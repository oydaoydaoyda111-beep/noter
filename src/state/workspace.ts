import type { Change, Folder, Note, Settings, Workspace, WorkspaceNode } from '../types';

export function createStore(initial: Workspace) {
  let workspace = initial;
  const listeners = new Set<(change: Change, id?: string) => void>();
  const emit = (change: Change, id?: string) => listeners.forEach(listener => listener(change, id));
  const siblings = (parentId: string | null) => {
    const parent = parentId ? workspace.nodes[parentId] : null;
    return parent?.type === 'folder' ? parent.children : workspace.rootIds;
  };
  const nameFor = (name: string, type: 'note' | 'folder', parentId: string | null, ignoreId?: string) => {
    const base = name.trim().replace(/[\/\\\n\r]/g, ' ').replace(type === 'note' ? /\.md$/i : /$^/, '').trim().slice(0, 120) || (type === 'note' ? 'Untitled' : 'New folder');
    const names = siblings(parentId).filter(id => id !== ignoreId).map(id => workspace.nodes[id]?.name.toLowerCase());
    let result = base;
    for (let index = 2; names.includes(result.toLowerCase()); index++) result = `${base} ${index}`;
    return result;
  };

  return {
    get workspace() { return workspace; },
    get activeNote(): Note | null {
      const node = workspace.activeNoteId ? workspace.nodes[workspace.activeNoteId] : null;
      return node?.type === 'note' ? node : null;
    },
    subscribe(listener: (change: Change, id?: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(id: string) {
      if (workspace.nodes[id]?.type !== 'note') return;
      if (!workspace.openTabs.includes(id)) workspace.openTabs.push(id);
      workspace.activeNoteId = id;
      emit('tabs', id);
    },
    close(id: string) {
      const index = workspace.openTabs.indexOf(id);
      if (index < 0) return;
      workspace.openTabs.splice(index, 1);
      if (workspace.activeNoteId === id) workspace.activeNoteId = workspace.openTabs[Math.min(index, workspace.openTabs.length - 1)] ?? null;
      emit('tabs');
    },
    create(type: 'note' | 'folder', name: string, parentId: string | null): WorkspaceNode {
      if (parentId && workspace.nodes[parentId]?.type !== 'folder') parentId = null;
      const id = crypto.randomUUID();
      const now = Date.now();
      const base = { id, name: nameFor(name, type, parentId), parentId, createdAt: now, updatedAt: now };
      const node: Note | Folder = type === 'note' ? { ...base, type, markdown: '' } : { ...base, type, children: [] };
      workspace.nodes[id] = node;
      siblings(parentId).push(id);
      let ancestor = parentId;
      while (ancestor) {
        workspace.collapsedFolders = workspace.collapsedFolders.filter(item => item !== ancestor);
        ancestor = workspace.nodes[ancestor]?.parentId ?? null;
      }
      emit('structure', id);
      if (type === 'note') this.open(id);
      return node;
    },
    rename(id: string, name: string) {
      const node = workspace.nodes[id];
      if (!node || !name.trim()) return;
      node.name = nameFor(name, node.type, node.parentId, id);
      node.updatedAt = Date.now();
      emit('structure', id);
    },
    remove(id: string) {
      const node = workspace.nodes[id];
      if (!node) return;
      const ids = new Set<string>();
      const collect = (nodeId: string) => {
        ids.add(nodeId);
        const item = workspace.nodes[nodeId];
        if (item?.type === 'folder') item.children.forEach(collect);
      };
      collect(id);
      const list = siblings(node.parentId);
      list.splice(list.indexOf(id), 1);
      const activeIndex = workspace.openTabs.indexOf(workspace.activeNoteId ?? '');
      workspace.openTabs = workspace.openTabs.filter(tab => !ids.has(tab));
      if (workspace.activeNoteId && ids.has(workspace.activeNoteId)) workspace.activeNoteId = workspace.openTabs[Math.min(activeIndex, workspace.openTabs.length - 1)] ?? null;
      workspace.collapsedFolders = workspace.collapsedFolders.filter(folder => !ids.has(folder));
      ids.forEach(nodeId => delete workspace.nodes[nodeId]);
      emit('structure');
      emit('tabs');
    },
    toggleFolder(id: string) {
      if (workspace.nodes[id]?.type !== 'folder') return;
      workspace.collapsedFolders = workspace.collapsedFolders.includes(id)
        ? workspace.collapsedFolders.filter(folder => folder !== id)
        : [...workspace.collapsedFolders, id];
      emit('folders', id);
    },
    edit(id: string, markdown: string) {
      const note = workspace.nodes[id];
      if (note?.type !== 'note' || note.markdown === markdown) return;
      note.markdown = markdown;
      note.updatedAt = Date.now();
      emit('content', id);
    },
    configure(settings: Partial<Settings>) {
      Object.assign(workspace.settings, settings);
      emit('settings');
    },
    replace(next: Workspace) {
      workspace = next;
      emit('reset');
    },
    path(id: string): string[] {
      const names: string[] = [];
      let node = workspace.nodes[id];
      while (node?.parentId) {
        node = workspace.nodes[node.parentId];
        if (node) names.unshift(node.name);
      }
      return names;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
