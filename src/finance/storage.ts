import { desktop, loadFinanceFile, saveFinanceFile } from '../desktop/platform';
import { validateFinanceFile, type Finance } from './model';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('noter.finance.v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Finance storage is unavailable.'));
  });
}
export async function loadFinance(): Promise<Finance | undefined> {
  if (desktop) { const value = await loadFinanceFile(); return value ? validateFinanceFile(value) : undefined; }
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('finance');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function persistFinance(finance: Finance): Promise<void> {
  if (desktop) { await saveFinanceFile(finance); return; }
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('workspace', 'readwrite');
      transaction.objectStore('workspace').put(finance, 'finance');
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('Could not save Finance. Your previous saved data is unchanged.'));
    });
  } finally { db.close(); }
}
