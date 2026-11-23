/**
 * Swap eligibility's writer observations on a Postgres primary (src/shadow/writer-observations.ts, eligibility.ts).
 *
 * Protects: on Postgres, a wrapped process notes committed writes once per refresh interval and never for a rolled-back
 * transaction; two processes on two hosts are two writer hosts; concurrent writers from one process do not wait on the
 * observation row; the eligibility SELECT runs on the pool the caller holds and a dropped database leaves the writer
 * fields out with the error code only. Regression it catches: Postgres-only behavior PGLite hides (pool concurrency,
 * real connection errors, timestamptz parameter binding).
 * Stop and restart fail closed: `stop` writes writer_coverage_stopped_at and a continued `start` writer_coverage_restarted_at
 * to state.json, and the eligibility read counts them as an unknown writer path while inside the window and while shadow mode
 * is off, even when the stop's gap row could not be inserted (the gap table was locked). Regression it catches: a stop or
 * restart that reads as clean because its only record was a table row that failed to land or aged out.
 * Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { wrapShadowEngine } from '../../src/shadow/wrapper.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import { WriterObserver } from '../../src/shadow/writer-observations.ts';
import { readWriterEvidence } from '../../src/shadow/writer-observations.ts';
import { WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER } from '../../src/shadow/writer-hooks.ts';
import { buildEligibilityStatus } from '../../src/shadow/eligibility.ts';
import postgres from '#postgres';
import { listHookedTables } from '../../src/shadow/writer-hooks.ts';
import { runEngineShadow } from '../../src/commands/engine-shadow.ts';
import { readShadowState, shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { withEnv } from '../helpers/with-env.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
const dirs: string[] = [];
const observers: WriterObserver[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-writer-elig-pg-'));
  dirs.push(dir);
  return dir;
}

function observer(primary: BrainEngine, dir: string, host: string, app: string): WriterObserver {
  const o = new WriterObserver({ primary, dir, identity: () => ({ hostId: host, applicationName: app, processKind: 'serve', gbrainVersion: 'test' }) });
  observers.push(o);
  return o;
}

async function settle(o: WriterObserver): Promise<void> { while (o.inFlight) await o.inFlight; }

const sink = { counters: newMirrorCounters(), offer: () => undefined, active: () => true };
const put = (e: BrainEngine, slug: string) => e.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' } as never);

d('writer observations on Postgres', () => {
  beforeAll(async () => { assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    for (const o of observers.splice(0)) o.stop();
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('committed writes note one row per process; a rolled-back transaction notes none', async () => {
    const dir = tempDir();
    const o = observer(engine, dir, '11111111-1111-4111-8111-111111111111', 'gbrain serve:10:aaaaaaaa');
    const wrapped = wrapShadowEngine(engine, sink, { sampleRate: 0, onCommittedWrite: () => o.note() });
    await expect(wrapped.transaction(async (tx) => { await put(tx, 'notes/rb'); throw new Error('roll back'); })).rejects.toThrow('roll back');
    await settle(o);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM engine_writer_observations')).toEqual([{ n: 0 }]);
    await Promise.all(Array.from({ length: 8 }, (_, i) => put(wrapped, `notes/p${i}`)));
    await settle(o);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM engine_writer_observations')).toEqual([{ n: 1 }]);
  }, 60_000);

  test('two hosts are two writer hosts; one process on one host is one', async () => {
    const dir = tempDir();
    const a = observer(engine, dir, '11111111-1111-4111-8111-111111111111', 'gbrain serve:10:aaaaaaaa');
    a.note(); await settle(a);
    const one = await buildEligibilityStatus({ dir, state: null, engine, source: { name: 't', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(one.eligibility.writer_hosts_7d).toBe(1);
    const b = observer(engine, dir, '22222222-2222-4222-8222-222222222222', 'gbrain sync:20:bbbbbbbb');
    b.note(); await settle(b);
    const two = await buildEligibilityStatus({ dir, state: null, engine, source: { name: 't', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(two.eligibility.writer_hosts_7d).toBe(2);
  }, 60_000);

  test('a closed pool leaves the writer fields out and reports only the error code', async () => {
    const dir = tempDir();
    const { engine: other, close: closeOther } = await template.clone();
    await closeOther();
    const out = await buildEligibilityStatus({ dir, state: null, engine: other, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect('writer_hosts_7d' in out.eligibility).toBe(false);
    expect(out.eligibility_evidence?.state).toBe('read_failed');
    expect(Object.keys(out.eligibility_evidence ?? {}).sort()).toEqual(['code', 'state']);
    expect(out.eligibility_evidence!.code).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  }, 60_000);

  /** A shadow brain on the clone under a temporary GBRAIN_HOME, with the commands wired to the shared engine. */
  function coverageHarness() {
    const home = tempDir();
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const config = { engine: 'postgres' as const, database_url: url };
    const out: string[] = [];
    const view = new Proxy(engine, { get: (t, p) => (p === 'disconnect' ? async () => undefined : Reflect.get(t, p, t)) });
    const make = () => ({ config: () => config, out: (l: string) => out.push(l), err: (l: string) => out.push(l), openPrimary: async () => view as never, loadAddon: async () => ({ ok: true }) as never, now: () => new Date() });
    const dirOf = () => shadowDirFor(shadowBrainKey(config)!); // after GBRAIN_HOME is set: the directory follows it
    const unknown = async () => {
      const dir = dirOf();
      const doc = await buildEligibilityStatus({ dir, state: readShadowState(dir), engine, source: { name: 'none', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => null });
      return doc.eligibility.unknown_writer_paths!;
    };
    return { home, out, make, dirOf, unknown };
  }

  test('the state file records the stop and the restart, and each makes the eligibility read count an unknown path', async () => {
    const { home, out, make, dirOf, unknown } = coverageHarness();
    await withEnv({ GBRAIN_HOME: home }, async () => {
      expect(await runEngineShadow(['start', '--plan'], make())).toBe(0);
      const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
      expect(readShadowState(dirOf())?.writer_coverage_restarted_at).toBeUndefined();
      expect(await unknown()).toBe(0);
      // An enabled restart continues the epoch.
      expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
      expect(readShadowState(dirOf())?.writer_coverage_restarted_at).toBeDefined();
      expect(await unknown()).toBeGreaterThanOrEqual(1);
      // A stop records its time, and a stopped shadow counts for as long as it is stopped.
      expect(await runEngineShadow(['stop'], make())).toBe(0);
      const stopped = readShadowState(dirOf())!;
      expect([stopped.enabled, typeof stopped.writer_coverage_stopped_at]).toEqual([false, 'string']);
      expect(await unknown()).toBeGreaterThanOrEqual(1);
    });
  }, 90_000);

  test('a stop whose gap insert cannot land still refuses after the restart: the stop time is in the state file, not only in a table', async () => {
    const { home, out, make, unknown } = coverageHarness();
    const locker = postgres((engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl, { max: 1, onnotice: () => undefined, prepare: false });
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await runEngineShadow(['start', '--plan'], make())).toBe(0);
        const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
        expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        let granted!: () => void;
        const ready = new Promise<void>((r) => { granted = r; });
        const locked = locker.begin(async (t) => { await t`LOCK TABLE engine_writer_coverage_gaps IN ACCESS EXCLUSIVE MODE`; granted(); await held; });
        await ready;
        // The removal's gap insert times out under the lock and is swallowed: the hooks come off with no gap row.
        expect(await runEngineShadow(['stop'], make())).toBe(0);
        release();
        await locked.catch(() => undefined);
        expect((await listHookedTables(engine)).length).toBe(0);
        expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_coverage_gaps`))[0]!.n).toBe(0);
        expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
        expect(await unknown()).toBeGreaterThanOrEqual(1);
        await runEngineShadow(['stop'], make());
      });
    } finally { await locker.end({ timeout: 5 }).catch(() => undefined); }
  }, 90_000);

  test('a state file without primary_engine cannot switch the Postgres writer checks off: an unclaimed session still refuses', async () => {
    const dir = tempDir();
    const { installWriterHooks } = await import('../../src/shadow/writer-hooks.ts');
    await installWriterHooks(engine, dir);
    const a = observer(engine, dir, '11111111-1111-4111-8111-111111111111', 'gbrain serve:10:aaaaaaaa');
    a.note(); await settle(a);
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const other = postgres(url, { max: 1, onnotice: () => undefined, prepare: false, connection: { application_name: 'psql' } });
    try { await other`INSERT INTO config (key, value) VALUES ('hooks-no-primary-engine', '1') ON CONFLICT (key) DO NOTHING`; } finally { await other.end({ timeout: 5 }).catch(() => undefined); }
    const base = { version: 1, enabled: true, started_at: new Date(Date.now() - 3_600_000).toISOString(), sample_rate: 1, queue_bound: 8, plan_hash: 'h', brain: 'b' };
    const read = async (state: unknown) => (await buildEligibilityStatus({ dir, state: state as never, engine, source: { name: 't', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' })).eligibility.unknown_writer_paths!;
    // With the field present, the unclaimed session is an unresolved writer; with it missing, the open engine still decides.
    const withField = await read({ ...base, primary_engine: 'postgres' });
    const without = await read(base);
    expect(withField).toBeGreaterThanOrEqual(1);
    expect(without).toBeGreaterThanOrEqual(withField + 1);
  }, 60_000);

  test('a restart killed after the hooks changed still counts: the marker is written before any hook is touched', async () => {
    const { home, out, make, dirOf, unknown } = coverageHarness();
    const other = postgres((engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl, { max: 1, onnotice: () => undefined, prepare: false, connection: { application_name: 'psql' } });
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await runEngineShadow(['start', '--plan'], make())).toBe(0);
        const planHash = out.find(l => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
        expect(await runEngineShadow(['start', '--yes', '--expect', planHash], make())).toBe(0);
        expect(await unknown()).toBe(0);
        // A hook is lost while shadow mode is on, and a writer nobody claims commits through that table.
        await engine.executeRaw('DROP TRIGGER gbrain_writer_note ON config');
        await other`INSERT INTO config (key, value) VALUES ('hooks-killed-restart', '1') ON CONFLICT (key) DO NOTHING`;
        // The restart repairs the hook and is killed before it publishes its state.
        await expect(runEngineShadow(['start', '--yes', '--expect', planHash], { ...make(), afterHooks: () => { throw new Error('killed'); } })).rejects.toThrow('killed');
        expect((await listHookedTables(engine)).length).toBeGreaterThan(0);
        expect(readShadowState(dirOf())?.writer_coverage_restarted_at).toBeDefined();
        expect(await unknown()).toBeGreaterThanOrEqual(1);
      });
    } finally { await other.end({ timeout: 5 }).catch(() => undefined); }
  }, 90_000);

  test('the trigger never waits on an evidence lock, even for a writer with a 10 ms statement timeout: the write commits and a gap row records it', async () => {
    const dir = tempDir();
    const { installWriterHooks } = await import('../../src/shadow/writer-hooks.ts');
    await installWriterHooks(engine, dir);
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const locker = postgres(url, { max: 1, onnotice: () => undefined, prepare: false });
    const writer = postgres(url, { max: 1, onnotice: () => undefined, prepare: false, connection: { application_name: 'gbrain cli:930:abcdef30', statement_timeout: 10 } });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let granted!: () => void;
      const ready = new Promise<void>((r) => { granted = r; });
      const locked = locker.begin(async (t) => { await t`LOCK TABLE engine_writer_sessions IN ACCESS EXCLUSIVE MODE`; granted(); await held; });
      await ready;
      const started = Date.now();
      await writer`INSERT INTO config (key, value) VALUES ('hooks-short-deadline', '1') ON CONFLICT (key) DO NOTHING`;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-short-deadline'`))[0]!.n).toBe(1);
      release();
      await locked.catch(() => undefined);
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_coverage_gaps`))[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await writer.end({ timeout: 5 }).catch(() => undefined);
      await locker.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 60_000);

  test('an uncommitted row with the writer\'s exact session key cannot cancel a short-deadline write: the trigger has no uniqueness check to wait on', async () => {
    const dir = tempDir();
    const { installWriterHooks } = await import('../../src/shadow/writer-hooks.ts');
    await installWriterHooks(engine, dir);
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const holder = postgres(url, { max: 1, onnotice: () => undefined, prepare: false });
    const app = 'gbrain cli:931:abcdef31';
    const writer = postgres(url, { max: 1, onnotice: () => undefined, prepare: false, connection: { application_name: app, statement_timeout: 10 } });
    try {
      // The writer's own key, as the trigger will compute it, read on the writer's one connection.
      const [me] = await writer.unsafe(`SELECT coalesce(host(inet_client_addr()), 'local') AS addr, pg_backend_pid() AS pid`);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let inserted!: () => void;
      const ready = new Promise<void>((r) => { inserted = r; });
      const open = holder.begin(async (t) => {
        await t`INSERT INTO engine_writer_sessions (application_name, client_addr, backend_pid) VALUES (${app}, ${me!.addr as string}, ${me!.pid as number})`;
        inserted(); await held;
      });
      await ready;
      const started = Date.now();
      await writer`INSERT INTO config (key, value) VALUES ('hooks-same-key', '1') ON CONFLICT (key) DO NOTHING`;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM config WHERE key = 'hooks-same-key'`))[0]!.n).toBe(1);
      release();
      await open;
      // Both rows are committed now: the same connection is one session, and the write left evidence.
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM engine_writer_sessions WHERE application_name = $1`, [app]))[0]!.n).toBe(2);
      const ev = await readWriterEvidence(engine, new Date(Date.now() - 3_600_000), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
      expect(ev.unresolved).toBe(1);
    } finally {
      await writer.end({ timeout: 5 }).catch(() => undefined);
      await holder.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 60_000);

  test('repeated session rows count as one session, and a refresh updates every matching row', async () => {
    const dir = tempDir();
    const { installWriterHooks } = await import('../../src/shadow/writer-hooks.ts');
    await installWriterHooks(engine, dir);
    const url = (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
    const app = 'gbrain cli:932:abcdef32';
    const writer = postgres(url, { max: 1, onnotice: () => undefined, prepare: false, connection: { application_name: app } });
    try {
      await writer`INSERT INTO config (key, value) VALUES ('hooks-dup-1', '1') ON CONFLICT (key) DO NOTHING`;
      // A second identical row (a restore, a race) ages together with the first.
      await engine.executeRaw(`INSERT INTO engine_writer_sessions (application_name, client_addr, backend_pid, first_seen, last_seen)
        SELECT application_name, client_addr, backend_pid, first_seen, last_seen FROM engine_writer_sessions WHERE application_name = $1`, [app]);
      await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = clock_timestamp() - interval '11 minutes' WHERE application_name = $1`, [app]);
      const read = () => readWriterEvidence(engine, new Date(Date.now() - 3_600_000), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
      expect((await read()).unresolved).toBe(1);
      await writer`UPDATE config SET value = '2' WHERE key = 'hooks-dup-1'`;
      const rows = await engine.executeRaw<{ age: number }>(`SELECT extract(epoch FROM clock_timestamp() - last_seen)::int AS age FROM engine_writer_sessions WHERE application_name = $1`, [app]);
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.age < 60)).toBe(true);
      expect((await read()).unresolved).toBe(1);
    } finally { await writer.end({ timeout: 5 }).catch(() => undefined); }
  }, 60_000);
});
