import { createStore } from './state/workspace';
import { storage } from './storage/storage';
import { createEditor } from './editor/editor';
import { createTree } from './tree/tree';
import { createTabs } from './tabs/tabs';
import { createSearch } from './search/search';
import { applySettings, openSettings } from './settings/settings';
import { askDialog } from './ui/dialog';
import { showMenu, type MenuItem } from './ui/menu';
import { animateDocument } from './ui/motion';
import { icon } from './ui/icons';
import { el } from './ui/dom';
import type { WorkspaceNode } from './types';

export function startApp(mount: HTMLElement) {
  const loaded = storage.load();
  const store = createStore(loaded.workspace);
  mount.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Workspace navigation">
        <div class="workspace-header">
          <div class="brand-mark" aria-hidden="true"><span>n</span></div>
          <div class="brand-copy"><span class="brand-name">noter<span class="brand-period">.</span></span><span class="workspace-name">Personal workspace</span></div>
        </div>
        <div class="create-actions">
          <button class="new-note-button" id="new-note" type="button"><span>New note</span><kbd class="new-note-key"></kbd></button>
          <button class="new-folder-button icon-button" id="new-folder" type="button" title="New folder" aria-label="New folder"></button>
        </div>
        <div class="search-field">
          <input id="search" type="search" placeholder="Search anything…" aria-label="Search all notes" autocomplete="off" spellcheck="false" />
          <kbd class="search-key"></kbd>
          <button id="clear-search" class="icon-button" type="button" aria-label="Clear search" title="Clear search" hidden></button>
        </div>
        <div class="tree-heading"><h2 id="tree-label">Workspace</h2><span id="note-count"></span></div>
        <div class="sidebar-files"><nav id="file-tree"></nav><div id="search-results" aria-label="Search results" hidden></div></div>
        <div class="sidebar-bottom">
          <button id="settings" class="settings-button" type="button"><span>Settings</span></button>
          <div class="local-caption"><span class="local-dot"></span> A space that's only yours</div>
        </div>
      </aside>
      <main class="workspace">
        <div class="tab-bar"><div id="tabs" class="tabs"></div><div class="tab-bar-end"><span class="workspace-label">YOUR SPACE, IN FOCUS</span></div></div>
        <section id="note-panel" class="note-panel" role="tabpanel" aria-label="Active note">
          <div class="workspace-topline">
            <div id="breadcrumb" class="breadcrumb" aria-label="Note location"></div>
            <div class="editor-actions"><div id="format-toolbar" class="format-toolbar" role="toolbar" aria-label="Text formatting"></div><span class="toolbar-divider"></span><button id="note-actions" class="icon-button" type="button" aria-label="Note actions" title="Note actions"></button></div>
          </div>
          <div id="editor-scroll" class="editor-scroll">
            <article id="document" class="document">
              <div class="document-symbol" aria-hidden="true"></div>
              <input id="note-title" class="note-title" type="text" aria-label="Note title" placeholder="Untitled" maxlength="120" autocomplete="off" spellcheck="false" />
              <div id="editor" class="editor"></div>
              <div class="document-end" aria-hidden="true"><span></span><span class="end-dot"></span><span></span></div>
            </article>
          </div>
        </section>
        <div id="workspace-empty" class="workspace-empty" hidden>
          <div class="empty-illustration" aria-hidden="true"><div class="empty-paper back"></div><div class="empty-paper front"><span></span><span></span><span></span></div></div>
          <p class="empty-eyebrow">A LITTLE ROOM TO THINK</p>
          <h1>Every thought starts somewhere.</h1>
          <p>Open a note from your workspace,<br />or give a new idea a page of its own.</p>
          <button id="empty-create" class="button-primary" type="button">Create a note</button>
        </div>
        <footer class="status-bar"><div id="document-stats"></div><div class="status-right"><span class="format-caption">Markdown</span><span class="status-separator"></span><span id="save-status" class="save-status" role="status" aria-live="polite"><span class="save-dot"></span><span id="save-label">Saved locally</span></span></div></footer>
      </main>
    </div>
    <div id="notification" class="notification" role="status" aria-live="polite" hidden></div>
    <div id="storage-warning" class="storage-warning" role="alert" hidden></div>`;

  const get = <T extends HTMLElement = HTMLElement>(id: string) => mount.querySelector<T>(`#${id}`)!;
  const title = get<HTMLInputElement>('note-title');
  const editorRoot = get('editor');
  const documentPage = get('document');
  const panel = get('note-panel');
  const scroller = get('editor-scroll');
  const noteMenuButton = get<HTMLButtonElement>('note-actions');
  const saveStatus = get('save-status');
  const warning = get('storage-warning');
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let shownNoteId: string | null = null;
  let changedSinceLoad = false;
  const scrollPositions = new Map<string, number>();

  function notify(message: string) {
    const notification = get('notification'); notification.textContent = message; notification.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { notification.hidden = true; }, 2400);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (loaded.warning && !changedSinceLoad) return false;
    const success = storage.save(store.workspace);
    saveStatus.dataset.state = success ? 'saved' : 'error';
    get('save-label').textContent = success ? 'Saved locally' : 'Couldn’t save';
    if (!success) { warning.textContent = 'Your changes are still in memory. Browser storage is unavailable or full; keep this page open until you can save.'; warning.hidden = false; }
    else { loaded.warning = undefined; warning.hidden = true; }
    return success;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveStatus.dataset.state = 'pending'; get('save-label').textContent = 'Saving…';
    saveTimer = setTimeout(saveNow, store.workspace.settings.autosaveDelay);
  }

  function commitTitle() {
    clearTimeout(titleTimer);
    if (shownNoteId && store.workspace.nodes[shownNoteId] && title.value.trim() && title.value.trim() !== store.workspace.nodes[shownNoteId].name) store.rename(shownNoteId, title.value);
  }

  function open(id: string) { commitTitle(); store.open(id); }

  function createNote(parentId: string | null) {
    commitTitle();
    store.create('note', 'Untitled', parentId);
    title.focus(); title.select();
  }

  async function createFolder(parentId: string | null) {
    const parent = parentId ? store.workspace.nodes[parentId]?.name : null;
    const answer = await askDialog({ title: 'A home for your notes', description: parent ? `Create a folder inside ${parent}.` : 'Create a folder in your workspace.', fields: [{ name: 'name', label: 'Folder name', placeholder: 'A new collection' }], submit: 'Create folder' });
    if (answer) store.create('folder', answer.name, parentId);
  }

  async function rename(node: WorkspaceNode) {
    const answer = await askDialog({ title: `Rename ${node.type}`, fields: [{ name: 'name', label: node.type === 'note' ? 'Note title' : 'Folder name', value: node.name }], submit: 'Rename' });
    if (answer) store.rename(node.id, answer.name);
  }

  async function remove(node: WorkspaceNode) {
    const confirmed = await askDialog({
      title: `Delete “${node.name}”?`,
      description: node.type === 'folder' ? 'This folder and every note inside it will be permanently removed.' : 'This note will be permanently removed from your workspace.',
      submit: `Delete ${node.type}`, danger: true,
    });
    if (confirmed) { store.remove(node.id); saveNow(); }
  }

  function nodeMenu(node: WorkspaceNode, x: number, y: number, trigger: HTMLElement) {
    const items: MenuItem[] = node.type === 'folder'
      ? [{ label: 'New note inside', icon: 'plus', action: () => createNote(node.id) }, { label: 'New folder inside', icon: 'folderPlus', action: () => void createFolder(node.id) }]
      : [{ label: 'Open note', icon: 'note', action: () => open(node.id) }];
    items.push({ label: 'Rename', icon: 'edit', action: () => void rename(node) }, { label: 'Delete', icon: 'trash', action: () => void remove(node), danger: true });
    showMenu(x, y, items, trigger);
  }

  const editor = createEditor(editorRoot, get('format-toolbar'), markdown => {
    if (store.activeNote) store.edit(store.activeNote.id, markdown);
  });
  const tree = createTree(get('file-tree'), store, { open, menu: nodeMenu, createNote });
  const tabs = createTabs(get('tabs'), store, open);
  const search = createSearch(get<HTMLInputElement>('search'), get<HTMLButtonElement>('clear-search'), get('search-results'), get('file-tree'), get('tree-label'), store, open);

  function updateStats() {
    const walker = document.createTreeWalker(editorRoot, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('.database-block') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    const text = parts.join('').replace(/\u200b/g, '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const stats = get('document-stats');
    stats.replaceChildren();
    if (store.activeNote) stats.append(el('span', '', `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`), el('span', 'stats-dot', '·'), el('span', 'character-count', `${text.length.toLocaleString()} characters`));
    else stats.textContent = `${Object.values(store.workspace.nodes).filter(node => node.type === 'note').length} notes in your workspace`;
  }

  function renderNote() {
    const note = store.activeNote;
    panel.hidden = !note; get('workspace-empty').hidden = !!note;
    get('breadcrumb').replaceChildren();
    if (note) {
      const crumbs = ['Personal workspace', ...store.path(note.id), `${note.name}.md`];
      crumbs.forEach((name, index) => {
        if (index) get('breadcrumb').append(icon('chevron'));
        get('breadcrumb').append(el('span', index === crumbs.length - 1 ? 'breadcrumb-current' : '', name));
      });
      if (document.activeElement !== title) title.value = note.name;
      document.title = `${note.name} — Noter`;
    } else document.title = 'Noter — a little room to think';
    if (shownNoteId !== (note?.id ?? null)) {
      if (shownNoteId) scrollPositions.set(shownNoteId, scroller.scrollTop);
      editor.load(note?.id ?? null, note?.markdown);
      shownNoteId = note?.id ?? null;
      scroller.scrollTop = shownNoteId ? scrollPositions.get(shownNoteId) ?? 0 : 0;
      if (note) animateDocument(documentPage);
    }
    updateStats();
  }

  function renderCount() {
    get('note-count').textContent = String(Object.values(store.workspace.nodes).filter(node => node.type === 'note').length);
  }

  store.subscribe(change => {
    changedSinceLoad = true;
    if (change === 'reset') {
      clearTimeout(titleTimer); editor.reset(); tree.reset(); scrollPositions.clear(); shownNoteId = null;
      applySettings(store.workspace.settings); tree.render(); tabs.render(); search.reset(); renderNote(); renderCount(); saveNow(); return;
    }
    if (change === 'structure') { tree.render(); tabs.render(); search.render(); renderNote(); renderCount(); }
    if (change === 'tabs') { tabs.render(); tree.activeState(); renderNote(); search.render(); }
    if (change === 'folders') tree.folderState();
    if (change === 'content') { updateStats(); if (get<HTMLInputElement>('search').value.trim()) search.render(); }
    if (change === 'settings') applySettings(store.workspace.settings);
    scheduleSave();
  });

  get('new-note').prepend(icon('plus'));
  get('new-folder').append(icon('folderPlus'));
  get('settings').prepend(icon('settings'));
  get('clear-search').append(icon('close'));
  get('note-actions').append(icon('more'));
  get('document').querySelector('.document-symbol')!.append(icon('note'));
  mount.querySelector('.search-field')!.prepend(icon('search'));
  mount.querySelector('.search-key')!.textContent = `${mod} F`;
  mount.querySelector('.new-note-key')!.textContent = `${mod} N`;
  get('new-note').onclick = () => createNote(tree.destination);
  get('new-folder').onclick = () => void createFolder(tree.destination);
  get('empty-create').onclick = () => createNote(null);
  get('settings').onclick = () => openSettings(store);
  noteMenuButton.onclick = () => {
    commitTitle();
    const note = store.activeNote; if (!note) return;
    const bounds = noteMenuButton.getBoundingClientRect(); nodeMenu(note, bounds.right - 210, bounds.bottom + 6, noteMenuButton);
  };
  title.addEventListener('input', () => { clearTimeout(titleTimer); titleTimer = setTimeout(commitTitle, 500); });
  title.addEventListener('blur', () => { commitTitle(); if (store.activeNote) title.value = store.activeNote.name; });
  title.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitTitle(); editor.focus(); } });

  document.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]')) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    switch (event.key.toLowerCase()) {
      case 's': event.preventDefault(); commitTitle(); if (saveNow()) notify('Saved on this device'); break;
      case 'f': event.preventDefault(); search.focus(); break;
      case 'n': event.preventDefault(); createNote(tree.destination); break;
      case 'w': if (store.activeNote) { event.preventDefault(); commitTitle(); void tabs.close(store.activeNote.id); } break;
    }
  });
  window.addEventListener('beforeunload', () => { commitTitle(); saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { commitTitle(); saveNow(); } });

  applySettings(store.workspace.settings); tree.render(); tabs.render(); renderNote(); renderCount();
  if (loaded.warning) { warning.textContent = loaded.warning; warning.hidden = false; }
  else saveNow();
}
