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
 * cwd pays a cold parse/transpile cost (no near-cwd .bun cache). Measured
 * 11.3s and 28.9s on two back-to-back Windows spawns. Consolidating into one
 * test with one shared tmpdir keeps wall-clock under the runner's default
 * timeout.
 *
 * Per-step budgets come from `helpers/pglite-spawn-budget.ts` (measurements +
 * `GBRAIN_TEST_*` overrides documented there), NOT from literals here. They
 * are hang detectors, not latency targets.
 *
 * Serial because it spawns subprocesses + writes a tmpdir.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { REPO_ROOT as REPO } from './helpers/repo-root.ts';
import { makeGbrainShim } from './helpers/gbrain-shim.ts';
import {
  PGLITE_BOOTSTRAP_MS,
  ORCHESTRATOR_CASCADE_MS,
  CLI_SPAWN_MS,
} from './helpers/pglite-spawn-budget.ts';

// Same fast-loop escape hatch doctor-cli-smoke.serial.test.ts offers: this file
// is minutes of real subprocess work on Windows, and an inner edit loop rarely
// needs it. CI never sets this.
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

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
  // per-spawn cold-start is the dominant cost (11.3s / 28.9s measured on two
  // back-to-back Windows spawns); we pay it 4 times here, not 8.
  test.skipIf(SKIP)('init --migrate-only → apply-migrations --yes → re-run → --list (all exit 0)', async () => {
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
      //
      // `shim.pathValue` joins with the platform PATH delimiter. A
      // hardcoded ':' does not error on Windows — it silently makes the
      // shim dir (and every inherited entry) unresolvable, so lookup falls
      // through to whatever `gbrain` is globally installed.
      // `GBRAIN_HOME` is what actually redirects the brain: `configDir()`
      // honors it and only falls back to `homedir()`, which on Windows
      // reads USERPROFILE and would ignore a bare `HOME`.
      const env = {
        HOME: home,
        GBRAIN_HOME: home,
        PATH: shim.pathValue,
      };

      // Step 1: init --migrate-only seeds the schema. Pre-fix on PGLite this
      // worked but the next step then deadlocked.
      const init = await runCli(['init', '--migrate-only'], env, PGLITE_BOOTSTRAP_MS);
      expect(init.exitCode).toBe(0);
      expect(init.stdout + init.stderr).toMatch(/Schema up to date|migration\(s\) applied/);

      // Step 2: apply-migrations --yes runs the orchestrator chain. Pre-fix
      // this wedged on v0.11.0 phase A with the PGLite lock timeout.
      // Cascade budget, not bootstrap: this walks all 19 orchestrators and
      // each shells out. Measured 698.3s end-to-end on Windows.
      const apply = await runCli(
        ['apply-migrations', '--yes', '--non-interactive'],
        env,
        ORCHESTRATOR_CASCADE_MS,
      );
      if (apply.exitCode !== 0) {
        // Dump for triage. The two failure shapes seen so far: exit 137 (the
        // runCli killer fired — a real hang), and exit 1 from an orchestrator
        // phase aborting on its OWN internal timeout, which no budget here
        // can influence. The stderr dump is what tells them apart.
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
      const second = await runCli(
        ['apply-migrations', '--yes', '--non-interactive'],
        env,
        PGLITE_BOOTSTRAP_MS,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout + second.stderr).toMatch(/All migrations up to date|up to date/);

      // Step 4: --list exits 0 (third leg of the #1062 contract). Reads the
      // already-built brain — no schema replay, so the cheap budget applies.
      const list = await runCli(['apply-migrations', '--list'], env, CLI_SPAWN_MS);
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).toMatch(/applied|pending|migration/i);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
      shim.cleanup();
    }
    // Derived, not a hand-picked constant: the test-level cap must sit ABOVE
    // the sum of the four per-step budgets, or it fires first and you lose the
    // per-step diagnostic that says WHICH spawn hung. Mirror the steps exactly
    // — bootstrap (init) + cascade (apply) + bootstrap (re-run) + cli (--list).
    // Deriving it also means a GBRAIN_TEST_* override scales this automatically.
  }, PGLITE_BOOTSTRAP_MS * 2 + ORCHESTRATOR_CASCADE_MS + CLI_SPAWN_MS + 60_000);
});
