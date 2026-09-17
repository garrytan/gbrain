#!/usr/bin/env bun
/** Download the exact compiler archive pinned in the checked-in manifest. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import toolchain from './toolchain.json';

const args = process.argv.slice(2);
const index = args.indexOf('--dir');
const directory = resolve(index < 0 ? '.context/native-toolchain' : args[index + 1]);
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
const key = `${arch}-${platform}` as keyof typeof toolchain.archives;
const archiveInfo = toolchain.archives[key];
if (!archiveInfo) throw new Error(`No pinned Zig archive for ${key}`);
mkdirSync(directory, { recursive: true });
const archive = join(directory, archiveInfo.tarball.split('/').at(-1)!);
if (!existsSync(archive)) {
  const response = await fetch(archiveInfo.tarball);
  if (!response.ok) throw new Error(`Compiler download failed: HTTP ${response.status}`);
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== archiveInfo.shasum) throw new Error('Pinned compiler checksum mismatch');
execFileSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' });
const extracted = readdirSync(directory, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('zig-'));
if (!extracted) throw new Error('Compiler archive did not contain Zig');
const binary = join(directory, extracted.name, process.platform === 'win32' ? 'zig.exe' : 'zig');
if (execFileSync(binary, ['version'], { encoding: 'utf8' }).trim() !== toolchain.version) throw new Error('Extracted compiler version mismatch');
if (args.includes('--github-path')) {
  if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV) throw new Error('GitHub environment files are missing');
  appendFileSync(process.env.GITHUB_PATH, dirname(binary) + '\n');
  appendFileSync(process.env.GITHUB_ENV, `ZIG=${binary}\n`);
}
console.log(binary);
