import { button, el } from './dom';

const emojis = [
  ['📝', 'Memo'], ['📚', 'Books'], ['💡', 'Idea'], ['⭐', 'Star'],
  ['🎯', 'Target'], ['🚀', 'Rocket'], ['💻', 'Computer'], ['🛠️', 'Tools'],
  ['📅', 'Calendar'], ['✅', 'Check'], ['📌', 'Pin'], ['📂', 'Folder'],
  ['🏠', 'Home'], ['🌱', 'Seedling'], ['🌿', 'Herb'], ['🌸', 'Flower'],
  ['☀️', 'Sun'], ['🌙', 'Moon'], ['🔥', 'Fire'], ['❤️', 'Heart'],
  ['🎨', 'Art'], ['🎵', 'Music'], ['📷', 'Camera'], ['🎬', 'Movie'],
  ['☕', 'Coffee'], ['🍳', 'Cooking'], ['🏃', 'Running'], ['✈️', 'Travel'],
  ['🌍', 'World'], ['💼', 'Work'], ['🧠', 'Brain'], ['🔖', 'Bookmark'],
] as const;

export function nameEmoji(name: string): string | null {
  return name.trimStart().match(/^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/u)?.[0] ?? null;
}

/** Emojis are part of the name, so exports and search keep them naturally. */
export function createNameEmojiPicker(input: HTMLInputElement): HTMLElement {
  const wrapper = el('div', 'name-emoji-picker');
  const actions = el('div', 'name-emoji-actions');
  const toggle = button('Add emoji to name', 'name-emoji-toggle');
  const remove = button('Remove emoji from name', 'name-emoji-remove');
  remove.textContent = 'Remove';
  const choices = el('div', 'name-emoji-choices');
  choices.id = `emoji-choices-${crypto.randomUUID()}`;
  choices.hidden = true;
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Choose an emoji');
  toggle.setAttribute('aria-controls', choices.id);
  toggle.setAttribute('aria-expanded', 'false');

  function current() { return nameEmoji(input.value); }

  function update() {
    const selected = current();
    toggle.textContent = selected ? `${selected} Change emoji` : '☺ Add emoji';
    const label = selected ? 'Change emoji in name' : 'Add emoji to name';
    toggle.setAttribute('aria-label', label); toggle.title = label;
    remove.hidden = !selected;
    choices.querySelectorAll<HTMLButtonElement>('button').forEach(control => {
      control.setAttribute('aria-pressed', String(control.textContent === selected));
    });
  }

  function close() {
    choices.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function apply(emoji: string) {
    const selected = current();
    const name = selected ? input.value.trimStart().slice(selected.length).trimStart() : input.value.trimStart();
    const next = emoji ? `${emoji} ${name}` : name;
    if (next.length > input.maxLength) {
      input.setCustomValidity('Shorten the name to make room for the emoji.');
      input.reportValidity();
      return;
    }
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  }

  for (const [emoji, name] of emojis) {
    const choice = button(`Use ${name.toLowerCase()} emoji`, 'name-emoji-choice');
    choice.textContent = emoji;
    choice.onclick = () => apply(emoji);
    choices.append(choice);
  }
  toggle.onclick = () => {
    choices.hidden = !choices.hidden;
    toggle.setAttribute('aria-expanded', String(!choices.hidden));
    if (!choices.hidden) choices.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  };
  remove.onclick = () => apply('');
  choices.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(); toggle.focus();
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const controls = Array.from(choices.querySelectorAll<HTMLButtonElement>('button'));
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -8 : 8;
    controls[(index + offset + controls.length) % controls.length]?.focus();
  });
  input.addEventListener('input', update);
  actions.append(toggle, remove);
  wrapper.append(actions, choices, el('p', 'name-emoji-hint', 'Pick an emoji, or type your own directly in the name.'));
  update();
  return wrapper;
}
