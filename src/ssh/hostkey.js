// Server host key parsing, signature verification and fingerprints.

import { Reader, concat } from './wire.js';
import { sha256 } from './kex.js';

const subtle = globalThis.crypto.subtle;
const dec = new TextDecoder();

export const HOST_KEY_ALGORITHMS = ['ssh-ed25519', 'ecdsa-sha2-nistp256'];

export function hostKeyType(blob) {
  return dec.decode(new Reader(blob).string());
}

// OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of SHA-256(key blob).
export async function fingerprint(blob) {
  const digest = await sha256(blob);
  return 'SHA256:' + btoa(String.fromCharCode(...digest)).replace(/=+$/, '');
}

// Left-pads an unsigned big-endian integer to exactly `n` bytes.
function fixed(bytes, n) {
  if (bytes.length > n) throw new Error('integer too large');
  const out = new Uint8Array(n);
  out.set(bytes, n - bytes.length);
  return out;
}

export async function verifyHostKeySignature(algorithm, blob, signature, data) {
  const key = new Reader(blob);
  const type = key.text();
  const sig = new Reader(signature);
  const sigType = sig.text();
  const sigBody = sig.string();
  if (type !== algorithm || sigType !== algorithm) {
    throw new Error(`host key type ${type} / signature ${sigType} does not match ${algorithm}`);
  }

  if (type === 'ssh-ed25519') {
    const pub = await subtle.importKey('raw', key.string(), { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify({ name: 'Ed25519' }, pub, sigBody, data);
  }

  if (type === 'ecdsa-sha2-nistp256') {
    if (key.text() !== 'nistp256') throw new Error('unexpected ECDSA curve');
    const pub = await subtle.importKey(
      'raw',
      key.string(),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    // SSH encodes the signature as mpint r, mpint s; WebCrypto wants fixed-width r || s.
    const rs = new Reader(sigBody);
    const raw = concat(fixed(rs.mpint(), 32), fixed(rs.mpint(), 32));
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw, data);
  }

  throw new Error(`unsupported host key type ${type}`);
}
