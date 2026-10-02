import { button, el } from '../ui/dom';
import { icon } from '../ui/icons';
import { monthKey, type Cell, type Column, type NoteDatabase, type Row } from './model';

export interface ViewActions {
  editRow(row: Row): void;
  addRow(defaults?: Record<string, Cell>): void;
  moveRow(row: Row, column: Column, value: string): void;
  changeMonth(month: string, control: 'previous' | 'next' | 'today'): void;
  addProperty(type: 'date' | 'select'): void;
}

export function recordTitle(data: NoteDatabase, row: Row): string {
  const column = data.columns.find(column => column.type === 'text') ?? data.columns[0];
  return String(row.cells[column.id] ?? '').trim() || 'Untitled record';
}

function missingProperty(type: 'date' | 'select', actions: ViewActions): HTMLElement {
  const empty = el('div', 'database-view-empty');
  empty.append(el('h3', '', type === 'date' ? 'Give your records a date' : 'Give your board a little structure'),
    el('p', '', type === 'date' ? 'Add a date property to place records on your calendar.' : 'Add a select property to organize records into lanes.'));
  const add = button(`Add ${type} property`, 'button-secondary');
  add.append(icon('plus'), el('span', '', `Add ${type} property`)); add.onclick = () => actions.addProperty(type);
  empty.append(add); return empty;
}

export function kanbanView(data: NoteDatabase, rows: Row[], actions: ViewActions): HTMLElement {
  const column = data.columns.find(column => column.id === data.boardColumnId);
  if (!column) return missingProperty('select', actions);
  const board = el('div', 'database-board');
  const groups = [...new Set(['', ...column.options, ...data.rows.map(row => String(row.cells[column.id] ?? ''))])];
  let dragged: Row | null = null;
  for (const [index, group] of groups.entries()) {
    const lane = el('section', 'database-lane'); lane.style.setProperty('--lane-color', ['#91a2b4', '#c3ae89', '#8bb1cc', '#94b7a2', '#b3a1c2'][index % 5]);
    lane.setAttribute('aria-label', `${group || 'Unassigned'} lane`);
    const members = rows.filter(row => String(row.cells[column.id] ?? '') === group);
    const header = el('div', 'database-lane-header');
    header.append(el('span', 'database-lane-dot'), el('h3', '', group || 'Unassigned'), el('span', 'database-lane-count', String(members.length)));
    const add = button(`Add record to ${group || 'Unassigned'}`, 'database-lane-add'); add.append(icon('plus'));
    add.onclick = () => actions.addRow({ [column.id]: group }); header.append(add); lane.append(header);
    const cards = el('div', 'database-lane-cards');
    for (const row of members) {
      const card = el('article', 'database-card'); card.draggable = true; card.dataset.rowId = row.id;
      const edit = button(`Edit ${recordTitle(data, row)}`, 'database-card-open');
      edit.textContent = recordTitle(data, row); edit.onclick = () => actions.editRow(row); card.append(edit);
      const details = el('div', 'database-card-details');
      const primary = data.columns.find(item => item.type === 'text') ?? data.columns[0];
      for (const property of data.columns.filter(item => item.id !== column.id && item.id !== primary.id).slice(0, 3)) {
        const value = row.cells[property.id];
        if (value === '' || value === null || value === false) continue;
        const detail = el('span', '', property.type === 'checkbox' ? `✓ ${property.name}` : String(value));
        detail.title = property.name; details.append(detail);
      }
      if (details.childElementCount) card.append(details);
      const status = el('select', 'database-card-status'); status.setAttribute('aria-label', `${column.name} for ${recordTitle(data, row)}`);
      for (const value of groups) { const option = el('option', '', value || 'Unassigned'); option.value = value; status.append(option); }
      status.value = group; status.onchange = () => actions.moveRow(row, column, status.value); card.append(status);
      card.addEventListener('dragstart', event => {
        if ((event.target as Element).closest('select') || !event.dataTransfer) { event.preventDefault(); return; }
        dragged = row; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.clearData(); event.dataTransfer.setData('application/x-noter-record', row.id); card.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => { dragged = null; card.classList.remove('is-dragging'); board.querySelectorAll('.is-drop-target').forEach(item => item.classList.remove('is-drop-target')); });
      cards.append(card);
    }
    if (!members.length) cards.append(el('p', 'database-lane-empty', data.filter.trim() ? 'No matching records' : 'Drop a record here'));
    lane.append(cards);
    lane.addEventListener('dragover', event => {
      if (!dragged || !event.dataTransfer) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; lane.classList.add('is-drop-target');
    });
    lane.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !lane.contains(event.relatedTarget)) lane.classList.remove('is-drop-target'); });
    lane.addEventListener('drop', event => {
      if (!dragged) return;
      event.preventDefault(); const row = dragged; dragged = null; lane.classList.remove('is-drop-target'); actions.moveRow(row, column, group);
    });
    board.append(lane);
  }
  return board;
}

function dateKey(date: Date): string { return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`; }

export function calendarView(data: NoteDatabase, rows: Row[], actions: ViewActions): HTMLElement {
  const column = data.columns.find(column => column.id === data.calendarColumnId);
  if (!column) return missingProperty('date', actions);
  const calendar = el('div', 'database-calendar');
  const month = new Date(`${data.calendarMonth}-01T12:00:00`);
  const navigation = el('div', 'database-calendar-nav');
  const label = el('h3', '', month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  const controls = el('div', 'database-calendar-controls');
  const previous = button('Previous month', 'database-month-arrow'); previous.append(icon('chevron')); previous.classList.add('is-previous');
  const next = button('Next month', 'database-month-arrow'); next.append(icon('chevron'));
  const today = button('Go to current month', 'database-today'); today.textContent = 'Today';
  previous.dataset.monthControl = 'previous'; next.dataset.monthControl = 'next'; today.dataset.monthControl = 'today';
  const shift = (amount: number) => {
    const date = new Date(month); date.setMonth(date.getMonth() + amount);
    if (date.getFullYear() >= 1 && date.getFullYear() <= 9999) actions.changeMonth(monthKey(date), amount < 0 ? 'previous' : 'next');
  };
  previous.disabled = data.calendarMonth === '0001-01'; next.disabled = data.calendarMonth === '9999-12';
  previous.onclick = () => shift(-1); next.onclick = () => shift(1); today.onclick = () => actions.changeMonth(monthKey(), 'today');
  controls.append(today, previous, next); navigation.append(label, controls); calendar.append(navigation);
  const wrapper = el('div', 'database-calendar-scroll');
  const weekdays = el('div', 'database-weekdays'); weekdays.setAttribute('aria-hidden', 'true');
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) weekdays.append(el('span', '', day));
  const grid = el('div', 'database-calendar-grid');
  const start = new Date(month); start.setDate(1 - (month.getDay() + 6) % 7);
  const todayKey = dateKey(new Date());
  const byDate = new Map<string, Row[]>();
  for (const row of rows) { const key = String(row.cells[column.id] ?? ''); const records = byDate.get(key) ?? []; records.push(row); byDate.set(key, records); }
  for (let index = 0; index < 42; index++) {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const day = el('section', 'database-calendar-day');
    if (monthKey(date) !== data.calendarMonth) day.classList.add('is-outside-month');
    if (key === todayKey) day.classList.add('is-today');
    day.setAttribute('aria-label', date.toLocaleDateString(undefined, { dateStyle: 'full' }));
    const header = el('div', 'database-day-header'); header.append(el('span', 'database-day-number', String(date.getDate())));
    const add = button(`Add record on ${key}`, 'database-day-add'); add.append(icon('plus'));
    add.disabled = date.getFullYear() < 1 || date.getFullYear() > 9999;
    add.onclick = () => actions.addRow({ [column.id]: key }); header.append(add); day.append(header);
    for (const row of byDate.get(key) ?? []) {
      const event = button(`Edit ${recordTitle(data, row)} on ${key}`, 'database-calendar-event'); event.textContent = recordTitle(data, row);
      event.onclick = () => actions.editRow(row); day.append(event);
    }
    grid.append(day);
  }
  wrapper.append(weekdays, grid); calendar.append(wrapper);
  const undated = byDate.get('') ?? [];
  const unscheduled = el('div', 'database-unscheduled');
  const unscheduledHeader = el('div', 'database-unscheduled-header');
  unscheduledHeader.append(el('span', '', 'Without a date'), el('span', 'database-lane-count', String(undated.length)));
  unscheduled.append(unscheduledHeader);
  if (!undated.length) unscheduled.append(el('p', '', data.filter.trim() ? 'No matching undated records.' : 'Every record has a date.'));
  for (const row of undated) {
    const item = button(`Schedule ${recordTitle(data, row)}`, 'database-calendar-event'); item.textContent = recordTitle(data, row);
    item.onclick = () => actions.editRow(row); unscheduled.append(item);
  }
  calendar.append(unscheduled); return calendar;
}
