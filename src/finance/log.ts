import type { Finance, Transaction } from './model.ts';

// Finance is stored as one append-only log per device in .noter/finance/log-<device>.jsonl.
// Each device appends only to its own file, avoiding competing writes during normal sync.
// Every line is one batch of changes; replaying all batches ordered by (ts, dev, seq) gives
// the current data, with the latest change winning for each transaction or setting.
// The Android client implements the same format in FinanceLog.kt; keep both in step.

export const metaKeys = ['accounts', 'categories', 'categoryDefinitions', 'defaults', 'sourceName', 'templateSha256'] as const;
type MetaKey = typeof metaKeys[number];
export type FinanceOp = { k: 'reset' } | { k: 'tx'; id: string; tx: Transaction | null } | { k: 'meta'; key: MetaKey; value: unknown };
export interface FinanceBatch { v: 1; ts: number; dev: string; seq: number; ops: FinanceOp[] }
export interface LogFile { name: string; text: string }
export type FinanceData = Omit<Finance, 'template'>;

function invalid(): never { throw new Error('Finance log contains invalid data. Keep the files and restore a valid backup before editing.'); }
const isString = (value: unknown): value is string => typeof value === 'string';

export function canonicalTransaction(row: Transaction): Transaction {
  const result: Transaction = { id: row.id, date: row.date, cents: row.cents, account: row.account, category: row.category, subcategory: row.subcategory, payee: row.payee, note: row.note };
  if (row.transferId) result.transferId = row.transferId;
  return result;
}

function metaValue(data: FinanceData, key: MetaKey, templateSha256: string): unknown {
  switch (key) {
    case 'accounts': return data.accounts.map(account => account.archived === undefined ? { name: account.name, note: account.note } : { name: account.name, note: account.note, archived: account.archived });
    case 'categories': return data.categories;
    case 'categoryDefinitions': return data.categoryDefinitions ?? null;
    case 'defaults': return data.defaults ? { account: data.defaults.account, category: data.defaults.category } : null;
    case 'sourceName': return data.sourceName;
    case 'templateSha256': return templateSha256;
  }
}

/** Operations that turn `base` into `next`. Without a base, the batch replaces all Finance data. */
export function diffFinance(base: { data: FinanceData; templateSha256: string } | undefined, next: FinanceData, templateSha256: string): FinanceOp[] {
  const ops: FinanceOp[] = [];
  if (!base) ops.push({ k: 'reset' });
  for (const key of metaKeys) {
    const value = metaValue(next, key, templateSha256);
    if (!base || JSON.stringify(metaValue(base.data, key, base.templateSha256)) !== JSON.stringify(value)) ops.push({ k: 'meta', key, value });
  }
  const previous = new Map((base?.data.transactions ?? []).map(row => [row.id, JSON.stringify(canonicalTransaction(row))]));
  const current = new Set<string>();
  for (const row of next.transactions) {
    current.add(row.id);
    const tx = canonicalTransaction(row);
    if (previous.get(row.id) !== JSON.stringify(tx)) ops.push({ k: 'tx', id: row.id, tx });
  }
  for (const id of previous.keys()) if (!current.has(id)) ops.push({ k: 'tx', id, tx: null });
  return ops;
}

function validBatch(value: unknown): FinanceBatch {
  const batch = value as FinanceBatch;
  if (!batch || batch.v !== 1 || !Number.isSafeInteger(batch.ts) || !isString(batch.dev) || !batch.dev || !Number.isSafeInteger(batch.seq) || !Array.isArray(batch.ops)) invalid();
  for (const op of batch.ops) {
    if (op?.k === 'reset') continue;
    if (op?.k === 'tx' && isString(op.id) && op.id && (op.tx === null || (typeof op.tx === 'object' && op.tx.id === op.id))) continue;
    if (op?.k === 'meta' && (metaKeys as readonly string[]).includes(op.key)) continue;
    invalid();
  }
  return batch;
}

export interface ParsedLogs { batches: FinanceBatch[]; clock: number; seq: number; ownNeedsNewline: boolean }

/** Parses every log file. A final line without a newline is an interrupted write and is ignored. */
export function parseLogs(files: LogFile[], device: string): ParsedLogs {
  const seen = new Map<string, FinanceBatch>();
  let clock = 0, seq = 0, ownNeedsNewline = false;
  for (const file of files) {
    const lines = file.text.split('\n');
    const tail = lines.pop() ?? '';
    if (tail.trim() && file.name === `log-${device}.jsonl`) ownNeedsNewline = true;
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { invalid(); }
      const batch = validBatch(parsed);
      seen.set(`${batch.dev}\u0000${batch.seq}`, batch);
      clock = Math.max(clock, batch.ts);
      if (batch.dev === device) seq = Math.max(seq, batch.seq);
    }
  }
  return { batches: [...seen.values()], clock, seq, ownNeedsNewline };
}

/** Replays batches into Finance data; returns undefined when Finance was never started. */
export function replayFinance(batches: FinanceBatch[]): { data: FinanceData; templateSha256: string } | undefined {
  const ordered = [...batches].sort((a, b) => a.ts - b.ts || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || a.seq - b.seq);
  const rows = new Map<string, Transaction>();
  const meta: Partial<Record<MetaKey, unknown>> = {};
  for (const batch of ordered) for (const op of batch.ops) {
    if (op.k === 'reset') { rows.clear(); for (const key of metaKeys) delete meta[key]; }
    else if (op.k === 'tx') { if (op.tx) rows.set(op.id, op.tx); else rows.delete(op.id); }
    else meta[op.key] = op.value;
  }
  const accounts = Array.isArray(meta.accounts) ? meta.accounts as Finance['accounts'] : [];
  const transactions = [...rows.values()];
  if (!accounts.length && !transactions.length) return undefined;
  // Concurrent edits on different devices can leave references that no longer line up.
  // Repair them without losing amounts: restore missing accounts and unlink broken transfers.
  const names = new Set(accounts.map(account => account.name));
  for (const row of transactions) if (isString(row.account) && !names.has(row.account)) { accounts.push({ name: row.account, note: '' }); names.add(row.account); }
  const groups = new Map<string, Transaction[]>();
  for (const row of transactions) if (row.transferId) groups.set(row.transferId, [...groups.get(row.transferId) ?? [], row]);
  const repaired = transactions.map(row => {
    const pair = row.transferId ? groups.get(row.transferId)! : undefined;
    if (!pair || (pair.length === 2 && pair[0].cents === -pair[1].cents && pair[0].account !== pair[1].account && pair[0].date === pair[1].date)) return row;
    const copy = { ...row }; delete copy.transferId; return copy;
  });
  const data: FinanceData = { version: 1, accounts, transactions: repaired, categories: Array.isArray(meta.categories) ? meta.categories as string[] : [], sourceName: isString(meta.sourceName) ? meta.sourceName : '' };
  if (meta.defaults) data.defaults = meta.defaults as Finance['defaults'];
  if (meta.categoryDefinitions) data.categoryDefinitions = meta.categoryDefinitions as Finance['categoryDefinitions'];
  return { data, templateSha256: isString(meta.templateSha256) ? meta.templateSha256 : '' };
}

export function batchLine(device: string, clock: number, seq: number, ops: FinanceOp[]): { line: string; ts: number } {
  const ts = Math.max(Date.now(), clock + 1);
  if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(seq)) throw new Error('Finance log timestamp or sequence is outside the supported range.');
  return { line: `${JSON.stringify({ v: 1, ts, dev: device, seq, ops })}\n`, ts };
}
