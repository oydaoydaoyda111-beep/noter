export const columnTypes = { text: 'Text', number: 'Number', select: 'Select', date: 'Date', checkbox: 'Checkbox' } as const;
export type ColumnType = keyof typeof columnTypes;
export type Cell = string | number | boolean | null;
export interface Column { id: string; name: string; type: ColumnType; options: string[]; }
export interface Row { id: string; cells: Record<string, Cell>; }
export type DatabaseView = 'table' | 'kanban' | 'calendar';
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
  return { version: 1, title: 'Untitled database', columns, rows: [newRow(columns)], filter: '', sort: null,
    view: 'table', calendarColumnId: columns[2].id, boardColumnId: columns[1].id, calendarMonth: monthKey() };
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
      return { id: column.id, name: column.name, type: column.type, options };
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
      calendarMonth: typeof value.calendarMonth === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.calendarMonth) ? value.calendarMonth : monthKey() };
    resolveViewColumns(data);
    return data;
  } catch { return null; }
}

export function visibleRows(data: NoteDatabase): Row[] {
  const query = data.filter.toLocaleLowerCase().trim();
  const rows = data.rows.filter(row => !query || data.columns.some(column => String(row.cells[column.id] ?? '').toLocaleLowerCase().includes(query)));
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
