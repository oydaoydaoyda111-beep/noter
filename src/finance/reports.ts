import type { Finance } from './model.ts';
import { isTransferCategory } from './categories.ts';

export interface CategoryReport { category: string; income: number; expenses: number }
export interface MonthlyReport {
  month: string; income: number; expenses: number; net: number; entries: number;
  categories: CategoryReport[];
}

function monthDate(month: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a valid report month.');
  return new Date(`${month}-01T12:00:00Z`);
}

export function monthRange(month: string): [string, string] {
  const end = monthDate(month); end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return [`${month}-01`, end.toISOString().slice(0, 10)];
}

function addCents(total: number, cents: number): number {
  const next = total + cents;
  if (!Number.isSafeInteger(next)) throw new Error('Report totals exceed the supported amount range.');
  return next;
}

/** Six calendar months ending at the selection. Reports derive from the ledger without changing it. */
export function monthlyReports(finance: Finance, month: string, account = ''): MonthlyReport[] {
  const selected = monthDate(month);
  const periods = new Map<string, MonthlyReport & { groups: Map<string, CategoryReport> }>();
  for (let offset = -5; offset <= 0; offset++) {
    const date = new Date(selected); date.setUTCMonth(date.getUTCMonth() + offset);
    const key = date.toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue; // Dates before year zero cannot occur in the file format.
    periods.set(key, { month: key, income: 0, expenses: 0, net: 0, entries: 0, categories: [], groups: new Map() });
  }
  for (const row of finance.transactions) {
    if ((account && row.account !== account) || row.transferId || isTransferCategory(row.category) || row.category.trim().toLowerCase() === 'initial') continue;
    const period = periods.get(row.date.slice(0, 7)); if (!period) continue;
    const kind = row.cents > 0 ? 'income' : 'expenses', cents = Math.abs(row.cents);
    period[kind] = addCents(period[kind], cents); period.entries++;
    let category = period.groups.get(row.category);
    if (!category) { category = { category: row.category, income: 0, expenses: 0 }; period.groups.set(row.category, category); }
    category[kind] = addCents(category[kind], cents);
  }
  return [...periods.values()].map(({ groups, ...period }) => ({ ...period, net: period.income - period.expenses, categories: [...groups.values()] }));
}
