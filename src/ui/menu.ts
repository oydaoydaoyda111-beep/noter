import { el, button } from './dom';
import { icon, type IconName } from './icons';

/** `hint` shows a keyboard shortcut; `separator` draws a divider above the item. */
export interface MenuItem { label: string; icon: IconName; action: () => void; danger?: boolean; hint?: string; separator?: boolean; disabled?: boolean; }

let dismissCurrent: (() => void) | null = null;

export function showMenu(x: number, y: number, items: MenuItem[], trigger?: HTMLElement, label = 'File actions') {
  dismissCurrent?.();
  const menu = el('div', 'context-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  const close = (restoreFocus = false) => {
    menu.remove();
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('resize', resize);
    dismissCurrent = null;
    if (restoreFocus) trigger?.focus();
  };
  const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
  const resize = () => close();
  for (const item of items) {
    const control = button(item.label, `menu-item${item.danger ? ' danger' : ''}`);
    control.setAttribute('role', 'menuitem'); control.append(icon(item.icon), el('span', 'menu-label', item.label));
    if (item.hint) control.append(el('kbd', 'menu-hint', item.hint));
    control.disabled = !!item.disabled;
    control.onclick = () => { close(); item.action(); };
    if (item.separator && menu.childElementCount) menu.append(el('div', 'menu-separator'));
    menu.append(control);
  }
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
  menu.addEventListener('keydown', event => {
    const controls = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); controls[(index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length]?.focus();
    }
  });
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', resize);
  dismissCurrent = () => close();
}
