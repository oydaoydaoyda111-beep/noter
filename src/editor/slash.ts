import { button, el } from '../ui/dom';
import { currentBlock, selectionRange, textBeforeCaret } from './selection';

const commands = [
  { style: 'p', name: 'Text', hint: 'A simple paragraph', badge: 'T', keywords: 'paragraph plain text' },
  { style: 'h1', name: 'Heading 1', hint: 'A large section heading', badge: 'H1', keywords: 'h1 title heading' },
  { style: 'h2', name: 'Heading 2', hint: 'A medium section heading', badge: 'H2', keywords: 'h2 subtitle heading' },
  { style: 'h3', name: 'Heading 3', hint: 'A small section heading', badge: 'H3', keywords: 'h3 heading' },
  { style: 'ul', name: 'Bullet list', hint: 'Keep a few ideas together', badge: '•', keywords: 'ul unordered bullets list' },
  { style: 'ol', name: 'Numbered list', hint: 'Steps in a natural order', badge: '1.', keywords: 'ol ordered numbered list' },
  { style: 'blockquote', name: 'Quote', hint: 'Give a thought some emphasis', badge: '❝', keywords: 'blockquote quote' },
  { style: 'pre', name: 'Code block', hint: 'Code with syntax highlighting', badge: '<>', keywords: 'pre code snippet' },
  { style: 'hr', name: 'Divider', hint: 'A little space between ideas', badge: '—', keywords: 'hr divider horizontal rule separator' },
  { style: 'database', name: 'Database', hint: 'A table with typed properties', badge: '▦', keywords: 'database table rows properties' },
] as const;

export function createSlashMenu(root: HTMLElement, onSelect: (style: typeof commands[number]['style'], range: Range) => void, enabled: () => boolean) {
  const menu = el('div', 'slash-menu');
  const list = el('div', 'slash-options');
  const caption = el('div', 'slash-caption', 'INSERT A BLOCK');
  menu.append(caption, list, el('div', 'slash-footer', '↑ ↓ Navigate   ·   ↵ Insert   ·   Esc Close'));
  list.id = 'slash-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Insert a block');
  menu.hidden = true; document.body.append(menu);
  let frame = 0;
  let active = 0;
  let matches: (typeof commands[number])[] = [];
  let queryText: string | null = null;
  let queryBlock: HTMLElement | null = null;
  let dismissed: { text: string; block: HTMLElement } | null = null;

  function query() {
    if (!enabled() || document.activeElement !== root || document.querySelector('dialog[open]')) return null;
    const range = selectionRange(root);
    const block = currentBlock(root);
    if (!range?.collapsed || !block || block.tagName !== 'P' || block.closest('pre')) return null;
    const before = textBeforeCaret(block, range).replace(/\u200b/g, '');
    const match = before.match(/^\/([^\n/]{0,40})$/);
    if (!match || before !== block.textContent?.replace(/\u200b/g, '')) return null;
    const prefix = range.cloneRange(); prefix.setStart(block, 0);
    return { text: match[1].toLowerCase().trim(), block, range, prefix };
  }

  function hide() {
    menu.hidden = true;
    root.removeAttribute('aria-controls'); root.removeAttribute('aria-activedescendant'); root.removeAttribute('aria-expanded');
    queryText = null; queryBlock = null;
  }

  function pick(index: number) {
    const current = query();
    const command = matches[index];
    if (!current || !command) { hide(); return; }
    hide(); dismissed = null; onSelect(command.style, current.prefix);
  }

  function markActive() {
    const options = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
    const option = options[active];
    if (option) {
      root.setAttribute('aria-activedescendant', option.id);
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    } else root.removeAttribute('aria-activedescendant');
  }

  function render(current: NonNullable<ReturnType<typeof query>>) {
    if (current.text !== queryText || current.block !== queryBlock) {
      queryText = current.text; queryBlock = current.block; active = 0;
      matches = commands.filter(command => `${command.name} ${command.keywords}`.toLowerCase().includes(current.text));
      list.replaceChildren();
      matches.forEach((command, index) => {
        const option = button(command.name, 'slash-option'); option.tabIndex = -1;
        option.id = `slash-option-${index}`; option.setAttribute('role', 'option');
        const copy = el('span', 'slash-option-copy'); copy.append(el('span', 'slash-option-name', command.name), el('span', 'slash-option-hint', command.hint));
        option.append(el('span', 'slash-badge', command.badge), copy);
        option.addEventListener('mousedown', event => event.preventDefault());
        option.onmouseenter = () => { active = index; markActive(); };
        option.onclick = () => pick(index); list.append(option);
      });
      if (!matches.length) list.append(el('p', 'slash-empty', 'No matching blocks. Try “heading” or “code”.'));
    }
    menu.hidden = false;
    root.setAttribute('aria-controls', list.id); root.setAttribute('aria-expanded', 'true');
    const scroller = root.closest<HTMLElement>('.editor-scroll') ?? root;
    const bounds = scroller.getBoundingClientRect();
    const anchor = current.range.getClientRects()[0] ?? current.block.getBoundingClientRect();
    const topEdge = Math.max(8, bounds.top + 8);
    const bottomEdge = Math.min(innerHeight - 8, bounds.bottom - 8);
    if (anchor.bottom < topEdge || anchor.top > bottomEdge) { hide(); return; }
    const below = bottomEdge - anchor.bottom - 9;
    const above = anchor.top - topEdge - 9;
    const useBelow = below >= Math.min(260, above);
    const space = useBelow ? below : above;
    if (space < 115) { hide(); return; }
    menu.style.maxHeight = `${Math.min(410, space)}px`;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(bounds.left + 8, Math.min(anchor.left, Math.min(bounds.right, innerWidth) - rect.width - 8));
    const top = useBelow ? anchor.bottom + 9 : anchor.top - rect.height - 9;
    menu.style.left = `${Math.round(left)}px`; menu.style.top = `${Math.round(top)}px`;
    markActive();
  }

  function update() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const current = query();
      if (!current) { hide(); dismissed = null; return; }
      if (dismissed?.text === current.text && dismissed.block === current.block) { hide(); return; }
      render(current);
    });
  }

  root.addEventListener('blur', hide);
  document.addEventListener('pointerdown', event => {
    if (menu.hidden || menu.contains(event.target as Node)) return;
    const current = query();
    if (current) dismissed = { text: current.text, block: current.block };
    hide();
  });
  root.closest('.editor-scroll')?.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);

  return {
    update,
    reset() { hide(); dismissed = null; },
    handleKey(event: KeyboardEvent) {
      if (menu.hidden || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'Escape') {
        const current = query();
        if (current) dismissed = { text: current.text, block: current.block };
        hide(); event.preventDefault(); return true;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        markActive(); event.preventDefault(); return true;
      }
      if (event.key === 'Enter' && !event.shiftKey && matches.length) {
        event.preventDefault(); pick(active); return true;
      }
      return false;
    },
  };
}
