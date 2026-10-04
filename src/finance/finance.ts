import { readDocument, writeDocument } from '../desktop/platform';
import { el, button } from '../ui/dom';
import { askDialog } from '../ui/dialog';
import { balances, money, saveTransaction, removeTransaction, type Finance, type Transaction } from './model';
import { importWorkbook, exportWorkbook } from './excel';
import { loadFinance, persistFinance } from './storage';
import { categoryCatalog, registerCategory } from './categories';
import { manageAccounts } from './account-manager';
import { manageCategories } from './category-manager';
import { createCategorySelectors } from './category-selectors';
import { createBudgetView } from './budget-view';
import { createReportView } from './report-view';
import { monthRange } from './reports';
import { editTransactions } from './bulk-editor';
import { removeTransactions, transactionSelection } from './bulk';
import type { Settings } from '../types';
import { formatFinanceAmount, formatFinanceDate } from '../settings/model';

const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
export function createFinance(root: HTMLElement, getSettings: () => Settings, openSettings: () => void, setDefaultAccount: (name: string) => void) {
  const format = (cents: number) => formatFinanceAmount(cents, getSettings().financeCurrency);
  let finance: Finance | undefined;
  let busy = false, loaded = false, loadError = false;
  let query = '', accountFilter = '', categoryFilter = '', from = '', until = '';
  let page = 0;
  const selected = new Set<string>();
  const status = el('p', 'finance-status'); status.setAttribute('role', 'status');
  const body = el('div', 'finance-body'); root.append(body, status);
  const budgets = createBudgetView(() => finance!, commit, format);
  const reports = createReportView(() => finance!, format, (month, account) => {
    query = categoryFilter = ''; accountFilter = account; [from, until] = monthRange(month); page = 0; selected.clear(); render();
    root.querySelector('.finance-history')?.scrollIntoView({ block: 'start' }); root.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
  });
  function message(text: string, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
  function action(label: string, callback: () => void, primary = false) {
    const control = button(label, primary ? 'button-primary' : 'button-secondary'); control.textContent = label; control.onclick = callback; control.disabled = busy; return control;
  }
  async function commit(next: Finance): Promise<boolean> {
    if (busy) return false;
    busy = true; render(); message('Saving…');
    try {
      await persistFinance(next);
      if (categoryFilter && !categoryCatalog(next).some(item => item.name === categoryFilter)) {
        const previous = finance?.transactions.find(row => row.category === categoryFilter);
        categoryFilter = next.transactions.find(row => row.id === previous?.id)?.category ?? '';
      }
      if (accountFilter && !next.accounts.some(item => item.name === accountFilter)) {
        const previous = finance?.transactions.find(row => row.account === accountFilter);
        accountFilter = next.transactions.find(row => row.id === previous?.id)?.account ?? '';
      }
      finance = next; message('Saved on this device'); return true;
    }
    catch (error) { message(error instanceof Error ? error.message : String(error), true); return false; }
    finally { busy = false; render(); }
  }
  async function chooseWorkbook() {
    if (busy || loadError) return;
    try {
      const file = await readDocument('xlsx'); if (!file) return;
      if (finance) {
        const confirmed = await askDialog({ title: 'Replace Finance data?', description: 'This replaces all transactions and accounts. Export a backup first if you want to keep your current data.', submit: 'Replace with workbook', danger: true });
        if (!confirmed) return;
      }
      busy = true; render(); message('Reading workbook…');
      const next = await importWorkbook(file.bytes, file.name);
      await persistFinance(next); finance = next; page = 0;
      selected.clear();
      query = accountFilter = categoryFilter = from = until = '';
      message(`Imported ${next.transactions.length.toLocaleString()} transactions and ${next.accounts.length} accounts. Saved on this device.`);
    } catch (error) { message(error instanceof Error ? error.message : String(error), true); }
    finally { busy = false; render(); }
  }
  async function download() {
    if (!finance || busy) return;
    busy = true; render();
    try {
      if (await writeDocument(`bank-backup-${today()}.xlsx`, await exportWorkbook(finance))) message('Excel backup exported.');
    } catch (error) { message(error instanceof Error ? error.message : String(error), true); }
    finally { busy = false; render(); }
  }
  function transactionDialog(kind: 'expense' | 'income' | 'transfer', existing?: Transaction, duplicate = false) {
    if (!finance || busy) return;
    const source = finance;
    if (kind === 'transfer' && !existing && source.accounts.filter(item => !item.archived).length < 2) { message('Add or restore a second account to record a transfer.', true); return; }
    const linked = existing?.transferId ? source.transactions.find(row => row.transferId === existing.transferId && row.cents < 0) : undefined;
    const original = linked ?? existing;
    const destination = original?.transferId ? source.transactions.find(row => row.transferId === original.transferId && row.cents > 0)?.account : '';
    if (original?.transferId) kind = 'transfer';
    const dialog = el('dialog', 'dialog finance-dialog');
    const form = el('form');
    const title = el('h2', '', `${original && !duplicate ? 'Edit' : 'New'} ${kind}`); title.id = 'finance-dialog-title'; dialog.setAttribute('aria-labelledby', title.id);
    const header = el('div', 'dialog-header'); header.append(title, action('Close', () => dialog.close())); form.append(header);
    const grid = el('div', 'finance-form-grid'); form.append(grid);
    function field(name: string, labelText: string, input: HTMLInputElement | HTMLSelectElement, required = true) {
      const label = el('label', 'field-label', labelText); input.name = name; input.className = 'field-input'; input.required = required; label.append(input); grid.append(label); return input;
    }
    function text(name: string, label: string, value: string, type = 'text', required = true) {
      const input = el('input'); input.type = type; input.value = value; input.maxLength = 2000; return field(name, label, input, required) as HTMLInputElement;
    }
    function select(name: string, label: string, values: string[], value: string) {
      const input = el('select'); for (const option of values) { const item = el('option', '', option); item.value = option; input.append(item); } input.value = values.includes(value) ? value : values[0]; return field(name, label, input) as HTMLSelectElement;
    }
    const date = text('date', 'Date', duplicate ? today() : original?.date ?? today(), 'date');
    const amount = text('amount', 'Amount', original ? (Math.abs(original.cents) / 100).toFixed(2) : '', 'text'); amount.inputMode = 'decimal'; amount.placeholder = '0.00';
    const preferences = getSettings();
    const available = source.accounts.filter(item => !item.archived || item.name === original?.account || item.name === destination);
    const preferredAccount = available.some(account => !account.archived && account.name === preferences.financeDefaultAccount) ? preferences.financeDefaultAccount : '';
    const account = select('account', kind === 'transfer' ? 'From account' : 'Account', available.map(account => account.name), original?.account ?? (preferredAccount || (preferences.financeRememberEntries ? source.defaults?.account : '') || ''));
    let to: HTMLSelectElement | undefined;
    if (kind === 'transfer') to = select('destination', 'To account', available.map(account => account.name), destination || available.find(item => item.name !== account.value)?.name || '');
    function suggestions(input: HTMLInputElement, name: string, values: string[]) {
      const list = el('datalist'); list.id = `finance-${name}`; input.setAttribute('list', list.id);
      for (const value of [...new Set(values)].filter(Boolean)) { const option = el('option'); option.value = value; list.append(option); } form.append(list); return list;
    }
    const catalog = categoryCatalog(source);
    const selectors = createCategorySelectors(catalog, { category: kind === 'transfer' ? 'Transfer to other account' : original?.category ?? (preferences.financeRememberEntries ? source.defaults?.category : '') ?? '', subcategory: original?.subcategory ?? '' }, kind === 'transfer');
    grid.append(selectors.root);
    const payee = text('payee', 'Payee / payer', original?.payee ?? '', 'text', false);
    suggestions(payee, 'payees', source.transactions.map(row => row.payee));
    const note = text('note', 'Note', original?.note ?? '', 'text', false);
    const error = el('p', 'finance-error'); error.setAttribute('role', 'alert'); form.append(error);
    if (kind === 'transfer') form.append(el('p', 'dialog-description', 'Both account entries are saved together. Editing or deleting this transfer updates both entries.'));
    const actions = el('div', 'dialog-actions');
    const submit = el('button', 'button-primary', 'Save transaction'); submit.type = 'submit'; actions.append(action('Cancel', () => dialog.close()), submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        const cents = money(amount.value); if (cents <= 0) throw new Error('Enter a positive amount.');
        const selected = selectors.value();
        if (!selected.category && selected.subcategory) throw new Error('Choose a category before adding a subcategory.');
        const row: Transaction = { id: original && !duplicate ? original.id : crypto.randomUUID(), date: date.value, cents: kind === 'income' ? cents : -cents, account: account.value, category: selected.category, subcategory: selected.subcategory, payee: payee.value.trim(), note: note.value.trim() };
        const next = registerCategory(saveTransaction(source, row, to?.value), row.category, row.subcategory);
        next.defaults = preferences.financeRememberEntries ? { account: row.account, category: kind === 'transfer' ? source.defaults?.category ?? '' : row.category } : undefined;
        submit.disabled = true;
        if (await commit(next)) dialog.close();
        else error.textContent = 'Could not save. Keep this dialog open and try again.';
      } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'Could not save transaction.'; }
      finally { submit.disabled = false; }
    };
    dialog.append(form); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); amount.focus();
  }
  async function remove(row: Transaction) {
    const confirmed = await askDialog({ title: row.transferId ? 'Delete this transfer?' : 'Delete this transaction?', description: row.transferId ? 'Both account entries will be deleted and balances recalculated.' : 'The account balance will be recalculated.', submit: 'Delete', danger: true });
    if (confirmed && finance) await commit(removeTransaction(finance, row.id));
  }
  function render() {
    body.replaceChildren();
    const header = el('div', 'finance-header');
    const heading = el('div'); heading.append(el('p', 'finance-eyebrow', 'PERSONAL FINANCE'), el('h1', '', 'Your money, in focus.'), el('p', 'finance-subtitle', 'Quick entries. Clear balances. Excel backups.'));
    const tools = el('div', 'finance-actions'); tools.append(action(finance ? 'Import workbook' : 'Import bank.xlsx', () => void chooseWorkbook()), action('Export Excel backup', () => void download())); tools.lastElementChild?.toggleAttribute('disabled', !finance || busy);
    tools.append(action('Settings', openSettings));
    header.append(heading, tools); body.append(header);
    if (!loaded) { body.append(el('p', '', 'Opening Finance…')); return; }
    if (!finance) {
      const welcome = el('div', 'finance-welcome'); welcome.append(el('span', 'finance-welcome-symbol', '↗'), el('h2', '', 'Bring your workbook into Noter'), el('p', '', 'Import bank.xlsx once. Your actions become transactions, account balances update automatically, and the other sheets stay in your Excel backups.'), action('Choose Excel workbook', () => void chooseWorkbook(), true), el('p', 'finance-local', 'Saved on this device. Export backups regularly.'));
      body.append(welcome); return;
    }
    const summary = el('div', 'finance-summary'), balance = balances(finance);
    const card = (label: string, value: number, note?: string) => { const item = el('div', 'finance-account'); item.append(el('span', 'finance-account-label', label), el('strong', value < 0 ? 'negative' : '', format(value))); if (note) item.append(el('span', 'finance-account-note', note)); return item; };
    summary.append(card('Total balance', [...balance.values()].reduce((sum, cents) => sum + cents, 0)));
    for (const account of finance.accounts) summary.append(card(`${account.name}${account.archived ? ' · Archived' : ''}`, balance.get(account.name) ?? 0, getSettings().financeShowAccountNotes ? account.note : undefined)); body.append(summary);
    const entry = el('div', 'finance-entry'); entry.append(action('− Expense', () => transactionDialog('expense'), true), action('+ Income', () => transactionDialog('income')), action('⇄ Transfer', () => transactionDialog('transfer')), action('Manage accounts', () => manageAccounts(() => finance!, commit, format, () => getSettings().financeDefaultAccount, setDefaultAccount)), action('Manage categories', () => manageCategories(() => finance!, commit))); body.append(entry);
    reports.refresh(busy); body.append(reports.root); budgets.refresh(busy); body.append(budgets.root);
    const filters = el('div', 'finance-filters');
    const history = el('div', 'finance-history');
    function redraw() { page = 0; selected.clear(); renderHistory(history); }
    const search = el('input', 'field-input'); search.type = 'search'; search.placeholder = 'Search transactions…'; search.setAttribute('aria-label', 'Search transactions'); search.value = query; search.oninput = () => { query = search.value; redraw(); }; filters.append(search);
    function filter(label: string, values: string[], value: string, update: (value: string) => void) {
      const select = el('select', 'field-input'); select.setAttribute('aria-label', label);
      const all = el('option', '', `All ${label.toLowerCase()}`); all.value = ''; select.append(all);
      for (const value of values) { const option = el('option', '', value); option.value = value; select.append(option); }
      select.value = value; select.onchange = () => { update(select.value); redraw(); }; filters.append(select);
    }
    filter('Accounts', finance.accounts.map(account => account.name), accountFilter, value => { accountFilter = value; });
    filter('Categories', [...new Set(finance.transactions.map(row => row.category).filter(Boolean))].sort(), categoryFilter, value => { categoryFilter = value; });
    for (const [label, value, update] of [['From date', from, (value: string) => { from = value; }], ['Until date', until, (value: string) => { until = value; }]] as const) {
      const wrapper = el('label', 'finance-date-label', label); const input = el('input', 'field-input'); input.type = 'date'; input.value = value; input.onchange = () => { update(input.value); redraw(); }; wrapper.append(input); filters.append(wrapper);
    }
    filters.append(action('Clear filters', () => { query = accountFilter = categoryFilter = from = until = ''; page = 0; selected.clear(); render(); }));
    body.append(filters, history, el('p', 'finance-local', `Source: ${finance.sourceName} · Saved in your workspace folder · Amounts use two decimal places · Excel backups preserve the other sheets`)); renderHistory(history);
  }
  function renderHistory(root: HTMLElement) {
    if (!finance) return;
    root.replaceChildren();
    const needle = query.trim().toLocaleLowerCase();
    const rows = finance.transactions.filter(row => (!accountFilter || row.account === accountFilter) && (!categoryFilter || row.category === categoryFilter) && (!from || row.date >= from) && (!until || row.date <= until) && (!needle || [row.date, formatFinanceDate(row.date, getSettings().financeDateFormat), row.account, row.category, row.subcategory, row.payee, row.note, format(row.cents)].some(value => value.toLocaleLowerCase().includes(needle)))).sort((a, b) => b.date.localeCompare(a.date));
    const available = new Set(finance.transactions.map(row => row.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
    const pageSize = getSettings().financePageSize;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, totalPages - 1);
    const head = el('div', 'finance-history-heading'); head.append(el('h2', '', 'Transactions'), el('span', '', `${rows.length.toLocaleString()} entries · Net ${format(rows.reduce((sum, row) => sum + row.cents, 0))}`)); root.append(head);
    const selection = el('div', 'finance-bulk-actions'); selection.setAttribute('aria-label', 'Transaction selection');
    const selectLabel = el('label', 'finance-bulk-toggle'), selectAll = el('input'); selectAll.type = 'checkbox'; selectAll.disabled = busy || !rows.length; selectAll.setAttribute('aria-label', 'Select all matching transactions');
    const count = rows.filter(row => selected.has(row.id)).length; selectAll.checked = !!rows.length && count === rows.length; selectAll.indeterminate = count > 0 && count < rows.length;
    selectAll.onchange = () => { if (selectAll.checked) { for (const id of transactionSelection(finance!, new Set(rows.map(row => row.id)))) selected.add(id); } else selected.clear(); renderHistory(root); root.querySelector<HTMLInputElement>('[aria-label="Select all matching transactions"]')?.focus(); };
    selectLabel.append(selectAll, document.createTextNode('Select all matching'));
    selection.append(selectLabel);
    const selectionCount = el('span', 'finance-local', selected.size ? `${selected.size} entries selected` : 'Selection includes all matching pages'); selectionCount.setAttribute('role', 'status'); selection.append(selectionCount);
    if (selected.size) {
      selection.append(action('Edit selected transactions', () => editTransactions(() => finance!, new Set(selected), commit, () => { selected.clear(); render(); })), action('Delete selected transactions', () => void bulkRemove(new Set(selected))), action('Clear selection', () => { selected.clear(); renderHistory(root); root.querySelector<HTMLInputElement>('[aria-label="Select all matching transactions"]')?.focus(); }));
      selection.children[2].textContent = 'Edit selected'; selection.children[3].textContent = 'Delete selected';
    }
    root.append(selection);
    if (!rows.length) { root.append(el('p', 'finance-no-results', 'No transactions match these filters.')); return; }
    const scroll = el('div', 'finance-table-scroll'), table = el('table', 'finance-table'), thead = el('thead'), tr = el('tr');
    for (const title of ['Select', 'Date', 'Description', 'Account', 'Category', 'Amount', 'Actions']) { const th = el('th', '', title); th.scope = 'col'; tr.append(th); } thead.append(tr); table.append(thead);
    const tbody = el('tbody');
    for (const row of rows.slice(page * pageSize, page * pageSize + pageSize)) {
      const tr = el('tr');
      tr.classList.toggle('is-selected', selected.has(row.id));
      const selectionCell = el('td', 'finance-selection-cell'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(row.id); checkbox.disabled = busy; checkbox.dataset.transactionId = row.id; checkbox.setAttribute('aria-label', `Select ${row.payee || row.note || 'transaction'} on ${row.date}`);
      checkbox.onchange = () => { for (const id of transactionSelection(finance!, new Set([row.id]))) { if (checkbox.checked) selected.add(id); else selected.delete(id); } renderHistory(root); root.querySelector<HTMLInputElement>(`[data-transaction-id="${CSS.escape(row.id)}"]`)?.focus(); };
      selectionCell.append(checkbox); tr.append(selectionCell);
      const values = [formatFinanceDate(row.date, getSettings().financeDateFormat), row.payee || row.note || 'Transaction', row.account, [row.category, row.subcategory].filter(Boolean).join(' / '), format(row.cents)];
      values.forEach((value, index) => { const td = el('td', index === 4 ? `finance-amount ${row.cents < 0 ? 'negative' : 'positive'}` : '', value); td.dataset.label = ['Date', 'Description', 'Account', 'Category', 'Amount'][index]; if (index === 1 && row.payee && row.note) td.append(el('small', 'finance-row-note', row.note)); if (index === 1 && row.transferId) td.append(el('small', 'finance-row-note', 'Linked transfer')); tr.append(td); });
      const actions = el('td', 'finance-row-actions');
      const kind = row.transferId ? 'transfer' : row.cents < 0 ? 'expense' : 'income';
      actions.append(action('Edit', () => transactionDialog(kind, row)), action('Repeat', () => transactionDialog(kind, row, true)), action('Delete', () => void remove(row))); tr.append(actions); tbody.append(tr);
    }
    table.append(tbody); scroll.append(table); root.append(scroll);
    const pagination = el('div', 'finance-pagination');
    const previous = action('Previous', () => { page--; renderHistory(root); }), next = action('Next', () => { page++; renderHistory(root); }); previous.disabled = page === 0; next.disabled = page >= totalPages - 1;
    pagination.append(previous, el('span', '', `Page ${page + 1} of ${totalPages}`), next); root.append(pagination);
  }
  async function bulkRemove(ids: Set<string>) {
    if (!finance || busy) return;
    const count = transactionSelection(finance, ids).size;
    const confirmed = await askDialog({ title: `Delete ${count} selected entries?`, description: 'Linked transfers include both account entries, even when one is outside the filter. All selected entries will be deleted and balances recalculated.', submit: 'Delete selected', danger: true });
    try { if (confirmed && finance && await commit(removeTransactions(finance, ids))) { selected.clear(); render(); } }
    catch (error) { message(error instanceof Error ? error.message : 'Could not delete selected transactions.', true); }
  }
  render();
  void loadFinance().then(value => { finance = value; loaded = true; render(); }).catch(error => { loaded = true; loadError = true; render(); message(`${error instanceof Error ? error.message : String(error)} Reload to try again.`, true); });
  return { show() { root.hidden = false; render(); }, hide() { root.hidden = true; }, refresh() { render(); }, async reload() { if (busy) throw new Error('Wait for Finance to finish saving.'); finance = await loadFinance(); selected.clear(); loadError = false; render(); }, isBusy() { return busy; }, accounts() { return finance?.accounts.filter(account => !account.archived).map(account => account.name) ?? []; }, focusSearch() { root.querySelector<HTMLInputElement>('input[type="search"]')?.focus(); } };
}
