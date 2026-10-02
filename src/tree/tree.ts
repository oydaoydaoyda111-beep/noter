import type { Store } from '../state/workspace';
import type { WorkspaceNode } from '../types';
import { button, el, emptyState } from '../ui/dom';
import { icon } from '../ui/icons';

export interface TreeActions {
  open: (id: string) => void;
  menu: (node: WorkspaceNode, x: number, y: number, trigger: HTMLElement) => void;
  createNote: (parentId: string | null) => void;
}

export function createTree(container: HTMLElement, store: Store, actions: TreeActions) {
  container.setAttribute('role', 'tree');
  container.setAttribute('aria-label', 'Workspace files');
  let selectedFolder: string | null = null;

  function renderNode(id: string, depth: number): HTMLElement {
    const node = store.workspace.nodes[id];
    const group = el('div', 'tree-node'); group.dataset.nodeId = id;
    const row = el('div', `tree-row${node.type === 'folder' ? ' folder-row' : ''}`);
    row.style.setProperty('--depth', String(depth));
    const control = button(node.name, 'tree-control');
    control.dataset.id = id;
    control.setAttribute('role', 'treeitem');
    control.setAttribute('aria-level', String(depth + 1));
    if (node.type === 'folder') {
      control.setAttribute('aria-expanded', String(!store.workspace.collapsedFolders.includes(id)));
      control.append(icon('chevron'), icon('folder'));
    } else {
      control.setAttribute('aria-selected', String(store.workspace.activeNoteId === id));
      control.append(el('span', 'tree-spacer'), icon('note'));
      row.classList.toggle('is-active', store.workspace.activeNoteId === id);
    }
    const label = el('span', 'tree-label', node.name);
    control.append(label);
    if (node.type === 'note') control.append(el('span', 'file-extension', '.md'));
    control.onclick = () => {
      if (node.type === 'folder') { selectedFolder = id; store.toggleFolder(id); }
      else { selectedFolder = node.parentId; actions.open(id); }
    };
    const more = button(`Actions for ${node.name}`, 'tree-more'); more.append(icon('more'));
    more.onclick = () => {
      selectedFolder = node.type === 'folder' ? node.id : node.parentId;
      const bounds = more.getBoundingClientRect(); actions.menu(node, bounds.right + 4, bounds.top, more);
    };
    row.oncontextmenu = event => {
      event.preventDefault(); selectedFolder = node.type === 'folder' ? node.id : node.parentId;
      actions.menu(node, event.clientX, event.clientY, control);
    };
    row.append(control, more); group.append(row);
    if (node.type === 'folder') {
      const wrapper = el('div', 'folder-children'); wrapper.dataset.folderId = id;
      const inner = el('div', 'folder-children-inner'); inner.setAttribute('role', 'group');
      node.children.forEach(child => inner.append(renderNode(child, depth + 1)));
      if (!node.children.length) {
        const empty = button('Create a note in this folder', 'empty-folder');
        empty.textContent = 'A little space to fill';
        empty.style.setProperty('--depth', String(depth + 1));
        empty.onclick = () => actions.createNote(id); inner.append(empty);
      }
      wrapper.append(inner); group.append(wrapper);
    }
    return group;
  }

  function folderState() {
    container.querySelectorAll<HTMLElement>('[data-folder-id]').forEach(wrapper => {
      const collapsed = store.workspace.collapsedFolders.includes(wrapper.dataset.folderId!);
      wrapper.classList.toggle('is-collapsed', collapsed);
      wrapper.inert = collapsed;
      wrapper.parentElement?.querySelector('.tree-control')?.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  container.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('tree-control')) return;
    const controls = Array.from(container.querySelectorAll<HTMLButtonElement>('.tree-control')).filter(control => !control.closest('.is-collapsed'));
    const index = controls.indexOf(target as HTMLButtonElement);
    const id = target.dataset.id!;
    const node = store.workspace.nodes[id];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); controls[Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (event.key === 'ArrowRight' && node.type === 'folder') {
      event.preventDefault();
      if (store.workspace.collapsedFolders.includes(id)) store.toggleFolder(id); else controls[index + 1]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.type === 'folder' && !store.workspace.collapsedFolders.includes(id)) store.toggleFolder(id);
      else if (node.parentId) controls.find(control => control.dataset.id === node.parentId)?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); controls[event.key === 'Home' ? 0 : controls.length - 1]?.focus();
    }
  });

  return {
    render() {
      const focusedId = (document.activeElement as HTMLElement)?.dataset.id;
      container.replaceChildren();
      store.workspace.rootIds.forEach(id => container.append(renderNode(id, 0)));
      if (!store.workspace.rootIds.length) {
        const empty = emptyState('A fresh beginning', 'Your first note is just one thought away.');
        const create = button('Create a note', 'text-button'); create.textContent = 'Create your first note';
        create.append(icon('arrow')); create.onclick = () => actions.createNote(null); empty.append(create); container.append(empty);
      }
      folderState();
      if (focusedId) Array.from(container.querySelectorAll<HTMLButtonElement>('[data-id]')).find(control => control.dataset.id === focusedId)?.focus();
    },
    folderState,
    activeState() {
      container.querySelectorAll<HTMLButtonElement>('.tree-control').forEach(control => {
        if (store.workspace.nodes[control.dataset.id!]?.type !== 'note') return;
        const active = store.workspace.activeNoteId === control.dataset.id;
        control.setAttribute('aria-selected', String(active)); control.parentElement?.classList.toggle('is-active', active);
      });
    },
    get destination() {
      if (selectedFolder && store.workspace.nodes[selectedFolder]?.type === 'folder') return selectedFolder;
      return store.activeNote?.parentId ?? null;
    },
    reset() { selectedFolder = null; },
  };
}
