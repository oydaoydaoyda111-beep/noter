import { invoke, isTauri } from '@tauri-apps/api/core';
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
export async function loadFinanceFile() {
  await financeQueue.catch(() => {}); financeQueue = Promise.resolve();
  const loaded = await invoke<{ finance: Record<string, unknown> | null; revision: string }>('load_finance');
  financeRevision = loaded.revision;
  return loaded.finance ? { ...loaded.finance, template: new Uint8Array(loaded.finance.template as number[]) } : undefined;
}
export async function financeChanged() { return financeRevision !== await invoke<string>('finance_revision'); }
export function saveFinanceFile(data: { template: Uint8Array }) {
  const snapshot: Record<string, unknown> = JSON.parse(JSON.stringify({ ...data, template: undefined }));
  const template = Array.from(data.template);
  const operation = financeQueue.catch(() => {}).then(async () => { financeRevision = await invoke<string>('save_finance', { data: snapshot, template, expected: financeRevision }); });
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
