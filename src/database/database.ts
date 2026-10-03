import { button, el } from '../ui/dom';
import { icon } from '../ui/icons';
import { showMenu, type MenuItem } from '../ui/menu';
import { askDialog } from '../ui/dialog';
import { animateOut } from '../ui/motion';
import { activeView, columnWidth, createSavedView, duplicateRows, optionColor, optionPalette, saveActiveView, switchView, removeRows, updateRows, visibleColumns, cellValue, columnTypes, newRow, readDatabase, resolveViewColumns, visibleRows, type Cell, type Column, type ColumnType, type DatabaseView, type NoteDatabase, type Row } from './model';
import { calendarView, kanbanView, recordTitle, type ViewActions } from './views';

const bound = new WeakSet<HTMLElement>();
const badges: Record<ColumnType, string> = { text: 'T', number: '#', select: '⌄', date: '◷', checkbox: '✓' };

interface PropertyDraft extends Omit<Column, 'id'> { optionRenames: Record<string, string>; }

function propertyDialog(column?: Column, preferredType: ColumnType = 'text'): Promise<PropertyDraft | null> {
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
    const optionsLabel = el('div', 'database-option-editor');
    optionsLabel.append(el('p', 'field-label', 'Select options'));
    const optionList = el('div', 'database-option-list');
    const optionInputs: HTMLInputElement[] = [];
    const originalNames = new Map<HTMLInputElement, string>();
    const optionColors = new Map<HTMLInputElement, HTMLSelectElement>();
    const optionEntry = el('div', 'database-option-entry');
    const options = el('input', 'field-input'); options.placeholder = 'Add an option…'; options.maxLength = 200;
    options.setAttribute('aria-label', 'New select option');
    const addOption = button('Add select option', 'database-properties-add'); addOption.append(icon('plus'));
    function updateOptionOrder() {
      Array.from(optionList.children).forEach((row, index) => {
        const up = row.querySelector<HTMLButtonElement>('[data-move="up"]');
        const down = row.querySelector<HTMLButtonElement>('[data-move="down"]');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === optionInputs.length - 1;
      });
    }
    function addOptionRow(value: string) {
      const row = el('div', 'database-option-row');
      const input = el('input', 'field-input'); input.value = value; input.maxLength = 200;
      input.setAttribute('aria-label', 'Select option'); originalNames.set(input, value);
      const color = el('select', 'database-option-color'); color.setAttribute('aria-label', `Color for ${value}`);
      for (const [id, hex] of Object.entries(optionPalette)) {
        const option = el('option', '', id[0].toUpperCase() + id.slice(1)); option.value = id; option.style.color = hex; color.append(option);
      }
      color.value = optionColor(column ?? { id: '', name: '', type: 'select', options: [] }, value);
      const paint = () => { color.style.setProperty('--option-color', optionPalette[color.value as keyof typeof optionPalette]); };
      color.onchange = paint; paint(); optionColors.set(input, color);
      const remove = button(`Remove option ${value}`, 'database-property-delete'); remove.append(icon('close'));
      input.oninput = () => { options.setCustomValidity(''); remove.setAttribute('aria-label', `Remove option ${input.value}`); color.setAttribute('aria-label', `Color for ${input.value}`); };
      remove.onclick = () => { optionInputs.splice(optionInputs.indexOf(input), 1); row.remove(); updateOptionOrder(); options.setCustomValidity(''); options.focus(); };
      optionInputs.push(input); row.append(input, color);
      for (const direction of [-1, 1]) {
        const action = direction < 0 ? 'up' : 'down';
        const move = button(`Move option ${value} ${action}`, `database-property-move is-${action}`); move.dataset.move = action; move.append(icon('arrow'));
        move.onclick = () => {
          const index = optionInputs.indexOf(input), next = index + direction;
          if (next < 0 || next >= optionInputs.length) return;
          const neighbor = optionList.children[next];
          if (direction < 0) neighbor.before(row); else neighbor.after(row);
          [optionInputs[index], optionInputs[next]] = [optionInputs[next], optionInputs[index]];
          updateOptionOrder(); move.focus();
        };
        row.append(move);
      }
      row.append(remove); optionList.append(row); updateOptionOrder();
    }
    const initialOptions = column?.options ?? (preferredType === 'select' ? ['Not started', 'In progress', 'Done'] : []);
    initialOptions.forEach(addOptionRow);
    function appendOption() {
      const value = options.value.trim();
      if (!value) return;
      if (optionInputs.some(input => input.value.trim() === value)) {
        options.setCustomValidity('This option already exists.'); options.reportValidity(); return;
      }
      addOptionRow(value); options.value = ''; options.setCustomValidity(''); options.focus();
    }
    addOption.onclick = appendOption;
    options.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); appendOption(); } };
    options.oninput = () => options.setCustomValidity('');
    optionEntry.append(options, addOption); optionsLabel.append(optionList, optionEntry);
    const updateOptions = () => { optionsLabel.hidden = type.value !== 'select'; if (type.value !== 'select') options.setCustomValidity(''); };
    type.onchange = updateOptions; updateOptions();
    name.oninput = () => name.setCustomValidity('');
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', 'button-secondary'); cancel.textContent = 'Cancel';
    const submit = el('button', 'button-primary', column ? 'Save changes' : 'Add property'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(nameLabel, typeLabel, optionsLabel, actions); dialog.append(form);
    let result: PropertyDraft | null = null;
    let closing = false;
    const finish = async () => { if (closing) return; closing = true; await animateOut(dialog); dialog.close(); };
    form.onsubmit = event => {
      event.preventDefault();
      const rawValues = [...optionInputs.map(input => input.value), options.value].map(value => value.trim()).filter(Boolean);
      const values = [...new Set(rawValues)];
      if (type.value === 'select' && values.length !== rawValues.length) { options.setCustomValidity('Option names must be unique.'); options.reportValidity(); return; }
      const colors: Record<string, string> = Object.create(null), renames: Record<string, string> = Object.create(null);
      optionInputs.forEach(input => {
        const value = input.value.trim(); if (!value) return;
        colors[value] = optionColors.get(input)!.value;
        const original = originalNames.get(input)!;
        if (column?.options.includes(original) && original !== value) renames[original] = value;
      });
      if (!name.value.trim()) { name.setCustomValidity('Enter a property name.'); name.reportValidity(); return; }
      if (type.value === 'select' && !values.length) { options.setCustomValidity('Enter at least one option.'); options.reportValidity(); return; }
      result = { name: name.value.trim(), type: type.value as ColumnType, options: type.value === 'select' ? values : [], optionColors: type.value === 'select' ? colors : {}, optionRenames: type.value === 'select' ? renames : {} }; void finish();
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
    values.forEach(value => { const option = el('option', '', value); option.value = value; option.style.color = optionPalette[optionColor(column, value)]; field.append(option); });
    field.value = String(value ?? '');
    field.classList.add('database-select-value');
    const paint = () => { field.style.setProperty('--option-color', optionPalette[optionColor(column, field.value)]); };
    field.addEventListener('change', paint); paint(); return field;
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

function bulkPropertyDialog(columns: Column[], count: number): Promise<{ columnId: string; value: Cell } | null> {
  return new Promise(resolve => {
    const dialog = el('dialog', 'dialog'), form = el('form');
    const heading = el('h2', '', `Edit ${count} selected records`); heading.id = `bulk-edit-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby', heading.id);
    const header = el('div', 'dialog-header'); const close = button('Close bulk edit'); close.append(icon('close')); header.append(heading, close);
    const label = el('label', 'field-label', 'Property'); const property = el('select', 'field-input');
    columns.forEach(column => { const option = el('option', '', column.name); option.value = column.id; property.append(option); }); label.append(property);
    const valueLabel = el('label', 'field-label', 'New value');
    let field: HTMLInputElement | HTMLSelectElement;
    const renderField = () => {
      const column = columns.find(item => item.id === property.value)!;
      field = cellField(column, cellValue('', column.type), 'field-input'); field.setAttribute('aria-label', 'New value');
      valueLabel.replaceChildren(document.createTextNode('New value'), field);
    };
    property.onchange = renderField; renderField();
    const actions = el('div', 'dialog-actions'); const cancel = button('Cancel', 'button-secondary'); cancel.textContent = 'Cancel';
    const apply = el('button', 'button-primary', 'Apply to selected'); apply.type = 'submit'; actions.append(cancel, apply);
    form.append(header, el('p', 'dialog-description', 'Only this property will change. All other values stay as they are.'), label, valueLabel, actions); dialog.append(form);
    let result: { columnId: string; value: Cell } | null = null, closing = false;
    const finish = async () => { if (closing) return; closing = true; await animateOut(dialog); dialog.close(); };
    form.onsubmit = event => { event.preventDefault(); const column = columns.find(item => item.id === property.value)!; result = { columnId: column.id, value: fieldValue(field, column) }; void finish(); };
    close.onclick = cancel.onclick = () => void finish();
    dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal(); property.focus();
  });
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
    saveActiveView(data);
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
  const tabs = el('div', 'database-view-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'View layout');
  const viewButtons = new Map<DatabaseView, HTMLButtonElement>();
  for (const view of ['table', 'kanban', 'calendar'] as const) {
    const trigger = button(`${view[0].toUpperCase()}${view.slice(1)} view`, 'database-view-tab');
    trigger.append(icon(view), el('span', '', `${view[0].toUpperCase()}${view.slice(1)}`));
    trigger.onclick = () => { if (data.view === view) return; before(true); selectedRows.clear(); data.view = view; render(); commit(); trigger.focus(); };
    viewButtons.set(view, trigger); tabs.append(trigger);
  }
  const selectedRows = new Set<string>();
  const savedViews = el('div', 'database-saved-views');
  const viewLabel = el('label', 'database-property-picker', 'View');
  const viewSelect = el('select'); viewSelect.setAttribute('aria-label', 'Saved database view'); viewLabel.append(viewSelect);
  const addView = button('Create saved view', 'database-properties-add'); addView.append(icon('plus'), el('span', '', 'New view'));
  const renameView = button('Rename saved view', 'database-config-edit'); renameView.append(icon('edit'));
  const deleteView = button('Delete saved view', 'database-property-delete'); deleteView.append(icon('trash'));
  savedViews.append(viewLabel, addView, renameView, deleteView);
  viewSelect.onchange = () => { before(true); selectedRows.clear(); switchView(data, viewSelect.value); render(); commit(); viewSelect.focus(); };
  addView.onclick = async () => {
    const result = await askDialog({ title: 'Create a saved view', description: 'Start with the current layout, filters, sorting, and columns. Changes to this view will be saved automatically.', fields: [{ name: 'name', label: 'View name', placeholder: 'All tasks, This week, Completed…' }], submit: 'Create view' });
    if (!result || !block.isConnected) return;
    before(true); saveActiveView(data);
    const name = uniqueViewName(result.name);
    const view = createSavedView(data, name); data.views.push(view); switchView(data, view.id); selectedRows.clear(); render(); commit(); viewSelect.focus();
  };
  renameView.onclick = async () => {
    const view = activeView(data);
    const result = await askDialog({ title: 'Rename view', fields: [{ name: 'name', label: 'View name', value: view.name }], submit: 'Rename' });
    if (!result || !block.isConnected) return;
    before(true); view.name = uniqueViewName(result.name, view.id); renderSavedViews(); commit(); renameView.focus();
  };
  deleteView.onclick = async () => {
    if (data.views.length <= 1) return;
    const view = activeView(data);
    const result = await askDialog({ title: `Delete “${view.name}” view?`, description: 'This removes only the view settings. All records and properties stay in the database.', submit: 'Delete view', danger: true });
    if (!result || !block.isConnected || data.views.length <= 1) return;
    before(true); switchView(data, data.views.find(item => item.id !== view.id)!.id); data.views = data.views.filter(item => item.id !== view.id);
    selectedRows.clear(); render(); commit(); viewSelect.focus();
  };
  const viewFilters = el('div', 'database-saved-filters');
  const selectionBar = el('div', 'database-selection-bar');
  const selectAll = el('input', 'database-record-select'); selectAll.type = 'checkbox'; selectAll.setAttribute('aria-label', 'Select all matching records');
  selectAll.onchange = () => { visibleRows(data).forEach(row => selectAll.checked ? selectedRows.add(row.id) : selectedRows.delete(row.id)); updateSelection(); };
  const selectionCount = el('span', 'database-selection-count'); selectionCount.setAttribute('aria-live', 'polite');
  const bulkEdit = button('Edit selected records', 'database-properties-add'); bulkEdit.textContent = 'Edit';
  const bulkDuplicate = button('Duplicate selected records', 'database-properties-add'); bulkDuplicate.textContent = 'Duplicate';
  const bulkDelete = button('Delete selected records', 'database-bulk-delete'); bulkDelete.textContent = 'Delete';
  const clearSelection = button('Clear record selection', 'database-config-edit'); clearSelection.append(icon('close'));
  clearSelection.onclick = () => { selectedRows.clear(); updateSelection(); selectAll.focus(); };
  bulkDuplicate.onclick = () => { before(true); const copies = duplicateRows(data, selectedRows); selectedRows.clear(); copies.forEach(row => selectedRows.add(row.id)); renderContent(); commit(); bulkDuplicate.focus(); };
  bulkEdit.onclick = () => void editSelectedRecords();
  bulkDelete.onclick = async () => {
    const ids = new Set(selectedRows);
    if (!ids.size) return;
    const result = await askDialog({ title: `Delete ${ids.size} selected ${ids.size === 1 ? 'record' : 'records'}?`, description: 'The selected records will be removed from this database. You can undo this change in the editor.', submit: 'Delete records', danger: true });
    if (!result || !block.isConnected) return;
    before(true); removeRows(data, ids); selectedRows.clear(); renderContent(); commit(); selectAll.focus();
  };
  selectionBar.append(selectAll, selectionCount, bulkEdit, bulkDuplicate, bulkDelete, clearSelection);
  const toolbar = el('div', 'database-toolbar');
  const search = el('div', 'database-filter'); search.append(icon('search'));
  const filter = el('input'); filter.type = 'search'; filter.placeholder = 'Filter rows…'; filter.value = data.filter; filter.setAttribute('aria-label', 'Filter database rows'); search.append(filter);
  const clearSort = button('Clear database sorting', 'database-sort-clear');
  clearSort.append(icon('close'), el('span', '', 'Clear sort')); clearSort.hidden = !data.sort;
  const propertiesButton = button('Manage database properties', 'database-properties-button');
  propertiesButton.append(icon('settings'), el('span', '', 'Properties'));
  propertiesButton.setAttribute('aria-expanded', 'false');
  toolbar.append(search, clearSort, propertiesButton);
  let propertiesOpen = false;
  const propertiesPanel = el('div', 'database-properties-panel');
  propertiesPanel.id = `properties-${crypto.randomUUID()}`;
  propertiesPanel.hidden = true;
  propertiesPanel.setAttribute('role', 'region');
  propertiesPanel.setAttribute('aria-label', 'Database properties');
  propertiesButton.setAttribute('aria-controls', propertiesPanel.id);
  propertiesButton.onclick = () => {
    propertiesOpen = !propertiesOpen;
    renderProperties();
  };
  propertiesPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); propertiesOpen = false; renderProperties(); propertiesButton.focus();
    }
  });
  const configuration = el('div', 'database-view-config');
  const wrapper = el('div', 'database-table-wrap');
  const table = el('table', 'database-table'); table.setAttribute('aria-label', data.title || 'Database');
  const colgroup = el('colgroup');
  const head = el('thead'), body = el('tbody'); table.append(colgroup, head, body); wrapper.append(table);
  const viewHost = el('div', 'database-view-content');
  const footer = el('div', 'database-footer');
  const addRow = button('Add database row', 'database-add-row'); addRow.append(icon('plus'), el('span', '', 'New row'));
  const count = el('span', 'database-row-count'); count.setAttribute('aria-live', 'polite'); footer.append(addRow, count);
  block.append(header, savedViews, tabs, toolbar, viewFilters, selectionBar, propertiesPanel, configuration, wrapper, viewHost, footer);

  const actions: ViewActions = {
    selectedRows,
    selectRow: (row, selected) => { if (selected) selectedRows.add(row.id); else selectedRows.delete(row.id); updateSelection(); },
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

  function uniqueViewName(name: string, ignoreId?: string) {
    const base = name.trim().slice(0, 80) || 'Untitled view'; let result = base;
    for (let suffix = 2; data.views.some(view => view.id !== ignoreId && view.name.toLowerCase() === result.toLowerCase()); suffix++) result = `${base} ${suffix}`;
    return result;
  }

  function renderSavedViews() {
    viewSelect.replaceChildren();
    data.views.forEach(view => { const option = el('option', '', view.name); option.value = view.id; viewSelect.append(option); });
    viewSelect.value = data.activeViewId; deleteView.disabled = data.views.length <= 1;
  }

  function renderViewFilters() {
    viewFilters.replaceChildren();
    const view = activeView(data);
    const conditionLabel = el('label', 'database-property-picker', 'Where');
    const property = el('select'); property.setAttribute('aria-label', 'Filter property');
    const all = el('option', '', 'All records'); all.value = ''; property.append(all);
    data.columns.forEach(column => { const option = el('option', '', column.name); option.value = column.id; property.append(option); });
    property.value = view.condition?.columnId ?? '';
    property.onchange = () => { before(true); selectedRows.clear(); view.condition = property.value ? { columnId: property.value, value: String(cellValue('', data.columns.find(column => column.id === property.value)!.type) ?? '') } : null; renderViewFilters(); renderContent(); commit(); };
    conditionLabel.append(property); viewFilters.append(conditionLabel);
    const column = data.columns.find(item => item.id === view.condition?.columnId);
    if (column && view.condition) {
      viewFilters.append(el('span', 'database-filter-is', 'is'));
      const field = cellField(column, cellValue(view.condition.value, column.type), 'database-condition-value');
      field.setAttribute('aria-label', 'Filter value');
      field.oninput = () => { before(); selectedRows.clear(); view.condition = { columnId: column.id, value: String(fieldValue(field, column) ?? '') }; renderContent(); commit(); };
      viewFilters.append(field);
    }
    const sortLabel = el('label', 'database-property-picker', 'Sort');
    const sort = el('select'); sort.setAttribute('aria-label', 'Sort property');
    const none = el('option', '', 'No sorting'); none.value = ''; sort.append(none);
    data.columns.forEach(column => { const option = el('option', '', column.name); option.value = column.id; sort.append(option); });
    sort.value = data.sort?.columnId ?? '';
    sort.onchange = () => { before(true); data.sort = sort.value ? { columnId: sort.value, direction: 'asc' } : null; render(); commit(); };
    sortLabel.append(sort); viewFilters.append(sortLabel);
    if (data.sort) {
      const direction = button('Toggle sort direction', 'database-properties-add'); direction.textContent = data.sort.direction === 'asc' ? '↑ Ascending' : '↓ Descending';
      direction.onclick = () => { before(true); if (data.sort) data.sort.direction = data.sort.direction === 'asc' ? 'desc' : 'asc'; render(); commit(); }; viewFilters.append(direction);
    }
  }

  function updateSelection() {
    for (const id of selectedRows) if (!data.rows.some(row => row.id === id)) selectedRows.delete(id);
    const rows = visibleRows(data), matching = rows.filter(row => selectedRows.has(row.id)).length;
    selectAll.checked = !!rows.length && matching === rows.length; selectAll.indeterminate = matching > 0 && matching < rows.length; selectAll.disabled = !rows.length;
    const headerCheck = head.querySelector<HTMLInputElement>('.database-record-select');
    if (headerCheck) { headerCheck.checked = selectAll.checked; headerCheck.indeterminate = selectAll.indeterminate; headerCheck.disabled = selectAll.disabled; }
    block.querySelectorAll<HTMLInputElement>('[data-selection-id]').forEach(control => {
      control.checked = selectedRows.has(control.dataset.selectionId!);
      control.closest('[data-row-id]')?.classList.toggle('is-selected', control.checked);
    });
    selectionCount.textContent = selectedRows.size ? `${selectedRows.size} selected` : 'Select records';
    for (const control of [bulkEdit, bulkDuplicate, bulkDelete, clearSelection]) control.hidden = !selectedRows.size;
  }

  async function editSelectedRecords() {
    const ids = new Set(selectedRows); if (!ids.size) return;
    const result = await bulkPropertyDialog(data.columns, ids.size);
    if (!result || !block.isConnected) return;
    before(true); updateRows(data, ids, result.columnId, result.value); renderContent(); commit(); bulkEdit.focus();
  }

  function renderRows() {
    const rows = visibleRows(data); body.replaceChildren();
    if (!rows.length) {
      const row = el('tr'), cell = el('td', 'database-empty', data.filter.trim() ? 'No rows match your filter.' : 'Your table is ready. Add your first row.');
      cell.colSpan = visibleColumns(data).length + 3; row.append(cell); body.append(row); return;
    }
    for (const row of rows) {
      const tr = el('tr'); tr.dataset.rowId = row.id;
      const selection = el('td', 'database-selection-cell');
      const checkbox = el('input', 'database-record-select'); checkbox.type = 'checkbox'; checkbox.checked = selectedRows.has(row.id);
      checkbox.dataset.selectionId = row.id; checkbox.setAttribute('aria-label', `Select ${recordTitle(data, row)}`);
      checkbox.onchange = () => actions.selectRow(row, checkbox.checked); selection.append(checkbox); tr.append(selection);
      tr.classList.toggle('is-selected', selectedRows.has(row.id));
      for (const column of visibleColumns(data)) {
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
      const rowActions = el('td', 'database-row-actions');
      const remove = button(`Delete row ${data.rows.indexOf(row) + 1}`, 'database-row-remove'); remove.append(icon('trash'));
      remove.onclick = () => { before(true); data.rows.splice(data.rows.indexOf(row), 1); selectedRows.delete(row.id); renderContent(); commit(); addRow.focus(); };
      rowActions.append(remove); tr.append(rowActions); body.append(tr);
    }
  }

  function focusProperty(id: string, action = 'edit') {
    const row = Array.from(propertiesPanel.querySelectorAll<HTMLElement>('[data-property-id]')).find(item => item.dataset.propertyId === id);
    const control = row?.querySelector<HTMLButtonElement>(`[data-action='${action}']`);
    (control && !control.disabled ? control : row?.querySelector<HTMLButtonElement>("[data-action='edit']") ?? propertiesButton).focus({ preventScroll: true });
  }

  function renderProperties() {
    propertiesButton.setAttribute('aria-expanded', String(propertiesOpen));
    propertiesPanel.hidden = !propertiesOpen;
    propertiesPanel.replaceChildren();
    if (!propertiesOpen) return;
    const heading = el('div', 'database-properties-heading');
    heading.append(el('span', '', `Properties · ${data.columns.length}`));
    const add = button('Add property', 'database-properties-add');
    add.append(icon('plus'), el('span', '', 'Add property'));
    add.onclick = () => void editProperty();
    heading.append(add);
    propertiesPanel.append(heading, el('p', 'database-properties-hint', 'Visibility and widths belong to this view. Property names, types, and order apply to every view.'));
    data.columns.forEach((column, index) => {
      const row = el('div', 'database-property-row'); row.dataset.propertyId = column.id;
      const edit = button(`Edit ${column.name} property`, 'database-property-edit'); edit.dataset.action = 'edit';
      const details = el('span', 'database-property-details');
      details.append(el('span', 'database-property-name', column.name), el('span', 'database-property-type', `${columnTypes[column.type]}${column.type === 'select' ? ` · ${column.options.length} options` : ''}`));
      edit.append(el('span', 'database-type-badge', badges[column.type]), details, icon('edit'));
      edit.onclick = () => void editProperty(column);
      row.append(edit);
      const visibility = el('input', 'database-property-visibility'); visibility.type = 'checkbox';
      visibility.checked = !activeView(data).hiddenColumnIds.includes(column.id);
      visibility.setAttribute('aria-label', `Show ${column.name} in this view`);
      visibility.title = 'Show in this view';
      visibility.disabled = visibility.checked && visibleColumns(data).length === 1;
      visibility.onchange = () => {
        before(true); const view = activeView(data);
        view.hiddenColumnIds = visibility.checked ? view.hiddenColumnIds.filter(id => id !== column.id) : [...view.hiddenColumnIds, column.id];
        render(); commit(); focusProperty(column.id);
      };
      row.append(visibility);
      if (data.view === 'table') {
        const width = el('input', 'database-property-width'); width.type = 'number'; width.min = '100'; width.max = '600'; width.step = '10'; width.value = String(columnWidth(data, column.id));
        width.setAttribute('aria-label', `${column.name} column width`); width.title = 'Column width in pixels';
        width.onchange = () => { before(true); activeView(data).columnWidths[column.id] = Math.min(600, Math.max(100, Number(width.value) || 180)); render(); commit(); focusProperty(column.id); };
        row.append(width);
      }
      for (const direction of [-1, 1]) {
        const action = direction < 0 ? 'up' : 'down';
        const move = button(`Move ${column.name} ${action}`, `database-property-move is-${action}`); move.dataset.action = action;
        move.append(icon('arrow')); move.disabled = index + direction < 0 || index + direction >= data.columns.length;
        move.onclick = () => {
          const current = data.columns.indexOf(column);
          if (current < 0 || current + direction < 0 || current + direction >= data.columns.length) return;
          before(true);
          [data.columns[current], data.columns[current + direction]] = [data.columns[current + direction], data.columns[current]];
          render(); commit(); focusProperty(column.id, action);
        };
        row.append(move);
      }
      const remove = button(`Delete ${column.name} property`, 'database-property-delete'); remove.append(icon('trash'));
      remove.disabled = data.columns.length === 1;
      if (remove.disabled) remove.title = 'Keep at least one property';
      remove.onclick = () => void deleteProperty(column);
      row.append(remove); propertiesPanel.append(row);
    });
  }

  function renderColumns() {
    head.replaceChildren(); colgroup.replaceChildren();
    const selectionCol = el('col'); selectionCol.style.width = '38px'; colgroup.append(selectionCol);
    const row = el('tr');
    const selectionHead = el('th', 'database-selection-cell'); selectionHead.scope = 'col';
    const all = el('input', 'database-record-select'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all table records');
    all.onchange = () => { visibleRows(data).forEach(item => all.checked ? selectedRows.add(item.id) : selectedRows.delete(item.id)); updateSelection(); }; selectionHead.append(all); row.append(selectionHead);
    for (const column of visibleColumns(data)) {
      const col = el('col'); col.dataset.columnId = column.id; col.style.width = `${columnWidth(data, column.id)}px`; colgroup.append(col);
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
      const resize = el('button', 'database-column-resize'); resize.type = 'button'; resize.setAttribute('role', 'separator'); resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('aria-label', `Resize ${column.name} column`);
      resize.setAttribute('aria-valuemin', '100'); resize.setAttribute('aria-valuemax', '600'); resize.setAttribute('aria-valuenow', String(columnWidth(data, column.id)));
      const setWidth = (width: number) => {
        const next = Math.min(600, Math.max(100, width)); activeView(data).columnWidths[column.id] = next;
        col.style.width = `${next}px`; resize.setAttribute('aria-valuenow', String(next)); updateTableWidth();
      };
      resize.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); before(true);
        setWidth(event.key === 'Home' ? 100 : event.key === 'End' ? 600 : columnWidth(data, column.id) + (event.key === 'ArrowLeft' ? -20 : 20)); commit(); renderProperties();
      };
      resize.ondblclick = () => { before(true); setWidth(180); commit(); renderProperties(); };
      resize.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault(); before(true); const start = event.clientX, width = columnWidth(data, column.id); resize.setPointerCapture(event.pointerId);
        resize.onpointermove = move => setWidth(width + move.clientX - start);
        const finish = (cancelled: boolean) => {
          resize.onpointermove = null; resize.onpointerup = null; resize.onpointercancel = null;
          if (cancelled) setWidth(width);
          if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
          commit(); renderProperties();
        };
        resize.onpointerup = () => finish(false); resize.onpointercancel = () => finish(true);
      };
      th.append(trigger, resize); row.append(th);
    }
    const add = el('th'); add.scope = 'col'; add.className = 'database-spacer';
    const addProperty = button('Add database property', 'database-add-property'); addProperty.append(icon('plus')); addProperty.onclick = () => void editProperty(); add.append(addProperty);
    row.append(add, el('th', 'database-row-actions')); head.append(row);
    for (let index = 0; index < 2; index++) { const col = el('col'); col.style.width = '40px'; colgroup.append(col); }
    updateTableWidth();
  }

  function updateTableWidth() { table.style.width = `${visibleColumns(data).reduce((total, column) => total + columnWidth(data, column.id), 118)}px`; }

  function renderContent() {
    const rows = visibleRows(data);
    count.textContent = `${rows.length}${data.filter.trim() || activeView(data).condition ? ` of ${data.rows.length}` : ''} ${rows.length === 1 ? 'record' : 'records'}`;
    if (data.view === 'table') renderRows();
    else {
      const scroll = viewHost.querySelector('.database-board')?.scrollLeft ?? 0;
      const view = data.view === 'kanban' ? kanbanView(data, rows, actions) : calendarView(data, rows, actions);
      viewHost.replaceChildren(view); if (data.view === 'kanban') view.scrollLeft = scroll;
    }
    updateSelection();
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
    filter.value = data.filter;
    renderSavedViews(); renderViewFilters();
    for (const [view, trigger] of viewButtons) trigger.setAttribute('aria-pressed', String(data.view === view));
    wrapper.hidden = data.view !== 'table'; viewHost.hidden = data.view === 'table';
    addRow.replaceChildren(icon('plus'), el('span', '', data.view === 'table' ? 'New row' : 'New record'));
    renderConfiguration(); renderColumns(); renderContent(); renderProperties();
  }

  body.addEventListener('focusout', () => requestAnimationFrame(() => {
    if (block.isConnected && data.view === 'table' && !body.contains(document.activeElement) && (data.sort || data.filter.trim())) renderContent();
  }));

  async function editProperty(column?: Column, preferredType: ColumnType = 'text') {
    const result = await propertyDialog(column, preferredType);
    if (!result || !block.isConnected) return;
    before(true);
    const { optionRenames, ...property } = result;
    if (column) {
      if (column.type === 'select' && property.type === 'select') {
        data.rows.forEach(row => { const value = String(row.cells[column.id] ?? ''); if (Object.hasOwn(optionRenames, value)) row.cells[column.id] = optionRenames[value]; });
        data.views.forEach(view => { if (view.condition?.columnId === column.id && Object.hasOwn(optionRenames, view.condition.value)) view.condition.value = optionRenames[view.condition.value]; });
      }
      Object.assign(column, property);
      data.views.forEach(view => { if (view.condition?.columnId === column.id) view.condition.value = String(cellValue(view.condition.value, column.type) ?? ''); });
      data.rows.forEach(row => { row.cells[column.id] = cellValue(row.cells[column.id], column.type); });
    } else {
      const added = { ...property, id: crypto.randomUUID() }; data.columns.push(added);
      data.rows.forEach(row => { row.cells[added.id] = cellValue('', added.type); });
    }
    render(); commit();
    if (propertiesOpen) { focusProperty(column?.id ?? data.columns[data.columns.length - 1].id); return; }
    if (!column && data.view === 'table') wrapper.scrollLeft = wrapper.scrollWidth;
    (data.view === 'table' && !column ? head.querySelector<HTMLButtonElement>('.database-add-property') : viewButtons.get(data.view))?.focus({ preventScroll: true });
  }

  async function deleteProperty(column: Column) {
    if (data.columns.length <= 1 || !data.columns.includes(column)) return;
    const result = await askDialog({ title: `Delete “${column.name}”?`, description: 'This removes the property and its cell values from every row.', submit: 'Delete property', danger: true });
    if (!result || !block.isConnected || data.columns.length <= 1 || !data.columns.includes(column)) return;
    before(true); data.columns.splice(data.columns.indexOf(column), 1);
    data.rows.forEach(row => { delete row.cells[column.id]; });
    if (data.sort?.columnId === column.id) data.sort = null;
    data.views.forEach(view => {
      view.hiddenColumnIds = view.hiddenColumnIds.filter(id => id !== column.id);
      if (view.hiddenColumnIds.length === data.columns.length) view.hiddenColumnIds = view.hiddenColumnIds.filter(id => id !== data.columns[0].id);
      delete view.columnWidths[column.id];
      if (view.sort?.columnId === column.id) view.sort = null;
      if (view.condition?.columnId === column.id) view.condition = null;
    });
    render(); commit();
    if (propertiesOpen) focusProperty(data.columns[0].id); else title.focus();
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

  filter.oninput = () => { before(); selectedRows.clear(); data.filter = filter.value; renderContent(); commit(); };
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
