import type { Settings } from '../types.ts';

export const defaultSettings: Settings = {
  fontSize: 18, fontStyle: 'sans', documentWidth: 790, density: 'comfortable', motion: 'full', autosaveDelay: 650,
  accentColor: 'blue', startupSection: 'last', spellcheck: true, showNoteStats: true,
  financeCurrency: '', financeDateFormat: 'iso', financeTableDensity: 'compact', financePageSize: 50,
  financeDefaultAccount: '', financeRememberEntries: true, financeShowAccountNotes: true,
};
export function normalizeSettings(input: unknown): Settings {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const result = { ...defaultSettings };
  const pick = <K extends keyof Settings>(key: K, options: readonly Settings[K][]) => {
    if (options.includes(value[key] as Settings[K])) result[key] = value[key] as Settings[K];
  };
  pick('fontStyle', ['sans', 'serif', 'mono']); pick('documentWidth', [720, 790, 850]);
  pick('density', ['comfortable', 'compact']); pick('motion', ['full', 'subtle', 'none']);
  pick('accentColor', ['blue', 'green', 'purple']); pick('startupSection', ['last', 'notes', 'finance']);
  pick('financeCurrency', ['', 'AZN', 'USD', 'EUR', 'GBP', 'TRY']); pick('financeDateFormat', ['iso', 'dmy', 'mdy']);
  pick('financeTableDensity', ['compact', 'comfortable']); pick('financePageSize', [25, 50, 100, 200]);
  for (const key of ['spellcheck', 'showNoteStats', 'financeRememberEntries', 'financeShowAccountNotes'] as const) if (typeof value[key] === 'boolean') result[key] = value[key];
  const size = Number(value.fontSize), delay = Number(value.autosaveDelay);
  if (Number.isFinite(size) && size > 0) result.fontSize = Math.max(14, Math.min(24, size));
  if (Number.isFinite(delay) && delay > 0) result.autosaveDelay = Math.max(200, Math.min(2000, delay));
  if (typeof value.financeDefaultAccount === 'string' && value.financeDefaultAccount.length <= 120) result.financeDefaultAccount = value.financeDefaultAccount;
  return result;
}
export function formatFinanceAmount(cents: number, currency: Settings['financeCurrency']): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...(currency ? { style: 'currency', currency, currencyDisplay: 'code' } : {}) });
}
export function formatFinanceDate(iso: string, format: Settings['financeDateFormat']): string {
  const [year, month, day] = iso.split('-');
  return format === 'dmy' ? `${day}/${month}/${year}` : format === 'mdy' ? `${month}/${day}/${year}` : iso;
}
