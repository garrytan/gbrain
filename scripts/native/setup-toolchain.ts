#!/usr/bin/env bun
/**
 * Download the exact compiler archive pinned in the checked-in manifest.
 *
 * ziglang.org throttles CI downloads (about 180 KB/s measured, so the 82 MB
 * Windows archive outran the 15-minute job limit), and the Zig project asks
 * automated downloads to use its community mirrors instead
 * (https://ziglang.org/download/community-mirrors/). Sources are tried in
 * order and every archive must match the pinned sha256, so a mirror can fail
 * but never substitute bytes. ziglang.org stays the last resort.
 *
 * Every phase is bounded, so a CI step fails here with a message naming the
 * phase instead of running into the job timeout (.223's darwin-x64 cell sat
 * in this step for 15 minutes with no output):
 * - The download has one budget across all sources. A source is dropped when
 *   no bytes arrive for STALL_MS, or when its recent rate projects that the
 *   pinned size cannot arrive before the budget ends: a trickle that never
 *   stalls no longer holds a source for minutes.
 * - Extraction and the `zig version` check run under their own timeouts.
 * Each phase prints how long it took.
 *
 * GBRAIN_ZIG_SOURCES (comma-separated base URLs, replacing the mirrors and
 * ziglang.org) and GBRAIN_ZIG_DOWNLOAD_BUDGET_S exist for a local mirror and
 * for tests.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import toolchain from './toolchain.json';

const MIRRORS = ['https://pkg.hexops.org/zig', 'https://zig.linus.dev/zig', 'https://zig.squirl.dev', 'https://zigmirror.com', 'https://pkg.earth/zig'];
const STALL_MS = 30_000;
const DOWNLOAD_BUDGET_MS = Number(process.env.GBRAIN_ZIG_DOWNLOAD_BUDGET_S ?? 300) * 1000;
/** A source's rate is judged over this window, starting once it has run this long. */
const RATE_WINDOW_MS = Math.min(15_000, DOWNLOAD_BUDGET_MS / 10);
const EXTRACT_MS = 90_000;
const VERSION_MS = 60_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Run a command to completion within `ms`, or throw naming `what`; SIGKILL on overrun. */
export function runWithin(command: string, args: string[], ms: number, what: string): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new Error(`${what} did not finish within ${ms / 1000}s`);
    throw error;
  }
}

/**
 * One source: stream to `archive`.partial and keep it only if the checksum
 * matches. Aborts on a stall, on a rate that cannot deliver the remaining
 * bytes before `deadline`, or at `deadline`.
 */
async function fetchVerified(url: string, archive: string, size: number, shasum: string, deadline: number): Promise<void> {
  const partial = `${archive}.partial`;
  const controller = new AbortController();
  let reason = '';
  const abort = (why: string) => { if (!reason) { reason = why; controller.abort(); } };
  const started = Date.now();
  let received = 0;
  const samples: Array<[number, number]> = [[started, 0]];
  const overall = setTimeout(() => abort('the download budget ran out'), Math.max(0, deadline - started));
  let stall = setTimeout(() => abort(`no bytes for ${STALL_MS / 1000}s`), STALL_MS);
  const pace = setInterval(() => {
    const now = Date.now();
    samples.push([now, received]);
    while (samples.length > 1 && now - samples[1]![0] >= RATE_WINDOW_MS) samples.shift();
    const [since, base] = samples[0]!;
    if (now - started < RATE_WINDOW_MS || now - since < RATE_WINDOW_MS / 2) return;
    const rate = (received - base) / ((now - since) / 1000);
    const needed = (size - received) / Math.max(rate, 1);
    if (now + needed * 1000 > deadline) {
      abort(`too slow: ${Math.round(rate / 1024)} KB/s leaves ${Math.round((size - received) / 1048576)} MB for ${seconds(deadline - now)} of the download budget`);
    }
  }, Math.max(250, RATE_WINDOW_MS / 5));
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
    if (sha256(partial) !== shasum) throw new Error('checksum mismatch');
    renameSync(partial, archive);
    console.error(`zig archive: ${received} bytes in ${seconds(Date.now() - started)} from ${url}`);
  } catch (error) {
    rmSync(partial, { force: true });
    throw new Error(reason ? `${reason} after ${received} bytes in ${seconds(Date.now() - started)}` : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(overall);
    clearTimeout(stall);
    clearInterval(pace);
  }
}

if (import.meta.main) {
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

  if (existsSync(archive) && sha256(archive) !== archiveInfo.shasum) rmSync(archive);
  if (existsSync(archive)) {
    console.error(`zig archive: reusing ${archive}`);
  } else {
    const sources = process.env.GBRAIN_ZIG_SOURCES
      ? process.env.GBRAIN_ZIG_SOURCES.split(',').map(base => `${base.replace(/\/$/, '')}/${name}`)
      : [...MIRRORS.map(m => `${m}/${name}?source=gbrain-ci`), archiveInfo.tarball];
    const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
    const failures: string[] = [];
    for (const url of sources) {
      if (Date.now() >= deadline) {
        failures.push(`${url}: not tried`);
        continue;
      }
      try {
        await fetchVerified(url, archive, Number(archiveInfo.size), archiveInfo.shasum, deadline);
        break;
      } catch (error) {
        failures.push(`${url}: ${(error as Error).message}`);
        console.error(`zig archive: ${url} failed (${(error as Error).message}); trying the next source`);
      }
    }
    if (!existsSync(archive)) {
      throw new Error(`Compiler download failed from every source within its ${DOWNLOAD_BUDGET_MS / 1000}s budget:\n  ${failures.join('\n  ')}`);
    }
  }
  let started = Date.now();
  runWithin('tar', ['-xf', archive, '-C', directory], EXTRACT_MS, `Extracting ${archive}`);
  console.error(`zig archive: extracted in ${seconds(Date.now() - started)}`);
  const extracted = readdirSync(directory, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith('zig-'));
  if (!extracted) throw new Error('Compiler archive did not contain Zig');
  const binary = join(directory, extracted.name, process.platform === 'win32' ? 'zig.exe' : 'zig');
  started = Date.now();
  const version = runWithin(binary, ['version'], VERSION_MS, `\`${binary} version\``).trim();
  console.error(`zig: \`zig version\` answered ${version} in ${seconds(Date.now() - started)}`);
  if (version !== toolchain.version) throw new Error('Extracted compiler version mismatch');
  if (args.includes('--github-path')) {
    if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV) throw new Error('GitHub environment files are missing');
    appendFileSync(process.env.GITHUB_PATH, dirname(binary) + '\n');
    appendFileSync(process.env.GITHUB_ENV, `ZIG=${binary}\n`);
  }
  console.log(binary);
}
