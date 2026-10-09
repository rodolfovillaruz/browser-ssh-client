import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AesGcmCipher, AesCtrEtmCipher, NoneCipher } from '../src/ssh/cipher.js';
import { deriveKey } from '../src/ssh/kex.js';
import { fingerprint } from '../src/ssh/hostkey.js';

const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const subtle = webcrypto.subtle;

test('X25519 matches RFC 7748 §6.1', async () => {
  // WebCrypto only imports X25519 private keys as PKCS8 or JWK.
  const pkcs8 = (k) => new Uint8Array([...fromHex('302e020100300506032b656e04220420'), ...k]);
  const alicePriv = await subtle.importKey(
    'pkcs8',
    pkcs8(fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')),
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
  const bobPub = await subtle.importKey(
    'raw',
    fromHex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'),
    { name: 'X25519' },
    false,
    [],
  );
  const shared = await subtle.deriveBits({ name: 'X25519', public: bobPub }, alicePriv, 256);
  assert.equal(hex(new Uint8Array(shared)), '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
});

test('deriveKey extends output past one hash block', async () => {
  const k = await deriveKey(fromHex('01'), fromHex('aa'), 'C', fromHex('bb'), 64);
  assert.equal(k.length, 64);
  const short = await deriveKey(fromHex('01'), fromHex('aa'), 'C', fromHex('bb'), 32);
  assert.deepEqual(k.subarray(0, 32), short);
});

test('fingerprint format', async () => {
  assert.match(await fingerprint(fromHex('00')), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

async function roundTrip(makeCipher) {
  const tx = await makeCipher();
  const rx = await makeCipher();
  for (let seq = 0; seq < 5; seq++) {
    const payload = crypto.getRandomValues(new Uint8Array(seq * 37 + 1));
    const packet = await tx.encrypt(seq, payload);
    const length = new DataView(packet.buffer).getUint32(0);
    assert.equal(packet.length, 4 + length + tx.macLength);
    assert.deepEqual(await rx.decrypt(seq, packet), payload);
  }
}

test('none cipher frames to 8-byte blocks', async () => {
  const packet = await new NoneCipher().encrypt(0, new Uint8Array(3));
  assert.equal(packet.length % 8, 0);
  await roundTrip(() => new NoneCipher());
});

test('AES-GCM round-trips and rejects tampering', async () => {
  const key = fromHex('00'.repeat(32));
  const iv = fromHex('11'.repeat(12));
  await roundTrip(() => AesGcmCipher.create(key, iv));

  const tx = await AesGcmCipher.create(key, iv);
  const rx = await AesGcmCipher.create(key, iv);
  const packet = await tx.encrypt(0, fromHex('5e'));
  packet[8] ^= 1;
  await assert.rejects(rx.decrypt(0, packet), /authentication failed/);
});

test('AES-CTR + EtM round-trips and checks sequence numbers', async () => {
  const make = () => AesCtrEtmCipher.create(fromHex('22'.repeat(16)), fromHex('ff'.repeat(16)), fromHex('33'.repeat(32)));
  await roundTrip(make); // the all-ff IV also exercises 128-bit counter wraparound

  const tx = await make();
  const rx = await make();
  await assert.rejects(rx.decrypt(1, await tx.encrypt(0, fromHex('5e'))), /authentication failed/);
});
