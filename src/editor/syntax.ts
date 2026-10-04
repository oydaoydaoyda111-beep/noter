import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);

export const codeLanguages: [string, string][] = [
  ['code', 'Plain text'],
  ...hljs.listLanguages().filter(language => language !== 'plaintext')
    .map(language => [language, hljs.getLanguage(language)?.name ?? language] as [string, string])
    .sort((a, b) => a[1].localeCompare(b[1])),
];

export function codeLanguage(value: string): string {
  const name = value.toLowerCase();
  if (['code', 'text', 'txt', 'plaintext'].includes(name)) return 'code';
  const grammar = hljs.getLanguage(name);
  return codeLanguages.find(([language]) => grammar && hljs.getLanguage(language) === grammar)?.[0] ?? value;
}

const rendered = new WeakMap<HTMLPreElement, { text: string; language: string; html: string }>();

export function highlightCodeBlocks(root: HTMLElement): boolean {
  let changed = false;
  for (const pre of root.querySelectorAll('pre')) {
    const text = pre.textContent ?? '';
    const language = codeLanguage(pre.dataset.language || 'code');
    const previous = rendered.get(pre);
    const code = pre.querySelector('code');
    pre.spellcheck = false;
    if (code && previous?.text === text && previous.language === language && previous.html === code.innerHTML) continue;
    const next = document.createElement('code');
    if (language !== 'code' && codeLanguages.some(([name]) => name === language)) {
      next.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else next.textContent = text;
    if (!text || text.endsWith('\n')) next.append(document.createElement('br'));
    // Token markup is decorative; Markdown serialization and copying read only text.
    if (!code || pre.childNodes.length !== 1 || code.innerHTML !== next.innerHTML) {
      pre.replaceChildren(next); changed = true;
    }
    rendered.set(pre, { text, language, html: next.innerHTML });
  }
  return changed;
}
