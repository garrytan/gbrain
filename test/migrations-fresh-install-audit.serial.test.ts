/**
 * E8 fresh-install audit (agent-first operator wave, Lane E).
 *
 * `gbrain init` records a migration complete on a new brain only when the
 * migration declares `fresh_install_noop: true`. This file is the proof for
 * every flag: on one keyless PGLite brain created by the real CLI
 * (`init --pglite --no-embedding`, hermetic HOME = GBRAIN_HOME, provider keys
 * scrubbed, `fetch` refused), each flagged orchestrator runs for real and the
 * public schema (columns, indexes, constraints), every table's row count, the
 * config table and the GBRAIN_HOME file tree must be byte-identical before and
 * after. The unflagged migrations list as `pending_fresh_install` and
 * `apply-migrations --yes --no-autopilot-install` completes them.
 *
 * Orchestrators that shell out (`extract`, `repair-jsonb`, `get_stats`) run the
 * source CLI through `GBRAIN_JOB_CHILD_CLI` with the no-network preload; none
 * of the audited orchestrators installs a service.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { PROVIDER_ENV_KEYS } from './helpers/provider-env.ts';
import { snapshotBrain } from './helpers/fresh-brain-snapshot.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import { SHARED_CONTENT_INSPECT_ARGV } from '../src/commands/migrations/shared-content.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

const REPO = join(import.meta.dir, '..');
const FLAGGED = ['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.29.1', '0.31.0', '0.32.2', '0.43.0', '0.46.3', '0.60.31'];
const SETUP = ['0.11.0', '0.14.0', '0.22.4', '0.28.0', '0.53.0'];

let home = '';
let tools = '';
let databasePath = '';
const keyless = Object.fromEntries([...PROVIDER_ENV_KEYS, 'GBRAIN_PGLITE_SNAPSHOT'].map(key => [key, undefined]));

function ledger(): CompletedMigrationEntry[] {
  return readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-e8-home-'));
  tools = mkdtempSync(join(tmpdir(), 'gbrain-e8-tools-'));
  const child = join(tools, 'gbrain');
  writeFileSync(child, `#!/bin/sh\nexec "${process.execPath}" --no-env-file --preload "${join(REPO, 'test/helpers/no-network-preload.ts')}" "${join(REPO, 'src/cli.ts')}" "$@"\n`);
  chmodSync(child, 0o755);
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, cwd: home, env: keyless, timeoutMs: 120_000 });
  expect(init.exitCode).toBe(0);
  databasePath = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).database_path;
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

describe('E8 — gbrain init stamps only fresh_install_noop migrations', () => {
  test('the flagged set is exactly the audited set; everything else is setup work', () => {
    expect(migrations.filter(m => m.fresh_install_noop).map(m => m.version)).toEqual(FLAGGED);
    expect(migrations.filter(m => !m.fresh_install_noop).map(m => m.version)).toEqual(SETUP);
  });

  test('init writes a fresh_install ledger entry for each flagged migration and nothing else', () => {
    const entries = ledger();
    expect(entries.map(e => e.version)).toEqual(FLAGGED);
    for (const entry of entries) {
      expect(entry).toMatchObject({ status: 'complete', fresh_install: true });
      expect(typeof entry.installed_version).toBe('string');
    }
  });

  test('apply-migrations --list --json reports the rest as pending_fresh_install with the finishing command', async () => {
    const list = await runCli(['apply-migrations', '--list', '--json'], { home, cwd: home, env: keyless });
    expect(list.exitCode).toBe(0);
    const body = JSON.parse(list.stdout.trim().split('\n').at(-1)!);
    const byStatus = (status: string) => body.migrations.filter((m: { status: string }) => m.status === status).map((m: { version: string }) => m.version);
    expect(byStatus('applied')).toEqual(FLAGGED);
    expect(byStatus('pending_fresh_install')).toEqual(SETUP);
    expect(byStatus('pending')).toEqual([]);
    expect(body.needs_action).toBe(0);
    expect(body.pending_fresh_install).toBe(SETUP.length);
    expect(body.next.argv).toEqual(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install']);
    expect(body.migrations.filter((m: { fresh_install?: boolean }) => m.fresh_install).length).toBe(FLAGGED.length);
  }, 60_000);
});

describe('E8 audit — each fresh_install_noop orchestrator changes nothing on a new brain', () => {
  for (const version of FLAGGED) {
    test(`v${version}`, async () => {
      const migration = migrations.find(m => m.version === version)!;
      const fetched: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: unknown) => {
        fetched.push(String(input));
        throw new Error('network disabled in the fresh-install audit');
      }) as unknown as typeof fetch;
      try {
        await withEnv({
          ...keyless, HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
          GBRAIN_JOB_CHILD_CLI: join(tools, 'gbrain'), GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_AUTOPILOT_INSTALL: '1',
        }, async () => {
          const before = await snapshotBrain(home, databasePath);
          const result = await migration.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
          expect(result.status).toBe('complete');
          expect(result.phases.filter(phase => phase.status === 'failed')).toEqual([]);
          expect(await snapshotBrain(home, databasePath)).toEqual(before);
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(fetched).toEqual([]);
    }, 120_000);
  }
});

describe('E8 — finishing setup', () => {
  test('apply-migrations --yes completes pending_fresh_install; shared-skills names its command; max_stalled keeps its default', async () => {
    const run = await runCli(['apply-migrations', '--yes', '--no-autopilot-install'], { home, cwd: home, env: keyless, timeoutMs: 120_000 });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`next step: ${SHARED_CONTENT_INSPECT_ARGV.join(' ')}`);
    const shared = ledger().filter(e => e.version === '0.53.0').at(-1)!;
    expect(shared.phases?.[0]).toMatchObject({ name: 'content-checkpoints', argv: SHARED_CONTENT_INSPECT_ARGV });

    const list = await runCli(['apply-migrations', '--list', '--json'], { home, cwd: home, env: keyless });
    const body = JSON.parse(list.stdout.trim().split('\n').at(-1)!);
    expect(body.migrations.every((m: { status: string }) => m.status === 'applied')).toBe(true);
    expect(body.next).toBeUndefined();

    const engine = new PGLiteEngine();
    await engine.connect({ database_path: databasePath });
    try {
      const [column] = await engine.executeRaw<{ column_default: string }>(
        "SELECT column_default FROM information_schema.columns WHERE table_name = 'minion_jobs' AND column_name = 'max_stalled'");
      expect(column.column_default).toBe('5');
    } finally {
      await engine.disconnect();
    }
  }, 180_000);
});
