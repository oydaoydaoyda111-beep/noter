import type { Finance } from './model.ts';
export function updateAccount(finance: Finance, previous: string | undefined, rawName: string, note: string): Finance {
  const name = rawName.trim();
  if (!name || name.length > 120) throw new Error('Enter an account name between 1 and 120 characters.');
  if (note.length > 2000) throw new Error('Keep account notes under 2,000 characters.');
  if (previous !== undefined && !finance.accounts.some(account => account.name === previous)) throw new Error('Account no longer exists.');
  if (finance.accounts.some(account => account.name !== previous && account.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('That account already exists.');
  return { ...finance, accounts: previous === undefined ? [...finance.accounts, { name, note }] : finance.accounts.map(account => account.name === previous ? { ...account, name, note } : account), transactions: finance.transactions.map(row => row.account === previous ? { ...row, account: name } : row), defaults: finance.defaults && finance.defaults.account === previous ? { ...finance.defaults, account: name } : finance.defaults };
}
export function archiveAccount(finance: Finance, name: string, archived: boolean): Finance {
  const account = finance.accounts.find(item => item.name === name);
  if (!account) throw new Error('Account no longer exists.');
  if (archived && !account.archived && finance.accounts.filter(item => !item.archived).length <= 1) throw new Error('Keep at least one active account.');
  return { ...finance, accounts: finance.accounts.map(item => item.name === name ? { ...item, archived } : item), defaults: archived && finance.defaults?.account === name ? { ...finance.defaults, account: '' } : finance.defaults };
}
