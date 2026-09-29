/**
 * buildEntityCard (src/core/verbs/entity-card.ts) — the v0.47 open-loop-backed
 * open_threads entries. Additive optional fields (direction/due/counterparty/
 * status/loop_id) appear ONLY on threads backed by an open_loops row; a
 * commitment fact already surfaced via its loop's fact_id is not duplicated;
 * brains with no loop rows still build cards.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard, type EntityCard } from '../src/core/verbs/entity-card.ts';
import { assembleContextPack, assembleDeltaContext } from '../src/core/context/turn-context.ts';
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

/**
 * #5504 read side: facts and open loops a connector source stores under the
 * slug of a page living in another source attach to that page's trusted
 * card under the cross-source reference rule (own source first, then the
 * single `federated: true` page elsewhere); remote cards never widen.
 */
describe('entity card cross-source references (#5504)', () => {
  const BOB = 'people/bob-example';

  async function setSource(id: string, config: Record<string, unknown>): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
      [id, JSON.stringify(config)],
    );
  }

  async function bobPage(sourceId: string): Promise<void> {
    await engine.putPage(BOB, { title: 'Bob', type: 'person', compiled_truth: 'Bob, a synthetic person.' }, { sourceId });
  }

  /** One active commitment fact plus one open loop for `slug`, stored in `sourceId`. */
  async function seedRows(sourceId: string, slug = BOB): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ($1, $2, $3, 'commitment', 'cross-source:loops-test')`,
      [sourceId, slug, `Send the budget to Bob (${sourceId})`],
    );
    await upsertOpenLoop(engine, loop({
      sourceId,
      dedupKey: `commit:${sourceId}`,
      loopType: 'commitment_owed_by_me',
      detector: 'llm_extract',
      counterpartySlug: slug,
      counterpartyEmail: 'bob@example.com',
      summary: `Loop from ${sourceId}`,
    }));
  }

  async function bobCard(sourceId: string, remote = false): Promise<EntityCard> {
    const res = await buildEntityCard(engine, sourceId, BOB, { remote });
    expect(res.found).toBe(true);
    return res.card!;
  }

  function rowsFrom(c: EntityCard, sourceId: string): string[] {
    return c.open_threads
      .map((t) => t.text)
      .filter((t) => t === `Loop from ${sourceId}` || t === `Send the budget to Bob (${sourceId})`);
  }

  test('a connector row for a page in a federated source shows on the trusted card and counts', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await seedRows('gmail');
    const c = await bobCard('default');
    expect(rowsFrom(c, 'gmail').sort()).toEqual(['Loop from gmail', 'Send the budget to Bob (gmail)']);
    const loopThread = c.open_threads.find((t) => t.text === 'Loop from gmail')!;
    expect(loopThread.loop_id).toBeGreaterThan(0);
    expect(loopThread.direction).toBe('owed_by_me');
    expect(c.active_fact_count).toBe(1);
  });

  test('remote card is unchanged by connector rows (deny)', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility)
       VALUES ('default', $1, 'Bob owns the roadmap', 'commitment', 'loops-test', 'world')`,
      [BOB],
    );
    const before = await bobCard('default', true);
    await seedRows('gmail');
    await engine.executeRaw(`UPDATE facts SET visibility = 'world' WHERE source_id = 'gmail'`);
    const after = await bobCard('default', true);
    expect(after).toEqual(before);
    expect(rowsFrom(after, 'gmail')).toEqual([]);
    expect(after.active_fact_count).toBe(1);
    // The trusted card over the same rows does widen.
    expect(rowsFrom(await bobCard('default'), 'gmail')).toHaveLength(2);
  });

  const cases: Array<{
    name: string;
    sources: Record<string, Record<string, unknown>>;
    archived?: string[];
    pages: string[];
    card: string;
    expectGmailRows: boolean;
  }> = [
    {
      name: 'own source first: gmail with its own live page keeps its rows off the default card',
      sources: { gmail: { kind: 'google', federated: true } },
      pages: ['default', 'gmail'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      name: 'own source first: gmail rows stay on the gmail card',
      sources: { gmail: { kind: 'google', federated: true } },
      pages: ['default', 'gmail'],
      card: 'gmail',
      expectGmailRows: true,
    },
    {
      name: 'ambiguity: pages in two federated sources, the default card gets none',
      sources: { gmail: { kind: 'google', federated: true }, crm: { federated: true } },
      pages: ['default', 'crm'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      name: 'ambiguity: pages in two federated sources, the other card gets none',
      sources: { gmail: { kind: 'google', federated: true }, crm: { federated: true } },
      pages: ['default', 'crm'],
      card: 'crm',
      expectGmailRows: false,
    },
    {
      name: 'a non-federated page elsewhere does not make the slug ambiguous',
      sources: { gmail: { kind: 'google', federated: true }, crm: {} },
      pages: ['default', 'crm'],
      card: 'default',
      expectGmailRows: true,
    },
    {
      name: 'isolation: gmail configured federated:false never contributes',
      sources: { gmail: { kind: 'google', federated: false } },
      pages: ['default'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      name: 'isolation: default configured federated:false receives none',
      sources: { default: { federated: false }, gmail: { kind: 'google', federated: true } },
      pages: ['default'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      name: 'federation unset: default with federation unset receives none',
      sources: { default: {}, gmail: { kind: 'google', federated: true } },
      pages: ['default'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      // Operator decision (story-02 fix round 1): only `federated: true`
      // sources contribute on the read side.
      name: 'federation unset: gmail with federation unset does not contribute',
      sources: { gmail: { kind: 'google' } },
      pages: ['default'],
      card: 'default',
      expectGmailRows: false,
    },
    {
      name: 'an archived gmail source does not contribute',
      sources: { gmail: { kind: 'google', federated: true } },
      archived: ['gmail'],
      pages: ['default'],
      card: 'default',
      expectGmailRows: false,
    },
  ];

  for (const cse of cases) {
    test(cse.name, async () => {
      for (const [id, config] of Object.entries(cse.sources)) await setSource(id, config);
      for (const id of cse.archived ?? []) {
        await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = $1`, [id]);
      }
      for (const sourceId of cse.pages) await bobPage(sourceId);
      await seedRows('gmail');
      const c = await bobCard(cse.card);
      expect(rowsFrom(c, 'gmail')).toHaveLength(cse.expectGmailRows ? 2 : 0);
      expect(c.active_fact_count).toBe(cse.expectGmailRows ? 1 : 0);
    });
  }

  test('a soft-deleted page in gmail does not count as its own page', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await bobPage('gmail');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE source_id = 'gmail' AND slug = $1`, [BOB]);
    await seedRows('gmail');
    expect(rowsFrom(await bobCard('default'), 'gmail')).toHaveLength(2);
  });

  test('only people/ and companies/ slugs attach across sources', async () => {
    const PLAN = 'concepts/bob-plan';
    await setSource('gmail', { kind: 'google', federated: true });
    await engine.putPage(PLAN, { title: 'Bob plan', type: 'concept', compiled_truth: 'A synthetic plan.' }, { sourceId: 'default' });
    await seedRows('gmail', PLAN);
    const res = await buildEntityCard(engine, 'default', PLAN, { remote: false });
    expect(res.found).toBe(true);
    expect(rowsFrom(res.card!, 'gmail')).toEqual([]);
    expect(res.card!.active_fact_count).toBe(0);
  });

  test('a caller that does not pass remote === false never widens (fail-closed)', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await seedRows('gmail');
    for (const remote of [undefined, null]) {
      const res = await buildEntityCard(engine, 'default', BOB, { remote: remote as unknown as boolean });
      expect(rowsFrom(res.card!, 'gmail')).toEqual([]);
      expect(res.card!.active_fact_count).toBe(0);
    }
  });

  test('rows stranded by an ambiguous slug are logged, and nothing logs when none are stranded', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await setSource('crm', { federated: true });
    await bobPage('default');
    await bobPage('crm');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await bobCard('default');
      expect(errors.mock.calls.flat().filter((m) => String(m).includes('ambiguous'))).toEqual([]);
      await seedRows('gmail');
      const c = await bobCard('default');
      expect(rowsFrom(c, 'gmail')).toEqual([]);
      const logged = errors.mock.calls.flat().map(String).filter((m) => m.includes('ambiguous'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`slug=${BOB}`);
      expect(logged[0]).toContain('1 active fact(s) and 1 open loop(s)');
    } finally {
      errors.mockRestore();
    }
  });

  test('a trusted include_private context_pack card carries cross-source rows; the default pack does not', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await seedRows('gmail');
    const trusted = await assembleContextPack(engine, { sourceId: 'default', entities: [BOB], includePrivate: true });
    expect(trusted.cards?.map((c) => c.entity.slug)).toEqual([BOB]);
    expect(rowsFrom(trusted.cards![0], 'gmail')).toContain('Loop from gmail');
    const worldOnly = await assembleContextPack(engine, { sourceId: 'default', entities: [BOB] });
    expect(worldOnly.cards?.map((c) => c.entity.slug)).toEqual([BOB]);
    expect(rowsFrom(worldOnly.cards![0], 'gmail')).toEqual([]);
  });

  test('a trusted include_private delta thread arm carries cross-source loop events; the default delta does not', async () => {
    await setSource('gmail', { kind: 'google', federated: true });
    await bobPage('default');
    await seedRows('gmail');
    const threadTexts = (r: Awaited<ReturnType<typeof assembleDeltaContext>>) => (r.openThreads ?? []).map((t) => t.text);
    const trusted = await assembleDeltaContext(engine, { sourceId: 'default', entities: [BOB], includePrivate: true });
    expect(threadTexts(trusted)).toContain('Loop from gmail');
    const worldOnly = await assembleDeltaContext(engine, { sourceId: 'default', entities: [BOB] });
    expect(threadTexts(worldOnly)).not.toContain('Loop from gmail');
  });
});
