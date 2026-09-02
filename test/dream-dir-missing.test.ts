/**
 * REGRESSION (iron rule): `gbrain dream --dir <missing>` still exits 1 with
 * the same message after the brain-dir resolver moved to src/core/brain-dir.ts.
 * The resolver itself never exits; dream.ts maps `explicit_missing` to the
 * historical exit-1 at its call site. Subprocess test (same harness as
 * dream-keyless-exit.test.ts) because process.exit is the contract.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

describe.skipIf(SKIP)('gbrain dream --dir <missing path> (regression)', () => {
  let home = '';
  let env: Record<string, string>;

  function gbrain(args: string[], timeoutMs: number) {
    const res = spawnSync(process.execPath, ['run', CLI, ...args], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { exitCode: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-dream-dir-missing-'));
    const bunDir = dirname(process.execPath || '/usr/local/bin');
    env = {
      PATH: `${bunDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      GBRAIN_HOME: home,
      TMPDIR: tmpdir(),
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
    };
    // Keyless PGLite brain, exactly like dream-keyless-exit.test.ts, so the
    // run reaches the --dir resolution with a real engine behind it.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({
        engine: 'pglite',
        database_path: join(home, '.gbrain', 'brain.pglite'),
        embedding_disabled: true,
      }) + '\n',
    );
    const init = gbrain(['init', '--migrate-only'], 120_000);
    if (init.exitCode !== 0) throw new Error(`init --migrate-only failed (${init.exitCode}):\n${init.stderr.slice(-2000)}`);
  }, 180_000);

  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('exits 1 and names the missing --dir path; no cycle runs', () => {
    const missing = join(home, 'no-such-checkout');
    const r = gbrain(['dream', '--dir', missing, '--phase', 'lint', '--json'], 120_000);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`--dir path does not exist: ${missing}`);
    // No report was produced: the exit happened before the cycle.
    expect(r.stdout).not.toContain('"phases"');
  }, 150_000);
});
