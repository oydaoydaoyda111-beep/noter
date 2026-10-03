import { el, button } from '../ui/dom';
import { balances, type Finance } from './model';
import { updateAccount, archiveAccount } from './accounts';

export function manageAccounts(getFinance: () => Finance, commit: (next: Finance) => Promise<boolean>, format: (cents: number) => string, getDefault: () => string, setDefault: (name: string) => void) {
  const dialog = el('dialog', 'dialog finance-category-dialog finance-account-dialog'); dialog.setAttribute('aria-label', 'Manage accounts');
  const header = el('div', 'dialog-header');
  const close = button('Close account manager'); close.textContent = '×'; close.onclick = () => dialog.close(); header.append(el('h2', '', 'Manage accounts'), close);
  const search = el('input', 'field-input'); search.type = 'search'; search.placeholder = 'Find an account…'; search.setAttribute('aria-label', 'Find accounts');
  const status = el('p', 'finance-local'); status.setAttribute('role', 'status');
  const list = el('div', 'finance-account-list'); let saving = false;
  function control(label: string, action: () => void, disabled = false) { const item = button(label, 'button-secondary'); item.textContent = label; item.disabled = saving || disabled; item.onclick = action; return item; }
  async function apply(operation: (finance: Finance) => Finance, done?: () => void) {
    if (saving) return false;
    try {
      const next = operation(getFinance()); saving = true; render();
      if (!await commit(next)) throw new Error('Could not save accounts. Please try again.');
      done?.(); status.textContent = 'Saved on this device.'; status.classList.remove('finance-error'); return true;
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not update account.'; status.classList.add('finance-error'); return false; }
    finally { saving = false; render(); }
  }
  function edit(previous?: string) {
    const account = getFinance().accounts.find(item => item.name === previous);
    const editor = el('dialog', 'dialog'); editor.setAttribute('aria-label', previous ? 'Edit account' : 'Add account');
    const form = el('form'), name = el('input', 'field-input'), note = el('textarea', 'field-input');
    name.required = true; name.maxLength = 120; name.value = account?.name ?? ''; note.maxLength = 2000; note.rows = 3; note.value = account?.note ?? '';
    const nameLabel = el('label', 'field-label', 'Account name'), noteLabel = el('label', 'field-label', 'Account notes (optional)'); nameLabel.append(name); noteLabel.append(note);
    const error = el('p', 'finance-error'); error.setAttribute('role', 'alert');
    const actions = el('div', 'dialog-actions'), submit = el('button', 'button-primary', 'Save account'); submit.type = 'submit';
    actions.append(control('Cancel', () => editor.close()), submit);
    form.append(el('h2', '', previous ? 'Edit account' : 'Add account'), el('p', 'dialog-description', previous ? 'Renaming updates existing transactions and linked transfers. Balances stay the same.' : 'Starts at zero. Add an income entry with category Initial for an opening balance.'), nameLabel, noteLabel, error, actions);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true;
      const selected = getDefault();
      if (await apply(finance => updateAccount(finance, previous, name.value, note.value.trim()), () => { if (previous && selected === previous) setDefault(name.value.trim()); })) editor.close();
      else { error.textContent = status.textContent; submit.disabled = false; }
    };
    editor.append(form); document.body.append(editor); editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); }); editor.addEventListener('close', () => { editor.remove(); search.focus(); }, { once: true }); editor.showModal(); name.focus();
  }
  const add = control('Add account', () => edit());
  dialog.append(header, el('p', 'dialog-description', 'Edit names and notes, choose a default, or archive accounts. Archived accounts retain balances and history and can be restored anytime.'), search, add, status, list);
  function render() {
    list.replaceChildren(); add.disabled = close.disabled = saving;
    const finance = getFinance(), totals = balances(finance), needle = search.value.trim().toLocaleLowerCase();
    const visible = finance.accounts.filter(account => [account.name, account.note].some(value => value.toLocaleLowerCase().includes(needle)));
    if (!visible.length) list.append(el('p', 'finance-no-results', 'No accounts match.'));
    for (const account of visible) {
      const card = el('div', 'finance-account-row'), info = el('div', 'finance-account-info'), count = finance.transactions.filter(row => row.account === account.name).length;
      info.append(el('strong', '', account.name), el('span', 'finance-account-meta', `${format(totals.get(account.name) ?? 0)} · ${count} ${count === 1 ? 'transaction' : 'transactions'}${account.archived ? ' · Archived' : ''}${getDefault() === account.name ? ' · Default' : ''}`));
      if (account.note) info.append(el('span', 'finance-account-note', account.note));
      card.append(info);
      const tools = el('div', 'finance-account-actions');
      tools.append(control('Edit', () => edit(account.name)), control(getDefault() === account.name ? 'Default' : 'Set default', () => { setDefault(account.name); render(); }, !!account.archived || getDefault() === account.name), control(account.archived ? 'Restore' : 'Archive', () => void apply(finance => archiveAccount(finance, account.name, !account.archived), () => { if (!account.archived && getDefault() === account.name) setDefault(''); })));
      card.append(tools); list.append(card);
    }
  }
  search.oninput = render; render(); document.body.append(dialog); dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); }); dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); search.focus();
}
