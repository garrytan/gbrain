/**
 * Queue admission control (five-issue fix wave, commit 5): param-coalescing,
 * waiting-TTL sweep, and the name-global quota. Covers the four
 * outside-voice-hardened invariants:
 *   - owner lanes never cross (hash INCLUDES __owner_client_id),
 *   - parented submits never coalesce (aggregator bookkeeping),
 *   - coalescing is age-bounded to ttl/2 (a fresh submit must not coalesce
 *     onto a nearly-expired row and die an hour later),
 *   - TTL cancellation flows through cancelJobs (descendants + child_done +
 *     parent resolution) and writes the reason error_text every alerting
 *     surface keys on.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  computeParamHash,
  QueueQuotaExceededError,
  runWaitingTtlTick,
  TTL_NOTICE_SHOWN_KEY,
  _resetAdmissionCacheForTest,
} from '../src/core/minions/admission.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

const SUB = { allowProtectedSubmit: true } as const;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  // Targeted reset (same posture as the other minion suites): wipe jobs +
  // inbox + this suite's config keys, but keep the schema-version row that
  // ensureSchema() checks.
  await engine.executeRaw(`DELETE FROM minion_inbox`, []);
  await engine.executeRaw(`DELETE FROM minion_jobs`, []);
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'minions.%'`, []);
  _resetAdmissionCacheForTest();
});

async function backdate(id: number, hours: number): Promise<void> {
  // Both timestamps: the TTL sweep + coalesce age-bound key on updated_at
  // (a requeue refreshes the TTL window); getStats oldest-wait uses created_at.
  await engine.executeRaw(
    `UPDATE minion_jobs SET created_at = now() - ($2 * interval '1 hour'),
                            updated_at = now() - ($2 * interval '1 hour') WHERE id = $1`,
    [id, hours],
  );
}

describe('computeParamHash', () => {
  test('stable across key order, excludes only __param_hash', () => {
    const a = computeParamHash({ prompt: 'p', model: 'm', nested: { x: 1, y: 2 } });
    const b = computeParamHash({ model: 'm', nested: { y: 2, x: 1 }, prompt: 'p' });
    expect(a).toBe(b);
    expect(computeParamHash({ prompt: 'p', __param_hash: 'stale' })).toBe(computeParamHash({ prompt: 'p' }));
  });

  test('__owner_client_id is INCLUDED — owner lanes hash differently', () => {
    const a = computeParamHash({ prompt: 'p', __owner_client_id: 'client-a' });
    const b = computeParamHash({ prompt: 'p', __owner_client_id: 'client-b' });
    expect(a).not.toBe(b);
  });
});

describe('param-coalescing (subagent default-on)', () => {
  test('identical parentless submit coalesces onto the waiting row', async () => {
    const first = await queue.add('subagent', { prompt: 'daily digest', model: 'anthropic:claude-sonnet-5' }, {}, SUB);
    expect(first.coalesced).not.toBe(true);
    expect((first.data as Record<string, unknown>).__param_hash).toBeDefined();

    const second = await queue.add('subagent', { prompt: 'daily digest', model: 'anthropic:claude-sonnet-5' }, {}, SUB);
    expect(second.id).toBe(first.id);
    expect(second.coalesced).toBe(true);

    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'subagent'`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  test('different prompts insert separate rows', async () => {
    const a = await queue.add('subagent', { prompt: 'task A' }, {}, SUB);
    const b = await queue.add('subagent', { prompt: 'task B' }, {}, SUB);
    expect(b.id).not.toBe(a.id);
    expect(b.coalesced).not.toBe(true);
  });

  test('identical prompts from different owner lanes never coalesce', async () => {
    const a = await queue.add('subagent', { prompt: 'same', __owner_client_id: 'client-a' }, {}, SUB);
    const b = await queue.add('subagent', { prompt: 'same', __owner_client_id: 'client-b' }, {}, SUB);
    expect(b.id).not.toBe(a.id);
  });

  test('a RUNNING identical job does not suppress a re-run (waiting-only)', async () => {
    const first = await queue.add('subagent', { prompt: 'rerun me' }, {}, SUB);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_until = now() + interval '5 minutes' WHERE id = $1`,
      [first.id],
    );
    const second = await queue.add('subagent', { prompt: 'rerun me' }, {}, SUB);
    expect(second.id).not.toBe(first.id);
  });

  test('EMPTY payloads never coalesce (no dedupe signal — scaffolding/placeholder jobs stay distinct)', async () => {
    const a = await queue.add('subagent', {}, {}, SUB);
    const b = await queue.add('subagent', {}, {}, SUB);
    expect(b.id).not.toBe(a.id);
    expect((a.data as Record<string, unknown>).__param_hash).toBeUndefined();
  });

  test('parented submits never coalesce (fanout children belong to their parent)', async () => {
    const parent = await queue.add('subagent_aggregator', { kind: 'agg' }, {}, SUB);
    const c1 = await queue.add('subagent', { prompt: 'chunk' }, { parent_job_id: parent.id }, SUB);
    const c2 = await queue.add('subagent', { prompt: 'chunk' }, { parent_job_id: parent.id }, SUB);
    expect(c2.id).not.toBe(c1.id);
  });

  test('age-bounded: a near-TTL waiting row is not a coalesce target', async () => {
    const first = await queue.add('subagent', { prompt: 'old intent' }, {}, SUB);
    await backdate(first.id, 47); // TTL default 48h → bound is 24h
    const second = await queue.add('subagent', { prompt: 'old intent' }, {}, SUB);
    expect(second.id).not.toBe(first.id);
  });

  test('kill-switch GBRAIN_MINIONS_ADMISSION=0 disables coalescing', async () => {
    await withEnv({ GBRAIN_MINIONS_ADMISSION: '0' }, async () => {
      _resetAdmissionCacheForTest();
      const a = await queue.add('subagent', { prompt: 'killed' }, {}, SUB);
      const b = await queue.add('subagent', { prompt: 'killed' }, {}, SUB);
      expect(b.id).not.toBe(a.id);
    });
    _resetAdmissionCacheForTest(); // don't leak the killed-policy cache to later tests
  });

  test('config off-switch minions.coalesce_params.subagent=false disables it', async () => {
    await engine.setConfig('minions.coalesce_params.subagent', 'false');
    _resetAdmissionCacheForTest();
    const a = await queue.add('subagent', { prompt: 'cfg-off' }, {}, SUB);
    const b = await queue.add('subagent', { prompt: 'cfg-off' }, {}, SUB);
    expect(b.id).not.toBe(a.id);
  });

  test('opt-in for a non-default name via coalesce_params submit option', async () => {
    const a = await queue.add('shell', { command: 'echo hi' }, { coalesce_params: true }, SUB);
    const b = await queue.add('shell', { command: 'echo hi' }, { coalesce_params: true }, SUB);
    expect(b.id).toBe(a.id);
    expect(b.coalesced).toBe(true);
  });
});

describe('name-global quota (config-only, no shipped default)', () => {
  test('no quota configured → unlimited (D2C: default protection is the scream, not the cap)', async () => {
    for (let i = 0; i < 5; i++) {
      await queue.add('subagent', { prompt: `distinct ${i}` }, {}, SUB);
    }
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'subagent' AND status = 'waiting'`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(5);
  });

  test('configured quota rejects with a typed, actionable error', async () => {
    await engine.setConfig('minions.quota_max_waiting.subagent', '2');
    _resetAdmissionCacheForTest();
    await queue.add('subagent', { prompt: 'q1' }, {}, SUB);
    await queue.add('subagent', { prompt: 'q2' }, {}, SUB);
    let threw: unknown = null;
    try {
      await queue.add('subagent', { prompt: 'q3' }, {}, SUB);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(QueueQuotaExceededError);
    expect((threw as Error).message).toContain('minions.quota_max_waiting.subagent');
    expect((threw as QueueQuotaExceededError).code).toBe('quota_exceeded');
  });

  test('quota counts the name across ALL queues (private fanout queues cannot dodge it)', async () => {
    await engine.setConfig('minions.quota_max_waiting.subagent', '2');
    _resetAdmissionCacheForTest();
    await queue.add('subagent', { prompt: 'a' }, { queue: 'dream-inline-1' }, SUB);
    await queue.add('subagent', { prompt: 'b' }, { queue: 'dream-inline-2' }, SUB);
    await expect(
      queue.add('subagent', { prompt: 'c' }, { queue: 'dream-inline-3' }, SUB),
    ).rejects.toThrow('quota');
  });

  test('an identical submit coalesces BEFORE the quota check (dedupe is not rejection)', async () => {
    await engine.setConfig('minions.quota_max_waiting.subagent', '2');
    _resetAdmissionCacheForTest();
    const a = await queue.add('subagent', { prompt: 'same one' }, {}, SUB);
    await queue.add('subagent', { prompt: 'other' }, {}, SUB);
    // At quota. An IDENTICAL re-submit must return the existing row, not throw.
    const again = await queue.add('subagent', { prompt: 'same one' }, {}, SUB);
    expect(again.id).toBe(a.id);
    expect(again.coalesced).toBe(true);
  });
});

describe('waiting-TTL sweep (handleWaitingTTL via cancelJobs)', () => {
  test('cancels waiting rows past TTL with the reason error_text; young rows untouched', async () => {
    const old = await queue.add('subagent', { prompt: 'ancient' }, {}, SUB);
    const young = await queue.add('subagent', { prompt: 'fresh' }, {}, SUB);
    await backdate(old.id, 49);

    const { cancelled, by_name } = await queue.handleWaitingTTL();
    expect(cancelled).toBe(1);
    expect(by_name.subagent).toBe(1);

    const oldRow = await queue.getJob(old.id);
    expect(oldRow?.status).toBe('cancelled');
    expect(oldRow?.error_text).toContain('waiting_ttl_expired');
    expect(oldRow?.finished_at).toBeTruthy();
    const youngRow = await queue.getJob(young.id);
    expect(youngRow?.status).toBe('waiting');
  });

  test('active and delayed rows are never TTL-cancelled', async () => {
    const active = await queue.add('subagent', { prompt: 'running' }, {}, SUB);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_until = now() + interval '5 minutes',
        created_at = now() - interval '100 hours' WHERE id = $1`,
      [active.id],
    );
    const { cancelled } = await queue.handleWaitingTTL();
    expect(cancelled).toBe(0);
    expect((await queue.getJob(active.id))?.status).toBe('active');
  });

  test('CRITICAL: TTL-cancelling a fanout child unblocks its waiting-children parent', async () => {
    const parent = await queue.add('subagent_aggregator', { kind: 'agg' }, {}, SUB);
    const child = await queue.add(
      'subagent',
      { prompt: 'doomed child' },
      { parent_job_id: parent.id, on_child_fail: 'continue' },
      SUB,
    );
    expect((await queue.getJob(parent.id))?.status).toBe('waiting-children');
    await backdate(child.id, 49);

    const { cancelled } = await queue.handleWaitingTTL();
    expect(cancelled).toBe(1);
    expect((await queue.getJob(child.id))?.status).toBe('cancelled');
    // The bookkeeping cancelJobs carries: parent resolves out of
    // waiting-children instead of wedging forever (the v128-raw-UPDATE trap).
    expect((await queue.getJob(parent.id))?.status).toBe('waiting');
    // And the child_done inbox message landed for the parent.
    const inbox = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_inbox WHERE job_id = $1`,
      [parent.id],
    );
    expect(parseInt(inbox[0].count, 10)).toBe(1);
  });

  test('per-tick cap bounds one sweep; the backlog drains across ticks oldest-first', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const j = await queue.add('subagent', { prompt: `stale ${i}` }, {}, SUB);
      await backdate(j.id, 50 + i);
      ids.push(j.id);
    }
    const tick1 = await queue.handleWaitingTTL({ maxPerTick: 2 });
    expect(tick1.cancelled).toBe(2);
    const tick2 = await queue.handleWaitingTTL({ maxPerTick: 2 });
    expect(tick2.cancelled).toBe(2);
    const tick3 = await queue.handleWaitingTTL({ maxPerTick: 2 });
    expect(tick3.cancelled).toBe(1);
    for (const id of ids) {
      expect((await queue.getJob(id))?.status).toBe('cancelled');
    }
  });

  test('minions.ttl_waiting_hours.subagent=0 disables the sweep for that name', async () => {
    await engine.setConfig('minions.ttl_waiting_hours.subagent', '0');
    const j = await queue.add('subagent', { prompt: 'protected' }, {}, SUB);
    await backdate(j.id, 500);
    const { cancelled } = await queue.handleWaitingTTL();
    expect(cancelled).toBe(0);
    expect((await queue.getJob(j.id))?.status).toBe('waiting');
  });

  test('config override listConfigKeys path: TTL applies to a non-default name', async () => {
    await engine.setConfig('minions.ttl_waiting_hours.shell', '1');
    const j = await queue.add('shell', { command: 'echo stale' }, {}, SUB);
    await backdate(j.id, 2);
    const { by_name } = await queue.handleWaitingTTL();
    expect(by_name.shell).toBe(1);
    expect((await queue.getJob(j.id))?.status).toBe('cancelled');
  });

  test('a TTL-cancelled row frees its idempotency key for a fresh submit', async () => {
    const first = await queue.add('subagent', { prompt: 'keyed' }, { idempotency_key: 'ttl-key-1' }, SUB);
    await backdate(first.id, 49);
    await queue.handleWaitingTTL();
    expect((await queue.getJob(first.id))?.status).toBe('cancelled');
    const fresh = await queue.add('subagent', { prompt: 'keyed' }, { idempotency_key: 'ttl-key-1' }, SUB);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.status).toBe('waiting');
  });
});

describe('getStats drain/depth extensions', () => {
  test('by_type carries drained_* split, waiting_now, and oldest_waiting_minutes', async () => {
    const done = await queue.add('subagent', { prompt: 'done one' }, {}, SUB);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', started_at = now() - interval '2 minutes',
        finished_at = now() - interval '1 minute' WHERE id = $1`,
      [done.id],
    );
    const ttlVictim = await queue.add('subagent', { prompt: 'shredded' }, {}, SUB);
    await backdate(ttlVictim.id, 49);
    await queue.handleWaitingTTL();
    const waiting = await queue.add('subagent', { prompt: 'still here' }, {}, SUB);
    await backdate(waiting.id, 3);

    const stats = await queue.getStats();
    const sub = stats.by_type.find(t => t.name === 'subagent');
    expect(sub).toBeDefined();
    expect(sub!.drained_completed).toBe(1);
    expect(sub!.drained_cancelled).toBe(1);
    expect(sub!.waiting_now).toBe(1);
    expect(sub!.oldest_waiting_minutes).toBeGreaterThanOrEqual(170); // ~3h
  });
});

describe('idempotency_key precedence over param-coalescing', () => {
  test('a keyed submit never param-coalesces onto an unkeyed identical row', async () => {
    // Producer-owned idempotency is the STRONGER contract: a param-coalesce
    // hit would return a row the key was never registered against, so a
    // later same-key submit would insert fresh and run the work twice.
    const unkeyed = await queue.add('subagent', { prompt: 'same work' }, {}, SUB);
    const keyed = await queue.add('subagent', { prompt: 'same work' }, { idempotency_key: 'key-precedence-1' }, SUB);
    expect(keyed.id).not.toBe(unkeyed.id);
    expect(keyed.coalesced).not.toBe(true);
    // And the keyed row carries no param hash — coalescing was disabled, not deferred.
    expect((keyed.data as Record<string, unknown>).__param_hash).toBeUndefined();
  });
});

describe('cancelJobs reason + rootStatuses (direct)', () => {
  test('reason sets error_text; no-reason cancel preserves pre-existing error_text', async () => {
    const a = await queue.add('subagent', { prompt: 'reason target' }, {}, SUB);
    const b = await queue.add('subagent', { prompt: 'prior-text holder' }, {}, SUB);
    await engine.executeRaw(`UPDATE minion_jobs SET error_text = 'prior failure detail' WHERE id = $1`, [b.id]);

    await queue.cancelJobs([a.id], { reason: 'explicit cancel reason' });
    await queue.cancelJobs([b.id]); // no reason → COALESCE keeps what was there

    const aRow = await queue.getJob(a.id);
    const bRow = await queue.getJob(b.id);
    expect(aRow?.status).toBe('cancelled');
    expect(aRow?.error_text).toBe('explicit cancel reason');
    expect(bRow?.status).toBe('cancelled');
    expect(bRow?.error_text).toBe('prior failure detail');
  });

  test('rootStatuses re-check: an active row in the batch is left running', async () => {
    const w = await queue.add('subagent', { prompt: 'still waiting' }, {}, SUB);
    const act = await queue.add('subagent', { prompt: 'claimed meanwhile' }, {}, SUB);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_until = now() + interval '5 minutes' WHERE id = $1`,
      [act.id],
    );
    const swept = await queue.cancelJobs([w.id, act.id], { reason: 'sweep', rootStatuses: ['waiting'] });
    expect(swept.some(j => j.id === w.id)).toBe(true);
    expect(swept.some(j => j.id === act.id)).toBe(false);
    expect((await queue.getJob(w.id))?.status).toBe('cancelled');
    expect((await queue.getJob(act.id))?.status).toBe('active');
  });
});

describe('runWaitingTtlTick warn-before-act gate (D1A)', () => {
  test('tick 1 = notice (counts affected, stamps ISO flag, cancels NOTHING); grace holds; sweep after grace', async () => {
    const victim = await queue.add('subagent', { prompt: 'expired long ago' }, {}, SUB);
    await backdate(victim.id, 49);

    // Tick 1: notice. Nothing cancelled, flag stamped with a timestamp.
    const t1 = await runWaitingTtlTick(engine, queue);
    expect(t1.phase).toBe('notice');
    expect(t1.affected).toBe(1);
    expect(t1.cancelled).toBe(0);
    expect((await queue.getJob(victim.id))?.status).toBe('waiting');
    const flag = await engine.getConfig(TTL_NOTICE_SHOWN_KEY);
    expect(Number.isFinite(Date.parse(flag ?? ''))).toBe(true);

    // Tick 2 inside the grace window: still nothing cancelled.
    const t2 = await runWaitingTtlTick(engine, queue);
    expect(t2.phase).toBe('grace');
    expect((await queue.getJob(victim.id))?.status).toBe('waiting');

    // Grace elapsed (env seam = 0ms): the sweep runs.
    await withEnv({ GBRAIN_MINIONS_TTL_NOTICE_GRACE_MS: '0' }, async () => {
      const t3 = await runWaitingTtlTick(engine, queue);
      expect(t3.phase).toBe('swept');
      expect(t3.cancelled).toBe(1);
    });
    const after = await queue.getJob(victim.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.error_text).toStartWith('waiting_ttl_expired');
  });

  test("legacy flag value 'true' (pre-grace releases) sweeps immediately", async () => {
    const victim = await queue.add('subagent', { prompt: 'legacy-flag victim' }, {}, SUB);
    await backdate(victim.id, 49);
    await engine.setConfig(TTL_NOTICE_SHOWN_KEY, 'true');
    const tick = await runWaitingTtlTick(engine, queue);
    expect(tick.phase).toBe('swept');
    expect((await queue.getJob(victim.id))?.status).toBe('cancelled');
  });

  test('kill-switch: GBRAIN_MINIONS_ADMISSION=0 does nothing, not even the notice', async () => {
    await withEnv({ GBRAIN_MINIONS_ADMISSION: '0' }, async () => {
      const tick = await runWaitingTtlTick(engine, queue);
      expect(tick.phase).toBe('killed');
    });
    expect(await engine.getConfig(TTL_NOTICE_SHOWN_KEY)).toBeNull();
  });
});
