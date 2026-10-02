export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(label: string, className = 'icon-button'): HTMLButtonElement {
  const element = el('button', className);
  element.type = 'button';
  element.setAttribute('aria-label', label);
  element.title = label;
  return element;
}

export function emptyState(title: string, description: string): HTMLElement {
  const container = el('div', 'empty-state');
  container.append(el('p', 'empty-title', title), el('p', 'empty-description', description));
  return container;
}
