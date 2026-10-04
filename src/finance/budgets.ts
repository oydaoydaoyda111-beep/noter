import type { Budget, Finance } from './model.ts';
import { isTransferCategory } from './categories.ts';

const key = (budget: Budget) => `${budget.month}\0${budget.category}`;

export function validateBudgets(value: unknown): asserts value is Budget[] {
  const seen = new Set<string>();
  if (!Array.isArray(value)) throw new Error('Finance budgets contain invalid data.');
  for (const budget of value as Budget[]) {
    if (!budget || typeof budget.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(budget.month) || typeof budget.category !== 'string' || !budget.category.trim() || budget.category.length > 120 || isTransferCategory(budget.category) || !Number.isSafeInteger(budget.cents) || budget.cents <= 0 || seen.has(key(budget))) {
      throw new Error('Choose a valid month, category and positive budget amount. Each category can have one budget per month.');
    }
    seen.add(key(budget));
  }
}

export function saveBudget(finance: Finance, budget: Budget, previous?: Budget): Finance {
  validateBudgets([budget]);
  if (previous && key(previous) !== key(budget) && finance.budgets?.some(item => key(item) === key(budget))) throw new Error('That category already has a budget for this month. Edit its existing budget.');
  const remaining = (finance.budgets ?? []).filter(item => key(item) !== key(budget) && (!previous || key(item) !== key(previous)));
  return { ...finance, budgets: [...remaining, { ...budget }] };
}

export function removeBudget(finance: Finance, budget: Budget): Finance {
  return { ...finance, budgets: (finance.budgets ?? []).filter(item => key(item) !== key(budget)) };
}

/** Budgets count expenses in the calendar month; income and internal transfers do not consume them. */
export function budgetProgress(finance: Finance, month: string): (Budget & { spent: number })[] {
  const spending = new Map<string, number>();
  for (const row of finance.transactions) {
    if (!row.date.startsWith(`${month}-`) || row.cents >= 0 || row.transferId || isTransferCategory(row.category)) continue;
    const cents = (spending.get(row.category) ?? 0) - row.cents;
    if (!Number.isSafeInteger(cents)) throw new Error('Monthly expense totals exceed the supported amount range.');
    spending.set(row.category, cents);
  }
  return (finance.budgets ?? []).filter(budget => budget.month === month).map(budget => ({ ...budget, spent: spending.get(budget.category) ?? 0 })).sort((a, b) => a.category.localeCompare(b.category));
}
