export const columnTypes = { text: 'Text', number: 'Number', select: 'Select', date: 'Date', checkbox: 'Checkbox' } as const;
export type ColumnType = keyof typeof columnTypes;
export type Cell = string | number | boolean | null;
export interface Column { id: string; name: string; type: ColumnType; options: string[]; optionColors?: Record<string, string>; }
export interface Row { id: string; cells: Record<string, Cell>; }
export type DatabaseView = 'table' | 'kanban' | 'calendar';
export const optionPalette = { gray: '#91a2b4', yellow: '#d8bd80', blue: '#8bb9e0', green: '#92c7a5', purple: '#bea4df', pink: '#dfa4c4', red: '#e6a19f', orange: '#dca77f' } as const;
export type OptionColor = keyof typeof optionPalette;
export interface SavedView {
  id: string;
  name: string;
  layout: DatabaseView;
  filter: string;
  sort: NoteDatabase['sort'];
  hiddenColumnIds: string[];
  columnWidths: Record<string, number>;
  calendarColumnId: string | null;
  boardColumnId: string | null;
  calendarMonth: string;
  condition: { columnId: string; value: string } | null;
}
export interface NoteDatabase {
  version: 1;
  title: string;
  columns: Column[];
  rows: Row[];
  filter: string;
  sort: { columnId: string; direction: 'asc' | 'desc' } | null;
  view: DatabaseView;
  calendarColumnId: string | null;
  boardColumnId: string | null;
  calendarMonth: string;
  views: SavedView[];
  activeViewId: string;
}

export function optionColor(column: Column, value: string): OptionColor {
  const color = column.optionColors?.[value];
  if (color && Object.hasOwn(optionPalette, color)) return color as OptionColor;
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return value ? (Object.keys(optionPalette) as OptionColor[])[hash % Object.keys(optionPalette).length] : 'gray';
}

export function activeView(data: NoteDatabase): SavedView {
  return data.views.find(view => view.id === data.activeViewId) ?? data.views[0];
}

export function createSavedView(data: NoteDatabase, name: string, layout = data.view): SavedView {
  const current = data.views?.length ? activeView(data) : null;
  return { id: crypto.randomUUID(), name, layout, filter: data.filter, sort: data.sort ? { ...data.sort } : null,
    hiddenColumnIds: [...(current?.hiddenColumnIds ?? [])], columnWidths: { ...(current?.columnWidths ?? {}) },
    calendarColumnId: data.calendarColumnId, boardColumnId: data.boardColumnId, calendarMonth: data.calendarMonth,
    condition: current?.condition ? { ...current.condition } : null };
}

export function saveActiveView(data: NoteDatabase) {
  const view = activeView(data);
  Object.assign(view, { layout: data.view, filter: data.filter, sort: data.sort ? { ...data.sort } : null,
    calendarColumnId: data.calendarColumnId, boardColumnId: data.boardColumnId, calendarMonth: data.calendarMonth });
}

export function switchView(data: NoteDatabase, id: string) {
  const view = data.views.find(item => item.id === id);
  if (!view) return;
  saveActiveView(data);
  data.activeViewId = id;
  Object.assign(data, { view: view.layout, filter: view.filter, sort: view.sort ? { ...view.sort } : null,
    calendarColumnId: view.calendarColumnId, boardColumnId: view.boardColumnId, calendarMonth: view.calendarMonth });
  resolveViewColumns(data);
}

export function visibleColumns(data: NoteDatabase): Column[] {
  const hidden = new Set(activeView(data).hiddenColumnIds);
  return data.columns.filter(column => !hidden.has(column.id));
}

export function columnWidth(data: NoteDatabase, id: string): number {
  return Math.min(600, Math.max(100, activeView(data).columnWidths[id] ?? 180));
}

export function duplicateRows(data: NoteDatabase, ids: Set<string>): Row[] {
  const copies = data.rows.filter(row => ids.has(row.id)).map(row => ({ id: crypto.randomUUID(), cells: { ...row.cells } }));
  data.rows.push(...copies);
  return copies;
}

export function removeRows(data: NoteDatabase, ids: Set<string>) {
  data.rows = data.rows.filter(row => !ids.has(row.id));
}

export function updateRows(data: NoteDatabase, ids: Set<string>, columnId: string, value: Cell) {
  const column = data.columns.find(item => item.id === columnId);
  if (!column) return;
  data.rows.forEach(row => { if (ids.has(row.id)) row.cells[columnId] = cellValue(value, column.type); });
}

export function monthKey(date = new Date()): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function resolveViewColumns(data: NoteDatabase) {
  for (const [key, type] of [['calendarColumnId', 'date'], ['boardColumnId', 'select']] as const) {
    if (!data.columns.some(column => column.id === data[key] && column.type === type)) {
      data[key] = data.columns.find(column => column.type === type)?.id ?? null;
    }
  }
}

export function cellValue(value: unknown, type: ColumnType): Cell {
  if (type === 'checkbox') return value === true || value === 1 || /^(true|yes|done|1)$/i.test(String(value));
  if (type === 'number') {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value); return Number.isFinite(number) ? number : null;
  }
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : '';
  }
  return text;
}

export function newRow(columns: Column[]): Row {
  const cells: Record<string, Cell> = Object.create(null);
  columns.forEach(column => { cells[column.id] = cellValue('', column.type); });
  return { id: crypto.randomUUID(), cells };
}

export function newDatabase(): NoteDatabase {
  const columns: Column[] = [
    { id: crypto.randomUUID(), name: 'Name', type: 'text', options: [] },
    { id: crypto.randomUUID(), name: 'Status', type: 'select', options: ['Not started', 'In progress', 'Done'] },
    { id: crypto.randomUUID(), name: 'Due', type: 'date', options: [] },
  ];
  const data: NoteDatabase = { version: 1, title: 'Untitled database', columns, rows: [newRow(columns)], filter: '', sort: null,
    view: 'table', calendarColumnId: columns[2].id, boardColumnId: columns[1].id, calendarMonth: monthKey(), views: [], activeViewId: '' };
  data.views = ['table', 'kanban', 'calendar'].map(layout => createSavedView(data, layout[0].toUpperCase() + layout.slice(1), layout as DatabaseView));
  data.activeViewId = data.views[0].id;
  return data;
}

export function readDatabase(source: string): NoteDatabase | null {
  try {
    const value = JSON.parse(source) as NoteDatabase;
    if (!value || value.version !== 1 || typeof value.title !== 'string' || !Array.isArray(value.columns) || !value.columns.length || !Array.isArray(value.rows)) return null;
    const ids = new Set<string>();
    const columns = value.columns.map(column => {
      if (!column || typeof column.id !== 'string' || ids.has(column.id) || typeof column.name !== 'string' || !Object.hasOwn(columnTypes, column.type)) throw new Error('Invalid column');
      ids.add(column.id);
      const options = Array.isArray(column.options) ? [...new Set(column.options.filter(option => typeof option === 'string'))] : [];
      const optionColors: Record<string, string> = Object.create(null);
      for (const option of options) {
        const color = column.optionColors?.[option];
        if (typeof color === 'string' && Object.hasOwn(optionPalette, color)) optionColors[option] = color;
      }
      return { id: column.id, name: column.name, type: column.type, options, optionColors };
    });
    ids.clear();
    const rows = value.rows.map(row => {
      if (!row || typeof row.id !== 'string' || ids.has(row.id) || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) throw new Error('Invalid row');
      ids.add(row.id);
      const cells: Record<string, Cell> = Object.create(null);
      columns.forEach(column => { cells[column.id] = cellValue(row.cells[column.id], column.type); });
      return { id: row.id, cells };
    });
    const sort = value.sort && columns.some(column => column.id === value.sort?.columnId) && ['asc', 'desc'].includes(value.sort.direction) ? value.sort : null;
    const data: NoteDatabase = { version: 1, title: value.title, columns, rows, filter: typeof value.filter === 'string' ? value.filter : '', sort,
      view: ['table', 'kanban', 'calendar'].includes(value.view) ? value.view : 'table',
      calendarColumnId: typeof value.calendarColumnId === 'string' ? value.calendarColumnId : null,
      boardColumnId: typeof value.boardColumnId === 'string' ? value.boardColumnId : null,
      calendarMonth: typeof value.calendarMonth === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.calendarMonth) ? value.calendarMonth : monthKey(), views: [], activeViewId: '' };
    resolveViewColumns(data);
    const viewIds = new Set<string>();
    if (Array.isArray(value.views)) for (const raw of value.views) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || viewIds.has(raw.id) || typeof raw.name !== 'string' || !['table', 'kanban', 'calendar'].includes(raw.layout)) continue;
      viewIds.add(raw.id);
      const view = createSavedView(data, raw.name.trim().slice(0, 80) || 'Untitled view', raw.layout);
      view.id = raw.id;
      view.filter = typeof raw.filter === 'string' ? raw.filter : '';
      view.sort = raw.sort && columns.some(column => column.id === raw.sort?.columnId) && ['asc', 'desc'].includes(raw.sort.direction) ? { ...raw.sort } : null;
      view.hiddenColumnIds = Array.isArray(raw.hiddenColumnIds) ? [...new Set(raw.hiddenColumnIds.filter(id => columns.some(column => column.id === id)))] : [];
      if (view.hiddenColumnIds.length === columns.length) view.hiddenColumnIds = view.hiddenColumnIds.filter(id => id !== columns[0].id);
      view.columnWidths = Object.create(null);
      for (const column of columns) {
        const width = raw.columnWidths?.[column.id];
        if (typeof width === 'number' && Number.isFinite(width)) view.columnWidths[column.id] = Math.min(600, Math.max(100, width));
      }
      view.calendarColumnId = columns.find(column => column.id === raw.calendarColumnId && column.type === 'date')?.id ?? columns.find(column => column.type === 'date')?.id ?? null;
      view.boardColumnId = columns.find(column => column.id === raw.boardColumnId && column.type === 'select')?.id ?? columns.find(column => column.type === 'select')?.id ?? null;
      view.calendarMonth = typeof raw.calendarMonth === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(raw.calendarMonth) ? raw.calendarMonth : monthKey();
      view.condition = raw.condition && columns.some(column => column.id === raw.condition?.columnId) && typeof raw.condition.value === 'string' ? { columnId: raw.condition.columnId, value: raw.condition.value } : null;
      data.views.push(view);
    }
    if (!data.views.length) data.views = (['table', 'kanban', 'calendar'] as const).map(layout => createSavedView(data, layout[0].toUpperCase() + layout.slice(1), layout));
    data.activeViewId = data.views.find(view => view.id === value.activeViewId)?.id ?? data.views.find(view => view.layout === data.view)?.id ?? data.views[0].id;
    const current = activeView(data);
    Object.assign(data, { view: current.layout, filter: current.filter, sort: current.sort, calendarColumnId: current.calendarColumnId, boardColumnId: current.boardColumnId, calendarMonth: current.calendarMonth });
    return data;
  } catch { return null; }
}

export function visibleRows(data: NoteDatabase): Row[] {
  const query = data.filter.toLocaleLowerCase().trim();
  const condition = activeView(data).condition;
  const rows = data.rows.filter(row => (!query || data.columns.some(column => String(row.cells[column.id] ?? '').toLocaleLowerCase().includes(query)))
    && (!condition || String(row.cells[condition.columnId] ?? '') === condition.value));
  const sort = data.sort;
  if (!sort) return rows;
  const column = data.columns.find(item => item.id === sort.columnId);
  if (!column) return rows;
  return rows.sort((a, b) => {
    const left = a.cells[column.id], right = b.cells[column.id];
    const leftEmpty = left === null || left === '', rightEmpty = right === null || right === '';
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    const order = column.type === 'number' || column.type === 'checkbox' ? Number(left) - Number(right) : String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return sort.direction === 'asc' ? order : -order;
  });
}
