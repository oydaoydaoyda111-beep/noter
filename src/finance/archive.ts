import { invoke } from '@tauri-apps/api/core';
export async function unpackWorkbook(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const files = await invoke<Record<string, number[]>>('unpack_workbook', { bytes: Array.from(bytes) });
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, new Uint8Array(data)]));
}
export async function packWorkbook(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await invoke<number[]>('pack_workbook', { files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Array.from(bytes)])) }));
}
