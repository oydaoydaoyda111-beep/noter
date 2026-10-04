import { validateBudgets } from './budgets.ts';

export interface Transaction {
  id: string; date: string; cents: number; account: string; category: string;
  subcategory: string; payee: string; note: string; transferId?: string;
}
export interface Budget { month: string; category: string; cents: number }
export interface Finance {
  version: 1; accounts: { name: string; note: string; archived?: boolean }[]; transactions: Transaction[];
  categories: string[]; sourceName: string; template: Uint8Array;
  defaults?: { account: string; category: string };
  categoryDefinitions?: { name: string; subcategories: string[] }[];
  budgets?: Budget[];
}
export function money(value: string): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter an amount with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('Amount is too large.');
  return value.trim().startsWith('-') ? -cents : cents;
}
export function balances(finance: Finance): Map<string, number> {
  const result = new Map(finance.accounts.map(account => [account.name, 0]));
  for (const row of finance.transactions) result.set(row.account, (result.get(row.account) ?? 0) + row.cents);
  return result;
}
export function validateTransaction(finance: Finance, row: Transaction) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) throw new Error('Choose a valid date.');
  if (!Number.isSafeInteger(row.cents) || !row.cents) throw new Error('Amount must be greater than zero.');
  if (!finance.accounts.some(account => account.name === row.account)) throw new Error('Choose an account.');
}
export function saveTransaction(finance: Finance, row: Transaction, destination?: string): Finance {
  validateTransaction(finance, row);
  const existing = finance.transactions.find(item => item.id === row.id);
  const group = existing?.transferId;
  const remaining = finance.transactions.filter(item => group ? item.transferId !== group : item.id !== row.id);
  const next: Transaction = { ...row, transferId: undefined };
  delete next.transferId;
  if (destination) {
    if (destination === row.account || !finance.accounts.some(account => account.name === destination)) throw new Error('Choose a different destination account.');
    const transferId = group ?? crypto.randomUUID();
    next.transferId = transferId; next.cents = -Math.abs(row.cents); next.category = 'Transfer to other account';
    remaining.push(next, { ...next, id: crypto.randomUUID(), account: destination, cents: -next.cents });
  } else remaining.push(next);
  return { ...finance, transactions: remaining };
}
export function removeTransaction(finance: Finance, id: string): Finance {
  const row = finance.transactions.find(item => item.id === id);
  return { ...finance, transactions: finance.transactions.filter(item => row?.transferId ? item.transferId !== row.transferId : item.id !== id) };
}

// File storage can be changed by another editor or device. Reject invalid records
// before showing or modifying them; never silently drop financial entries.
export function validateFinanceFile(value: unknown): Finance {
  const data = value as Finance;
  const invalid = () => { throw new Error('Finance files contain invalid data. Keep the files and restore a valid backup before editing.'); };
  if (!data || data.version !== 1 || !Array.isArray(data.accounts) || !data.accounts.length || !Array.isArray(data.transactions) || !Array.isArray(data.categories) || !data.categories.every(name => typeof name === 'string') || typeof data.sourceName !== 'string' || !(data.template instanceof Uint8Array)) invalid();
  const accounts = new Set<string>(), ids = new Set<string>();
  for (const account of data.accounts) {
    if (!account || typeof account.name !== 'string' || !account.name || typeof account.note !== 'string' || accounts.has(account.name) || (account.archived !== undefined && typeof account.archived !== 'boolean')) invalid();
    accounts.add(account.name);
  }
  for (const row of data.transactions) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !['date','account','category','subcategory','payee','note'].every(key => typeof row[key as keyof Transaction] === 'string') || !accounts.has(row.account) || !Number.isSafeInteger(row.cents) || !row.cents || (row.transferId !== undefined && typeof row.transferId !== 'string')) invalid();
    try { validateTransaction(data, row); } catch { invalid(); } ids.add(row.id);
  }
  if (data.defaults && (typeof data.defaults.account !== 'string' || typeof data.defaults.category !== 'string')) invalid();
  if (data.categoryDefinitions !== undefined && (!Array.isArray(data.categoryDefinitions) || !data.categoryDefinitions.every(item => item && typeof item.name === 'string' && Array.isArray(item.subcategories) && item.subcategories.every(name => typeof name === 'string')))) invalid();
  if (data.budgets !== undefined) validateBudgets(data.budgets);
  for (const row of data.transactions) if (row.transferId) {
    const pair = data.transactions.filter(item => item.transferId === row.transferId);
    if (pair.length !== 2 || pair[0].cents !== -pair[1].cents || pair[0].account === pair[1].account || pair[0].date !== pair[1].date) invalid();
  }
  return data;
}
