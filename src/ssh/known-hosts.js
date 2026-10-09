// Trust-on-first-use host key store in IndexedDB (the IWA's isolated storage).

const DB_NAME = 'browser-ssh';
const STORE = 'known_hosts';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const hostId = (host, port) => (port === 22 ? host : `[${host}]:${port}`).toLowerCase();

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

// Returns { algorithm, key (base64 blob), fingerprint, added } or undefined.
export function lookupHost(host, port) {
  return run('readonly', (s) => s.get(hostId(host, port)));
}

export function rememberHost(host, port, { algorithm, key, fingerprint }) {
  const entry = { algorithm, key: toBase64(key), fingerprint, added: new Date().toISOString() };
  return run('readwrite', (s) => s.put(entry, hostId(host, port)));
}

export function forgetHost(host, port) {
  return run('readwrite', (s) => s.delete(hostId(host, port)));
}

// 'known' | 'unknown' | 'changed'
export async function checkHost(host, port, { algorithm, key }) {
  const entry = await lookupHost(host, port);
  if (!entry) return { status: 'unknown' };
  if (entry.algorithm === algorithm && entry.key === toBase64(key)) return { status: 'known', entry };
  // A different key type may just mean the server gained a new key; still require confirmation.
  return { status: 'changed', entry };
}
