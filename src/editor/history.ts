import { bookmark, restoreBookmark, type Bookmark } from './selection';

interface Snapshot { html: string; selection: Bookmark | null; }

export function createHistory(root: HTMLElement, onChange: () => void) {
  const undo: Snapshot[] = [];
  const redo: Snapshot[] = [];
  let lastEdit = 0;
  const snapshot = (): Snapshot => ({ html: root.innerHTML, selection: bookmark(root) });
  const restore = (entry: Snapshot) => {
    root.innerHTML = entry.html;
    root.focus(); restoreBookmark(root, entry.selection); onChange();
    lastEdit = 0;
  };
  return {
    record(force = false) {
      const now = Date.now();
      if (force || now - lastEdit > 600) {
        undo.push(snapshot());
        if (undo.length > 100) undo.shift();
      }
      redo.length = 0;
      lastEdit = now;
    },
    undo() {
      const previous = undo.pop();
      if (!previous) return;
      redo.push(snapshot()); restore(previous);
    },
    redo() {
      const next = redo.pop();
      if (!next) return;
      undo.push(snapshot()); restore(next);
    },
    reset() { undo.length = 0; redo.length = 0; lastEdit = 0; },
  };
}
