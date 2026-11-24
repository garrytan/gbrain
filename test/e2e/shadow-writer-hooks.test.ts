/**
 * Writer hooks on a Postgres primary (src/shadow/writer-hooks.ts, gbrain_note_writer() from migration v332).
 *
 * Protects: start hooks every brain table and stop removes every hook, including hooks a killed start or a crashed
 * stop left; a write from a connection no gbrain process claims (another machine, psql) is counted as an unknown
 * writer path even after it disconnects or a later claimed write overwrites the same row; the trigger never fails or
 * blocks the writer (a broken evidence table becomes a gap row, a broken gap table only a warning); a table added
 * later and a role that cannot record evidence are counted; the start plan declares the hooks.
 * Review round 1 (the maintainer's three conditions): nothing but the empty tables exists before `start --yes`, and
 * triggers exist only between start and stop (the install, kill and stop tests); `stop` removes every trigger,
 * including after a crash mid-start and for a process that is still open (the stop tests); a trigger never fails a
 * write and never waits on an evidence table beyond its 50 ms bound (the lock tests); a role counts as covered only
 * with a complete recording route, a hook counts only while it fires for every write, and the trigger stamps the
 * time it ran, not the start of the writer's transaction.
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
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import {
  ensureWriterHooks, installWriterHooks, listHookedTables, readWriterHooksManifest, removeWriterHooks, WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER,
} from '../../src/shadow/writer-hooks.ts';
import { readWriterEvidence, WriterObserver } from '../../src/shadow/writer-observations.ts';
import { runEngineShadow, shadowPlan } from '../../src/commands/engine-shadow.ts';
import { attachShadowParts } from '../../src/shadow/attach.ts';
import { SHADOW_STATE_VERSION, writeShadowState, type ShadowState } from '../../src/shadow/state.ts';
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
  beforeAll(async () => { assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
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
    expect(await ensureWriterHooks(engine, dir)).toEqual(['hooks_late_table']);
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

  /** A throwaway LOGIN role with a password, and a connection as that role. */
  async function roleConnection(grants: string[], bypass: boolean, noInherit = false): Promise<{ sql: ReturnType<typeof postgres>; role: string; drop: () => Promise<void> }> {
    const role = `hooks_r_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await engine.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD 'pw-${role}'${bypass ? ' BYPASSRLS' : ''}${noInherit ? ' NOINHERIT' : ''}`);
    for (const g of grants) await engine.executeRaw(g.replace(/\$ROLE/g, role));
    const url = new URL((engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl);
    const phrase = `pw-${role}`; // the throwaway role's login phrase, built from its own name
    url.username = role;
    Object.assign(url, { password: phrase });
    const sql = postgres(url.toString(), { max: 1, connection: { application_name: `gbrain cli:900:${role.slice(-8)}` }, onnotice: () => undefined });
    sockets.push(sql);
    return {
      sql, role,
      drop: async () => {
        await sql.end({ timeout: 5 }).catch(() => undefined);
        sockets.splice(sockets.indexOf(sql), 1);
        await engine.executeRaw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => undefined);
        await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      },
    };
  }

  function shadowState(): ShadowState {
    return { version: SHADOW_STATE_VERSION, enabled: true, started_at: new Date().toISOString(), sample_rate: 1, queue_bound: 8, plan_hash: 'x', brain: 'pg-hooks-test', primary_engine: 'postgres' };
  }

  async function observationRows(): Promise<number> {
    return (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_observations`))[0]!.n;
  }

  test('stop ends bookkeeping in a process that is still open: its next write neither notes nor puts the hooks back', async () => {
    const dir = tempDir();
    const state = shadowState();
    await installWriterHooks(engine, dir);
    writeShadowState(dir, state);
    // A resident process that opened the brain while shadow mode was on and has not written yet.
    const resident = attachShadowParts(engine, dir, state);
    // `stop`, from another process: state off, hooks removed, manifest gone.
    writeShadowState(dir, { ...state, enabled: false, stopped_at: new Date().toISOString() });
    await removeWriterHooks(engine, dir);
    expect(await listHookedTables(engine)).toEqual([]);
    await resident.engine.executeRaw(`INSERT INTO config (key, value) VALUES ('after-stop', '1') ON CONFLICT (key) DO NOTHING`);
    while (resident.observer.inFlight) await resident.observer.inFlight;
    expect(await listHookedTables(engine)).toEqual([]);
    expect(await observationRows()).toBe(0);
    // The same resident, once shadow mode is on again (start installed the hooks), notes and keeps the hooks.
    await installWriterHooks(engine, dir);
    writeShadowState(dir, state);
    expect(await ensureWriterHooks(engine, dir)).toEqual([]);
  }, 60_000);

  test('a repair that finds the manifest not `installed` does nothing, so it cannot undo a stop or an install in progress', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    await engine.executeRaw('DROP TRIGGER gbrain_writer_note ON config');
    await removeWriterHooks(engine, dir);
    expect(await ensureWriterHooks(engine, dir)).toEqual([]);
    expect(await listHookedTables(engine)).toEqual([]);
    // Killed start: the manifest says `installing`; a live process still must not hook.
    await expect(installWriterHooks(engine, dir, { afterTable: (_t, i) => { if (i === 2) throw new Error('killed'); } })).rejects.toThrow('killed');
    expect(readWriterHooksManifest(dir)?.state).toBe('installing');
    expect(await ensureWriterHooks(engine, dir)).toEqual([]);
    expect(await listHookedTables(engine)).toEqual([]);
  }, 60_000);

  test('a repair running while stop removes the hooks cannot leave a hook behind', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    await engine.executeRaw('DROP TRIGGER gbrain_writer_note ON config');
    // Run the repair and the removal together, several times, in both start orders; the catalog must end with no hook.
    for (let i = 0; i < 4; i++) {
      await installWriterHooks(engine, dir);
      await engine.executeRaw('DROP TRIGGER gbrain_writer_note ON config');
      const results = await Promise.allSettled(i % 2 === 0
        ? [ensureWriterHooks(engine, dir), removeWriterHooks(engine, dir)]
        : [removeWriterHooks(engine, dir), ensureWriterHooks(engine, dir)]);
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      expect(await listHookedTables(engine)).toEqual([]);
    }
  }, 60_000);

  test('a gap needs no sequence: a restricted login that can only insert a gap row still leaves evidence, and the write commits', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    const gapOnly = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE'], true);
    try {
      // Covered by the gap route: the audit counts the role as able to record.
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
      await gapOnly.sql`INSERT INTO config (key, value) VALUES ('hooks-gap-only', '1')`;
      expect((await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'hooks-gap-only'`))[0]!.value).toBe('1');
      const ev = await evidence();
      expect(ev.gaps).toBe(baseline.gaps + 1);
      expect((await engine.executeRaw<{ code: string; backend_pid: number }>(`SELECT code, backend_pid FROM engine_writer_coverage_gaps ORDER BY created_at DESC LIMIT 1`))[0]!.code).toBe('42501');
    } finally { await gapOnly.drop(); }
  }, 60_000);

  test('a role with only part of a recording route, or only the session route, is uncovered', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    // Session INSERT without SELECT or UPDATE, and no gap right: neither route works.
    const insertOnly = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_sessions TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
      await insertOnly.sql`INSERT INTO config (key, value) VALUES ('hooks-partial-1', '1')`;
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-partial-1'`))[0]!.n).toBe(1);
      const ev = await evidence();
      expect(ev.unresolved).toBe(baseline.unresolved);
      expect(ev.gaps).toBe(baseline.gaps);
    } finally { await insertOnly.drop(); }
    // SELECT and INSERT on sessions but no UPDATE: the first note works, a refresh would not, so still uncovered.
    const noUpdate = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT SELECT, INSERT ON engine_writer_sessions TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
    } finally { await noUpdate.drop(); }
    // The session route alone is not enough: a refresh the trigger skips can only be recorded as a gap, which this role cannot insert.
    const full = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT SELECT, INSERT, UPDATE ON engine_writer_sessions TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
    } finally { await full.drop(); }
    // The gap route is covered.
    const gapRoute = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
    } finally { await gapRoute.drop(); }
  }, 60_000);

  test('a hook that does not fire for every write counts as no hook: disabled, replica-only, wrong events; repair records a gap', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    expect((await evidence()).unhooked).toBe(0);
    const unclaimed = connection('psql');
    for (const [name, sqlText] of [
      ['disabled', 'ALTER TABLE config DISABLE TRIGGER gbrain_writer_note'],
      ['replica-only', 'ALTER TABLE config ENABLE REPLICA TRIGGER gbrain_writer_note'],
      ['wrong events', 'DROP TRIGGER gbrain_writer_note ON config; CREATE TRIGGER gbrain_writer_note AFTER INSERT ON config FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer()'],
      ['always-enabled', 'DROP TRIGGER gbrain_writer_note ON config; CREATE TRIGGER gbrain_writer_note AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON config FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer(); ALTER TABLE config DISABLE TRIGGER gbrain_writer_note; ALTER TABLE config ENABLE ALWAYS TRIGGER gbrain_writer_note'],
    ] as const) {
      await engine.executeRaw(sqlText);
      const broken = name !== 'always-enabled';
      expect([name, (await evidence()).unhooked]).toEqual([name, broken ? 1 : 0]);
      if (broken) {
        // A write from a connection no gbrain process claims: the swap's unknown count must refuse while the hook is broken.
        await unclaimed`INSERT INTO config (key, value) VALUES (${`hooks-${name}`}, '1') ON CONFLICT (key) DO NOTHING`;
        const before = (await evidence()).gaps;
        expect(await ensureWriterHooks(engine, dir)).toEqual(['config']);
        const after = await evidence();
        expect(after.unhooked).toBe(0);
        expect(after.gaps).toBe(before + 1);
      }
    }
    // The disabled hook, written through while disabled, left no session row: only the repair's gap row records the window.
    expect((await listHookedTables(engine)).length).toBe(await brainTableCount());
  }, 60_000);

  test('the trigger never waits on an evidence table: a writer commits within a bound while the table is locked, and a gap row records it', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const locker = connection('gbrain serve:901:abcdef01');
    const writer = connection('gbrain cli:902:abcdef02');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const locked = locker.begin(async (t) => { await t`LOCK TABLE engine_writer_sessions IN ACCESS EXCLUSIVE MODE`; await held; });
    await new Promise((r) => setTimeout(r, 300));
    const baseline = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_coverage_gaps`))[0]!.n;
    const started = Date.now();
    await writer`INSERT INTO config (key, value) VALUES ('hooks-locked', '1') ON CONFLICT (key) DO NOTHING`;
    expect(Date.now() - started).toBeLessThan(1_500);
    // The caller's own settings are untouched by the function's lock_timeout.
    expect((await writer`SHOW lock_timeout`)[0]!.lock_timeout).toBe('0');
    expect((await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'hooks-locked'`))[0]!.value).toBe('1');
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_coverage_gaps`))[0]!.n).toBe(baseline + 1);
    release();
    await locked.catch(() => undefined);
    // Both evidence tables locked, each on its own connection, both locks confirmed granted before the write starts.
    const lockSessions = connection('psql');
    const lockGaps = connection('psql');
    let releaseBoth!: () => void;
    const heldBoth = new Promise<void>((r) => { releaseBoth = r; });
    const heldLock = (table: string): { done: Promise<unknown>; ready: Promise<void> } => {
      let ready!: () => void;
      const granted = new Promise<void>((r) => { ready = r; });
      const sql = table === 'engine_writer_sessions' ? lockSessions : lockGaps;
      const done = sql.begin(async (t) => { await t.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`); ready(); await heldBoth; });
      return { done, ready: granted };
    };
    const one = heldLock('engine_writer_sessions');
    const two = heldLock('engine_writer_coverage_gaps');
    await Promise.all([one.ready, two.ready]);
    const granted = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.mode = 'AccessExclusiveLock' AND l.granted AND c.relname IN ('engine_writer_sessions', 'engine_writer_coverage_gaps')`);
    expect(granted[0]!.n).toBe(2);
    const bothStarted = Date.now();
    await writer`INSERT INTO config (key, value) VALUES ('hooks-locked-both', '1') ON CONFLICT (key) DO NOTHING`;
    expect(Date.now() - bothStarted).toBeLessThan(1_500);
    // The write committed while both locks were still held.
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-locked-both'`))[0]!.n).toBe(1);
    releaseBoth();
    await Promise.all([one.done, two.done]);
  }, 60_000);

  test('a session row held by another transaction is skipped, not waited on, and the skip is a gap; the next write refreshes it once it is free', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const writer = connection('gbrain serve:903:abcdef03');
    const holder = connection('psql');
    await writer`INSERT INTO config (key, value) VALUES ('hooks-row-1', '1') ON CONFLICT (key) DO NOTHING`;
    const age = async (): Promise<number> => (await engine.executeRaw<{ s: number }>(
      `SELECT extract(epoch FROM clock_timestamp() - last_seen)::int AS s FROM engine_writer_sessions WHERE application_name = 'gbrain serve:903:abcdef03'`))[0]!.s;
    await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = clock_timestamp() - interval '11 minutes' WHERE application_name = 'gbrain serve:903:abcdef03'`);
    expect(await age()).toBeGreaterThanOrEqual(660);
    const gapsBefore = (await evidence()).gaps;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const tx = holder.begin(async (t) => { await t`SELECT 1 FROM engine_writer_sessions WHERE application_name = 'gbrain serve:903:abcdef03' FOR UPDATE`; await held; });
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await writer`UPDATE config SET value = '2' WHERE key = 'hooks-row-1'`;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await age()).toBeGreaterThanOrEqual(660);
    // The skipped refresh left this write unrecorded, so it is a gap the swap counts (the write itself committed).
    expect((await evidence()).gaps).toBe(gapsBefore + 1);
    expect((await engine.executeRaw<{ value: string }>(`SELECT value FROM config WHERE key = 'hooks-row-1'`))[0]!.value).toBe('2');
    release();
    await tx;
    await writer`UPDATE config SET value = '3' WHERE key = 'hooks-row-1'`;
    expect(await age()).toBeLessThan(60);
    expect((await evidence()).gaps).toBe(gapsBefore + 1);
  }, 60_000);

  test('the trigger stamps the time it ran, not the start of the writer transaction: a late write in an old transaction is inside the window', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const old = connection('psql');
    let since!: Date;
    await old.begin(async (t) => {
      await t`SELECT 1`;
      await new Promise((r) => setTimeout(r, 1_200));
      since = new Date();
      await new Promise((r) => setTimeout(r, 50));
      await t`INSERT INTO config (key, value) VALUES ('hooks-old-txn', '1') ON CONFLICT (key) DO NOTHING`;
    });
    const ev = await readWriterEvidence(engine, since, true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
    expect(ev.unresolved).toBe(1);
  }, 60_000);

  test('a login granted INSERT on columns only, with no evidence rights, is a writer the audit counts, and its write is unrecorded', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    const columnOnly = await roleConnection(['GRANT INSERT (key, value) ON config TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
      await columnOnly.sql`INSERT INTO config (key, value) VALUES ('hooks-column-only', '1')`;
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-column-only'`))[0]!.n).toBe(1);
      const ev = await evidence();
      expect([ev.unresolved, ev.gaps]).toEqual([baseline.unresolved, baseline.gaps]);
    } finally { await columnOnly.drop(); }
    // UPDATE on one column counts too, and a column grant that comes with a gap route is covered.
    const updateOnly = await roleConnection(['GRANT UPDATE (value) ON config TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
    } finally { await updateOnly.drop(); }
    const covered = await roleConnection(['GRANT INSERT (key, value) ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE'], true);
    try {
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
    } finally { await covered.drop(); }
  }, 60_000);

  test('a NOLOGIN role that a login reaches with SET ROLE is judged as itself: no recording route means uncovered, even for a NOINHERIT member', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const target = `hooks_nl_${suffix}`;
    await engine.executeRaw(`CREATE ROLE ${target} NOLOGIN BYPASSRLS`);
    await engine.executeRaw(`GRANT INSERT, UPDATE ON config TO ${target}`);
    const member = await roleConnection([`GRANT ${target} TO $ROLE`], false, true);
    try {
      // Reachable and writable, no evidence rights: counted (the target role; the NOINHERIT login has no write right of its own).
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
      await member.sql.begin(async (t) => {
        await t.unsafe(`SET LOCAL ROLE ${target}`);
        await t`INSERT INTO config (key, value) VALUES ('hooks-set-role', '1')`;
      });
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-set-role'`))[0]!.n).toBe(1);
      const ev = await evidence();
      expect([ev.unresolved, ev.gaps]).toEqual([baseline.unresolved, baseline.gaps]);
      // Give the target a recording route and it is covered again.
      await engine.executeRaw(`GRANT INSERT ON engine_writer_coverage_gaps TO ${target}`);
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
    } finally {
      await member.drop();
      await engine.executeRaw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${target}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${target}`).catch(() => undefined);
    }
  }, 60_000);

  test('a session-only writer whose refresh is skipped leaves no gap row, so the audit must refuse it: it is uncovered', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    const sessionOnly = await roleConnection(['GRANT INSERT ON config TO $ROLE', 'GRANT SELECT, INSERT, UPDATE ON engine_writer_sessions TO $ROLE'], true);
    const holder = connection('psql');
    try {
      await sessionOnly.sql`INSERT INTO config (key, value) VALUES ('hooks-session-only-1', '1')`;
      await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = clock_timestamp() - interval '11 minutes' WHERE application_name LIKE 'gbrain cli:900:%'`);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const tx = holder.begin(async (t) => { await t`SELECT 1 FROM engine_writer_sessions WHERE application_name LIKE 'gbrain cli:900:%' FOR UPDATE`; await held; });
      await new Promise((r) => setTimeout(r, 200));
      await sessionOnly.sql`INSERT INTO config (key, value) VALUES ('hooks-session-only-2', '1')`;
      release();
      await tx;
      const ev = await evidence();
      // The skipped refresh left no gap row (the role cannot insert one) ...
      expect(ev.gaps).toBe(baseline.gaps);
      // ... so the only thing that keeps criterion 11 honest is the role audit.
      expect(ev.uncovered_roles).toBe(baseline.uncovered_roles + 1);
    } finally { await sessionOnly.drop(); }
  }, 60_000);

  test('a membership with SET FALSE, or a chain with SET off on one edge, is not reachable by SET ROLE (PostgreSQL 16 and newer)', async () => {
    const [v] = await engine.executeRaw<{ n: number }>(`SELECT current_setting('server_version_num')::int AS n`);
    if (v!.n < 160000) return;
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const baseline = await evidence();
    const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const target = `hooks_set_t_${suffix}`;
    const mid = `hooks_set_m_${suffix}`;
    await engine.executeRaw(`CREATE ROLE ${target} NOLOGIN BYPASSRLS`);
    await engine.executeRaw(`GRANT INSERT, UPDATE ON config TO ${target}`);
    await engine.executeRaw(`CREATE ROLE ${mid} NOLOGIN`);
    // The login has a complete route of its own, so it is covered whatever it inherits.
    const login = await roleConnection(['GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE'], true);
    try {
      // INHERIT TRUE, SET FALSE: the login inherits the target's rights (judged as itself) but cannot SET ROLE to it.
      await engine.executeRaw(`GRANT ${target} TO ${login.role} WITH INHERIT TRUE, SET FALSE`);
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
      await expect(login.sql.begin(async (t) => { await t.unsafe(`SET LOCAL ROLE ${target}`); })).rejects.toThrow();
      // A chain login -> mid (SET true) -> target (SET false) is not reachable either.
      await engine.executeRaw(`REVOKE ${target} FROM ${login.role}`);
      await engine.executeRaw(`GRANT ${mid} TO ${login.role} WITH SET TRUE`);
      await engine.executeRaw(`GRANT ${target} TO ${mid} WITH INHERIT FALSE, SET FALSE`);
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles);
      // With SET on the last edge the target is reachable and has no gap route: uncovered.
      await engine.executeRaw(`REVOKE ${target} FROM ${mid}`);
      await engine.executeRaw(`GRANT ${target} TO ${mid} WITH INHERIT FALSE, SET TRUE`);
      expect((await evidence()).uncovered_roles).toBe(baseline.uncovered_roles + 1);
    } finally {
      await login.drop();
      for (const r of [mid, target]) {
        await engine.executeRaw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${r}`).catch(() => undefined);
        await engine.executeRaw(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
      }
    }
  }, 60_000);

  test('restarting shadow mode keeps the evidence epoch: yesterday\'s unclaimed writer still counts, and stop records a gap', async () => {
    const home = tempDir();
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const config = { engine: 'postgres' as const, database_url: url };
    const out: string[] = [];
    const view = new Proxy(engine, { get: (t, p) => (p === 'disconnect' ? async () => undefined : Reflect.get(t, p, t)) });
    const t0 = new Date(Date.now() - 2 * 3_600_000);
    const make = (at: Date) => ({ config: () => config, out: (l: string) => out.push(l), err: (l: string) => out.push(l), openPrimary: async () => view as never, loadAddon: async () => ({ ok: true }) as never, now: () => at });
    await withEnv({ GBRAIN_HOME: home }, async () => {
      expect(await runEngineShadow(['start', '--plan'], make(t0))).toBe(0);
      const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make(t0))).toBe(0);
      const { shadowBrainKey, shadowDirFor, readShadowState } = await import('../../src/shadow/state.ts');
      const dir = shadowDirFor(shadowBrainKey(config)!);
      expect(readShadowState(dir)?.writer_evidence_since).toBe(t0.toISOString());
      // A second host's unclaimed connection writes, then its row ages to an hour ago.
      const other = connection('psql');
      await other`INSERT INTO config (key, value) VALUES ('hooks-epoch', '1') ON CONFLICT (key) DO NOTHING`;
      await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = clock_timestamp() - interval '1 hour'`);
      const { buildEligibilityStatus } = await import('../../src/shadow/eligibility.ts');
      const read = async () => (await buildEligibilityStatus({ dir, state: readShadowState(dir), engine, source: { name: 'none', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => null })).eligibility.unknown_writer_paths;
      const before = (await read())!;
      expect(before).toBeGreaterThanOrEqual(1);
      // Start again now: started_at moves, the epoch does not, and the old second writer still counts.
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make(new Date()))).toBe(0);
      const restarted = readShadowState(dir)!;
      expect(restarted.writer_evidence_since).toBe(t0.toISOString());
      expect(Date.parse(restarted.started_at)).toBeGreaterThan(t0.getTime());
      expect((await read())!).toBeGreaterThanOrEqual(before);
      // Stop, then start: same epoch, and one gap row, recorded by the stop in the transaction that removed the hooks.
      const gapsBefore = (await evidence()).gaps;
      expect(await runEngineShadow(['stop'], make(new Date()))).toBe(0);
      expect((await evidence()).gaps).toBe(gapsBefore + 1);
      expect((await engine.executeRaw<{ code: string }>(`SELECT code FROM engine_writer_coverage_gaps ORDER BY created_at DESC LIMIT 1`))[0]!.code).toBe('hooks_removed');
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make(new Date()))).toBe(0);
      expect(readShadowState(dir)!.writer_evidence_since).toBe(t0.toISOString());
      expect((await evidence()).gaps).toBe(gapsBefore + 1);
      await runEngineShadow(['stop'], make(new Date()));
    });
  }, 60_000);

  test('a restart replaces the hooks in one transaction: writers keep being recorded during it, and a failed install keeps the old hooks', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const total = await brainTableCount();
    const unclaimed = connection('psql');
    // Mid-install, with the new transaction open and not committed, a write from a connection no process claims is still hooked.
    let sawWriter = false;
    await installWriterHooks(engine, dir, {
      afterTable: async (_t, i) => {
        if (i !== 0) return;
        await unclaimed`INSERT INTO config (key, value) VALUES ('hooks-mid-install', '1') ON CONFLICT (key) DO NOTHING`;
        sawWriter = true;
      },
    });
    expect(sawWriter).toBe(true);
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_sessions WHERE application_name = 'psql'`))[0]!.n).toBe(1);
    expect((await listHookedTables(engine)).length).toBe(total);
    // A second install that fails part-way rolls back to the hooks that were there, and the manifest says installed again.
    await expect(installWriterHooks(engine, dir, { afterTable: (_t, i) => { if (i === 3) throw new Error('killed'); } })).rejects.toThrow('killed');
    expect((await listHookedTables(engine)).length).toBe(total);
    expect((await evidence()).unhooked).toBe(0);
    expect(readWriterHooksManifest(dir)?.state).toBe('installed');
    // A restart over a disabled hook leaves every hook effective (or fails whole): never a quietly disabled one.
    await engine.executeRaw('ALTER TABLE config DISABLE TRIGGER gbrain_writer_note');
    expect((await evidence()).unhooked).toBe(1);
    await installWriterHooks(engine, dir);
    expect((await evidence()).unhooked).toBe(0);
  }, 60_000);

  test('a state file from before the epoch fields keeps its start on the first restart (and a stopped one records a gap)', async () => {
    const home = tempDir();
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const config = { engine: 'postgres' as const, database_url: url };
    const out: string[] = [];
    const view = new Proxy(engine, { get: (t, p) => (p === 'disconnect' ? async () => undefined : Reflect.get(t, p, t)) });
    const make = () => ({ config: () => config, out: (l: string) => out.push(l), err: (l: string) => out.push(l), openPrimary: async () => view as never, loadAddon: async () => ({ ok: true }) as never, now: () => new Date() });
    const t0 = new Date(Date.now() - 3 * 3_600_000);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const { shadowBrainKey, shadowDirFor, readShadowState } = await import('../../src/shadow/state.ts');
      const dir = shadowDirFor(shadowBrainKey(config)!);
      expect(await runEngineShadow(['start', '--plan'], make())).toBe(0);
      const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
      const legacy = (enabled: boolean): ShadowState => ({ version: SHADOW_STATE_VERSION, enabled, started_at: t0.toISOString(), sample_rate: 0.1, queue_bound: 256, plan_hash: planHash, brain: 'legacy', primary_engine: 'postgres', ...(enabled ? {} : { stopped_at: new Date().toISOString() }) });
      await installWriterHooks(engine, dir);
      writeShadowState(dir, legacy(true));
      const other = connection('psql');
      await other`INSERT INTO config (key, value) VALUES ('hooks-legacy', '1') ON CONFLICT (key) DO NOTHING`;
      await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = clock_timestamp() - interval '1 hour'`);
      const { buildEligibilityStatus } = await import('../../src/shadow/eligibility.ts');
      const unknown = async () => (await buildEligibilityStatus({ dir, state: readShadowState(dir), engine, source: { name: 'none', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => null })).eligibility.unknown_writer_paths!;
      expect(await unknown()).toBeGreaterThanOrEqual(1);
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
      // The restart adopted the legacy start as the epoch, so the hour-old second writer is still inside the window.
      expect(readShadowState(dir)!.writer_evidence_since).toBe(t0.toISOString());
      expect(await unknown()).toBeGreaterThanOrEqual(1);
      // A stopped legacy state (an older stop recorded no gap) records one at the next start.
      writeShadowState(dir, legacy(false));
      const gapsBefore = (await evidence()).gaps;
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
      expect(readShadowState(dir)!.writer_evidence_since).toBe(t0.toISOString());
      expect((await evidence()).gaps).toBe(gapsBefore + 1);
      await runEngineShadow(['stop'], make());
    });
  }, 60_000);

  test('an expired process claim cannot resolve a current session: the writer stays unresolved', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const hostA = '11111111-1111-4111-8111-111111111111';
    const hostB = '22222222-2222-4222-8222-222222222222';
    // Host A is observed now; host B claimed 'gbrain serve:910:abcdef10' eight days ago and no longer claims anything.
    await engine.executeRaw(`INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version, first_seen, last_seen) VALUES
      ($1, 'gbrain cli:911:abcdef11', 'cli', 'test', now(), now()),
      ($2, 'gbrain serve:910:abcdef10', 'serve', 'test', now() - interval '8 days', now() - interval '8 days')`, [hostA, hostB]);
    const writer = connection('gbrain serve:910:abcdef10');
    await writer`INSERT INTO config (key, value) VALUES ('hooks-expired-claim', '1') ON CONFLICT (key) DO NOTHING`;
    const ev = await readWriterEvidence(engine, new Date(Date.now() - 7 * 86_400_000), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
    expect(ev.hosts).toBe(1);
    expect(ev.unresolved).toBe(1);
    // A claim inside the window resolves it.
    await engine.executeRaw(`UPDATE engine_writer_observations SET last_seen = now() WHERE application_name = 'gbrain serve:910:abcdef10'`);
    expect((await readWriterEvidence(engine, new Date(Date.now() - 7 * 86_400_000), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES)).unresolved).toBe(0);
  }, 60_000);

  test('a conditional hook (WHEN false, or UPDATE OF a column list) counts as no hook and is repaired with a gap row', async () => {
    const dir = tempDir();
    await installWriterHooks(engine, dir);
    const unclaimed = connection('psql');
    const ran: string[] = [];
    for (const [name, create] of [
      ['when false', 'AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON config FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION gbrain_note_writer()'],
      ['column list', 'AFTER INSERT OR UPDATE OF value OR DELETE OR TRUNCATE ON config FOR EACH STATEMENT EXECUTE FUNCTION gbrain_note_writer()'],
    ] as const) {
      await engine.executeRaw(`DROP TRIGGER gbrain_writer_note ON config`);
      await engine.executeRaw(`CREATE TRIGGER gbrain_writer_note ${create}`).catch(() => undefined);
      const hooked = await listHookedTables(engine);
      if (!hooked.includes('config')) continue; // the server refused the shape (a column list needs a row-level trigger): nothing to prove
      ran.push(name);
      expect([name, (await evidence()).unhooked]).toEqual([name, 1]);
      await unclaimed`INSERT INTO config (key, value) VALUES (${`hooks-${name}`}, '1') ON CONFLICT (key) DO NOTHING`;
      const before = (await evidence()).gaps;
      expect(await ensureWriterHooks(engine, dir)).toEqual(['config']);
      const after = await evidence();
      expect([name, after.unhooked, after.gaps]).toEqual([name, 0, before + 1]);
    }
    expect(ran).toContain('when false');
  }, 60_000);

  test('the process-side note never holds a serving connection: with its table locked, a second request on a one-connection pool completes promptly', async () => {
    const dir = tempDir();
    const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
    const one = new PostgresEngine();
    await one.connect({ database_url: (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl, poolSize: 1 });
    const locker = connection('psql');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const locked = locker.begin(async (t) => { await t`LOCK TABLE engine_writer_observations IN ACCESS EXCLUSIVE MODE`; await held; });
    await new Promise((r) => setTimeout(r, 300));
    const failures: string[] = [];
    try {
      const o = new WriterObserver({
        primary: one, dir, recordFailure: (c) => failures.push(c),
        identity: () => ({ hostId: '11111111-1111-4111-8111-111111111111', applicationName: 'gbrain cli:920:abcdef20', processKind: 'cli', gbrainVersion: 'test' }),
      });
      o.note();
      const started = Date.now();
      const rows = await one.executeRaw<{ n: number }>('SELECT 1 AS n');
      expect(rows).toEqual([{ n: 1 }]);
      expect(Date.now() - started).toBeLessThan(1_500);
      while (o.inFlight) await o.inFlight;
      expect(failures).toEqual(['55P03']);
      // A busy table is waited out for the refresh interval, not hammered on every write.
      o.note();
      expect(o.inFlight).toBeNull();
      o.stop();
    } finally {
      release();
      await locked.catch(() => undefined);
      await one.disconnect();
    }
  }, 60_000);

  test('start --yes hooks the tables before turning on; stop removes them; stop with the database down exits 1 and says so', async () => {
    const home = tempDir();
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const config = { engine: 'postgres' as const, database_url: url };
    const out: string[] = [];
    const err: string[] = [];
    // The shared engine must survive each command's disconnect (start, even with --plan, opens the brain to read its
    // storage mode): hand every command a view whose disconnect does nothing.
    const view = new Proxy(engine, { get: (t, p) => (p === 'disconnect' ? async () => undefined : Reflect.get(t, p, t)) });
    const deps = { config: () => config, out: (l: string) => out.push(l), err: (l: string) => err.push(l), openPrimary: async () => view as never, loadAddon: async () => ({ ok: true }) as never };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      expect(await runEngineShadow(['start', '--plan'], deps)).toBe(0);
      const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
      expect(out.join('\n')).toContain('gbrain_writer_note');
      const keep = deps;
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
