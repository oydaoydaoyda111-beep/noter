import { defaultSettings, demoWorkspace, emptyWorkspace } from '../state/demo';
import type { Workspace, WorkspaceNode } from '../types';

const STORAGE_KEY = 'noter.workspace.v1';

function validate(data: unknown): Workspace {
  const value = data as Workspace;
  if (!value || value.version !== 1 || !value.nodes || !Array.isArray(value.rootIds)) throw new Error('Invalid workspace');
  const nodes: Record<string, WorkspaceNode> = Object.create(null);
  for (const [id, node] of Object.entries(value.nodes)) {
    if (!node || node.id !== id || typeof node.name !== 'string' || !['note', 'folder'].includes(node.type)
      || (node.type === 'note' && typeof node.markdown !== 'string')
      || (node.type === 'folder' && !Array.isArray(node.children))) throw new Error('Invalid note');
    nodes[id] = node;
  }
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null) => {
    const node = nodes[id];
    if (!node || seen.has(id) || node.parentId !== parentId) throw new Error('Invalid folder hierarchy');
    seen.add(id);
    if (node.type === 'folder') node.children.forEach(child => visit(child, id));
  };
  value.rootIds.forEach(id => visit(id, null));
  if (seen.size !== Object.keys(nodes).length) throw new Error('Unreachable note');
  const openTabs = [...new Set(Array.isArray(value.openTabs) ? value.openTabs : [])].filter(id => nodes[id]?.type === 'note');
  const settings = { ...defaultSettings, ...value.settings };
  settings.fontSize = Math.max(14, Math.min(24, Number(settings.fontSize) || defaultSettings.fontSize));
  if (!['sans', 'serif', 'mono'].includes(settings.fontStyle)) settings.fontStyle = 'sans';
  settings.documentWidth = Number(settings.documentWidth);
  if (![720, 790, 850].includes(settings.documentWidth)) settings.documentWidth = 790;
  settings.autosaveDelay = Math.max(200, Math.min(2000, Number(settings.autosaveDelay) || 650));
  if (!['comfortable', 'compact'].includes(settings.density)) settings.density = 'comfortable';
  if (!['full', 'subtle', 'none'].includes(settings.motion)) settings.motion = 'full';
  return {
    version: 1, nodes, rootIds: value.rootIds, openTabs, settings,
    activeNoteId: value.activeNoteId && openTabs.includes(value.activeNoteId) ? value.activeNoteId : openTabs[0] ?? null,
    collapsedFolders: (Array.isArray(value.collapsedFolders) ? value.collapsedFolders : []).filter(id => nodes[id]?.type === 'folder'),
  };
}

export const storage = {
  load(): { workspace: Workspace; warning?: string } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return { workspace: demoWorkspace() };
      return { workspace: validate(JSON.parse(raw)) };
    } catch {
      return { workspace: emptyWorkspace(), warning: 'Your saved workspace could not be opened. Local storage may be unavailable. You can start fresh in Settings.' };
    }
  },
  save(workspace: Workspace): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      return true;
    } catch {
      return false;
    }
  },
};
