import { validateTransaction, type Finance, type Transaction } from './model.ts';
import { registerCategory } from './categories.ts';

export type TransactionPatch = Partial<Pick<Transaction, 'date' | 'account' | 'category' | 'subcategory' | 'payee' | 'note'>>;

/** Selecting either transfer entry always includes its partner, even outside the current filter. */
export function transactionSelection(finance: Finance, ids: Set<string>): Set<string> {
  const groups = new Set(finance.transactions.filter(row => ids.has(row.id) && row.transferId).map(row => row.transferId));
  return new Set(finance.transactions.filter(row => ids.has(row.id) || (row.transferId && groups.has(row.transferId))).map(row => row.id));
}

function selectedIds(finance: Finance, ids: Set<string>): Set<string> {
  const available = new Set(finance.transactions.map(row => row.id));
  if (!ids.size || [...ids].some(id => !available.has(id))) throw new Error('The selected transactions changed. Close this dialog and select them again.');
  return transactionSelection(finance, ids);
}

export function updateTransactions(finance: Finance, ids: Set<string>, patch: TransactionPatch): Finance {
  const selected = selectedIds(finance, ids);
  if (!Object.keys(patch).length) throw new Error('Choose at least one field to change.');
  for (const [field, value] of Object.entries(patch)) {
    if (!['date', 'account', 'category', 'subcategory', 'payee', 'note'].includes(field) || typeof value !== 'string' || value.length > (field === 'category' || field === 'subcategory' || field === 'account' ? 120 : 2000)) throw new Error('Enter valid transaction fields.');
  }
  if (patch.subcategory !== undefined && patch.category === undefined) throw new Error('Choose a category when changing subcategories.');
  const transfer = finance.transactions.some(row => selected.has(row.id) && row.transferId);
  if (transfer && (patch.account !== undefined || patch.category !== undefined)) throw new Error('For linked transfers, bulk editing supports date, payee and note. Edit account destinations individually.');
  if (patch.account !== undefined && !finance.accounts.some(account => account.name === patch.account && !account.archived)) throw new Error('Choose an active account.');
  if (patch.category === '' && patch.subcategory) throw new Error('Choose a category before adding a subcategory.');
  const transactions = finance.transactions.map(row => {
    if (!selected.has(row.id)) return row;
    const next = { ...row, ...patch };
    if (patch.category !== undefined) next.subcategory = patch.subcategory ?? '';
    validateTransaction(finance, next);
    return next;
  });
  const next = { ...finance, transactions };
  return patch.category ? registerCategory(next, patch.category, patch.subcategory) : next;
}

export function removeTransactions(finance: Finance, ids: Set<string>): Finance {
  const selected = selectedIds(finance, ids);
  return { ...finance, transactions: finance.transactions.filter(row => !selected.has(row.id)) };
}
