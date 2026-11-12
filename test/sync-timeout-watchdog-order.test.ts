/**
 * #7819: a single-source `sync --timeout N` is stopped by its own in-band
 * abort as a partial run with exit 0, never by the sync watchdog.
 *
 * Protects: the hard-deadline backstop for `--timeout N` sits one grace window
 * after N. The watchdog arms before connectEngine and the in-band abort after
 * it, so a backstop at exactly N always fires first and SIGTERMs the run
 * (exit 143, `code=sync_deadline_stop`). A plain-directory source maps the
 * interrupted import to a `timeout` partial, as the full Git import does.
 * Fails when: the `--timeout` backstop moves back to N, or the plain-directory
 * import's abort surfaces as `internal_error` (exit 1) instead of a partial.
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
  test('a plain-directory --timeout stop is a partial with exit 0, before the watchdog backstop', async () => {
    const home = join(dir, 'home');
    const notes = join(dir, 'notes');
    const files = 3000;
    writeLargeWorktree(notes, files);
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
    const add = await runCli(['sources', 'add', 'source-a', '--path', notes, '--force'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(add.exitCode, add.stderr).toBe(0);

    const sync = await runCli(['sync', '--source', 'source-a', '--no-embed', '--timeout', '2'], { home, env: KEYS, timeoutMs: 120_000 });
    expect(sync.stdout).not.toContain('sync_deadline_stop');
    expect(sync.stderr).not.toContain('[sync-watchdog] deadline reached');
    expect(sync.stderr).toContain('hard deadline armed: 32s');
    expect(sync.exitCode, `${sync.stdout.slice(-2000)}\n${sync.stderr.slice(-2000)}`).toBe(0);
    expect(sync.stdout).toContain('Sync PARTIAL');
    expect(sync.stdout).toContain('reason=timeout');
  }, 300_000);
});
