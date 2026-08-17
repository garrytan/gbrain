/**
 * Two-phase tool ledger helpers (persistToolExecPending/Complete/Failed) —
 * #4155 raw-id semantics.
 *
 * After migration v131 dropped the job-wide UNIQUE (job_id, tool_use_id),
 * tool_use_id stores the RAW provider id and may repeat both across turns and
 * (defensively) within one turn. Pinned contracts:
 *
 * 1. Same-turn duplicate raw ids: each call keeps its own row (distinct
 *    ordinals), and complete/failed settlement lands on the call's OWN row —
 *    never a settled same-id sibling.
 * 2. Zombie-race downgrade guard: persistToolExecFailed's stable-id conflict
 *    update never downgrades an already-complete row, and never touches a
 *    conflicting row that belongs to a DIFFERENT tool_use_id.
 * 3. Legacy compatibility: a pre-existing ordinal=NULL row for the same
 *    (job_id, message_idx, tool_use_id) suppresses a re-insert (the old
 *    ON CONFLICT DO NOTHING semantics), and settlement still finds it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { __testing } from '../src/core/minions/handlers/subagent.ts';

const { persistToolExecPending, persistToolExecComplete, persistToolExecFailed } = __testing;

let engine: PGLiteEngine;
let queue: MinionQueue;
let jobId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM minion_jobs');
  const j = await queue.add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true });
  jobId = j.id;
});

async function rows(): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, ordinal, tool_use_id, tool_name, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
}

describe('persistToolExec* — same-turn duplicate raw ids (#4155)', () => {
  test('two calls sharing one raw id keep separate rows and settle on their own ordinal', async () => {
    await persistToolExecPending(engine, jobId, 1, 0, 'dup', 'search', { q: 'a' });
    await persistToolExecPending(engine, jobId, 1, 1, 'dup', 'put_page', { slug: 'b' });

    let r = await rows();
    expect(r.length).toBe(2); // the NOT EXISTS guard must not collapse stamped rows

    // Settle call 0 complete, then call 1 failed — each on its own row.
    await persistToolExecComplete(engine, jobId, 1, 0, 'dup', { hit: 'zero' });
    await persistToolExecFailed(engine, jobId, 1, 1, 'dup', 'put_page', { slug: 'b' }, 'one-broke');

    r = await rows();
    expect(r.length).toBe(2);
    expect(r[0].ordinal).toBe(0);
    expect(r[0].status).toBe('complete');
    expect(r[1].ordinal).toBe(1);
    expect(r[1].status).toBe('failed');
    expect(r[1].error).toBe('one-broke');
  });

  test('a late failure for one call never overwrites the settled same-id sibling', async () => {
    // Call 0 fully settled; call 1 (same raw id) fails without a pending row.
    await persistToolExecPending(engine, jobId, 1, 0, 'dup', 'search', { q: 'a' });
    await persistToolExecComplete(engine, jobId, 1, 0, 'dup', { hit: 'keep-me' });
    await persistToolExecFailed(engine, jobId, 1, 1, 'dup', 'search', { q: 'a' }, 'late-error');

    const r = await rows();
    expect(r.length).toBe(2);
    expect(r[0].status).toBe('complete'); // untouched
    expect(r[1].status).toBe('failed');
  });

  test('a failure for a call with no own row never captures a same-id sibling STILL-PENDING row', async () => {
    // Red-team finding: an `OR status = 'pending'` disjunct in the failed
    // UPDATE selected the sibling's in-flight row (different ordinal, same raw
    // id) when the failing call had no row of its own (e.g. unregistered
    // tool), marking the sibling failed with the wrong call's error and
    // skipping the INSERT leg.
    await persistToolExecPending(engine, jobId, 1, 0, 'dup', 'search', { q: 'a' });
    // Call 1 (same raw id, ordinal 1) is rejected upfront — no pending row.
    await persistToolExecFailed(engine, jobId, 1, 1, 'dup', 'bad_tool', {}, 'not in registry');

    const r = await rows();
    expect(r.length).toBe(2);
    expect(r[0].ordinal).toBe(0);
    expect(r[0].status).toBe('pending'); // sibling stays in flight, error-free
    expect(r[0].error).toBeNull();
    expect(r[1].ordinal).toBe(1);
    expect(r[1].status).toBe('failed'); // failure lands on its OWN row
    expect(r[1].error).toBe('not in registry');
  });
});

describe('persistToolExecFailed — stable-id conflict downgrade guard', () => {
  test('does not downgrade a complete row owned by a DIFFERENT tool_use_id at the same ordinal', async () => {
    // Winner: settled complete at (msg 1, ordinal 0) under id "winner".
    await persistToolExecPending(engine, jobId, 1, 0, 'winner', 'search', { q: 'w' });
    await persistToolExecComplete(engine, jobId, 1, 0, 'winner', { hit: 'won' });

    // Loser (zombie writer): same ordinal slot, different id, reports failed.
    // The UPDATE leg finds nothing (different id, nothing pending), and the
    // INSERT leg's conflict-update predicate must refuse the downgrade.
    await persistToolExecFailed(engine, jobId, 1, 0, 'loser', 'search', { q: 'l' }, 'zombie-error');

    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].tool_use_id).toBe('winner');
    expect(r[0].status).toBe('complete'); // NOT downgraded to failed
    expect(r[0].error).toBeNull();
  });
});

describe('persistToolExec* — legacy ordinal=NULL row compatibility', () => {
  test('a legacy row suppresses re-insert and still receives settlement', async () => {
    // Simulate a pre-upgrade pending row (no ordinal stamped).
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
       VALUES ($1, 2, 'legacy-id', 'search', '{}'::jsonb, 'pending')`,
      [jobId],
    );

    // Replay re-persists pending (now with an ordinal): must be a no-op.
    await persistToolExecPending(engine, jobId, 2, 0, 'legacy-id', 'search', {});
    let r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].ordinal).toBeNull();

    // Settlement finds the legacy row.
    await persistToolExecComplete(engine, jobId, 2, 0, 'legacy-id', { hit: 'legacy' });
    r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('complete');
  });

  test('a late failure never downgrades a legacy row that already settled complete', async () => {
    // Adversarial-review finding: the ordinal IS NULL disjunct in the failed
    // UPDATE's inner SELECT matched a legacy COMPLETE row (CASE priority 2)
    // when no own-ordinal/pending row existed, silently overwriting a settled
    // outcome with 'failed'.
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 3, 'legacy-done', 'search', '{}'::jsonb, 'complete', '{"hit":"keep"}'::jsonb)`,
      [jobId],
    );

    await persistToolExecFailed(engine, jobId, 3, 1, 'legacy-done', 'search', {}, 'late-zombie-error');

    const r = await rows();
    const legacy = r.find(x => x.ordinal === null);
    expect(legacy?.status).toBe('complete'); // NOT downgraded
    expect(legacy?.error).toBeNull();
    // The failure lands as its own stamped row instead of clobbering.
    const stamped = r.find(x => x.ordinal === 1);
    expect(stamped?.status).toBe('failed');
  });

  test('a late completion never overwrites a legacy row that already settled complete', async () => {
    // Same class on the complete side: a settled legacy sibling's output must
    // not be replaced by a different call's completion.
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 4, 'legacy-done2', 'search', '{}'::jsonb, 'complete', '{"hit":"original"}'::jsonb)`,
      [jobId],
    );

    await persistToolExecComplete(engine, jobId, 4, 1, 'legacy-done2', { hit: 'other-call' });

    const r = await rows();
    const legacy = r.find(x => x.message_idx === 4 && x.ordinal === null);
    const out = typeof legacy?.output === 'string' ? JSON.parse(legacy.output as string) : legacy?.output;
    expect((out as Record<string, unknown>)?.hit).toBe('original'); // untouched
  });
});
