import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTransactions, groupTransactionsByDate, balancesAfterTransactions, projectTransactionBalances } from '../src/finance/ledger.ts';
import { saveTransaction } from '../src/finance/model.ts';

const transaction = (overrides = {}) => ({
  id: crypto.randomUUID(), date: '2026-10-04', cents: -1234, account: 'Checking',
  category: 'Food', subcategory: '', payee: 'Test', note: '', ...overrides,
});

test('an empty ledger has zero totals and no date groups', () => {
  assert.deepEqual(summarizeTransactions([]), { entries: 0, incoming: 0, outgoing: 0, net: 0 });
  assert.deepEqual(groupTransactionsByDate([]), []);
});

test('filtered ledger totals include every supplied entry and preserve exact cents', () => {
  const rows = [
    transaction({ cents: 10010, category: 'Initial' }), transaction({ cents: -325 }),
    transaction({ cents: 50, category: 'Refund' }),
    transaction({ cents: -1000, transferId: 'pair', category: 'Transfer to other account' }),
    transaction({ cents: 1000, transferId: 'pair', account: 'Savings', category: 'Transfer to other account' }),
    transaction({ cents: -20, category: 'Transfer to other account' }), transaction({ cents: 0 }),
  ];
  const saved = structuredClone(rows);
  assert.deepEqual(summarizeTransactions(rows), { entries: 7, incoming: 11060, outgoing: 1345, net: 9715 });
  assert.deepEqual(summarizeTransactions(rows.filter(row => row.account === 'Savings')), { entries: 1, incoming: 1000, outgoing: 0, net: 1000 });
  assert.deepEqual(summarizeTransactions(rows.filter(row => row.cents < 0)), { entries: 3, incoming: 0, outgoing: 1345, net: -1345 });
  assert.deepEqual(rows, saved);
});

test('date groups are newest first and keep equal-date transaction order without mutating the ledger', () => {
  const rows = [
    transaction({ id: 'older', date: '2025-12-31', cents: -10 }),
    transaction({ id: 'first', date: '2026-10-04', cents: 101 }),
    transaction({ id: 'middle', date: '2026-01-01', cents: -25 }),
    transaction({ id: 'second', date: '2026-10-04', cents: -1 }),
  ];
  const saved = structuredClone(rows);
  Object.freeze(rows);
  const groups = groupTransactionsByDate(rows);
  assert.deepEqual(groups.map(group => group.date), ['2026-10-04', '2026-01-01', '2025-12-31']);
  assert.deepEqual(groups[0].rows.map(row => row.id), ['first', 'second']);
  assert.equal(groups[0].rows[0], rows[1]);
  assert.notEqual(groups[0].rows, rows);
  assert.deepEqual(groups.map(group => summarizeTransactions(group.rows)), [
    { entries: 2, incoming: 101, outgoing: 1, net: 100 },
    { entries: 1, incoming: 0, outgoing: 25, net: -25 },
    { entries: 1, incoming: 0, outgoing: 10, net: -10 },
  ]);
  groups[0].rows.pop();
  assert.deepEqual(rows, saved);
});

test('supported-range totals and cancellation are exact regardless of transaction order', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const rows = [transaction({ cents: maximum - 1 }), transaction({ cents: -maximum }), transaction({ cents: 1 })];
  const expected = { entries: 3, incoming: maximum, outgoing: maximum, net: 0 };
  assert.deepEqual(summarizeTransactions(rows), expected);
  assert.deepEqual(summarizeTransactions([...rows].reverse()), expected);
  assert.deepEqual(summarizeTransactions([transaction({ cents: maximum })]), { entries: 1, incoming: maximum, outgoing: 0, net: maximum });
  assert.deepEqual(summarizeTransactions([transaction({ cents: -maximum })]), { entries: 1, incoming: 0, outgoing: maximum, net: -maximum });
});

test('overflow is explicit for incoming and outgoing totals, even when net cancels', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const sign of [-1, 1]) {
    const rows = [transaction({ cents: sign * maximum }), transaction({ cents: sign })];
    assert.throws(() => summarizeTransactions(rows), /supported amount range/);
    assert.equal(groupTransactionsByDate(rows)[0].rows.length, 2);
    assert.throws(() => summarizeTransactions([...rows, transaction({ cents: -sign * maximum })]), /supported amount range/);
  }
  for (const cents of [maximum + 1, -maximum - 1, 1.234, NaN, Infinity]) {
    assert.throws(() => summarizeTransactions([transaction({ cents })]), /supported amount range/);
  }
});

const finance = (transactions = []) => ({
  version: 1, accounts: [{ name: 'Checking', note: '' }, { name: 'Savings', note: '' }, { name: 'Empty', note: '' }],
  transactions, categories: [], sourceName: '', template: new Uint8Array(),
});

test('historical balances use full account history, ascending dates and stable same-day stored order', () => {
  const rows = [
    transaction({ id: 'later', date: '2026-10-04', cents: -200 }),
    transaction({ id: 'first', date: '2026-10-02', cents: 50 }),
    transaction({ id: 'opening', date: '2026-10-01', cents: 1000, category: 'Initial' }),
    transaction({ id: 'out', date: '2026-10-03', cents: -300, transferId: 'pair' }),
    transaction({ id: 'second', date: '2026-10-02', cents: -25 }),
    transaction({ id: 'in', date: '2026-10-03', cents: 300, account: 'Savings', transferId: 'pair' }),
    transaction({ id: 'savings-opening', date: '2026-10-01', cents: 100, account: 'Savings', category: 'Initial' }),
  ];
  const saved = structuredClone(rows);
  Object.freeze(rows);
  assert.deepEqual([...balancesAfterTransactions(rows)], [
    ['opening', 1000], ['savings-opening', 100], ['first', 1050], ['second', 1025],
    ['out', 725], ['in', 400], ['later', 525],
  ]);
  assert.deepEqual(rows, saved);
  assert.deepEqual([...balancesAfterTransactions([])], []);
});

test('historical overflow remains unavailable until exact later cancellation restores supported balances', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const sign of [-1, 1]) {
    const rows = [transaction({ id: 'start', cents: sign * maximum }), transaction({ id: 'overflow', cents: sign }), transaction({ id: 'recover', cents: -sign })];
    assert.deepEqual([...balancesAfterTransactions(rows)], [['start', sign * maximum], ['overflow', null], ['recover', sign * maximum]]);
  }
  assert.throws(() => balancesAfterTransactions([transaction({ cents: 1.5 })]), /supported amount range/);
});

test('balance previews apply new entries and edited account changes without changing saved data', () => {
  const source = finance([
    transaction({ id: 'opening', date: '2026-10-01', cents: 1000, category: 'Initial' }),
    transaction({ id: 'expense', cents: -100 }), transaction({ cents: 200, account: 'Savings' }),
  ]);
  const saved = structuredClone(source);
  assert.deepEqual([...projectTransactionBalances(source, transaction({ cents: -200 }))], [['Checking', 700], ['Savings', 200], ['Empty', 0]]);
  assert.deepEqual([...projectTransactionBalances(source, transaction({ id: 'expense', cents: -150, account: 'Savings' }))], [['Checking', 1000], ['Savings', 50], ['Empty', 0]]);
  assert.deepEqual([...projectTransactionBalances(source, transaction({ id: 'income', date: '2025-01-01', cents: 25 }))], [['Checking', 925], ['Savings', 200], ['Empty', 0]]);
  assert.deepEqual(source, saved);
});

test('transfer balance previews replace both linked entries and can change transfer direction or become ordinary entries', () => {
  const source = finance([transaction({ cents: 1000, category: 'Initial' }), transaction({ cents: 200, account: 'Savings' })]);
  const draft = transaction({ id: 'out', cents: -250 });
  assert.deepEqual([...projectTransactionBalances(source, draft, 'Savings')], [['Checking', 750], ['Savings', 450], ['Empty', 0]]);
  const transferred = saveTransaction(source, draft, 'Savings'), saved = structuredClone(transferred);
  assert.deepEqual([...projectTransactionBalances(transferred, { ...draft, cents: -300 }, 'Savings')], [['Checking', 700], ['Savings', 500], ['Empty', 0]]);
  const incoming = transferred.transactions.find(row => row.transferId && row.account === 'Savings');
  assert.deepEqual([...projectTransactionBalances(transferred, { ...incoming, cents: -300 }, 'Checking')], [['Checking', 1300], ['Savings', -100], ['Empty', 0]]);
  assert.deepEqual([...projectTransactionBalances(transferred, { ...draft, cents: -50 })], [['Checking', 950], ['Savings', 200], ['Empty', 0]]);
  assert.deepEqual(transferred, saved);
  assert.throws(() => projectTransactionBalances(source, draft, 'Checking'), /different destination/);
  assert.throws(() => projectTransactionBalances(source, { ...draft, date: '2026-02-30' }), /valid date/);
});

test('preview totals allow intermediate overflow with final cancellation and isolate unsupported account balances', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const source = finance([transaction({ cents: maximum }), transaction({ cents: 1 }), transaction({ cents: -maximum })]);
  assert.equal(projectTransactionBalances(source, transaction({ cents: 1 })).get('Checking'), 2);
  for (const sign of [-1, 1]) {
    assert.equal(projectTransactionBalances(finance([transaction({ cents: sign * maximum })]), transaction({ cents: sign })).get('Checking'), null);
    const withOverflow = finance([transaction({ cents: sign * maximum }), transaction({ cents: sign })]);
    assert.deepEqual([...projectTransactionBalances(withOverflow, transaction({ account: 'Savings', cents: 25 }))], [['Checking', null], ['Savings', 25], ['Empty', 0]]);
  }
});
