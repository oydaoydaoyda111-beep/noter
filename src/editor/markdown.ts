import { createDatabaseBlock } from '../database/database';
import { readDatabase } from '../database/model';

const BLOCK_START = /^(?:\s{0,3}#{1,3}\s|\s*`{3,}|\s*>|\s*(?:[-+*]|\d+[.)])\s|\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const LIST_ITEM = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\](?:\s+(.*))?$/;
const TOGGLE = /^\[!toggle\]([+-]?)\s*(.*)$/i;
const IMAGE = /^\s*!\[([^\]\n]*)\]\((<[^>\n]+>|[^\s)]+)\)\s*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const WIKI_LINK = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/;

/** An Obsidian-style `[[Note]]` link, kept as one unit so its target cannot be half-edited. */
export function noteLink(target: string, label?: string): HTMLElement {
  const link = document.createElement('span');
  link.className = 'note-link'; link.contentEditable = 'false';
  link.dataset.target = target;
  if (label && label !== target) link.dataset.label = label;
  link.textContent = label || target.split('#')[0].split('/').pop() || target;
  return link;
}

/** Note names linked from Markdown, lower-cased without headings or aliases. */
export function linkedNames(markdown: string): string[] {
  return Array.from(markdown.matchAll(/\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g), match => match[1].trim().toLowerCase());
}

/** Cells of a pipe-table row; `\|` is a literal pipe. */
function tableCells(line: string): string[] {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\' && text[index + 1] === '|') { current += '|'; index++; }
    else if (text[index] === '|') { cells.push(current.trim()); current = ''; }
    else current += text[index];
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  return lines[index].includes('|') && TABLE_DELIMITER.test(lines[index + 1] ?? '') && lines[index + 1].includes('-')
    && tableCells(lines[index]).length === tableCells(lines[index + 1]).length;
}

/** A Markdown image link; the original link text is kept so saving does not rewrite it. */
export function imageFigure(source: string, alt = ''): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'md-image'; figure.contentEditable = 'false';
  figure.dataset.src = source; figure.dataset.alt = alt;
  return figure;
}

/** A Notion-style table with a header row; cells hold inline Markdown. */
export function tableElement(rows: string[][], align: string[] = []): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'md-table'; table.dataset.align = align.join(',');
  const head = document.createElement('thead'), body = document.createElement('tbody');
  rows.forEach((cells, rowIndex) => {
    const row = document.createElement('tr');
    for (const text of cells) {
      const cell = document.createElement(rowIndex ? 'td' : 'th');
      cell.append(inlineDom(text));
      if (!cell.childNodes.length) cell.append(document.createElement('br'));
      row.append(cell);
    }
    (rowIndex ? body : head).append(row);
  });
  table.append(head, body);
  return table;
}

/** A collapsible block stored as an Obsidian foldable callout. */
export function toggleElement(summary: Node, body: Node, open: boolean): HTMLElement {
  const toggle = document.createElement('div');
  toggle.className = 'toggle'; toggle.dataset.open = String(open);
  const title = document.createElement('p'); title.className = 'toggle-summary'; title.append(summary);
  if (!title.childNodes.length) title.append(document.createElement('br'));
  const content = document.createElement('div'); content.className = 'toggle-body'; content.append(body);
  if (!content.childNodes.length) { const paragraph = document.createElement('p'); paragraph.append(document.createElement('br')); content.append(paragraph); }
  toggle.append(title, content);
  return toggle;
}

export function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const url = new URL(trimmed);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function closingDelimiter(text: string, delimiter: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (!text.startsWith(delimiter, index)) continue;
    const run = text.slice(index).match(delimiter[0] === '*' ? /^\*+/ : /^_+/)?.[0].length ?? 0;
    if (delimiter.length === 1 && run > 1) {
      if (run % 2) return index + run - 1;
      index += run - 1; continue;
    }
    if (delimiter.length === 2 && run === 3) {
      const singles = text.slice(start, index).match(delimiter[0] === '*' ? /(?<!\*)\*(?!\*)/g : /(?<!_)_(?!_)/g) ?? [];
      return index + (singles.length % 2);
    }
    return index;
  }
  return -1;
}

export function inlineDom(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let plain = '';
  const flush = () => { if (plain) fragment.append(document.createTextNode(plain)); plain = ''; };
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && index + 1 < text.length && /[\\`*_{}\[\]()#+.!<>-]/.test(text[index + 1])) {
      plain += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '\n') {
      flush(); fragment.append(document.createElement('br')); index++; continue;
    }
    if (text[index] === '`') {
      const delimiter = text.slice(index).match(/^`+/)![0];
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end >= 0) {
        flush();
        const code = document.createElement('code');
        let content = text.slice(index + delimiter.length, end).replace(/\n/g, ' ');
        if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
        code.textContent = content;
        fragment.append(code); index = end + delimiter.length; continue;
      }
    }
    const triple = text.startsWith('***', index) ? '***' : text.startsWith('___', index) ? '___' : null;
    if (triple) {
      const end = closingDelimiter(text, triple, index + 3);
      if (end > index + 3) {
        flush();
        const strong = document.createElement('strong');
        const emphasis = document.createElement('em');
        emphasis.append(inlineDom(text.slice(index + 3, end))); strong.append(emphasis);
        fragment.append(strong); index = end + 3; continue;
      }
    }
    const strong = text.startsWith('**', index) ? '**' : text.startsWith('__', index) ? '__' : null;
    const emphasis = strong ?? (text[index] === '*' || (text[index] === '_' && !/\w/.test(text[index - 1] ?? '')) ? text[index] : null);
    if (emphasis) {
      const end = closingDelimiter(text, emphasis, index + emphasis.length);
      if (end > index + emphasis.length) {
        flush();
        const mark = document.createElement(strong ? 'strong' : 'em');
        mark.append(inlineDom(text.slice(index + emphasis.length, end)));
        fragment.append(mark); index = end + emphasis.length; continue;
      }
    }
    const wiki = text.startsWith('[[', index) ? text.slice(index).match(WIKI_LINK) : null;
    if (wiki) {
      flush(); fragment.append(noteLink(wiki[1].trim(), wiki[2]?.trim())); index += wiki[0].length; continue;
    }
    if (text[index] === '[') {
      const match = text.slice(index).match(/^\[([^\]\n]+)\]\(([^\s)]*)(?:\s+"[^"]*")?\)/);
      const href = match ? safeUrl(match[2]) : null;
      if (match && href) {
        flush();
        const link = document.createElement('a');
        link.href = href; link.rel = 'noopener noreferrer'; link.target = '_blank';
        link.append(inlineDom(match[1]));
        fragment.append(link); index += match[0].length; continue;
      }
    }
    plain += text[index++];
  }
  flush();
  return fragment;
}

function parseList(lines: string[], start: number): { list: HTMLElement; next: number } {
  const first = lines[start].match(LIST_ITEM)!;
  const indentation = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2]) !== 1) (list as HTMLOListElement).start = parseInt(first[2]);
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(LIST_ITEM);
    if (!match || match[1].length !== indentation || /^\d/.test(match[2]) !== ordered) break;
    const item = document.createElement('li');
    const task = ordered ? null : match[3].match(TASK);
    if (task) { item.className = 'task'; item.dataset.checked = String(task[1] !== ' '); }
    item.append(inlineDom(task ? task[2] ?? '' : match[3]));
    list.append(item);
    index++;
    while (index < lines.length) {
      const nested = lines[index].match(LIST_ITEM);
      if (nested && nested[1].length > indentation) {
        const result = parseList(lines, index);
        item.append(result.list); index = result.next;
      } else if (lines[index].trim() && !nested && lines[index].search(/\S/) > indentation) {
        item.append(document.createElement('br'), inlineDom(lines[index].trim())); index++;
      } else break;
    }
    if (!lines[index]?.trim() && lines[index + 1]?.match(LIST_ITEM)?.[1].length === indentation) index++;
  }
  return { list, next: index };
}

function parseBlocks(lines: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s*(`{3,})([\w+-]*)\s*$/);
    if (fence) {
      const content: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      if (fence[2] === 'noter-database') {
        const database = readDatabase(content.join('\n'));
        if (database) { fragment.append(createDatabaseBlock(database)); continue; }
      }
      const pre = document.createElement('pre');
      pre.dataset.language = fence[2] || 'code';
      const code = document.createElement('code');
      const text = content.join('\n');
      code.textContent = text;
      // A final line break supplies a caret line box without adding a character to saved code.
      if (!text || text.endsWith('\n')) code.append(document.createElement('br'));
      pre.append(code); fragment.append(pre); continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.*)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      element.append(inlineDom(heading[2].replace(/\s+#+\s*$/, '')));
      fragment.append(element); index++; continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      const rule = document.createElement('hr');
      rule.contentEditable = 'false';
      fragment.append(rule); index++; continue;
    }
    const image = line.match(IMAGE);
    if (image) { fragment.append(imageFigure(image[2], image[1])); index++; continue; }
    if (isTableStart(lines, index)) {
      const header = tableCells(line);
      const align = tableCells(lines[index + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
      const rows = [header];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index++]);
        rows.push(header.map((_, column) => cells[column] ?? ''));
      }
      fragment.append(tableElement(rows, align)); continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*> ?/, ''));
      const toggle = quoted[0].match(TOGGLE);
      if (toggle) { fragment.append(toggleElement(inlineDom(toggle[2]), parseBlocks(quoted.slice(1)), toggle[1] !== '-')); continue; }
      const quote = document.createElement('blockquote');
      quote.append(parseBlocks(quoted));
      if (!quote.childNodes.length) quote.append(document.createElement('p'));
      fragment.append(quote); continue;
    }
    if (LIST_ITEM.test(line)) {
      const result = parseList(lines, index);
      fragment.append(result.list); index = result.next; continue;
    }
    const paragraph = document.createElement('p');
    const content = [line.replace(/ {2}$/, '')];
    index++;
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index]) && !IMAGE.test(lines[index]) && !isTableStart(lines, index)) content.push(lines[index++].replace(/ {2}$/, ''));
    paragraph.append(inlineDom(content.join('\n')));
    fragment.append(paragraph);
  }
  return fragment;
}

export function markdownToDom(markdown: string): DocumentFragment {
  const fragment = parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'));
  const last = fragment.lastElementChild;
  if (!last || ['HR', 'PRE', 'TABLE', 'FIGURE'].includes(last.tagName) || last.classList.contains('database-block') || last.classList.contains('toggle')) {
    const paragraph = document.createElement('p');
    paragraph.append(document.createElement('br'));
    fragment.append(paragraph);
  }
  return fragment;
}

function clean(text: string): string { return text.replace(/\u200b/g, '').replace(/\u00a0/g, ' '); }

/** Code is literal; caret placeholders must not change whitespace or Unicode characters. */
export function codeText(pre: Element): string { return pre.textContent ?? ''; }

function escapeText(text: string): string {
  return clean(text).replace(/([\\`*_\[\]#>])/g, '\\$1');
}

function longestTicks(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
  if (!(node instanceof Element)) return '';
  const content = Array.from(node.childNodes).map(inlineMarkdown).join('');
  switch (node.tagName) {
    case 'BR': return '  \n';
    case 'B': case 'STRONG': return clean(node.textContent ?? '') ? `**${content}**` : '';
    case 'I': case 'EM': return clean(node.textContent ?? '') ? `*${content}*` : '';
    case 'CODE': {
      const text = clean(node.textContent ?? '');
      if (!text) return '';
      const fence = '`'.repeat(longestTicks(text) + 1);
      const padding = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && !!text.trim()) ? ' ' : '';
      return `${fence}${padding}${text}${padding}${fence}`;
    }
    case 'A': {
      const href = safeUrl(node.getAttribute('href') ?? '');
      return href ? `[${content}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : content;
    }
    case 'UL': case 'OL': return '';
    case 'SPAN': {
      const target = node.classList.contains('note-link') ? node.getAttribute('data-target') : null;
      if (target) { const label = node.getAttribute('data-label'); return `[[${target}${label ? `|${label}` : ''}]]`; }
      return content;
    }
    default: return content;
  }
}

function serializeList(list: Element, indent = ''): string {
  const ordered = list.tagName === 'OL';
  let number = parseInt(list.getAttribute('start') ?? '1') || 1;
  return Array.from(list.children).map(item => {
    const prefix = ordered ? `${number++}. ` : '- ';
    const task = !ordered && item.classList.contains('task') ? `[${item.getAttribute('data-checked') === 'true' ? 'x' : ' '}]` : '';
    const text = Array.from(item.childNodes).map(inlineMarkdown).join('').trim();
    const continuation = indent + ' '.repeat(prefix.length);
    const lines = `${indent}${prefix}${task ? `${task} ` : ''}${text.replace(/\n/g, `\n${continuation}`)}`;
    const nested = Array.from(item.children).filter(child => child.tagName === 'UL' || child.tagName === 'OL');
    return lines + nested.map(child => '\n' + serializeList(child, continuation)).join('');
  }).join('\n');
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '').trim();
  if (!(node instanceof Element)) return '';
  if (node.classList.contains('toggle')) {
    const summary = node.querySelector(':scope > .toggle-summary');
    const title = summary ? Array.from(summary.childNodes).map(inlineMarkdown).join('').replace(/\s*\n\s*/g, ' ').trim() : '';
    const body = Array.from(node.querySelector(':scope > .toggle-body')?.childNodes ?? []).map(blockMarkdown).filter(Boolean).join('\n\n');
    const header = `> [!toggle]${node.getAttribute('data-open') === 'false' ? '-' : '+'}${title ? ` ${title}` : ''}`;
    return body ? `${header}\n${body.split('\n').map(line => line ? `> ${line}` : '>').join('\n')}` : header;
  }
  if (node.tagName === 'FIGURE' && node.classList.contains('md-image')) {
    const source = node.getAttribute('data-src') ?? '';
    return source ? `![${(node.getAttribute('data-alt') ?? '').replace(/[\]\n]/g, ' ')}](${source})` : '';
  }
  if (node.tagName === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.children).map(cell =>
      Array.from(cell.childNodes).map(inlineMarkdown).join('').replace(/\s*\n\s*/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const align = (node.getAttribute('data-align') ?? '').split(',');
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, column) => cells[column] ?? '').join(' | ')} |`;
    const delimiter = `| ${Array.from({ length: width }, (_, column) => ({ left: ':---', center: ':---:', right: '---:' } as Record<string, string>)[align[column]] ?? '---').join(' | ')} |`;
    return [line(rows[0]), delimiter, ...rows.slice(1).map(line)].join('\n');
  }
  if (node.classList.contains('database-block')) {
    const content = node.getAttribute('data-database') ?? '{}';
    const fence = '`'.repeat(Math.max(3, longestTicks(content) + 1));
    return `${fence}noter-database\n${content}\n${fence}`;
  }
  const text = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
  switch (node.tagName) {
    case 'H1': case 'H2': case 'H3': return text ? `${'#'.repeat(Number(node.tagName[1]))} ${text}` : '';
    case 'HR': return '---';
    case 'PRE': {
      const content = codeText(node);
      const language = node.getAttribute('data-language') ?? '';
      const fence = '`'.repeat(Math.max(3, longestTicks(content) + 1));
      return `${fence}${language === 'code' ? '' : language.replace(/[^\w+-]/g, '')}\n${content}\n${fence}`;
    }
    case 'BLOCKQUOTE': {
      const blocks = Array.from(node.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n');
      return blocks.split('\n').map(line => `> ${line}`).join('\n');
    }
    case 'UL': case 'OL': return serializeList(node);
    case 'DIV':
      if (node.querySelector('p,div,h1,h2,h3,pre,ul,ol,blockquote')) return Array.from(node.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n');
      return text;
    default: return text.replace(/^(\d+)\. /gm, '$1\\. ').replace(/^([-+]) /gm, '\\$1 ').replace(/^(-{3,})$/gm, '\\$1');
  }
}

export function domToMarkdown(root: HTMLElement): string {
  return Array.from(root.childNodes).map(blockMarkdown).filter(Boolean).join('\n\n').trim();
}
