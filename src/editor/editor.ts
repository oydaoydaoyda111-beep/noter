import { copyText, openExternal, pickAttachment, readAttachment, readClipboardText, saveAttachment } from '../desktop/platform';
import { el, button } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { askDialog } from '../ui/dialog';
import { showMenu, type MenuItem } from '../ui/menu';
import { codeText, domToMarkdown, imageFigure, inlineDom, markdownToDom, noteLink, safeUrl, tableElement, toggleElement } from './markdown';
import { createLinkPicker, type NoteLinks } from './links';
import { bookmark, caretAt, currentBlock, restoreBookmark, selectionRange, setRange, textBeforeCaret } from './selection';
import { createHistory } from './history';
import { codeLanguage, codeLanguages, highlightCodeBlocks } from './syntax';
import { createSlashMenu } from './slash';
import { createDatabaseBlock, hydrateDatabases } from '../database/database';
import { newDatabase } from '../database/model';

type BlockStyle = 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'task' | 'blockquote' | 'toggle' | 'pre' | 'table' | 'hr' | 'image' | 'database';
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

/** `noteDepth` is how many folders contain the open note, so image links stay relative to it. */
export function createEditor(root: HTMLElement, toolbar: HTMLElement, onChange: (markdown: string) => void, noteDepth: () => number = () => 0, links?: NoteLinks) {
  root.contentEditable = 'true';
  root.spellcheck = false;
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
    ['ul', 'Bullet list'], ['ol', 'Numbered list'], ['task', 'Task list'], ['blockquote', 'Quote'], ['toggle', 'Toggle'], ['pre', 'Code block'],
    ['table', 'Table'], ['hr', 'Divider'], ['image', 'Image'], ['database', 'Database'],
  ];
  styles.forEach(([value, label]) => {
    const option = el('option', '', label); option.value = value; styleSelect.append(option);
  });
  toolbar.append(styleSelect, el('span', 'toolbar-divider'));

  const change = () => {
    hydrateDatabases(root);
    hydrateImages();
    hydrateLinks();
    // Undo restores old markup, including highlights of blocks that are no longer selected.
    for (const block of root.querySelectorAll('.is-block-selected')) if (!selectedBlocks.includes(block as HTMLElement)) block.classList.remove('is-block-selected');
    const markdown = domToMarkdown(root);
    root.classList.toggle('is-empty', !markdown);
    onChange(markdown);
    refreshToolbar();
    scheduleCodeHeaders();
    scheduleSyntax();
  };
  const history = createHistory(root, change);
  const linkPicker = links ? createLinkPicker(root, links, (target, typed) => {
    const range = selectionRange(root), block = currentBlock(root);
    if (!range || !block) return;
    history.record(true);
    const fragment = document.createDocumentFragment(); fragment.append(noteLink(target));
    replaceTextBefore(range, block, typed, fragment); change(); rememberSelection();
  }, () => !composing) : null;
  function hydrateLinks() {
    for (const link of root.querySelectorAll<HTMLElement>('.note-link')) link.classList.toggle('is-missing', !links?.resolve(link.dataset.target ?? ''));
  }
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
    linkPicker?.update();
    positionTableTools();
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
    else if (element?.closest('td,th')) style = 'table';
    else if (element?.closest('.toggle-summary')) style = 'toggle';
    else if (element?.closest('li.task')) style = 'task';
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
    const isInline = (node: Node) => node.nodeType === Node.TEXT_NODE || (node instanceof Element && !node.matches('p,h1,h2,h3,div,ul,ol,blockquote,pre,hr,table,figure,.database-block'));
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
    } else if (block.parentElement?.classList.contains('toggle-body')) {
      block.parentElement.parentElement!.after(paragraph); block.remove();
    } else block.replaceWith(paragraph);
    caretAt(paragraph);
    return paragraph;
  }

  function applyBlock(style: BlockStyle, recordHistory = true) {
    restoreSelection();
    if (style === 'image') { void insertImage(pickAttachment()); return; }
    if (recordHistory) history.record(true);
    let block = currentBlock(root) ?? root.firstElementChild as HTMLElement;
    if (!block) return;
    const position = bookmark(root);
    if (style === 'task') {
      if (block.tagName === 'LI' && block.parentElement?.tagName === 'UL') {
        if (block.classList.contains('task')) { block.removeAttribute('class'); block.removeAttribute('data-checked'); }
        else { block.className = 'task'; block.dataset.checked = 'false'; }
        restoreBookmark(root, position); change(); rememberSelection(); return;
      }
      applyBlock('ul', false);
      const item = currentBlock(root);
      if (item?.tagName === 'LI') { item.className = 'task'; item.dataset.checked = 'false'; }
      change(); rememberSelection(); return;
    }
    if (style === 'toggle') {
      if (block.closest('pre,td,th')) return;
      if (block.classList.contains('toggle-summary')) { unwrapToggle(block.parentElement!); change(); rememberSelection(); return; }
      if (block.tagName === 'LI' || block.parentElement?.tagName === 'BLOCKQUOTE') block = exitStructured(block);
      const summary = document.createDocumentFragment(); summary.append(...block.childNodes);
      const toggle = toggleElement(summary, document.createDocumentFragment(), true);
      block.replaceWith(toggle);
      const title = toggle.firstElementChild as HTMLElement;
      caretAt(title, !emptyBlock(title)); change(); rememberSelection(); return;
    }
    if (style === 'table') {
      if (block.closest('td,th')) return;
      const table = tableElement([['', '', ''], ['', '', ''], ['', '', '']]);
      const next = blankParagraph();
      if (emptyBlock(block) && block.tagName === 'P' && !block.classList.contains('toggle-summary')) block.replaceWith(table, next);
      else outerBlock(block).after(table, next);
      caretAt(table.querySelector('th')!); change(); rememberSelection(); return;
    }
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
    const task = ['P', 'DIV'].includes(block.tagName) ? before.match(/^(?:[-+*] ?\[([ xX]?)\]?|\[([ xX]?)\]) $/)
      : block.tagName === 'LI' && block.parentElement?.tagName === 'UL' && !block.classList.contains('task') ? before.match(/^\[([ xX]?)\] $/) : null;
    if (task) {
      history.record(true);
      const remove = range.cloneRange(); remove.setStart(block, 0); remove.deleteContents();
      savedRange = selectionRange(root)?.cloneRange() ?? null;
      if (block.tagName !== 'LI') applyBlock('ul', false);
      const item = currentBlock(root);
      if (item?.tagName === 'LI') {
        item.className = 'task'; item.dataset.checked = String(/x/i.test(task[1] ?? task[2] ?? ''));
        if (emptyBlock(item) && !item.querySelector('br')) { item.prepend(el('br')); caretAt(item); }
      }
      change(); rememberSelection(); return;
    }
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
    for (const pattern of [/\[\[[^[\]\n|]+(?:\|[^[\]\n]+)?\]\]$/, /\*\*[^*\n]+\*\*$/, /(?<!\*)\*[^*\n]+\*$/, /`[^`\n]+`$/, /\[[^\]\n]+\]\([^\s)]+\)$/]) {
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
    const cell = block.closest<HTMLElement>('td,th');
    if (cell) {
      // Cells hold one line of Markdown: Enter goes down a row, Ctrl+Enter leaves the table.
      if (event.metaKey || event.ctrlKey) {
        const table = cell.closest('table')!;
        if (!(table.nextElementSibling instanceof HTMLParagraphElement)) table.after(blankParagraph());
        caretAt(table.nextElementSibling!); change(); rememberSelection();
      } else moveCell(cell, 'down');
      return;
    }
    if (block.classList.contains('toggle-summary')) {
      const toggle = block.parentElement!;
      const first = toggle.querySelector(':scope > .toggle-body')?.firstElementChild;
      if (toggle.dataset.open !== 'false' && first instanceof HTMLParagraphElement && emptyBlock(first) && !textAfterCaret(block).replace(/​/g, '')) {
        caretAt(first); rememberSelection(); return;
      }
      const tail = range.cloneRange(); tail.setEnd(block, block.childNodes.length);
      const next = el('p'); next.append(tail.extractContents());
      if (!next.textContent) next.replaceChildren(el('br'));
      if (!block.textContent) block.replaceChildren(el('br'));
      if (toggle.dataset.open === 'false') toggle.after(next); else toggle.querySelector(':scope > .toggle-body')!.prepend(next);
      caretAt(next); change(); rememberSelection(); return;
    }
    if (emptyBlock(block) && block.parentElement?.classList.contains('toggle-body') && !block.nextElementSibling) {
      exitStructured(block); change(); rememberSelection(); return;
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
    if (block.classList.contains('task')) { next.className = 'task'; next.dataset.checked = 'false'; }
    if (!next.textContent && !next.querySelector('ul,ol')) { next.replaceChildren(el('br')); }
    if (!block.textContent && !block.querySelector('ul,ol')) block.replaceChildren(el('br'));
    block.after(next); caretAt(next); change(); rememberSelection();
  }

  function toggleTask(item: HTMLElement) {
    history.record(true);
    item.dataset.checked = String(item.dataset.checked !== 'true');
    change();
  }

  /** The block as a direct child of the page or of a toggle's content, which is what moves and inserts work with. */
  function outerBlock(block: HTMLElement): HTMLElement {
    let element = block;
    while (element.parentElement && element.parentElement !== root && !element.parentElement.classList.contains('toggle-body')) element = element.parentElement;
    return element;
  }

  function unwrapToggle(toggle: HTMLElement): HTMLElement {
    const summary = toggle.querySelector(':scope > .toggle-summary');
    const body = Array.from(toggle.querySelector(':scope > .toggle-body')?.childNodes ?? []).filter(node => !(node instanceof HTMLParagraphElement && emptyBlock(node)));
    const paragraph = el('p');
    if (summary) paragraph.append(...summary.childNodes);
    if (!paragraph.childNodes.length) paragraph.append(el('br'));
    toggle.replaceWith(paragraph, ...body);
    caretAt(paragraph);
    return paragraph;
  }

  function toggleOpen(toggle: HTMLElement) {
    history.record(true);
    const open = toggle.dataset.open === 'false';
    toggle.dataset.open = String(open);
    // A caret inside hidden content would type into blocks the reader cannot see.
    const range = selectionRange(root);
    if (!open && range && toggle.querySelector(':scope > .toggle-body')?.contains(range.startContainer)) caretAt(toggle.querySelector(':scope > .toggle-summary')!, true);
    change(); rememberSelection();
  }

  const imageUrls = new Map<string, Promise<string | null>>();
  function hydrateImages() {
    const noteId = currentId;
    for (const figure of root.querySelectorAll<HTMLElement>('figure.md-image')) {
      const source = figure.dataset.src ?? '';
      if (figure.dataset.shown === source) continue;
      figure.dataset.shown = source;
      figure.replaceChildren(el('span', 'md-image-status', 'Loading image…'));
      if (!noteId) continue;
      let url = imageUrls.get(source);
      if (!url) {
        url = readAttachment(noteId, source).then(bytes => URL.createObjectURL(new Blob([bytes]))).catch(() => null);
        imageUrls.set(source, url);
      }
      void url.then(href => {
        if (!root.contains(figure) || figure.dataset.src !== source || currentId !== noteId) return;
        if (!href) { figure.replaceChildren(el('span', 'md-image-status', `Image not found: ${source}`)); return; }
        const image = el('img'); image.src = href; image.alt = figure.dataset.alt ?? ''; image.draggable = false;
        figure.replaceChildren(image);
      });
    }
  }

  async function insertImage(saving: Promise<string | null>) {
    const block = currentBlock(root) ?? root.lastElementChild as HTMLElement | null;
    let path: string | null;
    try { path = await saving; } catch (error) {
      await askDialog({ title: 'Could not add the image', description: error instanceof Error ? error.message : String(error), submit: 'OK' });
      return;
    }
    if (!path || !block || !root.contains(block)) return;
    history.record(true);
    const figure = imageFigure('../'.repeat(noteDepth()) + path.split('/').map(encodeURIComponent).join('/'));
    if (emptyBlock(block) && block.tagName === 'P' && !block.classList.contains('toggle-summary')) block.replaceWith(figure);
    else outerBlock(block).after(figure);
    if (!figure.nextElementSibling) figure.after(blankParagraph());
    caretAt(figure.nextElementSibling!); change(); rememberSelection();
  }

  function tableCell(rowLength: number, header: boolean) {
    return Array.from({ length: rowLength }, () => { const cell = el(header ? 'th' : 'td'); cell.append(el('br')); return cell; });
  }

  function addRow(row: HTMLTableRowElement): HTMLTableRowElement {
    const next = el('tr'); next.append(...tableCell(row.children.length, false));
    if (row.parentElement?.tagName === 'THEAD') row.closest('table')!.tBodies[0]?.prepend(next); else row.after(next);
    return next;
  }

  function tableEdit(cell: HTMLElement, action: 'row' | 'column' | 'delete-row' | 'delete-column') {
    const table = cell.closest('table')!, row = cell.parentElement as HTMLTableRowElement;
    const column = Array.from(row.children).indexOf(cell);
    history.record(true);
    let target: Element | null = cell;
    if (action === 'row') target = addRow(row).children[column];
    else if (action === 'column') {
      for (const each of table.querySelectorAll('tr')) each.children[column].after(...tableCell(1, each.parentElement?.tagName === 'THEAD'));
      target = row.children[column + 1];
      const align = (table.dataset.align ?? '').split(','); align.splice(column + 1, 0, ''); table.dataset.align = align.join(',');
    } else if (action === 'delete-row') {
      if (row.parentElement?.tagName === 'THEAD') return;
      target = row.nextElementSibling?.children[column] ?? row.previousElementSibling?.children[column] ?? table.querySelector('th');
      row.remove();
    } else {
      if (row.children.length <= 1) return;
      for (const each of table.querySelectorAll('tr')) each.children[column]?.remove();
      target = row.children[Math.min(column, row.children.length - 1)];
      const align = (table.dataset.align ?? '').split(','); align.splice(column, 1); table.dataset.align = align.join(',');
    }
    if (target) caretAt(target, true);
    change(); rememberSelection();
  }

  function moveCell(cell: HTMLElement, direction: 'next' | 'previous' | 'down') {
    const rows = Array.from(cell.closest('table')!.querySelectorAll('tr'));
    const row = cell.parentElement as HTMLTableRowElement;
    const index = rows.indexOf(row), column = Array.from(row.children).indexOf(cell);
    let target: Element | null | undefined;
    if (direction === 'previous') target = cell.previousElementSibling ?? rows[index - 1]?.lastElementChild;
    else if (direction === 'next') target = cell.nextElementSibling ?? rows[index + 1]?.firstElementChild;
    else target = rows[index + 1]?.children[column];
    if (!target && direction !== 'previous') {
      history.record(true); const added = addRow(row); target = direction === 'next' ? added.firstElementChild : added.children[column];
      change();
    }
    if (target) { caretAt(target, true); rememberSelection(); }
  }

  // A "unit" is what block actions work on: a list item, or a block directly in the page or a toggle.
  const unitOf = (block: HTMLElement) => block.tagName === 'LI' ? block : outerBlock(block);
  let selectedBlocks: HTMLElement[] = [];
  let blockAnchor: HTMLElement | null = null, blockFocus: HTMLElement | null = null;

  function selectBlocks(blocks: HTMLElement[], anchor = blocks[0], focus = blocks[blocks.length - 1]) {
    for (const block of root.querySelectorAll('.is-block-selected')) block.classList.remove('is-block-selected');
    selectedBlocks = blocks.filter(block => root.contains(block));
    blockAnchor = anchor ?? null; blockFocus = focus ?? null;
    for (const block of selectedBlocks) block.classList.add('is-block-selected');
    if (selectedBlocks.length) {
      window.getSelection()?.removeAllRanges(); root.focus({ preventScroll: true }); floating.hidden = true;
      selectedBlocks[selectedBlocks.length - 1].scrollIntoView({ block: 'nearest' });
    }
  }

  /** Units from [first] to [last] in document order; blocks in different containers are widened to page-level blocks. */
  function unitRange(first: HTMLElement, last: HTMLElement): HTMLElement[] {
    if (first.parentElement !== last.parentElement) { first = topLevel(first); last = topLevel(last); }
    const siblings = Array.from(first.parentElement!.children) as HTMLElement[];
    const [from, to] = [siblings.indexOf(first), siblings.indexOf(last)].sort((a, b) => a - b);
    return siblings.slice(from, to + 1);
  }

  /** The selected blocks, or the blocks the text selection touches. */
  function targetUnits(): HTMLElement[] {
    if (selectedBlocks.length) return selectedBlocks;
    const range = selectionRange(root), block = currentBlock(root);
    if (!range) return [];
    // Selections that start or end on the page itself (Ctrl+A, dragging past the text) cover whole page-level blocks.
    if (!block || range.startContainer === root || range.endContainer === root) {
      return (Array.from(root.children) as HTMLElement[]).filter(child => range.intersectsNode(child));
    }
    const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    const endBlock = endElement?.closest<HTMLElement>('p,h1,h2,h3,li,pre,div,td,th');
    const start = unitOf(block);
    return unitRange(start, endBlock && endBlock !== root && root.contains(endBlock) ? unitOf(endBlock) : start);
  }

  function focusUnit(unit: HTMLElement, end: boolean) {
    let target: Element | null = unit;
    if (unit.matches('ul,ol')) target = end ? unit.lastElementChild : unit.firstElementChild;
    else if (unit.classList.contains('toggle')) target = unit.querySelector(':scope > .toggle-summary');
    else if (unit.tagName === 'TABLE') target = unit.querySelector('th,td');
    else if (unit.tagName === 'PRE') target = unit.querySelector('code') ?? unit;
    else if (unit.isContentEditable === false || unit.matches('hr,figure,.database-block')) {
      if (!(unit.nextElementSibling instanceof HTMLParagraphElement)) unit.after(blankParagraph());
      target = unit.nextElementSibling;
    }
    root.focus({ preventScroll: true });
    if (target) caretAt(target, end);
    rememberSelection();
  }

  /** Moves blocks above or below their neighbour; the caret moves with them. */
  function moveUnits(units: HTMLElement[], up: boolean) {
    if (!units.length) return;
    const sibling = up ? units[0].previousElementSibling : units[units.length - 1].nextElementSibling;
    if (!sibling) return;
    const range = selectionRange(root);
    const ends = range && [range.startContainer, range.startOffset, range.endContainer, range.endOffset] as const;
    history.record(true);
    if (up) sibling.before(...units); else sibling.after(...units);
    if (ends) { const restored = document.createRange(); restored.setStart(ends[0], ends[1]); restored.setEnd(ends[2], ends[3]); setRange(restored); }
    units[0].scrollIntoView({ block: 'nearest' });
    change(); rememberSelection();
  }

  function duplicateUnits(units: HTMLElement[]) {
    // Databases keep their own IDs, so they are not duplicated.
    const copies = units.filter(unit => !unit.classList.contains('database-block')).map(unit => {
      const copy = unit.cloneNode(true) as HTMLElement;
      copy.classList.remove('is-block-selected');
      return copy;
    });
    if (!copies.length) return;
    history.record(true);
    units[units.length - 1].after(...copies);
    change();
    if (selectedBlocks.length) selectBlocks(copies); else focusUnit(copies[copies.length - 1], true);
  }

  function deleteUnits(units: HTMLElement[]) {
    if (!units.length) return;
    history.record(true);
    const parent = units[0].parentElement;
    const next = units[units.length - 1].nextElementSibling ?? units[0].previousElementSibling;
    units.forEach(unit => unit.remove());
    if (parent?.matches('ul,ol') && !parent.children.length) parent.remove();
    if (parent?.classList.contains('toggle-body') && !parent.children.length) parent.append(blankParagraph());
    if (!root.children.length) root.append(blankParagraph());
    selectBlocks([]);
    change();
    focusUnit(next instanceof HTMLElement && root.contains(next) ? next : root.lastElementChild as HTMLElement, false);
  }

  function unitsMarkdown(units: HTMLElement[]) {
    const container = el('div');
    for (const unit of units) {
      const copy = unit.cloneNode(true) as HTMLElement;
      // Consecutive list items are copied inside their kind of list.
      if (unit.tagName === 'LI') {
        const last = container.lastElementChild;
        if (last?.tagName === unit.parentElement!.tagName && last.getAttribute('data-copy') === 'list') last.append(copy);
        else { const list = unit.parentElement!.cloneNode(false) as HTMLElement; list.setAttribute('data-copy', 'list'); list.append(copy); container.append(list); }
      } else container.append(copy);
    }
    return domToMarkdown(container);
  }

  async function copyUnits(units: HTMLElement[]) {
    try { await copyText(unitsMarkdown(units)); }
    catch { await navigator.clipboard?.writeText(unitsMarkdown(units)).catch(() => {}); }
  }

  const turnIntoStyles: [BlockStyle, string, IconName][] = [
    ['p', 'Text', 'note'], ['h1', 'Heading 1', 'bold'], ['h2', 'Heading 2', 'bold'], ['h3', 'Heading 3', 'bold'],
    ['ul', 'Bullet list', 'more'], ['ol', 'Numbered list', 'more'], ['task', 'Task list', 'check'],
    ['blockquote', 'Quote', 'quote'], ['toggle', 'Toggle', 'chevron'], ['pre', 'Code block', 'code'],
  ];

  /** Converts each text block in [units] to [style], keeping its text; one undo step reverts all of them. */
  function turnInto(units: HTMLElement[], style: BlockStyle) {
    const targets = units.flatMap(unit => {
      if (unit.matches('ul,ol,blockquote')) return Array.from(unit.children) as HTMLElement[];
      if (unit.classList.contains('toggle')) return [unit.querySelector<HTMLElement>(':scope > .toggle-summary')!];
      return [unit];
    }).filter(target => target && !target.matches('hr,figure,table,.database-block'));
    if (!targets.length) return;
    selectBlocks([]);
    history.record(true);
    for (const target of targets) {
      if (!root.contains(target)) continue;
      root.focus({ preventScroll: true });
      caretAt(target.tagName === 'PRE' ? target.querySelector('code') ?? target : target, true);
      savedRange = selectionRange(root)?.cloneRange() ?? null;
      applyBlock(style, false);
    }
    // Each converted block starts its own list; neighbouring lists of one kind read as one list, as they do after reloading.
    for (const list of Array.from(root.querySelectorAll<HTMLElement>('ul + ul, ol + ol'))) {
      const previous = list.previousElementSibling;
      if (previous && root.contains(list)) { previous.append(...list.childNodes); list.remove(); }
    }
    change();
  }

  function showTurnInto(units: HTMLElement[], x: number, y: number) {
    if (!units.length) return;
    showMenu(x, y, turnIntoStyles.map(([style, label, name]) => ({ label, icon: name, action: () => turnInto(units, style) })), root, 'Turn into');
  }

  function showBlockMenu(units: HTMLElement[], x: number, y: number) {
    const count = units.length > 1 ? ` ${units.length} blocks` : '';
    showMenu(x, y, [
      { label: 'Turn into…', icon: 'edit', action: () => showTurnInto(units, x, y) },
      { label: `Duplicate${count}`, icon: 'plus', action: () => duplicateUnits(units) },
      { label: 'Copy as Markdown', icon: 'copy', action: () => void copyUnits(units) },
      { label: `Delete${count}`, icon: 'trash', danger: true, action: () => deleteUnits(units) },
    ], root, 'Block actions');
  }

  function caretPoint(): [number, number] {
    const range = selectionRange(root);
    const rect = range?.getClientRects()[0] ?? (selectedBlocks[0] ?? currentBlock(root))?.getBoundingClientRect();
    return rect ? [rect.left, rect.bottom + 6] : [innerWidth / 2, innerHeight / 3];
  }

  /** Keys while blocks are selected; returns true when the key was handled. */
  function blockKeys(event: KeyboardEvent): boolean {
    const units = selectedBlocks;
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    const key = event.key.toLowerCase();
    const done = () => { event.preventDefault(); return true; };
    if (['shift', 'control', 'alt', 'meta'].includes(key)) return true;
    if (key === 'escape') { selectBlocks([]); return done(); }
    if (key === 'enter' && !mod) { const last = units[units.length - 1]; selectBlocks([]); focusUnit(last, true); return done(); }
    if (key === 'backspace' || key === 'delete') { deleteUnits(units); return done(); }
    if (key === 'arrowup' || key === 'arrowdown') {
      const up = key === 'arrowup';
      if (mod && event.shiftKey) { const moved = [...units]; moveUnits(moved, up); selectBlocks(moved, blockAnchor ?? undefined, blockFocus ?? undefined); return done(); }
      const edge = up ? units[0].previousElementSibling : units[units.length - 1].nextElementSibling;
      if (event.shiftKey && blockAnchor && blockFocus) {
        const next = (up ? blockFocus.previousElementSibling : blockFocus.nextElementSibling) as HTMLElement | null;
        if (next) selectBlocks(unitRange(blockAnchor, next), blockAnchor, next);
      } else if (edge instanceof HTMLElement) selectBlocks([edge]);
      return done();
    }
    if (mod && key === 'd') { duplicateUnits(units); return done(); }
    if (mod && key === 'c') { void copyUnits(units); return done(); }
    if (mod && key === 'x') { const cut = [...units]; void copyUnits(cut).then(() => deleteUnits(cut)); return done(); }
    if (mod && key === '/') { showTurnInto(units, ...caretPoint()); return done(); }
    if (mod && (key === 'z' || key === 'y')) { selectBlocks([]); return false; }
    // Typing leaves block selection and continues at the end of the first block.
    selectBlocks([]); focusUnit(units[0], true);
    return false;
  }

  // Drag handle beside the hovered block; dropping reorders blocks within the same list, toggle, or page.
  const handle = button('Drag to move this block', 'block-handle');
  handle.textContent = '⋮⋮'; handle.tabIndex = -1; handle.hidden = true;
  const dropLine = el('div', 'block-drop-line'); dropLine.hidden = true;
  codeLayer.append(handle, dropLine);
  let handleBlock: HTMLElement | null = null;
  let dragging = false;
  function unitAt(target: EventTarget | null): HTMLElement | null {
    const element = target instanceof Element ? target : null;
    if (!element || !root.contains(element) || element === root) return null;
    const item = element.closest('li');
    if (item && root.contains(item)) return item;
    return outerBlock(element instanceof HTMLElement ? element : element.parentElement!);
  }
  root.addEventListener('mousemove', event => {
    if (dragging) return;
    const unit = unitAt(event.target);
    if (!unit || unit === root) return;
    handleBlock = unit;
    const bounds = codeLayer.getBoundingClientRect(), rect = unit.getBoundingClientRect();
    handle.style.transform = `translate(${rect.left - bounds.left - (unit.tagName === 'LI' || unit.classList.contains('toggle') ? 48 : 28)}px, ${rect.top - bounds.top + 2}px)`;
    handle.hidden = false;
  });
  page.addEventListener('mouseleave', () => { if (!dragging) handle.hidden = true; });
  handle.addEventListener('pointerdown', event => {
    if (!handleBlock || !root.contains(handleBlock)) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId); dragging = true;
    const unit = handleBlock;
    // Dragging a selected block carries the whole selection; a click without movement opens the block menu.
    const units = selectedBlocks.includes(unit) ? [...selectedBlocks] : [unit];
    const startY = event.clientY;
    let moved = false;
    units.forEach(each => each.classList.add('is-dragging'));
    let drop: { target: Element; after: boolean } | null = null;
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientY - startY) < 5) return;
      moved = true;
      const siblings = Array.from(unit.parentElement!.children).filter(child => !units.includes(child as HTMLElement));
      const target = siblings.find(child => moveEvent.clientY < child.getBoundingClientRect().bottom) ?? siblings[siblings.length - 1];
      if (!target) return;
      const rect = target.getBoundingClientRect(), bounds = codeLayer.getBoundingClientRect();
      const after = moveEvent.clientY > rect.top + rect.height / 2;
      drop = { target, after };
      dropLine.style.transform = `translate(${rect.left - bounds.left}px, ${(after ? rect.bottom : rect.top) - bounds.top - 1}px)`;
      dropLine.style.width = `${rect.width}px`; dropLine.hidden = false;
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish);
      dragging = false; dropLine.hidden = true; units.forEach(each => each.classList.remove('is-dragging'));
      if (!moved) {
        const rect = handle.getBoundingClientRect();
        selectBlocks(units);
        showBlockMenu(units, rect.left, rect.bottom + 4);
      } else if (drop && root.contains(unit)) {
        history.record(true);
        if (drop.after) drop.target.after(...units); else drop.target.before(...units);
        change(); rememberSelection();
      }
      handle.hidden = true;
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });

  // Row and column controls appear above the table that holds the caret.
  const tableTools = el('div', 'table-tools'); tableTools.hidden = true;
  tableTools.setAttribute('role', 'toolbar'); tableTools.setAttribute('aria-label', 'Table');
  for (const [action, label] of [['row', '+ Row'], ['column', '+ Column'], ['delete-row', '− Row'], ['delete-column', '− Column']] as const) {
    const control = button(label.replace('+', 'Add').replace('−', 'Delete'), 'table-tool'); control.textContent = label;
    control.addEventListener('mousedown', event => event.preventDefault());
    control.onclick = () => { restoreSelection(); const cell = currentBlock(root)?.closest<HTMLElement>('td,th'); if (cell) tableEdit(cell, action); };
    tableTools.append(control);
  }
  codeLayer.append(tableTools);
  function positionTableTools() {
    const table = currentBlock(root)?.closest('table');
    if (!table) { tableTools.hidden = true; return; }
    const bounds = codeLayer.getBoundingClientRect(), rect = table.getBoundingClientRect();
    tableTools.hidden = false;
    tableTools.style.transform = `translate(${rect.left - bounds.left}px, ${rect.top - bounds.top - tableTools.offsetHeight - 4}px)`;
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
    if (selectedBlocks.length && blockKeys(event)) return;
    if (linkPicker?.handleKey(event)) return;
    if (slashMenu.handleKey(event)) return;
    if (event.key === 'Escape' && !floating.hidden) { event.preventDefault(); dismissFloating(); return; }
    if (event.key === 'Escape' && !event.shiftKey) {
      const units = targetUnits();
      if (units.length) { event.preventDefault(); selectBlocks(units); return; }
    }
    if (mod && event.key === '/') { event.preventDefault(); showTurnInto(targetUnits(), ...caretPoint()); return; }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateUnits(targetUnits()); return; }
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
    const block = currentBlock(root);
    if (mod && event.key === 'Enter' && block?.classList.contains('task')) { event.preventDefault(); toggleTask(block); return; }
    if (mod && event.key === 'Enter' && block?.classList.contains('toggle-summary')) { event.preventDefault(); toggleOpen(block.parentElement!); return; }
    if (mod && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); moveUnits(targetUnits(), event.key === 'ArrowUp'); return;
    }
    if (event.key === 'Enter') { enter(event); return; }
    const range = selectionRange(root);
    const cell = block?.closest<HTMLElement>('td,th');
    if (event.key === 'Tab' && cell) { event.preventDefault(); moveCell(cell, event.shiftKey ? 'previous' : 'next'); return; }
    if (event.key === 'Backspace' && range?.collapsed && block && !textBeforeCaret(block, range).replace(/​/g, '')) {
      if (cell) {
        // Never merge cells; an empty body row is removed instead.
        event.preventDefault();
        const row = cell.parentElement as HTMLTableRowElement;
        if (cell === row.firstElementChild && row.parentElement?.tagName === 'TBODY' && Array.from(row.children).every(each => emptyBlock(each as HTMLElement))) {
          const previous = row.previousElementSibling?.lastElementChild ?? row.closest('table')!.querySelector('tr')?.lastElementChild;
          history.record(true); row.remove(); if (previous) caretAt(previous, true); change(); rememberSelection();
        } else if (cell.previousElementSibling) caretAt(cell.previousElementSibling, true);
        return;
      }
      if (block.classList.contains('toggle-summary')) {
        event.preventDefault(); history.record(true); unwrapToggle(block.parentElement!); change(); rememberSelection(); return;
      }
      const body = block.parentElement;
      if (body?.classList.contains('toggle-body') && block === body.firstElementChild) {
        event.preventDefault();
        if (emptyBlock(block)) { history.record(true); block.remove(); change(); }
        caretAt(body.parentElement!.querySelector(':scope > .toggle-summary')!, true); rememberSelection(); return;
      }
      const before = outerBlock(block) === block ? block.previousElementSibling : null;
      if (before?.tagName === 'TABLE') {
        event.preventDefault();
        if (emptyBlock(block)) { history.record(true); block.remove(); change(); }
        caretAt(before.querySelector('tr:last-child > :last-child') ?? before, true); rememberSelection(); return;
      }
      if (before?.tagName === 'FIGURE') {
        event.preventDefault(); history.record(true); before.remove(); change(); rememberSelection(); return;
      }
    }
    // Backspace at the start of a task keeps the bullet and removes only the checkbox.
    if (event.key === 'Backspace' && range?.collapsed && block?.classList.contains('task') && !textBeforeCaret(block, range)) {
      event.preventDefault(); history.record(true);
      block.removeAttribute('class'); block.removeAttribute('data-checked');
      change(); rememberSelection(); return;
    }
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
    const image = Array.from(event.clipboardData?.files ?? []).find(file => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type));
    if (image && !currentBlock(root)?.closest('pre,td,th')) {
      void insertImage(image.arrayBuffer().then(buffer => saveAttachment(new Uint8Array(buffer), image.type.slice(6).replace('jpeg', 'jpg'))));
      return;
    }
    const pasted = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    const inCode = !!currentBlock(root)?.closest('pre');
    const inCell = !!currentBlock(root)?.closest('td,th');
    // Excel and Word table cells copy with a final line break; a single line still pastes inline.
    const text = inCode ? pasted : inCell ? pasted.trim().replace(/\s*\n\s*/g, ' ') : pasted.replace(/\n$/, '');
    if (!text) return;
    history.record(true);
    if (inCode || inCell || !text.includes('\n')) insertText(text);
    else {
      const range = selectionRange(root);
      const block = currentBlock(root);
      if (!range || !block) return;
      range.deleteContents();
      const tail = range.cloneRange(); tail.setEnd(block, block.childNodes.length);
      const remainder = tail.extractContents();
      const fragment = markdownToDom(text);
      const last = fragment.lastElementChild;
      const anchor = outerBlock(block);
      anchor.after(fragment);
      if (emptyBlock(block)) block.remove();
      if (remainder.textContent) { const paragraph = el('p'); paragraph.append(remainder); last?.after(paragraph); }
      if (last) caretAt(last, true);
    }
    normalize(); change(); rememberSelection();
  });
  root.addEventListener('drop', event => event.preventDefault());
  // Checkboxes and toggle arrows are drawn in the block's left gutter, so a press left of the text box acts on them.
  const gutterControl = (event: MouseEvent) => {
    const item = (event.target as Element).closest('li.task, .toggle-summary');
    if (!(item instanceof HTMLElement) || event.clientX >= item.getBoundingClientRect().left) return null;
    return item.tagName !== 'LI' || item.parentElement?.tagName === 'UL' ? item : null;
  };
  root.addEventListener('mousedown', event => {
    if (gutterControl(event) || (event.target as Element).closest('.note-link')) { event.preventDefault(); return; }
    // Shift+click selects whole blocks from the caret's block to the clicked one.
    const clicked = event.shiftKey && event.button === 0 ? unitAt(event.target) : null;
    const from = selectedBlocks.length ? blockAnchor : currentBlock(root) && unitOf(currentBlock(root)!);
    if (clicked && from && clicked !== from && clicked.parentElement === from.parentElement) {
      event.preventDefault(); selectBlocks(unitRange(from, clicked), from, clicked); return;
    }
    if (selectedBlocks.length) selectBlocks([]);
  });
  // Right-click menu with clipboard, formatting and block actions in place of the browser's own menu.
  const modKey = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl ';
  root.addEventListener('contextmenu', event => {
    const target = event.target as Element;
    if (target.closest('.database-block')) return;
    event.preventDefault();
    if (selectedBlocks.length && !selectedBlocks.some(block => block.contains(target))) selectBlocks([]);
    rememberSelection();
    const range = selectionRange(root);
    const hasText = !!range && !range.collapsed && !!range.toString().trim();
    const blocks = selectedBlocks.length > 0;
    const clicked = unitAt(target);
    const units = blocks ? [...selectedBlocks] : hasText ? targetUnits() : clicked ? [clicked] : [];
    const inCode = !!currentBlock(root)?.closest('pre');
    const items: MenuItem[] = [];
    const noteTarget = target.closest<HTMLElement>('.note-link')?.dataset.target;
    const href = safeUrl(target.closest('a')?.getAttribute('href') ?? '');
    if (noteTarget && links) items.push({ label: 'Open linked note', icon: 'arrow', action: () => links.open(noteTarget) });
    if (href) items.push({ label: 'Open link', icon: 'arrow', action: () => void openExternal(href).catch(() => {}) }, { label: 'Copy link address', icon: 'link', action: () => void copyText(href).catch(() => {}) });
    const clipboard = (command: 'cut' | 'copy') => () => {
      if (blocks) { const chosen = [...units]; void copyUnits(chosen).then(() => { if (command === 'cut') deleteUnits(chosen); }); return; }
      restoreSelection(); document.execCommand(command);
    };
    items.push(
      { label: 'Cut', icon: 'cut', hint: `${modKey}X`, disabled: !hasText && !blocks, separator: true, action: clipboard('cut') },
      { label: 'Copy', icon: 'copy', hint: `${modKey}C`, disabled: !hasText && !blocks, action: clipboard('copy') },
      { label: 'Paste', icon: 'paste', hint: `${modKey}V`, disabled: blocks, action: () => void readClipboardText().then(text => {
        if (!text) return;
        restoreSelection();
        const data = new DataTransfer(); data.setData('text/plain', text);
        root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }) },
    );
    if (hasText && !inCode) items.push(
      { label: 'Bold', icon: 'bold', hint: `${modKey}B`, separator: true, action: () => applyMark('strong') },
      { label: 'Italic', icon: 'italic', hint: `${modKey}I`, action: () => applyMark('em') },
      { label: 'Inline code', icon: 'code', action: () => applyMark('code') },
      { label: 'Link…', icon: 'link', hint: `${modKey}K`, action: () => { restoreSelection(); void insertLink(); } },
    );
    if (units.length) {
      const count = units.length > 1 ? ` ${units.length} blocks` : ' block';
      items.push(
        { label: 'Turn into…', icon: 'edit', hint: `${modKey}/`, separator: true, action: () => showTurnInto(units, event.clientX, event.clientY) },
        { label: `Duplicate${count}`, icon: 'plus', hint: `${modKey}D`, action: () => duplicateUnits(units) },
        { label: 'Copy as Markdown', icon: 'copy', action: () => void copyUnits(units) },
        { label: `Delete${count}`, icon: 'trash', danger: true, action: () => deleteUnits(units) },
      );
    }
    showMenu(event.clientX, event.clientY, items, root, 'Editor actions');
  });
  // Dragging a text selection across blocks selects those blocks, as in Notion.
  root.addEventListener('mouseup', () => {
    const range = selectionRange(root);
    if (!range || range.collapsed || selectedBlocks.length) return;
    const units = targetUnits();
    if (units.length > 1) selectBlocks(units);
  });
  root.addEventListener('click', event => {
    const noteTarget = (event.target as Element).closest<HTMLElement>('.note-link')?.dataset.target;
    if (noteTarget && links) { event.preventDefault(); links.open(noteTarget); return; }
    const control = gutterControl(event);
    if (control) { event.preventDefault(); if (control.tagName === 'LI') toggleTask(control); else toggleOpen(control.parentElement!); return; }
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
      currentId = id; savedRange = null; history.reset(); selectedBlocks = [];
      floating.hidden = true; dismissedRange = null;
      slashMenu.reset(); linkPicker?.reset();
      clearTimeout(syntaxTimer);
      for (const url of imageUrls.values()) void url.then(href => { if (href) URL.revokeObjectURL(href); });
      imageUrls.clear(); handle.hidden = true; tableTools.hidden = true;
      root.replaceChildren(markdownToDom(markdown));
      hydrateImages(); hydrateLinks();
      highlightCodeBlocks(root);
      root.classList.toggle('is-empty', !markdown);
      scheduleCodeHeaders();
      styleSelect.value = 'p';
      markButtons.forEach(controls => controls.forEach(control => { control.classList.remove('is-active'); control.setAttribute('aria-pressed', 'false'); }));
    },
    focus() { root.focus(); restoreBookmark(root, currentId ? positions.get(currentId) ?? null : null); },
    reset() {
      currentId = null; savedRange = null; positions.clear(); history.reset(); floating.hidden = true; dismissedRange = null;
      slashMenu.reset(); linkPicker?.reset();
      clearTimeout(syntaxTimer);
      for (const entry of codeHeaders.values()) { clearTimeout(entry.timer); entry.header.remove(); }
      codeHeaders.clear();
    },
    get markdown() { return domToMarkdown(root); },
    refreshLinks: hydrateLinks,
  };
}
