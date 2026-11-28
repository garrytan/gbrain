/**
 * The seal's change token on a Postgres primary (src/shadow/seal.ts): a seal written at close is confirmed at the next
 * start only when the database shows nothing was written in between, judged from the database's own write counters
 * of the copied relations, not from the evidence rows another writer might never record.
 *
 * Protects: a writer whose evidence row is refreshed but is not the newest row, a role that has no way to record
 * evidence, a write while both evidence tables are locked, a write that was still open (or prepared) when the seal was
 * confirmed, a statistics reset, a TRUNCATE or a dropped-and-recreated relation, a server with track_counts off, and a
 * write that began only after the confirmation, are each refused with a named reason (or revoked after the child took
 * the confirmation). Each test fails on the writer-fingerprint seal for its own reason: it asserts the verdict.
 * Regression it catches: a restart trusted because the recorded evidence did not move while an unrecorded write did.
 * Needs DATABASE_URL; skips without it. The PREPARE TRANSACTION case needs a server with max_prepared_transactions > 0
 * and runs only when GBRAIN_TEST_PREPARED_DATABASE_URL names one (it is listed as skipped otherwise).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { openReadSource, type ReadSource } from '../../src/shadow/read-pool.ts';
import { installWriterHooks } from '../../src/shadow/writer-hooks.ts';
import { confirmSeal, quietSince, sealMark } from '../../src/shadow/seal.ts';
import { SEED_RECORD_VERSION, writeSeedRecord, type SeedRecord } from '../../src/shadow/seed.ts';

const d = hasDatabase() ? describe : describe.skip;
const preparedUrl = process.env.GBRAIN_TEST_PREPARED_DATABASE_URL ?? '';

type Template = Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let template: Template;
let engine: PostgresEngine;
let close: () => Promise<void>;
let dir: string;
let reads: ReadSource;
const dirs: string[] = [];
const sockets: Array<ReturnType<typeof postgres>> = [];
const sources: ReadSource[] = [];

const url = (): string => (engine as unknown as { connectedDatabaseUrl: string }).connectedDatabaseUrl;
const deps = (r: ReadSource = reads) => ({ dir, reads: r, postgres: true as const, primary: engine });

/** A plain connection to the clone with its own application_name (psql, another machine's writer). */
function connection(applicationName: string): ReturnType<typeof postgres> {
  const sql = postgres(url(), { max: 1, connection: { application_name: applicationName }, onnotice: () => undefined });
  sockets.push(sql);
  return sql;
}

const databaseName = async (): Promise<string> => (await engine.executeRaw<{ name: string }>('SELECT current_database()::text AS name'))[0]!.name;

async function backends(app: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()`, [app]);
  return row!.n;
}

/** Ends a connection and waits until its backend is gone (a backend's statistics are flushed when it exits). */
async function finish(sql: ReturnType<typeof postgres>, app: string): Promise<void> {
  await sql.end({ timeout: 5 });
  sockets.splice(sockets.indexOf(sql), 1);
  for (let i = 0; i < 100 && await backends(app) > 0; i++) await new Promise((r) => setTimeout(r, 100));
  expect(await backends(app)).toBe(0);
}

/** A foreign transaction that has inserted a row and holds it open until `release()`. */
async function holdWrite(app: string, key: string): Promise<{ release: () => Promise<void>; sql: ReturnType<typeof postgres> }> {
  const sql = connection(app);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const open = new Promise<void>((r) => { started = r; });
  const tx = sql.begin(async (t) => { await t`INSERT INTO config (key, value) VALUES (${key}, '1') ON CONFLICT (key) DO NOTHING`; started(); await held; });
  await open;
  return { sql, release: async () => { release(); await tx; } };
}

/** The rpc a serving process holds to its follow child: records every call; `onConfirm` runs inside the `confirmSeal` call, `onCommit` inside `commitSeal`. */
function fakeRpc(token: string | null, onConfirm?: (args: Record<string, unknown>) => Promise<void>, onCommit?: () => Promise<void>) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const rpc = (async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === 'state') return { pending_seal: { db_at: token } };
    if (method === 'confirmSeal') await onConfirm?.(args);
    if (method === 'commitSeal') await onCommit?.();
    return {};
  }) as never;
  return { calls, rpc };
}

async function sealed(r: ReadSource = reads): Promise<string> {
  const mark = await sealMark(deps(r));
  expect(mark).toHaveProperty('token');
  return (mark as { token: string }).token;
}

/** A login role (BYPASSRLS when asked, so its write is not stopped by row security) with the given grants and no route to record evidence; dropped with its privileges. */
async function throwawayRole(grants: string[], bypassRls = false, attributes = ''): Promise<{ role: string; connect: (app: string) => ReturnType<typeof postgres>; drop: () => Promise<void> }> {
  const role = `seal_tok_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const phrase = ['gbtest', role].join('_'); // the throwaway role's login phrase, built from its own name
  await engine.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD '${phrase}'${bypassRls ? ' BYPASSRLS' : ''}${attributes ? ` ${attributes}` : ''}`);
  for (const g of grants) await engine.executeRaw(g.replace(/\$ROLE/g, role));
  return {
    role,
    connect: (app) => {
      const u = new URL(url());
      u.username = role;
      Object.assign(u, { password: phrase });
      const sql = postgres(u.toString(), { max: 1, connection: { application_name: app }, onnotice: () => undefined });
      sockets.push(sql);
      return sql;
    },
    drop: async () => {
      await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    },
  };
}

/** Everything a brain needs for a seal check: a probe relation, installed hooks, and a seed record that names the relations the seed copied. */
async function prepare(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-seal-token-'));
  dirs.push(dir);
  await engine.executeRaw('CREATE TABLE seal_probe_rel (id int PRIMARY KEY)');
  await installWriterHooks(engine, dir);
  const present = new Set((await engine.executeRaw<{ name: string }>(`SELECT relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'`)).map((r) => r.name));
  const relations: SeedRecord['relations'] = {};
  for (const name of ['sources', 'config', 'pages', 'seal_probe_rel', 'relation_from_an_older_schema']) {
    relations[name] = present.has(name) ? { rows_read: 0, imported: 0, skipped: 0, dropped: 0, unmapped_columns: [] } : { rows_read: 0, imported: 0, skipped: 0, dropped: 0, unmapped_columns: [], absent: true };
  }
  writeSeedRecord(dir, { version: SEED_RECORD_VERSION, seed_id: 'seed-token', started_at: 'x', finished_at: 'x', primary_engine: 'postgres', relations, losses: { values: {}, not_copied: [], gaps: {} }, unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0, digests: true });
  reads = openReadSource(engine);
  sources.push(reads);
}

const teardown = async (): Promise<void> => {
  for (const s of sockets.splice(0)) await s.end({ timeout: 5 }).catch(() => undefined);
  for (const r of sources.splice(0)) await r.close().catch(() => undefined);
  await close();
  for (const x of dirs.splice(0)) rmSync(x, { recursive: true, force: true });
};

d('the seal change token on Postgres', () => {
  beforeAll(async () => { assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!); template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); await prepare(); }, 60_000);
  afterEach(teardown, 60_000);

  test('control: nothing changed, the seal is confirmed and no revoke follows', async () => {
    const token = await sealed();
    expect(await quietSince(deps(), token)).toEqual({ ok: true });
    const { calls, rpc } = fakeRpc(token);
    await confirmSeal({ ...deps(), rpc });
    // The commit is sent only after the second read was quiet too.
    expect(calls.map((c) => c.method)).toEqual(['state', 'confirmSeal', 'commitSeal']);
    expect(calls[1]!.args).toEqual({ db_at: token, ok: true, reason: null });
    expect(calls[2]!.args).toEqual({ db_at: token });
  }, 60_000);

  test('a commit the child does not acknowledge is revoked (seal_commit_unacknowledged): a lost answer does not prove it was not applied', async () => {
    const token = await sealed();
    const { calls, rpc } = fakeRpc(token, undefined, async () => { throw new Error('timeout'); });
    expect(await confirmSeal({ ...deps(), rpc, revokeRetryMs: [0] })).toEqual({ doubt: null });
    expect(calls.map((c) => c.method)).toEqual(['state', 'confirmSeal', 'commitSeal', 'revokeSeal']);
    expect(calls[3]!.args).toEqual({ reason: 'seal_commit_unacknowledged' });
  }, 60_000);

  test('a writer that is still connected is refused at the seal, though its session row is old and not the newest', async () => {
    const app = 'psql-writer-s4';
    const w = connection(app);
    await w`INSERT INTO config (key, value) VALUES ('s4', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`;
    await engine.executeRaw(`UPDATE engine_writer_sessions SET last_seen = now() - interval '20 minutes' WHERE application_name = $1`, [app]);
    await engine.executeRaw(`INSERT INTO engine_writer_sessions (application_name, client_addr, backend_pid, last_seen) VALUES ('psql-ghost-s4', 'local', 0, now() + interval '1 hour')`);
    expect(await sealMark(deps())).toEqual({ refused: 'other_writer_live' });
    await finish(w, app);
  }, 60_000);

  test('a role with no way to record evidence is refused at the seal', async () => {
    const r = await throwawayRole(['GRANT INSERT ON config TO $ROLE'], true);
    try {
      expect(await sealMark(deps())).toEqual({ refused: 'uncovered_writer_role' });
    } finally { await r.drop(); }
  }, 60_000);

  test('a write by a role that appeared after the seal and is gone again is caught by the counters', async () => {
    const token = await sealed();
    const r = await throwawayRole(['GRANT INSERT ON config TO $ROLE'], true);
    const app = 'psql-role-writer';
    try {
      const sql = r.connect(app);
      await sql`INSERT INTO config (key, value) VALUES ('role-write', '1')`;
      await finish(sql, app);
    } finally { await r.drop(); }
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'writes_since_seal' });
  }, 60_000);

  /** Both evidence tables locked (each on its own connection), a foreign write commits unrecorded; the locks are released. */
  async function unrecordedWrite(app: string): Promise<ReturnType<typeof postgres>> {
    const writer = connection(app);
    const lockers = ['psql-lock-sessions', 'psql-lock-gaps'].map((a) => ({ app: a, sql: connection(a) }));
    let releaseAll!: () => void;
    const held = new Promise<void>((r) => { releaseAll = r; });
    const tables = ['engine_writer_sessions', 'engine_writer_coverage_gaps'];
    const ready = lockers.map(({ sql }, i) => new Promise<void>((resolve) => {
      sql.begin(async (t) => { await t.unsafe(`LOCK TABLE ${tables[i]} IN ACCESS EXCLUSIVE MODE`); resolve(); await held; }).catch(() => undefined);
    }));
    await Promise.all(ready);
    const [granted] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.mode = 'AccessExclusiveLock' AND l.granted AND c.relname = ANY($1)`, [tables]);
    expect(granted!.n).toBe(2);
    await writer`INSERT INTO config (key, value) VALUES ('unrecorded', '1') ON CONFLICT (key) DO NOTHING`;
    releaseAll();
    for (const l of lockers) await finish(l.sql, l.app);
    return writer;
  }

  test('a write that no evidence table recorded (both locked), from a writer that has disconnected, is caught by the counters', async () => {
    const token = await sealed();
    const writer = await unrecordedWrite('psql-writer-s5b');
    await finish(writer, 'psql-writer-s5b');
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'writes_since_seal' });
  }, 60_000);

  test('the same write from a writer that is still connected is refused too: its statistics may not be flushed yet', async () => {
    const token = await sealed();
    const writer = await unrecordedWrite('psql-writer-s5c');
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'other_backend_recent' });
    await finish(writer, 'psql-writer-s5c');
  }, 60_000);

  test('a write still open while the quiet check runs is refused, and the seal is never confirmed on it', async () => {
    const token = await sealed();
    const open = await holdWrite('psql-writer-s6', 's6');
    const { calls, rpc } = fakeRpc(token, async () => { await open.release(); });
    try {
      await confirmSeal({ ...deps(), rpc });
    } finally { await open.release().catch(() => undefined); }
    const confirms = calls.filter((c) => c.method === 'confirmSeal');
    expect(confirms.map((c) => c.args)).toEqual([{ db_at: token, ok: false, reason: 'other_writer_open' }]);
  }, 60_000);

  test('a write that opens after the quiet check but before the child took the confirmation revokes it', async () => {
    const token = await sealed();
    let open: Awaited<ReturnType<typeof holdWrite>> | null = null;
    const { calls, rpc } = fakeRpc(token, async (args) => { if (args.ok === true) open = await holdWrite('psql-writer-revoke', 'revoke'); });
    try {
      await confirmSeal({ ...deps(), rpc });
    } finally { await (open as Awaited<ReturnType<typeof holdWrite>> | null)?.release().catch(() => undefined); }
    expect(calls.map((c) => c.method)).toEqual(['state', 'confirmSeal', 'revokeSeal']); // revoked, and never committed
    expect(calls[2]!.args).toEqual({ reason: 'other_writer_open' });
  }, 60_000);

  /**
   * A reading role that is not a superuser and lacks pg_read_all_stats (a hosted database's app role): another role's
   * pg_stat_activity row shows its pid, usesysid, usename and application_name, but state, backend_xid, state_change
   * and backend_type are NULL (measured on PostgreSQL 16 and 17). The read runs under SET LOCAL ROLE to that role.
   */
  async function unprivilegedReads(): Promise<{ reads: ReadSource; drop: () => Promise<void> }> {
    const role = `seal_rd_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`); // the read turns row security off, as the brain owner may
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await engine.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    const wrapped: ReadSource = { pauseMs: reads.pauseMs, close: async () => {}, read: (fn) => reads.read(async (tx, query) => { await query(`SET LOCAL ROLE ${role}`); return fn(tx, query); }) };
    return { reads: wrapped, drop: async () => { await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined); await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); } };
  }

  test('a connected idle session of a role that cannot write a copied relation (a monitoring agent) does not refuse, seen or hidden', async () => {
    const monitor = await throwawayRole([]);
    const hidden = await unprivilegedReads();
    try {
      const app = 'monitor-agent';
      const sql = monitor.connect(app);
      await sql`SELECT 1`; // idle from now on, well inside the settle window
      expect(await backends(app)).toBe(1);
      const seen = await sealMark(deps()); // read as a superuser: the session is visible and idle for under a minute
      expect(seen).not.toHaveProperty('refused');
      const token = (seen as { token: string }).token;
      expect(await sealMark(deps(hidden.reads))).not.toHaveProperty('refused'); // read by a role that cannot see it
      await sql`SELECT 1`;
      expect(await quietSince(deps(), token)).toEqual({ ok: true });
      await finish(sql, app);
    } finally { await hidden.drop(); await monitor.drop(); }
  }, 60_000);

  test('a session hidden from the reading role, of a role that can write a copied relation, is refused while its write is open', async () => {
    const writer = await throwawayRole(['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE', 'GRANT INSERT, UPDATE ON engine_writer_sessions TO $ROLE', 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO $ROLE'], true);
    const hidden = await unprivilegedReads();
    try {
      expect(await sealMark(deps(hidden.reads))).not.toHaveProperty('refused'); // the role alone is covered: no refusal yet
      const app = 'hidden-writer';
      const sql = writer.connect(app);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let started!: () => void;
      const open = new Promise<void>((r) => { started = r; });
      const tx = sql.begin(async (t) => { await t`INSERT INTO config (key, value) VALUES ('hidden-open', '1')`; started(); await held; });
      await open;
      try {
        expect(await sealMark(deps(hidden.reads))).toEqual({ refused: 'other_backend_unseen' });
      } finally { release(); await tx; }
      await finish(sql, app);
    } finally { await hidden.drop(); await writer.drop(); }
  }, 60_000);

  test('a hidden NOINHERIT login that can SET ROLE to a writer role, holding an uncommitted INSERT as that role, is refused at the seal and at the check', async () => {
    // The login itself has no privilege on any table; the NOLOGIN role it can switch to writes config and has every
    // route to record evidence, so no role is uncovered. pg_stat_activity names the login, not the role it switched to.
    const target = `seal_tgt_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await engine.executeRaw(`CREATE ROLE ${target} NOLOGIN BYPASSRLS`);
    for (const g of ['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE', 'GRANT INSERT, UPDATE ON engine_writer_sessions TO $ROLE', 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO $ROLE']) await engine.executeRaw(g.replace(/\$ROLE/g, target));
    const login = await throwawayRole([`GRANT ${target} TO $ROLE`], false, 'NOINHERIT');
    const hidden = await unprivilegedReads();
    try {
      const token = await sealed(hidden.reads); // nobody connected yet: the reachable role is covered, so no refusal
      const app = 'hidden-set-role-writer';
      const sql = login.connect(app);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let started!: () => void;
      const open = new Promise<void>((r) => { started = r; });
      const tx = sql.begin(async (t) => { await t.unsafe(`SET LOCAL ROLE ${target}`); await t`INSERT INTO config (key, value) VALUES ('hidden-set-role-open', '1')`; started(); await held; });
      await open;
      try {
        expect(await sealMark(deps(hidden.reads))).toEqual({ refused: 'other_backend_unseen' });
        expect(await quietSince(deps(hidden.reads), token)).toEqual({ ok: false, reason: 'other_backend_unseen' });
      } finally { release(); await tx; }
      await finish(sql, app);
    } finally {
      await hidden.drop(); await login.drop();
      await engine.executeRaw(`DROP OWNED BY ${target}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${target}`).catch(() => undefined);
    }
  }, 60_000);

  // No exemption by connection name: anyone can set application_name. Only connections proven to be the sealing
  // process's own (reserved from its pool while the read runs) are left out of the activity checks.
  test('a visible client that sets the sealing process\'s connection name and holds a write open is refused at the seal (other_writer_open)', async () => {
    const token = await sealed();
    const app = (JSON.parse(token) as { app: string }).app;
    const open = await holdWrite(app, 'same-name-open');
    try {
      expect(await sealMark(deps())).toEqual({ refused: 'other_writer_open' });
      expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'other_writer_open' });
    } finally { await open.release(); }
  }, 60_000);

  test('a visible client that sets the sealing process\'s connection name and wrote moments ago is refused at the seal (other_writer_live: the hooks recorded it and it is still connected)', async () => {
    const app = (JSON.parse(await sealed()) as { app: string }).app;
    const sql = connection(app);
    await sql`INSERT INTO config (key, value) VALUES ('same-name-recent', '1')`;
    expect(await sealMark(deps())).toEqual({ refused: 'other_writer_live' });
    await sql`SELECT 1`; // a read only, moments ago, by a client that never wrote through the hooks: recent
    const reader = connection(app);
    await reader`SELECT 1`;
    await engine.executeRaw(`DELETE FROM engine_writer_sessions WHERE application_name = $1`, [app]); // its row gone: judged on its state alone
    expect(await sealMark(deps())).toEqual({ refused: 'other_backend_recent' });
  }, 60_000);

  test('a hidden login that sets the sealing process\'s connection name, holding an uncommitted INSERT, is refused at the seal and at the check, and the seal is never confirmed', async () => {
    const writer = await throwawayRole(['GRANT INSERT ON config TO $ROLE', 'GRANT INSERT ON engine_writer_coverage_gaps TO $ROLE', 'GRANT INSERT, UPDATE ON engine_writer_sessions TO $ROLE', 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO $ROLE'], true);
    const hidden = await unprivilegedReads();
    try {
      const token = await sealed(hidden.reads);
      const app = (JSON.parse(token) as { app: string }).app; // the name the sealing process connects with
      const sql = writer.connect(app);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let started!: () => void;
      const open = new Promise<void>((r) => { started = r; });
      const tx = sql.begin(async (t) => { await t`INSERT INTO config (key, value) VALUES ('hidden-same-name-open', '1')`; started(); await held; });
      await open;
      try {
        expect(await sealMark(deps(hidden.reads))).toEqual({ refused: 'other_backend_unseen' });
        expect(await quietSince(deps(hidden.reads), token)).toEqual({ ok: false, reason: 'other_backend_unseen' });
        const { calls, rpc } = fakeRpc(token);
        await confirmSeal({ ...deps(hidden.reads), rpc });
        expect(calls.filter((c) => c.method === 'confirmSeal').map((c) => c.args)).toEqual([{ db_at: token, ok: false, reason: 'other_backend_unseen' }]);
        expect(calls.map((c) => c.method)).not.toContain('commitSeal');
      } finally { release(); await tx; }
    } finally { await hidden.drop(); await writer.drop(); }
  }, 60_000);

  test('control: the sealing process\'s own pool connections, just used, are proven its own and still seal, read as the owner and as a role that cannot see them', async () => {
    await Promise.all([1, 2, 3].map((i) => engine.executeRaw(`SELECT pg_sleep(0.05), ${i}`))); // several pool connections, active a moment ago
    expect(await sealMark(deps())).toHaveProperty('token');
    const hidden = await unprivilegedReads();
    try {
      await Promise.all([1, 2, 3].map((i) => engine.executeRaw(`SELECT pg_sleep(0.05), ${i}`)));
      expect(await sealMark(deps(hidden.reads))).toHaveProperty('token');
    } finally { await hidden.drop(); }
  }, 60_000);

  test('a pool connection another part of the sealing process holds reserved, and wrote through, is proven its own and still seals', async () => {
    // A serving process keeps one pool connection reserved for its whole life (the persistence consumer's idle lane), and
    // that connection wrote through the hooks at startup. It can never be reserved again, yet it is the process's own.
    await engine.withReservedConnection(async (conn) => {
      await conn.executeRaw(`INSERT INTO config (key, value) VALUES ('held-own-lane', '1')`);
      const [{ pid }] = await conn.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM engine_writer_sessions WHERE backend_pid = $1', [pid]);
      expect(n).toBe(1); // the hooks recorded it as a writer, and it is still connected
      expect(await sealMark(deps())).toHaveProperty('token');
    });
  }, 60_000);

  test('a pool connection of the sealing process still running a statement at the seal is proven its own and does not refuse it', async () => {
    const busy = engine.executeRaw('SELECT pg_sleep(1.5)');
    try {
      await new Promise((r) => setTimeout(r, 300)); // the statement is running: not idle, and not reservable
      expect(await sealMark(deps())).toHaveProperty('token');
    } finally { await busy; }
  }, 60_000);

  test('a statistics reset is refused', async () => {
    const token = await sealed();
    await engine.executeRaw('SELECT pg_stat_reset()');
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'stats_reset_changed' });
  }, 60_000);

  test('a TRUNCATE of a copied relation is refused', async () => {
    const token = await sealed();
    await engine.executeRaw('TRUNCATE config');
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'relfilenode_changed' });
  }, 60_000);

  test('a copied relation dropped and created again is refused', async () => {
    const token = await sealed();
    await engine.executeRaw('DROP TABLE seal_probe_rel');
    await engine.executeRaw('CREATE TABLE seal_probe_rel (id int PRIMARY KEY)');
    await installWriterHooks(engine, dir);
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'relation_oid_changed' });
  }, 60_000);

  test('track_counts off for the database is refused by a reader that was connected before and by a new one, at the seal and at the check', async () => {
    const token = await sealed();
    const name = await databaseName();
    await engine.executeRaw(`ALTER DATABASE "${name}" SET track_counts = off`);
    expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'track_counts_off' });
    expect(await sealMark(deps())).toEqual({ refused: 'track_counts_off' });
    const fresh = openReadSource(engine);
    sources.push(fresh);
    expect(await quietSince(deps(fresh), token)).toEqual({ ok: false, reason: 'track_counts_off' });
    expect(await sealMark(deps(fresh))).toEqual({ refused: 'track_counts_off' });
  }, 60_000);

  test('track_counts off for a role in this database is refused', async () => {
    const token = await sealed();
    const r = await throwawayRole([]);
    try {
      const name = await databaseName();
      await engine.executeRaw(`ALTER ROLE ${r.role} IN DATABASE "${name}" SET track_counts = off`);
      expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'track_counts_off' });
      expect(await sealMark(deps())).toEqual({ refused: 'track_counts_off' });
    } finally { await r.drop(); }
  }, 60_000);
});

const p = hasDatabase() && preparedUrl ? describe : describe.skip;
p('the seal change token with prepared transactions (GBRAIN_TEST_PREPARED_DATABASE_URL, max_prepared_transactions > 0)', () => {
  let prepared: Template;
  beforeAll(async () => { assertSafeE2eDatabaseUrl(preparedUrl); prepared = await persistencePostgresTemplate(preparedUrl); }, 120_000);
  afterAll(async () => { await prepared.dispose(); });
  beforeEach(async () => { ({ engine, close } = await prepared.clone()); await prepare(); }, 60_000);
  afterEach(teardown, 60_000);

  test('a prepared transaction that holds a write is refused at the check and at the seal', async () => {
    const token = await sealed();
    const app = 'psql-writer-prepare';
    const w = connection(app);
    await w.unsafe(`BEGIN; INSERT INTO config (key, value) VALUES ('prep', '1') ON CONFLICT (key) DO NOTHING; PREPARE TRANSACTION 'seal_token_probe'`);
    await finish(w, app);
    try {
      expect(await quietSince(deps(), token)).toEqual({ ok: false, reason: 'prepared_transaction' });
      expect(await sealMark(deps())).toEqual({ refused: 'prepared_transaction' });
    } finally { await engine.executeRaw(`ROLLBACK PREPARED 'seal_token_probe'`).catch(() => undefined); }
  }, 60_000);
});
