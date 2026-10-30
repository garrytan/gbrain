/**
 * Large-brain ceilings (Foundations 1, F4d), at the CLI boundary where a
 * 52,028-document brain hit them.
 *
 * Protects:
 *   - `gbrain sync` under a non-TTY caller: the default and env deadlines no
 *     longer kill a run that is still importing. A sync whose work outlasts
 *     its deadline window completes and imports every file.
 *   - `gbrain sources add` registers a checkout far above the ~8k-file point
 *     where the old per-file manifest crossed its 1 MiB metadata bound.
 * Fails when: the sync watchdog goes back to a plain wall-clock kill (the
 * child exits 143 after the 1 s deadline with files missing), or the managed
 * manifest grows with the file count again (`request_too_large`).
 * Why new: test/process-watchdog-harness.test.ts drives the watchdog through a
 * harness and test/persistence-large-manifest.test.ts calls the lifecycle
 * function directly; neither runs the real CLI commands the operator runs.
 *   Either order of the 1 s deadline and the first committed page, each
 *   forced once (test/helpers/sync-watchdog-order-preload.ts): the
 *   watchdog's deadline line names the one that ran, and the run completes.
 * Seam: the order preload only delays when the watchdog worker starts or hears
 * of a commit. Deadlines are shortened through the documented env knob, not by
 * waiting an hour.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { commitFixtureRepository, writeLargeWorktree } from './helpers/large-worktree.ts';

const LARGE_CHECKOUT_FILES = 20_000;
const ORDER_PRELOAD = join(import.meta.dir, 'helpers', 'sync-watchdog-order-preload.ts');
const KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };

function commitWorktree(root: string, files: number): void {
  writeLargeWorktree(root, files);
  commitFixtureRepository(root);
}

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-large-ceilings-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function freshBrain(name: string): Promise<string> {
  const home = join(dir, name, 'home');
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, env: KEYS, timeoutMs: 120_000 });
  expect(init.exitCode, init.stderr).toBe(0);
  return home;
}

describe('large-brain ceilings (CLI)', () => {
  // The watchdog's deadline line names which came first, the deadline or the first committed page: a commit by the
  // 1 s deadline extends the run as "still progressing"; a run with no commit by then gets one progress window from
  // its start. Either way it keeps importing and completes.
  async function syncPastDeadline(name: string, order?: 'commit-first' | 'deadline-first') {
    const home = await freshBrain(name);
    const repo = join(dir, name, 'repo');
    commitWorktree(repo, 150);
    const add = await runCli(['sources', 'add', 'notes', '--path', repo], { home, env: KEYS, timeoutMs: 120_000 });
    expect(add.exitCode, add.stderr).toBe(0);

    const sync = await runCli(['sync', '--source', 'notes', '--no-pull'], {
      home, timeoutMs: 180_000,
      env: {
        ...KEYS, GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '1', GBRAIN_SYNC_STALL_ABORT_SECONDS: '60',
        ...(order ? { BUN_OPTIONS: `--preload ${ORDER_PRELOAD}`, GBRAIN_TEST_SYNC_WATCHDOG_ORDER: order } : {}),
      },
    });
    expect(sync.stderr).toContain('extends while the sync keeps progressing');
    const deadline = sync.stderr.split('\n').filter((line) => line.startsWith('[sync-watchdog] deadline reached (1s)'));
    expect(deadline, sync.stderr).toHaveLength(1);
    const ran = deadline[0]!.includes('but the run is still progressing') ? 'commit-first' : 'deadline-first';
    expect(deadline[0]).toContain(ran === 'commit-first'
      ? 'but the run is still progressing'
      : 'before the run committed anything; it stops as a stall unless it commits within 60s of its start');
    expect(sync.stdout).not.toContain('sync_deadline_stop');
    expect(sync.exitCode, sync.stderr).toBe(0);
    expect(sync.stdout).toContain('150 file(s) imported');
    return ran;
  }

  test('a sync that outlasts its deadline window keeps going while it imports, and completes', async () => {
    await syncPastDeadline('sync');
  }, 300_000);

  test('a first page committed before the deadline extends the run as still progressing, and it completes', async () => {
    expect(await syncPastDeadline('commit-first', 'commit-first')).toBe('commit-first');
  }, 300_000);

  test('a first page committed after the deadline gets the progress window from its start, and the run completes', async () => {
    expect(await syncPastDeadline('deadline-first', 'deadline-first')).toBe('deadline-first');
  }, 300_000);

  test('sources add registers a 20,000-file checkout', async () => {
    const home = await freshBrain('add');
    const repo = join(dir, 'add', 'repo');
    commitWorktree(repo, LARGE_CHECKOUT_FILES);
    const add = await runCli(['sources', 'add', 'big', '--path', repo], { home, env: KEYS, timeoutMs: 180_000 });
    expect(add.stderr).not.toContain('request_too_large');
    expect(add.exitCode, `sources add exited ${add.exitCode}\nstderr:\n${add.stderr.slice(-4000)}\nstdout:\n${add.stdout.slice(-2000)}`).toBe(0);
    expect(JSON.parse(add.stdout.slice(add.stdout.indexOf('{')))).toMatchObject({ source_id: 'big', state: 'committed' });
  }, 300_000);
});
