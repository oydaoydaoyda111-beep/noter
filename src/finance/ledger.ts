import { saveTransaction, type Finance, type Transaction } from './model.ts';

export interface TransactionTotals {
  entries: number; incoming: number; outgoing: number; net: number;
}
export interface TransactionDateGroup {
  date: string; rows: Transaction[];
}

const supportedAmount = BigInt(Number.MAX_SAFE_INTEGER);

function supportedCents(cents: bigint): number {
  if (cents < -supportedAmount || cents > supportedAmount) throw new Error('Transaction totals exceed the supported amount range.');
  return Number(cents);
}

function exactCents(cents: number): bigint {
  if (!Number.isSafeInteger(cents)) throw new Error('Transaction totals exceed the supported amount range.');
  return BigInt(cents);
}

/** Totals for every supplied ledger entry, including opening balances and transfer sides. */
export function summarizeTransactions(rows: readonly Transaction[]): TransactionTotals {
  let incoming = 0n, outgoing = 0n;
  for (const row of rows) {
    const cents = exactCents(row.cents);
    if (cents > 0n) incoming += cents;
    else outgoing -= cents;
  }
  return { entries: rows.length, incoming: supportedCents(incoming), outgoing: supportedCents(outgoing), net: supportedCents(incoming - outgoing) };
}

/** Newest dates first; rows within each date retain the supplied ledger order. */
export function groupTransactionsByDate(rows: readonly Transaction[]): TransactionDateGroup[] {
  const dates = new Map<string, Transaction[]>();
  for (const row of rows) {
    const group = dates.get(row.date);
    if (group) group.push(row);
    else dates.set(row.date, [row]);
  }
  return [...dates.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, entries]) => ({ date, rows: entries }));
}

/** Historical account balance after each entry; equal dates retain stored order. */
export function balancesAfterTransactions(rows: readonly Transaction[]): Map<string, number | null> {
  const accounts = new Map<string, bigint>(), result = new Map<string, number | null>();
  for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const balance = (accounts.get(row.account) ?? 0n) + exactCents(row.cents);
    accounts.set(row.account, balance);
    result.set(row.id, balance < -supportedAmount || balance > supportedAmount ? null : Number(balance));
  }
  return result;
}

/** Current account balances if the draft were saved, including replacement of linked transfers. */
export function projectTransactionBalances(finance: Finance, row: Transaction, destination?: string): Map<string, number | null> {
  const projected = saveTransaction(finance, row, destination);
  const accounts = new Map(finance.accounts.map(account => [account.name, 0n]));
  for (const transaction of projected.transactions) accounts.set(transaction.account, (accounts.get(transaction.account) ?? 0n) + exactCents(transaction.cents));
  return new Map([...accounts].map(([account, cents]) => [account, cents < -supportedAmount || cents > supportedAmount ? null : Number(cents)]));
}
