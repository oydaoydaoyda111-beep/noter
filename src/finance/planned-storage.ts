import { invoke } from '@tauri-apps/api/core';
import { validateExpensePlans, type ExpensePlans } from './planned';

export async function loadExpensePlans(): Promise<{ plans: ExpensePlans; revision: string | null }> {
  const loaded = await invoke<{ text: string | null; revision: string | null }>('load_expense_plans');
  return { plans: loaded.text === null ? { version: 1, expenses: [] } : validateExpensePlans(JSON.parse(loaded.text)), revision: loaded.revision };
}

export function saveExpensePlans(plans: ExpensePlans, expected: string | null) {
  validateExpensePlans(plans);
  return invoke<string>('save_expense_plans', { text: JSON.stringify(plans, null, 2) + '\n', expected });
}
