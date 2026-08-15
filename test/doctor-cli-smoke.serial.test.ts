/**
 * v0.39 subprocess smoke for `gbrain doctor --json`.
 *
 * Covers the runDoctor wrapper paths that buildChecks-only tests can't
 * reach in-process (D10/CMT-2): outputResults render, process.exit code,
 * --json envelope shape on the wire. Pre-v0.39 the wave had only
 * source-grep tests for these paths; the v0.38.2.0 partial-scan wave
 * showed that's not enough (render bugs slipped through).
 *
 * Spawns `bun run src/cli.ts doctor --json` against a fresh PGLite
 * tempdir brain. Asserts exit code 0 on a freshly-initialized brain,
 * JSON parses, schema_version=2 contract holds, status enum is one of
 * the documented values, checks array is non-empty.
 *
 * Serial because it spawns subprocesses and writes a tmpdir. Skippable
 * via `GBRAIN_SKIP_SUBPROCESS_TESTS=1` for fast-loop budget control.
 *
 * Per-spawn cold-start on CI is ~10-20s. Single test, single brain.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

function makeGbrainShim(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), 'gbrain-shim-doctor-'));
  const shimPath = join(binDir, 'gbrain');
  writeFileSync(shimPath, `#!/bin/sh\nexec bun run ${REPO}/src/cli.ts "$@"\n`, { mode: 0o755 });
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

describe('gbrain doctor --json subprocess smoke (D10/CMT-2)', () => {
  test.skipIf(SKIP)('exits 0 on freshly-initialized PGLite brain; JSON envelope is well-formed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-smoke-'));
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
      const env = {
        HOME: home,
        GBRAIN_HOME: home,
        PATH: `${shim.binDir}:${process.env.PATH ?? ''}`,
      };

      // Step 1: init + apply migrations so the brain is at head before doctor runs.
      // Without this, the brain would be detected as mid-migration and doctor would
      // (correctly) report partial state.
      const init = await runCli(['init', '--migrate-only'], env, 90_000);
      expect(init.exitCode).toBe(0);

      // Step 2: doctor --json against the fresh brain. This is the load-bearing
      // assertion that covers runDoctor's wrapper (render + exit code) — the
      // path that buildChecks-only tests deliberately don't exercise.
      const doctor = await runCli(['doctor', '--json'], env, 120_000);
      if (doctor.exitCode !== 0) {
        console.error('--- doctor stdout ---\n' + doctor.stdout);
        console.error('--- doctor stderr ---\n' + doctor.stderr);
      }
      expect(doctor.exitCode).toBe(0);

      // JSON envelope shape (schema_version=2 contract).
      let parsed: unknown;
      try {
        parsed = JSON.parse(doctor.stdout);
      } catch (e) {
        throw new Error(`doctor --json output failed to parse: ${(e as Error).message}\n${doctor.stdout.slice(0, 500)}`);
      }
      const report = parsed as { schema_version: number; status: string; health_score: number; checks: unknown[] };
      expect(report.schema_version).toBe(2);
      expect(['healthy', 'warnings', 'unhealthy']).toContain(report.status);
      expect(typeof report.health_score).toBe('number');
      expect(report.health_score).toBeGreaterThanOrEqual(0);
      expect(report.health_score).toBeLessThanOrEqual(100);
      expect(Array.isArray(report.checks)).toBe(true);
      expect(report.checks.length).toBeGreaterThan(0);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
      shim.cleanup();
    }
  }, 300_000);
});
