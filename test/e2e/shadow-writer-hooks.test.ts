/**
 * Writer hooks on a Postgres primary (src/shadow/writer-hooks.ts, gbrain_note_writer() from migration v332).
 *
 * Protects: start hooks every brain table and stop removes every hook, including hooks a killed start or a crashed
 * stop left; a write from a connection no gbrain process claims (another machine, psql) is counted as an unknown
 * writer path even after it disconnects or a later claimed write overwrites the same row; the trigger never fails or
 * blocks the writer (a broken evidence table becomes a gap row, a broken gap table only a warning); a table added
 * later and a role that cannot record evidence are counted; the start plan declares the hooks.
 * Regression it catches: the unseen-second-host hole the plan review found in process-only observations, a trigger
 * that aborts or waits on a user write, and orphan triggers after a crash. Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import {
  ensureWriterHooks, installWriterHooks, listHookedTables, readWriterHooksManifest, removeWriterHooks, WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER,
} from '../../src/shadow/writer-hooks.ts';
import { readWriterEvidence, WriterObserver } from '../../src/shadow/writer-observations.ts';
import { runEngineShadow, shadowPlan } from '../../src/commands/engine-shadow.ts';
import { withEnv } from '../helpers/with-env.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
const dirs: string[] = [];
const sockets: Array<ReturnType<typeof postgres>> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-writer-hooks-pg-'));
  dirs.push(dir);
  return dir;
}

/** A plain connection to the clone with its own application_name (a psql or another machine's writer). */
function connection(applicationName: string): ReturnType<typeof postgres> {
  const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
  const sql = postgres(url, { max: 1, connection: { application_name: applicationName }, onnotice: () => undefined });
  sockets.push(sql);
  return sql;
}

async function evidence() {
  return readWriterEvidence(engine, new Date(Date.now() - 3_600_000), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
}

async function brainTableCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND c.relname::text <> ALL($1::text[])`, [[...WRITER_EVIDENCE_TABLES]]);
  return row!.n;
}

d('writer hooks on Postgres', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    for (const s of sockets.splice(0)) await s.end({ timeout: 5 }).catch(() => undefined);
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('install hooks every brain table but not the evidence tables; remove drops them all', async () => {
    const dir = tempDir();
    const tables = await installWriterHooks(engine, dir);
    expect(tables.length).toBe(await brainTableCount());
    expect(tables.length).toBeGreaterThan(50);
    expect(tables.some(t => WRITER_EVIDENCE_TABLES.includes(t))).toBe(false);
    expect((await listHookedTables(engine)).length).toBe(tables.length);
    expect(readWriterHooksManifest(dir)?.state).toBe('installed');
    expect((await evidence()).unhooked).toBe(0);
    expect(await removeWriterHooks(engine, dir)).toBe(tables.length);
    expect(await listHookedTables(engine)).toEqual([]);
    expect(existsSync(join(dir, 'writer-hooks.json'))).toBe(false);
  }, 60_000);

  test('a killed start leaves nothing hooked (one transaction); leftovers after a crash are removed by the next remove', async () => {
    const dir = tempDir();
    await expect(installWriterHooks(engine, dir, { afterTable: (_t, i) => { if (i === 3) throw new Error('killed'); } })).rejects.toThrow('killed');
    expect(readWriterHooksManifest(dir)?.state).toBe('installing');
    expect(await listHookedTables(engine)).toEqual([]);
    // A crash after the commit and before the shadow turned on: hooks exist with no shadow running.
    await installWriterHooks(engine, dir);
    rmSync(join(dir, 'writer-hooks.json'), { force: true });
    expect((await listHookedTables(engine)).length).toBeGreaterThan(0);
    await removeWriterHooks(engine, dir);
    expect(await listHookedTables(engine)).toEqual([]);
  }, 60_000);

  test('an unclaimed writer counts as unknown even after it disconnects; a claimed one does not', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const other = connection('psql');
    await other`INSERT INTO config (key, value) VALUES ('hooks-test', 'a') ON CONFLICT (key) DO UPDATE SET value = 'a'`;
    await other.end({ timeout: 5 });
    sockets.splice(sockets.indexOf(other), 1);
    // A later claimed write to the same row leaves the final state equal; the hook already saw the other writer.
    const claimed = connection('gbrain cli:777:abcdef77');
    await claimed`UPDATE config SET value = 'b' WHERE key = 'hooks-test'`;
    const o = new WriterObserver({ primary: engine, dir, identity: () => ({ hostId: '11111111-1111-4111-8111-111111111111', applicationName: 'gbrain cli:777:abcdef77', processKind: 'cli', gbrainVersion: 'test' }) });
    o.note();
    while (o.inFlight) await o.inFlight;
    o.stop();
    const ev = await evidence();
    expect(ev.hosts).toBe(1);
    expect(ev.unresolved).toBe(1);
  }, 60_000);

  test('the trigger never fails the write: a broken evidence table becomes a gap row, a broken gap table only a warning', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const writer = connection('gbrain cli:778:abcdef78');
    await engine.executeRaw('ALTER TABLE engine_writer_sessions RENAME TO engine_writer_sessions_moved');
    try {
      await writer`INSERT INTO config (key, value) VALUES ('hooks-gap', '1') ON CONFLICT (key) DO NOTHING`;
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_coverage_gaps`))[0]!.n).toBe(1);
      await engine.executeRaw('ALTER TABLE engine_writer_coverage_gaps RENAME TO engine_writer_coverage_gaps_moved');
      try {
        await writer`UPDATE config SET value = '2' WHERE key = 'hooks-gap'`;
      } finally {
        await engine.executeRaw('ALTER TABLE engine_writer_coverage_gaps_moved RENAME TO engine_writer_coverage_gaps');
      }
    } finally {
      await engine.executeRaw('ALTER TABLE engine_writer_sessions_moved RENAME TO engine_writer_sessions');
    }
    expect((await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'hooks-gap'`))[0]!.value).toBe('2');
    expect((await evidence()).gaps).toBe(1);
  }, 60_000);

  test('the trigger never waits: a writer in an open transaction does not block another connection of the same process', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const a = connection('gbrain serve:779:abcdef79');
    const b = connection('gbrain serve:779:abcdef79');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const tx = a.begin(async (t) => { await t`INSERT INTO config (key, value) VALUES ('hooks-a', '1')`; await held; });
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await b`INSERT INTO config (key, value) VALUES ('hooks-b', '1')`;
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await tx;
  }, 60_000);

  test('a table added later counts until it is hooked, and hooking it leaves a gap row', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    await engine.executeRaw('CREATE TABLE hooks_late_table (id int)');
    expect((await evidence()).unhooked).toBe(1);
    expect(await ensureWriterHooks(engine)).toEqual(['hooks_late_table']);
    const ev = await evidence();
    expect(ev.unhooked).toBe(0);
    expect(ev.gaps).toBe(1);
  }, 60_000);

  test('a login role that can write brain tables but cannot record evidence is counted; built-in group roles are not', async () => {
    expect((await evidence()).uncovered_roles).toBe(0);
    const role = `hooks_role_${process.pid}_${Date.now() % 100000}`;
    const baseline = (await evidence()).uncovered_roles;
    await engine.executeRaw(`CREATE ROLE ${role} LOGIN`);
    try {
      await engine.executeRaw(`GRANT INSERT ON config TO ${role}`);
      expect((await evidence()).uncovered_roles).toBe(baseline + 1);
      // Rights on the gap table are not enough while row security applies to the role.
      await engine.executeRaw(`GRANT INSERT ON engine_writer_coverage_gaps TO ${role}`);
      const [rls] = await engine.executeRaw<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'engine_writer_coverage_gaps'`);
      expect((await evidence()).uncovered_roles).toBe(rls!.on ? baseline + 1 : baseline);
      await engine.executeRaw(`ALTER ROLE ${role} BYPASSRLS`);
      expect((await evidence()).uncovered_roles).toBe(baseline);
    } finally {
      await engine.executeRaw(`REVOKE ALL ON config FROM ${role}`).catch(() => undefined);
      await engine.executeRaw(`REVOKE ALL ON engine_writer_coverage_gaps FROM ${role}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE ${role}`).catch(() => undefined);
    }
  }, 60_000);

  test('start --yes hooks the tables before turning on; stop removes them; stop with the database down exits 1 and says so', async () => {
    const home = tempDir();
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const config = { engine: 'postgres' as const, database_url: url };
    const out: string[] = [];
    const err: string[] = [];
    const deps = { config: () => config, out: (l: string) => out.push(l), err: (l: string) => err.push(l), openPrimary: async () => engine, loadAddon: async () => ({ ok: true }) as never };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      expect(await runEngineShadow(['start', '--plan'], deps)).toBe(0);
      const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
      expect(out.join('\n')).toContain('gbrain_writer_note');
      // The shared engine must survive the command's disconnect: hand it a view whose disconnect does nothing.
      const view = new Proxy(engine, { get: (t, p) => (p === 'disconnect' ? async () => undefined : Reflect.get(t, p, t)) });
      const keep = { ...deps, openPrimary: async () => view as never };
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], keep)).toBe(0);
      expect((await listHookedTables(engine)).length).toBe(await brainTableCount());
      expect(await runEngineShadow(['stop'], { ...keep, openPrimary: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } })).toBe(1);
      expect(err.join('\n')).toContain('writer_hooks_left (ECONNREFUSED)');
      expect((await listHookedTables(engine)).length).toBeGreaterThan(0);
      expect(await runEngineShadow(['stop'], keep)).toBe(0);
      expect(await listHookedTables(engine)).toEqual([]);
    });
  }, 60_000);

  test('the start plan declares the hooks on Postgres and not on PGLite', () => {
    expect(shadowPlan('k', 'postgres', '/d', { sampleRate: 0.1, queueBound: 256 }).plan.writes.some(w => w.includes('gbrain_writer_note'))).toBe(true);
    expect(shadowPlan('k', 'pglite', '/d', { sampleRate: 0.1, queueBound: 256 }).plan.writes.some(w => w.includes('gbrain_writer_note'))).toBe(false);
  });
});
