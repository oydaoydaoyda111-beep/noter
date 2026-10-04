import { readWorkspaceSnapshot, adoptWorkspaceSnapshot, workspaceChanged, financeChanged, flushFiles, chooseFolder, readDocument, writeDocument, readLastSection, saveLastSection, preserveWorkspaceEdits } from './desktop/platform';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createStore } from './state/workspace';
import { storage, validateWorkspace } from './storage/storage';
import { createEditor } from './editor/editor';
import { createTree } from './tree/tree';
import { createTabs } from './tabs/tabs';
import { createSearch } from './search/search';
import { applySettings, openSettings } from './settings/settings';
import { askDialog } from './ui/dialog';
import { showMenu, type MenuItem } from './ui/menu';
import { animateDocument } from './ui/motion';
import { icon } from './ui/icons';
import { nameEmoji } from './ui/emoji';
import { el } from './ui/dom';
import type { WorkspaceNode } from './types';
import { createFinance } from './finance/finance';

export async function startApp(mount: HTMLElement) {
  const loaded = await storage.load();
  const store = createStore(loaded.workspace);
  mount.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Workspace navigation">
        <div class="workspace-header">
          <div class="brand-mark" aria-hidden="true"><span>n</span></div>
          <div class="brand-copy"><span class="brand-name">noter<span class="brand-period">.</span></span><span class="workspace-name">Personal workspace</span></div>
        </div>
        <nav class="workspace-sections" aria-label="Workspace sections"><button id="notes-section" type="button" aria-pressed="true">Notes</button><button id="finance-section" type="button" aria-pressed="false">Finance</button></nav>
        <div class="create-actions">
          <button class="new-note-button" id="new-note" type="button"><span>New note</span><kbd class="new-note-key"></kbd></button>
          <button class="new-folder-button icon-button" id="new-folder" type="button" title="New folder" aria-label="New folder"></button>
        </div>
        <div class="search-field">
          <input id="search" type="search" placeholder="Search anything…" aria-label="Search all notes" autocomplete="off" spellcheck="false" />
          <kbd class="search-key"></kbd>
          <button id="clear-search" class="icon-button" type="button" aria-label="Clear search" title="Clear search" hidden></button>
        </div>
        <div id="search-filters" class="search-filters" role="group" aria-label="Search in"></div>
        <div class="tree-heading"><h2 id="tree-label">Workspace</h2><span id="note-count"></span></div>
        <div class="sidebar-files"><nav id="file-tree"></nav><div id="search-results" aria-label="Search results" hidden></div></div>
        <div class="sidebar-bottom">
          <button id="settings" class="settings-button" type="button"><span>Settings</span></button>
          <div class="local-caption"><span class="local-dot"></span> A space that's only yours</div>
        </div>
      </aside>
      <main class="workspace">
        <div class="tab-bar"><div id="tabs" class="tabs"></div><div class="tab-bar-end"><span class="workspace-label">YOUR SPACE, IN FOCUS</span></div></div>
        <section id="finance-panel" class="finance-panel" aria-label="Finance workspace" hidden></section>
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
  function applicationSettings() { openSettings(store, finance.accounts(), { reload: reloadFiles, chooseFolder: switchFolder, exportNotes, importNotes }); }
  const finance = createFinance(get('finance-panel'), () => store.workspace.settings, applicationSettings, name => store.configure({ financeDefaultAccount: name }));
  let showingFinance = false;
  function section(isFinance: boolean) {
    commitTitle(); showingFinance = isFinance;
    get('notes-section').setAttribute('aria-pressed', String(!isFinance));
    get('finance-section').setAttribute('aria-pressed', String(isFinance));
    if (isFinance) finance.show(); else finance.hide();
    renderNote();
    if (isFinance) document.title = 'Finance — Noter';
    void saveLastSection(isFinance ? 'finance' : 'notes').catch(() => { /* Navigation still works if device preferences cannot be saved. */ });
  }
  get('notes-section').onclick = () => section(false);
  get('finance-section').onclick = () => section(true);
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

  let editVersion = 0, unsaved = false, applyingDisk = false, polling = false, checkingFiles = false;
  async function saveNow() {
    clearTimeout(saveTimer);
    if (loaded.warning && !changedSinceLoad) return false;
    const version = editVersion;
    try {
      const success = await storage.save(store.workspace);
      if (version === editVersion) {
        unsaved = !success;
        saveStatus.dataset.state = success ? 'saved' : 'error';
        get('save-label').textContent = success ? 'Saved to folder' : 'Couldn’t save';
        if (!success) { warning.textContent = 'Your changes are still in memory. Storage is unavailable or full; keep Noter open until you can save.'; warning.hidden = false; }
        else { loaded.warning = undefined; warning.hidden = true; }
      }
      return success;
    } catch (error) {
      unsaved = true; saveStatus.dataset.state = 'error'; get('save-label').textContent = 'Couldn’t save';
      warning.replaceChildren(el('span', '', String(error)));
      const reload = el('button', 'button-secondary', 'Review synced changes'); reload.onclick = () => void reloadFiles(); warning.append(reload);
      warning.hidden = false; return false;
    }
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

  function open(id: string) { section(false); store.open(id); }

  let creatingNote = false;
  async function createNote(parentId: string | null) {
    if (creatingNote) return;
    creatingNote = true;
    try {
      commitTitle();
      const parent = parentId ? store.workspace.nodes[parentId]?.name : null;
      const answer = await askDialog({
        title: 'Create a note',
        description: parent ? `Add a new note inside ${parent}.` : 'Give your next idea a name.',
        fields: [{ name: 'name', label: 'Note name', placeholder: 'What’s on your mind?' }],
        submit: 'Create note', nameEmoji: true,
      });
      if (!answer) return;
      section(false);
      store.create('note', answer.name, parentId);
      editor.focus();
    } finally {
      creatingNote = false;
    }
  }

  async function createFolder(parentId: string | null) {
    const parent = parentId ? store.workspace.nodes[parentId]?.name : null;
    const answer = await askDialog({ title: 'A home for your notes', description: parent ? `Create a folder inside ${parent}.` : 'Create a folder in your workspace.', fields: [{ name: 'name', label: 'Folder name', placeholder: 'A new collection' }], submit: 'Create folder', nameEmoji: true });
    if (answer) store.create('folder', answer.name, parentId);
  }

  async function rename(node: WorkspaceNode) {
    const answer = await askDialog({ title: `Rename ${node.type}`, fields: [{ name: 'name', label: node.type === 'note' ? 'Note title' : 'Folder name', value: node.name }], submit: 'Rename', nameEmoji: true });
    if (answer) store.rename(node.id, answer.name);
  }

  async function remove(node: WorkspaceNode) {
    const confirmed = await askDialog({
      title: `Delete “${node.name}”?`,
      description: node.type === 'folder' ? 'This folder will be removed from the workspace. Its notes are kept in .noter/trash.' : 'This note will move to .noter/trash in your workspace folder.',
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
  const search = createSearch(get<HTMLInputElement>('search'), get<HTMLButtonElement>('clear-search'), get('search-results'), get('file-tree'), get('tree-label'), get('search-filters'), store, open);

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
    panel.hidden = showingFinance || !note; get('workspace-empty').hidden = showingFinance || !!note;
    get('breadcrumb').replaceChildren();
    get('document').querySelector<HTMLElement>('.document-symbol')!.hidden = !!note && !!nameEmoji(note.name);
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
    if (showingFinance) document.title = 'Finance — Noter';
  }

  function renderCount() {
    get('note-count').textContent = String(Object.values(store.workspace.nodes).filter(node => node.type === 'note').length);
  }

  store.subscribe(change => {
    if (applyingDisk) { editor.reset(); tree.reset(); scrollPositions.clear(); shownNoteId = null; applySettings(store.workspace.settings); tree.render(); tabs.render(); search.reset(); renderNote(); renderCount(); return; }
    editVersion++; unsaved = true; changedSinceLoad = true;
    if (change === 'reset') {
      clearTimeout(titleTimer); editor.reset(); tree.reset(); scrollPositions.clear(); shownNoteId = null;
      applySettings(store.workspace.settings); finance.refresh(); tree.render(); tabs.render(); search.reset(); renderNote(); renderCount(); saveNow(); return;
    }
    if (change === 'structure') { tree.render(); tabs.render(); search.render(); renderNote(); renderCount(); }
    if (change === 'tabs') { tabs.render(); tree.activeState(); renderNote(); search.render(); }
    if (change === 'folders') tree.folderState();
    if (change === 'content') { updateStats(); if (get<HTMLInputElement>('search').value.trim()) search.render(); }
    if (change === 'settings') { applySettings(store.workspace.settings); finance.refresh(); }
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
  get('settings').onclick = applicationSettings;
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
      case 's': event.preventDefault(); commitTitle(); void saveNow().then(success => { if (success) notify('Saved to workspace folder'); }); break;
      case 'f': event.preventDefault(); if (showingFinance) finance.focusSearch(); else search.focus(); break;
      case 'n': event.preventDefault(); createNote(tree.destination); break;
      case 'w': if (store.activeNote) { event.preventDefault(); commitTitle(); void tabs.close(store.activeNote.id); } break;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { commitTitle(); void saveNow(); }
    else void checkSyncedFiles(true);
  });

  async function exportNotes() {
    commitTitle();
    await writeDocument('noter-notes-backup.json', new TextEncoder().encode(JSON.stringify(store.workspace, null, 2)));
  }
  async function importNotes() {
    const file = await readDocument('json'); if (!file) return;
    const next = validateWorkspace(JSON.parse(new TextDecoder().decode(file.bytes)));
    const answer = await askDialog({ title: 'Restore notes backup?', description: 'Replace notes, folders, and settings with this backup. Finance is kept. Export your current notes first if you need them.', submit: 'Restore notes', danger: true });
    if (answer) { store.replace(next); await saveNow(); }
  }
  async function switchFolder() {
    commitTitle(); if (!await saveNow() || finance.isBusy()) { notify('Finish saving your changes before switching folders.'); return; }
    try { await flushFiles(); if (await chooseFolder()) location.reload(); } catch (error) { notify(String(error)); }
  }
  async function reloadFiles() {
    if (polling || finance.isBusy()) return;
    commitTitle(); clearTimeout(saveTimer);
    polling = true;
    try {
      if (unsaved) {
        const answer = await askDialog({ title: 'Keep both versions', description: 'Keep your changed notes as Markdown copies in a Recovered edits folder, and back up your full workspace before loading synced files. Cancel to keep editing.', submit: 'Keep edits and reload' });
        if (!answer) { scheduleSave(); return; }
      }
      await flushFiles().catch(() => {});
      const version = editVersion;
      const recovery = unsaved ? await preserveWorkspaceEdits(structuredClone(store.workspace)) : null;
      if (recovery) { warning.textContent = `Your edits were backed up to ${recovery.snapshot}${recovery.folder ? ` and copied into ${recovery.folder}` : ''}.`; warning.hidden = false; }
      const snapshot = await readWorkspaceSnapshot();
      if (version !== editVersion) { notify('Finish editing before reloading synced files.'); return; }
      const next = validateWorkspace(snapshot.workspace); adoptWorkspaceSnapshot(snapshot); applyingDisk = true; store.replace(next); applyingDisk = false; unsaved = false; loaded.warning = undefined;
      await finance.reload(); warning.hidden = recovery === null; saveStatus.dataset.state = 'saved'; get('save-label').textContent = recovery ? 'Both versions kept' : 'Synced files loaded'; notify(recovery ? 'Your edits were preserved; synced files loaded' : 'Workspace reloaded from files');
    } catch (error) { warning.textContent = String(error); warning.hidden = false; }
    finally { applyingDisk = false; polling = false; }
  }
  document.documentElement.dataset.desktop = 'true';
  const currentWindow = getCurrentWindow();
  await currentWindow.onCloseRequested(async event => {
    event.preventDefault(); commitTitle();
    if (finance.isBusy()) { notify('Wait for Finance to finish saving before closing.'); return; }
    if (!await saveNow()) return;
    try { await flushFiles(); await currentWindow.destroy(); } catch (error) { notify(String(error)); }
  });
  await listen<string>('desktop-command', event => {
    if (event.payload === 'quit') { void currentWindow.close(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (event.payload === 'new-note') void createNote(tree.destination);
    if (event.payload === 'settings') applicationSettings();
    if (event.payload === 'save') { commitTitle(); void saveNow(); }
    if (event.payload === 'folder') void switchFolder();
    if (event.payload === 'reload') void reloadFiles();
  });
  async function checkSyncedFiles(force = false) {
    if (document.hidden || checkingFiles || polling || unsaved || finance.isBusy() || document.querySelector('dialog[open]')) return;
    checkingFiles = true;
    try {
      const results = await Promise.allSettled([workspaceChanged(force), financeChanged()]);
      if (document.hidden || unsaved || finance.isBusy() || document.querySelector('dialog[open]')) return;
      if (results.some(result => result.status === 'fulfilled' && result.value)) { await reloadFiles(); return; }
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') { warning.textContent = `Could not check synced files: ${String(failed.reason)}`; warning.hidden = false; }
    } finally { checkingFiles = false; }
  }
  setInterval(() => void checkSyncedFiles(), 5000);

  applySettings(store.workspace.settings); tree.render(); tabs.render(); renderNote(); renderCount();
  try { const startup = store.workspace.settings.startupSection; if ((startup === 'last' ? await readLastSection() : startup) === 'finance') section(true); } catch { if (store.workspace.settings.startupSection === 'finance') section(true); }
  if (loaded.warning) { warning.textContent = loaded.warning; warning.hidden = false; }
  else saveNow();
}
