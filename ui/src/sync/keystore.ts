// Where the account lives. The AES key is non-extractable, so it can only be stored as a CryptoKey
// (IndexedDB structured clone); the token sits beside it. The root key is never written anywhere.
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
        request.onsuccess = () => resolve((request.result as Account | undefined) ?? undefined);
        request.onerror = () => reject(request.error ?? new Error('key store read failed'));
      });
    } finally {
      db.close();
    }
  },
  save: (account) => write('readwrite', (store) => store.put(account, 'account')),
  clear: () => write('readwrite', (store) => store.delete('account')),
};
