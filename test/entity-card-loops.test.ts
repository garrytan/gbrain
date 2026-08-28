/**
 * buildEntityCard (src/core/verbs/entity-card.ts) — the v0.47 open-loop-backed
 * open_threads entries. Additive optional fields (direction/due/counterparty/
 * status/loop_id) appear ONLY on threads backed by an open_loops row; a
 * commitment fact already surfaced via its loop's fact_id is not duplicated;
 * brains with no loop rows still build cards.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard, type EntityCard } from '../src/core/verbs/entity-card.ts';
import { closeOpenLoop, upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';

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
  await engine.putPage(
    'people/alice-example',
    { title: 'Alice', type: 'person', compiled_truth: 'Alice, a founder at acme-example.' },
    { sourceId: 'g1' },
  );
});

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_inbound',
    loopType: 'unanswered_inbound',
    counterpartySlug: 'people/alice-example',
    counterpartyEmail: 'alice@example.com',
    summary: 'Reply owed to alice@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

async function card(name = 'Alice'): Promise<EntityCard> {
  const res = await buildEntityCard(engine, 'g1', name, { remote: false });
  expect(res.found).toBe(true);
  return res.card!;
}

describe('entity card open-loop-backed open_threads', () => {
  test('an open loop pointing at the person surfaces first with loop_id/direction/due/status', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const c = await card();
    expect(c.open_threads.length).toBeGreaterThanOrEqual(1);
    const t = c.open_threads[0];
    expect(t.kind).toBe('commitment');
    expect(t.text).toBe('Reply owed to alice@example.com: "Quarterly plan" (2d)');
    expect(t.loop_id).toBe(id);
    expect(t.direction).toBe('my_turn'); // unanswered_inbound = I owe the reply
    expect(t.due).toBeNull();
    expect(t.status).toBe('open');
    expect(t.counterparty).toBe('people/alice-example');
    expect(t.date).toBeTruthy();
  });

  test('loop_type → direction mapping across all four mapped types', async () => {
    const cases: Array<{
      loopType: OpenLoopUpsert['loopType'];
      dedup: string;
      direction: string;
    }> = [
      { loopType: 'commitment_owed_by_me', dedup: 'commit:aaaaaaaa', direction: 'owed_by_me' },
      { loopType: 'commitment_owed_to_me', dedup: 'commit:bbbbbbbb', direction: 'owed_to_me' },
      { loopType: 'unanswered_inbound', dedup: 'thread:18c2f4a9b3d21e01:unanswered_inbound', direction: 'my_turn' },
      { loopType: 'unanswered_outbound', dedup: 'thread:18c2f4a9b3d21e02:unanswered_outbound', direction: 'their_turn' },
    ];
    for (const cse of cases) {
      await resetPgliteState(engine);
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('g1', 'g1') ON CONFLICT (id) DO NOTHING`,
      );
      await engine.putPage(
        'people/alice-example',
        { title: 'Alice', type: 'person', compiled_truth: 'Alice.' },
        { sourceId: 'g1' },
      );
      await upsertOpenLoop(
        engine,
        loop({
          loopType: cse.loopType,
          dedupKey: cse.dedup,
          detector: cse.loopType.startsWith('commitment') ? 'llm_extract' : 'deterministic_thread',
        }),
      );
      const c = await card();
      expect(c.open_threads[0].direction).toBe(cse.direction as never);
    }
  });

  test('due_at rides through on the thread', async () => {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:cccccccc',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        dueAt: due,
      }),
    );
    const c = await card();
    const t = c.open_threads[0];
    expect(t.due).toBeTruthy();
    expect(new Date(t.due as never as string).getTime()).toBe(Date.parse(due));
  });

  test('a commitment fact whose id is the loop fact_id is NOT duplicated as a second thread', async () => {
    const factRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('g1', 'people/alice-example', 'Send the deck to alice-example', 'commitment', 'loops-test')
       RETURNING id`,
    );
    const factId = Number(factRows[0].id);
    await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:dddddddd',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        summary: 'Loop: send the deck',
        factId,
      }),
    );
    const c = await card();
    // The loop-backed thread is present...
    const loopThreads = c.open_threads.filter((t) => t.loop_id !== undefined);
    expect(loopThreads).toHaveLength(1);
    expect(loopThreads[0].text).toBe('Loop: send the deck');
    // ...and the projected fact does NOT appear a second time.
    const factTexts = c.open_threads.filter((t) => t.text === 'Send the deck to alice-example');
    expect(factTexts).toHaveLength(0);
    // The fact still counts as an active fact.
    expect(c.active_fact_count).toBe(1);
  });

  test('a commitment fact NOT backed by any loop still surfaces (without the loop-only fields)', async () => {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('g1', 'people/alice-example', 'Intro alice-example to fund-a', 'commitment', 'loops-test')`,
    );
    const c = await card();
    const t = c.open_threads.find((x) => x.text === 'Intro alice-example to fund-a');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('commitment');
    expect(t!.loop_id).toBeUndefined();
    expect(t!.direction).toBeUndefined();
    expect(t!.status).toBeUndefined();
  });

  test('closed loops do not surface as open_threads', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    await closeOpenLoop(engine, 'g1', id, 'done', 'manual');
    const c = await card();
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
  });

  test('loops for the same slug in ANOTHER source do not leak into the card', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('g2', 'g2') ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(engine, loop({ sourceId: 'g2' }));
    const c = await card();
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
  });

  test('open_threads cap: at most 3 loop-backed threads, newest activity first', async () => {
    for (let i = 1; i <= 4; i++) {
      await upsertOpenLoop(
        engine,
        loop({
          dedupKey: `thread:18c2f4a9b3d21e0${i}:unanswered_inbound`,
          threadId: `18c2f4a9b3d21e0${i}`,
          summary: `loop ${i}`,
          lastActivityAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        }),
      );
    }
    const c = await card();
    expect(c.open_threads).toHaveLength(3);
    expect(c.open_threads.map((t) => t.text)).toEqual(['loop 1', 'loop 2', 'loop 3']);
  });

  test('brains with zero loop rows still build the card (open_loops query matches nothing)', async () => {
    const c = await card();
    expect(c.entity.slug).toBe('people/alice-example');
    expect(c.open_threads.filter((t) => t.loop_id !== undefined)).toHaveLength(0);
    // No loop-only optional fields anywhere.
    for (const t of c.open_threads) {
      expect(t.loop_id).toBeUndefined();
      expect(t.direction).toBeUndefined();
    }
  });
});
