// net.Socket adapter with the same interface as src/transport/direct-socket.js (tests only).

import net from 'node:net';

export function connectNode(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const chunks = [];
    const waiters = [];
    let ended = false;
    let error = null;

    const wake = () => {
      while (waiters.length && (chunks.length || ended || error)) {
        const w = waiters.shift();
        if (chunks.length) w.resolve(new Uint8Array(chunks.shift()));
        else if (error) w.reject(error);
        else w.resolve(null);
      }
    };

    sock.on('data', (d) => {
      chunks.push(d);
      wake();
    });
    sock.on('end', () => {
      ended = true;
      wake();
    });
    sock.on('close', () => {
      ended = true;
      wake();
    });
    sock.on('error', (e) => {
      error = e;
      wake();
      reject(e);
    });
    sock.on('connect', () =>
      resolve({
        read: () => new Promise((res, rej) => (waiters.push({ resolve: res, reject: rej }), wake())),
        write: (bytes) => new Promise((res, rej) => sock.write(bytes, (e) => (e ? rej(e) : res()))),
        close: () => sock.destroy(),
      }),
    );
  });
}
