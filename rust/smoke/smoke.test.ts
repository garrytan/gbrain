/**
 * The /ship test lane for the Rust addon's Bun-side files (rust/scripts/build.ts and rust/smoke/*).
 * It lives outside test/ on purpose: the unit runner only collects test/, so machines with no Rust
 * never run it. It builds the addon and runs the smoke script as child processes, the same two
 * commands the rust-engine.yml addon job runs. It needs cargo and fails, never skips, without it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
});
