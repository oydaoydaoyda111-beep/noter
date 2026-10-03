export interface BaseNode {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note extends BaseNode {
  type: 'note';
  markdown: string;
}

export interface Folder extends BaseNode {
  type: 'folder';
  children: string[];
}

export type WorkspaceNode = Note | Folder;

export interface Settings {
  fontSize: number;
  fontStyle: 'sans' | 'serif' | 'mono';
  documentWidth: number;
  density: 'comfortable' | 'compact';
  motion: 'full' | 'subtle' | 'none';
  autosaveDelay: number;
  accentColor: 'blue' | 'green' | 'purple';
  startupSection: 'last' | 'notes' | 'finance';
  spellcheck: boolean;
  showNoteStats: boolean;
  financeCurrency: '' | 'AZN' | 'USD' | 'EUR' | 'GBP' | 'TRY';
  financeDateFormat: 'iso' | 'dmy' | 'mdy';
  financeTableDensity: 'compact' | 'comfortable';
  financePageSize: number;
  financeDefaultAccount: string;
  financeRememberEntries: boolean;
  financeShowAccountNotes: boolean;
}

export interface Workspace {
  version: 1;
  nodes: Record<string, WorkspaceNode>;
  rootIds: string[];
  openTabs: string[];
  activeNoteId: string | null;
  collapsedFolders: string[];
  settings: Settings;
}

export type Change = 'structure' | 'tabs' | 'folders' | 'content' | 'settings' | 'reset';
