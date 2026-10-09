// curve25519-sha256 key exchange (RFC 8731) and key derivation (RFC 4253 §7.2).

import { Writer, concat } from './wire.js';

const subtle = globalThis.crypto.subtle;

export const KEX_ALGORITHMS = ['curve25519-sha256', 'curve25519-sha256@libssh.org'];

export async function sha256(data) {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

export class Curve25519Exchange {
  static async create() {
    const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    return Object.assign(new Curve25519Exchange(), { privateKey: pair.privateKey, publicKey });
  }

  // Returns the shared secret K as raw 32 bytes (interpreted as an unsigned big-endian integer).
  async computeSecret(serverPublic) {
    if (serverPublic.length !== 32) throw new Error('bad curve25519 public key length');
    const peer = await subtle.importKey('raw', serverPublic, { name: 'X25519' }, false, []);
    const secret = new Uint8Array(
      await subtle.deriveBits({ name: 'X25519', public: peer }, this.privateKey, 256),
    );
    if (secret.every((b) => b === 0)) throw new Error('curve25519 shared secret is zero');
    return secret;
  }
}

// H = HASH(V_C || V_S || I_C || I_S || K_S || Q_C || Q_S || K)
export async function exchangeHash({ clientVersion, serverVersion, clientKexInit, serverKexInit, hostKey, clientPublic, serverPublic, secret }) {
  const w = new Writer(1024);
  w.string(clientVersion).string(serverVersion);
  w.string(clientKexInit).string(serverKexInit);
  w.string(hostKey).string(clientPublic).string(serverPublic);
  w.mpint(secret);
  return sha256(w.bytes());
}

// Derives `length` bytes of key material for `letter` ('A'..'F').
export async function deriveKey(secret, hash, letter, sessionId, length) {
  const k = new Writer().mpint(secret).bytes();
  let out = await sha256(concat(k, hash, new Uint8Array([letter.charCodeAt(0)]), sessionId));
  while (out.length < length) {
    out = concat(out, await sha256(concat(k, hash, out)));
  }
  return out.slice(0, length);
}
