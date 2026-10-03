import type { Store } from '../state/workspace';
import type { Note } from '../types';
import { el, button, emptyState } from '../ui/dom';
import { icon } from '../ui/icons';
import { nameEmoji } from '../ui/emoji';

function highlight(text: string, query: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let start = 0;
  let index = lower.indexOf(query.toLowerCase());
  while (index >= 0) {
    fragment.append(document.createTextNode(text.slice(start, index)), el('mark', '', text.slice(index, index + query.length)));
    start = index + query.length; index = lower.indexOf(query.toLowerCase(), start);
  }
  fragment.append(document.createTextNode(text.slice(start)));
  return fragment;
}

function excerpt(note: Note, query: string): string {
  const plain = note.markdown.replace(/[`*_#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  const match = plain.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, match - 30);
  return (start > 0 ? '…' : '') + plain.slice(start, start + 110) + (plain.length > start + 110 ? '…' : '');
}

export function createSearch(input: HTMLInputElement, clear: HTMLButtonElement, results: HTMLElement, tree: HTMLElement, label: HTMLElement, filters: HTMLElement, store: Store, open: (id: string) => void) {
  const scopes = [
    { id: 'all', label: 'All', placeholder: 'Search anything…', hint: 'note names, contents, and folder paths' },
    { id: 'names', label: 'Names', placeholder: 'Search note names…', hint: 'note names' },
    { id: 'contents', label: 'Contents', placeholder: 'Search note contents…', hint: 'note contents' },
    { id: 'folders', label: 'Folders', placeholder: 'Search folder paths…', hint: 'folder paths' },
  ] as const;
  let scope: typeof scopes[number] = scopes[0];
  const controls = scopes.map(option => {
    const control = button(`Search in ${option.label.toLowerCase()}`, 'search-filter');
    control.textContent = option.label;
    control.setAttribute('aria-pressed', String(option.id === scope.id));
    control.onclick = () => {
      scope = option;
      controls.forEach((item, index) => item.setAttribute('aria-pressed', String(scopes[index].id === scope.id)));
      input.placeholder = scope.placeholder;
      input.setAttribute('aria-label', `Search ${scope.hint}`);
      clearTimeout(timer);
      render();
    };
    return control;
  });
  filters.replaceChildren(...controls);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    const query = input.value.trim();
    results.hidden = !query; tree.hidden = !!query; clear.hidden = !input.value;
    results.replaceChildren();
    if (!query) { label.textContent = 'Workspace'; return; }
    const lower = query.toLowerCase();
    const notes = Object.values(store.workspace.nodes).filter((node): node is Note => node.type === 'note')
      .filter(note => {
        const nameMatch = note.name.toLowerCase().includes(lower);
        const contentMatch = note.markdown.toLowerCase().includes(lower);
        const folderMatch = store.path(note.id).join(' / ').toLowerCase().includes(lower);
        if (scope.id === 'names') return nameMatch;
        if (scope.id === 'contents') return contentMatch;
        if (scope.id === 'folders') return folderMatch;
        return nameMatch || contentMatch || folderMatch;
      })
      .sort((a, b) => Number(b.name.toLowerCase().includes(lower)) - Number(a.name.toLowerCase().includes(lower)) || a.name.localeCompare(b.name));
    label.textContent = `${notes.length} ${notes.length === 1 ? 'result' : 'results'}`;
    if (!notes.length) { results.append(emptyState('No matching notes', `Searching ${scope.hint}. Try another word or change the filter.`)); return; }
    for (const note of notes) {
      const control = button(`Open ${note.name}`, `search-result${store.workspace.activeNoteId === note.id ? ' is-active' : ''}`);
      const title = el('span', 'result-title');
      if (!nameEmoji(note.name)) title.append(icon('note'));
      title.append(highlight(note.name, query));
      const preview = el('span', 'result-excerpt'); preview.append(highlight(excerpt(note, query), query));
      const path = store.path(note.id);
      control.append(title, preview);
      if (path.length) {
        const location = el('span', 'result-path');
        location.append(highlight(path.join(' / '), query));
        control.append(location);
      }
      control.onclick = () => open(note.id); results.append(control);
    }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 90); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { clearTimeout(timer); render(); event.preventDefault(); results.querySelector('button')?.focus(); }
    if (event.key === 'Escape') { input.value = ''; render(); input.blur(); }
    if (event.key === 'Enter') { clearTimeout(timer); render(); results.querySelector('button')?.click(); }
  });
  results.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const controls = Array.from(results.querySelectorAll('button'));
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) input.focus(); else controls[Math.min(next, controls.length - 1)]?.focus();
  });
  clear.onclick = () => { input.value = ''; render(); input.focus(); };
  return {
    render,
    focus() { input.focus(); input.select(); },
    reset() { clearTimeout(timer); input.value = ''; render(); },
  };
}
