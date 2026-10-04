import { el, button } from '../ui/dom';
import type { Finance } from './model';
import { transactionSelection, updateTransactions, type TransactionPatch } from './bulk';
import { categoryCatalog } from './categories';
import { createCategorySelectors } from './category-selectors';

export function editTransactions(getFinance: () => Finance, ids: Set<string>, commit: (next: Finance) => Promise<boolean>, done: () => void) {
  const source = getFinance(), selected = transactionSelection(source, ids), rows = source.transactions.filter(row => selected.has(row.id));
  if (!rows.length) return;
  const transfers = rows.some(row => row.transferId);
  const dialog = el('dialog', 'dialog finance-dialog'); dialog.setAttribute('aria-label', 'Edit selected transactions');
  const form = el('form'), grid = el('div', 'finance-form-grid');
  function field(name: string, content: HTMLElement, disabled = false) {
    const group = el('div', 'finance-bulk-field'), label = el('label', 'finance-bulk-toggle'), enabled = el('input'); enabled.type = 'checkbox'; enabled.name = `change-${name}`; enabled.disabled = disabled;
    label.append(enabled, document.createTextNode(`Change ${name}`));
    const controls = el('fieldset'); controls.disabled = true; controls.append(content); group.append(label, controls); grid.append(group);
    enabled.onchange = () => { controls.disabled = !enabled.checked; if (enabled.checked) controls.querySelector<HTMLElement>('input,select,button')?.focus(); };
    return enabled;
  }
  function input(name: string, value: string, type = 'text') {
    const control = el('input', 'field-input'); control.name = name; control.type = type; control.value = value; control.maxLength = 2000; control.setAttribute('aria-label', `New ${name}`); return control;
  }
  const date = input('date', rows[0].date, 'date'); date.required = true; const changeDate = field('date', date);
  const account = el('select', 'field-input'); account.name = 'account'; account.setAttribute('aria-label', 'New account');
  for (const item of source.accounts.filter(item => !item.archived)) { const option = el('option', '', item.name); option.value = item.name; account.append(option); }
  if (source.accounts.some(item => !item.archived && item.name === rows[0].account)) account.value = rows[0].account;
  const changeAccount = field('account', account, transfers);
  const categories = createCategorySelectors(categoryCatalog(source), { category: '', subcategory: '' }, false);
  const changeCategory = field('category', categories.root, transfers);
  const payee = input('payee', rows.every(row => row.payee === rows[0].payee) ? rows[0].payee : ''); const changePayee = field('payee', payee);
  const note = input('note', rows.every(row => row.note === rows[0].note) ? rows[0].note : ''); const changeNote = field('note', note);
  const error = el('p', 'finance-error'); error.setAttribute('role', 'alert');
  const cancel = button('Cancel', 'button-secondary'); cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  const submit = el('button', 'button-primary', 'Apply changes'); submit.type = 'submit';
  const actions = el('div', 'dialog-actions'); actions.append(cancel, submit);
  form.append(el('h2', '', `Edit ${selected.size} selected entries`), el('p', 'dialog-description', 'Check only the fields you want to replace. Amounts and transaction IDs stay the same.'), grid);
  if (transfers) form.append(el('p', 'dialog-description', 'Both entries of linked transfers are included. For this selection, only date, payee and note can be changed; edit transfer accounts individually.'));
  form.append(error, actions);
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    try {
      const patch: TransactionPatch = {};
      if (changeDate.checked) patch.date = date.value;
      if (changeAccount.checked) patch.account = account.value;
      if (changeCategory.checked) Object.assign(patch, categories.value());
      if (changePayee.checked) patch.payee = payee.value.trim();
      if (changeNote.checked) patch.note = note.value.trim();
      const next = updateTransactions(getFinance(), selected, patch);
      saving = true; cancel.disabled = submit.disabled = true;
      if (await commit(next)) { done(); dialog.close(); } else error.textContent = 'Could not save. Your changes are still in this dialog; resolve the save error and try again.';
    } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'Could not update transactions.'; }
    finally { saving = false; cancel.disabled = submit.disabled = false; }
  };
  dialog.append(form); dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); doneFocus(); }, { once: true });
  function doneFocus() { (document.querySelector<HTMLElement>('[aria-label="Edit selected transactions"]') ?? document.querySelector<HTMLElement>('[aria-label="Select all matching transactions"]'))?.focus(); }
  document.body.append(dialog); dialog.showModal(); grid.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
}
