/**
 * v0.36.1.x #1100: PGLite + `gbrain apply-migrations` chain spawn test.
 *
 * Spawns `gbrain init --migrate-only` followed by `gbrain apply-migrations
 * --yes --non-interactive` against a fresh tmpdir, asserts the full
 * migration chain walks to head without wedging on the v0.11.0 Minions
 * phase A subprocess deadlock.
 *
 * Pre-fix, this exact sequence hit `GBrain: Timed out waiting for PGLite
 * lock` because:
 *   1. apply-migrations pre-flight schema-version probe held the
 *      single-writer lock briefly and raced the v0.11.0 subprocess.
 *   2. v0.11.0 phase A spawned `gbrain init --migrate-only` as a child;
 *      the child inherited HOME and tried to acquire the same lock.
 *
 * The fix routes phase A in-process for PGLite and skips the pre-flight
 * probe on PGLite (the warning is non-essential there). No DATABASE_URL
 * needed; runs in standard unit CI.
 *
 * Single-test design: every `bun run <abs-path>/src/cli.ts` from a tmpdir
 * cwd pays a cold parse/transpile cost (no near-cwd .bun cache). On
 * Ubuntu CI that's ~10-20s per spawn. Consolidating into one test with
 * one shared tmpdir keeps wall-clock under the runner's default timeout.
 *
 * Serial because it spawns subprocesses + writes a tmpdir.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Make a shim `gbrain` binary that routes to `bun run <repo>/src/cli.ts`.
 *
 * The v0.11.0 orchestrator chain spawns subprocesses via `execSync('gbrain
 * jobs smoke')` and `execSync('gbrain init --migrate-only')` (the Postgres
 * path; PGLite now routes in-process, but phase B's smoke still shells out).
 * On a developer machine `gbrain` resolves via `bun link`; on CI it
 * doesn't exist on PATH and execSync fails with "command not found",
 * propagating up as an orchestrator failure. The shim avoids the global-
 * install dependency.
 */
function makeGbrainShim(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), 'gbrain-shim-'));
  const shimPath = join(binDir, 'gbrain');
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec bun run ${REPO}/src/cli.ts "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);
  return {
    binDir,
    cleanup: () => {
      try { rmSync(binDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('apply-migrations on fresh PGLite (v0.36.1.x #1100)', () => {
  // ONE test, ONE brain, ONE end-to-end pass through the lifecycle. The
  // per-spawn cold-start on Ubuntu CI (~10-20s) is the dominant cost; we
  // pay it 4 times here, not 8.
  test('init --migrate-only → apply-migrations --yes → re-run → --list (all exit 0)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-pglite-spawn-'));
    const shim = makeGbrainShim();
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_dimensions: 1536,
        }) + '\n',
      );
      // PATH shim so orchestrator phase-B execSync('gbrain jobs smoke')
      // and similar resolve to our shim instead of requiring a global
      // install. This matches the contract users hit in production
      // (gbrain on PATH) without depending on `bun link` having run.
      const env = {
        HOME: home,
        GBRAIN_HOME: home,
        PATH: `${shim.binDir}:${process.env.PATH ?? ''}`,
      };

      // Step 1: init --migrate-only seeds the schema. Pre-fix on PGLite this
      // worked but the next step then deadlocked.
      const init = await runCli(['init', '--migrate-only'], env, 90_000);
      expect(init.exitCode).toBe(0);
      expect(init.stdout + init.stderr).toMatch(/Schema up to date|migration\(s\) applied/);

      // Step 2: apply-migrations --yes runs the orchestrator chain. Pre-fix
      // this wedged on v0.11.0 phase A with the PGLite lock timeout.
      const apply = await runCli(
        ['apply-migrations', '--yes', '--non-interactive'],
        env,
        180_000,
      );
      if (apply.exitCode !== 0) {
        // Dump for CI triage — local repro passes; this surfaces the
        // Ubuntu-specific failure mode (probably env-related: BUN_INSTALL,
        // HOME-relative path, or a PGLite WASM quirk).
        console.error('--- apply-migrations stdout ---\n' + apply.stdout);
        console.error('--- apply-migrations stderr ---\n' + apply.stderr);
        console.error('--- init stdout ---\n' + init.stdout);
        console.error('--- init stderr ---\n' + init.stderr);
      }
      expect(apply.exitCode).toBe(0);
      const applyOut = apply.stdout + apply.stderr;
      expect(applyOut).not.toMatch(/Timed out waiting for PGLite lock/);
      expect(applyOut).not.toMatch(/Phase A \(schema\) failed/);
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);

      // Step 3: re-run is idempotent — "All migrations up to date" must exit
      // 0, not fall through to implicit non-zero (the #1062 fix path).
      const second = await runCli(['apply-migrations', '--yes', '--non-interactive'], env, 90_000);
      expect(second.exitCode).toBe(0);
      expect(second.stdout + second.stderr).toMatch(/All migrations up to date|up to date/);

      // Step 4: --list exits 0 (third leg of the #1062 contract).
      const list = await runCli(['apply-migrations', '--list'], env, 60_000);
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).toMatch(/applied|pending|migration/i);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
      shim.cleanup();
    }
  }, 480_000);
});
