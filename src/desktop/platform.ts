import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Finance } from '../finance/model';
import { batchLine, diffFinance, parseLogs, replayFinance, type FinanceData, type FinanceOp, type LogFile } from '../finance/log.ts';
export const desktop = isTauri();
export let workspacePath = '';
let revision = '', financeRevision = '';
let workspaceBase: unknown;
let workspaceQueue: Promise<unknown> = Promise.resolve(), financeQueue: Promise<unknown> = Promise.resolve();
export async function selectedFolder() { const path = await invoke<string | null>('workspace_folder'); workspacePath = path ?? ''; return path; }
export async function chooseFolder() { const path = await invoke<string | null>('choose_workspace_folder'); if (path) workspacePath = path; return path; }
export function readLastSection() { return invoke<'notes' | 'finance'>('read_last_section'); }
export function saveLastSection(section: 'notes' | 'finance') { return invoke<void>('save_last_section', { section }); }
export interface WorkspaceSnapshot { workspace: unknown; revision: string; path: string }
export async function readWorkspaceSnapshot() { return invoke<WorkspaceSnapshot>('load_workspace'); }
export function adoptWorkspaceSnapshot(loaded: WorkspaceSnapshot) { revision = loaded.revision; workspacePath = loaded.path; workspaceBase = JSON.parse(JSON.stringify(loaded.workspace)); }
export async function loadWorkspaceFile() { const loaded = await readWorkspaceSnapshot(); adoptWorkspaceSnapshot(loaded); return loaded.workspace; }
export async function workspaceChanged(force = false) { return revision !== await invoke<string>('workspace_revision', { force }); }
export interface PreservedEdits { snapshot: string; folder: string | null; notes: number }
export async function preserveWorkspaceEdits(workspace: unknown) {
  await workspaceQueue.catch(() => {});
  if (workspaceBase === undefined) throw new Error('Open your workspace before preserving edits.');
  return invoke<PreservedEdits>('preserve_workspace_edits', { workspace, base: workspaceBase });
}
function sameJSON(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJSON(value, right[index]));
  if (Array.isArray(right)) return false;
  const first = left as Record<string, unknown>, second = right as Record<string, unknown>, keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every(key => Object.hasOwn(second, key) && sameJSON(first[key], second[key]));
}
export function saveWorkspaceFile(workspace: unknown) {
  const snapshot: unknown = JSON.parse(JSON.stringify(workspace));
  const operation = workspaceQueue.catch(() => {}).then(async () => {
    if (sameJSON(snapshot, workspaceBase)) return;
    revision = await invoke<string>('save_workspace', { workspace: snapshot, expected: revision }); workspaceBase = snapshot;
  });
  workspaceQueue = operation; return operation;
}
let financeDevice = '', financeClock = 0, financeSeq = 0, financeNewline = false;
let financeOwnLog: string | null = null, financeTemplate: string | null = null;
let financeNeedsReload = false;
let financeBase: { data: FinanceData; templateSha256: string; template: Uint8Array } | undefined;
async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function appendFinance(ops: FinanceOp[], template: Uint8Array | undefined, retireLegacy = false) {
  const { line, ts } = batchLine(financeDevice, financeClock, financeSeq + 1, ops);
  try {
    const saved = await invoke<{ revision: string; ownLogSha256: string | null; templateSha256: string | null }>('append_finance', {
      line: (financeNewline ? '\n' : '') + line, template: template ? Array.from(template) : null, retireLegacy,
      expectedOwnLog: financeOwnLog, expectedTemplate: financeTemplate,
    });
    financeOwnLog = saved.ownLogSha256; financeTemplate = saved.templateSha256;
    // Other-device batches may arrive during this edit. Only loading/replaying can
    // acknowledge their revision; adopting the append result could hide them forever.
  } catch (error) {
    financeNeedsReload = true;
    throw new Error(`${String(error)} Reload Finance before saving again so completed changes are preserved.`);
  }
  financeClock = ts; financeSeq++; financeNewline = false;
}
export async function loadFinanceFile() {
  await financeQueue.catch(() => {}); financeQueue = Promise.resolve();
  financeNeedsReload = true;
  const loaded = await invoke<{ logs: LogFile[]; legacy: Record<string, unknown> | null; template: number[] | null; revision: string; device: string; ownLogSha256: string | null; templateSha256: string | null }>('load_finance');
  financeRevision = loaded.revision; financeDevice = loaded.device;
  financeOwnLog = loaded.ownLogSha256; financeTemplate = loaded.templateSha256;
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
  if (!state) { financeNeedsReload = false; return undefined; }
  if (state.templateSha256 !== templateSha256) throw new Error('Finance workbook is still syncing or was changed independently. Wait for Syncthing to finish and reload.');
  financeBase = { ...state, template };
  financeNeedsReload = false;
  return { ...state.data, template };
}
export async function financeChanged() { return financeRevision !== await invoke<string>('finance_revision'); }
export function saveFinanceFile(data: Finance) {
  const snapshot: FinanceData = JSON.parse(JSON.stringify({ ...data, template: undefined }));
  const template = data.template;
  const operation = financeQueue.catch(() => {}).then(async () => {
    if (financeNeedsReload) throw new Error('Reload Finance before saving again so completed changes are preserved.');
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
  const file = await invoke<{ name: string; bytes: number[] } | null>('open_document', { extension });
  return file ? { name: file.name, bytes: new Uint8Array(file.bytes) } : null;
}
export async function writeDocument(name: string, bytes: Uint8Array) {
  return invoke<boolean>('save_document', { name, bytes: Array.from(bytes) });
}
export async function copyText(text: string) {
  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); await writeText(text);
}
export async function openExternal(href: string) {
  if (!['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)) return;
  const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(href);
}
