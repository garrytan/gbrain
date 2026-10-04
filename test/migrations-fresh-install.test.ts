/**
 * E8 fresh-install stamping: the ledger stamps init writes, the
 * `pending_fresh_install` status every migration surface derives from them
 * (apply-migrations plan, get_health ledger summary, doctor), and the
 * in-process config read in v0.12.0. The end-to-end proof on a real
 * `gbrain init` brain is test/migrations-fresh-install-audit.serial.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import { stampFreshInstallMigrations } from '../src/commands/migrations/fresh-install.ts';
import { __testing as planTesting } from '../src/commands/apply-migrations.ts';
import { __testing as v0120Testing } from '../src/commands/migrations/v0_12_0.ts';
import { migrationLedgerSummary } from '../src/core/migration-ledger.ts';
import { loadCompletedMigrations, type CompletedMigrationEntry } from '../src/core/preferences.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { getDbUrlSource } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FLAGGED = migrations.filter(m => m.fresh_install_noop).map(m => m.version);
const SETUP = migrations.filter(m => !m.fresh_install_noop).map(m => m.version);
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-e8-unit-'));
  homes.push(home);
  return home;
}

function writeLedger(home: string, entries: CompletedMigrationEntry[]): void {
  mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const stamp = (version: string, installed: string): CompletedMigrationEntry =>
  ({ version, status: 'complete', fresh_install: true, installed_version: installed });

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('stampFreshInstallMigrations', () => {
  test('stamps every fresh_install_noop migration, lists the rest as pending_fresh_install, and is idempotent', async () => {
    const home = freshHome();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const receipt = stampFreshInstallMigrations('0.60.37');
      expect(receipt).toEqual({ installed_version: '0.60.37', stamped: FLAGGED, pending_fresh_install: SETUP });
      const entries = loadCompletedMigrations();
      expect(entries.map(e => e.version)).toEqual(FLAGGED);
      for (const entry of entries) {
        expect(entry).toMatchObject({ status: 'complete', fresh_install: true, installed_version: '0.60.37' });
        expect(entry.phases?.[0]).toMatchObject({ name: 'fresh_install', status: 'skipped' });
      }
      stampFreshInstallMigrations('0.60.37');
      expect(loadCompletedMigrations().length).toBe(FLAGGED.length);
    });
  });

  test('never stamps a migration newer than the creating binary', async () => {
    const home = freshHome();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const receipt = stampFreshInstallMigrations('0.20.0');
      expect(receipt.stamped).toEqual(['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.16.0', '0.18.0', '0.18.1']);
      expect(receipt.pending_fresh_install).toEqual(['0.11.0', '0.14.0']);
    });
  });
});

describe('pending_fresh_install status', () => {
  test('ledger summary: setup work on a new brain is pending_fresh_install, not pending', async () => {
    const home = freshHome();
    writeLedger(home, FLAGGED.map(v => stamp(v, '0.60.37')));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const summary = migrationLedgerSummary('0.60.37');
      expect(summary.pending).toEqual([]);
      expect(summary.pending_fresh_install).toEqual(SETUP);
    });
  });

  test('migrations newer than the creating version stay ordinary pending upgrade work', async () => {
    const home = freshHome();
    writeLedger(home, ['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.29.1'].map(v => stamp(v, '0.30.0')));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const summary = migrationLedgerSummary('99.0.0');
      expect(summary.pending_fresh_install).toEqual(['0.11.0', '0.14.0', '0.22.4', '0.28.0']);
      expect(summary.pending).toEqual(['0.31.0', '0.32.2', '0.43.0', '0.46.3', '0.53.0', '0.60.31']);
    });
  });

  test('a brain with no stamps (created before stamping) keeps every unrun migration pending', async () => {
    const home = freshHome();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const summary = migrationLedgerSummary('99.0.0');
      expect(summary.pending_fresh_install).toEqual([]);
      expect(summary.pending.length).toBe(migrations.length);
    });
  });

  test('apply-migrations plan puts unrun setup work in pending_fresh_install and runs it like pending', () => {
    const idx = planTesting.indexCompleted(FLAGGED.map(v => stamp(v, '0.60.37')));
    const plan = planTesting.buildPlan(idx, '0.60.37');
    expect(plan.applied.map(m => m.version)).toEqual(FLAGGED);
    expect(plan.pending_fresh_install.map(m => m.version)).toEqual(SETUP);
    expect(plan.pending).toEqual([]);
  });
});

describe('doctor minions_migration with fresh-install stamps', () => {
  async function minionsChecks(home: string) {
    return withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () =>
      (await buildChecks(null, ['--fast', '--json'], getDbUrlSource())).filter(c => c.name === 'minions_migration'));
  }

  test('a stamped newer no-op does not hide a real partial', async () => {
    const home = freshHome();
    writeLedger(home, [...FLAGGED.map(v => stamp(v, '0.60.37')), { version: '0.11.0', status: 'partial' }]);
    const checks = await minionsChecks(home);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('fail');
    expect(checks[0].message).toContain('0.11.0');
  });

  test('a real newer completion still supersedes a stale partial', async () => {
    const home = freshHome();
    writeLedger(home, [{ version: '0.11.0', status: 'partial' }, { version: '0.60.31', status: 'complete' }]);
    const checks = await minionsChecks(home);
    expect(checks.filter(c => c.status === 'fail')).toEqual([]);
  });

  test('pending setup work is an info row with the finishing command, never a failure', async () => {
    const home = freshHome();
    writeLedger(home, FLAGGED.map(v => stamp(v, '0.60.37')));
    const [check] = await minionsChecks(home);
    expect(check).toMatchObject({ status: 'ok', severity: 'info', details: { pending_fresh_install: SETUP } });
    expect(check.message).toContain('not a failed upgrade');
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], consent: [], actor: 'agent' });
  });
});

describe('v0.12.0 config check reads auto_link in-process', () => {
  let home = '';
  let database = '';
  let engine: PGLiteEngine;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-e8-autolink-'));
    database = join(home, '.gbrain', 'brain.pglite');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: database });
    await engine.initSchema();
    await engine.disconnect();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  const check = () => withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    () => v0120Testing.phaseBConfigCheck({ yes: true, dryRun: false, noAutopilotInstall: true }));

  // Before E8 this shelled out to `gbrain config get`, which has no CLI to
  // resolve under bun test, so the disabled value was never seen.
  test('database plane auto_link=false skips the backfill; unset defaults to enabled', async () => {
    expect((await check()).autoLink).toEqual({ status: 'unknown', raw: undefined });
    await engine.connect({ database_path: database });
    try { await engine.setConfig('auto_link', 'false'); } finally { await engine.disconnect(); }
    expect((await check()).autoLink).toEqual({ status: 'disabled', raw: 'false' });
  }, 60_000);
});
