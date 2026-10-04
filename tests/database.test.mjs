import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDatabase, newRow, readDatabase, activeView, createSavedView, saveActiveView, switchView, visibleColumns, visibleRows, columnWidth, optionColor, duplicateRows, updateRows, removeRows } from '../src/database/model.ts';

test('desktop reads the shared Android database fixture with the same typed cells and saved views', () => {
  const data = readDatabase(readFileSync(new URL('./fixtures/file-storage/database.json', import.meta.url), 'utf8'));
  assert.ok(data);
  assert.deepEqual(visibleRows(data).map(row => row.id), ['beta', 'alpha', 'delta', 'gamma']);
  assert.deepEqual(visibleColumns(data).map(column => column.id), ['name', 'status', 'due', 'score']);
  assert.equal(data.rows[0].cells.score, 3);
  assert.equal(data.rows[1].cells.done, true);
  assert.equal(data.rows[2].cells.score, null);
  assert.equal(columnWidth(data, 'name'), 280);
  assert.equal(optionColor(data.columns[1], 'Done'), 'green');
  activeView(data).condition = { columnId: 'score', value: '3' };
  assert.deepEqual(visibleRows(data).map(row => row.id), ['alpha']);
  switchView(data, 'board');
  assert.equal(data.view, 'kanban');
  assert.deepEqual(visibleRows(data).map(row => row.id), ['gamma']);
  switchView(data, 'calendar');
  assert.equal(data.view, 'calendar');
  assert.equal(data.calendarMonth, '2026-10');
  assert.equal(visibleRows(data).filter(row => row.cells.due === '2026-10-04').length, 2);
});

test('legacy databases migrate without losing rows or current settings', () => {
  const original = newDatabase();
  original.rows[0].cells[original.columns[0].id] = 'Keep me';
  original.view = 'kanban'; original.filter = 'Keep';
  original.sort = { columnId: original.columns[0].id, direction: 'desc' };
  delete original.views; delete original.activeViewId;
  const migrated = readDatabase(JSON.stringify(original));
  assert.ok(migrated);
  assert.equal(migrated.views.length, 3);
  assert.equal(migrated.view, 'kanban');
  assert.equal(migrated.filter, 'Keep');
  assert.deepEqual(migrated.sort, original.sort);
  assert.deepEqual(migrated.rows, original.rows);
});

test('saved views retain independent filters, sort, visibility, widths, and grouping after reload', () => {
  const data = newDatabase(), first = activeView(data);
  first.hiddenColumnIds = [data.columns[2].id]; first.columnWidths[data.columns[0].id] = 320;
  data.filter = 'Alpha'; data.sort = { columnId: data.columns[0].id, direction: 'desc' };
  first.condition = { columnId: data.columns[1].id, value: 'Done' };
  saveActiveView(data);
  const second = createSavedView(data, 'Completed', 'kanban'); data.views.push(second); switchView(data, second.id);
  second.hiddenColumnIds = []; second.columnWidths[data.columns[0].id] = 140; second.condition.value = 'In progress';
  data.filter = 'Beta'; data.sort = null; saveActiveView(data);
  switchView(data, first.id);
  assert.equal(data.filter, 'Alpha'); assert.equal(data.sort.direction, 'desc'); assert.equal(columnWidth(data, data.columns[0].id), 320);
  assert.equal(visibleColumns(data).length, 2); assert.equal(activeView(data).condition.value, 'Done');
  const restored = readDatabase(JSON.stringify(data));
  switchView(restored, second.id);
  assert.equal(restored.view, 'kanban'); assert.equal(restored.filter, 'Beta'); assert.equal(restored.sort, null);
  assert.equal(visibleColumns(restored).length, 3); assert.equal(columnWidth(restored, data.columns[0].id), 140);
  assert.equal(activeView(restored).condition.value, 'In progress');
});

test('invalid view settings are normalized and all columns cannot remain hidden', () => {
  const data = newDatabase(), view = activeView(data);
  view.hiddenColumnIds = data.columns.map(column => column.id);
  view.columnWidths = { [data.columns[0].id]: 9999, [data.columns[1].id]: -1, removed: 150 };
  view.sort = { columnId: 'missing', direction: 'asc' }; view.condition = { columnId: 'missing', value: 'Done' };
  view.calendarMonth = '2026-99'; data.views.push({ ...view });
  const restored = readDatabase(JSON.stringify(data));
  assert.ok(restored); assert.equal(restored.views.length, 3); assert.equal(visibleColumns(restored).length, 1);
  assert.equal(columnWidth(restored, data.columns[0].id), 600); assert.equal(columnWidth(restored, data.columns[1].id), 100);
  assert.equal(activeView(restored).columnWidths.removed, undefined); assert.equal(restored.sort, null); assert.equal(activeView(restored).condition, null);
});

test('option colors survive reordering and serialization; untrusted colors are ignored', () => {
  const data = newDatabase(), column = data.columns[1];
  column.optionColors = { Done: 'green', 'Not started': 'url(https://invalid.test)' };
  const defaultColor = optionColor(column, 'In progress'); column.options.reverse();
  assert.equal(optionColor(column, 'In progress'), defaultColor);
  const restored = readDatabase(JSON.stringify(data));
  assert.equal(optionColor(restored.columns[1], 'Done'), 'green');
  assert.equal(restored.columns[1].optionColors['Not started'], undefined);
});

test('exact conditions and sorting include hidden property values', () => {
  const data = newDatabase(), name = data.columns[0].id, status = data.columns[1].id;
  data.rows = ['Zeta', 'Alpha', 'Other'].map((value, index) => {
    const row = newRow(data.columns); row.cells[name] = value; row.cells[status] = index < 2 ? 'Done' : 'In progress'; return row;
  });
  activeView(data).hiddenColumnIds = [status]; activeView(data).condition = { columnId: status, value: 'Done' };
  data.sort = { columnId: name, direction: 'asc' };
  assert.deepEqual(visibleRows(data).map(row => row.cells[name]), ['Alpha', 'Zeta']);
  data.filter = 'zeta'; assert.equal(visibleRows(data).length, 1);
});

test('bulk edits, duplicates, and deletion affect only selected records', () => {
  const data = newDatabase(), name = data.columns[0].id, status = data.columns[1].id;
  data.rows.push(newRow(data.columns), newRow(data.columns));
  data.rows.forEach((row, index) => { row.cells[name] = `Task ${index}`; });
  const ids = new Set([data.rows[0].id, data.rows[2].id, 'missing']);
  updateRows(data, ids, status, 'Done');
  assert.equal(data.rows[0].cells[status], 'Done'); assert.equal(data.rows[1].cells[status], ''); assert.equal(data.rows[2].cells[status], 'Done');
  const copies = duplicateRows(data, ids); assert.equal(copies.length, 2); assert.equal(data.rows.length, 5);
  assert.notEqual(copies[0].id, data.rows[0].id); copies[0].cells[name] = 'Changed'; assert.equal(data.rows[0].cells[name], 'Task 0');
  removeRows(data, new Set(copies.map(row => row.id))); assert.equal(data.rows.length, 3);
  assert.equal(readDatabase(JSON.stringify(data)).rows.length, 3);
});
