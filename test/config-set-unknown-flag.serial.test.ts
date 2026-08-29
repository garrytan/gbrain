/**
 * #3661 — `gbrain config set` must reject a flag it does not implement
 * instead of dropping it and writing anyway.
 *
 * The bug: `gbrain config set models.tier.subagent <value> --dry-run` printed
 * the normal "Set <key> = <value>" confirmation and persisted the mutation to
 * the DB config plane. `--dry-run` is implemented by sync/import/extract/
 * quarantine/pages, so an operator who had learned that habit got a live
 * config write where they expected a preview.
 *
 * These tests spawn the real CLI against a throwaway PGLite brain and assert
 * on BEHAVIOR — exit code plus the value `config get` reports afterwards — not
 * on the source text of the handler. The write-didn't-happen assertion is the
 * load-bearing one: an implementation that errors AFTER `engine.setConfig`
 * would still pass an exit-code-only test.
 *
 * Pre-fix, the two rejection tests fail on exit code AND on the persisted
 * value; the control tests pass on both trees (they pin the regression).
 *
 * Serial: spawns subprocesses against a pinned GBRAIN_HOME tmpdir.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const KEY = 'models.tier.subagent';
const BASELINE = 'anthropic:claude-haiku-4-5';

let home: string;
let dbPath: string;

function cliEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    // Neutralize ambient routing signals from the invoking shell/CI so the
    // spawns can only ever reach the throwaway brain created below.
    GBRAIN_BRAIN_ID: '',
    GBRAIN_SOURCE: '',
    GBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
  };
}

async function runCli(
  args: string[],
  timeoutMs = 90_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: cliEnv(),
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

/** Put the key back to a known value so each test starts from the same state. */
async function setBaseline(): Promise<void> {
  const r = await runCli(['config', 'set', KEY, BASELINE]);
  expect(r.exitCode).toBe(0);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-config-set-flag-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n',
  );
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect();
}, 240_000);

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('config set rejects unknown flags instead of writing anyway', () => {
  test('control: no flags still writes and reports the value', async () => {
    const set = await runCli(['config', 'set', KEY, BASELINE]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain(`Set ${KEY} = ${BASELINE}`);

    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  test('the reported case: --dry-run is refused and nothing is persisted', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, 'claude-cli:probe-invalid', '--dry-run']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --dry-run');
    // The pre-fix output — the confirmation line that made the write invisible.
    expect(set.stdout).not.toContain('Set ');

    // The load-bearing assertion: the config plane is untouched. An
    // implementation that errors after setConfig fails here.
    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  test('any unimplemented flag is refused, not just --dry-run', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, 'anthropic:claude-opus-4-1', '--bogus']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --bogus');

    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  // Ordering follow-up: the flag can land BEFORE the value too
  // (`config set <key> --dry-run <value>`), not just after it. The original
  // #3661 gate only scanned the tail past `<key> <value>`, so a flag sitting
  // in the value slot was silently treated as a literal value and written.
  test('an unknown flag placed before the value is also refused (ordering)', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, '--dry-run', 'claude-cli:probe-invalid']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --dry-run');
    expect(set.stdout).not.toContain('Set ');

    // The load-bearing assertion: nothing was written, including the flag
    // token itself, which pre-fix would have landed in the config plane as
    // the literal value (`value = args[2]` picked up `--dry-run` directly).
    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  // Every flag `config set` implements, so a future edit that narrows the
  // allowlist breaks here instead of silently rejecting a working command.
  const IMPLEMENTED_FLAGS: Array<[string, string]> = [
    ['--force', 'anthropic:claude-sonnet-4-6'],
    ['--coverage-override', 'anthropic:claude-sonnet-4-5'],
    ['--yes', 'anthropic:claude-opus-4-5'],
  ];

  for (const [flag, written] of IMPLEMENTED_FLAGS) {
    test(`${flag}, an implemented flag, still writes`, async () => {
      await setBaseline();

      const set = await runCli(['config', 'set', KEY, written, flag]);
      expect(set.exitCode).toBe(0);
      expect(set.stdout).toContain(`Set ${KEY} = ${written}`);

      const get = await runCli(['config', 'get', KEY]);
      expect(get.exitCode).toBe(0);
      expect(get.stdout.trim()).toBe(written);
    }, 180_000);
  }
});
