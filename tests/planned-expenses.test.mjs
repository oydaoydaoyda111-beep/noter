import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedTotals, validateExpensePlans } from '../src/finance/planned.ts';

const plans = expenses => ({ version: 1, expenses });
const expense = (cents = 125) => ({ id: 'one', name: 'Lunch', cents });
test('planned totals use all active accounts, exact cents and permit shortfalls', () => {
  const finance = { accounts: [{ name: 'Cash' }, { name: 'Bank' }, { name: 'Old', archived: true }], transactions: [
    { account: 'Cash', cents: 10010 }, { account: 'Bank', cents: -15 }, { account: 'Old', cents: 99999 },
    { account: 'Cash', cents: -1000 }, { account: 'Bank', cents: 1000 },
  ] };
  assert.deepEqual(plannedTotals(finance, plans([expense(10000)])), { balance: 9995, planned: 10000, remaining: -5 });
  assert.deepEqual(plannedTotals(finance, plans([])), { balance: 9995, planned: 0, remaining: 9995 });
  assert.deepEqual(plannedTotals({ accounts: [], transactions: finance.transactions }, plans([expense()])), { balance: 0, planned: 125, remaining: -125 });
});
test('planned totals reject overflow without rounding', () => {
  const finance = { accounts: [{ name: 'Cash' }], transactions: [{ account: 'Cash', cents: Number.MAX_SAFE_INTEGER }, { account: 'Cash', cents: 1 }] };
  assert.throws(() => plannedTotals(finance, plans([])), /supported amount/);
  assert.throws(() => plannedTotals({ accounts: [], transactions: [] }, plans([expense(Number.MAX_SAFE_INTEGER), { ...expense(1), id: 'two' }])), /supported amount/);
});
test('planned storage validates round trips, identities and positive integer cents', () => {
  const original = plans([expense()]);
  assert.deepEqual(validateExpensePlans(JSON.parse(JSON.stringify(original))), original);
  for (const value of [null, {}, { version: 2, expenses: [] }, plans([expense(), expense()]), ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(cents => plans([expense(cents)])), plans([{ ...expense(), name: ' ' }])]) assert.throws(() => validateExpensePlans(value));
});
