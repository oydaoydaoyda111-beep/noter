import { el, button } from '../ui/dom';
import { askDialog } from '../ui/dialog';
import { money, type Budget, type Finance } from './model';
import { budgetProgress, removeBudget, saveBudget } from './budgets';
import { categoryCatalog, isTransferCategory } from './categories';

export function createBudgetView(getFinance: () => Finance, commit: (next: Finance) => Promise<boolean>, format: (cents: number) => string) {
  const root = el('section', 'finance-budgets'); root.setAttribute('aria-label', 'Monthly budgets');
  const now = new Date();
  let month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, busy = false;
  function action(label: string, callback: () => void) {
    const control = button(label, 'button-secondary'); control.textContent = label; control.disabled = busy; control.onclick = callback; return control;
  }
  function edit(previous?: Budget) {
    if (busy) return;
    const dialog = el('dialog', 'dialog finance-dialog'), form = el('form'); dialog.setAttribute('aria-label', previous ? 'Edit monthly budget' : 'Add monthly budget');
    const grid = el('div', 'finance-form-grid');
    const date = el('input', 'field-input'); date.type = 'month'; date.name = 'month'; date.required = true; date.value = previous?.month ?? month;
    const category = el('select', 'field-input'); category.name = 'category'; category.required = true;
    for (const item of categoryCatalog(getFinance()).filter(item => !isTransferCategory(item.name))) { const option = el('option', '', item.name); option.value = item.name; category.append(option); }
    if (previous) category.value = previous.category;
    const amount = el('input', 'field-input'); amount.name = 'amount'; amount.inputMode = 'decimal'; amount.required = true; amount.placeholder = '0.00'; amount.value = previous ? (previous.cents / 100).toFixed(2) : '';
    for (const [name, input] of [['Month', date], ['Category', category], ['Monthly limit', amount]] as const) { const label = el('label', 'field-label', name); label.append(input); grid.append(label); }
    const error = el('p', 'finance-error'); error.setAttribute('role', 'alert');
    const cancel = action('Cancel', () => dialog.close()), submit = el('button', 'button-primary', 'Save budget'); submit.type = 'submit';
    const actions = el('div', 'dialog-actions'); actions.append(cancel, submit);
    form.append(el('h2', '', previous ? 'Edit budget' : 'Set monthly budget'), el('p', 'dialog-description', 'Track category expenses across all accounts. Income and internal transfers are excluded.'), grid, error, actions);
    let saving = false;
    form.onsubmit = async event => {
      event.preventDefault(); if (saving) return;
      try {
        const next = saveBudget(getFinance(), { month: date.value, category: category.value, cents: money(amount.value) }, previous);
        saving = true; cancel.disabled = submit.disabled = true;
        if (await commit(next)) { month = date.value; refresh(false); dialog.close(); }
        else error.textContent = 'Could not save. Your budget draft is still here; try again after resolving the save error.';
      } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'Could not save budget.'; }
      finally { saving = false; cancel.disabled = submit.disabled = false; }
    };
    dialog.append(form); dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); root.querySelector<HTMLButtonElement>('[aria-label="Add monthly budget"]')?.focus(); }, { once: true });
    document.body.append(dialog); dialog.showModal(); amount.focus();
  }
  async function remove(budget: Budget) {
    if (busy) return;
    const confirmed = await askDialog({ title: 'Remove this budget?', description: `Remove the ${budget.category} limit for ${budget.month}? Transaction history is kept.`, submit: 'Remove budget', danger: true });
    if (confirmed) await commit(removeBudget(getFinance(), budget));
  }
  function refresh(saving: boolean) {
    busy = saving; root.replaceChildren();
    const heading = el('div', 'finance-budget-heading'), controls = el('div', 'finance-budget-controls');
    const label = el('label', 'finance-date-label', 'Budget month'), input = el('input', 'field-input'); input.type = 'month'; input.value = month; input.disabled = busy;
    input.onchange = () => { if (input.value) { month = input.value; refresh(busy); root.querySelector<HTMLInputElement>('input[type="month"]')?.focus(); } }; label.append(input);
    const add = action('Add monthly budget', () => edit()); add.textContent = 'Set budget';
    controls.append(label, add); heading.append(el('h2', '', 'Budgets'), controls); root.append(heading);
    root.append(el('p', 'finance-local', 'Monthly category expenses across all accounts · income and transfers excluded'));
    try {
      const rows = budgetProgress(getFinance(), month);
      if (!rows.length) root.append(el('p', 'finance-budget-empty', 'No budgets for this month. Set a category limit to track spending.'));
      for (const budget of rows) {
        const row = el('div', 'finance-budget-row'), info = el('div', 'finance-budget-info');
        info.append(el('strong', '', budget.category), el('span', 'finance-local', `${format(budget.spent)} spent of ${format(budget.cents)}`));
        const progress = el('progress', 'finance-budget-progress'); progress.max = budget.cents; progress.value = Math.min(budget.spent, budget.cents); progress.setAttribute('aria-label', `${budget.category} budget usage`);
        const remaining = budget.cents - budget.spent;
        const amount = el('span', remaining < 0 ? 'finance-budget-remaining negative' : 'finance-budget-remaining', `${format(Math.abs(remaining))} ${remaining < 0 ? 'over budget' : 'left'}`);
        const tools = el('div', 'finance-budget-actions'); tools.append(action(`Edit ${budget.category} budget`, () => edit(budget)), action(`Remove ${budget.category} budget`, () => void remove(budget))); tools.firstElementChild!.textContent = 'Edit'; tools.lastElementChild!.textContent = 'Remove';
        row.classList.toggle('is-over-budget', remaining < 0); row.append(info, progress, amount, tools); root.append(row);
      }
      const previous = new Date(`${month}-01T12:00:00Z`); previous.setUTCMonth(previous.getUTCMonth() - 1);
      const previousMonth = previous.toISOString().slice(0, 7), existing = new Set(rows.map(row => row.category));
      const missing = (getFinance().budgets ?? []).filter(budget => budget.month === previousMonth && !existing.has(budget.category));
      if (missing.length) controls.append(action('Copy previous month', () => {
        let next = getFinance(); for (const budget of missing) next = saveBudget(next, { ...budget, month });
        void commit(next);
      }));
    } catch (error) { root.append(el('p', 'finance-error', error instanceof Error ? error.message : 'Could not calculate budgets.')); }
  }
  return { root, refresh };
}
