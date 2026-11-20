// Where the account lives: the token and the derived AES key. The root key is deliberately absent —
// it exists only in the moment it is shown at signup, so losing it means losing the account, and a
// script with same-origin access can use the AES key but cannot carry it (or the root) away.
export type Account = { token: string; key: CryptoKey };

export type AccountStore = {
  load(): Promise<Account | undefined>;
  save(account: Account): Promise<void>;
  clear(): Promise<void>;
};

const DB = 'varia-sync';
const STORE = 'account';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('cannot open the key store'));
  });
}

async function write(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('key store write failed'));
    });
  } finally {
    db.close();
  }
}

export const idbAccount: AccountStore = {
  async load() {
    const db = await open();
    try {
      return await new Promise<Account | undefined>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('account');
        request.onsuccess = () => {
          const record = request.result as Account | undefined;
          // A record without both halves is not an account: treat it as absent rather than crash
          // the engine on a partial write or a corrupted store.
          resolve(record && typeof record.token === 'string' && record.key instanceof CryptoKey ? record : undefined);
        };
        request.onerror = () => reject(request.error ?? new Error('key store read failed'));
      });
    } finally {
      db.close();
    }
  },
  save: (account) => write('readwrite', (store) => store.put(account, 'account')),
  clear: () => write('readwrite', (store) => store.delete('account')),
};
