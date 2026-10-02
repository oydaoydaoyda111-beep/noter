interface BlockAnchor { path: number[]; offset: number; }
export interface Bookmark { start: number; end: number; startAnchor?: BlockAnchor; endAnchor?: BlockAnchor; }

export function selectionRange(root: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null;
}

export function bookmark(root: HTMLElement): Bookmark | null {
  const range = selectionRange(root);
  if (!range) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  before.setEnd(range.endContainer, range.endOffset);
  const anchor = (node: Node, offset: number): BlockAnchor | undefined => {
    const element = node instanceof Element ? node : node.parentElement;
    const block = element?.closest<HTMLElement>('p,h1,h2,h3,li,pre,div');
    if (!block || block === root) return;
    const path: number[] = [];
    let child: Node = block;
    while (child.parentNode && child !== root) {
      path.unshift(Array.from(child.parentNode.childNodes).indexOf(child as ChildNode));
      child = child.parentNode;
    }
    const preceding = document.createRange();
    preceding.selectNodeContents(block); preceding.setEnd(node, offset);
    return { path, offset: preceding.toString().length };
  };
  return { start, end: before.toString().length, startAnchor: anchor(range.startContainer, range.startOffset), endAnchor: anchor(range.endContainer, range.endOffset) };
}

export function restoreBookmark(root: HTMLElement, position: Bookmark | null) {
  if (!position) return;
  const endpoint = (absolute: number, anchor?: BlockAnchor): [Node, number] => {
    let container: Node | undefined = root;
    if (anchor) for (const index of anchor.path) container = container?.childNodes[index];
    const anchored = !!anchor && container instanceof HTMLElement && container.matches('p,h1,h2,h3,li,pre,div,ul,ol,blockquote');
    const target = anchored ? container! : root;
    const desired = anchored ? anchor!.offset : absolute;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let last: Text | null = null;
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (offset + text.length >= desired) return [text, Math.max(0, desired - offset)];
      offset += text.length; last = text;
    }
    if (last) return [last, last.length];
    const element = target as HTMLElement;
    const block = element.querySelector<HTMLElement>('p,h1,h2,h3,li,pre') ?? element;
    return [block.tagName === 'PRE' ? block.querySelector('code') ?? block : block, 0];
  };
  const range = document.createRange();
  range.setStart(...endpoint(position.start, position.startAnchor));
  range.setEnd(...endpoint(position.end, position.endAnchor));
  setRange(range);
}

export function setRange(range: Range) {
  const selection = window.getSelection();
  selection?.removeAllRanges(); selection?.addRange(range);
}

export function caretAt(node: Node, end = false) {
  const range = document.createRange();
  range.selectNodeContents(node); range.collapse(!end); setRange(range);
}

export function currentBlock(root: HTMLElement): HTMLElement | null {
  const range = selectionRange(root);
  const element = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
  const block = element?.closest<HTMLElement>('p,h1,h2,h3,li,pre,div');
  return block && block !== root && root.contains(block) ? block : null;
}

export function textBeforeCaret(block: HTMLElement, range: Range): string {
  const before = document.createRange();
  before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
  return before.toString();
}
