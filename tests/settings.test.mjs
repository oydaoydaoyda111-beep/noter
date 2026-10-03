import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, formatFinanceAmount, formatFinanceDate } from '../src/settings/model.ts';

test('old preferences gain new defaults without losing appearance and autosave choices', () => {
  const old = { fontSize:22, fontStyle:'serif', documentWidth:850, density:'compact', motion:'none', autosaveDelay:1200 };
  const result = normalizeSettings(JSON.parse(JSON.stringify(old)));
  for (const [key,value] of Object.entries(old)) assert.equal(result[key],value);
  assert.equal(result.financeCurrency,''); assert.equal(result.financeTableDensity,'compact');
  assert.equal(result.financeRememberEntries,true); assert.equal(result.startupSection,'last');
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(result))),result);
});
test('malformed settings fall back safely and valid false switches survive reload', () => {
  const result = normalizeSettings({ fontSize:999, autosaveDelay:-5, financeCurrency:'invalid', financePageSize:0, startupSection:'other', financeRememberEntries:'false', showNoteStats:false, spellcheck:false, financeDefaultAccount:'Savings', accentColor:'purple', hiddenKey:'discard' });
  assert.equal(result.fontSize,24); assert.equal(result.autosaveDelay,650); assert.equal(result.financePageSize,50);
  assert.equal(result.financeCurrency,''); assert.equal(result.startupSection,'last'); assert.equal(result.financeRememberEntries,true);
  assert.equal(result.spellcheck,false); assert.equal(result.showNoteStats,false); assert.equal(result.financeDefaultAccount,'Savings');
  assert.equal(result.accentColor,'purple'); assert.equal(result.hiddenKey,undefined);
  assert.deepEqual(normalizeSettings(null),defaultSettings);
});
test('Finance formats presentation without changing amounts, dates, or precision', () => {
  assert.equal(formatFinanceDate('2026-10-03','iso'),'2026-10-03');
  assert.equal(formatFinanceDate('2026-10-03','dmy'),'03/10/2026');
  assert.equal(formatFinanceDate('2026-10-03','mdy'),'10/03/2026');
  assert.match(formatFinanceAmount(12345,'USD'),/USD/);
  assert.match(formatFinanceAmount(-1,''),/-0[.,]01/);
  assert.match(formatFinanceAmount(0,''),/0[.,]00/);
});
