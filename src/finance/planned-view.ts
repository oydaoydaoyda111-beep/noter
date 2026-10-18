import { el, button } from '../ui/dom';
import { askDialog } from '../ui/dialog';
import { money, type Finance } from './model';
import { plannedTotals, type ExpensePlans, type PlannedExpense } from './planned';
import { loadExpensePlans, saveExpensePlans } from './planned-storage';

export function showPlannedExpenses(getFinance: () => Finance, format: (cents: number) => string, restoreFocus: () => void) {
  const dialog = el('dialog', 'dialog finance-dialog finance-planned-dialog'); dialog.setAttribute('aria-label', 'Planned expenses');
  const header = el('div', 'dialog-header'), close = button('Close planned expenses', 'button-secondary'); close.textContent = 'Close';
  header.append(el('h2', '', 'Planned expenses'), close);
  const content = el('fieldset', 'finance-planned-content'), status = el('p', 'finance-error'); status.setAttribute('role', 'alert');
  dialog.append(header, el('p', 'dialog-description', 'Plan one-time expenses against your total balance across active accounts. Delete a plan when you no longer need it.'), content, status);
  let plans: ExpensePlans = { version: 1, expenses: [] }, revision: string | null = null;
  let busy = false, ready = false, needsReload = false;
  let editing: PlannedExpense | undefined, name = '', amount = '', draftId = crypto.randomUUID();
  function action(label: string, text: string, run: () => void) {
    const control = button(label, 'button-secondary'); control.textContent = text; control.onclick = run; return control;
  }
  function setBusy(value: boolean) { busy = value; content.disabled = value; close.disabled = value; }
  function focusName() { content.querySelector<HTMLInputElement>('[name="planned-name"]')?.focus(); }
  function resetDraft() { editing = undefined; name = amount = ''; draftId = crypto.randomUUID(); }
  async function dismiss() {
    if (busy) return;
    const changed = editing ? name !== editing.name || amount !== (editing.cents / 100).toFixed(2) : !!(name || amount);
    if (changed && !await askDialog({ title: 'Discard this expense draft?', description: 'Saved planned expenses will be kept.', submit: 'Discard draft', danger: true })) return;
    dialog.close();
  }
  close.onclick = () => void dismiss();
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('close', () => { dialog.remove(); restoreFocus(); }, { once: true });
  async function load() {
    setBusy(true); status.textContent = 'Loading…';
    try {
      const loaded = await loadExpensePlans(); plans = loaded.plans; revision = loaded.revision; ready = true; needsReload = false;
      status.textContent = ''; render();
    } catch (error) { ready = false; status.textContent = String(error); render(); }
    finally { setBusy(false); if (ready) focusName(); }
  }
  async function save(next: ExpensePlans): Promise<boolean> {
    if (busy || !ready || needsReload) return false;
    setBusy(true); status.textContent = 'Saving…';
    try {
      revision = await saveExpensePlans(next, revision); plans = next; status.textContent = ''; return true;
    } catch (error) {
      needsReload = true; status.textContent = `${String(error)} Your draft is kept. Use Reload plans before trying again.`; return false;
    } finally { setBusy(false); }
  }
  function render() {
    content.replaceChildren();
    content.append(action('Reload planned expenses', 'Reload plans', () => void load()));
    if (!ready) return;
    const summary = el('div', 'finance-planned-summary'); summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
    try {
      const totals = plannedTotals(getFinance(), plans);
      for (const [label, cents] of [['Active-account balance', totals.balance], ['Planned expenses', totals.planned], ['Remaining', totals.remaining]] as const) {
        const item = el('div'); item.append(el('span', 'finance-local', label), el('strong', cents < 0 ? 'negative' : '', format(cents))); summary.append(item);
      }
    } catch (error) { summary.append(el('p', 'finance-error', String(error))); }
    content.append(summary);
    const list = el('div', 'finance-planned-list'); list.setAttribute('aria-label', 'Saved planned expenses');
    if (!plans.expenses.length) list.append(el('p', 'finance-local', 'No planned expenses yet.'));
    for (const expense of plans.expenses) {
      const row = el('div', 'finance-planned-row');
      if (editing?.id === expense.id) row.append(editor());
      else {
        row.append(el('span', 'finance-planned-name', expense.name), el('strong', '', format(expense.cents)),
          action(`Edit planned expense ${expense.name}`, 'Edit', () => {
            if (name || amount || editing) { status.textContent = 'Save or cancel the current draft first.'; focusName(); return; }
            editing = { ...expense }; name = expense.name; amount = (expense.cents / 100).toFixed(2); render(); focusName();
          }),
          action(`Delete planned expense ${expense.name}`, 'Delete', () => void (async () => {
            if (await save({ ...plans, expenses: plans.expenses.filter(item => item.id !== expense.id) })) { render(); content.querySelector<HTMLButtonElement>('[aria-label="Reload planned expenses"]')?.focus(); }
          })()));
      }
      list.append(row);
    }
    content.append(list);
    // Retain a draft even if an incoming change deleted the entry being edited.
    if (!editing || !plans.expenses.some(item => item.id === editing?.id)) content.append(editor());
  }
  function editor() {
    const form = el('form', 'finance-planned-editor');
    const title = el('input', 'field-input'); title.name = 'planned-name'; title.setAttribute('aria-label', 'Planned expense name'); title.placeholder = 'Expense name'; title.required = true; title.value = name; title.oninput = () => { name = title.value; };
    const value = el('input', 'field-input'); value.name = 'planned-amount'; value.setAttribute('aria-label', 'Planned expense amount'); value.placeholder = '0.00'; value.inputMode = 'decimal'; value.required = true; value.value = amount; value.oninput = () => { amount = value.value; };
    const submit = el('button', 'button-primary', editing ? 'Save' : 'Add'); submit.type = 'submit';
    form.append(title, value, submit);
    if (editing || name || amount) form.append(action('Cancel planned expense draft', 'Cancel', () => { resetDraft(); status.textContent = ''; render(); focusName(); }));
    form.onsubmit = event => {
      event.preventDefault(); if (busy) return;
      void (async () => {
        try {
          if (needsReload) throw new Error('Reload plans before saving. Your draft is kept.');
          if (!name.trim()) throw new Error('Enter an expense name.');
          const cents = money(amount); if (cents <= 0) throw new Error('Enter an amount greater than zero.');
          const latest = editing ? plans.expenses.find(item => item.id === editing?.id) : undefined;
          if (editing && (!latest || latest.name !== editing.name || latest.cents !== editing.cents)) throw new Error('This expense changed or was deleted. Your draft is kept; cancel it and edit the latest entry.');
          const item = { id: editing?.id ?? draftId, name: name.trim(), cents };
          const acknowledged = !editing && plans.expenses.find(expense => expense.id === draftId);
          if (acknowledged) {
            if (acknowledged.name !== item.name || acknowledged.cents !== item.cents) throw new Error('This draft was already saved with different details. Cancel the draft and edit the saved expense.');
            resetDraft(); render(); focusName(); return;
          }
          const expenses = editing ? plans.expenses.map(expense => expense.id === item.id ? item : expense) : [...plans.expenses, item];
          if (await save({ version: 1, expenses })) { resetDraft(); render(); focusName(); }
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      })();
    };
    return form;
  }
  document.body.append(dialog); dialog.showModal(); void load();
}
