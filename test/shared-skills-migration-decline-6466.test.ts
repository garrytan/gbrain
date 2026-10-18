/**
 * #6466: a brain owner can decline the v0.53.0 shared-skills migration.
 * `shared_skills.migration.enabled=false` (brain-level DB config, shared by
 * every machine on that database) makes the runner skip the migration on
 * every apply-migrations path, including the reconcile re-check an applied
 * ledger entry would otherwise rerun: no orchestrator call, no inventory, no
 * config writes. `--list` reports it `declined`; an explicit
 * `--migration 0.53.0` refuses with exit 3 `migration_declined` and the
 * command that turns it back on (T1: refuse, because one machine's explicit
 * run would rewrite config for all of them); doctor and get_health report
 * `declined` instead of pending.
 *
 * Runner cases drive the real apply-migrations in a child process against a
 * stubbed registry (test/helpers/apply-migrations-schema-driver.ts, kind
 * `declinable`) on a PGLite brain whose config carries the key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { VERSION } from '../src/version.ts';
import * as ledger from '../src/core/migration-ledger.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import { sharedContentMigration } from '../src/commands/migrations/shared-content.ts';
import { minionsMigrationEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { collect, makeHome, spawnDriver } from './helpers/apply-migrations-lock-driver.ts';
import { parseDocument, writeSchemaDriver, type SchemaDriverOpts } from './helpers/apply-migrations-schema-driver.ts';

const KEY = 'shared_skills.migration.enabled';
// Read through the namespace so the fail-first run on a tree without them reports the missing behaviour, not an import error.
const { migrationLedgerSummary } = ledger;
const MIGRATION_OPT_OUT_KEYS = ledger.MIGRATION_OPT_OUT_KEYS;
const optOut = ledger as Pick<typeof ledger, 'isMigrationDeclinedValue' | 'declinedMigrations'>;
const work = mkdtempSync(join(tmpdir(), 'gbrain-decline-6466-'));
const TEMPLATE = join(work, 'template.pglite');
const homes: string[] = [];

beforeAll(async () => {
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: TEMPLATE });
  await engine.initSchema();
  await engine.disconnect();
}, 180_000);

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function pgliteHome(configValue: string | null): Promise<string> {
  const home = makeHome({ engine: 'pglite' });
  homes.push(home);
  const datastore = join(home, 'brain.pglite');
  cpSync(TEMPLATE, datastore, { recursive: true });
  if (configValue !== null) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: datastore });
    await engine.setConfig(KEY, configValue);
    await engine.disconnect();
  }
  return home;
}

async function run(home: string, opts: SchemaDriverOpts) {
  const result = await collect(spawnDriver(home, writeSchemaDriver(home, opts)));
  const logPath = join(home, 'orchestrator.log');
  return { ...result, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '', out: result.stderr + result.stdout };
}

describe('#6466 shared-skills migration opt-out', () => {
  test('the shared-content migration declares the opt-out key and the registry-free table matches every optOut', () => {
    expect(sharedContentMigration.optOut).toEqual({ key: KEY });
    const fromRegistry = Object.fromEntries(migrations.filter((m) => m.optOut).map((m) => [m.version, m.optOut!.key]));
    expect(MIGRATION_OPT_OUT_KEYS).toEqual(fromRegistry);
  });

  test('apply-migrations --yes skips the declined reconcile re-check and runs the rest', async () => {
    const home = await pgliteHome('false');
    const r = await run(home, { migrations: ['declinable', 'noop'], args: ['--yes', '--non-interactive', '--no-autopilot-install', '--json'] });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran noop\n');
    const doc = parseDocument(r.stdout);
    expect(doc.plan.declined).toEqual(['0.53.0']);
    expect(doc.plan.applied).toEqual([]);
  }, 180_000);

  test('with the key true or absent the re-check runs as before', async () => {
    for (const value of ['true', null]) {
      const home = await pgliteHome(value);
      const r = await run(home, { migrations: ['declinable'], args: ['--yes', '--non-interactive', '--no-autopilot-install'] });
      expect(r.code, r.out).toBe(0);
      expect(r.log).toBe('ran declinable\n');
    }
  }, 180_000);

  test('--list --json reports the migration declined with its key, not as needing action', async () => {
    const home = await pgliteHome('false');
    const r = await run(home, { migrations: ['declinable'], args: ['--list', '--json'] });
    expect(r.code, r.out).toBe(0);
    const doc = parseDocument(r.stdout);
    expect(doc.migrations).toEqual([{ version: '0.53.0', status: 'declined', headline: 'schema exit probe declinable', opt_out: { key: KEY } }]);
    expect(doc.needs_action).toBe(0);
    expect(r.log).toBe('');
    const human = await run(home, { migrations: ['declinable'], args: ['--list'] });
    expect(human.code, human.out).toBe(0);
    expect(human.stdout).toMatch(/declined\s+0\.53\.0/);
    expect(human.stdout).toContain(KEY);
  }, 180_000);

  test('an explicit --migration 0.53.0 refuses with exit 3 migration_declined and writes nothing', async () => {
    const home = await pgliteHome('false');
    const r = await run(home, { migrations: ['declinable'], args: ['--migration', '0.53.0', '--yes', '--json'] });
    expect(r.code, r.out).toBe(3);
    expect(r.log).toBe('');
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('migration_declined');
    expect(doc.class).toBe('consent');
    expect(doc.fix.next).toBe('ask_user');
    expect(doc.fix.argv).toEqual(['gbrain', 'config', 'set', KEY, 'true']);
    expect(doc.fix.verify.argv).toEqual(['gbrain', 'apply-migrations', '--list', '--json']);
    expect(doc.message).toContain(KEY);
    const dry = await run(home, { migrations: ['declinable'], args: ['--migration', '0.53.0', '--dry-run'] });
    expect(dry.code, dry.out).toBe(0);
    expect(dry.stdout).toContain('Declined');
    expect(dry.log).toBe('');
  }, 180_000);
});

describe('#6466 declined migrations in doctor and the ledger summary', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('isMigrationDeclinedValue accepts only explicit off values', () => {
    for (const v of ['false', '0', 'off', 'no', ' False ']) expect(optOut.isMigrationDeclinedValue(v)).toBe(true);
    for (const v of ['true', '1', 'on', '', 'maybe', null, undefined]) expect(optOut.isMigrationDeclinedValue(v)).toBe(false);
  });

  test('declinedMigrations reads the real registry from the brain config', async () => {
    expect([...await optOut.declinedMigrations(engine)]).toEqual([]);
    await engine.setConfig(KEY, 'false');
    expect([...await optOut.declinedMigrations(engine)]).toEqual(['0.53.0']);
    await engine.setConfig(KEY, 'true');
    expect([...await optOut.declinedMigrations(engine)]).toEqual([]);
  });

  test('migrationLedgerSummary lists a declined version as declined, never pending', () => {
    const plain = migrationLedgerSummary(VERSION);
    const declined = migrationLedgerSummary(VERSION, new Set(['0.53.0']));
    expect(declined.declined).toEqual(['0.53.0']);
    expect(declined.pending).not.toContain('0.53.0');
    expect(declined.pending_fresh_install).not.toContain('0.53.0');
    expect(declined.partial).not.toContain('0.53.0');
    expect(plain.declined).toEqual([]);
  });

  test('doctor minions_migration reports the declined migration as ok with its key', async () => {
    await engine.setConfig(KEY, 'false');
    const ctx = { engine, progress: { heartbeat() {}, finish() {} }, args: [] } as unknown as DoctorContext;
    const checks = await minionsMigrationEntry.run(ctx) as Check[];
    const declined = checks.find((c) => c.name === 'minions_migration' && c.details && 'declined' in (c.details as object));
    expect(declined).toBeDefined();
    expect(declined!.status).toBe('ok');
    expect(declined!.message).toContain('0.53.0');
    expect(declined!.message).toContain(KEY);
    expect((declined!.details as { declined: string[] }).declined).toEqual(['0.53.0']);
    expect(checks.filter((c) => c.name === 'minions_migration' && c.status !== 'ok')).toEqual([]);
  });
});
