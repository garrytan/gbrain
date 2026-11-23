#!/usr/bin/env bun
/**
 * Build the Rust engine addon and copy it to a predictable place.
 *
 *   bun run rust:build                  # the release addon
 *   bun run rust:build --crash-points   # the crash cell's addon (scripts/rust-crash/README.md)
 *
 * Output: rust/target/addon/gbrain_engine.<target>.node (with --crash-points:
 * rust/target/addon-crash-points/gbrain_engine.<target>.node, built with the `crash-points` feature, which the release
 * addon never has), plus the line to export so the loader (and rust/smoke/run.ts) can find it:
 *
 *   GBRAIN_RUST_ENGINE_ADDON=/abs/path/to/gbrain_engine.<target>.node
 *
 * Rust is optional for gbrain. This script is the only place that needs it, and when cargo is
 * missing it stops with install instructions before touching anything.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rustDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crashPoints = process.argv.slice(2).includes('--crash-points');
const unknown = process.argv.slice(2).filter(a => a !== '--crash-points');

function fail(message: string): never {
  console.error(`rust:build: ${message}`);
  process.exit(1);
}
if (unknown.length > 0) fail(`unknown argument ${unknown.join(' ')}; the only option is --crash-points`);

/** Rust host triple -> the target names the engine reports (see `target()` in the crate). */
const TARGETS: Record<string, { name: string; library: string }> = {
  'x86_64-unknown-linux-gnu': { name: 'linux-x64-glibc', library: 'libgbrain_napi.so' },
  'x86_64-unknown-linux-musl': { name: 'linux-x64-musl', library: 'libgbrain_napi.so' },
  'aarch64-unknown-linux-gnu': { name: 'linux-arm64-glibc', library: 'libgbrain_napi.so' },
  'aarch64-unknown-linux-musl': { name: 'linux-arm64-musl', library: 'libgbrain_napi.so' },
  'aarch64-apple-darwin': { name: 'darwin-arm64', library: 'libgbrain_napi.dylib' },
  'x86_64-apple-darwin': { name: 'darwin-x64', library: 'libgbrain_napi.dylib' },
  'x86_64-pc-windows-msvc': { name: 'win32-x64', library: 'gbrain_napi.dll' },
  'aarch64-pc-windows-msvc': { name: 'win32-arm64', library: 'gbrain_napi.dll' },
};

if (!Bun.which('cargo') || !Bun.which('rustc')) {
  fail(
    'cargo was not found on PATH. The Rust engine is optional, but building it needs Rust.\n' +
      '  Install it with rustup:  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh\n' +
      '  then open a new shell (or run `. "$HOME/.cargo/env"`) and re-run `bun run rust:build`.\n' +
      '  rustup reads rust/rust-toolchain.toml and installs the pinned Rust version by itself.',
  );
}

const version = Bun.spawnSync(['rustc', '-vV'], { cwd: rustDir, stderr: 'pipe' });
if (version.exitCode !== 0) {
  fail(`rustc -vV failed:\n${version.stderr.toString()}`);
}
const host = /^host: (\S+)$/m.exec(version.stdout.toString())?.[1];
if (!host) fail('could not read the host triple from `rustc -vV`.');
const target = TARGETS[host];
if (!target) {
  fail(`no addon target is defined for host ${host}. Add it to TARGETS here and to target() in the crate.`);
}

// One build at a time per checkout: the release addon and the crash-points addon come out of the same cargo file
// (target/<host>/release/<library>), so a second build that finished between this build and its copy below would hand
// this build the other variant's bytes. The lock is a directory holding the holder's pid; a holder that died leaves
// it behind, and the next build takes it over.
const lockDir = join(rustDir, 'target', '.rust-build.lock');
/** Whether the lock's holder still runs. A lock with no pid yet is fresh for 10 s (its holder is writing the pid). */
function holderAlive(): boolean {
  let pid = 0;
  try { pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim()); } catch {
    try { return Date.now() - statSync(lockDir).mtimeMs < 10_000; } catch { return false; }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
mkdirSync(join(rustDir, 'target'), { recursive: true });
const lockDeadline = Date.now() + 60 * 60_000;
for (let announced = false; ; ) {
  try {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail(`could not take the build lock ${lockDir}: ${String(error)}`);
    if (!holderAlive()) { rmSync(lockDir, { recursive: true, force: true }); continue; }
    if (Date.now() > lockDeadline) fail(`another rust:build in this checkout has held ${lockDir} for an hour; stop it or remove the directory.`);
    if (!announced) { console.error(`rust:build: waiting for another rust:build in this checkout to finish (${lockDir})`); announced = true; }
    Bun.sleepSync(500);
  }
}
process.on('exit', () => rmSync(lockDir, { recursive: true, force: true }));

// Name the output directory and the target, so a CARGO_TARGET_DIR, build.target-dir,
// CARGO_BUILD_TARGET or build.target setting cannot send the build elsewhere while the copy below
// picks up an older library. With --target, cargo always writes to target/<host>/release.
const build = Bun.spawnSync(
  ['cargo', 'build', '--release', '-p', 'gbrain-napi', '--target', host, '--target-dir', join(rustDir, 'target'),
    ...(crashPoints ? ['--features', 'crash-points'] : [])],
  {
    cwd: rustDir,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
if (build.exitCode !== 0) fail(`cargo build failed (exit ${build.exitCode}). No addon was written.`);

const built = join(rustDir, 'target', host, 'release', target.library);
if (!existsSync(built)) fail(`cargo succeeded but ${built} does not exist.`);

const outDir = join(rustDir, 'target', crashPoints ? 'addon-crash-points' : 'addon');
mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, `gbrain_engine.${target.name}.node`);
// Copy to a new file and rename over the old one. A new inode matters on macOS, where a
// previously loaded or signed file that is overwritten in place can be killed by the kernel.
const tmpPath = `${finalPath}.${process.pid}.tmp`;
try {
  copyFileSync(built, tmpPath);
  renameSync(tmpPath, finalPath);
} catch (error) {
  rmSync(tmpPath, { force: true });
  fail(`could not write ${finalPath}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\nBuilt ${finalPath}`);
console.log('Point gbrain at it with:\n');
console.log(`  export GBRAIN_RUST_ENGINE_ADDON=${finalPath}`);
