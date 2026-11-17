#!/usr/bin/env bun
/**
 * Build the Rust engine addon and copy it to a predictable place.
 *
 *   bun run rust:build
 *
 * Output: rust/target/addon/gbrain_engine.<target>.node, plus the line to export so the loader
 * (and rust/smoke/run.ts) can find it:
 *
 *   GBRAIN_RUST_ENGINE_ADDON=/abs/path/to/gbrain_engine.<target>.node
 *
 * Rust is optional for gbrain. This script is the only place that needs it, and when cargo is
 * missing it stops with install instructions before touching anything.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rustDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message: string): never {
  console.error(`rust:build: ${message}`);
  process.exit(1);
}

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

// Name the output directory and the target, so a CARGO_TARGET_DIR, build.target-dir,
// CARGO_BUILD_TARGET or build.target setting cannot send the build elsewhere while the copy below
// picks up an older library. With --target, cargo always writes to target/<host>/release.
const build = Bun.spawnSync(
  ['cargo', 'build', '--release', '-p', 'gbrain-napi', '--target', host, '--target-dir', join(rustDir, 'target')],
  {
    cwd: rustDir,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
if (build.exitCode !== 0) fail(`cargo build failed (exit ${build.exitCode}). No addon was written.`);

const built = join(rustDir, 'target', host, 'release', target.library);
if (!existsSync(built)) fail(`cargo succeeded but ${built} does not exist.`);

const outDir = join(rustDir, 'target', 'addon');
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
