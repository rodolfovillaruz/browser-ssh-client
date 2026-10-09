import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader, concat, equalBytes } from '../src/ssh/wire.js';

const hex = (u8) => Buffer.from(u8).toString('hex');
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

test('round-trips primitive types', () => {
  const w = new Writer(4);
  w.byte(7).bool(true).uint32(0xdeadbeef).uint64(2n ** 40n).string('héllo').nameList(['a', 'b-c']);
  const r = new Reader(w.bytes());
  assert.equal(r.byte(), 7);
  assert.equal(r.bool(), true);
  assert.equal(r.uint32(), 0xdeadbeef);
  assert.equal(r.uint64(), 2n ** 40n);
  assert.equal(r.text(), 'héllo');
  assert.deepEqual(r.nameList(), ['a', 'b-c']);
  assert.equal(r.remaining, 0);
});

test('mpint encoding follows RFC 4251 examples', () => {
  const enc = (h) => hex(new Writer().mpint(fromHex(h)).bytes());
  assert.equal(enc(''), '00000000');
  assert.equal(enc('00'), '00000000');
  assert.equal(enc('09a378f9b2e332a7'), '0000000809a378f9b2e332a7');
  assert.equal(enc('80'), '000000020080');
  assert.equal(enc('0000ff'), '0000000200ff');
});

test('mpint decoding strips sign byte', () => {
  const r = new Reader(fromHex('000000020080'));
  assert.equal(hex(r.mpint()), '80');
});

test('empty name-list', () => {
  const r = new Reader(new Writer().nameList([]).bytes());
  assert.deepEqual(r.nameList(), []);
});

test('truncated input throws', () => {
  assert.throws(() => new Reader(fromHex('000000')).uint32(), /truncated/);
  assert.throws(() => new Reader(fromHex('00000005abcd')).string(), /truncated/);
});

test('concat and equalBytes', () => {
  assert.ok(equalBytes(concat(fromHex('01'), fromHex('0203')), fromHex('010203')));
  assert.ok(!equalBytes(fromHex('01'), fromHex('02')));
});
