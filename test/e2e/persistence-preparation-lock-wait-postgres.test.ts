/**
 * #6278 (plan item 1.4) on Postgres: a preparation read blocked by a relation
 * lock ends at the budget on the server, not only in this process. Phase 0
 * (docs/eval/managed-sync-stall-repro.md) reproduced the reporter's signature
 * by holding `LOCK TABLE pages IN ACCESS EXCLUSIVE MODE` in another session
 * through a transaction-mode pooler, which drops the session's
 * `statement_timeout`: the member's origin check (`SELECT id,slug,source_path
 * FROM pages ...`, step `origin_check`) waited for as long as the lock was
 * held, and with the budget alone the released member's statement kept
 * running as a zombie that pinned its connection and its root until the
 * ceiling. Here another connection holds that lock in an open transaction
 * while a 200-page managed source drains through the real `performSync`
 * (budget 2 s, one lane: the grouped route in the first variant, the single
 * route in the second). Protects: the member is released `preparation_deadline` within
 * the budget plus slack, with its last step `origin_check`; no statement of
 * the sync remains active on the server after the release (the bound ended
 * it) while nothing new is issued, so the pool's active count is back at
 * zero; the root is free, so once the lock is dropped the same member and
 * every page behind it commit (the counter resets on commit). The second
 * variant holds the lock past both attempts: the member finishes
 * `failed`/`preparation_stalled` and the run ends blocked instead of waiting
 * for the watchdog. Before the server-side bound, the first variant failed:
 * the statement outlived the release (still `active`, waiting on the lock) and
 * the member was re-claimed only after the ceiling. Fails again if the bound
 * stops reaching the origin check or a 57014 at the budget is written as a
 * `storage_error` receipt instead of a charged release.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-prep-lock-wait-e2e-'));
let engine: BrainEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
const BUDGET_MS = 2_000;
/** How long past the budget the release may land (the server's timeout fires at the budget; the release statement follows). */
const SLACK_MS = 3_000;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const pad = (i: number) => String(i).padStart(3, '0');
async function fixture(e: BrainEngine, count: number) {
  const id = `lockwait-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    const full = join(root, 'notes', `n${pad(i)}.md`); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\ntitle: Note ${i}\n---\nA durable observation number ${i}, see [[notes/n${pad((i + 7) % count)}]].\n`);
  }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
type ImportRow = { slug: string; state: string; blocked_reason: string | null; error_code: string | null; preparation_attempts: number; error_message: string | null };
const imports = (e: BrainEngine, source: string) => e.executeRaw<ImportRow>(
  `SELECT slug,state,blocked_reason,error_code,preparation_attempts,error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [source]);
const ORIGIN_CHECK_SQL = 'SELECT id,slug,source_path FROM pages WHERE source_id=$1 AND ';

/** The lock holder: another session holding `pages` ACCESS EXCLUSIVE in an open transaction until `drop()`. */
async function holdPagesLock(url: string) {
  // Two connections: one holds the lock's transaction, the other reads the server state while it is held.
  const holder = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  const dropped = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const transaction = holder.begin(async sql => {
    // NOWAIT, retried: a queued ACCESS EXCLUSIVE request would make every later reader wait behind it while a publication
    // transaction still holds the table, so the holder takes the lock only at a moment nothing holds `pages`.
    for (;;) {
      await sql.unsafe('SAVEPOINT lock_attempt');
      try { await sql.unsafe('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE NOWAIT'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
        await sql.unsafe('ROLLBACK TO SAVEPOINT lock_attempt');
        await Bun.sleep(20);
      }
    }
    acquired.resolve();
    await dropped.promise;
  }).catch(error => { acquired.reject(error); throw error; });
  await acquired.promise;
  // The holder's own connection reads the server state: while the lock is held the engine's pool may be saturated by reads waiting on it.
  /** The sync's origin-check statements still running on the server (every one of them waits on this lock). */
  const activeOriginChecks = async () => Array.from(await holder.unsafe(
    `SELECT pid,state,wait_event_type,left(query,80) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' AND query LIKE $1`,
    [`${ORIGIN_CHECK_SQL}%`])) as Array<Record<string, unknown>>;
  const request = async (sourceId: string, slug: string) => (Array.from(await holder.unsafe(
    `SELECT slug,state,blocked_reason,error_code,preparation_attempts,error_message FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_sync_import'`,
    [sourceId, slug])) as ImportRow[])[0];
  return { activeOriginChecks, request, drop: async () => { dropped.resolve(); await transaction.catch(() => undefined); await holder.end(); } };
}

/**
 * Intercepts the consumer's origin check of `path` (the claimed request's, never the feeder's screen): `onFirst` runs before the
 * statement the first time (it takes the lock), and while `gate` is closed every later origin check of this source waits in
 * process, so a statement seen active on the server after the release can only be a statement the release left behind.
 */
function interceptOriginChecks(e: BrainEngine, sourceId: string, path: string, slug: string, onFirst: () => Promise<void>) {
  const original = e.executeRaw;
  let gate: Promise<void> = Promise.resolve();
  let holds = 0;
  (e as { executeRaw: unknown }).executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (typeof sql === 'string' && sql.startsWith(ORIGIN_CHECK_SQL) && params?.[0] === sourceId) {
      const target = Array.isArray(params?.[1]) && (params![1] as string[]).includes(path);
      const [claimed] = target ? await original.call(this, "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='running' AND intent->>'kind'='managed_sync_import'", [sourceId, slug]) : [];
      if (claimed && ++holds === 1) await onFirst();
      else await gate;
    }
    return original.call(this, sql, params, opts as never);
  };
  return { restore: () => { (e as { executeRaw: unknown }).executeRaw = original; }, holds: () => holds,
    close: () => { const opened = Promise.withResolvers<void>(); gate = opened.promise; return () => opened.resolve(); } };
}

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 12); engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
  await engine.setConfig('persistence.sync_preparation_ms', String(BUDGET_MS));
  await engine.setConfig('persistence.preparation_ceiling_ms', '60000');
  resetWriteSwitches();
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  resetWriteSwitches();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!hasDatabase())('a lock-blocked preparation read ends at the budget (Postgres, #6278 plan 1.4)', () => {
  test('the member is released preparation_deadline at the budget with no statement left on the server, and commits once the lock is dropped', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
    if (!engine) return;
    const f = await fixture(engine, 200);
    const stuckSlug = 'notes/n052', stuckPath = 'notes/n052.md';
    let lock: Awaited<ReturnType<typeof holdPagesLock>> | undefined;
    let lockedAt = 0;
    const observed: { releasedAt?: number; released?: ImportRow; leftover?: Array<Record<string, unknown>>; clearedAfterMs?: number } = {};
    let watcher: Promise<void> = Promise.resolve();
    const intercept = interceptOriginChecks(engine, f.id, stuckPath, stuckSlug, async () => {
      lock = await holdPagesLock(databaseUrl);
      lockedAt = performance.now();
      // The watcher: once the member is released, nothing new reaches the server, the leftover statements are counted, then the lock drops.
      watcher = (async () => {
        const open = intercept.close();
        try {
          await waitFor(async () => { const row = await lock!.request(f.id, stuckSlug); if (row?.state === 'queued' && row.blocked_reason === 'preparation_deadline') { observed.released = row; return true; } return false; },
            { timeoutMs: BUDGET_MS + SLACK_MS + 5_000, intervalMs: 50, label: 'the member is released at the budget' });
          observed.releasedAt = performance.now();
          // The wave's other members share its deadline; nothing of this wave may stay active on the server past the slack.
          await waitFor(async () => (await lock!.activeOriginChecks()).length === 0, { timeoutMs: SLACK_MS, intervalMs: 50, label: 'no origin check stays active on the server' })
            .catch(async () => { observed.leftover = await lock!.activeOriginChecks(); });
          observed.clearedAfterMs = performance.now() - observed.releasedAt;
        } finally { await lock!.drop(); open(); }
      })();
    });
    await engine.setConfig('sync.holds', 'fail');
    let result;
    try {
      result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 1 });
    } finally { intercept.restore(); await watcher.catch(() => undefined); await lock?.drop().catch(() => undefined); await engine.unsetConfig('sync.holds'); }
    expect(intercept.holds()).toBeGreaterThanOrEqual(1);
    // Released at the budget, charged once (the step reaches the stamp only on a renewal; the stalled receipt in the second variant names it).
    expect(observed.released).toMatchObject({ state: 'queued', blocked_reason: 'preparation_deadline', preparation_attempts: 1 });
    expect(observed.releasedAt! - lockedAt).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(observed.releasedAt! - lockedAt).toBeGreaterThanOrEqual(BUDGET_MS * 0.9);
    // The server ended the statements: no origin check of the sync is active while the lock is still held and nothing new is issued,
    // so the released member pins no connection (before the bound, the statement stayed active, waiting on the lock, until it dropped).
    expect(observed.leftover ?? []).toEqual([]);
    expect(observed.clearedAfterMs).toBeLessThan(SLACK_MS);
    // The root was free: the same member and every page committed once the lock dropped, and the counter reset on commit.
    expect(result.drain).toMatchObject({ outcome: 'synced' });
    const rows = await imports(engine, f.id);
    expect(rows.find(row => row.slug === stuckSlug)).toMatchObject({ state: 'committed', preparation_attempts: 0 });
    expect(rows.every(row => row.state === 'committed')).toBe(true);
    expect(rows.filter(row => row.blocked_reason === 'claim_lost')).toEqual([]);
    expect(await engine.getPage(stuckSlug, { sourceId: f.id })).not.toBeNull();
  }), 300_000);

  test('a lock held past both attempts finishes the member preparation_stalled and the run ends blocked instead of waiting for the watchdog', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '1' }, async () => {
    if (!engine) return;
    const f = await fixture(engine, 60);
    const stuckSlug = 'notes/n024', stuckPath = 'notes/n024.md';
    let lock: Awaited<ReturnType<typeof holdPagesLock>> | undefined;
    let lockedAt = 0;
    // The holder's poll is awaited before the holder ends, so no poll can land on an ended connection.
    let terminal: Promise<unknown> = Promise.resolve();
    const intercept = interceptOriginChecks(engine, f.id, stuckPath, stuckSlug, async () => {
      lock = await holdPagesLock(databaseUrl);
      lockedAt = performance.now();
      // Dropped only after the terminal receipt lands, so the second attempt also waits on the lock.
      terminal = waitFor(async () => (await lock!.request(f.id, stuckSlug))?.state === 'failed',
        { timeoutMs: BUDGET_MS * 2 + SLACK_MS * 2 + 10_000, intervalMs: 50, label: 'the member finishes preparation_stalled' })
        .catch(() => undefined).then(() => lock!.drop());
    });
    await engine.setConfig('sync.holds', 'fail');
    let result;
    try {
      result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 1 });
    } finally { intercept.restore(); await terminal.catch(() => undefined); await lock?.drop().catch(() => undefined); await engine.unsetConfig('sync.holds'); }
    const ended = performance.now();
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'blocked_by_failures' });
    expect(result.managedWrite?.slug).toBe(stuckSlug);
    const rows = await imports(engine, f.id);
    const stuck = rows.find(row => row.slug === stuckSlug)!;
    expect(stuck).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2 });
    expect(stuck.error_message).toContain('step origin_check (waiting on db)');
    // Two budgets, each ended by the server, then the receipt: well inside the ceiling.
    expect(ended - lockedAt).toBeLessThan(BUDGET_MS * 2 + SLACK_MS * 2 + 10_000);
    const stuckAt = rows.findIndex(row => row.slug === stuckSlug);
    expect(rows.slice(0, stuckAt).every(row => row.state === 'committed')).toBe(true);
    expect(await engine.getPage(stuckSlug, { sourceId: f.id })).toBeNull();
    expect(rows.filter(row => row.blocked_reason === 'claim_lost')).toEqual([]);
  }), 300_000);
});
