// SSH connection protocol (RFC 4254): channel multiplexing, flow control, session requests.

import { Writer, Reader } from './wire.js';

const MSG = {
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
};

const LOCAL_WINDOW = 2 * 1024 * 1024;
const LOCAL_MAX_PACKET = 32 * 1024;

// Terminal mode opcodes (RFC 4254 §8).
const TTY_OP_END = 0;
const IUTF8 = 42;

export class Channel {
  #conn;
  #localWindow = LOCAL_WINDOW;
  #remoteWindow = 0;
  #remoteMaxPacket = 0;
  #writeQueue = [];
  #requestReplies = [];
  #closeSent = false;

  ondata = null; // (Uint8Array) => void
  onstderr = null; // (Uint8Array) => void
  onexit = null; // ({ status } | { signal }) => void
  onclose = null; // (Error | null) => void

  constructor(conn, localId) {
    this.#conn = conn;
    this.localId = localId;
    this.remoteId = null;
    this.closed = false;
  }

  _opened(remoteId, window, maxPacket) {
    this.remoteId = remoteId;
    this.#remoteWindow = window;
    this.#remoteMaxPacket = maxPacket;
  }

  #send(writer) {
    return this.#conn.transport.send(writer.bytes());
  }

  #header(type) {
    return new Writer().byte(type).uint32(this.remoteId);
  }

  // Sends data, splitting it to respect the peer's window and maximum packet size.
  write(data) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    if (this.closed) return Promise.reject(new Error('channel closed'));
    return new Promise((resolve, reject) => {
      this.#writeQueue.push({ data, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.#writeQueue.length && this.#remoteWindow > 0) {
      const item = this.#writeQueue[0];
      const n = Math.min(item.data.length, this.#remoteWindow, this.#remoteMaxPacket);
      const chunk = item.data.subarray(0, n);
      item.data = item.data.subarray(n);
      this.#remoteWindow -= n;
      const sent = this.#send(this.#header(MSG.CHANNEL_DATA).string(chunk));
      if (item.data.length === 0) {
        this.#writeQueue.shift();
        sent.then(item.resolve, item.reject);
      }
    }
  }

  // Sends a channel request; resolves true/false when wantReply, otherwise immediately.
  request(type, wantReply, build = () => {}) {
    const w = this.#header(MSG.CHANNEL_REQUEST).string(type).bool(wantReply);
    build(w);
    const sent = this.#send(w);
    if (!wantReply) return sent.then(() => true);
    return new Promise((resolve, reject) => {
      this.#requestReplies.push({ resolve, reject });
      sent.catch(reject);
    });
  }

  async requestPty({ term = 'xterm-256color', cols = 80, rows = 24 } = {}) {
    const ok = await this.request('pty-req', true, (w) => {
      const modes = new Writer().byte(IUTF8).uint32(1).byte(TTY_OP_END).bytes();
      w.string(term).uint32(cols).uint32(rows).uint32(0).uint32(0).string(modes);
    });
    if (!ok) throw new Error('server refused to allocate a PTY');
  }

  async shell() {
    if (!(await this.request('shell', true))) throw new Error('server refused to start a shell');
  }

  async exec(command) {
    if (!(await this.request('exec', true, (w) => w.string(command)))) {
      throw new Error('server refused to run the command');
    }
  }

  resize(cols, rows) {
    return this.request('window-change', false, (w) => w.uint32(cols).uint32(rows).uint32(0).uint32(0));
  }

  eof() {
    return this.#send(this.#header(MSG.CHANNEL_EOF));
  }

  close() {
    if (this.#closeSent || this.closed) return Promise.resolve();
    this.#closeSent = true;
    return this.#send(this.#header(MSG.CHANNEL_CLOSE));
  }

  _handle(type, r) {
    switch (type) {
      case MSG.CHANNEL_WINDOW_ADJUST:
        this.#remoteWindow = Math.min(this.#remoteWindow + r.uint32(), 0xffffffff);
        this.#pump();
        break;
      case MSG.CHANNEL_DATA:
        this.#consume(r.string(), this.ondata);
        break;
      case MSG.CHANNEL_EXTENDED_DATA:
        r.uint32(); // data type code; 1 = stderr is the only one defined
        this.#consume(r.string(), this.onstderr ?? this.ondata);
        break;
      case MSG.CHANNEL_EOF:
        break;
      case MSG.CHANNEL_CLOSE:
        this.close().catch(() => {});
        this._finish(null);
        break;
      case MSG.CHANNEL_REQUEST: {
        const name = r.text();
        const wantReply = r.bool();
        if (name === 'exit-status') this.onexit?.({ status: r.uint32() });
        else if (name === 'exit-signal') this.onexit?.({ signal: r.text() });
        if (wantReply) this.#send(this.#header(MSG.CHANNEL_FAILURE)).catch(() => {});
        break;
      }
      case MSG.CHANNEL_SUCCESS:
      case MSG.CHANNEL_FAILURE:
        this.#requestReplies.shift()?.resolve(type === MSG.CHANNEL_SUCCESS);
        break;
    }
  }

  #consume(data, sink) {
    if (data.length > this.#localWindow) throw new Error('peer exceeded channel window');
    this.#localWindow -= data.length;
    sink?.(data.slice());
    if (this.#localWindow < LOCAL_WINDOW / 2) {
      this.#send(this.#header(MSG.CHANNEL_WINDOW_ADJUST).uint32(LOCAL_WINDOW - this.#localWindow)).catch(() => {});
      this.#localWindow = LOCAL_WINDOW;
    }
  }

  _finish(err) {
    if (this.closed) return;
    this.closed = true;
    const reason = err ?? new Error('channel closed');
    for (const w of this.#writeQueue.splice(0)) w.reject(reason);
    for (const r of this.#requestReplies.splice(0)) r.reject(reason);
    this.#conn._release(this.localId);
    this.onclose?.(err);
  }
}

export class Connection {
  #channels = new Map();
  #opening = new Map();
  #nextId = 0;

  onclose = null; // (Error) => void

  constructor(transport) {
    this.transport = transport;
    this.#loop();
  }

  async #loop() {
    let error;
    try {
      for (;;) this.#dispatch(await this.transport.recv());
    } catch (err) {
      error = err;
    }
    for (const ch of [...this.#channels.values()]) ch._finish(error);
    for (const { reject } of this.#opening.values()) reject(error);
    this.#opening.clear();
    this.onclose?.(error);
  }

  openSession() {
    const localId = this.#nextId++;
    const channel = new Channel(this, localId);
    const msg = new Writer()
      .byte(MSG.CHANNEL_OPEN)
      .string('session')
      .uint32(localId)
      .uint32(LOCAL_WINDOW)
      .uint32(LOCAL_MAX_PACKET)
      .bytes();
    return new Promise((resolve, reject) => {
      this.#opening.set(localId, { channel, resolve, reject });
      this.transport.send(msg).catch(reject);
    });
  }

  _release(localId) {
    this.#channels.delete(localId);
  }

  #dispatch(msg) {
    const type = msg[0];
    const r = new Reader(msg, 1);

    if (type === MSG.GLOBAL_REQUEST) {
      r.text();
      if (r.bool()) this.transport.send(Uint8Array.of(MSG.REQUEST_FAILURE)).catch(() => {});
      return;
    }

    if (type === MSG.CHANNEL_OPEN) {
      // Server-initiated channels (agent / X11 forwarding) are not supported.
      r.text();
      const sender = r.uint32();
      const reply = new Writer()
        .byte(MSG.CHANNEL_OPEN_FAILURE)
        .uint32(sender)
        .uint32(1)
        .string('not supported')
        .string('')
        .bytes();
      this.transport.send(reply).catch(() => {});
      return;
    }

    if (type < MSG.CHANNEL_OPEN_CONFIRMATION || type > MSG.CHANNEL_FAILURE) return;
    const localId = r.uint32();

    if (type === MSG.CHANNEL_OPEN_CONFIRMATION || type === MSG.CHANNEL_OPEN_FAILURE) {
      const pending = this.#opening.get(localId);
      if (!pending) throw new Error(`unexpected channel open reply for ${localId}`);
      this.#opening.delete(localId);
      if (type === MSG.CHANNEL_OPEN_FAILURE) {
        const code = r.uint32();
        pending.reject(new Error(`channel open failed: ${r.text() || `code ${code}`}`));
      } else {
        pending.channel._opened(r.uint32(), r.uint32(), r.uint32());
        this.#channels.set(localId, pending.channel);
        pending.resolve(pending.channel);
      }
      return;
    }

    const channel = this.#channels.get(localId);
    if (!channel) return; // late messages for a channel we already closed
    channel._handle(type, r);
  }
}
