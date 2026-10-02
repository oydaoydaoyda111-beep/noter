import type { Store } from '../state/workspace';
import { button, el } from '../ui/dom';
import { icon } from '../ui/icons';
import { animateOut } from '../ui/motion';

export function createTabs(container: HTMLElement, store: Store, open: (id: string) => void) {
  let previousIds: string[] = [];
  const closing = new Set<string>();
  container.setAttribute('role', 'tablist');
  container.setAttribute('aria-label', 'Open notes');

  async function close(id: string) {
    if (closing.has(id)) return;
    closing.add(id);
    const tab = Array.from(container.children).find(element => (element as HTMLElement).dataset.id === id) as HTMLElement | undefined;
    if (tab) await animateOut(tab);
    store.close(id); closing.delete(id);
  }

  container.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const id = tabs[next].dataset.id!; open(id);
    container.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });

  return {
    close,
    render() {
      const hadFocus = container.contains(document.activeElement);
      container.replaceChildren();
      const { openTabs, activeNoteId, nodes } = store.workspace;
      for (const id of openTabs) {
        const note = nodes[id]; if (note?.type !== 'note') continue;
        const active = activeNoteId === id;
        const tab = el('div', `tab${active ? ' is-active' : ''}${previousIds.includes(id) ? '' : ' is-new'}`);
        tab.dataset.id = id;
        const control = button(note.name, 'tab-control'); control.dataset.id = id;
        control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(active));
        control.setAttribute('aria-controls', 'note-panel'); control.tabIndex = active ? 0 : -1;
        control.append(icon('note'), el('span', 'tab-label', note.name));
        control.onclick = () => open(id);
        const dismiss = button(`Close ${note.name}`, 'tab-close'); dismiss.append(icon('close'));
        dismiss.onclick = () => void close(id); tab.append(control, dismiss); container.append(tab);
      }
      if (!openTabs.length) container.append(el('span', 'tabs-empty', 'A little room to think'));
      previousIds = [...openTabs];
      if (hadFocus) container.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      container.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    },
  };
}
