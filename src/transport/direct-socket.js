// Raw TCP via the Direct Sockets API (only available to Isolated Web Apps).
// https://wicg.github.io/direct-sockets/

export function directSocketsAvailable() {
  return typeof globalThis.TCPSocket === 'function';
}

// Returns { read, write, close } as expected by src/ssh/transport.js.
export async function connectDirect(host, port) {
  if (!directSocketsAvailable()) {
    throw new Error(
      'The Direct Sockets API is not available. Install this app as an Isolated Web App ' +
        '(see README) — it does not work as a normal web page.',
    );
  }

  const socket = new TCPSocket(host, port, { noDelay: true, keepAliveDelay: 30_000 });
  const { readable, writable } = await socket.opened;
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let closed = false;

  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    write(bytes) {
      return writer.write(bytes);
    },
    close() {
      if (closed) return;
      closed = true;
      // Closing both streams closes the socket.
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
    },
  };
}
