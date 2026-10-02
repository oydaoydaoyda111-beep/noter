import type { Store } from '../state/workspace';
import { demoWorkspace, emptyWorkspace } from '../state/demo';
import { el, button } from '../ui/dom';
import { icon } from '../ui/icons';
import { askDialog } from '../ui/dialog';
import { animateOut } from '../ui/motion';
import type { Settings } from '../types';

export function applySettings(settings: Settings) {
  const root = document.documentElement;
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--document-width', `${settings.documentWidth}px`);
  root.dataset.editorFont = settings.fontStyle;
  root.dataset.density = settings.density;
  root.dataset.motion = settings.motion;
}

export function openSettings(store: Store) {
  if (document.querySelector('.settings-dialog')) return;
  const dialog = el('dialog', 'dialog settings-dialog');
  dialog.setAttribute('aria-labelledby', 'settings-title');
  const header = el('div', 'dialog-header');
  const title = el('h2', '', 'Make it your space'); title.id = 'settings-title';
  const close = button('Close settings'); close.append(icon('close')); header.append(title, close);
  dialog.append(header, el('p', 'dialog-description', 'A few small adjustments to find your flow.'));

  function row(label: string, description: string, control: HTMLElement) {
    const wrapper = el('div', 'setting-row');
    const copy = el('div', 'setting-copy');
    const name = el('label', 'setting-label', label);
    const id = `setting-${label.toLowerCase().replace(/\s+/g, '-')}`;
    const field = control.matches('input,select') ? control : control.querySelector<HTMLElement>('input,select');
    if (field) { field.id = id; name.htmlFor = id; }
    else { name.id = `${id}-label`; control.setAttribute('aria-labelledby', name.id); }
    copy.append(name, el('p', 'setting-description', description)); wrapper.append(copy, control); dialog.append(wrapper);
  }

  const fontOptions = el('div', 'font-style-options');
  fontOptions.setAttribute('role', 'group');
  for (const [style, label] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']] as const) {
    const control = button(`Use ${label.toLowerCase()} document font`, 'font-style-button');
    control.textContent = label; control.dataset.fontStyle = style;
    control.setAttribute('aria-pressed', String(store.workspace.settings.fontStyle === style));
    control.onclick = () => {
      store.configure({ fontStyle: style });
      fontOptions.querySelectorAll<HTMLButtonElement>('button').forEach(option => option.setAttribute('aria-pressed', String(option === control)));
    };
    fontOptions.append(control);
  }
  row('Document font', 'Choose the character of your page.', fontOptions);

  const font = el('div', 'font-control');
  const range = el('input'); range.type = 'range'; range.min = '14'; range.max = '24'; range.step = '1';
  range.value = String(store.workspace.settings.fontSize); range.setAttribute('aria-label', 'Editor font size');
  const output = el('output', '', `${range.value}px`);
  font.append(range, output);
  range.oninput = () => { output.value = `${range.value}px`; store.configure({ fontSize: Number(range.value) }); };
  row('Editor type size', 'A comfortable size for your words.', font);

  function selectSetting<K extends 'density' | 'motion' | 'autosaveDelay' | 'documentWidth'>(key: K, label: string, description: string, options: [string, string][]) {
    const select = el('select', 'setting-select');
    options.forEach(([value, text]) => { const option = el('option', '', text); option.value = value; select.append(option); });
    select.value = String(store.workspace.settings[key]);
    select.onchange = () => store.configure({ [key]: key === 'autosaveDelay' || key === 'documentWidth' ? Number(select.value) : select.value });
    row(label, description, select);
  }
  selectSetting('documentWidth', 'Reading width', 'A little more space, or a closer focus.', [['720', 'Narrow (720 px)'], ['790', 'Balanced (790 px)'], ['850', 'Wide (850 px)']]);
  const preview = el('div', 'font-preview');
  const previewLine = store.activeNote?.markdown.split('\n').find(line => line.trim())?.replace(/^[#>]+\s*/, '').replace(/[`*_]/g, '');
  preview.append(el('span', 'font-preview-label', 'LIVE TYPE PREVIEW'), el('h3', 'font-preview-title', store.activeNote?.name ?? 'A little room to think'), el('p', 'font-preview-body', previewLine ?? 'Make the page feel like your own.'));
  dialog.append(preview);
  selectSetting('density', 'Interface spacing', 'Give the sidebar a little more room.', [['comfortable', 'Comfortable'], ['compact', 'Compact']]);
  selectSetting('motion', 'Animation', 'Set the pace of the interface.', [['full', 'Natural'], ['subtle', 'Subtle'], ['none', 'None']]);
  selectSetting('autosaveDelay', 'Autosave', 'How soon edits are stored on this device.', [['250', '250 ms'], ['650', '650 ms'], ['1200', '1.2 seconds'], ['2000', '2 seconds']]);
  const data = el('div', 'settings-data');
  data.append(el('h3', '', 'Workspace'), el('p', 'setting-description', 'Your notes live in this browser, on this device.'));
  const restore = button('Restore demo notes', 'button-secondary'); restore.textContent = 'Restore demo notes';
  restore.onclick = async () => {
    const confirmed = await askDialog({ title: 'Restore the demo workspace?', description: 'This replaces your current notes and folders with the original examples. Your appearance settings will stay.', submit: 'Restore demo', danger: true });
    if (confirmed) { const next = demoWorkspace(); next.settings = { ...store.workspace.settings }; store.replace(next); }
  };
  const erase = button('Erase workspace', 'text-button danger'); erase.textContent = 'Erase workspace';
  erase.onclick = async () => {
    const confirmed = await askDialog({ title: 'Start with a clean page?', description: 'This permanently removes every note, folder, open tab, and setting from this workspace.', submit: 'Erase workspace', danger: true });
    if (confirmed) { store.replace(emptyWorkspace()); void finish(); }
  };
  const actions = el('div', 'settings-data-actions'); actions.append(restore, erase); data.append(actions); dialog.append(data);
  const footer = el('p', 'settings-footer'); footer.append(icon('check'), document.createTextNode('Your preferences are saved automatically.')); dialog.append(footer);
  let closing = false;
  async function finish() {
    if (closing) return;
    closing = true; await animateOut(dialog); dialog.close();
  }
  close.onclick = () => void finish();
  dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) void finish();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); close.focus();
}
