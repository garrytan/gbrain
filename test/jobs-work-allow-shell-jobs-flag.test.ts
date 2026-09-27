/**
 * `gbrain jobs work --allow-shell-jobs` re-asserts GBRAIN_ALLOW_SHELL_JOBS=1
 * AFTER the startup cwd-.env quarantine (core/env-trust.ts drops that env var
 * whenever a .env in the worker's cwd assigns it), so a supervisor-spawned
 * worker (buildWorkerArgs pass-through) keeps its shell handler enabled.
 *
 * The `work` case is a long-running daemon, so the test stops it at the very
 * next validation exit — `--health-interval abc` → process.exit(1) — which
 * sits AFTER the flag line; process.exit is stubbed to throw (the
 * storage-export.test.ts convention). No worker loop ever starts and nothing
 * connects to a database: the config only has to be non-PGLite to get past
 * the `work` case's PGLite refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobs } from '../src/commands/jobs.ts';
import { saveConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { JOB_CHILD_EXIT_USAGE } from '../src/core/minions/worker-exit-codes.ts';
import { withEnv } from './helpers/with-env.ts';

const EXIT = '__test_exit__';
let home: string;
let originalExit: typeof process.exit;
let originalError: typeof console.error;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-jobs-work-flag-'));
  stderr = [];
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`${EXIT}:${code ?? 0}`);
  }) as typeof process.exit;
  originalError = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalError;
  rmSync(home, { recursive: true, force: true });
});

/** Run `jobs work <args> --health-interval abc`; returns the env var as the flag line left it. */
async function runWork(args: string[]): Promise<string> {
  return withEnv(
    { GBRAIN_HOME: home, GBRAIN_ALLOW_SHELL_JOBS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    async () => {
      saveConfig({ engine: 'postgres', database_url: 'postgresql://worker.invalid/brain' } as never);
      const err = await runJobs({} as unknown as BrainEngine, ['work', ...args, '--health-interval', 'abc'])
        .then(() => null, (e: unknown) => e);
      expect((err as Error).message).toBe(`${EXIT}:1`);
      expect(stderr.join('\n')).toContain('--health-interval must be a non-negative integer');
      return process.env.GBRAIN_ALLOW_SHELL_JOBS ?? '<unset>';
    },
  );
}

describe('jobs work --allow-shell-jobs', () => {
  test('the flag re-asserts GBRAIN_ALLOW_SHELL_JOBS=1 after preflight (before any worker starts)', async () => {
    expect(await runWork(['--allow-shell-jobs'])).toBe('1');
  });

  test('without the flag the env var stays unset — no implicit shell opt-in', async () => {
    expect(await runWork([])).toBe('<unset>');
  });
});

// ── `jobs run-child --allow-shell-jobs` (A5) ─────────────────────────────────
//
// The process-isolation child re-runs preflight in the worker's cwd, so the
// flag `buildChildArgs` appends must re-assert the env var there too. The
// `run-child` case exits at its usage check when no --job-id is given (after
// the re-assert), which is the observation point — no job, no DB, no handler.
describe('jobs run-child --allow-shell-jobs', () => {
  async function runChild(args: string[]): Promise<string> {
    return withEnv(
      { GBRAIN_HOME: home, GBRAIN_ALLOW_SHELL_JOBS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        saveConfig({ engine: 'postgres', database_url: 'postgresql://worker.invalid/brain' } as never);
        const engine = { disconnect: async () => {} } as unknown as BrainEngine;
        const err = await runJobs(engine, ['run-child', ...args]).then(() => null, (e: unknown) => e);
        expect((err as Error).message).toBe(`${EXIT}:${JOB_CHILD_EXIT_USAGE}`);
        expect(stderr.join('\n')).toContain('[run-child] internal command');
        return process.env.GBRAIN_ALLOW_SHELL_JOBS ?? '<unset>';
      },
    );
  }

  test('the flag re-asserts GBRAIN_ALLOW_SHELL_JOBS=1 in the child after preflight', async () => {
    expect(await runChild(['--allow-shell-jobs'])).toBe('1');
  });

  test('without the flag the child has no implicit shell opt-in', async () => {
    expect(await runChild([])).toBe('<unset>');
  });
});
