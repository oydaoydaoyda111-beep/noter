import { loadFinanceFile, saveFinanceFile } from '../desktop/platform.ts';
import { validateFinanceFile, type Finance } from './model.ts';
export async function loadFinance(): Promise<Finance | undefined> {
  const value = await loadFinanceFile();
  return value ? validateFinanceFile(value) : undefined;
}
export async function persistFinance(finance: Finance): Promise<void> {
  await saveFinanceFile(finance);
}
