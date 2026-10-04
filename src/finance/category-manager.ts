import { el, button } from '../ui/dom';
import { askDialog } from '../ui/dialog';
import type { Finance } from './model';
import { categoryCatalog, addCategory, renameCategory, mergeCategories, deleteCategory, isTransferCategory } from './categories';

export function manageCategories(getFinance: () => Finance, commit: (next: Finance) => Promise<boolean>) {
  const dialog = el('dialog', 'dialog finance-category-dialog');
  dialog.setAttribute('aria-labelledby', 'category-manager-title');
  const header = el('div', 'dialog-header'), title = el('h2', '', 'Manage categories'); title.id = 'category-manager-title';
  const close = button('Close category manager'); close.textContent = '×'; close.onclick = () => dialog.close(); header.append(title, close);
  const search = el('input', 'field-input'); search.type = 'search'; search.placeholder = 'Find a category or subcategory…'; search.setAttribute('aria-label', 'Find categories');
  const error = el('p', 'finance-error'); error.setAttribute('role', 'alert');
  const list = el('div', 'finance-category-list');
  let saving = false;
  const expanded = new Set<string>();
  function control(text: string, action: () => void, disabled = false) {
    const item = button(text, 'button-secondary'); item.textContent = text; item.disabled = saving || disabled; item.onclick = action; return item;
  }
  async function apply(operation: (finance: Finance) => Finance) {
    if (saving) return false;
    try {
      const next = operation(getFinance()); saving = true; render();
      if (await commit(next)) { error.textContent = 'Saved on this device.'; error.classList.remove('finance-error'); return true; }
      error.textContent = 'Could not save categories. Your previous categories are unchanged.'; error.classList.add('finance-error'); return false;
    } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'Could not update categories.'; error.classList.add('finance-error'); return false; }
    finally { saving = false; render(); }
  }
  async function add(parent?: string) {
    const answer = await askDialog({ title: parent ? `Add subcategory to “${parent}”` : 'Add category', fields: [{ name: 'name', label: parent ? 'Subcategory name' : 'Category name' }], submit: 'Add' });
    if (answer) { if (parent) expanded.add(parent); await apply(finance => addCategory(finance, answer.name, parent)); }
  }
  async function rename(name: string, subcategory?: string) {
    const answer = await askDialog({ title: subcategory ? 'Rename subcategory' : 'Rename category', description: 'Existing transactions and category budgets follow the new name. Amounts and balances stay the same.', fields: [{ name: 'name', label: 'Name', value: subcategory ?? name }], submit: 'Rename' });
    if (answer) { expanded.add(subcategory ? name : answer.name.trim()); await apply(finance => renameCategory(finance, name, answer.name, subcategory)); }
  }
  async function remove(name: string, subcategory?: string) {
    const count = getFinance().transactions.filter(row => row.category === name && (subcategory === undefined || row.subcategory === subcategory)).length;
    const budgets = subcategory === undefined ? (getFinance().budgets ?? []).filter(budget => budget.category === name).length : 0;
    const description = count ? `${count} transactions will keep their amounts, dates, and notes. ${subcategory ? 'Their subcategory will be cleared.' : 'Their category and subcategory will be cleared. Use Merge instead to move them to another category.'}` : 'This unused category will be removed.';
    const answer = await askDialog({ title: `Delete “${subcategory ?? name}”?`, description: description + (budgets ? ` Its ${budgets} monthly budget limits will also be removed.` : ''), submit: 'Delete', danger: true });
    if (answer) await apply(finance => deleteCategory(finance, name, subcategory));
  }
  function merge(name: string) {
    const targets = categoryCatalog(getFinance()).filter(item => item.name !== name && !isTransferCategory(item.name));
    const mergeDialog = el('dialog', 'dialog'); mergeDialog.setAttribute('aria-label', 'Merge category');
    const form = el('form'), select = el('select', 'field-input'); select.setAttribute('aria-label', 'Merge into category');
    for (const target of targets) { const option = el('option', '', target.name); option.value = target.name; select.append(option); }
    form.append(el('h2', '', `Merge “${name}”`), el('p', 'dialog-description', 'Move its transactions and subcategories into the selected category. Budget limits for the same month are added together. Transaction amounts and balances stay the same.'), select);
    const actions = el('div', 'dialog-actions'), submit = el('button', 'button-primary', 'Merge categories'); submit.type = 'submit';
    actions.append(control('Cancel', () => mergeDialog.close()), submit); form.append(actions);
    const mergeError = el('p', 'finance-error'); mergeError.setAttribute('role', 'alert'); form.append(mergeError);
    form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; expanded.add(select.value); if (await apply(finance => mergeCategories(finance, name, select.value))) mergeDialog.close(); else { mergeError.textContent = error.textContent; submit.disabled = false; } };
    mergeDialog.append(form); document.body.append(mergeDialog); mergeDialog.addEventListener('close', () => mergeDialog.remove(), { once: true }); mergeDialog.showModal(); select.focus();
  }
  const addButton = control('Add category', () => void add());
  dialog.append(header, el('p', 'dialog-description', 'Organize your transactions. Expand a category to manage its subcategories.'), search, addButton, error, list);
  function render() {
    list.replaceChildren(); addButton.disabled = saving; close.disabled = saving;
    const finance = getFinance(), catalog = categoryCatalog(finance), needle = search.value.trim().toLocaleLowerCase();
    const visible = catalog.filter(item => [item.name, ...item.subcategories].some(value => value.toLocaleLowerCase().includes(needle)));
    if (!visible.length) list.append(el('p', 'finance-no-results', 'No categories match.'));
    for (const category of visible) {
      const details = el('details', 'finance-category-card'); details.open = expanded.has(category.name) || !!needle;
      details.ontoggle = () => { if (details.open) expanded.add(category.name); else expanded.delete(category.name); };
      const summary = el('summary'), count = finance.transactions.filter(row => row.category === category.name).length;
      summary.append(el('span', '', category.name), el('small', '', `${count} ${count === 1 ? 'transaction' : 'transactions'} · ${category.subcategories.length} ${category.subcategories.length === 1 ? 'subcategory' : 'subcategories'}`)); details.append(summary);
      const protectedCategory = isTransferCategory(category.name);
      const tools = el('div', 'finance-category-tools');
      if (protectedCategory) tools.append(el('p', 'finance-local', 'Reserved for transfers.'));
      else tools.append(control('Add subcategory', () => void add(category.name)), control('Rename category', () => void rename(category.name)), control('Merge category', () => merge(category.name), catalog.filter(item => !isTransferCategory(item.name)).length < 2), control('Delete category', () => void remove(category.name)));
      details.append(tools);
      for (const subcategory of category.subcategories) {
        const row = el('div', 'finance-subcategory-row');
        row.append(el('span', '', subcategory), control('Rename', () => void rename(category.name, subcategory), protectedCategory), control('Delete', () => void remove(category.name, subcategory), protectedCategory)); details.append(row);
      }
      list.append(details);
    }
  }
  search.oninput = render; render(); document.body.append(dialog); dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); }); dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); search.focus();
}
