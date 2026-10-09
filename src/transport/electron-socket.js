// TCP via the Electron shell's preload bridge (electron/preload.cjs). Same interface as
// direct-socket.js; the main process only relays already-encrypted bytes.

export function electronSocketsAvailable() {
  return typeof globalThis.electronSockets?.connect === 'function';
}

export function connectElectron(host, port) {
  return globalThis.electronSockets.connect(host, port);
}
