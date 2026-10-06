/**
 * D-N5 (fix wave 9) — the v0.28.0 migration queues a re-chunk TODO in
 * pending-host-work.jsonl. Its `command` must be a real gbrain invocation
 * that runs on a brain, not a nonexistent `gbrain extract takes --rebuild`.
 *
 * The test runs the queued command (with --dry-run, so nothing is written)
 * against a fresh keyless PGLite brain and requires a clean exit.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { __testing } from '../src/commands/migrations/v0_28_0.ts';

const CLI_ENTRY = join(process.cwd(), 'src/cli.ts');

function runCli(home: string, args: string[]): { out: string; status: number } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete env[key];
  const r = spawnSync('bun', ['--no-env-file', 'run', CLI_ENTRY, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? -1 };
}

describe('D-N5 — v0.28.0 re-chunk TODO names a command that runs', () => {
  test('the queued command executes on a fresh brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-dn5-'));
    try {
      const command = await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
        const result = __testing.phaseCRechunkTodo({ dryRun: false } as never);
        expect(result.status).toBe('complete');
        const lines = readFileSync(__testing.pendingHostWorkPath(), 'utf8').trim().split('\n');
        return (JSON.parse(lines[lines.length - 1]) as { command: string }).command;
      });
      expect(command.startsWith('gbrain ')).toBe(true);
      expect(command).not.toContain('#');

      const init = runCli(home, ['init', '--pglite', '--no-embedding', '--non-interactive']);
      expect(init.status, init.out).toBe(0);
      const argv = command.split(/\s+/).slice(1);
      const hint = runCli(home, [...argv, '--dry-run']);
      expect(hint.status, hint.out).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120000);
});
