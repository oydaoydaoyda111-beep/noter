import { button, el } from '../ui/dom';
import { currentBlock, selectionRange, textBeforeCaret } from './selection';

export interface NoteMatch { target: string; name: string; detail: string }
export interface NoteLinks {
  search(query: string): NoteMatch[];
  resolve(target: string): string | null;
  open(target: string): void;
}

/** Suggests notes after `[[`; picking one replaces the typed `[[query` with a note link. */
export function createLinkPicker(root: HTMLElement, links: NoteLinks, onPick: (target: string, typed: number) => void, enabled: () => boolean) {
  const menu = el('div', 'slash-menu link-menu');
  const list = el('div', 'slash-options');
  menu.append(el('div', 'slash-caption', 'LINK TO A NOTE'), list, el('div', 'slash-footer', '↑ ↓ Navigate   ·   ↵ Link   ·   Esc Close'));
  list.id = 'link-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Link to a note');
  menu.hidden = true; document.body.append(menu);
  let frame = 0, active = 0;
  let matches: NoteMatch[] = [];
  let dismissed: string | null = null;

  function query() {
    if (!enabled() || document.activeElement !== root) return null;
    const range = selectionRange(root);
    const block = currentBlock(root);
    if (!range?.collapsed || !block || block.closest('pre,code')) return null;
    const before = textBeforeCaret(block, range).replace(/​/g, '');
    const match = before.match(/(?<!\\)\[\[([^[\]\n|]{0,60})$/);
    return match ? { text: match[1], typed: match[0].length, range, key: `${before.length}:${match[1]}` } : null;
  }

  function hide() {
    menu.hidden = true; root.removeAttribute('aria-activedescendant');
  }

  function pick(index: number) {
    const current = query(), choice = matches[index];
    hide();
    if (current && choice) onPick(choice.target, current.typed);
  }

  function markActive() {
    list.querySelectorAll('[role="option"]').forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
    const option = list.children[active] as HTMLElement | undefined;
    if (option?.id) { root.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
  }

  function render(current: NonNullable<ReturnType<typeof query>>) {
    const text = current.text.trim();
    matches = links.search(text);
    if (text && !matches.some(match => match.name.toLowerCase() === text.toLowerCase())) matches.push({ target: text, name: `Create “${text}”`, detail: 'New note when you open the link' });
    active = Math.min(active, Math.max(0, matches.length - 1));
    list.replaceChildren();
    matches.forEach((match, index) => {
      const option = button(match.name, 'slash-option'); option.tabIndex = -1;
      option.id = `link-option-${index}`; option.setAttribute('role', 'option');
      const copy = el('span', 'slash-option-copy'); copy.append(el('span', 'slash-option-name', match.name), el('span', 'slash-option-hint', match.detail));
      option.append(el('span', 'slash-badge', '↗'), copy);
      option.addEventListener('mousedown', event => event.preventDefault());
      option.onmouseenter = () => { active = index; markActive(); };
      option.onclick = () => pick(index);
      list.append(option);
    });
    if (!matches.length) list.append(el('p', 'slash-empty', 'Type a note name.'));
    menu.hidden = false;
    const anchor = current.range.getClientRects()[0] ?? root.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    const below = innerHeight - anchor.bottom - 9 >= rect.height;
    menu.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8)))}px`;
    menu.style.top = `${Math.round(below ? anchor.bottom + 9 : Math.max(8, anchor.top - rect.height - 9))}px`;
    markActive();
  }

  function update() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const current = query();
      if (!current || current.key === dismissed) { hide(); if (!current) dismissed = null; return; }
      render(current);
    });
  }

  root.addEventListener('blur', hide);
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target as Node)) { dismissed = query()?.key ?? null; hide(); } });

  return {
    update,
    reset() { hide(); dismissed = null; active = 0; },
    handleKey(event: KeyboardEvent) {
      if (menu.hidden || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'Escape') { dismissed = query()?.key ?? null; hide(); event.preventDefault(); return true; }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        markActive(); event.preventDefault(); return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && matches.length) { event.preventDefault(); pick(active); return true; }
      return false;
    },
  };
}
