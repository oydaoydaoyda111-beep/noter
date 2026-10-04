import { copyText, openExternal } from '../desktop/platform';
import { el, button } from '../ui/dom';
import { icon } from '../ui/icons';
import { askDialog } from '../ui/dialog';
import { codeText, domToMarkdown, inlineDom, markdownToDom, safeUrl } from './markdown';
import { bookmark, caretAt, currentBlock, restoreBookmark, selectionRange, setRange, textBeforeCaret } from './selection';
import { createHistory } from './history';
import { codeLanguage, codeLanguages, highlightCodeBlocks } from './syntax';
import { createSlashMenu } from './slash';
import { createDatabaseBlock, hydrateDatabases } from '../database/database';
import { newDatabase } from '../database/model';

type BlockStyle = 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'blockquote' | 'pre' | 'hr' | 'database';
type Mark = 'strong' | 'em' | 'code';

function blankParagraph(): HTMLParagraphElement {
  const paragraph = el('p');
  paragraph.append(el('br'));
  return paragraph;
}

function emptyBlock(block: HTMLElement): boolean {
  return !(block.textContent ?? '').replace(/[\u200b\s]/g, '');
}

function visibleText(text: string | null): string {
  return (text ?? '').replace(/\u200b/g, '');
}

export function createEditor(root: HTMLElement, toolbar: HTMLElement, onChange: (markdown: string) => void) {
  root.contentEditable = 'true';
  root.spellcheck = true;
  root.setAttribute('role', 'textbox');
  root.setAttribute('aria-multiline', 'true');
  root.setAttribute('aria-label', 'Note content');
  root.dataset.placeholder = 'Start with a thought…';
  let savedRange: Range | null = null;
  let currentId: string | null = null;
  let composing = false;
  const positions = new Map<string, ReturnType<typeof bookmark>>();
  const markButtons = new Map<Mark, HTMLButtonElement[]>();
  const floating = el('div', 'floating-toolbar');
  floating.setAttribute('role', 'toolbar');
  floating.setAttribute('aria-label', 'Selection formatting');
  floating.hidden = true;
  document.body.append(floating);
  const codeLayer = el('div', 'code-block-controls');
  const page = root.parentElement!;
  page.append(codeLayer);
  const codeHeaders = new Map<HTMLPreElement, { header: HTMLElement; language: HTMLSelectElement; timer?: ReturnType<typeof setTimeout> }>();
  let syntaxTimer: ReturnType<typeof setTimeout> | undefined;
  let codeFrame = 0;
  let floatingFrame = 0;
  let dismissedRange: Range | null = null;
  let selectingWithPointer = false;
  const styleSelect = el('select', 'block-select');
  styleSelect.setAttribute('aria-label', 'Block formatting');
  const styles: [BlockStyle, string][] = [
    ['p', 'Text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'],
    ['ul', 'Bullet list'], ['ol', 'Numbered list'], ['blockquote', 'Quote'], ['pre', 'Code block'], ['hr', 'Divider'], ['database', 'Database'],
  ];
  styles.forEach(([value, label]) => {
    const option = el('option', '', label); option.value = value; styleSelect.append(option);
  });
  toolbar.append(styleSelect, el('span', 'toolbar-divider'));

  const change = () => {
    hydrateDatabases(root);
    const markdown = domToMarkdown(root);
    root.classList.toggle('is-empty', !markdown);
    onChange(markdown);
    refreshToolbar();
    scheduleCodeHeaders();
    scheduleSyntax();
  };
  const history = createHistory(root, change);
  const slashMenu = createSlashMenu(root, (style, range) => {
    history.record(true); range.deleteContents(); range.collapse(true); setRange(range);
    savedRange = range.cloneRange(); applyBlock(style, false);
  }, () => !composing);

  function updateSyntax() {
    clearTimeout(syntaxTimer);
    if (composing || selectingWithPointer) return;
    const position = bookmark(root);
    if (highlightCodeBlocks(root)) {
      restoreBookmark(root, position);
      savedRange = selectionRange(root)?.cloneRange() ?? savedRange;
      refreshToolbar();
    }
  }

  function scheduleSyntax() {
    clearTimeout(syntaxTimer);
    if (!composing) syntaxTimer = setTimeout(updateSyntax, 160);
  }

  function scheduleCodeHeaders() {
    if (codeFrame) return;
    codeFrame = requestAnimationFrame(() => { codeFrame = 0; renderCodeHeaders(); });
  }

  function renderCodeHeaders() {
    for (const [pre, entry] of codeHeaders) {
      if (root.contains(pre)) continue;
      clearTimeout(entry.timer); entry.header.remove(); codeHeaders.delete(pre);
    }
    const bounds = codeLayer.getBoundingClientRect();
    for (const pre of root.querySelectorAll('pre')) {
      let entry = codeHeaders.get(pre);
      if (!entry) {
        const header = el('div', 'code-block-header');
        const language = el('select', 'code-block-language');
        language.setAttribute('aria-label', 'Code block language');
        for (const [value, name] of codeLanguages) {
          const option = el('option', '', name); option.value = value; language.append(option);
        }
        language.onchange = () => {
          history.record(true); pre.dataset.language = language.value;
          updateSyntax(); change();
        };
        const copy = button('Copy code', 'code-copy-button');
        const label = el('span', 'code-copy-label', 'Copy');
        label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
        copy.append(icon('copy'), label);
        copy.addEventListener('mousedown', event => event.preventDefault());
        copy.onclick = async () => {
          const current = codeHeaders.get(pre);
          if (!current || !root.contains(pre)) return;
          clearTimeout(current.timer); copy.disabled = true;
          try {
            await copyText(codeText(pre));
            label.textContent = 'Copied'; copy.replaceChild(icon('check'), copy.firstChild!);
            copy.dataset.state = 'copied';
          } catch {
            label.textContent = 'Copy failed'; copy.replaceChild(icon('copy'), copy.firstChild!); copy.dataset.state = 'error';
          } finally {
            copy.disabled = false;
            if (codeHeaders.get(pre) === current) current.timer = setTimeout(() => {
              label.textContent = 'Copy'; copy.replaceChild(icon('copy'), copy.firstChild!); delete copy.dataset.state;
            }, 2200);
          }
        };
        header.append(language, copy); codeLayer.append(header);
        entry = { header, language }; codeHeaders.set(pre, entry);
      }
      const language = codeLanguage(pre.dataset.language || 'code');
      if (!Array.from(entry.language.options).some(option => option.value === language)) {
        const option = el('option', '', `${language} (plain text)`); option.value = language; entry.language.append(option);
      }
      entry.language.value = language;
      entry.language.title = `Code language: ${entry.language.selectedOptions[0]?.textContent}`;
      const rect = pre.getBoundingClientRect();
      entry.header.style.transform = `translate(${rect.left - bounds.left + 1}px, ${rect.top - bounds.top + 1}px)`;
      entry.header.style.width = `${Math.max(0, rect.width - 2)}px`;
      entry.header.hidden = rect.width === 0;
    }
  }

  new ResizeObserver(scheduleCodeHeaders).observe(page);

  function rememberSelection() {
    const range = selectionRange(root);
    if (range) { savedRange = range.cloneRange(); refreshToolbar(); }
    scheduleFloating();
    slashMenu.update();
  }

  function scheduleFloating() {
    if (floatingFrame) return;
    floatingFrame = requestAnimationFrame(() => { floatingFrame = 0; positionFloating(); });
  }

  function positionFloating() {
    const range = selectionRange(root);
    const focused = document.activeElement;
    if (!range || range.collapsed || !range.toString().trim() || composing || selectingWithPointer || !document.hasFocus() || document.querySelector('dialog[open]')
      || (focused instanceof Element && !!focused.closest('.database-block'))
      || !(focused === root || root.contains(focused) || floating.contains(focused))) {
      floating.hidden = true;
      if (!range || range.collapsed) dismissedRange = null;
      return;
    }
    if (dismissedRange && range.compareBoundaryPoints(Range.START_TO_START, dismissedRange) === 0
      && range.compareBoundaryPoints(Range.END_TO_END, dismissedRange) === 0) {
      floating.hidden = true; return;
    }
    if (Array.from(root.querySelectorAll('pre')).some(pre => range.intersectsNode(pre))) { floating.hidden = true; return; }
    const scroller = root.closest<HTMLElement>('.editor-scroll') ?? root;
    const bounds = scroller.getBoundingClientRect();
    const leftEdge = Math.max(8, bounds.left + 8);
    const rightEdge = Math.min(innerWidth - 8, bounds.right - 8);
    const topEdge = Math.max(8, bounds.top + 8);
    const bottomEdge = Math.min(innerHeight - 8, bounds.bottom - 8);
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > topEdge && rect.top < bottomEdge && rect.right > leftEdge && rect.left < rightEdge);
    const anchor = rects[0];
    if (!anchor) { floating.hidden = true; return; }
    const wasHidden = floating.hidden;
    if (wasHidden) floating.style.visibility = 'hidden';
    floating.hidden = false;
    const { width, height } = floating.getBoundingClientRect();
    if (rightEdge - leftEdge < width || bottomEdge - topEdge < height) { floating.hidden = true; floating.style.visibility = ''; return; }
    const center = (Math.max(anchor.left, leftEdge) + Math.min(anchor.right, rightEdge)) / 2;
    const left = Math.max(leftEdge, Math.min(center - width / 2, rightEdge - width));
    let top = anchor.top - height - 10;
    if (top < topEdge) top = anchor.bottom + 10;
    top = Math.max(topEdge, Math.min(top, bottomEdge - height));
    floating.style.left = `${Math.round(left)}px`;
    floating.style.top = `${Math.round(top)}px`;
    floating.style.visibility = '';
  }

  function dismissFloating() {
    dismissedRange = selectionRange(root)?.cloneRange() ?? null;
    floating.hidden = true;
  }

  function restoreSelection() {
    root.focus({ preventScroll: true });
    if (savedRange && root.contains(savedRange.startContainer)) setRange(savedRange);
    else caretAt(root.lastElementChild ?? root, true);
  }

  function refreshToolbar() {
    const range = selectionRange(root);
    if (!range) return;
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const block = currentBlock(root);
    let style = block?.tagName.toLowerCase() ?? 'p';
    if (element?.closest('pre')) style = 'pre';
    else if (element?.closest('li')) style = element.closest('li')?.parentElement?.tagName.toLowerCase() ?? 'ul';
    else if (element?.closest('blockquote')) style = 'blockquote';
    styleSelect.value = style === 'div' ? 'p' : style;
    markButtons.forEach((controls, tag) => {
      const active = !!element?.closest(tag === 'strong' ? 'strong,b' : tag === 'em' ? 'em,i' : 'code');
      controls.forEach(control => {
        control.classList.toggle('is-active', active);
        control.setAttribute('aria-pressed', String(active));
      });
    });
  }

  function normalize() {
    const selection = selectionRange(root);
    const position = bookmark(root);
    const start = selection ? { node: selection.startContainer, offset: selection.startOffset } : null;
    const end = selection ? { node: selection.endContainer, offset: selection.endOffset } : null;
    const replacements = new Map<Node, Node>();
    let changed = false;
    const isInline = (node: Node) => node.nodeType === Node.TEXT_NODE || (node instanceof Element && !node.matches('p,h1,h2,h3,div,ul,ol,blockquote,pre,hr,.database-block'));
    for (const child of Array.from(root.childNodes)) {
      if (child.parentNode !== root) continue;
      if (isInline(child)) {
        const paragraph = el('p'); child.before(paragraph);
        let inline: ChildNode | null = child;
        while (inline && isInline(inline)) {
          const next: ChildNode | null = inline.nextSibling;
          paragraph.append(inline); inline = next;
        }
        changed = true;
      } else if (child instanceof HTMLDivElement && !child.querySelector('p,pre,ul,ol,blockquote,.database-block')) {
        const paragraph = el('p'); paragraph.append(...child.childNodes); child.replaceWith(paragraph);
        replacements.set(child, paragraph); changed = true;
      }
    }
    if (!root.childNodes.length) { root.append(blankParagraph()); changed = true; }
    if (root.lastElementChild?.tagName === 'HR') root.append(blankParagraph());
    if (changed && start && end) {
      const startNode = replacements.get(start.node) ?? start.node;
      const endNode = replacements.get(end.node) ?? end.node;
      // Moving a text node resets a live Range; restore its original boundaries.
      if (startNode !== root && endNode !== root && root.contains(startNode) && root.contains(endNode)) {
        const restored = document.createRange();
        const limit = (node: Node) => node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length;
        restored.setStart(startNode, Math.min(start.offset, limit(startNode)));
        restored.setEnd(endNode, Math.min(end.offset, limit(endNode)));
        setRange(restored);
      } else restoreBookmark(root, position);
    }
  }

  function topLevel(block: HTMLElement): HTMLElement {
    let element = block;
    while (element.parentElement && element.parentElement !== root) element = element.parentElement;
    return element;
  }

  function exitStructured(block: HTMLElement): HTMLElement {
    const paragraph = el('p');
    paragraph.append(...Array.from(block.childNodes).filter(child => !(child instanceof Element && ['UL', 'OL'].includes(child.tagName))));
    if (!paragraph.childNodes.length) paragraph.append(el('br'));
    if (block.tagName === 'LI') {
      const list = block.parentElement!;
      const remaining = list.cloneNode(false) as HTMLElement;
      while (block.nextSibling) remaining.append(block.nextSibling);
      list.after(paragraph);
      if (remaining.childNodes.length) paragraph.after(remaining);
      block.remove();
      if (!list.children.length) list.remove();
    } else if (block.parentElement?.tagName === 'BLOCKQUOTE') {
      const quote = block.parentElement;
      const remaining = el('blockquote');
      while (block.nextSibling) remaining.append(block.nextSibling);
      quote.after(paragraph);
      if (remaining.childNodes.length) paragraph.after(remaining);
      block.remove();
      if (!quote.childNodes.length) quote.remove();
    } else block.replaceWith(paragraph);
    caretAt(paragraph);
    return paragraph;
  }

  function applyBlock(style: BlockStyle, recordHistory = true) {
    restoreSelection();
    if (recordHistory) history.record(true);
    let block = currentBlock(root) ?? root.firstElementChild as HTMLElement;
    if (!block) return;
    const position = bookmark(root);
    if (style === 'database') {
      const database = createDatabaseBlock(newDatabase());
      const next = blankParagraph();
      if (emptyBlock(block) && block.parentElement === root) block.replaceWith(database, next);
      else topLevel(block).after(database, next);
      caretAt(next); change(); rememberSelection(); return;
    }
    if (style === 'hr') {
      const rule = el('hr'); rule.contentEditable = 'false';
      const next = blankParagraph();
      if (emptyBlock(block) && block.parentElement === root) block.replaceWith(rule, next);
      else topLevel(block).after(rule, next);
      caretAt(next); change(); rememberSelection(); return;
    }
    if (style === 'pre') {
      const pre = el('pre'); pre.dataset.language = 'code';
      const text = block.tagName === 'PRE' ? codeText(block) : (block.textContent ?? '').replace(/\u200b/g, '');
      const code = el('code', '', text);
      if (!text || text.endsWith('\n')) code.append(el('br'));
      pre.append(code);
      if (block.tagName === 'LI' || block.parentElement?.tagName === 'BLOCKQUOTE') block = exitStructured(block);
      block.replaceWith(pre); caretAt(code, true);
    } else if (style === 'ul' || style === 'ol') {
      if (block.tagName === 'LI') {
        const list = block.parentElement!;
        const next = el(style); next.append(...list.childNodes); list.replaceWith(next);
        restoreBookmark(root, position);
      } else {
        const list = el(style);
        const item = el('li'); item.append(...block.childNodes); list.append(item);
        block.replaceWith(list); restoreBookmark(root, position);
      }
    } else if (style === 'blockquote') {
      if (!block.closest('blockquote')) { const quote = el('blockquote'); block.replaceWith(quote); quote.append(block); }
      placeCaret(block, position);
    } else {
      if (block.tagName === 'LI' || block.parentElement?.tagName === 'BLOCKQUOTE') block = exitStructured(block);
      const next = el(style);
      if (block.tagName === 'PRE') next.textContent = codeText(block);
      else next.append(...block.childNodes);
      block.replaceWith(next); placeCaret(next, position);
    }
    change(); rememberSelection();
  }

  // Chromium cannot place a caret in a block without a line box, so typing would land in the previous block.
  function placeCaret(block: HTMLElement, position: ReturnType<typeof bookmark>) {
    if (emptyBlock(block) && !block.querySelector('br')) { block.replaceChildren(el('br')); caretAt(block); }
    else restoreBookmark(root, position);
  }

  // A caret placed after an inline element is moved back inside it by Chromium; a zero-width text node keeps typing outside.
  function caretAfterMark(mark: Node) {
    const tail = document.createTextNode('\u200b');
    mark.parentNode?.insertBefore(tail, mark.nextSibling);
    const range = document.createRange(); range.setStart(tail, 1); range.collapse(true); setRange(range);
  }

  function applyMark(tag: Mark) {
    restoreSelection();
    const range = selectionRange(root);
    if (!range || currentBlock(root)?.closest('pre')) return;
    history.record(true);
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const selector = tag === 'strong' ? 'strong,b' : tag === 'em' ? 'em,i' : 'code';
    if (range.collapsed) {
      const existing = element?.closest(selector);
      const after = existing ? range.cloneRange() : null;
      after?.setEnd(existing!, existing!.childNodes.length);
      if (existing && root.contains(existing) && after && visibleText(existing.textContent) && !visibleText(after.toString())) {
        // Toggling at the end of formatted text ends the format for what is typed next.
        caretAfterMark(existing);
      } else if (existing && root.contains(existing)) {
        const position = bookmark(root);
        existing.replaceWith(...existing.childNodes); restoreBookmark(root, position);
      } else {
        const mark = el(tag); const text = document.createTextNode('\u200b');
        mark.append(text); range.insertNode(mark); caretAt(text, true);
      }
    } else {
      const position = bookmark(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode as Text);
      const remove = nodes.length > 0 && nodes.every(node => node.parentElement?.closest(selector));
      for (const node of nodes.reverse()) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        const existing = node.parentElement?.closest(selector);
        if (end <= start || (!remove && existing)) continue;
        if (end < node.length) node.splitText(end);
        const selected = start > 0 ? node.splitText(start) : node;
        if (remove && existing) {
          const tail = document.createRange();
          tail.selectNodeContents(existing); tail.setStartAfter(selected);
          const after = existing.cloneNode(false) as Element;
          after.append(tail.extractContents());
          const ancestors: Element[] = [];
          for (let parent = selected.parentElement; parent && parent !== existing; parent = parent.parentElement) ancestors.push(parent);
          let unmarked: Node = selected;
          for (const ancestor of ancestors) {
            const copy = ancestor.cloneNode(false); copy.appendChild(unmarked); unmarked = copy;
          }
          existing.after(unmarked);
          if (after.textContent || after.querySelector('br')) (unmarked as ChildNode).after(after);
          if (!existing.textContent && !existing.querySelector('br')) existing.remove();
        } else {
          const mark = el(tag); selected.replaceWith(mark); mark.append(selected);
        }
      }
      restoreBookmark(root, position);
    }
    change(); rememberSelection();
  }

  async function insertLink() {
    rememberSelection();
    const range = savedRange?.cloneRange();
    const element = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
    const existing = element?.closest('a');
    const result = await askDialog({
      title: existing ? 'Edit link' : 'Add a link', submit: 'Save link',
      fields: [
        { name: 'text', label: 'Link text', value: range?.toString() || existing?.textContent || '', placeholder: 'Something worth visiting' },
        { name: 'url', label: 'URL', value: existing?.getAttribute('href') ?? 'https://', placeholder: 'https://example.com' },
      ],
    });
    if (!result) { restoreSelection(); return; }
    const href = safeUrl(result.url);
    if (!href) {
      await askDialog({ title: 'Use a valid link', description: 'Links can start with https://, http://, mailto:, or #.', submit: 'Got it' });
      restoreSelection(); return;
    }
    restoreSelection(); history.record(true);
    const link = el('a', '', result.text); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    if (existing && root.contains(existing)) existing.replaceWith(link);
    else { const current = selectionRange(root)!; current.deleteContents(); current.insertNode(link); }
    const after = document.createRange(); after.setStartAfter(link); after.collapse(true); setRange(after);
    change(); rememberSelection();
  }

  function addFormattingControls(container: HTMLElement) {
    for (const [tag, label, symbol] of [
      ['strong', 'Bold (Ctrl / ⌘ B)', 'bold'], ['em', 'Italic (Ctrl / ⌘ I)', 'italic'], ['code', 'Inline code', 'code'],
    ] as const) {
      const control = button(label, 'format-button'); control.append(icon(symbol));
      control.setAttribute('aria-pressed', 'false');
      control.addEventListener('mousedown', event => event.preventDefault());
      control.onclick = () => applyMark(tag); container.append(control);
      markButtons.set(tag, [...(markButtons.get(tag) ?? []), control]);
    }
    if (container === floating) container.append(el('span', 'toolbar-divider'));
    const linkButton = button('Add link (Ctrl / ⌘ K)', 'format-button'); linkButton.append(icon('link'));
    linkButton.addEventListener('mousedown', event => event.preventDefault());
    linkButton.onclick = () => void insertLink(); container.append(linkButton);
  }
  addFormattingControls(toolbar);
  addFormattingControls(floating);
  const dividerButton = button('Insert horizontal divider', 'format-button');
  dividerButton.append(icon('divider'));
  dividerButton.addEventListener('mousedown', event => event.preventDefault());
  dividerButton.onclick = () => applyBlock('hr');
  toolbar.append(el('span', 'toolbar-divider'), dividerButton);
  styleSelect.onchange = () => applyBlock(styleSelect.value as BlockStyle);
  floating.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dismissFloating(); restoreSelection(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const controls = Array.from(floating.querySelectorAll('button'));
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  });
  document.addEventListener('focusin', scheduleFloating);
  root.addEventListener('pointerdown', () => { selectingWithPointer = true; floating.hidden = true; });
  const finishPointerSelection = () => {
    if (!selectingWithPointer) return;
    selectingWithPointer = false; rememberSelection(); scheduleSyntax();
  };
  document.addEventListener('pointerup', finishPointerSelection);
  document.addEventListener('pointercancel', finishPointerSelection);
  document.addEventListener('pointerdown', event => {
    if (!root.contains(event.target as Node) && !floating.contains(event.target as Node)) floating.hidden = true;
  });
  root.closest('.editor-scroll')?.addEventListener('scroll', scheduleFloating, { passive: true });
  window.addEventListener('resize', scheduleFloating);
  window.addEventListener('blur', () => { selectingWithPointer = false; floating.hidden = true; });
  window.addEventListener('focus', scheduleFloating);

  function replaceTextBefore(range: Range, block: HTMLElement, length: number, fragment: DocumentFragment) {
    const before = textBeforeCaret(block, range).replace(/\u00a0/g, ' ');
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let offset = 0;
    const replacement = range.cloneRange();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (offset + text.length >= before.length - length) {
        replacement.setStart(text, Math.max(0, before.length - length - offset)); break;
      }
      offset += text.length;
    }
    const last = fragment.lastChild;
    replacement.deleteContents(); replacement.insertNode(fragment);
    if (last instanceof Element) caretAfterMark(last);
    else if (last) { const after = document.createRange(); after.setStartAfter(last); after.collapse(true); setRange(after); }
  }

  function shortcuts() {
    const range = selectionRange(root);
    const block = currentBlock(root);
    if (!range?.collapsed || !block || block.closest('pre')) return;
    const before = textBeforeCaret(block, range).replace(/\u00a0/g, ' ');
    if (['P', 'DIV'].includes(block.tagName)) {
      const prefix = before.match(/^(#{1,3}|[-+*]|\d+\.|>) $/);
      if (prefix) {
        history.record(true);
        const remove = range.cloneRange(); remove.setStart(block, 0); remove.deleteContents();
        savedRange = selectionRange(root)?.cloneRange() ?? null;
        const style: BlockStyle = prefix[1][0] === '#' ? `h${prefix[1].length}` as BlockStyle
          : prefix[1] === '>' ? 'blockquote' : /^\d/.test(prefix[1]) ? 'ol' : 'ul';
        applyBlock(style, false); return;
      }
    }
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    if (element?.closest('code,a')) return;
    for (const pattern of [/\*\*[^*\n]+\*\*$/, /(?<!\*)\*[^*\n]+\*$/, /`[^`\n]+`$/, /\[[^\]\n]+\]\([^\s)]+\)$/]) {
      const match = before.match(pattern);
      if (match && before[(match.index ?? 0) - 1] !== '\\') {
        replaceTextBefore(range, block, match[0].length, inlineDom(match[0])); break;
      }
    }
  }

  function textAfterCaret(block: HTMLElement): string {
    const range = selectionRange(root);
    if (!range) return '';
    const after = range.cloneRange(); after.collapse(false); after.setEnd(block, block.childNodes.length);
    return after.toString();
  }

  function insertText(text: string) {
    const range = selectionRange(root);
    if (!range) return;
    range.deleteContents();
    const node = document.createTextNode(text); range.insertNode(node); caretAt(node, true);
    const pre = node.parentElement?.closest('pre');
    if (pre && codeText(pre).endsWith('\n')) {
      const code = pre.querySelector('code') ?? pre;
      if (code.lastChild?.nodeName !== 'BR') code.append(el('br'));
    }
  }

  function enter(event: KeyboardEvent) {
    const range = selectionRange(root);
    let block = currentBlock(root);
    if (!range || !block) return;
    event.preventDefault(); history.record(true);
    if (!range.collapsed) { range.deleteContents(); normalize(); block = currentBlock(root) ?? block; }
    if (block.closest('pre')) {
      if (event.metaKey || event.ctrlKey) {
        const next = blankParagraph(); topLevel(block).after(next); caretAt(next);
      } else insertText('\n');
      change(); rememberSelection(); return;
    }
    if (event.shiftKey) {
      const br = el('br'); range.insertNode(br);
      const placeholder = document.createTextNode('\u200b'); br.after(placeholder); caretAt(placeholder, true);
      change(); rememberSelection(); return;
    }
    const text = block.textContent?.replace(/\u200b/g, '') ?? '';
    if (['P', 'DIV'].includes(block.tagName) && /^`{3,}[\w+-]*$/.test(text)) {
      const language = text.replace(/^`+/, ''); block.textContent = ''; savedRange = range.cloneRange();
      applyBlock('pre', false); const pre = currentBlock(root)?.closest('pre');
      if (pre) pre.dataset.language = language || 'code'; change(); return;
    }
    if (['P', 'DIV'].includes(block.tagName) && /^(---|\*\*\*|___)$/.test(text)) {
      block.textContent = ''; savedRange = selectionRange(root)?.cloneRange() ?? null; applyBlock('hr', false); return;
    }
    if (emptyBlock(block) && (block.tagName === 'LI' || block.parentElement?.tagName === 'BLOCKQUOTE' || /^H[1-3]$/.test(block.tagName))) {
      exitStructured(block); change(); rememberSelection(); return;
    }
    const tail = range.cloneRange(); tail.setEnd(block, block.childNodes.length);
    const rest = tail.extractContents();
    const next = el(block.tagName === 'LI' ? 'li' : 'p'); next.append(rest);
    if (!next.textContent && !next.querySelector('ul,ol')) { next.replaceChildren(el('br')); }
    if (!block.textContent && !block.querySelector('ul,ol')) block.replaceChildren(el('br'));
    block.after(next); caretAt(next); change(); rememberSelection();
  }

  function indentList(block: HTMLElement, outdent: boolean) {
    const list = block.parentElement!;
    history.record(true);
    if (outdent) {
      if (list.parentElement?.tagName === 'LI') {
        const parentItem = list.parentElement;
        parentItem.after(block);
        if (!list.children.length) list.remove();
      } else exitStructured(block);
    } else {
      const previous = block.previousElementSibling;
      if (previous?.tagName !== 'LI') return;
      let nested = Array.from(previous.children).find(child => child.tagName === list.tagName);
      if (!nested) { nested = document.createElement(list.tagName.toLowerCase()); previous.append(nested); }
      nested.append(block);
    }
    caretAt(block, true); change(); rememberSelection();
  }

  root.addEventListener('beforeinput', event => {
    if ((event.target as Element).closest('.database-block')) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); event.inputType === 'historyUndo' ? history.undo() : history.redo();
    } else history.record();
  });
  root.addEventListener('input', event => {
    if ((event.target as Element).closest('.database-block')) return;
    if (!composing && !(event as InputEvent).isComposing) { normalize(); shortcuts(); }
    change(); rememberSelection();
  });
  root.addEventListener('databasebeforechange', event => history.record(!!(event as CustomEvent<{ force: boolean }>).detail?.force));
  root.addEventListener('databasechange', change);
  root.addEventListener('compositionstart', event => {
    if ((event.target as Element).closest('.database-block')) return;
    composing = true; floating.hidden = true; slashMenu.reset(); clearTimeout(syntaxTimer);
  });
  root.addEventListener('compositionend', event => {
    if ((event.target as Element).closest('.database-block')) return;
    composing = false; normalize(); change(); rememberSelection();
  });
  document.addEventListener('selectionchange', rememberSelection);
  root.addEventListener('keydown', event => {
    if (event.isComposing) return;
    // Windows reports AltGr as Ctrl+Alt; those keys type characters rather than shortcuts.
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    if ((event.target as Element).closest('.database-block') && !(mod && ['z', 'y'].includes(event.key.toLowerCase()))) return;
    if (slashMenu.handleKey(event)) return;
    if (event.key === 'Escape' && !floating.hidden) { event.preventDefault(); dismissFloating(); return; }
    if (mod && ['b', 'i', 'k', 'z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      switch (event.key.toLowerCase()) {
        case 'b': applyMark('strong'); break;
        case 'i': applyMark('em'); break;
        case 'k': void insertLink(); break;
        case 'z': event.shiftKey ? history.redo() : history.undo(); break;
        case 'y': history.redo(); break;
      }
      return;
    }
    if (event.key === 'Enter') { enter(event); return; }
    const block = currentBlock(root);
    const range = selectionRange(root);
    if (event.key === 'Tab' && block?.closest('pre')) {
      event.preventDefault(); history.record(true); insertText('  '); change(); return;
    }
    if (event.key === 'Tab' && block?.tagName === 'LI') { event.preventDefault(); indentList(block, event.shiftKey); return; }
    if (event.key === 'Backspace' && range?.collapsed && block && !textBeforeCaret(block, range)) {
      if (/^H[1-3]$/.test(block.tagName) || (emptyBlock(block) && (block.tagName === 'LI' || block.tagName === 'PRE' || block.parentElement?.tagName === 'BLOCKQUOTE'))) {
        event.preventDefault(); history.record(true); exitStructured(block); change(); rememberSelection();
      }
    }
    if (event.key === 'ArrowDown' && block?.tagName === 'PRE' && range?.collapsed && !textAfterCaret(block)) {
      if (!block.nextElementSibling) block.after(blankParagraph());
      event.preventDefault(); caretAt(block.nextElementSibling!);
    }
  });
  root.addEventListener('paste', event => {
    if ((event.target as Element).closest('.database-block')) return;
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    const inCode = !!currentBlock(root)?.closest('pre');
    // Excel and Word table cells copy with a final line break; a single line still pastes inline.
    const text = inCode ? pasted : pasted.replace(/\n$/, '');
    if (!text) return;
    history.record(true);
    if (inCode || !text.includes('\n')) insertText(text);
    else {
      const range = selectionRange(root);
      const block = currentBlock(root);
      if (!range || !block) return;
      range.deleteContents();
      const tail = range.cloneRange(); tail.setEnd(block, block.childNodes.length);
      const remainder = tail.extractContents();
      const fragment = markdownToDom(text);
      const last = fragment.lastElementChild;
      const anchor = topLevel(block);
      anchor.after(fragment);
      if (emptyBlock(block)) block.remove();
      if (remainder.textContent) { const paragraph = el('p'); paragraph.append(remainder); last?.after(paragraph); }
      if (last) caretAt(last, true);
    }
    normalize(); change(); rememberSelection();
  });
  root.addEventListener('drop', event => event.preventDefault());
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) { const href = safeUrl(link.href); if (href) void openExternal(href).catch(() => {}); }
    }
  });

  return {
    load(id: string | null, markdown = '') {
      if (currentId === id) return;
      if (currentId) positions.set(currentId, bookmark(root));
      currentId = id; savedRange = null; history.reset();
      floating.hidden = true; dismissedRange = null;
      slashMenu.reset();
      clearTimeout(syntaxTimer);
      root.replaceChildren(markdownToDom(markdown));
      highlightCodeBlocks(root);
      root.classList.toggle('is-empty', !markdown);
      scheduleCodeHeaders();
      styleSelect.value = 'p';
      markButtons.forEach(controls => controls.forEach(control => { control.classList.remove('is-active'); control.setAttribute('aria-pressed', 'false'); }));
    },
    focus() { root.focus(); restoreBookmark(root, currentId ? positions.get(currentId) ?? null : null); },
    reset() {
      currentId = null; savedRange = null; positions.clear(); history.reset(); floating.hidden = true; dismissedRange = null;
      slashMenu.reset();
      clearTimeout(syntaxTimer);
      for (const entry of codeHeaders.values()) { clearTimeout(entry.timer); entry.header.remove(); }
      codeHeaders.clear();
    },
    get markdown() { return domToMarkdown(root); },
  };
}
