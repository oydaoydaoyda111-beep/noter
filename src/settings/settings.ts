import { workspacePath } from '../desktop/platform';
import type { Store } from '../state/workspace';
import { demoWorkspace, emptyWorkspace } from '../state/demo';
import { el, button } from '../ui/dom';
import { icon } from '../ui/icons';
import { askDialog } from '../ui/dialog';
import { animateOut } from '../ui/motion';
import type { Settings } from '../types';
import { defaultSettings } from './model';

export function applySettings(settings: Settings) {
  const root = document.documentElement;
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--document-width', `${settings.documentWidth}px`);
  root.dataset.editorFont = settings.fontStyle;
  root.dataset.density = settings.density;
  root.dataset.motion = settings.motion;
  root.dataset.accent = settings.accentColor;
  root.dataset.noteStats = String(settings.showNoteStats);
  root.dataset.financeDensity = settings.financeTableDensity;
  const editor = document.querySelector<HTMLElement>('#editor'); if (editor) editor.spellcheck = settings.spellcheck;
}

export function openSettings(store: Store, accounts: string[] = [], dataActions?: { reload: () => Promise<void>; chooseFolder: () => Promise<void>; exportNotes: () => Promise<void>; importNotes: () => Promise<void> }) {
  if (document.querySelector('.settings-dialog')) return;
  const dialog = el('dialog', 'dialog settings-dialog');
  dialog.setAttribute('aria-labelledby', 'settings-title');
  const header = el('div', 'dialog-header');
  const title = el('h2', '', 'Settings'); title.id = 'settings-title';
  const close = button('Close settings'); close.append(icon('close')); header.append(title, close);
  dialog.append(header, el('p', 'dialog-description', 'Make Noter work the way you do.'));
  const navigation = el('div', 'settings-navigation'); navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', 'Settings sections');
  const panels = ['Appearance', 'Workspace', 'Finance'].map((name, index) => {
    const tab = button(name, 'settings-tab'); tab.textContent = name; tab.setAttribute('role', 'tab'); tab.id = `settings-tab-${index}`;
    const panel = el('section', 'settings-panel'); panel.id = `settings-panel-${index}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    tab.setAttribute('aria-controls', panel.id); navigation.append(tab); return { tab, panel };
  });
  function show(index: number, focus = false) {
    panels.forEach((item, current) => { item.tab.setAttribute('aria-selected', String(index === current)); item.tab.tabIndex = index === current ? 0 : -1; item.panel.hidden = index !== current; });
    if (focus) panels[index].tab.focus();
  }
  panels.forEach((item, index) => {
    item.tab.onclick = () => show(index);
    item.tab.onkeydown = event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % panels.length : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); show(next, true); }
    };
  });
  dialog.append(navigation, ...panels.map(item => item.panel)); show(0);
  let section = panels[0].panel;

  function row(label: string, description: string, control: HTMLElement) {
    const wrapper = el('div', 'setting-row');
    const copy = el('div', 'setting-copy');
    const name = el('label', 'setting-label', label);
    const id = `setting-${label.toLowerCase().replace(/\s+/g, '-')}`;
    const field = control.matches('input,select') ? control : control.querySelector<HTMLElement>('input,select');
    if (field) { field.id = id; name.htmlFor = id; }
    else { name.id = `${id}-label`; control.setAttribute('aria-labelledby', name.id); }
    copy.append(name, el('p', 'setting-description', description)); wrapper.append(copy, control); section.append(wrapper);
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

  function selectSetting<K extends keyof Settings>(key: K, label: string, description: string, options: [string, string][]) {
    const select = el('select', 'setting-select');
    options.forEach(([value, text]) => { const option = el('option', '', text); option.value = value; select.append(option); });
    select.value = String(store.workspace.settings[key]);
    select.onchange = () => store.configure({ [key]: ['autosaveDelay', 'documentWidth', 'financePageSize'].includes(key) ? Number(select.value) : select.value });
    row(label, description, select);
  }
  selectSetting('documentWidth', 'Reading width', 'A little more space, or a closer focus.', [['720', 'Narrow (720 px)'], ['790', 'Balanced (790 px)'], ['850', 'Wide (850 px)']]);
  const preview = el('div', 'font-preview');
  const previewLine = store.activeNote?.markdown.split('\n').find(line => line.trim())?.replace(/^[#>]+\s*/, '').replace(/[`*_]/g, '');
  preview.append(el('span', 'font-preview-label', 'LIVE TYPE PREVIEW'), el('h3', 'font-preview-title', store.activeNote?.name ?? 'A little room to think'), el('p', 'font-preview-body', previewLine ?? 'Make the page feel like your own.'));
  section.append(preview);
  selectSetting('density', 'Interface spacing', 'Give the sidebar a little more room.', [['comfortable', 'Comfortable'], ['compact', 'Compact']]);
  selectSetting('accentColor', 'Accent color', 'Highlights, buttons, and selection.', [['blue', 'Soft blue'], ['green', 'Sage green'], ['purple', 'Lavender']]);
  selectSetting('motion', 'Animation', 'Set the pace of the interface.', [['full', 'Natural'], ['subtle', 'Subtle'], ['none', 'None']]);
  function toggleSetting(key: 'spellcheck' | 'showNoteStats' | 'financeRememberEntries' | 'financeShowAccountNotes', label: string, description: string) {
    const control = el('input', 'setting-checkbox'); control.type = 'checkbox'; control.checked = store.workspace.settings[key]; control.onchange = () => store.configure({ [key]: control.checked }); row(label, description, control);
  }
  section = panels[1].panel;
  selectSetting('startupSection', 'Start in', 'The section shown when you next open Noter.', [['last', 'Last used section'], ['notes', 'Notes'], ['finance', 'Finance'], ['planner', 'Planner']]);
  toggleSetting('spellcheck', 'Spellcheck', 'Check spelling while writing notes.');
  toggleSetting('showNoteStats', 'Word and character counts', 'Show note statistics in the status bar.');
  selectSetting('autosaveDelay', 'Autosave', 'How soon edits are stored on this device.', [['250', '250 ms'], ['650', '650 ms'], ['1200', '1.2 seconds'], ['2000', '2 seconds']]);
  const data = el('div', 'settings-data');
  data.append(el('h3', '', 'Workspace'), el('p', 'setting-description', 'Notes are Markdown files in your workspace folder.'));
  const restore = button('Restore demo notes', 'button-secondary'); restore.textContent = 'Restore demo notes';
  restore.onclick = async () => {
    const confirmed = await askDialog({ title: 'Restore the demo workspace?', description: 'This replaces your current notes and folders with the original examples. Your appearance settings will stay.', submit: 'Restore demo', danger: true });
    if (confirmed) { const next = demoWorkspace(); next.settings = { ...store.workspace.settings }; store.replace(next); }
  };
  const erase = button('Erase notes', 'text-button danger'); erase.textContent = 'Erase notes';
  erase.onclick = async () => {
    const confirmed = await askDialog({ title: 'Erase notes and reset settings?', description: 'This permanently removes notes, folders, and open tabs, and resets preferences. Your Finance transactions and accounts are kept.', submit: 'Erase notes', danger: true });
    if (confirmed) { store.replace(emptyWorkspace()); void finish(); }
  };
  const actions = el('div', 'settings-data-actions');
  if (dataActions) {
    data.append(el('p', 'setting-description settings-vault-path', workspacePath));
    const result = el('p', 'setting-description'); result.setAttribute('role', 'status');
    function dataButton(label: string, callback: () => Promise<void>) {
      const control = button(label, 'button-secondary'); control.textContent = label;
      control.onclick = async () => { control.disabled = true; try { await callback(); } catch (error) { result.textContent = String(error); } finally { control.disabled = false; } }; actions.append(control);
    }
    dataButton('Change workspace folder', dataActions.chooseFolder);
    dataButton('Reload synced files', async () => { dialog.close(); await dataActions.reload(); });
    dataButton('Export notes backup', dataActions.exportNotes);
    dataButton('Restore notes backup', dataActions.importNotes);
    data.append(result);
  }
  actions.append(restore, erase); data.append(actions); section.append(data);
  section = panels[2].panel;
  selectSetting('financeCurrency', 'Currency display', 'Labels amounts only; no conversion is performed. Use one currency for all accounts.', [['', 'No currency label'], ['AZN', 'AZN — Manat'], ['USD', 'USD — Dollar'], ['EUR', 'EUR — Euro'], ['GBP', 'GBP — Pound'], ['TRY', 'TRY — Lira']]);
  selectSetting('financeDateFormat', 'Date display', 'How transaction dates appear in the table.', [['iso', 'YYYY-MM-DD'], ['dmy', 'DD/MM/YYYY'], ['mdy', 'MM/DD/YYYY']]);
  selectSetting('financeTableDensity', 'Transaction spacing', 'Choose how much space each row uses.', [['compact', 'Compact'], ['comfortable', 'Comfortable']]);
  selectSetting('financePageSize', 'Transactions per page', 'How many matching entries appear at once.', [['25', '25'], ['50', '50'], ['100', '100'], ['200', '200']]);
  const accountOptions: [string, string][] = [['', 'Automatic'], ...accounts.map(name => [name, name] as [string, string])];
  const defaultAccount = store.workspace.settings.financeDefaultAccount;
  if (defaultAccount && !accounts.includes(defaultAccount)) accountOptions.push([defaultAccount, `${defaultAccount} (unavailable)`]);
  selectSetting('financeDefaultAccount', 'Default account', 'Use this account for new entries. Automatic uses the last account when remembering entries is on.', accountOptions);
  toggleSetting('financeRememberEntries', 'Remember entry choices', 'Reuse your last account and category for the next entry.');
  toggleSetting('financeShowAccountNotes', 'Account notes', 'Show account notes underneath each balance.');
  section.append(el('p', 'setting-description', 'Finance data is stored in .noter inside your synced folder. Use Export Excel backup for a workbook copy.'));
  const reset = button('Reset preferences', 'button-secondary'); reset.textContent = 'Reset preferences';
  reset.onclick = async () => {
    const answer = await askDialog({ title: 'Reset preferences?', description: 'Restore default appearance, workspace, and Finance preferences. Your notes, transactions, and accounts are kept.', submit: 'Reset preferences' });
    if (answer) { store.configure({ ...defaultSettings }); dialog.close(); }
  };
  const footer = el('div', 'settings-footer'); footer.append(el('span', '', 'Changes apply immediately and save on this device.'), reset); dialog.append(footer);
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
