/**
 * #7819: the sync watchdog never stops a single-source `--timeout N` run that
 * the in-band `--timeout` abort stops on its own.
 *
 * Protects: the hard-deadline backstop for `--timeout N` sits one grace window
 * after N. The watchdog arms before connectEngine and the in-band abort after
 * it, so a backstop at exactly N always fires first and SIGTERMs the run
 * (exit 143, `code=sync_deadline_stop`).
 * Fails when: the `--timeout` backstop moves back to N.
 * Seam: a plain-directory source large enough that its import outlasts the
 * timeout, through the real CLI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { writeLargeWorktree } from './helpers/large-worktree.ts';

const KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-sync-timeout-watchdog-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sync --timeout (CLI)', () => {
  test('the in-band --timeout stop lands before the watchdog backstop', async () => {
    const home = join(dir, 'home');
    const notes = join(dir, 'notes');
    writeLargeWorktree(notes, 3000);
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
    const add = await runCli(['sources', 'add', 'source-a', '--path', notes, '--force'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(add.exitCode, add.stderr).toBe(0);

    const sync = await runCli(['sync', '--source', 'source-a', '--no-embed', '--timeout', '2'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(sync.stdout).not.toContain('sync_deadline_stop');
    expect(sync.stderr).not.toContain('[sync-watchdog] deadline reached');
    expect(sync.exitCode, `${sync.stdout.slice(-2000)}\n${sync.stderr.slice(-2000)}`).not.toBe(143);
    expect(sync.stderr).toContain('hard deadline armed: 32s');
  }, 300_000);
});
