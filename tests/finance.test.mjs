import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { mockIPC } from '@tauri-apps/api/mocks';
import { money, balances, saveTransaction, removeTransaction, validateFinanceFile } from '../src/finance/model.ts';
import { budgetProgress, saveBudget, removeBudget, validateBudgets } from '../src/finance/budgets.ts';
import { monthlyReports, monthRange } from '../src/finance/reports.ts';
import { transactionSelection, updateTransactions, removeTransactions } from '../src/finance/bulk.ts';
import { diffFinance, parseLogs, replayFinance, batchLine } from '../src/finance/log.ts';
import { importWorkbook, exportWorkbook } from '../src/finance/excel.ts';
import { categoryCatalog, addCategory, renameCategory, mergeCategories, deleteCategory, registerCategory } from '../src/finance/categories.ts';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.window = { crypto: globalThis.crypto };
mockIPC((command, args) => {
  if (command === 'unpack_workbook') {
    let total = 0;
    const files = unzipSync(new Uint8Array(args.bytes), { filter: file => {
      total += file.originalSize;
      if (total > 40_000_000) throw new Error('Workbook expands beyond the supported 40 MB limit.');
      return true;
    } });
    return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Array.from(bytes)]));
  }
  if (command === 'pack_workbook') return Array.from(zipSync(Object.fromEntries(Object.entries(args.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]))));
  throw new Error(`Unexpected native command: ${command}`);
});
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export function fixture() {
  const cell = (ref, value) => typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const row = (index, values) => `<row r="${index}">${values.map((value, col) => cell(`${String.fromCharCode(66 + col)}${index}`, value)).join('')}</row>`;
  const sheet = rows => `<worksheet xmlns="${ns}"><dimension ref="B2:H8"/><sheetData>${rows}</sheetData></worksheet>`;
  const files = {
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="actions" sheetId="1" r:id="rId1"/><sheet name="current" sheetId="2" r:id="rId2"/><sheet name="planned" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Target="calcChain.xml"/></Relationships>',
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/calcChain.xml" ContentType="application/xml"/></Types>',
    'xl/worksheets/sheet1.xml': sheet(row(2, ['Date','Amount','Account','Category','Subcategory','Payee/Payer','Note']) + row(3, [45933,100.10,'Checking','Initial','','','']) + row(4, [45934,-0.20,'Checking','Food','','Cafe','Lunch']) + '<row r="5"><c r="C5"><f>SUBTOTAL(109,Table2[Amount])</f><v>99.9</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet(row(2,['Name','Value','Notes']) + row(3,['Checking',99.9,'Keep this note']) + row(4,['Savings',0,'']) + '<row r="5"><c r="C5"><f>SUBTOTAL(109,Table1[Value])</f><v>99.9</v></c></row><row r="23"><c r="G23" s="1"/></row>'),
    'xl/worksheets/sheet3.xml': sheet(row(2,['Planned','Cost']) + row(3,['Purchase',15])),
    'xl/tables/table1.xml': `<table xmlns="${ns}" name="Table2" ref="B2:H5"><autoFilter ref="B2:H4"/></table>`,
    'xl/tables/table2.xml': `<table xmlns="${ns}" name="Table1" ref="B2:D5"><autoFilter ref="B2:D4"/></table>`,
    'xl/styles.xml': '<styles>unchanged</styles>',
    'xl/calcChain.xml': '<calcChain/>'
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, xml]) => [path, strToU8(xml)])));
}
const transaction = (overrides = {}) => ({ id: crypto.randomUUID(), date:'2026-10-03', cents:-1234, account:'Checking', category:'Food', subcategory:'', payee:'Test', note:'', ...overrides });
test('monthly reports derive exact cash flow and categories without changing synced Finance data', async () => {
  const initial = await importWorkbook(fixture(), 'synthetic.xlsx');
  const source = { ...initial, accounts: initial.accounts.map(account => account.name === 'Savings' ? { ...account, archived: true } : account), budgets: [{ month: '2026-10', category: 'Food', cents: 5000 }], transactions: [
    transaction({ cents: 550050, category: 'Salary' }), transaction(), transaction({ cents: -2200, account: 'Savings' }),
    transaction({ cents: 99 }), transaction({ cents: -50, category: '' }),
    transaction({ cents: 999999, category: 'Initial' }), transaction({ cents: -999999, category: ' initial ' }),
    transaction({ cents: -10000, category: ' transfer TO other ACCOUNT ' }),
    transaction({ cents: -10000, transferId: 'pair' }), transaction({ cents: 10000, account: 'Savings', transferId: 'pair' }),
    transaction({ date: '2026-09-30', cents: 5000, category: 'Salary' }), transaction({ date: '2026-09-01', cents: -1400 }),
    transaction({ date: '2026-05-01', cents: -200 }), transaction({ date: '2026-04-30', cents: -600 }), transaction({ date: '2026-11-01', cents: 600 }),
  ] };
  const saved = structuredClone(source), reports = monthlyReports(source, '2026-10');
  assert.deepEqual(reports.map(report => report.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(reports.at(-1), { month: '2026-10', income: 550149, expenses: 3484, net: 546665, entries: 5, categories: [
    { category: 'Salary', income: 550050, expenses: 0 }, { category: 'Food', income: 99, expenses: 3434 }, { category: '', income: 0, expenses: 50 },
  ] });
  assert.equal(reports[0].expenses, 200); assert.equal(reports.at(-2).net, 3600);
  assert.deepEqual(reports[1], { month: '2026-06', income: 0, expenses: 0, net: 0, entries: 0, categories: [] });
  const checking = monthlyReports(source, '2026-10', 'Checking').at(-1), savings = monthlyReports(source, '2026-10', 'Savings').at(-1);
  assert.equal(checking.income, 550149); assert.equal(checking.expenses, 1284); assert.equal(checking.entries, 4);
  assert.equal(savings.income, 0); assert.equal(savings.expenses, 2200); assert.equal(savings.net, -2200); assert.equal(savings.entries, 1);
  assert.equal(monthlyReports(source, '2026-10', 'Missing').at(-1).entries, 0);
  assert.deepEqual(source, saved);
  const replay = replayFinance(parseLogs([{ name: 'log-report-device.jsonl', text: batchLine('report-device', 0, 1, diffFinance(undefined, source, '')).line }], 'report-device').batches);
  assert.deepEqual(monthlyReports({ ...replay.data, template: source.template }, '2026-10'), reports);
  assert.deepEqual(diffFinance(replay, source, ''), []);
});

test('report calendar boundaries and integer overflow are handled explicitly', () => {
  const source = { transactions: [] };
  assert.deepEqual(monthRange('2024-02'), ['2024-02-01', '2024-02-29']);
  assert.deepEqual(monthRange('2026-02'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(monthRange('2026-12'), ['2026-12-01', '2026-12-31']);
  assert.deepEqual(monthRange('0001-01'), ['0001-01-01', '0001-01-31']);
  assert.deepEqual(monthRange('9999-12'), ['9999-12-01', '9999-12-31']);
  assert.deepEqual(monthlyReports(source, '2027-01').map(report => report.month), ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
  assert.equal(monthlyReports(source, '0001-01').length, 6);
  for (const month of ['2026-00', '2026-13', '2026-1', 'invalid', '']) {
    assert.throws(() => monthRange(month), /valid report month/);
    assert.throws(() => monthlyReports(source, month), /valid report month/);
  }
  for (const sign of [-1, 1]) assert.throws(() => monthlyReports({ transactions: [transaction({ cents: sign * Number.MAX_SAFE_INTEGER }), transaction({ cents: sign })] }, '2026-10'), /supported amount range/);
});

test('monthly budgets preserve exact limits, follow categories and survive logs and Excel backups', async () => {
  const initial = await importWorkbook(fixture(), 'synthetic.xlsx');
  let source = { ...initial, transactions: [transaction({ id: 'lunch', cents: -2500 }), transaction({ id: 'dinner', cents: -3500, account: 'Savings', subcategory: 'Dinner' }), transaction({ cents: 5000 }), transaction({ date: '2026-11-03', cents: -9000 }), transaction({ cents: -1000, category: 'Transfer to other account' })] };
  source = saveTransaction(source, transaction({ cents: -8000 }), 'Savings');
  const before = balances(source), ids = source.transactions.map(row => row.id);
  source = saveBudget(source, { month: '2026-10', category: 'Food', cents: 5000 });
  source = saveBudget(source, { month: '2026-11', category: 'Food', cents: 12000 });
  assert.deepEqual(budgetProgress(source, '2026-10'), [{ month: '2026-10', category: 'Food', cents: 5000, spent: 6000 }]);
  assert.equal(budgetProgress(source, '2026-11')[0].spent, 9000);
  assert.deepEqual(budgetProgress(source, '2026-12'), []);
  const renamed = renameCategory(source, 'Food', 'Dining');
  assert.ok(renamed.budgets.every(budget => budget.category === 'Dining'));
  const both = saveBudget(addCategory(renamed, 'Meals'), { month: '2026-10', category: 'Meals', cents: 3000 });
  const merged = mergeCategories(both, 'Dining', 'Meals');
  assert.deepEqual(merged.budgets, [{ month: '2026-10', category: 'Meals', cents: 8000 }, { month: '2026-11', category: 'Meals', cents: 12000 }]);
  assert.deepEqual(balances(merged), before); assert.deepEqual(merged.transactions.map(row => row.id), ids);
  assert.equal(deleteCategory(merged, 'Meals').budgets.length, 0);
  assert.equal(removeBudget(source, source.budgets[0]).budgets.length, 1);
  const restored = await importWorkbook(await exportWorkbook(source), 'backup.xlsx');
  assert.deepEqual(restored.budgets, source.budgets); assert.deepEqual(restored.transactions, source.transactions);
  const batch = batchLine('budget-device', 0, 1, diffFinance(undefined, source, ''));
  const replay = replayFinance(parseLogs([{ name: 'log-budget-device.jsonl', text: batch.line }], 'budget-device').batches);
  assert.deepEqual(replay.data.budgets, source.budgets);
  assert.deepEqual(validateFinanceFile({ ...replay.data, template: source.template }).budgets, source.budgets);
  assert.deepEqual(diffFinance(replay, { ...replay.data, transactions: replay.data.transactions.map(row => row.id === 'lunch' ? { ...row, note: 'Edited' } : row) }, '').map(op => op.k), ['tx']);
  for (const budget of [{ ...source.budgets[0], cents: 0 }, { ...source.budgets[0], cents: Number.MAX_SAFE_INTEGER + 1 }, { ...source.budgets[0], month: '2026-13' }, { ...source.budgets[0], cents: '10' }, { ...source.budgets[0], category: 'Transfer to other account' }]) assert.throws(() => validateBudgets([budget]));
  assert.throws(() => validateBudgets([source.budgets[0], source.budgets[0]]));
  assert.throws(() => validateFinanceFile({ ...source, budgets: null }));
  assert.throws(() => saveBudget(source, source.budgets[1], source.budgets[0]), /already has a budget/);
  const maximum = saveBudget(source, { month: '2026-10', category: 'Meals', cents: Number.MAX_SAFE_INTEGER });
  assert.throws(() => mergeCategories(maximum, 'Food', 'Meals'), /supported amount/);
});

test('bulk changes preserve IDs, amounts and linked transfer pairs and reject unsafe changes', async () => {
  const source = await importWorkbook(fixture(), 'synthetic.xlsx');
  const expense = source.transactions.find(row => row.cents < 0), ids = new Set([expense.id]);
  const updated = updateTransactions(source, ids, { category: 'Dining', subcategory: 'Lunch', account: 'Savings', date: '2026-10-01', payee: 'Cafe', note: '' });
  const changed = updated.transactions.find(row => row.id === expense.id);
  assert.equal(changed.cents, expense.cents); assert.equal(changed.account, 'Savings');
  assert.equal(changed.subcategory, 'Lunch'); assert.equal(source.transactions.find(row => row.id === expense.id).category, 'Food');
  assert.deepEqual(updated.transactions.map(row => row.id), source.transactions.map(row => row.id));
  assert.equal(updateTransactions(updated, ids, { category: 'Other' }).transactions.find(row => row.id === expense.id).subcategory, '');
  const transferred = saveTransaction(source, transaction({ id: 'out' }), 'Savings');
  const pair = transferred.transactions.filter(row => row.transferId), pairIds = transactionSelection(transferred, new Set(['out']));
  assert.equal(pairIds.size, 2);
  const edited = updateTransactions(transferred, new Set(['out']), { date: '2026-10-04', note: 'Both entries' });
  assert.ok(edited.transactions.filter(row => pairIds.has(row.id)).every(row => row.date === '2026-10-04' && row.note === 'Both entries'));
  assert.deepEqual(balances(edited), balances(transferred));
  assert.deepEqual(removeTransactions(edited, new Set([pair[1].id])).transactions, source.transactions);
  for (const patch of [{}, { date: '2026-02-30' }, { account: 'Missing' }, { note: 'x'.repeat(2001) }, { cents: 1 }, { subcategory: 'Orphan' }, { category: '', subcategory: 'Orphan' }]) assert.throws(() => updateTransactions(source, ids, patch));
  assert.throws(() => updateTransactions(transferred, pairIds, { account: 'Checking' }), /linked transfers/);
  assert.throws(() => updateTransactions(transferred, pairIds, { category: 'Other' }), /linked transfers/);
  assert.throws(() => updateTransactions(source, new Set(['missing']), { note: 'No' }), /select them again/);
  assert.throws(() => removeTransactions(source, new Set(['missing'])), /select them again/);
  const archived = { ...source, accounts: source.accounts.map(account => account.name === 'Savings' ? { ...account, archived: true } : account) };
  assert.throws(() => updateTransactions(archived, ids, { account: 'Savings' }), /active account/);
  assert.deepEqual(removeTransactions(source, ids).transactions, source.transactions.filter(row => row.id !== expense.id));
});
test('money uses exact minor units and rejects unsupported precision', () => {
  assert.equal(money('0.10'), 10); assert.equal(money('-123.45'), -12345);
  for (const value of ['1.234','NaN','1e5','', '9007199254740991']) assert.throws(() => money(value));
});
test('transfers are balanced and editing/deleting updates both entries', async () => {
  const source = await importWorkbook(fixture(),'test.xlsx');
  const before = [...balances(source).values()].reduce((a,b) => a+b,0);
  const row = transaction(); const transferred = saveTransaction(source,row,'Savings');
  assert.equal(transferred.transactions.length,4);
  assert.equal([...balances(transferred).values()].reduce((a,b) => a+b,0),before);
  const edited = saveTransaction(transferred,{...row,cents:-500},'Savings');
  assert.equal(edited.transactions.length,4); assert.equal(balances(edited).get('Savings'),500);
  assert.deepEqual(balances(removeTransaction(edited,row.id)),balances(source));
  assert.throws(() => saveTransaction(source,row,'Checking'));
  assert.throws(() => saveTransaction(source,transaction({date:'2026-02-30'})));
});
test('Excel backup preserves untouched parts, formulas, dates, IDs, and transfer groups', async () => {
  const template = fixture(); let source = await importWorkbook(template,'test.xlsx');
  assert.equal(source.transactions.length,2); assert.equal(balances(source).get('Checking'),9990);
  source = saveTransaction(source,transaction({note:'<script>& =SUM(1,2)'}),'Savings');
  source.accounts.push({name:'New account',note:'New note'});
  const output = await exportWorkbook(source); const restored = await importWorkbook(output,'backup.xlsx');
  assert.deepEqual(restored.transactions,source.transactions);
  assert.deepEqual(restored.accounts,source.accounts);
  assert.deepEqual(balances(restored),balances(source));
  const before = unzipSync(template), after = unzipSync(output);
  assert.deepEqual(after['xl/styles.xml'],before['xl/styles.xml']);
  assert.deepEqual(after['xl/worksheets/sheet3.xml'],before['xl/worksheets/sheet3.xml']);
  assert.equal(after['xl/calcChain.xml'],undefined);
  const current = strFromU8(after['xl/worksheets/sheet2.xml']);
  assert.match(current,/SUMIF\(Table2\[Account\]/); assert.match(current,/SUBTOTAL\(109,Table1\[Value\]\)/); assert.match(current,/G23/);
  assert.match(strFromU8(after['xl/tables/table1.xml']),/B2:H7/);
  assert.match(strFromU8(after['xl/tables/table2.xml']),/B2:D6/);
  const exportedAgain = await importWorkbook(await exportWorkbook(restored),'again.xlsx');
  assert.deepEqual(exportedAgain.transactions,source.transactions);
});
test('import refuses malformed ledgers without silently dropping entries', async () => {
  const parts = unzipSync(fixture());
  parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml']).replace('<v>-0.2</v>','<v>invalid</v>'));
  await assert.rejects(importWorkbook(zipSync(parts),'bad.xlsx'),/incomplete/);
});
test('category changes migrate labels and defaults without changing balances or transaction identity', async () => {
  let source = await importWorkbook(fixture(), 'test.xlsx');
  source = registerCategory(saveTransaction(source, transaction({subcategory:'Lunch'})), 'Food', 'Lunch');
  source.defaults = {account:'Checking', category:'Food'};
  const before = balances(source), ids = source.transactions.map(row => row.id);
  const renamed = renameCategory(source, 'Food', 'Dining');
  assert.equal(renamed.defaults.category, 'Dining');
  assert.ok(renamed.transactions.filter(row => row.cents < 0).every(row => row.category === 'Dining'));
  assert.equal(source.transactions.at(-1).category, 'Food'); // operations never mutate saved state
  const sub = renameCategory(renamed, 'Dining', 'Lunch out', 'Lunch');
  assert.equal(sub.transactions.at(-1).subcategory, 'Lunch out');
  const merged = mergeCategories(addCategory(sub, 'Meals'), 'Dining', 'Meals');
  assert.equal(merged.defaults.category, 'Meals');
  assert.ok(categoryCatalog(merged).find(item => item.name === 'Meals').subcategories.includes('Lunch out'));
  assert.ok(!categoryCatalog(merged).some(item => item.name === 'Dining'));
  const clearedSub = deleteCategory(merged,'Meals','Lunch out');
  assert.equal(clearedSub.transactions.at(-1).subcategory, '');
  const cleared = deleteCategory(clearedSub,'Meals');
  assert.equal(cleared.transactions.at(-1).category, ''); assert.equal(cleared.defaults.category,'');
  assert.deepEqual(balances(cleared),before); assert.deepEqual(cleared.transactions.map(row => row.id),ids);
});
test('category catalog upgrades legacy data and protects transfers and duplicate names', async () => {
  const source = await importWorkbook(fixture(),'test.xlsx');
  source.transactions.at(-1).subcategory = 'Lunch';
  assert.deepEqual(categoryCatalog(source).find(item => item.name === 'Food').subcategories,['Lunch']);
  assert.throws(() => addCategory(source, ' food '), /already exists/);
  assert.throws(() => addCategory(source, '  '), /name/);
  assert.throws(() => addCategory(source, 'lunch', 'Food'), /already exists/);
  assert.throws(() => renameCategory(source,'Food','Initial'), /Merge/);
  assert.throws(() => deleteCategory(source,'Transfer to other account'), /reserved/);
  assert.throws(() => mergeCategories(source,'Food','Transfer to other account'), /editable/);
});
test('Excel backups restore unused categories and subcategories as well as renamed transaction labels', async () => {
  let source = await importWorkbook(fixture(),'test.xlsx');
  source = addCategory(source,'Travel'); source = addCategory(source,'Flights','Travel');
  source = renameCategory(source,'Food','Dining');
  const restored = await importWorkbook(await exportWorkbook(source),'backup.xlsx');
  assert.deepEqual(categoryCatalog(restored),categoryCatalog(source));
  assert.deepEqual(restored.transactions,source.transactions);
  assert.deepEqual(balances(restored),balances(source));
});
test('actual bank workbook round trip and other five sheets remain intact', {skip: !process.env.BANK_TEST_WORKBOOK}, async () => {
  const bytes = new Uint8Array(readFileSync(process.env.BANK_TEST_WORKBOOK));
  const finance = await importWorkbook(bytes,'bank.xlsx');
  assert.equal(finance.transactions.length,691); assert.equal(finance.accounts.length,6);
  const output = await exportWorkbook(finance), restored = await importWorkbook(output,'backup.xlsx');
  assert.ok(JSON.stringify(restored.transactions) === JSON.stringify(finance.transactions), 'All private transaction fields must survive the round trip.');
  assert.ok(JSON.stringify(restored.accounts) === JSON.stringify(finance.accounts), 'Account names and notes must survive the round trip.');
  assert.deepEqual(balances(restored),balances(finance));
  const before = unzipSync(bytes), after = unzipSync(output);
  for (let sheet = 3; sheet <= 7; sheet++) assert.deepEqual(after[`xl/worksheets/sheet${sheet}.xml`],before[`xl/worksheets/sheet${sheet}.xml`]);
  assert.deepEqual(after['xl/styles.xml'],before['xl/styles.xml']);
  // Existing account formula caches reconcile to imported entries within a cent.
  const current = new DOMParser().parseFromString(strFromU8(before['xl/worksheets/sheet2.xml']),'text/xml');
  const cache = Array.from(current.getElementsByTagName('c')).filter(cell => /^C[3-8]$/.test(cell.getAttribute('r'))).map(cell => Math.round(Number(cell.getElementsByTagName('v')[0].textContent) * 100));
  assert.deepEqual(cache,finance.accounts.map(account => balances(finance).get(account.name)));
});

test('account edits migrate history and transfer links without changing totals', async () => {
  const { updateAccount, archiveAccount } = await import('../src/finance/accounts.ts');
  const original = await importWorkbook(fixture(), 'sample.xlsx');
  const finance = saveTransaction({ ...original, defaults: { account: 'Checking', category: 'Food' } }, transaction({ cents: -2000 }), 'Savings');
  const next = updateAccount(finance, 'Checking', 'Daily', 'New note');
  assert.equal(balances(next).get('Daily'), balances(finance).get('Checking'));
  assert.equal(next.defaults.account, 'Daily');
  assert.equal(next.accounts[0].note, 'New note');
  assert.equal(next.transactions.filter(row => row.transferId).length, 2);
  assert.ok(next.transactions.every(row => row.account !== 'Checking'));
  assert.equal(finance.accounts[0].name, 'Checking');
  assert.throws(() => updateAccount(finance, 'Checking', ' savings ', ''), /already exists/);
  assert.throws(() => updateAccount(finance, undefined, ' ', ''), /account name/);
  const archived = archiveAccount(next, 'Daily', true);
  assert.equal(archived.defaults.account, '');
  assert.deepEqual(archived.transactions, next.transactions);
  assert.throws(() => archiveAccount(archived, 'Savings', true), /at least one/);
  assert.equal(archiveAccount(archived, 'Daily', false).accounts[0].archived, false);
  const restored = await importWorkbook(await exportWorkbook(archived), 'backup.xlsx');
  assert.equal(restored.accounts[0].name, 'Daily');
  assert.equal(restored.accounts[0].archived, true);
  assert.equal(restored.accounts[0].note, 'New note');
  assert.equal(balances(restored).get('Daily'), balances(next).get('Daily'));
  assert.equal(restored.transactions.filter(row => row.transferId).length, 2);
});

test('native Finance records reject damaged or externally edited data without dropping entries', async () => {
  const { validateFinanceFile } = await import('../src/finance/model.ts');
  const source = await importWorkbook(fixture(), 'sample.xlsx');
  assert.equal(validateFinanceFile(source), source);
  for (const patch of [{ cents: 1.234 }, { cents: '10' }, { account: 'Missing' }, { date: '2026-02-30' }]) {
    assert.throws(() => validateFinanceFile({ ...source, transactions: [{ ...source.transactions[0], ...patch }] }), /invalid data/);
  }
  assert.throws(() => validateFinanceFile({ ...source, transactions: [source.transactions[0], source.transactions[0]] }), /invalid data/);
});
