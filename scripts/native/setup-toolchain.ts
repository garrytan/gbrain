#!/usr/bin/env bun
/**
 * Download the exact compiler archive pinned in the checked-in manifest.
 *
 * ziglang.org throttles CI downloads (about 180 KB/s measured, so the 82 MB
 * Windows archive outran the 15-minute job limit), and the Zig project asks
 * automated downloads to use its community mirrors instead
 * (https://ziglang.org/download/community-mirrors/). Sources are tried in
 * order, each attempt aborts when bytes stop arriving or it runs too long,
 * and every archive must match the pinned sha256, so a mirror can fail but
 * never substitute bytes. ziglang.org stays the last resort.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import toolchain from './toolchain.json';

const MIRRORS = ['https://pkg.hexops.org/zig', 'https://zig.linus.dev/zig', 'https://zig.squirl.dev', 'https://zigmirror.com', 'https://pkg.earth/zig'];
const STALL_MS = 30_000;
const ATTEMPT_MS = 240_000;

const args = process.argv.slice(2);
const index = args.indexOf('--dir');
const directory = resolve(index < 0 ? '.context/native-toolchain' : args[index + 1]);
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
const key = `${arch}-${platform}` as keyof typeof toolchain.archives;
const archiveInfo = toolchain.archives[key];
if (!archiveInfo) throw new Error(`No pinned Zig archive for ${key}`);
mkdirSync(directory, { recursive: true });
const name = archiveInfo.tarball.split('/').at(-1)!;
const archive = join(directory, name);

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** One source: stream to a temp file, abort on a stall or overrun, keep it only if the checksum matches. */
async function fetchVerified(url: string): Promise<void> {
  const partial = `${archive}.partial`;
  const controller = new AbortController();
  let reason = '';
  const abort = (why: string) => { reason = why; controller.abort(); };
  const overall = setTimeout(() => abort(`exceeded ${ATTEMPT_MS / 1000}s`), ATTEMPT_MS);
  let stall = setTimeout(() => abort(`no bytes for ${STALL_MS / 1000}s`), STALL_MS);
  const started = Date.now();
  let received = 0;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const out = createWriteStream(partial);
    for await (const chunk of response.body) {
      clearTimeout(stall);
      stall = setTimeout(() => abort(`no bytes for ${STALL_MS / 1000}s`), STALL_MS);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise<void>((ok, fail) => out.end((error?: Error | null) => (error ? fail(error) : ok())));
    if (sha256(partial) !== archiveInfo.shasum) throw new Error('checksum mismatch');
    renameSync(partial, archive);
    console.error(`zig archive: ${received} bytes in ${((Date.now() - started) / 1000).toFixed(1)}s from ${url}`);
  } catch (error) {
    rmSync(partial, { force: true });
    throw new Error(reason ? `${reason} after ${received} bytes` : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(overall);
    clearTimeout(stall);
  }
}

if (existsSync(archive) && sha256(archive) !== archiveInfo.shasum) rmSync(archive);
if (existsSync(archive)) {
  console.error(`zig archive: reusing ${archive}`);
} else {
  const failures: string[] = [];
  for (const url of [...MIRRORS.map(m => `${m}/${name}?source=gbrain-ci`), archiveInfo.tarball]) {
    try {
      await fetchVerified(url);
      break;
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
      console.error(`zig archive: ${url} failed (${(error as Error).message}); trying the next source`);
    }
  }
  if (!existsSync(archive)) throw new Error(`Compiler download failed from every source:\n  ${failures.join('\n  ')}`);
}
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
