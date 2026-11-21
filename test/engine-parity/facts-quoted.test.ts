/**
 * BrainEngine parity: the quote reads of search/transcript-quote.ts (which facts came from a third-party page, which
 * facts sit at or above the owner's trust tier, each page id's type) and the bare-name page lookup of a slot-history
 * question (search/slot-history.ts entityKeys), all in src/core/engine-sql/facts-recall.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member below returns the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which recalled facts and pages reach a model
 *    fenced as quoted third-party text, and whether a slot-history question finds its entity's history; on the Rust
 *    engine these ran through `executeRaw`, which it refuses, so a search lost its facts block and every history.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none; every fact, page, source and tier is seeded through the typed members (`insertFacts`, `insertFact`,
 *    `putPage`, `softDeletePage`, `recordDerivationEdges`, `transaction`, `applyTransactionSettings`) and `createSource`. Generated ids are
 *    compared by name, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TrustTier } from '../../src/core/trust/tier.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const QUOTED = ['transcript', 'chat'];
const BACKSTOP = [['sync:import', 'sync:'], ['mcp:put_page', 'put_page:']] as const;
const page = (type: string, frontmatter: Record<string, unknown> = {}) => ({ type: type as never, title: type, compiled_truth: 'x', frontmatter });

/** Inserts each named row into `sourceId`; resolves name -> id. */
async function facts(engine: BrainEngine, rows: Record<string, Record<string, unknown>>, sourceId = SRC): Promise<Map<string, number>> {
  const names = Object.keys(rows);
  const out = await engine.insertFacts(names.map((n, i) => ({ fact: n, kind: 'fact', visibility: 'world', source: 't', embedding: null, entity_slug: null, row_num: i + 1, source_markdown_slug: 'notes/seed', ...rows[n] })) as never, { source_id: sourceId });
  return new Map(names.map((n, i) => [n, Number(out.ids[i])]));
}

const named = (ids: Map<string, number>, got: readonly number[]) => {
  const byId = new Map([...ids].map(([n, id]) => [id, n]));
  return sorted(got.map((id) => byId.get(Number(id)) ?? `unknown:${id}`));
};

describe('engine parity: quote and slot-history reads', () => {
  parityTest('listFactsFromQuotedPages finds facts from a quoted page by slug or backstop session in their own source, deleted pages included', {
    methods: ['listFactsFromQuotedPages', 'insertFacts', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('chats/a', page('chat'));
    await engine.putPage('chats/gone', page('transcript'));
    await engine.putPage('notes/n', page('note'));
    await engine.softDeletePage('chats/gone');
    const ids = await facts(engine, {
      bySlug: { source_markdown_slug: 'chats/a' },
      deletedPage: { source_markdown_slug: 'chats/gone' },
      note: { source_markdown_slug: 'notes/n' },
      synced: { source: 'sync:import', source_session: 'sync:chats/a' },
      put: { source: 'mcp:put_page', source_session: 'put_page:chats/a' },
      crossed: { source: 'sync:import', source_session: 'put_page:chats/a' },
      noteSession: { source: 'sync:import', source_session: 'sync:notes/n' },
      plain: {},
    });
    const other = await facts(engine, { otherSource: { source: 'sync:import', source_session: 'sync:chats/a' } }, 'other');
    for (const [n, id] of other) ids.set(n, id);
    const all = [...ids.values()];
    const answers = {
      quoted: named(ids, await engine.listFactsFromQuotedPages([...all, all[0]!, 99_999_999], QUOTED, BACKSTOP)),
      withNotes: named(ids, await engine.listFactsFromQuotedPages(all, [...QUOTED, 'note'], BACKSTOP)),
      none: await engine.listFactsFromQuotedPages([], QUOTED, BACKSTOP),
    };
    expect(answers).toEqual({
      quoted: ['bySlug', 'deletedPage', 'put', 'synced'],
      withNotes: ['bySlug', 'deletedPage', 'note', 'noteSession', 'put', 'synced'],
      none: [],
    });
    return answers;
  });

  // The derivation clause joins the edge's input id to pages.id: any source, deleted pages included, and only an
  // input table of `pages` with an id of 1 to 18 digits (leading zeros allowed) names a page.
  parityTest('listFactsFromQuotedPages follows a derivation input edge to a quoted page', {
    methods: ['listFactsFromQuotedPages', 'recordDerivationEdges', 'insertFacts', 'putPage', 'getPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('chats/a', page('chat'));
    await engine.putPage('chats/gone', page('transcript'));
    await engine.putPage('chats/x', page('chat'), { sourceId: 'other' });
    await engine.putPage('notes/n', page('note'));
    const id = async (slug: string, sourceId = SRC) => String((await engine.getPage(slug, { sourceId }))!.id);
    const chat = await id('chats/a');
    const gone = await id('chats/gone');
    const elsewhere = await id('chats/x', 'other');
    const note = await id('notes/n');
    await engine.softDeletePage('chats/gone');
    const inputs: Record<string, { table: string; id: string }> = {
      derived: { table: 'pages', id: chat },
      fromDeleted: { table: 'pages', id: gone },
      fromOtherSource: { table: 'pages', id: elsewhere },
      padded: { table: 'pages', id: `00${chat}` },
      fromNote: { table: 'pages', id: note },
      notAPage: { table: 'facts', id: chat },
      notDigits: { table: 'pages', id: `${chat}a` },
      tooLong: { table: 'pages', id: chat.padStart(19, '0') },
    };
    const ids = await facts(engine, { ...Object.fromEntries(Object.keys(inputs).map((n) => [n, {}])), plain: {} });
    for (const [n, input] of Object.entries(inputs)) {
      await engine.recordDerivationEdges({ table: 'facts', id: String(ids.get(n)) }, SRC, [input]);
    }
    const answers = named(ids, await engine.listFactsFromQuotedPages([...ids.values()], QUOTED, BACKSTOP));
    expect(answers).toEqual(['derived', 'fromDeleted', 'fromOtherSource', 'padded']);
    return answers;
  });

  parityTest('listFactIdsAtTrustFloor keeps the facts whose stored tier ranks at or above the floor', {
    methods: ['listFactIdsAtTrustFloor', 'transaction', 'applyTransactionSettings', 'insertFact'],
  }, async (engine) => {
    const ids = new Map<string, number>();
    for (const tier of ['user_confirmed', 'operator_curated', 'agent_written', null] as Array<TrustTier | null>) {
      const write = (tx: BrainEngine) => tx.insertFact({ fact: String(tier), source: 'mcp:remember', entity_slug: null, visibility: 'world', embedding: null } as never, { source_id: SRC });
      const { id } = tier
        ? await engine.transaction(async (tx) => {
          await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify({ channel: tier })]);
          return write(tx);
        })
        : await write(engine);
      ids.set(String(tier), Number(id));
    }
    const all = [...ids.values(), 99_999_999];
    const answers = {
      owner: named(ids, await engine.listFactIdsAtTrustFloor(all, 'operator_curated')),
      unknown: named(ids, await engine.listFactIdsAtTrustFloor(all, 'unknown')),
      confirmed: named(ids, await engine.listFactIdsAtTrustFloor(all, 'user_confirmed')),
      none: await engine.listFactIdsAtTrustFloor([], 'unknown'),
    };
    expect(answers).toEqual({
      owner: ['operator_curated', 'user_confirmed'],
      unknown: ['agent_written', 'null', 'operator_curated', 'user_confirmed'],
      confirmed: ['user_confirmed'],
      none: [],
    });
    return answers;
  });

  parityTest('readPageTypesByIds reads each page id type, soft-deleted pages included, and skips ids with no page', {
    methods: ['readPageTypesByIds', 'putPage', 'getPage', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('chats/a', page('chat'));
    await engine.putPage('notes/gone', page('note'));
    const chat = Number((await engine.getPage('chats/a'))!.id);
    const gone = Number((await engine.getPage('notes/gone'))!.id);
    await engine.softDeletePage('notes/gone');
    const rows = await engine.readPageTypesByIds([chat, gone, chat, 99_999_999]);
    const answers = {
      types: sorted(rows.map((r) => `${Number(r.id) === chat ? 'chat' : Number(r.id) === gone ? 'gone' : r.id}:${r.type}`)),
      idKinds: rows.map((r) => typeof r.id),
      none: await engine.readPageTypesByIds([]),
    };
    expect(answers).toEqual({ types: ['chat:chat', 'gone:note'], idKinds: ['number', 'number'], none: [] });
    return answers;
  });

  parityTest('listReadablePageSlugs keeps the live pages the read scope admits in the asked source, at most the limit', {
    methods: ['listReadablePageSlugs', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/a', page('person'));
    await engine.putPage('people/b', page('person'));
    await engine.putPage('people/gone', page('person'));
    await engine.putPage('people/held', page('person', { quarantine: { reason: 'test' } }));
    await engine.putPage('people/c', page('person'), { sourceId: 'other' });
    await engine.softDeletePage('people/gone');
    const asked = ['people/gone', 'people/held', 'people/c', 'people/b', 'people/a'];
    const answers = {
      all: sorted(await engine.listReadablePageSlugs(SRC, asked, {}, 10)),
      capped: (await engine.listReadablePageSlugs(SRC, asked, {}, 1)).length,
      scopeSourcesIgnored: sorted(await engine.listReadablePageSlugs(SRC, asked, { sourceId: 'other', sourceIds: ['other'] }, 10)),
      otherSource: await engine.listReadablePageSlugs('other', asked, {}, 10),
      floor: await engine.listReadablePageSlugs(SRC, ['people/a'], { minTrust: 'operator_curated' }, 10),
      none: await engine.listReadablePageSlugs(SRC, [], {}, 2),
    };
    expect(answers).toEqual({
      all: ['people/a', 'people/b'],
      capped: 1,
      scopeSourcesIgnored: ['people/a', 'people/b'],
      otherSource: ['people/c'],
      floor: [],
      none: [],
    });
    return answers;
  });
});
