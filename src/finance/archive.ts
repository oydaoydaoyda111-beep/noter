import { desktop } from '../desktop/platform.ts';
import { invoke } from '@tauri-apps/api/core';
export async function unpackWorkbook(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  if (desktop) {
    const files = await invoke<Record<string, number[]>>('unpack_workbook', { bytes: Array.from(bytes) });
    return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, new Uint8Array(data)]));
  }
  const { unzipSync } = await import('fflate'); let total = 0;
  return unzipSync(bytes, { filter: file => { total += file.originalSize; if (total > 40_000_000) throw new Error('Workbook expands beyond the supported 40 MB limit.'); return true; } });
}
export async function packWorkbook(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  if (desktop) return new Uint8Array(await invoke<number[]>('pack_workbook', { files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Array.from(bytes)])) }));
  const { zipSync } = await import('fflate'); return zipSync(files);
}
