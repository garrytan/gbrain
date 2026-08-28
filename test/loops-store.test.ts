/**
 * loops-store (src/core/loops/loops-store.ts) on PGLite: upsert/reopen
 * semantics, evidence JSONB round-trip (real array — the $N::text::jsonb
 * discipline), close scoping, thread-close filters, list filters, the
 * staleness pass, and suppressions.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  addSuppression,
  closeOpenLoop,
  closeThreadLoops,
  listOpenLoops,
  loadSuppressions,
  markStaleLoops,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('g2', 'g2', '{"kind":"google"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_inbound',
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed to bob@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

function toMs(v: unknown): number {
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}

describe('upsertOpenLoop', () => {
  test('first insert reports created: true; same dedup_key reports created: false', async () => {
    const first = await upsertOpenLoop(engine, loop());
    expect(first.created).toBe(true);
    const second = await upsertOpenLoop(engine, loop({ summary: 'updated summary' }));
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('updated summary');
  });

  test('reopen: a closed loop flips back to open (closed_at/closed_by cleared) on conflict', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const closed = await closeOpenLoop(engine, 'g1', id, 'done', 'manual');
    expect(closed?.status).toBe('done');

    const again = await upsertOpenLoop(engine, loop({ summary: 'they pinged again' }));
    expect(again.created).toBe(false);
    expect(again.id).toBe(id);

    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows[0].status).toBe('open');
    expect(rows[0].closed_at).toBeNull();
    expect(rows[0].closed_by).toBeNull();
    expect(rows[0].summary).toBe('they pinged again');
  });

  test('evidence is REPLACED on upsert, not merged', async () => {
    await upsertOpenLoop(engine, loop());
    await upsertOpenLoop(
      engine,
      loop({ evidence: [{ message_id: '18c2f4a9b3d21e08', quote: 'newer ask' }] }),
    );
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows[0].evidence).toEqual([{ message_id: '18c2f4a9b3d21e08', quote: 'newer ask' }]);
  });

  test('last_activity_at keeps GREATEST across upserts', async () => {
    const t2 = '2026-08-20T00:00:00.000Z';
    const t1 = '2026-08-10T00:00:00.000Z';
    const t3 = '2026-08-24T00:00:00.000Z';
    const { id } = await upsertOpenLoop(engine, loop({ lastActivityAt: t2 }));

    // An older activity time must NOT move the clock backwards.
    await upsertOpenLoop(engine, loop({ lastActivityAt: t1 }));
    let rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows[0].id).toBe(id);
    expect(toMs(rows[0].last_activity_at)).toBe(Date.parse(t2));

    // A newer one advances it.
    await upsertOpenLoop(engine, loop({ lastActivityAt: t3 }));
    rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(toMs(rows[0].last_activity_at)).toBe(Date.parse(t3));
  });

  test('evidence round-trips as a real jsonb array (never a double-encoded string)', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    // The DB-side truth: jsonb_typeof must be 'array'. A JSON.stringify
    // double-encode would store a jsonb string scalar instead.
    const t = await engine.executeRaw<{ t: string }>(
      `SELECT jsonb_typeof(evidence) AS t FROM open_loops WHERE id = $1`,
      [id],
    );
    expect(t[0].t).toBe('array');
    // And the store's read side hands back a parsed array.
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(Array.isArray(rows[0].evidence)).toBe(true);
    expect(typeof rows[0].evidence).not.toBe('string');
    expect(rows[0].evidence[0].message_id).toBe('18c2f4a9b3d21e07');
    expect(rows[0].evidence[0].quote).toBe('Can you review the plan?');
  });

  test('COALESCE keeps prior counterparty_slug / due_at / fact_id when the new upsert omits them', async () => {
    await upsertOpenLoop(
      engine,
      loop({ counterpartySlug: 'people/bob-example', dueAt: '2026-09-01T00:00:00.000Z' }),
    );
    await upsertOpenLoop(engine, loop({ counterpartySlug: null, dueAt: null }));
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows[0].counterparty_slug).toBe('people/bob-example');
    expect(toMs(rows[0].due_at)).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
  });
});

describe('upsertOpenLoop manual-close guard', () => {
  const T_OLD = '2026-08-10T00:00:00.000Z';
  const T_BASE = '2026-08-20T00:00:00.000Z';
  const T_NEWER = '2026-08-24T00:00:00.000Z';

  test('re-upsert with the SAME lastActivityAt leaves a manually-closed row untouched (applied: false, original id)', async () => {
    const first = await upsertOpenLoop(engine, loop({ lastActivityAt: T_BASE }));
    expect(first.created).toBe(true);
    expect(first.applied).toBe(true);
    const closed = await closeOpenLoop(engine, 'g1', first.id, 'done', 'manual');
    expect(closed?.status).toBe('done');

    // The exact re-render-of-an-unchanged-thread case: same activity time.
    const again = await upsertOpenLoop(
      engine,
      loop({ summary: 'same-activity re-render', lastActivityAt: T_BASE }),
    );
    expect(again.applied).toBe(false);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id); // the untouched-row id is still reported

    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('done'); // `gbrain loops done` was NOT reverted
    expect(rows[0].closed_by).toBe('manual');
    expect(rows[0].closed_at).not.toBeNull();
    expect(rows[0].summary).toBe(loop().summary); // no field merged either

    // An OLDER activity time is guarded identically.
    const older = await upsertOpenLoop(
      engine,
      loop({ summary: 'older re-render', lastActivityAt: T_OLD }),
    );
    expect(older.applied).toBe(false);
    expect(older.id).toBe(first.id);
    expect((await listOpenLoops(engine, { sourceIds: ['g1'] }))[0].status).toBe('done');
  });

  test('re-upsert with a strictly NEWER lastActivityAt reopens the closed row (applied: true)', async () => {
    const { id } = await upsertOpenLoop(engine, loop({ lastActivityAt: T_BASE }));
    await closeOpenLoop(engine, 'g1', id, 'done', 'manual');

    const again = await upsertOpenLoop(
      engine,
      loop({ summary: 'they pinged again', lastActivityAt: T_NEWER }),
    );
    expect(again.applied).toBe(true);
    expect(again.created).toBe(false);
    expect(again.id).toBe(id);

    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].closed_at).toBeNull();
    expect(rows[0].closed_by).toBeNull();
    expect(rows[0].summary).toBe('they pinged again');
    expect(toMs(rows[0].last_activity_at)).toBe(Date.parse(T_NEWER));
  });

  test('an OPEN row still merges normally on an older or equal lastActivityAt (applied: true)', async () => {
    const { id } = await upsertOpenLoop(engine, loop({ lastActivityAt: T_BASE }));

    const older = await upsertOpenLoop(
      engine,
      loop({ summary: 'older evidence re-render', lastActivityAt: T_OLD }),
    );
    expect(older.applied).toBe(true);
    expect(older.created).toBe(false);
    expect(older.id).toBe(id);

    const equal = await upsertOpenLoop(
      engine,
      loop({ summary: 'equal-time re-render', lastActivityAt: T_BASE }),
    );
    expect(equal.applied).toBe(true);
    expect(equal.id).toBe(id);

    const rows = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].summary).toBe('equal-time re-render'); // merge really applied
    expect(toMs(rows[0].last_activity_at)).toBe(Date.parse(T_BASE)); // GREATEST kept
  });
});

describe('closeOpenLoop', () => {
  test('closes only open rows; a second close returns null', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const first = await closeOpenLoop(engine, 'g1', id, 'done', 'manual');
    expect(first).not.toBeNull();
    expect(first!.status).toBe('done');
    expect(first!.closed_by).toBe('manual');
    const second = await closeOpenLoop(engine, 'g1', id, 'done', 'manual');
    expect(second).toBeNull();
  });

  test('respects sourceId scoping: wrong source is a no-op, null is unscoped', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const wrong = await closeOpenLoop(engine, 'g2', id, 'done', 'manual');
    expect(wrong).toBeNull();
    const still = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(still).toHaveLength(1);

    const unscoped = await closeOpenLoop(engine, null, id, 'dropped', 'test-close');
    expect(unscoped).not.toBeNull();
    expect(unscoped!.status).toBe('dropped');
  });
});

describe('closeThreadLoops', () => {
  test('closes only the types named by `only`', async () => {
    await upsertOpenLoop(engine, loop());
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_outbound',
        loopType: 'unanswered_outbound',
      }),
    );
    const n = await closeThreadLoops(engine, 'g1', '18c2f4a9b3d21e07', 'reply_detected', [
      'unanswered_inbound',
    ]);
    expect(n).toBe(1);
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].loop_type).toBe('unanswered_outbound');
    const done = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0].loop_type).toBe('unanswered_inbound');
    expect(done[0].closed_by).toBe('reply_detected');
  });

  test('without `only`, closes every open deterministic_thread loop for the thread — but never llm_extract rows', async () => {
    await upsertOpenLoop(engine, loop());
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_outbound',
        loopType: 'unanswered_outbound',
      }),
    );
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:aaaaaaaa',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
      }),
    );
    const n = await closeThreadLoops(engine, 'g1', '18c2f4a9b3d21e07', 'reply_detected');
    expect(n).toBe(2);
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].detector).toBe('llm_extract');
  });

  test('scoped to the given source and thread', async () => {
    await upsertOpenLoop(engine, loop());
    await upsertOpenLoop(engine, loop({ sourceId: 'g2' })); // same dedup key, other source
    await upsertOpenLoop(
      engine,
      loop({ dedupKey: 'thread:18c2f4a9b3d21e99:unanswered_inbound', threadId: '18c2f4a9b3d21e99' }),
    );
    const n = await closeThreadLoops(engine, 'g1', '18c2f4a9b3d21e07', 'reply_detected');
    expect(n).toBe(1);
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);
    expect(await listOpenLoops(engine, { sourceIds: ['g2'], status: 'open' })).toHaveLength(1);
  });
});

describe('listOpenLoops filters', () => {
  beforeEach(async () => {
    await upsertOpenLoop(
      engine,
      loop({
        counterpartySlug: 'people/carol-example',
        counterpartyEmail: 'carol@example.com',
        dedupKey: 'thread:18c2f4a9b3d21e01:unanswered_inbound',
        threadId: '18c2f4a9b3d21e01',
        lastActivityAt: '2026-08-24T00:00:00.000Z',
      }),
    );
    await upsertOpenLoop(
      engine,
      loop({
        loopType: 'unanswered_outbound',
        counterpartyEmail: 'bob@example.com',
        dedupKey: 'thread:18c2f4a9b3d21e02:unanswered_outbound',
        threadId: '18c2f4a9b3d21e02',
        lastActivityAt: '2026-08-23T00:00:00.000Z',
      }),
    );
    await upsertOpenLoop(
      engine,
      loop({
        sourceId: 'g2',
        counterpartyEmail: 'dana@example.com',
        dedupKey: 'thread:18c2f4a9b3d21e03:unanswered_inbound',
        threadId: '18c2f4a9b3d21e03',
        lastActivityAt: '2026-08-22T00:00:00.000Z',
      }),
    );
    const closed = await upsertOpenLoop(
      engine,
      loop({
        counterpartyEmail: 'erin@example.com',
        dedupKey: 'thread:18c2f4a9b3d21e04:unanswered_inbound',
        threadId: '18c2f4a9b3d21e04',
      }),
    );
    await closeOpenLoop(engine, 'g1', closed.id, 'done', 'manual');
  });

  test('status filter', async () => {
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.map((l) => l.counterparty_email).sort()).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
    const done = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(done.map((l) => l.counterparty_email)).toEqual(['erin@example.com']);
    // No status filter → every status.
    expect(await listOpenLoops(engine, { sourceIds: ['g1'] })).toHaveLength(3);
  });

  test('loopType filter', async () => {
    const out = await listOpenLoops(engine, { sourceIds: ['g1'], loopType: 'unanswered_outbound' });
    expect(out).toHaveLength(1);
    expect(out[0].counterparty_email).toBe('bob@example.com');
  });

  test('counterparty filter matches slug OR email', async () => {
    const bySlug = await listOpenLoops(engine, {
      sourceIds: ['g1'],
      counterparty: 'people/carol-example',
    });
    expect(bySlug).toHaveLength(1);
    expect(bySlug[0].counterparty_email).toBe('carol@example.com');

    const byEmail = await listOpenLoops(engine, {
      sourceIds: ['g1'],
      counterparty: 'carol@example.com',
    });
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0].counterparty_slug).toBe('people/carol-example');

    const miss = await listOpenLoops(engine, { sourceIds: ['g1'], counterparty: 'nobody@example.com' });
    expect(miss).toHaveLength(0);
  });

  test('sourceIds filter federates and isolates', async () => {
    const g2only = await listOpenLoops(engine, { sourceIds: ['g2'] });
    expect(g2only).toHaveLength(1);
    expect(g2only[0].counterparty_email).toBe('dana@example.com');
    const both = await listOpenLoops(engine, { sourceIds: ['g1', 'g2'], status: 'open' });
    expect(both).toHaveLength(3);
    // No sourceIds → unscoped (trusted-local semantics).
    expect(await listOpenLoops(engine, { status: 'open' })).toHaveLength(3);
  });

  test('ordering is last_activity_at DESC and limit clamps', async () => {
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows.map((l) => l.counterparty_email)).toEqual(['carol@example.com', 'bob@example.com']);
    const limited = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open', limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].counterparty_email).toBe('carol@example.com');
  });
});

describe('markStaleLoops', () => {
  test('marks llm_extract rows overdue >14d or inactive >90d, never deterministic_thread rows', async () => {
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

    // Overdue AND inactive llm_extract (due 20d ago, silent 20d) → stale.
    // Overdue alone must NOT stale an actively-discussed commitment — that
    // would ping-pong stale→open→stale against the upsert's reopen (red-team).
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:11111111',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        dueAt: daysAgo(20),
        lastActivityAt: daysAgo(20),
      }),
    );
    // Overdue but ACTIVE (due 20d ago, message yesterday) → stays open.
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:44444444',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        dueAt: daysAgo(20),
        lastActivityAt: daysAgo(1),
      }),
    );
    // Inactive llm_extract (no due, 100d silent) → stale.
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:22222222',
        loopType: 'commitment_owed_to_me',
        detector: 'llm_extract',
        lastActivityAt: daysAgo(100),
      }),
    );
    // Healthy llm_extract (due in the future, active now) → stays open.
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:33333333',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        dueAt: new Date(now + 5 * 86_400_000).toISOString(),
        lastActivityAt: daysAgo(1),
      }),
    );
    // Ancient deterministic_thread loop → NOT the staleness pass's business.
    await upsertOpenLoop(engine, loop({ lastActivityAt: daysAgo(100) }));

    const n = await markStaleLoops(engine, 'g1');
    expect(n).toBe(2);

    const stale = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'stale' });
    expect(stale.map((l) => l.dedup_key).sort()).toEqual(['commit:11111111', 'commit:22222222']);
    for (const s of stale) expect(s.closed_by).toBe('staleness');

    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.map((l) => l.dedup_key).sort()).toEqual([
      'commit:33333333',
      'commit:44444444', // overdue but actively discussed — stays open
      'thread:18c2f4a9b3d21e07:unanswered_inbound',
    ]);
  });
});

describe('suppressions', () => {
  test('add + load + uniq on conflict + lowercasing', async () => {
    await addSuppression(engine, 'g1', 'sender', 'Bob@Example.com');
    await addSuppression(engine, 'g1', 'sender', 'bob@example.com'); // dup after lowering
    await addSuppression(engine, 'g1', 'thread', '18C2F4A9B3D21E07');
    await addSuppression(engine, 'g2', 'sender', 'carol@example.com'); // other source

    const set = await loadSuppressions(engine, 'g1');
    expect([...set.senders]).toEqual(['bob@example.com']);
    expect([...set.threads]).toEqual(['18c2f4a9b3d21e07']);
    expect(set.senders.has('carol@example.com')).toBe(false);

    const raw = await engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM loop_suppressions WHERE source_id = 'g1'`,
    );
    expect(Number(raw[0].n)).toBe(2);
  });
});
