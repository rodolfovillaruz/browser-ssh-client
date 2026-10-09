// Exposes a minimal TCP socket API and window controls to the page (context-isolated, sandboxed).

const { contextBridge, ipcRenderer } = require('electron');

const streams = new Map(); // id -> { chunks, waiters, ended, error }

function wake(s) {
  while (s.waiters.length && (s.chunks.length || s.ended || s.error)) {
    const w = s.waiters.shift();
    if (s.chunks.length) w.resolve(s.chunks.shift());
    else if (s.error) w.reject(new Error(s.error));
    else w.resolve(null);
  }
}

ipcRenderer.on('tcp:data', (_e, id, chunk) => {
  const s = streams.get(id);
  if (!s) return;
  s.chunks.push(chunk);
  wake(s);
});

ipcRenderer.on('tcp:error', (_e, id, message) => {
  const s = streams.get(id);
  if (!s) return;
  s.error = message;
  wake(s);
});

ipcRenderer.on('tcp:end', (_e, id) => {
  const s = streams.get(id);
  if (!s) return;
  s.ended = true;
  wake(s);
  streams.delete(id);
});

contextBridge.exposeInMainWorld('electronSockets', {
  // Resolves with { read, write, close }, the interface src/ssh/transport.js expects.
  async connect(host, port) {
    const id = crypto.randomUUID();
    // Register before connecting so no early data is lost.
    const s = { chunks: [], waiters: [], ended: false, error: null };
    streams.set(id, s);
    try {
      await ipcRenderer.invoke('tcp:connect', id, host, port);
    } catch (err) {
      streams.delete(id);
      throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    return {
      read: () => new Promise((resolve, reject) => (s.waiters.push({ resolve, reject }), wake(s))),
      write: (bytes) => ipcRenderer.invoke('tcp:write', id, bytes),
      close: () => ipcRenderer.send('tcp:close', id),
    };
  },
});

contextBridge.exposeInMainWorld('electronWindow', {
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
});
