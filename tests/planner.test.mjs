import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parsePlannerLogs, replayPlanner, occurrencesBetween, overdue, unscheduled, seriesDays, batchLine, createTask, setDone, moveOccurrence,
  skipOccurrence, deleteFollowing, changedFields, canonicalRepeat, describeRepeat,
} from '../src/planner/model.ts';
import { dayNumber, fromDayNumber, monthGrid, weekday } from '../src/planner/dates.ts';

const fixtures = new URL('./fixtures/file-storage/planner/', import.meta.url);
const read = name => readFileSync(new URL(name, fixtures), 'utf8');
const days = (start, rule, limit) => seriesDays(start, rule, dayNumber(limit)).map(fromDayNumber);
const occ = list => list.map(item => [item.date, item.task.id, item.on, item.done]);
const line = (dev, ts, seq, ops) => `${JSON.stringify({ v: 1, ts, dev, seq, ops })}\n`;
const plannerFrom = (...ops) => replayPlanner(parsePlannerLogs([{ name: 'log-a.jsonl', text: ops.map((op, index) => batchLine('a', index, index + 1, [op]).line).join('') }], 'a').batches);

test('shared Planner fixture replays identically to the expected contract', () => {
  const expected = JSON.parse(read('expected-planner.json'));
  const parsed = parsePlannerLogs(['log-desktop-a.jsonl', 'log-mobile-b.jsonl'].map(name => ({ name, text: read(name) })), expected.device);
  assert.equal(parsed.clock, expected.clock); assert.equal(parsed.seq, expected.seq); assert.equal(parsed.ownNeedsNewline, expected.ownNeedsNewline);
  const planner = replayPlanner(parsed.batches);
  assert.deepEqual([...planner.tasks.values()].sort((a, b) => a.id.localeCompare(b.id)), expected.tasks);
  assert.deepEqual(occ(occurrencesBetween(planner, ...expected.range)), expected.occurrences);
  assert.deepEqual(occ(overdue(planner, expected.today)), expected.overdue);
  assert.deepEqual(unscheduled(planner).map(task => task.id), expected.unscheduled);
});

test('repeat rules follow calendar boundaries', () => {
  assert.deepEqual(days('2026-01-31', { every: 'month', interval: 1 }, '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(days('2024-02-29', { every: 'year', interval: 1 }, '2028-12-31'), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  assert.deepEqual(days('2026-10-13', { every: 'month', interval: 1, monthly: 'weekday' }, '2027-01-31'), ['2026-10-13', '2026-11-10', '2026-12-08', '2027-01-12']);
  assert.deepEqual(days('2026-10-30', { every: 'month', interval: 2, monthly: 'weekday' }, '2027-03-31'), ['2026-10-30', '2026-12-25', '2027-02-26']);
  // Weekly rules count weeks from the start week and never produce dates before the start.
  assert.deepEqual(days('2026-10-14', { every: 'week', interval: 2, weekdays: [1, 3, 5] }, '2026-11-01'), ['2026-10-14', '2026-10-16', '2026-10-26', '2026-10-28', '2026-10-30']);
  assert.deepEqual(days('2026-10-11', { every: 'week', interval: 1 }, '2026-10-31'), ['2026-10-11', '2026-10-18', '2026-10-25']);
  assert.deepEqual(days('2026-10-01', { every: 'day', interval: 3, count: 3 }, '2030-01-01'), ['2026-10-01', '2026-10-04', '2026-10-07']);
  assert.deepEqual(days('2026-10-01', { every: 'day', interval: 1, until: '2026-10-03' }, '2030-01-01'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(days('2026-10-05', { every: 'day', interval: 1, until: '2026-10-01' }, '2030-01-01'), []);
  assert.equal(monthGrid(2026, 10)[0], '2026-09-28'); assert.equal(weekday(monthGrid(2026, 2)[0]), 1);
  assert.equal(describeRepeat({ every: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }, '2026-10-12'), 'Every weekday');
  assert.equal(describeRepeat({ every: 'month', interval: 1, monthly: 'weekday' }, '2026-10-30'), 'Every month on the last Friday');
  assert.equal(canonicalRepeat({ every: 'week', interval: 0 }), undefined);
  assert.equal(canonicalRepeat({ every: 'hour', interval: 1 }), undefined);
  assert.deepEqual(canonicalRepeat({ every: 'week', interval: 2, weekdays: [5, 1, 5] }), { every: 'week', interval: 2, weekdays: [1, 5] });
});

test('occurrence edits stay independent and series edits keep the start', () => {
  let planner = plannerFrom(createTask('t', ' Water ', '2026-10-01', { every: 'day', interval: 1 }, 5));
  const list = () => occurrencesBetween(planner, '2026-10-01', '2026-10-05');
  assert.equal(planner.tasks.get('t').title, 'Water');
  const ops = [];
  const apply = op => { ops.push(op); planner = plannerFrom(createTask('t', 'Water', '2026-10-01', { every: 'day', interval: 1 }, 5), ...ops); };
  apply(setDone(planner, list()[1], true));
  apply(moveOccurrence(planner, list()[1], '2026-10-04'));
  assert.deepEqual(occ(list()).slice(0, 4), [['2026-10-01', 't', '2026-10-01', false], ['2026-10-03', 't', '2026-10-03', false], ['2026-10-04', 't', '2026-10-02', true], ['2026-10-04', 't', '2026-10-04', false]].sort((a, b) => a[0].localeCompare(b[0]) || Number(a[3]) - Number(b[3])));
  apply(moveOccurrence(planner, list().find(item => item.on === '2026-10-02'), '2026-10-02'));
  assert.deepEqual(planner.exceptions.get('t').get('2026-10-02'), { done: true }, 'moving back keeps completion');
  apply(setDone(planner, list().find(item => item.on === '2026-10-02'), false));
  assert.equal(planner.exceptions.get('t').has('2026-10-02'), false, 'an occurrence without changes has no exception');
  apply(skipOccurrence(list()[0]));
  assert.equal(list()[0].on, '2026-10-02');
  apply(deleteFollowing(list().find(item => item.on === '2026-10-04')));
  assert.equal(planner.tasks.get('t').repeat.until, '2026-10-03');
  assert.deepEqual(list().map(item => item.on), ['2026-10-02', '2026-10-03']);
  assert.deepEqual(deleteFollowing({ task: planner.tasks.get('t'), on: '2026-10-01', repeating: true }), { k: 'del', id: 't' });
  assert.deepEqual(changedFields(planner.tasks.get('t'), { title: 'Water', date: null, repeat: { every: 'day', interval: 1 } }), { date: null, repeat: null });
  assert.throws(() => changedFields(planner.tasks.get('t'), { title: '  ', date: null, repeat: null }));
  assert.throws(() => createTask('x', 'a'.repeat(501), null, null, 1));
});

test('concurrent edits merge per field, deletion is final, and invalid logs are refused', () => {
  const create = { k: 'task', id: 't', set: { title: 'Old', date: '2026-10-01', repeat: null, done: false, created: 1 } };
  const logs = [
    { name: 'log-phone.jsonl', text: line('phone', 1, 1, [create]) + line('phone', 30, 2, [{ k: 'task', id: 't', set: { done: true } }]) },
    { name: 'log-desk.jsonl', text: line('desk', 20, 1, [{ k: 'task', id: 't', set: { title: 'Renamed' } }]) },
  ];
  const merged = replayPlanner(parsePlannerLogs(logs, 'desk').batches).tasks.get('t');
  assert.equal(merged.title, 'Renamed'); assert.equal(merged.done, true);
  const deleted = [...logs, { name: 'log-tablet.jsonl', text: line('tablet', 5, 1, [{ k: 'del', id: 't' }]) }];
  assert.equal(replayPlanner(parsePlannerLogs(deleted, 'desk').batches).tasks.has('t'), false);
  const bad = text => () => parsePlannerLogs([{ name: 'log-x.jsonl', text }], 'x');
  for (const op of [{ k: 'task', id: 't', set: { title: '' } }, { k: 'task', id: 't', set: { date: '2026-02-30' } }, { k: 'task', id: 't', set: { repeat: { every: 'day', interval: 1000 } } },
    { k: 'task', id: '', set: {} }, { k: 'occ', id: 't', on: '2026-10-01', value: { done: false } }, { k: 'occ', id: 't', on: '2026-10-01' }, { k: 'task', id: 't', set: { created: -1 } }]) {
    assert.throws(bad(`${JSON.stringify({ v: 1, ts: 1, dev: 'x', seq: 1, ops: [op] })}\n`), /invalid data/, JSON.stringify(op));
  }
  assert.throws(bad('{"v":1,"ts":1,"dev":"x","seq":1,"ops":[]\n'), /invalid data/);
  assert.throws(bad(`${JSON.stringify({ v: 2, ts: 1, dev: 'x', seq: 1, ops: [] })}\n`), /invalid data/);
  assert.throws(() => parsePlannerLogs([{ name: 'log-x.jsonl', text: line('x', 1, 1, []) }, { name: 'log-x copy.jsonl', text: line('x', 5, 1, [create]) }], 'x'), /conflicting batches/);
  // Syncthing copies of the same batch are harmless.
  assert.equal(parsePlannerLogs([{ name: 'log-x.jsonl', text: line('x', 1, 1, [create]) }, { name: 'log-x.sync-conflict.jsonl', text: line('x', 1, 1, [create]).replace('"v":1', '"v":1.0') }], 'x').batches.length, 1);
});
