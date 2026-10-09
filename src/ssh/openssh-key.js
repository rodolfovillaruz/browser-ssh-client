// Parser for OpenSSH private keys ("-----BEGIN OPENSSH PRIVATE KEY-----", openssh-key-v1).
// Supports unencrypted ssh-ed25519 keys.

import { Reader, Writer, concat } from './wire.js';

const subtle = globalThis.crypto.subtle;
const MAGIC = 'openssh-key-v1\0';

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function decodePem(text) {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error('not an OpenSSH private key (expected "BEGIN OPENSSH PRIVATE KEY")');
  const bin = atob(m[1].replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function parsePrivateKey(text) {
  const data = decodePem(text);
  const magic = new TextDecoder().decode(data.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('bad openssh-key-v1 magic');

  const r = new Reader(data, MAGIC.length);
  const cipher = r.text();
  const kdf = r.text();
  r.string(); // kdf options
  if (cipher !== 'none' || kdf !== 'none') {
    throw new Error('passphrase-protected keys are not supported yet; use an unencrypted key');
  }
  if (r.uint32() !== 1) throw new Error('key files with multiple keys are not supported');
  const publicBlob = r.string().slice();

  const priv = new Reader(r.string());
  if (priv.uint32() !== priv.uint32()) throw new Error('corrupt private key (check bytes differ)');
  const type = priv.text();
  if (type !== 'ssh-ed25519') throw new Error(`unsupported key type ${type}; use an ed25519 key`);
  const pub = priv.string().slice();
  const secret = priv.string(); // seed (32) || public key (32)
  const comment = priv.text();
  if (secret.length !== 64) throw new Error('bad ed25519 private key length');

  const key = await subtle.importKey(
    'pkcs8',
    concat(ED25519_PKCS8_PREFIX, secret.subarray(0, 32)),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );

  const expected = new Writer().string('ssh-ed25519').string(pub).bytes();
  if (expected.length !== publicBlob.length || expected.some((b, i) => b !== publicBlob[i])) {
    throw new Error('public and private key do not match');
  }

  return {
    algorithm: 'ssh-ed25519',
    publicBlob,
    comment,
    async sign(data) {
      const sig = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, data));
      return new Writer().string('ssh-ed25519').string(sig).bytes();
    },
  };
}
