// Packet ciphers for the SSH binary packet protocol (RFC 4253 §6).
//
// Every mode here keeps the 4-byte packet_length in plaintext (the "none" cipher, AES-GCM per
// RFC 5647 / OpenSSH, and encrypt-then-MAC), so the reader can always learn the packet size
// from the first 4 bytes without decrypting.

import { concat } from './wire.js';

const subtle = globalThis.crypto.subtle;

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// Builds packet_length || padding_length || payload || padding.
// `blockSize` alignment covers the whole packet when `lengthIncluded`, otherwise everything after
// packet_length (AEAD and EtM modes).
function frame(payload, blockSize, lengthIncluded) {
  const head = lengthIncluded ? 5 : 1;
  let pad = blockSize - ((head + payload.length) % blockSize);
  if (pad < 4) pad += blockSize;
  const packetLength = 1 + payload.length + pad;
  const out = new Uint8Array(4 + packetLength);
  new DataView(out.buffer).setUint32(0, packetLength);
  out[4] = pad;
  out.set(payload, 5);
  out.set(randomBytes(pad), 5 + payload.length);
  return out;
}

// Returns the payload of a decrypted packet body (padding_length || payload || padding).
function unframe(body) {
  const pad = body[0];
  if (pad < 4 || pad + 1 > body.length) throw new Error('bad SSH packet padding');
  return body.subarray(1, body.length - pad);
}

export class NoneCipher {
  macLength = 0;

  async encrypt(_seq, payload) {
    return frame(payload, 8, true);
  }

  async decrypt(_seq, packet) {
    return unframe(packet.subarray(4));
  }
}

// aes{128,256}-gcm@openssh.com: packet_length is AAD, the IV is a 4-byte fixed field followed by
// an 8-byte invocation counter that increments once per packet.
export class AesGcmCipher {
  macLength = 16;

  constructor(key, iv) {
    this.key = key;
    this.iv = iv.slice(0, 12);
  }

  static async create(keyBytes, ivBytes) {
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return new AesGcmCipher(key, ivBytes);
  }

  #nextIv() {
    const iv = this.iv.slice();
    const view = new DataView(this.iv.buffer, this.iv.byteOffset);
    view.setBigUint64(4, (view.getBigUint64(4) + 1n) & 0xffffffffffffffffn);
    return iv;
  }

  async encrypt(_seq, payload) {
    const packet = frame(payload, 16, false);
    const aad = packet.subarray(0, 4);
    const sealed = await subtle.encrypt(
      { name: 'AES-GCM', iv: this.#nextIv(), additionalData: aad, tagLength: 128 },
      this.key,
      packet.subarray(4),
    );
    return concat(aad, new Uint8Array(sealed));
  }

  async decrypt(_seq, packet) {
    const aad = packet.subarray(0, 4);
    let body;
    try {
      body = await subtle.decrypt(
        { name: 'AES-GCM', iv: this.#nextIv(), additionalData: aad, tagLength: 128 },
        this.key,
        packet.subarray(4),
      );
    } catch {
      throw new Error('SSH packet authentication failed');
    }
    return unframe(new Uint8Array(body));
  }
}

// aes128-ctr with hmac-sha2-256-etm@openssh.com. The MAC covers seq || packet_length || ciphertext.
export class AesCtrEtmCipher {
  macLength = 32;

  constructor(key, counter, macKey) {
    this.key = key;
    this.counter = counter.slice(0, 16);
    this.macKey = macKey;
  }

  static async create(keyBytes, ivBytes, macKeyBytes) {
    const key = await subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['encrypt']);
    const macKey = await subtle.importKey(
      'raw',
      macKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    return new AesCtrEtmCipher(key, ivBytes, macKey);
  }

  // AES-CTR keystream continues across packets, so advance the 128-bit counter by the blocks used.
  async #crypt(data) {
    const out = await subtle.encrypt(
      { name: 'AES-CTR', counter: this.counter.slice(), length: 128 },
      this.key,
      data,
    );
    let carry = data.length / 16;
    for (let i = 15; i >= 0 && carry > 0; i--) {
      const sum = this.counter[i] + (carry & 0xff);
      this.counter[i] = sum & 0xff;
      carry = Math.floor(carry / 256) + (sum >> 8);
    }
    return new Uint8Array(out);
  }

  #macInput(seq, lengthAndCipher) {
    const s = new Uint8Array(4);
    new DataView(s.buffer).setUint32(0, seq >>> 0);
    return concat(s, lengthAndCipher);
  }

  async encrypt(seq, payload) {
    const packet = frame(payload, 16, false);
    const ct = concat(packet.subarray(0, 4), await this.#crypt(packet.subarray(4)));
    const mac = new Uint8Array(await subtle.sign('HMAC', this.macKey, this.#macInput(seq, ct)));
    return concat(ct, mac);
  }

  async decrypt(seq, packet) {
    const ct = packet.subarray(0, packet.length - this.macLength);
    const mac = packet.subarray(packet.length - this.macLength);
    const ok = await subtle.verify('HMAC', this.macKey, mac, this.#macInput(seq, ct));
    if (!ok) throw new Error('SSH packet authentication failed');
    return unframe(await this.#crypt(ct.subarray(4)));
  }
}

// Key and IV sizes per cipher; `mac` is the MAC key length needed (0 for AEAD).
export const CIPHERS = {
  'aes256-gcm@openssh.com': { keyLength: 32, ivLength: 12, mac: false },
  'aes128-gcm@openssh.com': { keyLength: 16, ivLength: 12, mac: false },
  'aes128-ctr': { keyLength: 16, ivLength: 16, mac: true },
};

export const MACS = {
  'hmac-sha2-256-etm@openssh.com': { keyLength: 32 },
};

export async function createCipher(name, key, iv, macKey) {
  if (name.endsWith('-gcm@openssh.com')) return AesGcmCipher.create(key, iv);
  if (name === 'aes128-ctr') return AesCtrEtmCipher.create(key, iv, macKey);
  throw new Error(`unsupported cipher ${name}`);
}
