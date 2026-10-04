import type { Budget, Finance } from './model.ts';

export interface FinanceCategory { name: string; subcategories: string[] }
export const transferCategory = 'Transfer to other account';
const key = (name: string) => name.trim().toLocaleLowerCase();
export const isTransferCategory = (name: string) => key(name) === key(transferCategory);
function validName(name: string) {
  const result = name.trim();
  if (!result || result.length > 120) throw new Error('Enter a name between 1 and 120 characters.');
  return result;
}
export function categoryCatalog(finance: Finance): FinanceCategory[] {
  const result = new Map<string, Set<string>>();
  const add = (name: string, subcategory = '') => {
    if (!name) return;
    if (!result.has(name)) result.set(name, new Set());
    if (subcategory) result.get(name)!.add(subcategory);
  };
  for (const name of finance.categories) add(name);
  for (const category of finance.categoryDefinitions ?? []) {
    add(category.name); for (const subcategory of category.subcategories) add(category.name, subcategory);
  }
  for (const row of finance.transactions) add(row.category, row.subcategory);
  for (const budget of finance.budgets ?? []) add(budget.category);
  add(transferCategory);
  return [...result].map(([name, subcategories]) => ({ name, subcategories: [...subcategories].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
function withCatalog(finance: Finance, categoryDefinitions: FinanceCategory[]): Finance {
  return { ...finance, categoryDefinitions, categories: categoryDefinitions.map(category => category.name) };
}
export function registerCategory(finance: Finance, name: string, subcategory = ''): Finance {
  if (!name) return finance;
  const catalog = categoryCatalog(finance);
  let category = catalog.find(category => category.name === name);
  if (!category) { category = { name, subcategories: [] }; catalog.push(category); }
  if (subcategory && !category.subcategories.includes(subcategory)) category.subcategories.push(subcategory);
  return withCatalog(finance, catalog);
}
export function addCategory(finance: Finance, rawName: string, parent?: string): Finance {
  const name = validName(rawName), catalog = categoryCatalog(finance);
  if (parent !== undefined) {
    const category = catalog.find(category => category.name === parent);
    if (!category || isTransferCategory(parent)) throw new Error('Choose an editable category.');
    if (category.subcategories.some(item => key(item) === key(name))) throw new Error('That subcategory already exists.');
    category.subcategories.push(name);
  } else {
    if (catalog.some(category => key(category.name) === key(name))) throw new Error('That category already exists.');
    catalog.push({ name, subcategories: [] });
  }
  return withCatalog(finance, catalog);
}
export function renameCategory(finance: Finance, previous: string, rawName: string, subcategory?: string): Finance {
  const name = validName(rawName), catalog = categoryCatalog(finance);
  const category = catalog.find(category => category.name === previous);
  if (!category || isTransferCategory(previous)) throw new Error('This category is reserved for transfers.');
  if (subcategory !== undefined) {
    if (!category.subcategories.includes(subcategory)) throw new Error('Subcategory no longer exists.');
    if (category.subcategories.some(item => item !== subcategory && key(item) === key(name))) throw new Error('That subcategory already exists.');
    category.subcategories = category.subcategories.map(item => item === subcategory ? name : item);
  } else {
    if (catalog.some(item => item.name !== previous && key(item.name) === key(name))) throw new Error('That category already exists. Use Merge to combine them.');
    category.name = name;
  }
  const next = withCatalog(finance, catalog);
  next.transactions = finance.transactions.map(row => row.category !== previous ? row : subcategory === undefined ? { ...row, category: name } : row.subcategory === subcategory ? { ...row, subcategory: name } : row);
  if (subcategory === undefined && finance.defaults?.category === previous) next.defaults = { ...finance.defaults, category: name };
  if (subcategory === undefined && finance.budgets) next.budgets = finance.budgets.map(budget => budget.category === previous ? { ...budget, category: name } : budget);
  return next;
}
export function mergeCategories(finance: Finance, source: string, target: string): Finance {
  const catalog = categoryCatalog(finance), from = catalog.find(item => item.name === source), to = catalog.find(item => item.name === target);
  if (!from || !to || source === target || isTransferCategory(source) || isTransferCategory(target)) throw new Error('Choose two different editable categories.');
  to.subcategories = [...new Set([...to.subcategories, ...from.subcategories])];
  const next = withCatalog(finance, catalog.filter(item => item.name !== source));
  next.transactions = finance.transactions.map(row => row.category === source ? { ...row, category: target } : row);
  if (finance.defaults?.category === source) next.defaults = { ...finance.defaults, category: target };
  if (finance.budgets) {
    const budgets = new Map<string, Budget>();
    for (const budget of finance.budgets) {
      const category = budget.category === source ? target : budget.category, id = `${budget.month}\0${category}`;
      const cents = budget.cents + (budgets.get(id)?.cents ?? 0);
      if (!Number.isSafeInteger(cents)) throw new Error('Combined budget limits exceed the supported amount range.');
      budgets.set(id, { ...budget, category, cents });
    }
    next.budgets = [...budgets.values()];
  }
  return next;
}
export function deleteCategory(finance: Finance, name: string, subcategory?: string): Finance {
  if (isTransferCategory(name)) throw new Error('This category is reserved for transfers.');
  const catalog = categoryCatalog(finance);
  const next = withCatalog(finance, subcategory === undefined ? catalog.filter(item => item.name !== name) : catalog.map(item => item.name === name ? { ...item, subcategories: item.subcategories.filter(value => value !== subcategory) } : item));
  next.transactions = finance.transactions.map(row => row.category !== name ? row : subcategory === undefined ? { ...row, category: '', subcategory: '' } : row.subcategory === subcategory ? { ...row, subcategory: '' } : row);
  if (subcategory === undefined && finance.defaults?.category === name) next.defaults = { ...finance.defaults, category: '' };
  if (subcategory === undefined && finance.budgets) next.budgets = finance.budgets.filter(budget => budget.category !== name);
  return next;
}
