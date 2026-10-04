import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockIPC } from '@tauri-apps/api/mocks';
import { storage, validateWorkspace } from '../src/storage/storage.ts';
import { loadFinance, persistFinance } from '../src/finance/storage.ts';
import { batchLine, parseLogs, replayFinance } from '../src/finance/log.ts';
import { preserveWorkspaceEdits } from '../src/desktop/platform.ts';

const directory = new URL('./fixtures/file-storage/', import.meta.url);
const read = name => readFileSync(new URL(name, directory), 'utf8');
const manifest = JSON.parse(read('workspace.json'));
const workspace = structuredClone(manifest.workspace);
for (const [id, node] of Object.entries(workspace.nodes)) {
  if (node.type === 'note') node.markdown = read(manifest.paths[id]);
}
const logs = ['log-desktop-a.jsonl', 'log-mobile-b.jsonl'].map(name => ({ name, text: read(name) }));
const expected = JSON.parse(read('expected-finance.json'));

test('shared file fixtures preserve note IDs, hierarchy, settings and database Markdown', () => {
  const loaded = validateWorkspace(workspace);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), workspace);
  assert.match(loaded.nodes.overview.markdown, /```noter-database\n/);
  assert.equal(loaded.settings.fontSize, 18.5);
  assert.equal(loaded.settings.autosaveDelay, 650.5);
});

test('both device logs produce the shared Finance state regardless of file order', () => {
  for (const files of [logs, [...logs].reverse()]) {
    assert.deepEqual(replayFinance(parseLogs(files, 'desktop-a').batches), expected);
  }
  const initial = logs[0].text.split('\n')[0];
  assert.throws(() => parseLogs([{ name: 'bad.jsonl', text: initial.replace('1000.0', '9007199254740992') + '\n' }], 'desktop-a'));
  assert.throws(() => batchLine('desktop-a', Number.MAX_SAFE_INTEGER, 3, []), /supported range/);
  assert.throws(() => batchLine('desktop-a', 1002, Number.MAX_SAFE_INTEGER + 1, []), /supported range/);
  assert.equal(parseLogs([{ name: 'log-desktop-a.jsonl', text: logs[0].text + '{"v":1' }], 'desktop-a').ownNeedsNewline, true);
  assert.throws(() => parseLogs([{ name: 'log-desktop-a.jsonl', text: logs[0].text + '{"v":1\n' }], 'desktop-a'), /invalid data/);
});

test('desktop persists through native files and appends only the changed Finance record', async () => {
  globalThis.window = { crypto: globalThis.crypto };
  // Browser persistence must never be touched by the native storage adapters.
  const unavailable = new Proxy({}, { get() { throw new Error('Browser storage must not be used'); } });
  globalThis.localStorage = unavailable;
  globalThis.indexedDB = unavailable;
  let savedWorkspace;
  let failAfterAppend = false;
  const diskLogs = structuredClone(logs), appended = [];
  mockIPC((command, args) => {
    if (command === 'load_workspace') return { workspace, revision: 'notes-1', path: 'synthetic-vault' };
    if (command === 'save_workspace') { savedWorkspace = args.workspace; return 'notes-2'; }
    if (command === 'load_finance') return { logs: diskLogs, legacy: null, template: null, revision: 'finance-1', device: 'test-install' };
    if (command === 'append_finance') {
      appended.push(args);
      diskLogs.push({ name: 'log-test-install.jsonl', text: args.line });
      if (failAfterAppend) throw new Error('Synthetic acknowledgement failure');
      return 'finance-2';
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  assert.deepEqual(JSON.parse(JSON.stringify((await storage.load()).workspace)), workspace);
  await storage.save(workspace);
  assert.deepEqual(savedWorkspace, workspace);
  const finance = await loadFinance();
  const next = { ...finance, transactions: finance.transactions.map(row => row.id === 'meal' ? { ...row, cents: -1300 } : row) };
  await persistFinance(next);
  assert.equal(appended.length, 1);
  const ops = JSON.parse(appended[0].line).ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, 'meal');
  assert.equal(ops[0].tx.cents, -1300);
  assert.equal(appended[0].template, null);
  await persistFinance(next);
  assert.equal(appended.length, 1);
  const reloaded = await loadFinance();
  assert.deepEqual(reloaded.transactions, next.transactions);
  failAfterAppend = true;
  const uncertain = { ...reloaded, transactions: reloaded.transactions.map(row => row.id === 'income' ? { ...row, cents: 10001 } : row) };
  await assert.rejects(persistFinance(uncertain), /Reload Finance/);
  await assert.rejects(persistFinance(next), /Reload Finance/);
  assert.equal(appended.length, 2);
  failAfterAppend = false;
  assert.deepEqual((await loadFinance()).transactions, uncertain.transactions);
});

test('conflict recovery compares against the last acknowledged snapshot after a failed save', async () => {
  globalThis.window = { crypto: globalThis.crypto };
  let failSave = false, preserved;
  mockIPC((command, args) => {
    if (command === 'load_workspace') return { workspace: structuredClone(workspace), revision: 'base', path: 'synthetic-vault' };
    if (command === 'save_workspace') { if (failSave) throw new Error('SYNC_CONFLICT'); return 'saved'; }
    if (command === 'preserve_workspace_edits') { preserved = structuredClone(args); return { snapshot: '.noter/recovery/test/workspace.json', folder: 'Recovered edits test', notes: 1 }; }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const current = (await storage.load()).workspace;
  current.nodes.inbox.markdown = 'Acknowledged edit\n';
  await storage.save(current);
  const acknowledged = structuredClone(current);
  current.nodes.inbox.markdown = 'Unsaved edit\n';
  failSave = true;
  await assert.rejects(storage.save(current), /SYNC_CONFLICT/);
  const recovery = await preserveWorkspaceEdits(current);
  assert.deepEqual(preserved.base, acknowledged);
  assert.deepEqual(preserved.workspace, JSON.parse(JSON.stringify(current)));
  assert.equal(recovery.notes, 1);
  assert.equal(current.nodes.inbox.markdown, 'Unsaved edit\n');
});
