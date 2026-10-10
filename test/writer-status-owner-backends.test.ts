/**
 * #6317 (C1, reporter ask 3): `writer status --json` shows, per running
 * claim, the owner process's database backends from `pg_stat_activity`,
 * matched on the `application_name` every gbrain pool starts its connections
 * with (`gbrain <kind>:<pid>:<nonce8>`), with the statement label, ages,
 * state and wait event, and says how far the mapping can be trusted
 * (`backend_visibility`: session, pooled, unavailable). The running claim also
 * ends with one `next` envelope, carries `last_sql` from the stamp and the
 * pool numbers from the vendored driver when this process owns the claim.
 *
 * PGLite: the fields exist and read `unavailable`/empty. Postgres
 * (DATABASE_URL): this process's own connection appears under its name.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readWriterDiagnostics, readOwnerBackends, claimNextAction } from '../src/core/persistence/diagnostics.ts';
import { claimOwner, claimPhaseStamp, startClaimPhase, recordClaimSql, sqlLabel, claimTripleText, isOwnerThisProcess, claimStateOf } from '../src/core/persistence/claim-phase.ts';
import { boundedReads } from '../src/core/persistence/bounded-reads.ts';
import { consumerIdentity } from '../src/core/persistence/consumer-heartbeat.ts';
import { gbrainApplicationName } from '../src/core/db.ts';
import { driverPoolStats } from '../src/core/postgres-engine/pool-stats.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const engines: Array<{ engine: BrainEngine; close?: () => Promise<void> }> = [];
beforeAll(async () => {
  if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push({ engine: lite }); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push({ engine: pg.engine, close: pg.close }); }
}, 120_000);
afterAll(async () => { for (const e of engines) { if (e.close) await e.close(); else await e.engine.disconnect(); } });

async function runningClaim(engine: BrainEngine, stamp: string): Promise<string> {
  const id = `wb-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, `/tmp/${id}`]);
  const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
  const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  const token = JSON.parse(stamp).token as string, requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,
      state,execution_token,claim_expires_at,claim_phase)
    VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,'notes/p',$4::uuid,'d','{}'::jsonb,'{"kind":"managed_sync_import","path":"notes/p.md"}'::jsonb,1,16384,'running',$5::uuid,now()+interval '30 seconds',$6::text::jsonb)`,
  [requestId, id, src!.incarnation, wt!.id, token, stamp]);
  return requestId;
}

describe('claim stamp identity and last_sql', () => {
  test('the owner carries the nonce and pid namespace; the stamp carries last_sql; the triple text and the same-process check read them', () => {
    const owner = claimOwner();
    expect(owner).toMatchObject({ pid: process.pid, nonce: consumerIdentity().nonce });
    expect(gbrainApplicationName()).toBe(`gbrain ${owner.kind}:${process.pid}:${owner.nonce!.slice(0, 8)}`);
    expect(gbrainApplicationName().length).toBeLessThanOrEqual(63);
    expect(sqlLabel('SELECT r.id FROM persistence_requests r WHERE ...')).toBe('SELECT persistence_requests');
    expect(sqlLabel('  update "pages" set x=1')).toBe('UPDATE pages');
    expect(sqlLabel('WITH expired AS (SELECT 1) UPDATE persistence_requests SET state=$1')).toBe('WITH persistence_requests');
    expect(sqlLabel('SELECT 1')).toBe('SELECT');
    const clock = startClaimPhase(1_000, undefined, 30_000);
    recordClaimSql(clock, 'SELECT * FROM pages WHERE slug=$1', 5_000);
    expect(clock.lastSql).toEqual({ label: 'SELECT pages', at: 5_000 });
    expect(claimTripleText({ step: 'origin_check', waitingOn: 'db', lastSql: clock.lastSql }, 9_000)).toBe(' step=origin_check waiting_on=db last_sql=SELECT_pages@4s');
    expect(claimTripleText(undefined)).toBe(' step=none waiting_on=unknown last_sql=none');
    const state = claimStateOf({ state: 'running', claim_phase: claimPhaseStamp(clock, 'tok'), execution_token: 'tok' }, 9_000);
    expect(state).toMatchObject({ phase: 'preparing', owner: { pid: process.pid, nonce: owner.nonce }, last_sql: { label: 'SELECT pages', age_ms: 4_000 } });
    expect(isOwnerThisProcess({ pid: process.pid })).toBe(true);
    expect(isOwnerThisProcess({ pid: process.pid, nonce: owner.nonce })).toBe(true);
    expect(isOwnerThisProcess({ pid: process.pid, nonce: 'reused-pid-other-process' })).toBe(false);
    expect(isOwnerThisProcess({ pid: process.pid + 1 })).toBe(false);
  });

  test('boundedReads records the statement label on the clock before issuing it (Postgres path with a deadline)', async () => {
    const seen: string[] = [];
    const fake = { kind: 'postgres', executeRaw: async (sql: string) => { seen.push(sql); return []; } } as unknown as BrainEngine;
    const clock = startClaimPhase(Date.now(), undefined, 30_000);
    await boundedReads(fake, clock).executeRaw('SELECT 1 FROM persistence_requests');
    expect(seen).toHaveLength(1);
    expect(clock.lastSql?.label).toBe('SELECT persistence_requests');
  });

  test('driverPoolStats reads the vendored driver\'s queues and reports null for a driver without the accessor', () => {
    expect(driverPoolStats({ pool: { max: 10, open: 6, busy: 2, full: 1, reserved: 1, connecting: 0, closed: 0, ended: 0, queued: 3, inflight_oldest_ms: 250, completed: 42 } })).toEqual({ checked_out: 4, max: 10, waiters: 3, inflight_oldest_ms: 250, completed: 42 });
    expect(driverPoolStats({})).toBeNull();
    expect(driverPoolStats(null)).toBeNull();
  });
});

describe('writer status running claims', () => {
  test('owner.backend[], backend_visibility, next, last_sql and pool per engine', async () => {
    for (const { engine } of engines) {
      const clock = startClaimPhase(Date.now() - 20_000, undefined, 120_000);
      recordClaimSql(clock, 'SELECT id FROM pages WHERE slug=$1', Date.now() - 3_000);
      clock.step = 'import_screen'; clock.waitingOn = 'db';
      const requestId = await runningClaim(engine, claimPhaseStamp(clock, randomUUID()));
      const status = await readWriterDiagnostics(engine);
      const blocker = (status.blockers as Array<Record<string, any>>).find(b => b.request_id === requestId)!;
      expect(blocker).toBeDefined();
      const claim = blocker.claim;
      expect(claim).toMatchObject({ phase: 'preparing', step: 'import_screen', waiting_on: 'db', last_sql: { label: 'SELECT pages' }, owner: { pid: process.pid, nonce: consumerIdentity().nonce } });
      expect(claim.next).toMatchObject({ code: 'claim_running', fix: { next: 'run', argv: ['gbrain', 'sources', 'writer', 'status', '--source', blocker.source_id, '--json'] } });
      expect(claim.next.retry_after_ms).toBeGreaterThan(0);
      expect(claim.next.why).toContain(`pid ${process.pid}`);
      expect(typeof blocker.next_action).toBe('string');
      if (engine.kind === 'postgres') {
        expect(status.backend_visibility).toBe('session');
        expect(claim.owner.backend_visibility).toBe('session');
        // This process's own connection is one of the owner's backends: named, labelled, with a state and an age, never the SQL text.
        const mine = claim.owner.backend as Array<Record<string, unknown>>;
        expect(mine.length).toBeGreaterThanOrEqual(1);
        expect(mine[0]!.application_name).toBe(gbrainApplicationName());
        expect(mine.every(b => typeof b.pid === 'number' && typeof b.state === 'string')).toBe(true);
        expect(mine.some(b => String(b.statement ?? '').startsWith('SELECT'))).toBe(true);
        expect(JSON.stringify(mine)).not.toContain('pg_stat_activity WHERE');
        expect(claim.pool).toMatchObject({ max: expect.any(Number), checked_out: expect.any(Number), waiters: expect.any(Number) });
        expect(claim.pool_source).toBe('driver');
        // An owner that is not this process has no backend here and no pool (no heartbeat row yet).
        const other = await readOwnerBackends(engine, [{ kind: 'serve', pid: 999_999, nonce: 'nope' }]);
        expect(other.visibility).toBe('session');
        expect(other.byOwner.size).toBe(0);
      } else {
        expect(status.backend_visibility).toBe('unavailable');
        expect(claim.owner.backend).toEqual([]);
        expect(claim.pool).toBeNull();
      }
    }
  }, 60_000);

  test('next: past the ceiling or a wedged owner tells the host admin to restart the named pid; a lapsed claim resumes on its own', () => {
    const base = claimStateOf({ state: 'running', claim_phase: claimPhaseStamp({ ...startClaimPhase(Date.now() - 700_000), step: 'raw_hash', waitingOn: 'pool' }, 't'), execution_token: 't' })!;
    const overdue = claimNextAction(base, { reason: 'preparation_overdue', step: 'raw_hash', step_age_ms: 700_000, waiting_on: 'pool', budget_ms: 120_000 }, { budgetMs: 120_000, ceilingMs: 600_000 }, 's', { row: null, live: null });
    expect(overdue).toMatchObject({ code: 'claim_overdue', retry_after_ms: 0, fix: { next: 'tell_user_to_run', actor: 'host_admin' } });
    expect(overdue.fix.user_message).toContain(`pid ${process.pid}`);
    expect(overdue.why).toContain('past the 600s ceiling');
    const young = claimStateOf({ state: 'running', claim_phase: claimPhaseStamp({ ...startClaimPhase(Date.now() - 10_000), step: 'raw_hash', waitingOn: 'db' }, 't'), execution_token: 't' })!;
    const wedged = claimNextAction(young, null, { budgetMs: 120_000, ceilingMs: 600_000 }, 's',
      { row: { host_id: 'h', pid: process.pid, nonce: 'n', pid_ns: null, kind: 'serve', mode: 'full', started_at: '', renewed_at: new Date().toISOString(), restart_required: true, root_barrier_age_ms: null, pool: null, host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null, version: 'test', renewed_age_ms: 0, age_ms: 0, liveness: 'live', self: false }, live: true });
    expect(wedged).toMatchObject({ code: 'claim_overdue', fix: { next: 'tell_user_to_run' } });
    expect(wedged.why).toContain('restart_required');
    const running = claimNextAction(young, null, { budgetMs: 120_000, ceilingMs: 600_000 }, 's', { row: null, live: null });
    expect(running).toMatchObject({ code: 'claim_running', fix: { next: 'run' } });
    expect(running.retry_after_ms).toBeGreaterThan(100_000);
    const lapsed = claimStateOf({ state: 'running', claim_phase: null, execution_token: 't', claim_lapsed: true })!;
    expect(claimNextAction(lapsed, null, { budgetMs: null, ceilingMs: 600_000 }, null, { row: null, live: null })).toMatchObject({ code: 'claim_lapsed', retry_after_ms: null, fix: { next: 'run', argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } });
  });
});

