import { unpackWorkbook, packWorkbook } from './archive.ts';
const strFromU8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const strToU8 = (text: string) => new TextEncoder().encode(text);
import { balances, type Budget, type Finance, type Transaction } from './model.ts';
import { validateBudgets } from './budgets.ts';
import { categoryCatalog } from './categories.ts';

const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const headers = ['Date', 'Amount', 'Account', 'Category', 'Subcategory', 'Payee/Payer', 'Note'];
const children = (node: Document | Element, tag: string): Element[] => Array.from(node.getElementsByTagName(tag));
function parse(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw new Error('Workbook is missing a required part.');
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Workbook contains invalid XML.');
  return doc;
}
function paths(files: Record<string, Uint8Array>) {
  const workbook = parse(files['xl/workbook.xml']);
  if (children(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1') throw new Error('This importer requires the standard Excel date system.');
  const rels = parse(files['xl/_rels/workbook.xml.rels']);
  const sheets = new Map(children(workbook, 'sheet').map(sheet => {
    const target = children(rels, 'Relationship').find(rel => rel.getAttribute('Id') === sheet.getAttribute('r:id'))?.getAttribute('Target');
    return [sheet.getAttribute('name')!, target?.startsWith('/') ? target.slice(1) : `xl/${target}`];
  }));
  const tables = Object.keys(files).filter(path => /^xl\/tables\/[^/]+\.xml$/.test(path));
  const findTable = (name: string) => tables.find(path => parse(files[path]).documentElement.getAttribute('name') === name);
  const actions = sheets.get('actions'), current = sheets.get('current');
  const ledgerTable = findTable('Table2'), balanceTable = findTable('Table1');
  if (!actions || !current || !ledgerTable || !balanceTable) throw new Error('Choose a bank workbook with actions/current sheets and the original ledger tables.');
  return { actions, current, ledgerTable, balanceTable };
}
function reader(files: Record<string, Uint8Array>) {
  const shared = files['xl/sharedStrings.xml'] ? children(parse(files['xl/sharedStrings.xml']), 'si').map(item => children(item, 't').map(t => t.textContent ?? '').join('')) : [];
  return (cell: Element | undefined): string => {
    if (!cell) return '';
    const raw = children(cell, 'v')[0]?.textContent ?? '';
    if (cell.getAttribute('t') === 's') return shared[Number(raw)] ?? '';
    if (cell.getAttribute('t') === 'inlineStr') return children(cell, 't').map(t => t.textContent ?? '').join('');
    return raw;
  };
}
export async function importWorkbook(bytes: Uint8Array, sourceName: string): Promise<Finance> {
  const files = await unpackWorkbook(bytes);
  const path = paths(files), read = reader(files);
  const ledger = parse(files[path.actions]);
  const rows = children(ledger, 'row');
  const ledgerEnd = Number(parse(files[path.ledgerTable]).documentElement.getAttribute('ref')?.split(':')[1].replace(/\D/g, ''));
  const header = rows.find(row => row.getAttribute('r') === '2');
  if (!header || headers.some((name, index) => read(children(header, 'c').find(cell => cell.getAttribute('r') === `${String.fromCharCode(66 + index)}2`)) !== name)) throw new Error('The actions sheet does not have the expected seven columns.');
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const index = Number(row.getAttribute('r')); if (index <= 2 || index >= ledgerEnd) continue;
    const cells = children(row, 'c');
    const values = headers.map((_, col) => read(cells.find(cell => cell.getAttribute('r') === `${String.fromCharCode(66 + col)}${index}`)));
    if (cells.some(cell => children(cell, 'f').length)) throw new Error(`Transaction row ${index} contains a formula. Convert it to a value before importing.`);
    if (values.every(value => !value)) continue;
    const date = Number(values[0]), amount = Number(values[1]);
    if (!values[0] || !values[1] || !Number.isFinite(date) || !Number.isFinite(amount) || !values[2]) throw new Error(`Transaction row ${index} is incomplete. Import was cancelled.`);
    const cents = Math.round(amount * 100);
    if (!Number.isSafeInteger(cents)) throw new Error(`Transaction row ${index} has an invalid amount.`);
    transactions.push({ id: crypto.randomUUID(), date: new Date(Date.UTC(1899, 11, 30) + Math.round(date) * 86400000).toISOString().slice(0, 10), cents, account: values[2], category: values[3], subcategory: values[4], payee: values[5], note: values[6] });
  }
  const accounts: Finance['accounts'] = [];
  const balanceEnd = Number(parse(files[path.balanceTable]).documentElement.getAttribute('ref')?.split(':')[1].replace(/\D/g, ''));
  for (const row of children(parse(files[path.current]), 'row')) {
    const index = Number(row.getAttribute('r')); if (index <= 2 || index >= balanceEnd) continue;
    const cells = children(row, 'c');
    const value = (col: string) => read(cells.find(cell => cell.getAttribute('r') === `${col}${index}`));
    const amount = cells.find(cell => cell.getAttribute('r') === `C${index}`);
    if (children(amount ?? row, 'f').some(f => f.textContent?.includes('SUBTOTAL'))) continue;
    if (value('B')) accounts.push({ name: value('B'), note: value('D') });
  }
  for (const row of transactions) if (!accounts.some(account => account.name === row.account)) accounts.push({ name: row.account, note: '' });
  if (!accounts.length) throw new Error('Workbook has no accounts.');
  const categoryDefinitions: { name: string; subcategories: string[] }[] = [];
  const budgets: Budget[] = [];
  if (files['xl/worksheets/noter-finance.xml']) {
    const metadata = children(parse(files['xl/worksheets/noter-finance.xml']), 'row').slice(1);
    const used = new Set<string>();
    metadata.forEach((row, index) => {
      const values = children(row, 'c').map(read), transaction = transactions[index];
      if (values[0] === 'Budget') {
        if (!/^\d+$/.test(values[3] ?? '')) throw new Error('The workbook contains an invalid budget amount.');
        budgets.push({ month: values[1], category: values[2], cents: Number(values[3]) });
        return;
      }
      if (values[0] === 'Account' && values[1]) {
        const account = accounts.find(item => item.name === values[1]);
        if (account) account.archived = values[2] === 'archived';
        return;
      }
      if (values[0] === 'Category' && values[1]) {
        let category = categoryDefinitions.find(item => item.name === values[1]);
        if (!category) { category = { name: values[1], subcategories: [] }; categoryDefinitions.push(category); }
        if (values[2] && !category.subcategories.includes(values[2])) category.subcategories.push(values[2]);
        return;
      }
      if (!transaction || values[0] !== String(index + 3) || !values[1] || used.has(values[1])) return;
      used.add(values[1]); transaction.id = values[1]; if (values[2]) transaction.transferId = values[2];
    });
    for (const row of transactions) if (row.transferId) {
      const pair = transactions.filter(item => item.transferId === row.transferId);
      if (pair.length !== 2 || pair[0].cents !== -pair[1].cents || pair[0].account === pair[1].account || pair[0].date !== pair[1].date) row.transferId = undefined;
    }
  }
  const finance: Finance = { version: 1, accounts, transactions, categories: [...new Set([...transactions.map(row => row.category), ...categoryDefinitions.map(item => item.name)].filter(Boolean))], sourceName, template: bytes };
  if (categoryDefinitions.length) finance.categoryDefinitions = categoryDefinitions;
  if (budgets.length) { validateBudgets(budgets); finance.budgets = budgets; }
  return finance;
}

export async function exportWorkbook(finance: Finance): Promise<Uint8Array> {
  const files = await unpackWorkbook(finance.template), path = paths(files);
  const write = (path: string, doc: Document) => { files[path] = strToU8(new XMLSerializer().serializeToString(doc)); };
  function updateSheet(sheetPath: string, tablePath: string, data: (string | number)[][], totals: Record<string, { formula: string; value: number }>) {
    const doc = parse(files[sheetPath]), sheetData = children(doc, 'sheetData')[0];
    const table = parse(files[tablePath]);
    const oldEnd = Number(table.documentElement.getAttribute('ref')!.split(':')[1].replace(/\D/g, ''));
    const width = data[0]?.length ?? (sheetPath === path.actions ? 7 : 3);
    const oldRows = children(sheetData, 'row');
    const templateRow = oldRows.find(row => row.getAttribute('r') === '3');
    const styles = new Map(children(templateRow ?? sheetData, 'c').map(cell => [cell.getAttribute('r')?.replace(/\d/g, ''), cell.getAttribute('s')]));
    const oldTotal = oldRows.find(row => Number(row.getAttribute('r')) === oldEnd)?.cloneNode(true) as Element | undefined;
    for (const row of oldRows) if (Number(row.getAttribute('r')) > 2 && Number(row.getAttribute('r')) <= oldEnd) {
      for (const c of children(row, 'c')) {
        const column = c.getAttribute('r')!.replace(/\d/g, '');
        if (column.length === 1 && column >= 'B' && column <= String.fromCharCode(65 + width)) row.removeChild(c);
      }
      if (!children(row, 'c').length) sheetData.removeChild(row);
    }
    function cell(row: Element, ref: string, value: string | number, formula?: string) {
      const c = doc.createElementNS(ns, 'c'); c.setAttribute('r', ref);
      const style = styles.get(ref.replace(/\d/g, '')); if (style) c.setAttribute('s', style);
      if (formula) { const f = doc.createElementNS(ns, 'f'); f.textContent = formula; c.appendChild(f); }
      if (typeof value === 'number') { const v = doc.createElementNS(ns, 'v'); v.textContent = String(value); c.appendChild(v); }
      else if (value) { c.setAttribute('t', 'inlineStr'); const is = doc.createElementNS(ns, 'is'), t = doc.createElementNS(ns, 't'); t.setAttribute('xml:space', 'preserve'); t.textContent = value; is.appendChild(t); c.appendChild(is); }
      row.appendChild(c);
    }
    data.forEach((values, index) => {
      const row = doc.createElementNS(ns, 'row'); row.setAttribute('r', String(index + 3));
      values.forEach((value, col) => cell(row, `${String.fromCharCode(66 + col)}${index + 3}`, value,
        sheetPath === path.current && col === 1 ? 'SUMIF(Table2[Account],Table1[[#This Row],[Name]],Table2[Amount])' : undefined));
      sheetData.appendChild(row);
    });
    const end = data.length + 3;
    const row = oldTotal ?? doc.createElementNS(ns, 'row'); row.setAttribute('r', String(end));
    for (const c of children(row, 'c')) c.setAttribute('r', `${c.getAttribute('r')!.replace(/\d/g, '')}${end}`);
    for (const [column, total] of Object.entries(totals)) {
      const existing = children(row, 'c').find(c => c.getAttribute('r') === `${column}${end}`); const style = existing?.getAttribute('s'); if (existing) row.removeChild(existing);
      cell(row, `${column}${end}`, total.value, total.formula);
      if (style) (row.lastChild as Element).setAttribute('s', style);
    }
    for (const c of children(row, 'c').sort((a, b) => a.getAttribute('r')!.localeCompare(b.getAttribute('r')!))) row.appendChild(c);
    sheetData.appendChild(row);
    const sorted = children(sheetData, 'row').sort((a, b) => Number(a.getAttribute('r')) - Number(b.getAttribute('r')));
    const merged = new Map<string, Element>();
    for (const row of sorted) {
      const index = row.getAttribute('r')!, existing = merged.get(index);
      if (existing) { for (const c of children(row, 'c')) existing.appendChild(c); sheetData.removeChild(row); }
      else { merged.set(index, row); sheetData.appendChild(row); }
    }
    for (const row of merged.values()) for (const c of children(row, 'c').sort((a, b) => a.getAttribute('r')!.replace(/\d/g, '').localeCompare(b.getAttribute('r')!.replace(/\d/g, '')))) row.appendChild(c);
    table.documentElement.setAttribute('ref', `B2:${String.fromCharCode(65 + width)}${end}`);
    children(table, 'autoFilter')[0]?.setAttribute('ref', `B2:${String.fromCharCode(65 + width)}${end - 1}`);
    const dimension = children(doc, 'dimension')[0];
    const previousEnd = dimension?.getAttribute('ref')?.split(':')[1] ?? '';
    const lastCol = previousEnd.replace(/\d/g, '');
    dimension?.setAttribute('ref', `A2:${lastCol.length > 1 || lastCol > String.fromCharCode(65 + width) ? lastCol : String.fromCharCode(65 + width)}${Math.max(end, Number(previousEnd.replace(/\D/g, '')) || 0)}`);
    write(sheetPath, doc); write(tablePath, table);
  }
  const rows = finance.transactions.map(row => [Math.round((Date.parse(`${row.date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000), row.cents / 100, row.account, row.category, row.subcategory, row.payee, row.note]);
  updateSheet(path.actions, path.ledgerTable, rows, { C: { formula: 'SUBTOTAL(109,Table2[Amount])', value: finance.transactions.reduce((sum, row) => sum + row.cents, 0) / 100 }, H: { formula: 'SUBTOTAL(103,Table2[Note])', value: finance.transactions.filter(row => row.note).length } });
  const totals = balances(finance);
  updateSheet(path.current, path.balanceTable, finance.accounts.map(account => [account.name, (totals.get(account.name) ?? 0) / 100, account.note]), { C: { formula: 'SUBTOTAL(109,Table1[Value])', value: [...totals.values()].reduce((sum, value) => sum + value, 0) / 100 } });
  const workbook = parse(files['xl/workbook.xml']);
  // Hidden metadata keeps stable IDs and linked transfers when restoring a backup.
  const metadata = parse(strToU8(`<worksheet xmlns="${ns}"><sheetData/></worksheet>`));
  const metadataRows = [['Ledger row', 'Transaction ID', 'Transfer ID'], ...finance.transactions.map((row, index) => [String(index + 3), row.id, row.transferId ?? ''])];
  for (const category of categoryCatalog(finance)) {
    metadataRows.push(['Category', category.name, '']);
    for (const subcategory of category.subcategories) metadataRows.push(['Category', category.name, subcategory]);
  }
  for (const account of finance.accounts) if (account.archived !== undefined) metadataRows.push(['Account', account.name, account.archived ? 'archived' : 'active']);
  if (finance.budgets) {
    validateBudgets(finance.budgets);
    for (const budget of finance.budgets) metadataRows.push(['Budget', budget.month, budget.category, String(budget.cents)]);
  }
  const metadataData = children(metadata, 'sheetData')[0];
  metadataRows.forEach((values, index) => {
    const row = metadata.createElementNS(ns, 'row'); row.setAttribute('r', String(index + 1));
    values.forEach((value, col) => {
      const c = metadata.createElementNS(ns, 'c'); c.setAttribute('r', `${String.fromCharCode(65 + col)}${index + 1}`); c.setAttribute('t', 'inlineStr');
      const is = metadata.createElementNS(ns, 'is'), t = metadata.createElementNS(ns, 't'); t.textContent = value; is.appendChild(t); c.appendChild(is); row.appendChild(c);
    }); metadataData.appendChild(row);
  }); write('xl/worksheets/noter-finance.xml', metadata);
  const relationships = parse(files['xl/_rels/workbook.xml.rels']);
  const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
  let relationship = children(relationships, 'Relationship').find(rel => rel.getAttribute('Target') === 'worksheets/noter-finance.xml');
  if (!relationship) {
    relationship = relationships.createElementNS(relNs, 'Relationship');
    relationship.setAttribute('Id', `rIdNoterFinance${crypto.randomUUID().replaceAll('-', '')}`);
    relationship.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');
    relationship.setAttribute('Target', 'worksheets/noter-finance.xml'); relationships.documentElement.appendChild(relationship);
    const sheet = workbook.createElementNS(ns, 'sheet'); sheet.setAttribute('name', '_noter_finance'); sheet.setAttribute('state', 'hidden');
    sheet.setAttribute('sheetId', String(Math.max(...children(workbook, 'sheet').map(sheet => Number(sheet.getAttribute('sheetId')))) + 1));
    sheet.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r:id', relationship.getAttribute('Id')!); children(workbook, 'sheets')[0].appendChild(sheet);
  }
  write('xl/_rels/workbook.xml.rels', relationships);
  const contentTypes = parse(files['[Content_Types].xml']);
  if (!children(contentTypes, 'Override').some(part => part.getAttribute('PartName') === '/xl/worksheets/noter-finance.xml')) {
    const part = contentTypes.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override'); part.setAttribute('PartName', '/xl/worksheets/noter-finance.xml'); part.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'); contentTypes.documentElement.appendChild(part);
  } write('[Content_Types].xml', contentTypes);
  let calc = children(workbook, 'calcPr')[0]; if (!calc) { calc = workbook.createElementNS(ns, 'calcPr'); workbook.documentElement.appendChild(calc); }
  calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1'); write('xl/workbook.xml', workbook);
  // A stale calculation chain references the old row positions. Excel rebuilds it.
  delete files['xl/calcChain.xml'];
  for (const file of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    const doc = parse(files[file]);
    for (const node of children(doc, file.endsWith('.rels') ? 'Relationship' : 'Override')) {
      if ((node.getAttribute('Target') ?? node.getAttribute('PartName') ?? '').endsWith('calcChain.xml')) node.parentNode?.removeChild(node);
    }
    write(file, doc);
  }
  return packWorkbook(files);
}
