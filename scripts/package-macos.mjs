import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if (process.platform !== 'darwin') {
  console.error('desktop:package creates a macOS disk image. On Windows, run npm run desktop:build; the installer is written to src-tauri/target/release/bundle/nsis.');
  process.exit(1);
}
const build = spawnSync(process.execPath, ['scripts/tauri.mjs', 'build'], { stdio: 'inherit' });
if (build.error || build.status !== 0) process.exit(build.status ?? 1);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const staging = mkdtempSync(join(tmpdir(), 'noter-package-'));
const output = resolve(`src-tauri/target/release/bundle/dmg/Noter_${version}_${process.arch}.dmg`);
function run(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${program} failed (${result.status}).`);
}
try {
  mkdirSync('src-tauri/target/release/bundle/dmg', { recursive: true });
  run('ditto', ['src-tauri/target/release/bundle/macos/Noter.app', join(staging, 'Noter.app')]);
  symlinkSync('/Applications', join(staging, 'Applications'));
  run('hdiutil', ['create', '-volname', 'Noter', '-srcfolder', staging, '-ov', '-format', 'UDZO', output]);
  console.log(`Created ${output}`);
} finally { rmSync(staging, { recursive: true, force: true }); }
