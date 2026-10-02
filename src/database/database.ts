import { button, el } from '../ui/dom';
import { icon } from '../ui/icons';
import { showMenu, type MenuItem } from '../ui/menu';
import { askDialog } from '../ui/dialog';
import { animateOut } from '../ui/motion';
import { cellValue, columnTypes, newRow, readDatabase, resolveViewColumns, visibleRows, type Cell, type Column, type ColumnType, type DatabaseView, type NoteDatabase, type Row } from './model';
import { calendarView, kanbanView, recordTitle, type ViewActions } from './views';

const bound = new WeakSet<HTMLElement>();
const badges: Record<ColumnType, string> = { text: 'T', number: '#', select: '⌄', date: '◷', checkbox: '✓' };

function propertyDialog(column?: Column, preferredType: ColumnType = 'text'): Promise<Omit<Column, 'id'> | null> {
  return new Promise(resolve => {
    const dialog = el('dialog', 'dialog');
    const form = el('form');
    const header = el('div', 'dialog-header');
    const title = el('h2', '', column ? 'Edit property' : 'Add a property'); title.id = 'database-property-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('Close property settings'); close.append(icon('close')); header.append(title, close);
    form.append(header, el('p', 'dialog-description', 'Choose a name and a type. Changing the type converts existing cell values.'));
    const name = el('input', 'field-input'); name.value = column?.name ?? (preferredType === 'date' ? 'Date' : preferredType === 'select' ? 'Status' : ''); name.required = true; name.maxLength = 80; name.autocomplete = 'off';
    const nameLabel = el('label', 'field-label', 'Property name'); nameLabel.append(name);
    const type = el('select', 'field-input');
    for (const [value, label] of Object.entries(columnTypes)) { const option = el('option', '', label); option.value = value; type.append(option); }
    type.value = column?.type ?? preferredType;
    const typeLabel = el('label', 'field-label', 'Type'); typeLabel.append(type);
    const options = el('input', 'field-input'); options.value = column?.options.join(', ') ?? (preferredType === 'select' ? 'Not started, In progress, Done' : ''); options.placeholder = 'Not started, In progress, Done'; options.maxLength = 2000;
    const optionsLabel = el('label', 'field-label', 'Options, separated by commas'); optionsLabel.append(options);
    const updateOptions = () => { optionsLabel.hidden = type.value !== 'select'; options.required = type.value === 'select'; };
    type.onchange = updateOptions; updateOptions();
    name.oninput = () => name.setCustomValidity(''); options.oninput = () => options.setCustomValidity('');
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', 'button-secondary'); cancel.textContent = 'Cancel';
    const submit = el('button', 'button-primary', column ? 'Save changes' : 'Add property'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(nameLabel, typeLabel, optionsLabel, actions); dialog.append(form);
    let result: Omit<Column, 'id'> | null = null;
    let closing = false;
    const finish = async () => { if (closing) return; closing = true; await animateOut(dialog); dialog.close(); };
    form.onsubmit = event => {
      event.preventDefault();
      const values = [...new Set(options.value.split(',').map(value => value.trim()).filter(Boolean))];
      if (!name.value.trim()) { name.setCustomValidity('Enter a property name.'); name.reportValidity(); return; }
      if (type.value === 'select' && !values.length) { options.setCustomValidity('Enter at least one option.'); options.reportValidity(); return; }
      result = { name: name.value.trim(), type: type.value as ColumnType, options: type.value === 'select' ? values : [] }; void finish();
    };
    close.onclick = cancel.onclick = () => void finish();
    dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal(); name.focus(); name.select();
  });
}

function cellField(column: Column, value: Cell, className = 'database-cell'): HTMLInputElement | HTMLSelectElement {
  if (column.type === 'select') {
    const field = el('select', className);
    const empty = el('option', '', 'Empty'); empty.value = ''; field.append(empty);
    const values = [...column.options]; if (value && !values.includes(String(value))) values.push(String(value));
    values.forEach(value => { const option = el('option', '', value); option.value = value; field.append(option); });
    field.value = String(value ?? ''); return field;
  }
  const field = el('input', column.type === 'checkbox' ? (className === 'database-cell' ? 'database-checkbox' : 'database-record-checkbox') : className);
  field.type = column.type === 'checkbox' ? 'checkbox' : column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
  if (column.type === 'checkbox') field.checked = value === true;
  else { field.value = String(value ?? ''); field.placeholder = 'Empty'; }
  if (column.type === 'number') field.step = 'any';
  field.autocomplete = 'off'; return field;
}

function fieldValue(field: HTMLInputElement | HTMLSelectElement, column: Column): Cell {
  return cellValue(field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value, column.type);
}

function recordDialog(data: NoteDatabase, row: Row, editing: boolean): Promise<Row | 'delete' | null> {
  return new Promise(resolve => {
    const draft: Row = { id: row.id, cells: { ...row.cells } };
    const dialog = el('dialog', 'dialog database-record-dialog'), form = el('form');
    const header = el('div', 'dialog-header');
    const title = el('h2', '', editing ? recordTitle(data, row) : 'New record'); title.id = 'database-record-title'; dialog.setAttribute('aria-labelledby', title.id);
    const close = button('Close record'); close.append(icon('close')); header.append(title, close);
    form.append(header, el('p', 'dialog-description', data.title || 'Untitled database'));
    for (const column of data.columns) {
      const label = el('label', 'field-label', column.name);
      const field = cellField(column, draft.cells[column.id], 'field-input'); field.setAttribute('aria-label', column.name);
      field.oninput = () => { draft.cells[column.id] = fieldValue(field, column); };
      label.append(field); form.append(label);
    }
    const actions = el('div', 'dialog-actions');
    let result: Row | 'delete' | null = null, closing = false;
    const finish = async () => { if (closing) return; closing = true; await animateOut(dialog); dialog.close(); };
    if (editing) {
      const remove = button('Delete record', 'button-danger database-record-delete'); remove.textContent = 'Delete';
      remove.onclick = () => { result = 'delete'; void finish(); }; actions.append(remove);
    }
    const cancel = button('Cancel', 'button-secondary'); cancel.textContent = 'Cancel';
    const save = el('button', 'button-primary', editing ? 'Save changes' : 'Create record'); save.type = 'submit'; actions.append(cancel, save);
    form.append(actions); dialog.append(form);
    form.onsubmit = event => { event.preventDefault(); result = draft; void finish(); };
    close.onclick = cancel.onclick = () => void finish();
    dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal(); form.querySelector<HTMLElement>('input,select')?.focus();
  });
}

function bindDatabase(block: HTMLElement, data: NoteDatabase) {
  bound.add(block);
  block.replaceChildren(); block.contentEditable = 'false'; block.spellcheck = false;
  block.setAttribute('role', 'region'); block.setAttribute('aria-label', data.title || 'Database');
  const before = (force = false) => block.dispatchEvent(new CustomEvent('databasebeforechange', { bubbles: true, detail: { force } }));
  const commit = () => {
    block.dataset.database = JSON.stringify(data);
    block.setAttribute('aria-label', data.title || 'Database');
    table.setAttribute('aria-label', data.title || 'Database');
    block.dispatchEvent(new CustomEvent('databasechange', { bubbles: true }));
  };
  const header = el('div', 'database-header');
  const title = el('input', 'database-title'); title.value = data.title; title.placeholder = 'Untitled database'; title.maxLength = 120; title.setAttribute('aria-label', 'Database title');
  title.oninput = () => { before(); data.title = title.value; commit(); };
  const more = button('Database actions'); more.append(icon('more'));
  header.append(icon('table'), title, more);
  const tabs = el('div', 'database-view-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Database view');
  const viewButtons = new Map<DatabaseView, HTMLButtonElement>();
  for (const view of ['table', 'kanban', 'calendar'] as const) {
    const trigger = button(`${view[0].toUpperCase()}${view.slice(1)} view`, 'database-view-tab');
    trigger.append(icon(view), el('span', '', `${view[0].toUpperCase()}${view.slice(1)}`));
    trigger.onclick = () => { if (data.view === view) return; before(true); data.view = view; render(); commit(); trigger.focus(); };
    viewButtons.set(view, trigger); tabs.append(trigger);
  }
  const toolbar = el('div', 'database-toolbar');
  const search = el('div', 'database-filter'); search.append(icon('search'));
  const filter = el('input'); filter.type = 'search'; filter.placeholder = 'Filter rows…'; filter.value = data.filter; filter.setAttribute('aria-label', 'Filter database rows'); search.append(filter);
  const clearSort = button('Clear database sorting', 'database-sort-clear');
  clearSort.append(icon('close'), el('span', '', 'Clear sort')); clearSort.hidden = !data.sort;
  toolbar.append(search, clearSort);
  const configuration = el('div', 'database-view-config');
  const wrapper = el('div', 'database-table-wrap');
  const table = el('table', 'database-table'); table.setAttribute('aria-label', data.title || 'Database');
  const head = el('thead'), body = el('tbody'); table.append(head, body); wrapper.append(table);
  const viewHost = el('div', 'database-view-content');
  const footer = el('div', 'database-footer');
  const addRow = button('Add database row', 'database-add-row'); addRow.append(icon('plus'), el('span', '', 'New row'));
  const count = el('span', 'database-row-count'); count.setAttribute('aria-live', 'polite'); footer.append(addRow, count);
  block.append(header, tabs, toolbar, configuration, wrapper, viewHost, footer);

  const actions: ViewActions = {
    editRow: row => void editRecord(row),
    addRow: defaults => void editRecord(undefined, defaults),
    moveRow: (row, column, value) => {
      if (row.cells[column.id] === value) return;
      before(true); row.cells[column.id] = value; renderContent(); commit();
      const card = Array.from(viewHost.querySelectorAll<HTMLElement>('.database-card')).find(card => card.dataset.rowId === row.id);
      card?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true }); card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    changeMonth: (month, control) => {
      if (data.calendarMonth === month) return;
      before(true); data.calendarMonth = month; renderContent(); commit();
      const trigger = viewHost.querySelector<HTMLButtonElement>(`[data-month-control='${control}']`);
      (trigger && !trigger.disabled ? trigger : viewButtons.get('calendar'))?.focus({ preventScroll: true });
    },
    addProperty: type => void editProperty(undefined, type),
  };

  function renderRows() {
    const rows = visibleRows(data); body.replaceChildren();
    if (!rows.length) {
      const row = el('tr'), cell = el('td', 'database-empty', data.filter.trim() ? 'No rows match your filter.' : 'Your table is ready. Add your first row.');
      cell.colSpan = data.columns.length + 2; row.append(cell); body.append(row); return;
    }
    for (const row of rows) {
      const tr = el('tr'); tr.dataset.rowId = row.id;
      for (const column of data.columns) {
        const td = el('td'); td.dataset.type = column.type;
        const field = cellField(column, row.cells[column.id]);
        field.setAttribute('aria-label', `${column.name}, row ${data.rows.indexOf(row) + 1}`);
        const update = () => {
          before();
          row.cells[column.id] = fieldValue(field, column);
          commit();
        };
        field.oninput = update;
        td.append(field); tr.append(td);
      }
      tr.append(el('td', 'database-spacer'));
      const actions = el('td', 'database-row-actions');
      const remove = button(`Delete row ${data.rows.indexOf(row) + 1}`, 'database-row-remove'); remove.append(icon('trash'));
      remove.onclick = () => { before(true); data.rows.splice(data.rows.indexOf(row), 1); renderContent(); commit(); addRow.focus(); };
      actions.append(remove); tr.append(actions); body.append(tr);
    }
  }

  function renderColumns() {
    head.replaceChildren();
    const row = el('tr');
    for (const column of data.columns) {
      const th = el('th'); th.scope = 'col'; th.dataset.type = column.type;
      const trigger = button(`${column.name} property settings`, 'database-column'); trigger.setAttribute('aria-haspopup', 'menu');
      trigger.append(el('span', 'database-type-badge', badges[column.type]), el('span', 'database-column-name', column.name));
      if (data.sort?.columnId === column.id) trigger.append(el('span', 'database-sort-indicator', data.sort.direction === 'asc' ? '↑' : '↓'));
      trigger.onclick = () => {
        const sort = (direction: 'asc' | 'desc') => { before(true); data.sort = { columnId: column.id, direction }; render(); commit(); };
        const items: MenuItem[] = [
          { label: 'Sort ascending', icon: 'arrow', action: () => sort('asc') },
          { label: 'Sort descending', icon: 'arrow', action: () => sort('desc') },
          { label: 'Edit property', icon: 'edit', action: () => void editProperty(column) },
        ];
        if (data.columns.length > 1) items.push({ label: 'Delete property', icon: 'trash', danger: true, action: () => void deleteProperty(column) });
        const bounds = trigger.getBoundingClientRect(); showMenu(bounds.left, bounds.bottom + 5, items, trigger, 'Property actions');
      };
      th.append(trigger); row.append(th);
    }
    const add = el('th'); add.scope = 'col'; add.className = 'database-spacer';
    const addProperty = button('Add database property', 'database-add-property'); addProperty.append(icon('plus')); addProperty.onclick = () => void editProperty(); add.append(addProperty);
    row.append(add, el('th', 'database-row-actions')); head.append(row);
  }

  function renderContent() {
    const rows = visibleRows(data);
    count.textContent = `${rows.length}${data.filter.trim() ? ` of ${data.rows.length}` : ''} ${rows.length === 1 ? 'record' : 'records'}`;
    if (data.view === 'table') renderRows();
    else {
      const scroll = viewHost.querySelector('.database-board')?.scrollLeft ?? 0;
      const view = data.view === 'kanban' ? kanbanView(data, rows, actions) : calendarView(data, rows, actions);
      viewHost.replaceChildren(view); if (data.view === 'kanban') view.scrollLeft = scroll;
    }
  }

  function renderConfiguration() {
    configuration.replaceChildren(); configuration.hidden = data.view === 'table';
    if (data.view === 'table') return;
    const type = data.view === 'calendar' ? 'date' : 'select';
    const key = data.view === 'calendar' ? 'calendarColumnId' : 'boardColumnId';
    const label = el('label', 'database-property-picker', data.view === 'calendar' ? 'Date property' : 'Group by');
    const select = el('select'); select.setAttribute('aria-label', label.textContent!);
    const properties = data.columns.filter(column => column.type === type);
    if (!properties.length) { select.append(el('option', '', `No ${type} property`)); select.disabled = true; }
    properties.forEach(column => { const option = el('option', '', column.name); option.value = column.id; select.append(option); });
    select.value = data[key] ?? '';
    select.onchange = () => { before(true); data[key] = select.value; renderContent(); commit(); };
    label.append(select); configuration.append(label);
    const property = data.columns.find(column => column.id === data[key]);
    if (property) {
      const edit = button('Edit view property', 'database-config-edit'); edit.append(icon('settings'));
      edit.onclick = () => { const selected = data.columns.find(column => column.id === data[key]); if (selected) void editProperty(selected); }; configuration.append(edit);
    }
  }

  function render() {
    resolveViewColumns(data); clearSort.hidden = !data.sort;
    for (const [view, trigger] of viewButtons) trigger.setAttribute('aria-pressed', String(data.view === view));
    wrapper.hidden = data.view !== 'table'; viewHost.hidden = data.view === 'table';
    addRow.replaceChildren(icon('plus'), el('span', '', data.view === 'table' ? 'New row' : 'New record'));
    renderConfiguration(); renderColumns(); renderContent();
  }

  body.addEventListener('focusout', () => requestAnimationFrame(() => {
    if (block.isConnected && data.view === 'table' && !body.contains(document.activeElement) && (data.sort || data.filter.trim())) renderContent();
  }));

  async function editProperty(column?: Column, preferredType: ColumnType = 'text') {
    const result = await propertyDialog(column, preferredType);
    if (!result || !block.isConnected) return;
    before(true);
    if (column) {
      Object.assign(column, result);
      data.rows.forEach(row => { row.cells[column.id] = cellValue(row.cells[column.id], column.type); });
    } else {
      const added = { ...result, id: crypto.randomUUID() }; data.columns.push(added);
      data.rows.forEach(row => { row.cells[added.id] = cellValue('', added.type); });
    }
    render(); commit();
    if (!column && data.view === 'table') wrapper.scrollLeft = wrapper.scrollWidth;
    (data.view === 'table' && !column ? head.querySelector<HTMLButtonElement>('.database-add-property') : viewButtons.get(data.view))?.focus({ preventScroll: true });
  }

  async function deleteProperty(column: Column) {
    const result = await askDialog({ title: `Delete “${column.name}”?`, description: 'This removes the property and its cell values from every row.', submit: 'Delete property', danger: true });
    if (!result || !block.isConnected) return;
    before(true); data.columns.splice(data.columns.indexOf(column), 1);
    data.rows.forEach(row => { delete row.cells[column.id]; });
    if (data.sort?.columnId === column.id) data.sort = null;
    render(); commit(); title.focus();
  }

  async function editRecord(existing?: Row, defaults: Record<string, Cell> = {}) {
    const row = existing ?? newRow(data.columns);
    if (!existing) for (const column of data.columns) if (Object.hasOwn(defaults, column.id)) row.cells[column.id] = cellValue(defaults[column.id], column.type);
    const result = await recordDialog(data, row, !!existing);
    if (!result || !block.isConnected || (existing && !data.rows.includes(existing))) return;
    before(true);
    if (result === 'delete') data.rows.splice(data.rows.indexOf(row), 1);
    else if (existing) existing.cells = result.cells;
    else { data.rows.push(result); data.filter = ''; filter.value = ''; }
    renderContent(); commit(); addRow.focus({ preventScroll: true });
  }

  filter.oninput = () => { before(); data.filter = filter.value; renderContent(); commit(); };
  clearSort.onclick = () => { before(true); data.sort = null; render(); commit(); filter.focus(); };
  addRow.onclick = () => {
    if (data.view !== 'table') { void editRecord(); return; }
    before(true); const row = newRow(data.columns); data.rows.push(row); data.filter = ''; filter.value = '';
    renderContent(); commit();
    const target = Array.from(body.rows).find(element => element.dataset.rowId === row.id);
    target?.querySelector<HTMLElement>('input,select')?.focus();
  };
  more.onclick = () => {
    const bounds = more.getBoundingClientRect();
    showMenu(bounds.right - 210, bounds.bottom + 5, [
      { label: 'Add property', icon: 'plus', action: () => void editProperty() },
      { label: 'Delete database', icon: 'trash', danger: true, action: () => void removeDatabase() },
    ], more, 'Database actions');
  };
  async function removeDatabase() {
    const result = await askDialog({ title: `Delete “${data.title || 'Untitled database'}”?`, description: 'This removes the database and all its rows from this note.', submit: 'Delete database', danger: true });
    const parent = block.parentElement;
    if (!result || !parent || !block.isConnected) return;
    before(true); block.remove(); parent.dispatchEvent(new CustomEvent('databasechange', { bubbles: true })); parent.focus();
  }
  render();
}

export function createDatabaseBlock(data: NoteDatabase): HTMLElement {
  const block = el('section', 'database-block'); block.dataset.database = JSON.stringify(data);
  bindDatabase(block, data); return block;
}

export function hydrateDatabases(root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>('.database-block')) {
    if (bound.has(block)) continue;
    const data = readDatabase(block.dataset.database ?? '');
    if (data) bindDatabase(block, data);
  }
}
