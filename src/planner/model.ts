import { addDays, dateOf, dayNumber, daysInMonth, fromDayNumber, validDate, weekday } from './dates.ts';

// Planner is stored as one append-only log per device in .noter/planner/log-<device>.jsonl,
// like Finance. Each line is a batch; replaying every batch ordered by (ts, dev, seq) gives the
// current tasks. Changes are recorded per field and per occurrence, so completing a task on the
// phone and renaming another (or the same) task on the desktop at the same time both survive.
// The Android client implements the same format in PlannerLog.kt; keep both in step.

export type Frequency = 'day' | 'week' | 'month' | 'year';
export interface Repeat {
  every: Frequency;
  interval: number;
  /** ISO weekdays (Monday = 1) for weekly rules; defaults to the start date's weekday. */
  weekdays?: number[];
  /** Monthly rules repeat on the start date's day number, or on its weekday position (e.g. the second Tuesday). */
  monthly?: 'day' | 'weekday';
  until?: string;
  count?: number;
}
export interface Task { id: string; title: string; date: string | null; repeat: Repeat | null; done: boolean; created: number }
/** How one occurrence of a repeating task differs from its rule, keyed by the date the rule produces. */
export interface Exception { done?: true; skip?: true; move?: string }
export type TaskFields = Partial<Omit<Task, 'id'>>;
export type PlannerOp =
  | { k: 'task'; id: string; set: TaskFields }
  | { k: 'del'; id: string }
  | { k: 'occ'; id: string; on: string; value: Exception | null };
export interface PlannerBatch { v: 1; ts: number; dev: string; seq: number; ops: PlannerOp[] }
export interface Planner { tasks: Map<string, Task>; exceptions: Map<string, Map<string, Exception>> }
export interface LogFile { name: string; text: string }

export const MAX_TITLE = 500;
const frequencies: readonly string[] = ['day', 'week', 'month', 'year'];

function invalid(): never { throw new Error('Planner log contains invalid data. Keep the files and restore a valid backup before editing.'); }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TITLE;
}

/** Validates a repeat rule and returns it in canonical form, or undefined when it is malformed. */
export function canonicalRepeat(value: unknown): Repeat | undefined {
  if (!isObject(value) || typeof value.every !== 'string' || !frequencies.includes(value.every) || !isInteger(value.interval, 1, 999)) return undefined;
  const rule: Repeat = { every: value.every as Frequency, interval: value.interval };
  if (value.every === 'week' && value.weekdays !== undefined) {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length || !value.weekdays.every(day => isInteger(day, 1, 7))) return undefined;
    rule.weekdays = [...new Set(value.weekdays as number[])].sort((a, b) => a - b);
  }
  if (value.every === 'month' && value.monthly !== undefined) {
    if (value.monthly !== 'day' && value.monthly !== 'weekday') return undefined;
    if (value.monthly === 'weekday') rule.monthly = 'weekday';
  }
  if (value.until !== undefined) { if (!validDate(value.until)) return undefined; rule.until = value.until; }
  if (value.count !== undefined) { if (!isInteger(value.count, 1, 10000)) return undefined; rule.count = value.count; }
  return rule;
}

/** Known task fields are validated; unknown ones are ignored so newer clients can add fields. */
function validFields(value: unknown): TaskFields {
  if (!isObject(value)) invalid();
  const fields: TaskFields = {};
  if (Object.hasOwn(value, 'title')) { if (!validTitle(value.title)) invalid(); fields.title = value.title; }
  if (Object.hasOwn(value, 'date')) { if (value.date !== null && !validDate(value.date)) invalid(); fields.date = value.date as string | null; }
  if (Object.hasOwn(value, 'repeat')) {
    if (value.repeat === null) fields.repeat = null;
    else fields.repeat = canonicalRepeat(value.repeat) ?? invalid();
  }
  if (Object.hasOwn(value, 'done')) { if (typeof value.done !== 'boolean') invalid(); fields.done = value.done; }
  if (Object.hasOwn(value, 'created')) { if (!isInteger(value.created, 0, Number.MAX_SAFE_INTEGER)) invalid(); fields.created = value.created; }
  return fields;
}

function validException(value: unknown): Exception | null {
  if (value === null) return null;
  if (!isObject(value)) invalid();
  const result: Exception = {};
  if (value.done !== undefined) { if (value.done !== true) invalid(); result.done = true; }
  if (value.skip !== undefined) { if (value.skip !== true) invalid(); result.skip = true; }
  if (value.move !== undefined) { if (!validDate(value.move)) invalid(); result.move = value.move; }
  return Object.keys(result).length ? result : null;
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Unknown operation kinds are skipped for forward compatibility; known ones must be valid. */
function validOps(value: unknown): PlannerOp[] {
  if (!Array.isArray(value)) invalid();
  const ops: PlannerOp[] = [];
  for (const op of value) {
    if (!isObject(op) || typeof op.k !== 'string') invalid();
    if (op.k === 'task') { if (!validId(op.id)) invalid(); ops.push({ k: 'task', id: op.id, set: validFields(op.set) }); }
    else if (op.k === 'del') { if (!validId(op.id)) invalid(); ops.push({ k: 'del', id: op.id }); }
    else if (op.k === 'occ') {
      if (!validId(op.id) || !validDate(op.on) || !Object.hasOwn(op, 'value')) invalid();
      ops.push({ k: 'occ', id: op.id, on: op.on, value: validException(op.value) });
    }
  }
  return ops;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export interface ParsedPlannerLogs { batches: PlannerBatch[]; clock: number; seq: number; ownNeedsNewline: boolean }

/** Parses every log file. A final line without a newline is an interrupted write and is ignored. */
export function parsePlannerLogs(files: LogFile[], device: string): ParsedPlannerLogs {
  const seen = new Map<string, { batch: PlannerBatch; raw: unknown }>();
  let clock = 0, seq = 0, ownNeedsNewline = false;
  for (const file of files) {
    const lines = file.text.split('\n');
    const tail = lines.pop() ?? '';
    if (tail.trim() && file.name === `log-${device}.jsonl`) ownNeedsNewline = true;
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { invalid(); }
      if (!isObject(parsed) || parsed.v !== 1 || !Number.isSafeInteger(parsed.ts) || !validId(parsed.dev) || !Number.isSafeInteger(parsed.seq)) invalid();
      const batch: PlannerBatch = { v: 1, ts: parsed.ts as number, dev: parsed.dev, seq: parsed.seq as number, ops: validOps(parsed.ops) };
      const identity = `${batch.dev}\u0000${batch.seq}`;
      const previous = seen.get(identity);
      if (previous && (previous.batch.ts !== batch.ts || !sameJson(previous.raw, parsed.ops))) {
        throw new Error('Planner logs contain conflicting batches from the same device. Both versions have been kept. Resolve the conflicting log copies before editing.');
      }
      if (!previous) seen.set(identity, { batch, raw: parsed.ops });
      clock = Math.max(clock, batch.ts);
      if (batch.dev === device) seq = Math.max(seq, batch.seq);
    }
  }
  return { batches: [...seen.values()].map(entry => entry.batch), clock, seq, ownNeedsNewline };
}

/** Replays batches. Per field, the latest change wins; a deletion is final for that task. */
export function replayPlanner(batches: PlannerBatch[]): Planner {
  const ordered = [...batches].sort((a, b) => a.ts - b.ts || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || a.seq - b.seq);
  const fields = new Map<string, TaskFields>(), deleted = new Set<string>();
  const exceptions = new Map<string, Map<string, Exception>>();
  for (const batch of ordered) for (const op of batch.ops) {
    if (deleted.has(op.id)) continue;
    if (op.k === 'del') { deleted.add(op.id); fields.delete(op.id); exceptions.delete(op.id); }
    else if (op.k === 'task') fields.set(op.id, { ...fields.get(op.id), ...op.set });
    else {
      const map = exceptions.get(op.id) ?? new Map<string, Exception>();
      if (op.value) map.set(op.on, op.value); else map.delete(op.on);
      exceptions.set(op.id, map);
    }
  }
  const tasks = new Map<string, Task>();
  for (const [id, value] of fields) {
    // A task created on one device can lose its creating batch only through damage; skip untitled fragments.
    if (value.title === undefined) continue;
    tasks.set(id, { id, title: value.title, date: value.date ?? null, repeat: value.repeat ?? null, done: value.done ?? false, created: value.created ?? 0 });
  }
  for (const id of exceptions.keys()) if (!tasks.has(id)) exceptions.delete(id);
  return { tasks, exceptions };
}

export function batchLine(device: string, clock: number, seq: number, ops: PlannerOp[]): { line: string; ts: number } {
  const ts = Math.max(Date.now(), clock + 1);
  if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(seq)) throw new Error('Planner log timestamp or sequence is outside the supported range.');
  return { line: `${JSON.stringify({ v: 1, ts, dev: device, seq, ops })}\n`, ts };
}

// ---- Recurrence ---------------------------------------------------------------------------

/** The repeat rule actually in effect: a rule needs a start date. */
export const activeRepeat = (task: Task) => (task.date ? task.repeat : null);

function nthWeekday(year: number, month: number, isoDay: number, nth: number): number {
  const first = weekday(dateOf(year, month, 1));
  const firstMatch = 1 + ((isoDay - first + 7) % 7);
  if (nth > 0) return firstMatch + (nth - 1) * 7;
  const last = daysInMonth(year, month);
  return last - ((weekday(dateOf(year, month, last)) - isoDay + 7) % 7);
}

/** Position used by "monthly on the Nth weekday": 1–4, or -1 for the last one when the start falls on day 29 or later. */
export function weekdayPosition(date: string): number {
  const day = Number(date.slice(8));
  return day > 28 ? -1 : Math.ceil(day / 7);
}

/**
 * Day numbers the rule produces from its start date through `limit`, in order, before exceptions.
 * Counted rules count these generated dates, including skipped or moved occurrences.
 */
export function seriesDays(start: string, rule: Repeat, limit: number): number[] {
  const result: number[] = [];
  const first = dayNumber(start);
  const end = Math.min(limit, rule.until ? dayNumber(rule.until) : Infinity);
  const max = rule.count ?? Infinity;
  const push = (day: number) => { if (day >= first && day <= end && result.length < max) result.push(day); };
  if (end < first) return result;
  const [year, month, day] = start.split('-').map(Number);
  if (rule.every === 'day') {
    for (let current = first; current <= end && result.length < max; current += rule.interval) push(current);
  } else if (rule.every === 'week') {
    const days = rule.weekdays ?? [weekday(start)];
    const monday = first - (weekday(start) - 1);
    for (let week = monday; week <= end && result.length < max; week += 7 * rule.interval) for (const isoDay of days) push(week + isoDay - 1);
  } else if (rule.every === 'month') {
    const position = weekdayPosition(start), isoDay = weekday(start);
    for (let index = year * 12 + month - 1; result.length < max; index += rule.interval) {
      const y = Math.floor(index / 12), m = index % 12 + 1;
      if (dayNumber(dateOf(y, m, 1)) > end) break;
      push(dayNumber(dateOf(y, m, rule.monthly === 'weekday' ? nthWeekday(y, m, isoDay, position) : Math.min(day, daysInMonth(y, m)))));
    }
  } else {
    for (let y = year; result.length < max; y += rule.interval) {
      if (dayNumber(dateOf(y, 1, 1)) > end) break;
      push(dayNumber(dateOf(y, month, Math.min(day, daysInMonth(y, month)))));
    }
  }
  return result;
}

export interface Occurrence {
  task: Task;
  /** The date the task or rule assigns; identifies the occurrence. */
  on: string;
  /** Where the occurrence is shown, after any move. */
  date: string;
  done: boolean;
  repeating: boolean;
}

const MAX_DAY = dayNumber('9999-12-31');

/** Occurrences displayed from `from` through `to` (inclusive), sorted by date, open first, then creation. */
export function occurrencesBetween(planner: Planner, from: string, to: string): Occurrence[] {
  const start = dayNumber(from), end = dayNumber(to), result: Occurrence[] = [];
  for (const task of planner.tasks.values()) {
    const rule = activeRepeat(task);
    if (!task.date) continue;
    if (!rule) {
      if (task.date >= from && task.date <= to) result.push({ task, on: task.date, date: task.date, done: task.done, repeating: false });
      continue;
    }
    const exceptions = planner.exceptions.get(task.id);
    // Occurrences after the range can be moved into it; generate far enough to recognise them.
    let limit = end;
    for (const [on, exception] of exceptions ?? []) if (exception.move && exception.move >= from && exception.move <= to) limit = Math.max(limit, dayNumber(on));
    for (const day of seriesDays(task.date, rule, Math.min(limit, MAX_DAY))) {
      const on = fromDayNumber(day), exception = exceptions?.get(on);
      if (exception?.skip) continue;
      const date = exception?.move ?? on, shown = exception?.move ? dayNumber(exception.move) : day;
      if (shown >= start && shown <= end) result.push({ task, on, date, done: exception?.done === true, repeating: true });
    }
  }
  return result.sort(compareOccurrences);
}

/** Code-unit order, matching Kotlin's String.compareTo; locale rules would differ between clients. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  return compare(a.date, b.date) || Number(a.done) - Number(b.done) || a.task.created - b.task.created || compare(a.task.id, b.task.id) || compare(a.on, b.on);
}

/** Open occurrences shown before `today`, oldest first. */
export function overdue(planner: Planner, today: string): Occurrence[] {
  return occurrencesBetween(planner, '1000-01-01', addDays(today, -1)).filter(item => !item.done);
}

/** Tasks without a date, open first, oldest first. */
export function unscheduled(planner: Planner): Task[] {
  return [...planner.tasks.values()].filter(task => !task.date).sort((a, b) => Number(a.done) - Number(b.done) || a.created - b.created || compare(a.id, b.id));
}

// ---- Edits --------------------------------------------------------------------------------

export function createTask(id: string, title: string, date: string | null, repeat: Repeat | null, created: number): PlannerOp {
  if (!validTitle(title.trim())) throw new Error(`Enter a task title up to ${MAX_TITLE} characters.`);
  return { k: 'task', id, set: { title: title.trim(), date, repeat: date ? repeat : null, done: false, created } };
}

/** Marks one occurrence done or open. */
export function setDone(planner: Planner, item: Occurrence, done: boolean): PlannerOp {
  if (!item.repeating) return { k: 'task', id: item.task.id, set: { done } };
  const current = { ...planner.exceptions.get(item.task.id)?.get(item.on) };
  if (done) current.done = true; else delete current.done;
  return { k: 'occ', id: item.task.id, on: item.on, value: Object.keys(current).length ? current : null };
}

/** Moves one occurrence to another day; for repeating tasks only that occurrence moves. */
export function moveOccurrence(planner: Planner, item: Occurrence, date: string): PlannerOp {
  if (!item.repeating) return { k: 'task', id: item.task.id, set: { date } };
  const current = { ...planner.exceptions.get(item.task.id)?.get(item.on) };
  if (date === item.on) delete current.move; else current.move = date;
  return { k: 'occ', id: item.task.id, on: item.on, value: Object.keys(current).length ? current : null };
}

export function skipOccurrence(item: Occurrence): PlannerOp {
  return { k: 'occ', id: item.task.id, on: item.on, value: { skip: true } };
}

/** Ends a series before this occurrence; deleting from the first occurrence deletes the task. */
export function deleteFollowing(item: Occurrence): PlannerOp {
  const rule = activeRepeat(item.task);
  if (!rule || item.on <= item.task.date!) return { k: 'del', id: item.task.id };
  return { k: 'task', id: item.task.id, set: { repeat: { ...rule, until: addDays(item.on, -1) } } };
}

/** Fields that differ between a task and its edited version. */
export function changedFields(task: Task, next: { title: string; date: string | null; repeat: Repeat | null }): TaskFields {
  const set: TaskFields = {};
  const title = next.title.trim();
  if (!validTitle(title)) throw new Error(`Enter a task title up to ${MAX_TITLE} characters.`);
  if (title !== task.title) set.title = title;
  if (next.date !== task.date) set.date = next.date;
  const repeat = next.date ? next.repeat : null;
  if (JSON.stringify(repeat) !== JSON.stringify(task.repeat)) set.repeat = repeat;
  return set;
}

// ---- Descriptions -------------------------------------------------------------------------

const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const longDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const positions = ['', 'first', 'second', 'third', 'fourth'];
const units: Record<Frequency, [string, string]> = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };

/** A short human description, e.g. "Every 2 weeks on Mon, Thu until 2026-12-31". */
export function describeRepeat(rule: Repeat, start: string): string {
  const [one, many] = units[rule.every];
  let text = rule.interval === 1 ? `Every ${one}` : `Every ${rule.interval} ${many}`;
  if (rule.every === 'day' && rule.interval === 1) text = 'Daily';
  if (rule.every === 'week') {
    const days = rule.weekdays ?? [weekday(start)];
    if (rule.interval === 1 && days.length === 5 && days.every((day, index) => day === index + 1)) text = 'Every weekday';
    else text += ` on ${days.map(day => dayNames[day - 1]).join(', ')}`;
  }
  if (rule.every === 'month') {
    const position = weekdayPosition(start);
    text += rule.monthly === 'weekday' ? ` on the ${position < 0 ? 'last' : positions[position]} ${longDays[weekday(start) - 1]}` : ` on day ${Number(start.slice(8))}`;
  }
  if (rule.every === 'year') text += ` on ${start.slice(5)}`;
  if (rule.until) text += `, until ${rule.until}`;
  if (rule.count) text += `, ${rule.count} ${rule.count === 1 ? 'time' : 'times'}`;
  return text;
}
