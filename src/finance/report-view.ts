import { el, button } from '../ui/dom';
import type { Finance } from './model';
import { monthlyReports } from './reports';

export function createReportView(getFinance: () => Finance, format: (cents: number) => string, showTransactions: (month: string, account: string) => void) {
  const root = el('details', 'finance-reports'); root.setAttribute('aria-label', 'Monthly reports');
  const now = new Date();
  let month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, account = '', breakdown: 'income' | 'expenses' = 'expenses';
  const monthName = (value: string, short = false) => new Date(`${value}-01T12:00:00Z`).toLocaleDateString(undefined, { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
  function refresh(busy: boolean) {
    root.replaceChildren();
    const summary = el('summary', 'finance-report-summary'); summary.append(el('strong', '', 'Monthly reports')); root.append(summary);
    const finance = getFinance();
    if (account && !finance.accounts.some(item => item.name === account)) account = '';
    const controls = el('div', 'finance-report-controls');
    const date = el('input', 'field-input'); date.type = 'month'; date.value = month; date.min = '0001-01'; date.max = '9999-12'; date.required = true; date.disabled = busy; date.setAttribute('aria-label', 'Report month');
    date.onchange = () => { if (date.value && date.validity.valid) { month = date.value; refresh(busy); root.querySelector<HTMLInputElement>('[aria-label="Report month"]')?.focus(); } else date.value = month; };
    const accounts = el('select', 'field-input'); accounts.setAttribute('aria-label', 'Report account'); accounts.disabled = busy;
    const all = el('option', '', 'All accounts'); all.value = ''; accounts.append(all);
    for (const item of finance.accounts) { const option = el('option', '', `${item.name}${item.archived ? ' · Archived' : ''}`); option.value = item.name; accounts.append(option); }
    accounts.value = account; accounts.onchange = () => { account = accounts.value; refresh(busy); root.querySelector<HTMLSelectElement>('[aria-label="Report account"]')?.focus(); };
    for (const [title, input] of [['Month', date], ['Account', accounts]] as const) { const label = el('label', 'finance-date-label', title); label.append(input); controls.append(label); }
    const ledger = button('View month transactions', 'button-secondary'); ledger.textContent = 'View transactions'; ledger.disabled = busy; ledger.onclick = () => showTransactions(month, account); controls.append(ledger);
    root.append(controls, el('p', 'finance-local', 'Income and expenses exclude transfers and opening balances categorized as Initial. Reports use the selected month and account, independently of transaction filters.'));
    try {
      const periods = monthlyReports(finance, month, account), current = periods[periods.length - 1], previous = periods[periods.length - 2];
      summary.append(el('span', 'finance-local', `${monthName(month)} · ${account || 'All accounts'} · Net ${format(current.net)}`));
      const cards = el('div', 'finance-report-totals');
      for (const [title, key] of [['Income', 'income'], ['Expenses', 'expenses'], ['Net income', 'net']] as const) {
        const card = el('div', 'finance-report-total');
        card.append(el('span', 'finance-account-label', title), el('strong', current[key] < 0 || key === 'expenses' ? 'negative' : 'positive', format(current[key])));
        if (previous) card.append(el('span', 'finance-local', `${monthName(previous.month, true)}: ${format(previous[key])}`));
        cards.append(card);
      }
      root.append(cards);
      const figure = el('figure', 'finance-report-figure'); figure.setAttribute('aria-label', 'Six-month income and expense trend');
      const caption = el('figcaption'), legend = el('span', 'finance-report-legend');
      legend.append(el('span', 'positive', 'Income'), document.createTextNode(' · '), el('span', 'negative', 'Expenses'));
      caption.append(el('strong', '', 'Six-month trend'), legend); figure.append(caption);
      const chart = el('div', 'finance-report-trend'); chart.setAttribute('role', 'list');
      const maximum = Math.max(1, ...periods.flatMap(period => [period.income, period.expenses]));
      for (const period of periods) {
        const item = el('div', 'finance-trend-month'); item.setAttribute('role', 'listitem'); item.setAttribute('aria-label', `${monthName(period.month)}: income ${format(period.income)}, expenses ${format(period.expenses)}`);
        const bars = el('div', 'finance-trend-bars'); bars.setAttribute('aria-hidden', 'true');
        for (const kind of ['income', 'expenses'] as const) { const bar = el('div', `finance-trend-bar is-${kind}`); bar.style.height = `${period[kind] / maximum * 100}%`; bars.append(bar); }
        item.append(bars, el('span', '', monthName(period.month, true)), el('small', 'positive', format(period.income)), el('small', 'negative', format(period.expenses))); chart.append(item);
      }
      figure.append(chart); root.append(figure);
      const heading = el('div', 'finance-report-category-heading'), mode = el('select', 'field-input'); mode.setAttribute('aria-label', 'Report category breakdown');
      for (const [value, title] of [['expenses', 'Expenses'], ['income', 'Income']]) { const option = el('option', '', title); option.value = value; mode.append(option); }
      mode.value = breakdown; mode.onchange = () => { breakdown = mode.value === 'income' ? 'income' : 'expenses'; refresh(busy); root.querySelector<HTMLSelectElement>('[aria-label="Report category breakdown"]')?.focus(); };
      heading.append(el('h3', '', 'By category'), mode, el('span', 'finance-local', `${current.entries} income/expense entries`)); root.append(heading);
      const categories = current.categories.filter(item => item[breakdown] > 0).sort((a, b) => b[breakdown] - a[breakdown] || a.category.localeCompare(b.category));
      if (!categories.length) { root.append(el('p', 'finance-budget-empty', `No ${breakdown} for this month and account.`)); return; }
      const scroll = el('div', 'finance-table-scroll'), table = el('table', 'finance-table finance-report-table'), head = el('thead'), header = el('tr');
      for (const title of ['Category', 'Amount', 'Share']) { const cell = el('th', '', title); cell.scope = 'col'; header.append(cell); } head.append(header); table.append(head);
      const body = el('tbody');
      for (const category of categories) {
        const row = el('tr'), title = el('td', '', category.category || 'Uncategorized'), amount = el('td', 'finance-amount', format(category[breakdown])), share = el('td', 'finance-report-share');
        title.dataset.label = 'Category'; amount.dataset.label = 'Amount'; share.dataset.label = 'Share';
        const percentage = category[breakdown] / current[breakdown] * 100;
        const progress = el('progress'); progress.max = 100; progress.value = percentage; progress.setAttribute('aria-label', `${category.category || 'Uncategorized'} share of ${breakdown}`);
        share.append(progress, el('span', '', `${percentage.toFixed(1)}%`)); row.append(title, amount, share); body.append(row);
      }
      table.append(body); scroll.append(table); root.append(scroll);
    } catch (error) { root.append(el('p', 'finance-error', error instanceof Error ? error.message : 'Could not calculate reports.')); }
  }
  return { root, refresh };
}
