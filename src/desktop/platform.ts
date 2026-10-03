import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Finance } from '../finance/model';
import { batchLine, diffFinance, parseLogs, replayFinance, type FinanceData, type FinanceOp, type LogFile } from '../finance/log';
export const desktop = isTauri();
export let workspacePath = '';
let revision = '', financeRevision = '';
let workspaceQueue: Promise<unknown> = Promise.resolve(), financeQueue: Promise<unknown> = Promise.resolve();
export async function selectedFolder() { const path = await invoke<string | null>('workspace_folder'); workspacePath = path ?? ''; return path; }
export async function chooseFolder() { const path = await invoke<string | null>('choose_workspace_folder'); if (path) workspacePath = path; return path; }
export interface WorkspaceSnapshot { workspace: unknown; revision: string; path: string }
export async function readWorkspaceSnapshot() { return invoke<WorkspaceSnapshot>('load_workspace'); }
export function adoptWorkspaceSnapshot(loaded: WorkspaceSnapshot) { revision = loaded.revision; workspacePath = loaded.path; }
export async function loadWorkspaceFile() { const loaded = await readWorkspaceSnapshot(); adoptWorkspaceSnapshot(loaded); return loaded.workspace; }
export async function workspaceChanged() { return revision !== await invoke<string>('workspace_revision'); }
export function saveWorkspaceFile(workspace: unknown) {
  const snapshot: unknown = JSON.parse(JSON.stringify(workspace));
  const operation = workspaceQueue.catch(() => {}).then(async () => { revision = await invoke<string>('save_workspace', { workspace: snapshot, expected: revision }); });
  workspaceQueue = operation; return operation;
}
let financeDevice = '', financeClock = 0, financeSeq = 0, financeNewline = false;
let financeBase: { data: FinanceData; templateSha256: string; template: Uint8Array } | undefined;
async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function appendFinance(ops: FinanceOp[], template: Uint8Array | undefined, retireLegacy = false) {
  const { line, ts } = batchLine(financeDevice, financeClock, financeSeq + 1, ops);
  financeRevision = await invoke<string>('append_finance', { line: (financeNewline ? '\n' : '') + line, template: template ? Array.from(template) : null, retireLegacy });
  financeClock = ts; financeSeq++; financeNewline = false;
}
export async function loadFinanceFile() {
  await financeQueue.catch(() => {}); financeQueue = Promise.resolve();
  const loaded = await invoke<{ logs: LogFile[]; legacy: Record<string, unknown> | null; template: number[] | null; revision: string; device: string }>('load_finance');
  financeRevision = loaded.revision; financeDevice = loaded.device;
  const parsed = parseLogs(loaded.logs, loaded.device);
  financeClock = parsed.clock; financeSeq = parsed.seq; financeNewline = parsed.ownNeedsNewline;
  const template = new Uint8Array(loaded.template ?? []);
  const templateSha256 = loaded.template ? await sha256(template) : '';
  let state = replayFinance(parsed.batches);
  if (!state && loaded.legacy) {
    // One-time migration from the former single .noter/finance.json file.
    const { templateSha256: expected, ...legacy } = loaded.legacy;
    if (typeof expected === 'string' && expected !== templateSha256) throw new Error('Finance workbook is still syncing or was changed independently. Wait for Syncthing to finish and reload.');
    state = { data: legacy as unknown as FinanceData, templateSha256 };
    await appendFinance(diffFinance(undefined, state.data, templateSha256), undefined, true);
  }
  financeBase = undefined;
  if (!state) return undefined;
  if (state.templateSha256 !== templateSha256) throw new Error('Finance workbook is still syncing or was changed independently. Wait for Syncthing to finish and reload.');
  financeBase = { ...state, template };
  return { ...state.data, template };
}
export async function financeChanged() { return financeRevision !== await invoke<string>('finance_revision'); }
export function saveFinanceFile(data: Finance) {
  const snapshot: FinanceData = JSON.parse(JSON.stringify({ ...data, template: undefined }));
  const template = data.template;
  const operation = financeQueue.catch(() => {}).then(async () => {
    const base = financeBase;
    const templateSha256 = base && base.template === template ? base.templateSha256 : await sha256(template);
    const ops = diffFinance(base, snapshot, templateSha256);
    if (ops.length) await appendFinance(ops, templateSha256 === base?.templateSha256 ? undefined : template);
    financeBase = { data: snapshot, templateSha256, template };
  });
  financeQueue = operation; return operation;
}
export async function flushFiles() { await Promise.all([workspaceQueue, financeQueue]); }
export async function readDocument(extension: 'xlsx' | 'json'): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (desktop) {
    const file = await invoke<{ name: string; bytes: number[] } | null>('open_document', { extension });
    return file ? { name: file.name, bytes: new Uint8Array(file.bytes) } : null;
  }
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = `.${extension}`;
    input.oncancel = () => resolve(null);
    input.onchange = async () => { const file = input.files?.[0]; if (!file) { resolve(null); return; } if (file.size > (extension === 'json' ? 100_000_000 : 10_000_000)) { resolve(null); return; } resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }; input.click();
  });
}
export async function writeDocument(name: string, bytes: Uint8Array, type: string) {
  if (desktop) return invoke<boolean>('save_document', { name, bytes: Array.from(bytes) });
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); return true;
}
export async function copyText(text: string) {
  if (desktop) { const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); await writeText(text); }
  else await navigator.clipboard.writeText(text);
}
export async function openExternal(href: string) {
  if (!['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)) return;
  if (desktop) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(href); }
  else window.open(href, '_blank', 'noopener,noreferrer');
}
