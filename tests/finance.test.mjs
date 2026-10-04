import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { mockIPC } from '@tauri-apps/api/mocks';
import { money, balances, saveTransaction, removeTransaction } from '../src/finance/model.ts';
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
