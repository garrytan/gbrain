/**
 * #6543 (B2): the drain used to print a constant "claimable here: no" and wait the whole no-progress window (600 s in the
 * report) for a queued head no consumer could claim. The head probe names the predicate blocking the head; an
 * intervention-required blocker (a refresh fence no refresh process holds, a zombie publication ahead) stops the drain
 * `drain_stalled` / `cause: head_blocked` after one governor tick, while a live blocker (a foreground publication) keeps the
 * progress-aware wait. A failed probe prints `unknown`. Writer status names the same blocker.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { drainNext, engineStallProbe, formatDrainSummary, runDrain, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { headClaimability, type HeadBlocker } from '../src/core/persistence/head-blocker.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { refreshLockPath } from '../src/core/persistence/worktree-refresh.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const RESUME = 'gbrain sync --source s';
const done: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const fence: HeadBlocker = { predicate: 'refresh_fence', ids: ['ref-1'], state: 'fenced', owner: { kind: 'refresh', pid: null, live: false, restart_required: false }, intervention: true };
const hold: HeadBlocker = { predicate: 'root_hold', ids: ['req-ahead'], state: 'running', owner: { kind: 'serve', pid: 77, live: true, restart_required: false }, intervention: false };
const probeWith = (head: StallProbe['head']): StallProbe => ({ blockedHead: async () => null, fingerprint: async () => null, head });

describe('in-pass governor: head blocker classification', () => {
  test('an intervention-required blocker on a queued head stops within one governor tick, naming the predicate and its recovery', async () => {
    const started = Date.now();
    const result = await runDrain({ governMs: 20, noProgressMs: 60_000, publicationCeilingMs: 60_000,
      probe: probeWith(async () => ({ head_state: 'queued', request_id: 'req-head', claim: null, claimable_here: false, blocked_by: fence, consumer: 'self(full)' })),
      pass: () => new Promise<SyncResult>(() => undefined) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
      stall: { cause: 'head_blocked', in_pass: true, head_request_id: 'req-head', claimable_here: false, consumer: 'self(full)', blocked_by: { predicate: 'refresh_fence', ids: ['ref-1'] } } });
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ code: 'drain_stalled', cause: 'head_blocked', safe_to_loop: false, command: 'gbrain sources refresh s --resume', docs: 'docs/guides/write-refusals.md#head-blocked' });
    expect(next.fix).toMatchObject({ argv: ['gbrain', 'sources', 'refresh', 's', '--resume'], next: 'run' });
    const summary = formatDrainSummary(result, RESUME, 's').join('\n');
    expect(summary).toContain('cause=head_blocked');
    expect(summary).toContain('blocked_by=refresh_fence(fenced ref-1 no live refresh)');
    expect(summary).toContain('consumer=self(full)');
  });

  test('a zombie publication ahead suggests restarting the named owner', async () => {
    const zombie: HeadBlocker = { predicate: 'zombie_publication', ids: ['req-z'], state: 'running', owner: { kind: 'serve', pid: 4242, live: true, restart_required: true }, intervention: true };
    const result = await runDrain({ governMs: 20, noProgressMs: 60_000, publicationCeilingMs: 60_000,
      probe: probeWith(async () => ({ head_state: 'queued', request_id: 'req-head', claim: null, claimable_here: false, blocked_by: zombie })),
      pass: () => new Promise<SyncResult>(() => undefined) });
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ cause: 'head_blocked', fix: { actor: 'host_admin', next: 'tell_user_to_run' } });
    expect(next.why).toContain('Restart the gbrain serve process (pid 4242)');
  });

  test('a live blocker (a foreground publication ahead) lasting several ticks never stops the drain; the pass completes', async () => {
    let reads = 0;
    const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 60_000,
      probe: probeWith(async () => { reads++; return { head_state: 'queued', request_id: 'req-head', claim: null, claimable_here: false, blocked_by: hold }; }),
      pass: () => new Promise<SyncResult>(resolve => setTimeout(() => resolve({ ...done, managedCursor: { index: 1, total: 1 } }), 150)) });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(result.drain).toMatchObject({ outcome: 'synced' });
  });

  test('a head whose claimability could not be read prints unknown, never no', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 60, publicationCeilingMs: 60_000,
      probe: probeWith(async () => ({ head_state: 'queued', request_id: 'req-head', claim: null, claimable_here: null, blocked_by: null })),
      pass: () => new Promise<SyncResult>(() => undefined) });
    expect(result.drain).toMatchObject({ stop_reason: 'drain_stalled', stall: { cause: 'no_progress', claimable_here: null } });
    expect(formatDrainSummary(result, RESUME, 's').join('\n')).toContain('claimable here: unknown');
  }, 15_000);

  test('the stall line names the consumer and the blocker', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      await runDrain({ announce: true, progressMs: 15, governMs: 10, noProgressMs: 200, publicationCeilingMs: 60_000,
        probe: probeWith(async () => ({ head_state: 'queued', request_id: 'req-head', claim: null, claimable_here: false, blocked_by: hold, consumer: 'serve pid=77 last_heartbeat_ago=3s' })),
        pass: () => new Promise<SyncResult>(() => undefined) });
    } finally { spy.mockRestore(); }
    expect(lines.some(line => line.includes('consumer=serve pid=77 last_heartbeat_ago=3s') && line.includes('blocked_by=root_hold(running req-ahead serve pid 77)'))).toBe(true);
  }, 15_000);
});

describe('head blocker probe over a real brain', () => {
  const engines: Array<[string, BrainEngine]> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(['pglite', lite]); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(['postgres', pg.engine]); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const [kind, engine] of engines) if (kind === 'pglite') await engine.disconnect(); await closePostgres?.(); });

  async function seed(engine: BrainEngine) {
    const id = `hb-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, `/tmp/${id}`]);
    const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES($1::uuid) RETURNING id::text AS id', [localHostId()]);
    const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
    await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [id, src!.incarnation, wt!.id]);
    const request = async (state: 'queued' | 'running', slug: string, kind: string, extra: { token?: string; stamp?: string } = {}) => {
      const [row] = await engine.executeRaw<{ id: string; request_id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,
          state,execution_token,claim_expires_at,claim_phase)
        VALUES('local_cli','cli:example',$1::uuid,'put_page',$2,$3::uuid,$4,$5::uuid,'d','{}'::jsonb,$6::text::jsonb,1,16384,$7,$8::uuid,
          CASE WHEN $7='running' THEN now()+interval '30 seconds' END,$9::text::jsonb)
        RETURNING id::text AS id, request_id::text AS request_id`,
        [randomUUID(), id, src!.incarnation, slug, wt!.id, JSON.stringify({ kind, path: `${slug}.md` }), state, extra.token ?? null, extra.stamp ?? null]);
      return row!;
    };
    return { id, worktree: wt!.id, request };
  }

  test('a durable refresh fence with no refresh process stops the drain within one tick and writer status names it', async () => {
    for (const [, engine] of engines) {
      const { id, worktree, request } = await seed(engine);
      const head = await request('queued', 'notes/a', 'managed_sync_import');
      const [refresh] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_worktree_refreshes(worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
        VALUES($1::uuid,ARRAY[$2],gen_random_uuid(),1,1,'fenced',$3,$4,'origin/main') RETURNING id::text AS id`, [worktree, id, 'a'.repeat(40), 'b'.repeat(40)]);
      const probe = engineStallProbe(engine, id);
      const result = await runDrain({ governMs: 20, noProgressMs: 60_000, publicationCeilingMs: 60_000, probe, pass: () => new Promise<SyncResult>(() => undefined) });
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
        stall: { cause: 'head_blocked', head_request_id: head.id, claimable_here: false, blocked_by: { predicate: 'refresh_fence', ids: [refresh!.id], state: 'fenced', intervention: true } } });
      const status = await readWriterDiagnostics(engine);
      const row = (status.blockers as Array<Record<string, unknown>>).find(b => b.request_id === head.request_id)!;
      expect(row).toMatchObject({ claimable_here: false, blocked_by: { predicate: 'refresh_fence', ids: [refresh!.id] } });
      expect(String(row.next_action)).toContain(`gbrain sources refresh ${id} --resume`);
      expect(row.cancel_command).toBeUndefined();

      // A refresh process holding the lock is live work: the drain keeps waiting.
      const lock = await tryAcquireNativeLock(refreshLockPath(worktree));
      try {
        const live = await headClaimability(engine, { id: head.id, state: 'queued' }, localHostId());
        expect(live).toMatchObject({ claimable_here: false, blocked_by: { predicate: 'refresh_fence', intervention: false, owner: { live: true } } });
      } finally { await lock?.release(); }
      await engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='aborted' WHERE id=$1::uuid", [refresh!.id]);
      expect(await headClaimability(engine, { id: head.id, state: 'queued' }, localHostId())).toEqual({ claimable_here: true, blocked_by: null });
    }
  }, 60_000);

  test('a foreground publication ahead of a queued head lasting several ticks does not stop the drain, which completes', async () => {
    for (const [, engine] of engines) {
      const { id, request } = await seed(engine);
      const token = randomUUID(), at = new Date().toISOString();
      const stamp = JSON.stringify({ phase: 'publishing', claimed_at: at, since: at, token, step: null, step_since: at, waiting_on: 'publication', owner: { kind: 'serve', pid: 5151, version: 'test', nonce: 'n5' } });
      const ahead = await request('running', 'notes/fg', 'put_page', { token, stamp });
      const head = await request('queued', 'notes/b', 'managed_sync_import');
      const probe = engineStallProbe(engine, id);
      const read = await probe.head!();
      expect(read).toMatchObject({ head_state: 'running' });
      expect(await headClaimability(engine, { id: head.id, state: 'queued' }, localHostId()))
        .toMatchObject({ claimable_here: false, blocked_by: { predicate: 'root_hold', ids: [ahead.request_id], intervention: false } });
      const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 60_000, probe,
        pass: () => new Promise<SyncResult>(resolve => setTimeout(() => resolve({ ...done, managedCursor: { index: 1, total: 1 } }), 200)) });
      expect(result.drain).toMatchObject({ outcome: 'synced' });
      const status = await readWriterDiagnostics(engine);
      const row = (status.blockers as Array<Record<string, unknown>>).find(b => b.request_id === head.request_id)!;
      expect(row).toMatchObject({ claimable_here: false, blocked_by: { predicate: 'root_hold', ids: [ahead.request_id] } });
      expect(row.cancel_command).toBeUndefined();
    }
  }, 60_000);

  test('a failed probe reads unknown, not no', async () => {
    for (const [, engine] of engines) {
      const failing = new Proxy(engine, { get(target, prop, receiver) {
        if (prop === 'executeRaw') return async () => { throw new Error('probe read failed'); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as BrainEngine;
      expect(await headClaimability(failing, { id: randomUUID(), state: 'queued' }, localHostId())).toEqual({ claimable_here: null, blocked_by: null });
    }
  });
});
