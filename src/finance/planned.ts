import type { Finance } from './model.ts';

export interface PlannedExpense { id: string; name: string; cents: number }
export interface ExpensePlans { version: 1; expenses: PlannedExpense[] }

export function validateExpensePlans(value: unknown): ExpensePlans {
  const data = value as ExpensePlans;
  if (!data || data.version !== 1 || !Array.isArray(data.expenses)) throw new Error('Planned expenses file is invalid. Keep the file and restore a valid copy.');
  const ids = new Set<string>();
  for (const item of data.expenses) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !Number.isSafeInteger(item.cents) || item.cents <= 0) throw new Error('Planned expenses contain an invalid or duplicate entry.');
    ids.add(item.id);
  }
  return data;
}

export function plannedTotals(finance: Finance, plans: ExpensePlans) {
  const active = new Set(finance.accounts.filter(account => !account.archived).map(account => account.name));
  let balance = 0n, planned = 0n;
  for (const row of finance.transactions) if (active.has(row.account)) balance += BigInt(row.cents);
  for (const expense of plans.expenses) planned += BigInt(expense.cents);
  const exact = (value: bigint) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Planned expense totals exceed the supported amount range.');
    return Number(value);
  };
  return { balance: exact(balance), planned: exact(planned), remaining: exact(balance - planned) };
}
