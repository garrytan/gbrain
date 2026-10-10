/**
 * #6317 (B2, T2): a live preparation owned by another process on this host no
 * longer stops the drain at its allowance (that stop turned #6298's
 * run-continuing containment into a `blocked` exit for every caller); the
 * drain prints the stall line naming the owner from the allowance on and
 * stops `drain_stalled` with `cause: owner_wedged_here` only past the ceiling
 * or when the owner's heartbeat row says it is wedged, with `retry_after_ms`
 * to the ceiling. A lapsed head a consumer here can reclaim gets exactly one
 * more window. The same-process check compares the nonce. A foreign-host
 * owner and an overdue publication keep the allowance stop.
 *
 * #6278 (B4): the drain's no-progress detector is claim-aware. Its fingerprint
 * keys on state, blocked reason, head id/state and the head claim's
 * phase/step/since, never on the lease columns every renewal bumps (before
 * this change a renewed-forever claim could never read as a stall, which is
 * how the reporter got the watchdog instead of `blocked` with `next`). A live
 * preparation is allowed its budget plus grace; a lapsed claim keeps the plain
 * window; a preparation this process's own consumer holds past its allowance
 * ends the drain `resumable` / `preparation_abandoned`; a tripped breaker ends
 * it `blocked` / `preparation_systemic`. The stall object and the timer line
 * name the step and wait cause. B6: the timer line also prints during a pass
 * (a grouped publish parked in preparation never returns to the drain loop),
 * from a bounded read of the source's head claim, and never while commits flow.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { preparationConfigView } from '../src/core/persistence/config-snapshot.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { drainClaimOf, drainJsonFields, drainNext, engineStallProbe, formatDrainSummary, runDrain, STALL_GRACE_MS, syncOutcome, type DrainClaim, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const pending = (index: number, requestId = '00000000-0000-0000-0000-000000000001', total = 10): SyncResult => ({ ...base, status: 'partial', reason: 'writer_pending', managedCursor: { index, total },
  managedWrite: { source_id: 's', slug: 'p', path: 'p.md', write_error: 'write_pending', reason: 'write_pending', message: 'm', suggestion: 's',
    write_request: { request_id: requestId, state: 'queued', retry_after_ms: 0 } as never } });
const done = (total = 10): SyncResult => ({ ...base, managedCursor: { index: total, total } });
const RESUME = 'gbrain sync --source s --no-pull';
const stall = { request_id: 'r', state: 'queued', blocked_reason: null, head_request_id: 'h', head_state: 'running', claimable_here: false, owner_is_this_host: true };
const claim = (over: Partial<DrainClaim> = {}): DrainClaim => ({ phase: 'preparing', step: 'origin_check', waiting_on: 'db', step_age_ms: 45_000, claim_age_ms: 50_000, lapsed: false,
  owner_pid: null, owner_kind: null, owner_nonce: null, last_sql: null, allowance_ms: 150_000, ceiling_ms: 600_000, ...over });
const probeWith = (c: DrainClaim | null, key = 'same', extra: Partial<StallProbe> = {}): StallProbe => ({ blockedHead: async () => null, fingerprint: async () => ({ key, stall, claim: c }), ...extra });
const foreign = { ...stall, owner_is_this_host: false };
const foreignProbe = (c: DrainClaim | null): StallProbe => ({ blockedHead: async () => null, fingerprint: async () => ({ key: 'same', stall: foreign, claim: c }) });

describe('claim-aware no-progress window', () => {
  test('a healthy preparation longer than the 30 s window and shorter than its budget is not cut off', async () => {
    let passes = 0;
    const started = Date.now();
    const result = await runDrain({ pass: async () => (++passes < 12 ? pending(2) : done()), probe: probeWith(claim()), pauseMs: 5, stallMs: 20 });
    // Twelve passes over more than the 20 ms window: the plain rule would have stopped it as drain_stalled at the fourth pass.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 12 });
  });

  test('a live preparation past its allowance, owned on another host, stops blocked as drain_stalled with cause, step and wait cause', async () => {
    const result = await runDrain({ pass: async () => pending(2), probe: foreignProbe(claim({ step_age_ms: 160_000, owner_pid: process.pid + 1, owner_kind: 'serve' })), pauseMs: 1, stallMs: 20 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
      stall: { cause: 'preparation_overdue', step: 'origin_check', waiting_on: 'db', phase: 'preparing', stalled_seconds: 160, owner_pid: process.pid + 1, owner_kind: 'serve' } });
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: 'gbrain sources writer status s', safe_to_loop: false, docs: 'docs/guides/write-refusals.md#drain-stalled', code: 'drain_stalled', cause: 'preparation_overdue' });
    expect(next.why).toContain('stuck at step origin_check, waiting on db');
    expect(next.why).toContain('renewing the claim past the preparation budget');
    expect(formatDrainSummary(result, RESUME, 's').join('\n')).toContain('step=origin_check, waiting_on=db, cause=preparation_overdue');
  });

  describe('#6317 (B2, T2): a same-host owner that renews a preparing claim forever', () => {
    const other = { owner_pid: process.pid + 1, owner_kind: 'serve', owner_nonce: 'other-nonce', last_sql: { label: 'SELECT pages', age_ms: 155_000 } };

    test('past the allowance but inside the ceiling the drain keeps running (the containment, not a blocked exit) and the stall line names the owner and the triple', async () => {
      const err = captureStderr();
      try {
        let passes = 0;
        // Eight passes past the 150 s allowance: before #6317 the fourth pass stopped the drain as drain_stalled / preparation_overdue.
        const result = await runDrain({ announce: true, progressMs: 30, pass: async () => { await new Promise(r => setTimeout(r, 12)); return ++passes < 8 ? pending(2) : done(); },
          probe: probeWith(claim({ step_age_ms: 160_000, claim_age_ms: 165_000, ...other })), pauseMs: 1, stallMs: 20 });
        expect(result.drain).toMatchObject({ outcome: 'synced', passes: 8 });
        expect(err.stalled().length).toBeGreaterThanOrEqual(1);
        expect(err.stalled()[0]).toContain('stalled 160s on origin_check (waiting on db) · held by serve pid ' + (process.pid + 1) + ' · last_sql SELECT pages 155s ago · past the 2m30s allowance; the root is freed at the 10m00s ceiling');
      } finally { err.restore(); }
    });

    test('past the ceiling it stops drain_stalled / owner_wedged_here naming the owner pid, within 2x the window, with the restart as the fix', async () => {
      const started = Date.now();
      const result = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ step_age_ms: 600_000, claim_age_ms: 610_000, ...other })), pauseMs: 1, stallMs: 20 });
      expect(Date.now() - started).toBeLessThan(2 * 20 + 500);
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', retry_after_ms: 0,
        stall: { cause: 'owner_wedged_here', owner_pid: process.pid + 1, owner_kind: 'serve', owner_nonce: 'other-nonce', step: 'origin_check', waiting_on: 'db', past_ceiling: true, ceiling_ms: 600_000, last_sql: { label: 'SELECT pages' } } });
      const next = drainNext(result, RESUME, 's')!;
      expect(next).toMatchObject({ code: 'drain_stalled', cause: 'owner_wedged_here', safe_to_loop: false, retry_after_ms: 0, command: 'gbrain sources writer status --source s --json' });
      expect(next.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'host_admin' });
      expect(next.fix!.user_message).toContain(`pid ${process.pid + 1}`);
      expect(next.why).toContain(`held by the serve pid ${process.pid + 1} on this host, past the 10m00s ceiling`);
      expect(formatDrainSummary(result, RESUME, 's').join('\n')).toContain(`last_sql=SELECT pages (155s ago), cause=owner_wedged_here, owner=serve pid ${process.pid + 1}`);
      expect(drainJsonFields(result, RESUME, 's')).toMatchObject({ outcome: 'blocked', next: { fix: { next: 'tell_user_to_run' } } });
    });

    test('an owner whose heartbeat row is wedged stops the drain before the ceiling with retry_after_ms to it and a rerunnable fix (safe to loop)', async () => {
      const owner = async () => ({ kind: 'serve', pid: process.pid + 1, nonce: 'other-nonce', mode: 'full', live: true, restart_required: true, root_barrier_age_ms: null });
      const result = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ step_age_ms: 160_000, claim_age_ms: 200_000, ...other }), 'same', { owner }), pauseMs: 1, stallMs: 20 });
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'owner_wedged_here', past_ceiling: false, owner_row: { restart_required: true } } });
      expect(result.drain!.retry_after_ms).toBeGreaterThan(390_000);
      expect(result.drain!.retry_after_ms).toBeLessThanOrEqual(400_000);
      const next = drainNext(result, RESUME, 's')!;
      expect(next).toMatchObject({ safe_to_loop: true, command: RESUME, cause: 'owner_wedged_here' });
      // `wait` derives only from a provider actor (agent-output.ts deriveNext); a wedged owner is not one, so the agent reruns after retry_after_ms.
      expect(next.fix).toMatchObject({ next: 'run', actor: 'agent', command: RESUME });
      expect(next.fix!.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 's', '--json']);
      expect(next.why).toContain('reports restart_required');
      // A live, healthy row keeps the drain running.
      let passes = 0;
      const healthy = async () => ({ ...await owner(), restart_required: false, root_barrier_age_ms: 10_000 });
      const kept = await runDrain({ pass: async () => (++passes < 8 ? pending(2) : done()), probe: probeWith(claim({ step_age_ms: 160_000, claim_age_ms: 200_000, ...other }), 'same', { owner: healthy }), pauseMs: 1, stallMs: 20 });
      expect(kept.drain).toMatchObject({ outcome: 'synced', passes: 8 });
    });

    test('a stamp with this pid but another nonce is another process (pid reuse), never preparation_abandoned', async () => {
      const result = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ step_age_ms: 700_000, claim_age_ms: 700_000, owner_pid: process.pid, owner_nonce: 'not-ours', owner_kind: 'sync' })), pauseMs: 1, stallMs: 20 });
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'owner_wedged_here', owner_pid: process.pid } });
    });

    test('a lapsed head a consumer here can reclaim gets exactly one extra window, then drain_stalled / owner_missing; without one it stops at once', async () => {
      let reclaimable = true;
      const probe = probeWith(claim({ lapsed: true, step_age_ms: 5_000 }), 'same', { reclaimableHere: async () => reclaimable });
      const startedAt = Date.now();
      const extended = await runDrain({ pass: async () => pending(2), probe, pauseMs: 1, stallMs: 40 });
      const endedAt = Date.now();
      expect(extended.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'owner_missing' } });
      // Two windows of 40 ms (three passes each at least), not one. Each window runs from the probe after a pass, so the bound is on the drain's wall time, not on pass timestamps.
      expect(endedAt - startedAt).toBeGreaterThanOrEqual(80);
      expect(extended.drain!.passes).toBeGreaterThanOrEqual(6);
      reclaimable = false;
      const at = Date.now();
      const immediate = await runDrain({ pass: async () => pending(2), probe, pauseMs: 1, stallMs: 40 });
      expect(immediate.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'owner_missing' } });
      expect(Date.now() - at).toBeLessThan(80 + 300);
      expect(drainNext(immediate, RESUME, 's')!.why).toContain('no consumer here reclaimed it');
    });
  });

  test('a preparation this process owns past its allowance ends the drain resumable as preparation_abandoned (exit 0, safe to loop)', async () => {
    const result = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ step_age_ms: 200_000, owner_pid: process.pid })), pauseMs: 1, stallMs: 20 });
    expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'preparation_abandoned', stall: { cause: 'preparation_overdue', step: 'origin_check' } });
    expect(syncOutcome(result)).toBe('resumable');
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: RESUME, safe_to_loop: true, docs: 'docs/guides/write-refusals.md#drain-preparation-abandoned' });
    expect(next.why).toContain('outran its budget in this process');
    expect(drainJsonFields(result, RESUME, 's')).toMatchObject({ outcome: 'resumable', next: { safe_to_loop: true } });
  });

  test('a lapsed claim (owner missing) keeps the plain window and names the cause; an unstamped head keeps today\'s rule', async () => {
    const lapsed = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ lapsed: true, step_age_ms: 5_000 })), pauseMs: 1, stallMs: 20 });
    expect(lapsed.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'owner_missing', step: 'origin_check' } });
    expect(drainNext(lapsed, RESUME, 's')!.why).toContain('its claim lapsed');
    const unstamped = await runDrain({ pass: async () => pending(2), probe: probeWith(null), pauseMs: 1, stallMs: 20 });
    expect(unstamped.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', step: null } });
    expect(unstamped.drain!.passes).toBeGreaterThanOrEqual(4);
  });

  test('an overdue publication is detected separately from an overdue preparation', async () => {
    const result = await runDrain({ pass: async () => pending(2), probe: probeWith(claim({ phase: 'publishing', step: 'apply', step_age_ms: 400_000, owner_pid: process.pid })), pauseMs: 1, stallMs: 20 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'publication_overdue', phase: 'publishing', step: 'apply' } });
  });

  test('a tripped breaker ends the drain blocked as preparation_systemic with writer status as the next command', async () => {
    const tripped: SyncResult = { ...base, status: 'blocked_by_failures', failedFiles: 1, failureCodes: [{ code: 'preparation_stalled', count: 5 }],
      breaker: { code: 'preparation_systemic', rule: 'consecutive', stalled: 5, consecutive: 5, step: 'knowledge_publication', request_id: 'r5',
        fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 's', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'w' } } };
    const result = await runDrain({ pass: async () => tripped, pauseMs: 1 });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'preparation_systemic' });
    expect(syncOutcome(result)).toBe('blocked');
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: 'gbrain sources writer status --source s --json', safe_to_loop: false, docs: 'docs/guides/write-refusals.md#preparation_systemic' });
    expect(next.why).toContain('5 writes of this sync could not finish preparing at step knowledge_publication (5 in a row');
    expect(ERROR_CATALOGUE.sync_drain_preparation_systemic.code).toBe('preparation_systemic');
    expect(ERROR_CATALOGUE.sync_drain_preparation_abandoned.code).toBe('preparation_abandoned');
  });
});

describe('drainClaimOf', () => {
  const budgets = { syncMs: 120_000, maintenanceMs: 120_000, ceilingMs: 600_000 };
  const now = Date.parse('2026-10-07T12:00:00Z');
  const stamp = (over: Record<string, unknown> = {}) => ({ phase: 'preparing', claimed_at: '2026-10-07T11:58:00Z', since: '2026-10-07T11:59:00Z', token: 't', ...over });

  test('reads this claim\'s stamp: phase, step, wait cause, ages, pid and the allowance from the head\'s budget plus grace', () => {
    // The stamp claim-phase.ts writes: the pid lives under `owner`, and the step has its own `step_since`.
    const c = drainClaimOf({ head_state: 'running', head_claim_phase: stamp({ step: 'origin_check', step_since: '2026-10-07T11:59:30Z', waiting_on: 'pool', owner: { kind: 'sync', pid: 4242, version: '0.60.109.0' } }),
      head_token: 't', head_lapsed: false, head_kind: 'managed_sync_import' }, budgets, now);
    expect(c).toEqual({ phase: 'preparing', step: 'origin_check', waiting_on: 'pool', step_age_ms: 30_000, claim_age_ms: 120_000, lapsed: false, owner_pid: 4242, owner_kind: 'sync', owner_nonce: null, last_sql: null,
      allowance_ms: 120_000 + STALL_GRACE_MS, ceiling_ms: 600_000 });
    // #6317: the nonce and the last statement ride the stamp when the owner recorded them.
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: stamp({ owner: { kind: 'serve', pid: 7, version: 'v', nonce: 'n1' }, last_sql: { label: 'SELECT pages', at: '2026-10-07T11:59:50Z' } }),
      head_token: 't', head_lapsed: false, head_kind: 'managed_sync_import' }, budgets, now)).toMatchObject({ owner_pid: 7, owner_kind: 'serve', owner_nonce: 'n1', last_sql: { label: 'SELECT pages', age_ms: 10_000 } });
    // A stamp without `step_since` falls back to the phase's `since`; a pre-release top-level `pid` is still read.
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: stamp({ step: 'origin_check', pid: 4243 }), head_token: 't', head_lapsed: false, head_kind: 'managed_sync_import' }, budgets, now))
      .toMatchObject({ step_age_ms: 60_000, owner_pid: 4243 });
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: JSON.stringify(stamp({ phase: 'publishing' })), head_token: 't', head_lapsed: false, head_kind: 'put_page' }, { ...budgets, maintenanceMs: 300_000 }, now))
      .toMatchObject({ phase: 'publishing', step: null, waiting_on: 'unknown', allowance_ms: 300_000 + STALL_GRACE_MS });
    // The ceiling caps the allowance.
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: stamp(), head_token: 't', head_lapsed: false, head_kind: 'managed_sync_import' }, { ...budgets, ceilingMs: 60_000 }, now)!.allowance_ms).toBe(60_000 + STALL_GRACE_MS);
  });

  test('an older owner\'s stamp, a stamp of another claim, or no stamp read as null/unknown, never inferred; a lapsed lease is reported', () => {
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: stamp({ token: 'other' }), head_token: 't', head_lapsed: false, head_kind: null }, budgets, now))
      .toMatchObject({ phase: null, step: null, waiting_on: null, step_age_ms: null, owner_pid: null, lapsed: false });
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: null, head_token: 't', head_lapsed: true, head_kind: null }, budgets, now)).toMatchObject({ phase: null, lapsed: true });
    expect(drainClaimOf({ head_state: 'queued', head_claim_phase: stamp(), head_token: 't', head_lapsed: false, head_kind: null }, budgets, now)).toBeNull();
    expect(drainClaimOf({ head_state: 'running', head_claim_phase: stamp({ waiting_on: 'lock' }), head_token: 't', head_lapsed: false, head_kind: null }, budgets, now)!.waiting_on).toBe('unknown');
  });
});

describe('engineStallProbe fingerprint', () => {
  let engine: BrainEngine;
  beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('forced probe: lease renewals (updated_at, claim_expires_at) do not change the key; a step change does', async () => {
    const id = `probe-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, `/tmp/${id}`]);
    const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
    const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
    const token = randomUUID(), requestId = randomUUID();
    const stampOf = (step: string) => JSON.stringify({ phase: 'preparing', claimed_at: new Date(Date.now() - 90_000).toISOString(), since: new Date(Date.now() - 60_000).toISOString(), token, step, step_since: new Date(Date.now() - 60_000).toISOString(), waiting_on: 'db', owner: { kind: 'sync', pid: process.pid, version: 'test' } });
    const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,
        state,execution_token,claim_expires_at,claim_phase)
      VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,'notes/p',$4::uuid,'d','{}'::jsonb,'{"kind":"managed_sync_import","path":"notes/p.md"}'::jsonb,1,16384,'running',$5::uuid,now()+interval '30 seconds',$6::text::jsonb)
      RETURNING id::text AS id`, [requestId, id, src!.incarnation, wt!.id, token, stampOf('origin_check')]);
    const probe = engineStallProbe(engine);
    const result = pending(1, row!.id);
    const first = (await probe.fingerprint(result))!;
    expect(first.claim).toMatchObject({ phase: 'preparing', step: 'origin_check', waiting_on: 'db', lapsed: false, owner_pid: process.pid, allowance_ms: 120_000 + STALL_GRACE_MS });
    expect(first.claim!.step_age_ms).toBeGreaterThanOrEqual(59_000);
    // A renewal: the lease columns move, the key does not.
    await engine.executeRaw("UPDATE persistence_requests SET updated_at=now()+interval '1 second',claim_expires_at=now()+interval '40 seconds' WHERE id=$1::uuid", [row!.id]);
    expect((await probe.fingerprint(result))!.key).toBe(first.key);
    // The owner reaches the next step: the key changes.
    await engine.executeRaw('UPDATE persistence_requests SET claim_phase=$2::text::jsonb WHERE id=$1::uuid', [row!.id, stampOf('knowledge_publication')]);
    const second = (await probe.fingerprint(result))!;
    expect(second.key).not.toBe(first.key);
    expect(second.claim!.step).toBe('knowledge_publication');
    // The lease lapses: the claim reads lapsed and the key changes again.
    await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=$1::uuid", [row!.id]);
    const lapsed = (await probe.fingerprint(result))!;
    expect(lapsed.claim!.lapsed).toBe(true);
    expect(lapsed.key).not.toBe(second.key);
  });
});

/** Captures the drain's stderr lines (`serr` writes through console.error without a source prefix). */
function captureStderr(): { lines: string[]; stalled: () => string[]; stalledAt: () => Array<{ line: string; at: number }>; restore(): void } {
  const lines: string[] = [], at: number[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); at.push(Date.now()); });
  const stalledAt = () => lines.flatMap((line, i) => line.includes('· stalled ') ? [{ line, at: at[i]! }] : []);
  return { lines, stalled: () => stalledAt().map(entry => entry.line), stalledAt, restore: () => spy.mockRestore() };
}
/** One head read of the stall probe: when it started and when it settled (the line it feeds prints right after it settles). */
interface HeadRead { startedAt: number; settledAt: number }
/** Wraps a probe's `head` so every read's start and settle times are kept, in settle order. */
function headReadsOf(probe: StallProbe): { probe: StallProbe; list: HeadRead[] } {
  const list: HeadRead[] = [];
  const head = probe.head;
  if (!head) return { probe, list };
  return { list, probe: { ...probe, head: async () => {
    const startedAt = Date.now();
    try { return await head(); } finally { list.push({ startedAt, settledAt: Date.now() }); }
  } } };
}
/**
 * The stall lines that belong to the park: each line is attributed to the latest head read settled at or before it was
 * printed, and counts only when that read started after `parkedAt`. A read in flight across the stamp shows the state
 * before it (a true "preparing" line), so counting lines by position misattributes it to the park.
 */
function parkedStallLines(lines: ReadonlyArray<{ line: string; at: number }>, reads: ReadonlyArray<HeadRead>, parkedAt: number): string[] {
  if (!parkedAt) return [];
  return lines.flatMap(({ line, at }) => {
    const read = [...reads].reverse().find(entry => entry.settledAt <= at);
    return read && read.startedAt >= parkedAt ? [line] : [];
  });
}
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return check(); };
const committed = { phase: 'managed_sync.page_committed' } as Parameters<NonNullable<Parameters<typeof runDrain>[0]['onProgress']>>[0];

describe('live stall line during a pass (B6)', () => {
  const PROGRESS = 200;
  const headProbe = (head: StallProbe['head']): StallProbe => ({ blockedHead: async () => null, fingerprint: async () => null, head });

  test('while commits flow nothing prints; once they stop, the head claim is read and named; an empty head prints nothing', async () => {
    const err = captureStderr();
    try {
      let reads = 0;
      const head: StallProbe['head'] = async () => { reads++; return { head_state: 'running', claim: claim({ step_age_ms: 42_000 }) }; };
      // A wider interval here, so a loaded runner's timer gap between 75 ms commits never reads as a stall.
      const every = 500;
      await runDrain({ announce: true, progressMs: every, probe: headProbe(head), pass: async (_signal, onProgress) => {
        // Commits every 75 ms for three intervals: the ticker never reads the head and never prints a stall.
        for (let i = 0; i < 20; i++) { onProgress({ ...committed, total: 30, bankedFiles: i + 1 }); await new Promise(r => setTimeout(r, 75)); }
        expect(err.stalled()).toEqual([]);
        expect(reads).toBe(0);
        // Then nothing commits: within about two intervals the line names the head's step, wait cause, stall age and allowance.
        expect(await until(() => err.stalled().length > 0, 4 * every)).toBe(true);
        return done(30);
      } });
      expect(err.stalled()[0]).toBe('[sync] 20/30 processed · stalled 42s on origin_check (waiting on db) · allowed 2m30s');
      // Rate-limited to one line per interval.
      expect(err.stalled()).toHaveLength(1);
      err.lines.length = 0;
      await runDrain({ announce: true, progressMs: PROGRESS, probe: headProbe(async () => null), pass: async () => { await new Promise(r => setTimeout(r, 4 * PROGRESS)); return done(); } });
      expect(err.stalled()).toEqual([]);
    } finally { err.restore(); }
  });

  test('a head read that rejects or hangs never escapes the ticker or stacks; announce off never reads', async () => {
    const err = captureStderr();
    try {
      let reads = 0;
      const rejecting = await runDrain({ announce: true, progressMs: PROGRESS, probe: headProbe(async () => { reads++; throw new Error('lock timeout'); }),
        pass: async () => { await new Promise(r => setTimeout(r, 4 * PROGRESS)); return done(); } });
      expect(rejecting.drain?.outcome).toBe('synced');
      expect(reads).toBeGreaterThanOrEqual(1);
      reads = 0;
      await runDrain({ announce: true, progressMs: PROGRESS, probe: headProbe(() => { reads++; return new Promise(() => {}); }),
        pass: async () => { await new Promise(r => setTimeout(r, 5 * PROGRESS)); return done(); } });
      expect(reads).toBe(1);
      reads = 0;
      await runDrain({ announce: false, progressMs: PROGRESS, probe: headProbe(async () => { reads++; return null; }),
        pass: async () => { await new Promise(r => setTimeout(r, 3 * PROGRESS)); return done(); } });
      expect(reads).toBe(0);
      expect(err.stalled()).toEqual([]);
    } finally { err.restore(); }
  });

  describe('forced probe: a real managed sync parked in preparation', () => {
    // PGLite parks the single-write path; Postgres (DATABASE_URL set) parks a member of the grouped publish, the reporter's case.
    const engines: BrainEngine[] = [];
    let closePostgres: (() => Promise<void>) | undefined;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-drain-live-'));
    beforeAll(async () => {
      if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
      if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
    }, 120_000);
    afterAll(async () => {
      installFaultHook(undefined);
      for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
      await closePostgres?.(); rmSync(home, { recursive: true, force: true });
    });

    test('forced probe: a head read in flight across the park stamp prints a true "preparing" line that is not the park\'s first line', () => {
      // The master flake (#6271's unit-lane arm): read 1 starts before the stamp, settles after it, and its line prints after
      // the park snapshot. Counting lines by position took that line as the parked member's; attributing by read start does not.
      const parkedAt = 1_000;
      const reads: HeadRead[] = [{ startedAt: 990, settledAt: 1_005 }, { startedAt: 1_010, settledAt: 1_020 }];
      const lines = [{ line: '[sync] 1/3 processed · stalled 0s on preparing', at: 1_006 }, { line: '[sync] 1/3 processed · stalled 1s on origin_check (waiting on db) · allowed 2m', at: 1_021 }];
      const byPosition = lines.map(entry => entry.line);
      expect(byPosition[0]).toMatch(/on preparing$/);
      expect(parkedStallLines(lines, reads, parkedAt)).toEqual([lines[1]!.line]);
      // A line before the park, or with no settled read behind it, is never the park's.
      expect(parkedStallLines([{ line: lines[0]!.line, at: 900 }], reads, parkedAt)).toEqual([]);
      expect(parkedStallLines(lines, [], parkedAt)).toEqual([]);
      expect(parkedStallLines(lines, reads, 0)).toEqual([]);
    });

    test('the line names the parked member\'s step within about two intervals, then the sync finishes once it is released', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
      for (const engine of engines) {
        const id = `live-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
        const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        mkdirSync(join(root, 'notes'), { recursive: true });
        git('init', '-q');
        for (const name of ['a', 'b', 'c']) writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\nA synthetic observation about ${name}.\n`);
        git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
        await claimWorktree(engine, id, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let parkedAt = 0;
        const err = captureStderr();
        // A stall line comes from a head read; only a read that started after the park can show the parked member's stamp.
        // A read started before the stamp committed and settled after it prints a true-at-read-time "preparing" line, so the
        // lines are attributed to their read's start, never counted by position (#6355 fold-in: the master flake on #6271).
        const probe = engineStallProbe(engine, id);
        const reads = headReadsOf(probe);
        const parkedLines = () => parkedStallLines(err.stalledAt(), reads.list, parkedAt);
        // The first member parks in preparation, honouring its signal; the stamp gains the step a preparer would enter (the keys a renewal writes).
        installFaultHook(async (at, detail) => {
          if (at !== 'consumer:preparing' || detail.sourceId !== id || parkedAt) return;
          await engine.executeRaw(`UPDATE persistence_requests SET claim_phase = claim_phase || '{"step":"origin_check","waiting_on":"db"}'::jsonb WHERE request_id=$1::uuid`, [detail.requestId]);
          parkedAt = Date.now();
          await new Promise<void>(resolve => { void released.then(resolve); detail.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        });
        try {
          const bulk = await resolveBulkSettings(await preparationConfigView(engine), false);
          expect(bulk.enabled).toBe(engine.kind === 'postgres');
          const drain = runDrain({ announce: true, progressMs: PROGRESS, probe: reads.probe, bulk: { enabled: bulk.enabled, reason: bulk.reason },
            pass: (signal, onProgress) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, signal, onProgress, ...(bulk.enabled ? { bulk } : {}) }) });
          expect(await until(() => parkedAt > 0, 30_000)).toBe(true);
          const seen = await until(() => parkedLines().length > 0, 10 * PROGRESS);
          const seenAfterMs = Date.now() - parkedAt;
          release();
          const result = await drain;
          expect(seen).toBe(true);
          expect(seenAfterMs).toBeLessThanOrEqual(2 * PROGRESS + 400);
          expect(parkedLines()[0]).toMatch(/^\[sync\] \d+\/3 processed · stalled \d+s on origin_check \(waiting on db\) · allowed \d/);
          // One pass: the stall never returned to the drain loop, so only the live read could have named it.
          expect(result.drain).toMatchObject({ outcome: 'synced', written: 3, passes: 1 });
          if (bulk.enabled) expect(result.drain!.bulk!.grouped_pages).toBeGreaterThan(0);
          expect(await engine.getPage('notes/a', { sourceId: id })).not.toBeNull();
        } finally { err.restore(); release(); installFaultHook(undefined); await disposePersistenceConsumer(engine); }
      }
    }), 120_000);
  });
});
