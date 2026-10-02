import type { Store } from '../state/workspace';
import type { Note } from '../types';
import { el, button, emptyState } from '../ui/dom';
import { icon } from '../ui/icons';

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

export function createSearch(input: HTMLInputElement, clear: HTMLButtonElement, results: HTMLElement, tree: HTMLElement, label: HTMLElement, store: Store, open: (id: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    const query = input.value.trim();
    results.hidden = !query; tree.hidden = !!query; clear.hidden = !input.value;
    results.replaceChildren();
    if (!query) { label.textContent = 'Workspace'; return; }
    const lower = query.toLowerCase();
    const notes = Object.values(store.workspace.nodes).filter((node): node is Note => node.type === 'note')
      .filter(note => note.name.toLowerCase().includes(lower) || note.markdown.toLowerCase().includes(lower))
      .sort((a, b) => Number(b.name.toLowerCase().includes(lower)) - Number(a.name.toLowerCase().includes(lower)) || a.name.localeCompare(b.name));
    label.textContent = `${notes.length} ${notes.length === 1 ? 'result' : 'results'}`;
    if (!notes.length) { results.append(emptyState('Nothing here yet', 'Try another word. Search looks through every note.')); return; }
    for (const note of notes) {
      const control = button(`Open ${note.name}`, `search-result${store.workspace.activeNoteId === note.id ? ' is-active' : ''}`);
      const title = el('span', 'result-title'); title.append(icon('note'), highlight(note.name, query));
      const preview = el('span', 'result-excerpt'); preview.append(highlight(excerpt(note, query), query));
      const path = store.path(note.id);
      control.append(title, preview);
      if (path.length) control.append(el('span', 'result-path', path.join(' / ')));
      control.onclick = () => open(note.id); results.append(control);
    }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 90); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); }
    if (event.key === 'Escape') { input.value = ''; render(); input.blur(); }
    if (event.key === 'Enter') results.querySelector('button')?.click();
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
