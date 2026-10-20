/**
 * #6796: v0.53.0 records its checkpoint `complete` with
 * `apply_migrations_pending` on every run, because member enrollment and
 * native activation are never verified. `apply-migrations --list` and doctor
 * must report `applied_pending_host_work` only when the stored report
 * (`shared_skills.migration.v1`) names real host work (a source's writer or
 * publication stage, or a brain-level pending action), never for the
 * "no installation has enrolled" state a fresh brain is in, nor for a source
 * that opted out. Runner cases drive the real apply-migrations in a child
 * process against a stubbed registry (test/helpers/apply-migrations-schema-driver.ts,
 * kind `host_work`) on a PGLite brain whose config carries the report.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { minionsMigrationEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { collect, makeHome, spawnDriver } from './helpers/apply-migrations-lock-driver.ts';
import { parseDocument, writeSchemaDriver } from './helpers/apply-migrations-schema-driver.ts';
import { withEnv } from './helpers/with-env.ts';

const INSPECT = ['gbrain', 'apply-migrations', '--migration', '0.53.0', '--dry-run', '--json'];
const REPORT_KEY = 'shared_skills.migration.v1';
const stage = (name: string, status: string) => ({ stage: name, status, reason: 'fixture' });
const report = (stages: object[], pendingActions: string[] = []) => JSON.stringify({ version: 1, status: 'action_required', pending_actions: pendingActions,
  permission_changes: [], sources: [{ source_id: 'default', stages, status: 'action_required' }] });
const UNENROLLED = report([stage('inventory', 'complete'), stage('ownership', 'complete'), stage('projection', 'complete'), stage('policy', 'complete'), stage('members', 'action_required')]);
const WRITER_NOT_QUIESCED = report([stage('inventory', 'complete'), stage('ownership', 'action_required')]);
const OPTED_OUT = report([stage('projection', 'action_required')]);
const work = mkdtempSync(join(tmpdir(), 'gbrain-host-work-6796-'));
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

async function pgliteHome(stored: string): Promise<string> {
  const home = makeHome({ engine: 'pglite' });
  homes.push(home);
  const datastore = join(home, 'brain.pglite');
  cpSync(TEMPLATE, datastore, { recursive: true });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: datastore });
  await engine.setConfig(REPORT_KEY, stored);
  await engine.disconnect();
  return home;
}

async function list(home: string, json: boolean) {
  const result = await collect(spawnDriver(home, writeSchemaDriver(home, { migrations: ['host_work'], args: json ? ['--list', '--json'] : ['--list'] })));
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

describe('#6796 apply-migrations --list', () => {
  test('a writer stage still open: applied_pending_host_work with the read-only inventory as its fix', async () => {
    const home = await pgliteHome(WRITER_NOT_QUIESCED);
    const doc = parseDocument(await list(home, true));
    expect(doc.migrations).toEqual([{ version: '0.53.0', status: 'applied_pending_host_work', headline: 'schema exit probe host_work' }]);
    expect(doc.applied_pending_host_work).toEqual([{ version: '0.53.0', fix: { argv: INSPECT, command: INSPECT.join(' ') } }]);
    const human = await list(home, false);
    expect(human).toMatch(/applied_pending_host_work\s+0\.53\.0/);
    expect(human).toContain(INSPECT.join(' '));
    expect(human).not.toContain('All migrations up to date');
  }, 180_000);

  test('only unenrolled members (a fresh brain) is applied and up to date', async () => {
    const home = await pgliteHome(UNENROLLED);
    const doc = parseDocument(await list(home, true));
    expect(doc.migrations).toEqual([{ version: '0.53.0', status: 'applied', headline: 'schema exit probe host_work' }]);
    expect(doc.applied_pending_host_work).toBeUndefined();
    expect(await list(home, false)).toContain('All migrations up to date');
  }, 180_000);
});

describe('#6796 doctor minions_migration', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  async function hostWorkChecks(stored: string): Promise<Check[]> {
    await engine.setConfig(REPORT_KEY, stored);
    const home = mkdtempSync(join(work, 'doctor-'));
    const ledgerDir = join(home, '.gbrain', 'migrations');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'completed.jsonl'), JSON.stringify({ version: '0.53.0', status: 'complete', apply_migrations_pending: true }) + '\n');
    const ctx = { engine, progress: { heartbeat() {}, finish() {} }, args: [] } as unknown as DoctorContext;
    return withEnv({ GBRAIN_HOME: home }, async () => (await minionsMigrationEntry.run(ctx) as Check[])
      .filter(c => (c.details as { code?: string } | undefined)?.code === 'migration_host_work_pending'));
  }

  test('warns with the inventory fix while a writer stage or a pending action is open', async () => {
    const [check] = await hostWorkChecks(WRITER_NOT_QUIESCED);
    expect(check).toBeDefined();
    expect(check.name).toBe('minions_migration');
    expect(check.status).toBe('warn');
    expect(check.fix?.argv).toEqual(INSPECT);
    expect((check.details as { applied_pending_host_work: string[] }).applied_pending_host_work).toEqual(['0.53.0']);
    expect(await hostWorkChecks(report([stage('members', 'action_required')], ['Host-global catalog assignment is pending.']))).toHaveLength(1);
  });

  test('quiet for unenrolled members, an opted-out source and a declined migration', async () => {
    expect(await hostWorkChecks(UNENROLLED)).toEqual([]);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"shared_skills": false}'::jsonb WHERE id = 'default'`);
    expect(await hostWorkChecks(OPTED_OUT)).toEqual([]);
    await engine.executeRaw(`UPDATE sources SET config = config - 'shared_skills' WHERE id = 'default'`);
    expect(await hostWorkChecks(OPTED_OUT)).toHaveLength(1);
    await engine.setConfig('shared_skills.migration.enabled', 'false');
    expect(await hostWorkChecks(WRITER_NOT_QUIESCED)).toEqual([]);
  });
});
