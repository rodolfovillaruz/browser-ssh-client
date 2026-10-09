// SSH wire encoding (RFC 4251 §5).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s) {
  return enc.encode(s);
}

export function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class Writer {
  constructor(size = 256) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }

  #reserve(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v) {
    this.#reserve(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bool(v) {
    return this.byte(v ? 1 : 0);
  }

  uint32(v) {
    this.#reserve(4);
    new DataView(this.buf.buffer).setUint32(this.len, v >>> 0);
    this.len += 4;
    return this;
  }

  uint64(v) {
    this.#reserve(8);
    new DataView(this.buf.buffer).setBigUint64(this.len, BigInt(v));
    this.len += 8;
    return this;
  }

  raw(bytes) {
    this.#reserve(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return this;
  }

  // string: uint32 length + bytes. Accepts JS strings (UTF-8 encoded) or bytes.
  string(v) {
    const bytes = typeof v === 'string' ? utf8(v) : v;
    this.uint32(bytes.length);
    return this.raw(bytes);
  }

  nameList(names) {
    return this.string(names.join(','));
  }

  // mpint from unsigned big-endian bytes (strips leading zeros, adds a sign byte if needed).
  mpint(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    const body = bytes.subarray(i);
    if (body.length > 0 && body[0] & 0x80) {
      this.uint32(body.length + 1);
      this.byte(0);
    } else {
      this.uint32(body.length);
    }
    return this.raw(body);
  }

  bytes() {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  constructor(bytes, offset = 0) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.off = offset;
  }

  #need(n) {
    if (this.off + n > this.buf.length) throw new Error('SSH message truncated');
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  byte() {
    this.#need(1);
    return this.buf[this.off++];
  }

  bool() {
    return this.byte() !== 0;
  }

  uint32() {
    this.#need(4);
    const v = this.view.getUint32(this.off);
    this.off += 4;
    return v;
  }

  uint64() {
    this.#need(8);
    const v = this.view.getBigUint64(this.off);
    this.off += 8;
    return v;
  }

  raw(n) {
    this.#need(n);
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }

  string() {
    return this.raw(this.uint32());
  }

  text() {
    return dec.decode(this.string());
  }

  nameList() {
    const s = this.text();
    return s === '' ? [] : s.split(',');
  }

  // Returns unsigned big-endian magnitude (no sign byte). Negative mpints are not used by SSH here.
  mpint() {
    const b = this.string();
    if (b.length && b[0] & 0x80) throw new Error('negative mpint');
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    return b.subarray(i);
  }

  rest() {
    return this.raw(this.remaining);
  }
}
