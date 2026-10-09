// SSH transport layer (RFC 4253): version exchange, binary packets, key (re-)exchange.
//
// A socket is any object with:
//   read(): Promise<Uint8Array | null>   (null = EOF)
//   write(bytes: Uint8Array): Promise<void>
//   close(): void

import { Writer, Reader, utf8, concat, equalBytes } from './wire.js';
import { NoneCipher, CIPHERS, MACS, createCipher } from './cipher.js';
import { KEX_ALGORITHMS, Curve25519Exchange, exchangeHash, deriveKey } from './kex.js';
import { HOST_KEY_ALGORITHMS, verifyHostKeySignature, fingerprint, hostKeyType } from './hostkey.js';

export const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
};

export const CLIENT_VERSION = 'SSH-2.0-BrowserSSH_0.1';

const STRICT_KEX_CLIENT = 'kex-strict-c-v00@openssh.com';
const STRICT_KEX_SERVER = 'kex-strict-s-v00@openssh.com';
const CIPHER_ALGORITHMS = Object.keys(CIPHERS);
const MAC_ALGORITHMS = Object.keys(MACS);
const MAX_PACKET_LENGTH = 256 * 1024;

export class SshDisconnectError extends Error {
  constructor(code, description) {
    super(description || `disconnected (code ${code})`);
    this.code = code;
  }
}

// Buffers socket chunks so callers can read exact byte counts or lines.
class SocketReader {
  #socket;
  #buf = new Uint8Array(0);
  #off = 0;

  constructor(socket) {
    this.#socket = socket;
  }

  get #available() {
    return this.#buf.length - this.#off;
  }

  async #fill() {
    const chunk = await this.#socket.read();
    if (!chunk) throw new Error('connection closed by server');
    this.#buf = concat(this.#buf.subarray(this.#off), chunk);
    this.#off = 0;
  }

  async readExact(n) {
    while (this.#available < n) await this.#fill();
    const out = this.#buf.slice(this.#off, this.#off + n);
    this.#off += n;
    return out;
  }

  // Reads one line terminated by LF, returning it without CR/LF.
  async readLine(max = 8192) {
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, this.#off);
      if (nl !== -1) {
        let end = nl;
        if (end > this.#off && this.#buf[end - 1] === 0x0d) end--;
        const line = new TextDecoder().decode(this.#buf.subarray(this.#off, end));
        this.#off = nl + 1;
        return line;
      }
      if (this.#available > max) throw new Error('server identification line too long');
      await this.#fill();
    }
  }
}

function negotiate(what, client, server) {
  const found = client.find((alg) => server.includes(alg));
  if (!found) {
    throw new Error(`no common ${what} algorithm (server offers: ${server.join(', ') || 'none'})`);
  }
  return found;
}

export class Transport {
  #socket;
  #reader;
  #verifyHostKey;

  #inCipher = new NoneCipher();
  #outCipher = new NoneCipher();
  #inSeq = 0;
  #outSeq = 0;
  #writeChain = Promise.resolve();

  #inbox = [];
  #waiters = [];
  #pending = [];
  #closed = null;

  #kex = null;
  #initialKex = true;
  #strict = false;
  #firstKex = null;

  serverVersion = null;
  sessionId = null;
  hostKey = null;
  hostKeyFingerprint = null;
  algorithms = null;

  // verifyHostKey({ algorithm, key, fingerprint }) => Promise<boolean>, called once per connection.
  constructor(socket, { verifyHostKey }) {
    this.#socket = socket;
    this.#reader = new SocketReader(socket);
    this.#verifyHostKey = verifyHostKey;
  }

  get closed() {
    return this.#closed !== null;
  }

  async connect() {
    await this.#socket.write(utf8(CLIENT_VERSION + '\r\n'));
    // Servers may send other lines before the identification string (RFC 4253 §4.2).
    for (let i = 0; ; i++) {
      if (i > 1000) throw new Error('no SSH identification from server');
      const line = await this.#reader.readLine();
      if (line.startsWith('SSH-')) {
        this.serverVersion = line;
        break;
      }
    }
    if (!/^SSH-(2\.0|1\.99)-/.test(this.serverVersion)) {
      throw new Error(`unsupported SSH protocol: ${this.serverVersion}`);
    }

    const done = new Promise((resolve, reject) => (this.#firstKex = { resolve, reject }));
    this.#readLoop();
    this.#startKex();
    await done;
  }

  // Sends a higher-layer message. During key re-exchange, messages are held until NEWKEYS.
  send(payload) {
    if (this.#closed) return Promise.reject(this.#closed);
    const type = payload[0];
    const blocked = type >= 50 || type === MSG.SERVICE_REQUEST || type === MSG.SERVICE_ACCEPT;
    if (blocked && this.#kex && !this.#kex.newKeysSent) {
      return new Promise((resolve, reject) => this.#pending.push({ payload, resolve, reject }));
    }
    return this.#enqueue(payload);
  }

  // Resolves with the next message that the transport layer does not handle itself.
  recv() {
    if (this.#inbox.length) return Promise.resolve(this.#inbox.shift());
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  async close(reason = 'bye') {
    if (this.#closed) return;
    const msg = new Writer().byte(MSG.DISCONNECT).uint32(11).string(reason).string('').bytes();
    await this.#enqueue(msg).catch(() => {});
    this.#fail(new SshDisconnectError(11, 'closed by client'));
  }

  #enqueue(payload) {
    const step = this.#writeChain.then(async () => {
      if (this.#closed) throw this.#closed;
      const seq = this.#outSeq;
      this.#outSeq = (this.#outSeq + 1) >>> 0;
      const packet = await this.#outCipher.encrypt(seq, payload);
      await this.#socket.write(packet);
    });
    this.#writeChain = step.catch((err) => this.#fail(err));
    return step;
  }

  async #readLoop() {
    try {
      for (;;) {
        const head = await this.#reader.readExact(4);
        const length = new DataView(head.buffer).getUint32(0);
        if (length < 5 || length > MAX_PACKET_LENGTH) throw new Error(`bad packet length ${length}`);
        const rest = await this.#reader.readExact(length + this.#inCipher.macLength);
        const seq = this.#inSeq;
        this.#inSeq = (this.#inSeq + 1) >>> 0;
        const payload = await this.#inCipher.decrypt(seq, concat(head, rest));
        if (payload.length === 0) throw new Error('empty SSH packet');
        await this.#handle(payload, seq);
      }
    } catch (err) {
      this.#fail(err);
    }
  }

  async #handle(payload, seq) {
    const type = payload[0];
    const isKex = type === MSG.KEXINIT || type === MSG.NEWKEYS || (type >= 30 && type <= 49);
    if (this.#initialKex && this.#strict && !isKex) {
      throw new Error(`unexpected message ${type} during strict key exchange`);
    }

    switch (type) {
      case MSG.DISCONNECT: {
        const r = new Reader(payload, 1);
        throw new SshDisconnectError(r.uint32(), r.text());
      }
      case MSG.IGNORE:
      case MSG.DEBUG:
      case MSG.UNIMPLEMENTED:
      case MSG.EXT_INFO:
        return;
      case MSG.KEXINIT:
        return this.#onKexInit(payload, seq);
      case MSG.KEX_ECDH_REPLY:
        return this.#onEcdhReply(payload);
      case MSG.NEWKEYS:
        return this.#onNewKeys();
      default:
        if (isKex) throw new Error(`unexpected key exchange message ${type}`);
        this.#deliver(payload);
    }
  }

  #deliver(payload) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(payload);
    else this.#inbox.push(payload);
  }

  #startKex() {
    if (this.#kex) return;
    const w = new Writer(512).byte(MSG.KEXINIT);
    w.raw(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    w.nameList(this.#initialKex ? [...KEX_ALGORITHMS, STRICT_KEX_CLIENT] : KEX_ALGORITHMS);
    w.nameList(HOST_KEY_ALGORITHMS);
    w.nameList(CIPHER_ALGORITHMS).nameList(CIPHER_ALGORITHMS);
    w.nameList(MAC_ALGORITHMS).nameList(MAC_ALGORITHMS);
    w.nameList(['none']).nameList(['none']);
    w.nameList([]).nameList([]);
    w.bool(false).uint32(0);
    const clientKexInit = w.bytes();
    this.#kex = { clientKexInit, newKeysSent: false };
    this.#enqueue(clientKexInit).catch(() => {});
  }

  async #onKexInit(payload, seq) {
    if (this.#kex?.serverKexInit) throw new Error('duplicate KEXINIT');
    this.#startKex(); // server-initiated rekey: answer with our own KEXINIT
    const kex = this.#kex;
    kex.serverKexInit = payload;

    const r = new Reader(payload, 17);
    const server = {
      kex: r.nameList(),
      hostKey: r.nameList(),
      cipherC2S: r.nameList(),
      cipherS2C: r.nameList(),
      macC2S: r.nameList(),
      macS2C: r.nameList(),
      compC2S: r.nameList(),
      compS2C: r.nameList(),
    };

    if (this.#initialKex) {
      this.#strict = server.kex.includes(STRICT_KEX_SERVER);
      if (this.#strict && seq !== 0) throw new Error('strict KEX: KEXINIT was not the first packet');
    }

    const cipherC2S = negotiate('cipher', CIPHER_ALGORITHMS, server.cipherC2S);
    const cipherS2C = negotiate('cipher', CIPHER_ALGORITHMS, server.cipherS2C);
    this.algorithms = kex.algorithms = {
      kex: negotiate('key exchange', KEX_ALGORITHMS, server.kex),
      hostKey: negotiate('host key', HOST_KEY_ALGORITHMS, server.hostKey),
      cipherC2S,
      cipherS2C,
      // AEAD ciphers carry their own authentication; the MAC list is not negotiated for them.
      macC2S: CIPHERS[cipherC2S].mac ? negotiate('MAC', MAC_ALGORITHMS, server.macC2S) : null,
      macS2C: CIPHERS[cipherS2C].mac ? negotiate('MAC', MAC_ALGORITHMS, server.macS2C) : null,
    };
    negotiate('compression', ['none'], server.compC2S);
    negotiate('compression', ['none'], server.compS2C);

    kex.exchange = await Curve25519Exchange.create();
    const init = new Writer().byte(MSG.KEX_ECDH_INIT).string(kex.exchange.publicKey).bytes();
    this.#enqueue(init).catch(() => {});
  }

  async #onEcdhReply(payload) {
    const kex = this.#kex;
    if (!kex?.exchange) throw new Error('unexpected KEX_ECDH_REPLY');
    const alg = kex.algorithms;

    const r = new Reader(payload, 1);
    const hostKey = r.string().slice();
    const serverPublic = r.string().slice();
    const signature = r.string().slice();

    const secret = await kex.exchange.computeSecret(serverPublic);
    const hash = await exchangeHash({
      clientVersion: CLIENT_VERSION,
      serverVersion: this.serverVersion,
      clientKexInit: kex.clientKexInit,
      serverKexInit: kex.serverKexInit,
      hostKey,
      clientPublic: kex.exchange.publicKey,
      serverPublic,
      secret,
    });

    if (hostKeyType(hostKey) !== alg.hostKey) throw new Error('host key type mismatch');
    if (!(await verifyHostKeySignature(alg.hostKey, hostKey, signature, hash))) {
      throw new Error('host key signature verification failed');
    }
    if (this.hostKey) {
      if (!equalBytes(this.hostKey, hostKey)) throw new Error('host key changed during re-key');
    } else {
      const fp = await fingerprint(hostKey);
      if (!(await this.#verifyHostKey({ algorithm: alg.hostKey, key: hostKey, fingerprint: fp }))) {
        throw new Error('host key rejected');
      }
      this.hostKey = hostKey;
      this.hostKeyFingerprint = fp;
    }
    if (!this.sessionId) this.sessionId = hash;

    const derive = (letter, length) => deriveKey(secret, hash, letter, this.sessionId, length);
    const make = async (name, mac, ivLetter, keyLetter, macLetter) => {
      const spec = CIPHERS[name];
      return createCipher(
        name,
        await derive(keyLetter, spec.keyLength),
        await derive(ivLetter, spec.ivLength),
        mac ? await derive(macLetter, MACS[mac].keyLength) : null,
      );
    };
    const outCipher = await make(alg.cipherC2S, alg.macC2S, 'A', 'C', 'E');
    kex.inCipher = await make(alg.cipherS2C, alg.macS2C, 'B', 'D', 'F');

    // NEWKEYS goes out under the old keys; everything after it uses the new ones.
    this.#enqueue(Uint8Array.of(MSG.NEWKEYS)).catch(() => {});
    this.#writeChain = this.#writeChain.then(() => {
      this.#outCipher = outCipher;
      if (this.#strict) this.#outSeq = 0;
    });
    kex.newKeysSent = true;

    for (const { payload: held, resolve, reject } of this.#pending.splice(0)) {
      this.#enqueue(held).then(resolve, reject);
    }
  }

  #onNewKeys() {
    const kex = this.#kex;
    if (!kex?.inCipher) throw new Error('unexpected NEWKEYS');
    this.#inCipher = kex.inCipher;
    if (this.#strict) this.#inSeq = 0;
    this.#kex = null;
    if (this.#initialKex) {
      this.#initialKex = false;
      this.#firstKex.resolve();
    }
  }

  #fail(err) {
    if (this.#closed) return;
    this.#closed = err instanceof Error ? err : new Error(String(err));
    for (const w of this.#waiters.splice(0)) w.reject(this.#closed);
    for (const p of this.#pending.splice(0)) p.reject(this.#closed);
    this.#firstKex?.reject(this.#closed);
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
  }
}
