import { appendPlanner, loadPlannerFile } from '../desktop/platform';
import { button, el } from '../ui/dom';
import { askDialog } from '../ui/dialog';
import { icon } from '../ui/icons';
import { addDays, monthGrid, monthNames, localToday, validDate, weekday, weekdayNames } from './dates';
import {
  activeRepeat, canonicalRepeat, changedFields, createTask, deleteFollowing, describeRepeat, moveOccurrence, occurrencesBetween, overdue,
  setDone, skipOccurrence, unscheduled, weekdayPosition, MAX_TITLE, type Frequency, type Occurrence, type Planner, type PlannerOp, type Repeat, type Task,
} from './model';

const DRAG_TYPE = 'application/x-noter-task';
const CELL_LIMIT = 4;
const OVERDUE_LIMIT = 60;
const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const positions = ['', 'first', 'second', 'third', 'fourth'];

function longDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function shortDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
/** A single task is an occurrence of itself; unscheduled tasks have no date. */
function single(task: Task): Occurrence { return { task, on: task.date ?? '', date: task.date ?? '', done: task.done, repeating: false }; }

export function createPlanner(root: HTMLElement) {
  let planner: Planner | undefined;
  let loaded = false, loadError = false, busy = false, visible = false;
  let today = localToday();
  let [year, month] = today.split('-').map(Number);
  let focusDate = today;
  const status = el('p', 'finance-status planner-status'); status.setAttribute('role', 'status');
  const body = el('div', 'planner-body'); root.append(body, status);
  /** Occurrences by drag key, so drop targets can find what was dragged. */
  const dragged = new Map<string, Occurrence>();

  function message(text: string, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
  function action(label: string, callback: () => void, className = 'button-secondary') {
    const control = button(label, className); control.textContent = label; control.onclick = callback; return control;
  }

  async function commit(ops: PlannerOp[]): Promise<boolean> {
    if (busy || loadError || !planner || !ops.length) return false;
    busy = true; message('Saving…');
    try { planner = await appendPlanner(ops); message('Saved in your workspace folder'); return true; }
    catch (error) { loadError = true; message(error instanceof Error ? error.message : String(error), true); return false; }
    finally { busy = false; render(); }
  }

  async function reload() {
    try { planner = await loadPlannerFile(); loadError = false; if (status.classList.contains('is-error')) message(''); }
    catch (error) { loadError = true; message(`${error instanceof Error ? error.message : String(error)} Reload to try again.`, true); }
    finally { loaded = true; render(); }
  }

  // ---- Task editor --------------------------------------------------------------------------

  function editTask(item?: Occurrence, date: string | null = null) {
    if (!planner || busy || loadError) return;
    const task = item?.task;
    const dialog = el('dialog', 'dialog planner-dialog');
    const form = el('form');
    const heading = el('h2', '', task ? 'Edit task' : 'New task'); heading.id = 'planner-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const close = button('Close dialog'); close.append(icon('close')); close.onclick = () => dialog.close();
    const header = el('div', 'dialog-header'); header.append(heading, close); form.append(header);
    function labelled(text: string, control: HTMLElement, className = 'field-label') { const label = el('label', className, text); label.append(control); return label; }
    const title = el('input', 'field-input'); title.required = true; title.maxLength = MAX_TITLE; title.autocomplete = 'off'; title.value = task?.title ?? ''; title.placeholder = 'What needs doing?';
    const day = el('input', 'field-input'); day.type = 'date'; day.value = task ? task.date ?? '' : date ?? '';
    form.append(labelled('Task', title), labelled('Date', day), el('p', 'planner-hint', 'Leave the date empty to keep the task in Unscheduled.'));
    const rule = task?.repeat;
    const repeatRow = el('div', 'planner-repeat');
    const frequency = el('select', 'field-input');
    for (const [value, label] of [['', 'Does not repeat'], ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']]) { const option = el('option', '', label); option.value = value; frequency.append(option); }
    frequency.value = rule?.every ?? '';
    const interval = el('input', 'field-input planner-interval'); interval.type = 'number'; interval.min = '1'; interval.max = '999'; interval.value = String(rule?.interval ?? 1);
    const unit = el('span', 'planner-unit');
    const every = el('div', 'planner-every'); every.append(el('span', '', 'Every'), interval, unit);
    const weekdays = el('div', 'planner-weekdays-picker'); weekdays.setAttribute('role', 'group'); weekdays.setAttribute('aria-label', 'Repeat on');
    const chosenDays = new Set(rule?.weekdays ?? []);
    const dayButtons = shortDays.map((name, index) => {
      const toggle = button(weekdayNames[index], 'planner-weekday'); toggle.textContent = name.slice(0, 2);
      toggle.onclick = () => {
        // The start date's weekday is selected by default; clicking other days adds to it.
        if (!chosenDays.size && validDate(day.value)) chosenDays.add(weekday(day.value));
        if (!chosenDays.has(index + 1)) chosenDays.add(index + 1); else if (chosenDays.size > 1) chosenDays.delete(index + 1);
        update();
      };
      weekdays.append(toggle); return toggle;
    });
    const monthly = el('select', 'field-input'); monthly.setAttribute('aria-label', 'Monthly on');
    const ends = el('select', 'field-input'); ends.setAttribute('aria-label', 'Ends');
    for (const [value, label] of [['never', 'Never ends'], ['until', 'Ends on a date'], ['count', 'Ends after a number of times']]) { const option = el('option', '', label); option.value = value; ends.append(option); }
    ends.value = rule?.until ? 'until' : rule?.count ? 'count' : 'never';
    const until = el('input', 'field-input'); until.type = 'date'; until.value = rule?.until ?? ''; until.setAttribute('aria-label', 'Last date');
    const count = el('input', 'field-input'); count.type = 'number'; count.min = '1'; count.max = '10000'; count.value = String(rule?.count ?? 10); count.setAttribute('aria-label', 'Number of times');
    const summary = el('p', 'planner-summary'); summary.setAttribute('aria-live', 'polite');
    repeatRow.append(labelled('Repeat', frequency), every, weekdays, monthly, ends, until, count, summary);
    form.append(repeatRow);
    if (item?.repeating) form.append(el('p', 'planner-hint', `Changes apply to every occurrence. This one is on ${longDate(item.on)}.`));
    const error = el('p', 'finance-error'); error.setAttribute('role', 'alert'); form.append(error);

    function currentRepeat(): Repeat | null {
      if (!frequency.value || !validDate(day.value)) return null;
      const value: Record<string, unknown> = { every: frequency.value, interval: Number(interval.value) };
      if (frequency.value === 'week') value.weekdays = chosenDays.size ? [...chosenDays] : [weekday(day.value)];
      if (frequency.value === 'month' && monthly.value === 'weekday') value.monthly = 'weekday';
      if (ends.value === 'until') value.until = until.value;
      if (ends.value === 'count') value.count = Number(count.value);
      const result = canonicalRepeat(value);
      if (!result) throw new Error(ends.value === 'until' && !validDate(until.value) ? 'Choose the last date for this repeat.' : 'Use a repeat interval from 1 to 999 and up to 10,000 times.');
      if (result.until && result.until < day.value) throw new Error('The last date must be on or after the task date.');
      return result;
    }
    function update() {
      const scheduled = validDate(day.value), kind = frequency.value as Frequency | '';
      frequency.disabled = !scheduled;
      if (!scheduled && kind) frequency.value = '';
      const repeating = scheduled && !!frequency.value;
      every.hidden = ends.hidden = summary.hidden = !repeating;
      weekdays.hidden = !repeating || frequency.value !== 'week';
      monthly.hidden = !repeating || frequency.value !== 'month';
      until.hidden = !repeating || ends.value !== 'until';
      count.hidden = !repeating || ends.value !== 'count';
      const n = Number(interval.value);
      unit.textContent = { day: 'day', week: 'week', month: 'month', year: 'year', '': '' }[frequency.value as Frequency | ''] + (n === 1 ? '' : 's');
      const fallback = scheduled ? weekday(day.value) : 0;
      dayButtons.forEach((toggle, index) => toggle.setAttribute('aria-pressed', String(chosenDays.size ? chosenDays.has(index + 1) : index + 1 === fallback)));
      if (scheduled) {
        const previous = monthly.value || rule?.monthly || 'day', position = weekdayPosition(day.value);
        monthly.replaceChildren();
        for (const [value, label] of [['day', `On day ${Number(day.value.slice(8))}`], ['weekday', `On the ${position < 0 ? 'last' : positions[position]} ${weekdayNames[weekday(day.value) - 1]}`]]) { const option = el('option', '', label); option.value = value; monthly.append(option); }
        monthly.value = previous;
      }
      error.textContent = '';
      try { const current = currentRepeat(); summary.textContent = current ? describeRepeat(current, day.value) : ''; }
      catch (problem) { summary.textContent = problem instanceof Error ? problem.message : ''; }
    }
    for (const control of [day, frequency, interval, monthly, ends, until, count]) control.addEventListener('input', update);
    update();

    const actions = el('div', 'dialog-actions planner-actions');
    if (item) {
      const remove = action('Delete…', () => { dialog.close(); void removeTask(item); }, 'button-danger');
      actions.append(remove, el('span', 'planner-spacer'));
    }
    const submit = el('button', 'button-primary', task ? 'Save task' : 'Add task'); submit.type = 'submit';
    actions.append(action('Cancel', () => dialog.close()), submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        if (day.value && !validDate(day.value)) throw new Error('Choose a valid date or leave it empty.');
        const next = { title: title.value, date: day.value || null, repeat: currentRepeat() };
        const ops: PlannerOp[] = task
          ? (() => { const set = changedFields(task, next); return Object.keys(set).length ? [{ k: 'task', id: task.id, set }] : []; })()
          : [createTask(crypto.randomUUID(), next.title, next.date, next.repeat, Date.now())];
        if (!ops.length) { dialog.close(); return; }
        submit.disabled = true;
        if (await commit(ops)) dialog.close();
        else error.textContent = 'Could not save. Your changes are still in this dialog.';
      } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'Could not save this task.'; }
      finally { submit.disabled = false; }
    };
    dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); render(); }, { once: true });
    dialog.showModal(); title.focus();
  }

  async function removeTask(item: Occurrence) {
    if (!item.repeating) {
      const confirmed = await askDialog({ title: `Delete “${item.task.title}”?`, description: 'This task is removed on every device that syncs this folder.', submit: 'Delete task', danger: true });
      if (confirmed) await commit([{ k: 'del', id: item.task.id }]);
      return;
    }
    const choice = await chooseDialog(`Delete “${item.task.title}”?`, `This is a repeating task. Choose what to delete, starting from ${longDate(item.on)}.`, [
      ['one', 'Only this occurrence'], ['following', 'This and following'], ['all', 'All occurrences'],
    ]);
    if (choice === 'one') await commit([skipOccurrence(item)]);
    if (choice === 'following') await commit([deleteFollowing(item)]);
    if (choice === 'all') await commit([{ k: 'del', id: item.task.id }]);
  }

  function chooseDialog(title: string, description: string, choices: [string, string][]): Promise<string | null> {
    return new Promise(resolve => {
      const dialog = el('dialog', 'dialog'); let result: string | null = null;
      const heading = el('h2', '', title); heading.id = 'planner-choice-title'; dialog.setAttribute('aria-labelledby', heading.id);
      const header = el('div', 'dialog-header'); header.append(heading);
      const list = el('div', 'planner-choices');
      for (const [value, label] of choices) list.append(action(label, () => { result = value; dialog.close(); }, value === 'all' ? 'button-danger' : 'button-secondary'));
      const actions = el('div', 'dialog-actions'); actions.append(action('Cancel', () => dialog.close()));
      dialog.append(header, el('p', 'dialog-description', description), list, actions); document.body.append(dialog);
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
      dialog.showModal(); list.querySelector('button')?.focus();
    });
  }

  // ---- Task rows ------------------------------------------------------------------------------

  function dragKey(item: Occurrence) { return `${item.task.id}\u0000${item.on}`; }

  function taskRow(item: Occurrence, options: { compact?: boolean; showDate?: boolean; overdue?: boolean } = {}) {
    const row = el('div', `planner-task${item.done ? ' is-done' : ''}${options.overdue ? ' is-overdue' : ''}${options.compact ? ' is-compact' : ''}`);
    const key = dragKey(item); dragged.set(key, item);
    row.draggable = !busy; row.dataset.task = item.task.id; row.dataset.on = item.on;
    row.addEventListener('dragstart', event => {
      event.dataTransfer?.setData(DRAG_TYPE, key); event.dataTransfer!.effectAllowed = 'move';
      row.classList.add('is-dragging'); root.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); root.classList.remove('is-dragging'); root.querySelectorAll('.is-drop').forEach(target => target.classList.remove('is-drop')); });
    const check = el('input', 'planner-check'); check.type = 'checkbox'; check.checked = item.done; check.disabled = busy;
    check.setAttribute('aria-label', `${item.done ? 'Reopen' : 'Complete'} ${item.task.title}${item.date ? `, ${longDate(item.date)}` : ''}`);
    check.onchange = () => { if (planner) void commit([setDone(planner, item, check.checked)]); };
    const open = el('button', 'planner-task-title'); open.type = 'button';
    open.append(el('span', 'planner-task-text', item.task.title));
    if (item.repeating) { const mark = el('span', 'planner-repeat-mark', '↻'); mark.title = describeRepeat(activeRepeat(item.task)!, item.task.date!); open.append(mark); }
    if (options.showDate && item.date) open.append(el('span', 'planner-task-date', shortDate(item.date)));
    open.setAttribute('aria-label', `${item.task.title}${item.repeating ? ', repeats' : ''}${item.date ? `, ${longDate(item.date)}` : ', unscheduled'}${item.done ? ', done' : ''}. Alt+arrow keys move it.`);
    open.title = item.task.title;
    open.onclick = () => editTask(item);
    // Keyboard alternative to dragging: Alt+Left/Right moves by a day, Alt+Up/Down by a week.
    open.addEventListener('keydown', event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !item.date || !planner) return;
      const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
      if (!step) return;
      event.preventDefault(); const target = addDays(item.date, step); focusDate = target; followMonth(target);
      void commit([moveOccurrence(planner, item, target)]).then(saved => { if (saved) focusTask(item.task.id, item.on); });
    });
    row.append(check, open);
    return row;
  }

  function focusTask(id: string, on: string) {
    root.querySelector<HTMLElement>(`.planner-task[data-task="${CSS.escape(id)}"][data-on="${CSS.escape(on)}"] .planner-task-title`)?.focus();
  }

  function dropTarget(target: HTMLElement, accept: (item: Occurrence) => PlannerOp | string | null) {
    target.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes(DRAG_TYPE) || busy) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; target.classList.add('is-drop');
    });
    target.addEventListener('dragleave', event => { if (!target.contains(event.relatedTarget as Node)) target.classList.remove('is-drop'); });
    target.addEventListener('drop', event => {
      target.classList.remove('is-drop');
      const item = dragged.get(event.dataTransfer?.getData(DRAG_TYPE) ?? '');
      if (!item || !planner) return;
      event.preventDefault();
      const op = accept(item);
      if (typeof op === 'string') message(op, true); else if (op) void commit([op]);
    });
  }

  function scheduleOn(date: string) {
    return (item: Occurrence): PlannerOp | null => {
      if (!planner || item.date === date) return null;
      return item.task.date ? moveOccurrence(planner, item, date) : { k: 'task', id: item.task.id, set: { date } };
    };
  }

  // ---- Layout -------------------------------------------------------------------------------

  function followMonth(date: string) { [year, month] = date.split('-').map(Number); }

  function render() {
    if (!visible) return;
    dragged.clear();
    today = localToday();
    const active = document.activeElement as HTMLElement | null;
    const restore = active && root.contains(active) ? (active.dataset.date ? { date: active.dataset.date } : active.closest<HTMLElement>('.planner-task') ? { task: active.closest<HTMLElement>('.planner-task')!.dataset.task!, on: active.closest<HTMLElement>('.planner-task')!.dataset.on!, check: active.classList.contains('planner-check') } : null) : null;
    body.replaceChildren();
    const header = el('div', 'planner-header');
    const heading = el('div'); heading.append(el('p', 'finance-eyebrow', 'PLANNER'));
    const titleText = `${monthNames[month - 1]} ${year}`;
    const h1 = el('h1', '', titleText); h1.id = 'planner-month'; heading.append(h1);
    const tools = el('div', 'planner-tools');
    const previous = button('Previous month'); previous.append(icon('chevron')); previous.classList.add('planner-previous'); previous.onclick = () => shiftMonth(-1);
    const next = button('Next month'); next.append(icon('chevron')); next.onclick = () => shiftMonth(1);
    tools.append(previous, action('Today', () => { focusDate = today; followMonth(today); render(); focusCell(today); }), next, action('New task', () => editTask(undefined, focusDate), 'button-primary'));
    header.append(heading, tools); body.append(header);
    if (!loaded) { body.append(el('p', 'finance-local', 'Opening Planner…')); return; }
    if (loadError || !planner) {
      const problem = el('div', 'finance-welcome'); problem.append(el('h2', '', 'Planner needs a reload'), el('p', '', status.textContent || 'Planner could not be opened.'), action('Reload Planner', () => void reload(), 'button-primary'));
      body.append(problem); return;
    }
    const layout = el('div', 'planner-layout');
    layout.append(calendar(), sidebar());
    body.append(layout);
    if (restore && 'date' in restore) focusCell(restore.date!);
    else if (restore && 'task' in restore) {
      const row = root.querySelector<HTMLElement>(`.planner-task[data-task="${CSS.escape(restore.task)}"][data-on="${CSS.escape(restore.on)}"]`);
      row?.querySelector<HTMLElement>(restore.check ? '.planner-check' : '.planner-task-title')?.focus();
    }
  }

  function shiftMonth(delta: number) {
    const index = year * 12 + month - 1 + delta; year = Math.floor(index / 12); month = index % 12 + 1;
    const day = Math.min(Number(focusDate.slice(8)), 28); focusDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    render();
  }

  function focusCell(date: string) { root.querySelector<HTMLElement>(`.planner-day[data-date="${date}"]`)?.focus(); }

  function calendar() {
    const section = el('section', 'planner-calendar'); section.setAttribute('aria-labelledby', 'planner-month');
    const days = monthGrid(year, month);
    if (!days.includes(focusDate)) focusDate = days.find(date => date.slice(0, 7) === `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`)!;
    const items = occurrencesBetween(planner!, days[0], days[41]);
    const byDate = new Map<string, Occurrence[]>();
    for (const item of items) byDate.set(item.date, [...byDate.get(item.date) ?? [], item]);
    const grid = el('div', 'planner-grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-labelledby', 'planner-month');
    const head = el('div', 'planner-row planner-weekdays'); head.setAttribute('role', 'row');
    weekdayNames.forEach((name, index) => { const cell = el('div', 'planner-weekday-name', shortDays[index]); cell.setAttribute('role', 'columnheader'); cell.setAttribute('aria-label', name); head.append(cell); });
    grid.append(head);
    for (let week = 0; week < 6; week++) {
      const row = el('div', 'planner-row'); row.setAttribute('role', 'row');
      for (const date of days.slice(week * 7, week * 7 + 7)) {
        const list = byDate.get(date) ?? [];
        const cell = el('div', 'planner-day'); cell.setAttribute('role', 'gridcell'); cell.dataset.date = date;
        cell.tabIndex = date === focusDate ? 0 : -1;
        const outside = date.slice(5, 7) !== String(month).padStart(2, '0');
        cell.classList.toggle('is-outside', outside); cell.classList.toggle('is-today', date === today); cell.classList.toggle('is-past', date < today);
        const open = list.filter(item => !item.done).length;
        cell.setAttribute('aria-label', `${longDate(date)}${date === today ? ', today' : ''}. ${list.length ? `${list.length} ${list.length === 1 ? 'task' : 'tasks'}${open !== list.length ? `, ${open} open` : ''}` : 'No tasks'}. Press Enter to add a task.`);
        const top = el('div', 'planner-day-top');
        top.append(el('span', 'planner-day-number', String(Number(date.slice(8)))));
        const add = button(`Add a task on ${longDate(date)}`, 'icon-button planner-add'); add.append(icon('plus')); add.tabIndex = -1; add.onclick = event => { event.stopPropagation(); focusDate = date; editTask(undefined, date); };
        top.append(add); cell.append(top);
        const tasks = el('div', 'planner-day-tasks');
        for (const item of list.slice(0, list.length > CELL_LIMIT ? CELL_LIMIT - 1 : CELL_LIMIT)) tasks.append(taskRow(item, { compact: true, overdue: !item.done && date < today }));
        if (list.length > CELL_LIMIT) {
          const more = el('button', 'planner-more', `+${list.length - CELL_LIMIT + 1} more`); more.type = 'button';
          more.setAttribute('aria-label', `Show all ${list.length} tasks on ${longDate(date)}`); more.onclick = event => { event.stopPropagation(); dayDialog(date); };
          tasks.append(more);
        }
        cell.append(tasks);
        cell.addEventListener('click', event => { if (event.target === cell || event.target === tasks || (event.target as Element).closest('.planner-day-top') && !(event.target as Element).closest('button')) { focusDate = date; moveFocus(date); } });
        cell.addEventListener('dblclick', event => { if (!(event.target as Element).closest('.planner-task, button')) { focusDate = date; editTask(undefined, date); } });
        cell.addEventListener('keydown', event => onCellKey(event, date));
        dropTarget(cell, scheduleOn(date));
        row.append(cell);
      }
      grid.append(row);
    }
    section.append(grid);
    return section;
  }

  function moveFocus(date: string) {
    focusDate = date;
    const target = root.querySelector<HTMLElement>(`.planner-day[data-date="${date}"]`);
    if (!target) { followMonth(date); render(); focusCell(date); return; }
    root.querySelectorAll<HTMLElement>('.planner-day').forEach(cell => { cell.tabIndex = cell === target ? 0 : -1; });
    target.focus();
  }

  function onCellKey(event: KeyboardEvent, date: string) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: 1 - weekday(date), End: 7 - weekday(date) };
    if (event.key in steps) { event.preventDefault(); moveFocus(addDays(date, steps[event.key])); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); const [y, m, d] = date.split('-').map(Number), index = y * 12 + m - 1 + (event.key === 'PageUp' ? -1 : 1);
      const target = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`;
      followMonth(target); focusDate = target; render(); focusCell(target); return;
    }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editTask(undefined, date); }
  }

  function dayDialog(date: string) {
    if (!planner) return;
    const dialog = el('dialog', 'dialog planner-dialog');
    const heading = el('h2', '', longDate(date)); heading.id = 'planner-day-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const close = button('Close dialog'); close.append(icon('close')); close.onclick = () => dialog.close();
    const header = el('div', 'dialog-header'); header.append(heading, close);
    const list = el('div', 'planner-list');
    for (const item of occurrencesBetween(planner, date, date)) {
      const row = taskRow(item, { overdue: !item.done && date < today });
      row.querySelector<HTMLElement>('.planner-task-title')!.onclick = () => { dialog.close(); editTask(item); };
      list.append(row);
    }
    const actions = el('div', 'dialog-actions'); actions.append(action('Add task', () => { dialog.close(); editTask(undefined, date); }, 'button-primary'));
    dialog.append(header, list, actions); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); render(); }, { once: true });
    dialog.showModal(); close.focus();
  }

  function sidebar() {
    const aside = el('aside', 'planner-side'); aside.setAttribute('aria-label', 'Unscheduled and overdue tasks');
    const late = overdue(planner!, today);
    if (late.length) {
      const section = el('section', 'planner-section planner-overdue');
      const top = el('div', 'planner-section-heading'); const h2 = el('h2', '', 'Overdue'); h2.id = 'planner-overdue-title';
      top.append(h2, el('span', 'planner-count', String(late.length)));
      if (late.length > 1) top.append(action('Move all to today', () => { if (planner) void commit(late.map(item => moveOccurrence(planner!, item, today))); }, 'planner-link'));
      section.setAttribute('aria-labelledby', h2.id); section.append(top);
      const list = el('div', 'planner-list');
      for (const item of late.slice(-OVERDUE_LIMIT).reverse()) {
        const row = taskRow(item, { showDate: true, overdue: true });
        const move = button(`Move ${item.task.title} to today`, 'planner-link'); move.textContent = 'Today'; move.disabled = busy;
        move.onclick = () => { if (planner) void commit([moveOccurrence(planner, item, today)]); };
        row.append(move); list.append(row);
      }
      if (late.length > OVERDUE_LIMIT) list.append(el('p', 'planner-hint', `${late.length - OVERDUE_LIMIT} older overdue tasks are not shown. Complete or move recent ones first.`));
      section.append(list); aside.append(section);
    }
    const section = el('section', 'planner-section planner-inbox');
    const top = el('div', 'planner-section-heading'); const h2 = el('h2', '', 'Unscheduled'); h2.id = 'planner-inbox-title';
    const loose = unscheduled(planner!);
    top.append(h2, el('span', 'planner-count', String(loose.filter(task => !task.done).length)));
    section.setAttribute('aria-labelledby', h2.id); section.append(top);
    const quick = el('form', 'planner-quick');
    const input = el('input', 'field-input'); input.placeholder = 'Add a task…'; input.maxLength = MAX_TITLE; input.setAttribute('aria-label', 'New unscheduled task'); input.autocomplete = 'off'; input.disabled = busy;
    quick.append(input);
    quick.onsubmit = async event => {
      event.preventDefault();
      if (!input.value.trim()) return;
      const saved = await commit([createTask(crypto.randomUUID(), input.value, null, null, Date.now())]);
      if (saved) root.querySelector<HTMLInputElement>('.planner-quick input')?.focus();
    };
    section.append(quick);
    const list = el('div', 'planner-list planner-drop');
    for (const task of loose) list.append(taskRow(single(task)));
    if (!loose.length) list.append(el('p', 'planner-hint', 'Tasks without a date wait here. Drag one onto a day to schedule it.'));
    section.append(list);
    dropTarget(section, item => item.repeating ? 'Repeating tasks stay on the calendar. Edit the task to remove its date.' : item.task.date ? { k: 'task', id: item.task.id, set: { date: null } } : null);
    aside.append(section);
    aside.append(el('p', 'finance-local', 'Drag tasks between days or onto Unscheduled. Planner syncs through .noter/planner in your workspace folder.'));
    return aside;
  }

  // Midnight changes what counts as today and overdue.
  setInterval(() => { if (visible && localToday() !== today && !busy && !document.querySelector('dialog[open]')) render(); }, 60_000);

  return {
    show() { visible = true; root.hidden = false; if (!loaded) void reload(); else render(); },
    hide() { visible = false; root.hidden = true; },
    reload,
    isBusy: () => busy,
    focusNew() { editTask(undefined, focusDate); },
  };
}
