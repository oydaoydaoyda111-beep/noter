import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
// rustup may have been installed without changing the user's shell profile.
const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}${delimiter}${process.env.PATH ?? ''}` };
const args = process.argv.slice(2);
const rust = args[0] === 'test-rust';
if (args[0] === 'build' && process.platform === 'darwin' && !args.includes('--bundles')) args.push('--bundles', 'app');
const child = spawn(rust ? 'cargo' : process.execPath, rust ? ['test', '--manifest-path', 'src-tauri/Cargo.toml'] : ['node_modules/@tauri-apps/cli/tauri.js', ...args], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
