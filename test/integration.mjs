// End-to-end check against a real sshd.
//
//   node test/integration.mjs --host 127.0.0.1 --port 2222 --user $USER --key path/to/id_ed25519
//   node test/integration.mjs --host 127.0.0.1 --port 2222 --user test --password secret
//
// Runs `exec`, an interactive shell with a PTY, and a large transfer (set `RekeyLimit 1M` on the
// server to exercise key re-exchange).

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { connectNode } from './node-transport.mjs';
import { SshClient, parsePrivateKey } from '../src/ssh/client.js';

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '22' },
    user: { type: 'string', default: process.env.USER },
    key: { type: 'string' },
    password: { type: 'string' },
    bytes: { type: 'string', default: String(4 * 1024 * 1024) },
  },
});

const dec = new TextDecoder();

function collect(channel) {
  const chunks = [];
  let size = 0;
  channel.ondata = (d) => (chunks.push(d), (size += d.length));
  return new Promise((resolve, reject) => {
    let status = null;
    channel.onexit = (e) => (status = e);
    channel.onclose = (err) => (err ? reject(err) : resolve({ chunks, size, status }));
  });
}

async function connect() {
  const socket = await connectNode(args.host, Number(args.port));
  return SshClient.connect(socket, {
    username: args.user,
    password: args.password,
    privateKey: args.key ? await parsePrivateKey(await readFile(args.key, 'utf8')) : undefined,
    verifyHostKey: async ({ algorithm, fingerprint }) => {
      console.log(`host key ${algorithm} ${fingerprint}`);
      return true;
    },
    onBanner: (b) => console.log('banner:', b.trim()),
  });
}

const client = await connect();
console.log('authenticated, algorithms:', client.transport.algorithms);

{
  const ch = await client.exec('echo hello from $(uname -s); echo oops >&2; exit 3');
  ch.onstderr = (d) => console.log('stderr:', dec.decode(d).trim());
  const { chunks, status } = await collect(ch);
  const out = dec.decode(Buffer.concat(chunks)).trim();
  console.log('exec:', out, status);
  assert.match(out, /^hello from /);
  assert.deepEqual(status, { status: 3 });
}

{
  const ch = await client.shell({ cols: 100, rows: 30 });
  const done = collect(ch);
  await ch.write('stty size; echo "$TERM"; exit\n');
  const { chunks } = await done;
  const out = dec.decode(Buffer.concat(chunks));
  assert.match(out, /30 100/);
  assert.match(out, /xterm-256color/);
  console.log('shell: pty size and TERM ok');
}

{
  const n = Number(args.bytes);
  const started = Date.now();
  const ch = await client.exec(`head -c ${n} /dev/zero`);
  const { size } = await collect(ch);
  assert.equal(size, n);
  const secs = (Date.now() - started) / 1000;
  console.log(`transfer: ${n} bytes in ${secs.toFixed(2)}s (${(n / secs / 1e6).toFixed(1)} MB/s)`);
}

{
  // Upload direction: exercises our side of flow control.
  const n = 1024 * 1024;
  const ch = await client.exec('wc -c');
  const done = collect(ch);
  await ch.write(new Uint8Array(n));
  await ch.eof();
  const { chunks } = await done;
  assert.equal(Number(dec.decode(Buffer.concat(chunks)).trim()), n);
  console.log('upload: ok');
}

await client.close();
console.log('all checks passed');
