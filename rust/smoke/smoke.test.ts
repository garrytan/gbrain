/**
 * The /ship test lane for the Rust addon's Bun-side files (rust/scripts/build.ts and rust/smoke/*).
 * It lives outside test/ on purpose: the unit runner only collects test/, so machines with no Rust
 * never run it. It builds the addon and runs the smoke script as child processes, the same two
 * commands the rust-engine.yml addon job runs. It needs cargo and fails, never skips, without it.
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');

function run(args: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(args, { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe('rust addon smoke', () => {
  test('the addon builds and every smoke check passes', () => {
    const build = run([process.execPath, 'rust/scripts/build.ts'], { ...process.env });
    expect(build.out).toContain('Built ');
    expect(build.code).toBe(0);
    const addon = /export GBRAIN_RUST_ENGINE_ADDON=(\S+)/.exec(build.out)?.[1];
    expect(addon).toBeDefined();
    const smoke = run([process.execPath, join('rust', 'smoke', 'run.ts')], {
      ...process.env,
      GBRAIN_RUST_ENGINE_ADDON: addon,
    });
    if (smoke.code !== 0) console.error(smoke.out);
    expect(smoke.code).toBe(0);
  }, 900_000);

  test('a CARGO_TARGET_DIR setting does not make the build package an older library', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'gbrain-cargo-target-'));
    try {
      const build = run([process.execPath, 'rust/scripts/build.ts'], { ...process.env, CARGO_TARGET_DIR: elsewhere });
      expect(build.code).toBe(0);
      // The build went to rust/target, the directory the script copies from, not to the setting.
      expect(existsSync(join(elsewhere, 'release'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 900_000);

  test('a configured build target does not make the build package an older library', () => {
    // CARGO_BUILD_TARGET (or build.target) moves cargo's output to target/<triple>/release, even
    // for the host triple. A sentinel left in target/release must never become the addon.
    const host = /^host: (\S+)$/m.exec(run(['rustc', '-vV'], { ...process.env }).out)?.[1];
    expect(host).toBeDefined();
    const library = process.platform === 'darwin' ? 'libgbrain_napi.dylib' : 'libgbrain_napi.so';
    const releaseDir = join(repo, 'rust', 'target', 'release');
    const seeded = join(releaseDir, library);
    const saved = `${seeded}.smoke-saved`;
    const hadLibrary = existsSync(seeded);
    mkdirSync(releaseDir, { recursive: true });
    if (hadLibrary) renameSync(seeded, saved);
    const sentinel = 'stale library left by an earlier default-target build';
    writeFileSync(seeded, sentinel);
    try {
      const build = run([process.execPath, 'rust/scripts/build.ts'], { ...process.env, CARGO_BUILD_TARGET: host });
      if (build.code !== 0) console.error(build.out);
      expect(build.code).toBe(0);
      const addon = /export GBRAIN_RUST_ENGINE_ADDON=(\S+)/.exec(build.out)?.[1];
      expect(addon).toBeDefined();
      expect(readFileSync(addon!).toString('latin1')).not.toBe(sentinel);
      expect(readFileSync(addon!).equals(readFileSync(join(repo, 'rust', 'target', host!, 'release', library)))).toBe(true);
    } finally {
      rmSync(seeded, { force: true });
      if (hadLibrary) {
        copyFileSync(saved, seeded);
        rmSync(saved, { force: true });
      }
    }
  }, 900_000);
});
