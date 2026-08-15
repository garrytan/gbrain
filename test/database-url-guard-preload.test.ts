/**
 * #3485 invocation-level guard: a bare `bun test` must refuse to start while
 * DATABASE_URL or GBRAIN_DATABASE_URL is ambient, unless the invoker opted in
 * with GBRAIN_TEST_ALLOW_DATABASE_URL=1 (the e2e wrappers do, at their own
 * subprocess boundary).
 *
 * Each case spawns a real `bun test` child on a trivial probe fixture with a
 * controlled environment, so what's asserted is the actual preload behavior,
 * not a re-implementation of it. The child inherits this repo's bunfig.toml
 * (cwd = repo root), which registers the guard preload first.
 */
import { describe, test, expect } from 'bun:test';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PROBE = 'test/fixtures/preload-guard/guard-probe.test.ts';
const GUARD_MARKER = 'TEST-RUN GUARD: refusing to start';

/** Base child env: inherit, then strip every var the guard reads. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'DATABASE_URL' || k === 'GBRAIN_DATABASE_URL' || k === 'GBRAIN_TEST_ALLOW_DATABASE_URL') continue;
    env[k] = v;
  }
  return env;
}

function runProbe(extra: Record<string, string>): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'test', '--timeout=15000', PROBE], {
    cwd: REPO_ROOT,
    env: { ...baseEnv(), ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
    // A hung child would otherwise block the sync call past bun's own
    // per-test timeout (which cannot preempt a native sync call).
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

describe('database-url-guard-preload (#3485)', () => {
  test('refuses when DATABASE_URL is set', () => {
    const r = runProbe({ DATABASE_URL: 'postgresql://localhost:5434/gbrain' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(GUARD_MARKER);
    expect(r.stderr).toContain('DATABASE_URL');
  }, 30_000);

  test('refuses when GBRAIN_DATABASE_URL is set', () => {
    const r = runProbe({ GBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(GUARD_MARKER);
    expect(r.stderr).toContain('GBRAIN_DATABASE_URL');
  }, 30_000);

  test('refuses and names both when both are set', () => {
    const r = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      GBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(GUARD_MARKER);
    expect(r.stderr).toContain('DATABASE_URL and GBRAIN_DATABASE_URL are set');
  }, 30_000);

  test('allows with GBRAIN_TEST_ALLOW_DATABASE_URL=1', () => {
    const r = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      GBRAIN_TEST_ALLOW_DATABASE_URL: '1',
    });
    expect(r.stderr).not.toContain(GUARD_MARKER);
    expect(r.exitCode).toBe(0);
  }, 30_000);

  test('runs clean with no database URL ambient', () => {
    const r = runProbe({});
    expect(r.stderr).not.toContain(GUARD_MARKER);
    expect(r.exitCode).toBe(0);
  }, 30_000);

  test('refuses truthy-but-wrong override values (strict === "1")', () => {
    // A future loosening to Boolean(process.env...) must fail this test:
    // only the exact string '1' opts in.
    const r = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      GBRAIN_TEST_ALLOW_DATABASE_URL: 'true',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(GUARD_MARKER);
  }, 30_000);

  test('treats empty-string values as unset (v !== "" branch)', () => {
    // `export DATABASE_URL=` (empty) is a plausible dev state after a manual
    // unset attempt; the guard deliberately does not refuse on it — an empty
    // string cannot name a database to destroy.
    const r = runProbe({ DATABASE_URL: '', GBRAIN_DATABASE_URL: '' });
    expect(r.stderr).not.toContain(GUARD_MARKER);
    expect(r.exitCode).toBe(0);
  }, 30_000);
});
