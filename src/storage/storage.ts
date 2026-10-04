import { loadWorkspaceFile, saveWorkspaceFile } from '../desktop/platform.ts';
import { normalizeSettings } from '../settings/model.ts';
import type { Workspace, WorkspaceNode } from '../types';

export function validateWorkspace(data: unknown): Workspace {
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
  const settings = normalizeSettings(value.settings);
  return {
    version: 1, nodes, rootIds: value.rootIds, openTabs, settings,
    activeNoteId: value.activeNoteId && openTabs.includes(value.activeNoteId) ? value.activeNoteId : openTabs[0] ?? null,
    collapsedFolders: (Array.isArray(value.collapsedFolders) ? value.collapsedFolders : []).filter(id => nodes[id]?.type === 'folder'),
  };
}

export const storage = {
  async load(): Promise<{ workspace: Workspace; warning?: string }> {
    return { workspace: validateWorkspace(await loadWorkspaceFile()) };
  },
  async save(workspace: Workspace): Promise<boolean> {
    await saveWorkspaceFile(workspace);
    return true;
  },
};
