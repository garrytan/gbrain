/**
 * BrainEngine parity — the guarded relink writes of `facts` rows (engine-sql/fact-relink-writes.ts): placeRelinkedFact and
 * linkConversationFact, and listConversationRelinkPages, the conversation relink's page pick.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    places a pinned fact only while it still has no entity, page, row number or expiry, in the named source: `link` gives it
 *    the page, its fence row number and the new context; `retire` expires it onto the page with the new context. A conversation
 *    row links only while it is the same claim on the same page, live, user-said or unattributed, a derived extractor row (not
 *    an audit row), unlinked (or on the named unbacked key), and the target page is live. The page pick counts, per page of the
 *    source, the live user-or-unattributed derived rows with no entity (or, `unbacked`, on an unbacked name key), leaves out
 *    rows the relink already tried unless a newer page re-armed the miss (`skipTried`), and orders most rows first, then by
 *    slug in byte order (COLLATE "C"), at most `limit`.
 *  - Regression: an engine that moves a row another writer already placed, a row of another source, an expired or lapsed row,
 *    an assistant-said or audit row, or that links onto a deleted page, makes `gbrain facts relink` overwrite a fence position
 *    or attach a claim to the wrong entity. An engine that ignores the fence position's unique index writes two rows at one
 *    position. A page pick that sorts equal counts by the database collation (en_US puts `a-page` before `B-page`) picks a
 *    different page at the `limit` cut on Postgres than on PGLite.
 *  - Why existing coverage misses it: both statements ran through `executeRaw` inside facts/relink-publish.ts (the
 *    `relink_facts` coordinator mutation) and facts/conversation-relink.ts, which the parity cases cannot call (D18); the page
 *    pick also ran there through `executeRaw`.
 *  - Seam: rows are written with insertFact / insertFacts and read back with listFactsByEntity and listFactsForPage. Each
 *    answer names a row by the claim text the case wrote, never by its generated id, and times are reduced to "expired or
 *    not": each engine stamps its own clock. Lists are sorted by claim text in byte order.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { CONVERSATION_UNRESOLVED } from '../../src/core/facts/relink-reasons.ts';

const { parityTest } = parityArms(testBackends());

const CONVERSATION = 'cli:extract-conversation-facts';
const TERMINAL = 'cli:extract-conversation-facts:terminal:v2';
const TARGET = 'people/alice-example';

const note = (title: string) => ({ type: 'person' as const, title, compiled_truth: 'body', frontmatter: {} });

async function loose(engine: BrainEngine, text: string, sourceId = 'default'): Promise<number> {
  return (await engine.insertFact({ fact: text, source: 'chat' }, { source_id: sourceId })).id;
}

/** A conversation page's derived row: database-only (no row number). */
async function derived(engine: BrainEngine, slug: string, text: string, extra: Partial<NewFact> = {}, sourceId = 'default'): Promise<number> {
  const out = await engine.insertFacts([{ fact: text, source: CONVERSATION, ...extra, row_num: null, source_markdown_slug: slug } as never],
    { source_id: sourceId });
  return out.ids[0]!;
}

/** The target's rows as (claim, context, expired), by claim. */
async function onTarget(engine: BrainEngine, sourceId = 'default') {
  const rows = await engine.listFactsByEntity(sourceId, TARGET, { activeOnly: false, limit: 100 });
  return sorted(rows.map(r => ({ fact: r.fact, context: r.context, expired: r.expired_at !== null })), r => r.fact);
}

/** The target page's fence rows as (claim, row number). */
async function fenced(engine: BrainEngine) {
  const rows = await engine.listFactsForPage('default', TARGET);
  return sorted(rows.map(r => ({ fact: r.fact, row_num: r.row_num === null ? null : Number(r.row_num) })), r => r.fact);
}

describe('engine parity: fact relink writes', () => {
  parityTest('placeRelinkedFact links or retires only an unplaced row of the source', { methods: ['placeRelinkedFact', 'insertFact', 'listFactsByEntity', 'listFactsForPage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage(TARGET, note('Alice'));
    const linked = await loose(engine, 'a likes tea');
    const retired = await loose(engine, 'b likes coffee');
    const foreign = await loose(engine, 'c likes cocoa', 'other');
    const gone = await loose(engine, 'd likes juice');
    await engine.expireFact(gone);

    const link = (factId: number, rowNum: number) => engine.placeRelinkedFact('default', { factId, action: 'link', slug: TARGET, rowNum, context: 'relinked' });
    const moves = {
      linked: await link(linked, 4),
      again: await link(linked, 5),
      retired: await engine.placeRelinkedFact('default', { factId: retired, action: 'retire', slug: TARGET, context: 'relinked (duplicate)' }),
      foreign: await link(foreign, 6),
      expired: await engine.placeRelinkedFact('default', { factId: gone, action: 'retire', slug: TARGET, context: 'x' }),
    };
    expect(moves).toEqual({ linked: true, again: false, retired: true, foreign: false, expired: false });
    const target = await onTarget(engine);
    expect(target).toEqual([
      { fact: 'a likes tea', context: 'relinked', expired: false },
      { fact: 'b likes coffee', context: 'relinked (duplicate)', expired: true },
    ]);
    const fence = await fenced(engine);
    expect(fence).toEqual([{ fact: 'a likes tea', row_num: 4 }]);
    return { moves, target, fence, other: await onTarget(engine, 'other') };
  });

  parityTest('placeRelinkedFact refuses a fence position another row holds', { methods: ['placeRelinkedFact', 'insertFact', 'listFactsForPage'] }, async (engine) => {
    await engine.putPage(TARGET, note('Alice'));
    const first = await loose(engine, 'a likes tea');
    const second = await loose(engine, 'b likes coffee');
    expect(await engine.placeRelinkedFact('default', { factId: first, action: 'link', slug: TARGET, rowNum: 1, context: 'c' })).toBe(true);
    const err = await engine.placeRelinkedFact('default', { factId: second, action: 'link', slug: TARGET, rowNum: 1, context: 'c' })
      .then(() => null, (e: unknown) => String((e as Error).message ?? e));
    expect(err).toContain('idx_facts_fence_key');
    const fence = await fenced(engine);
    expect(fence).toEqual([{ fact: 'a likes tea', row_num: 1 }]);
    return { refused: err !== null, fence };
  });

  parityTest('linkConversationFact links a derived row only while it is still as planned', { methods: ['linkConversationFact', 'insertFacts', 'listFactsByEntity', 'softDeletePage'] }, async (engine) => {
    await engine.putPage(TARGET, note('Alice'));
    await engine.putPage('people/gone-example', note('Gone'));
    await engine.softDeletePage('people/gone-example');
    const slug = 'conversations/2026-01-01';
    const ids = {
      plain: await derived(engine, slug, 'a met at the cafe'),
      assistant: await derived(engine, slug, 'b said by the assistant', { attributed_to: 'assistant' } as never),
      audit: await derived(engine, slug, 'c audit row', { source: TERMINAL }),
      chat: await derived(engine, slug, 'd chat row', { source: 'chat' }),
      named: await derived(engine, slug, 'e on a name key', { entity_slug: 'alice' }),
      lapsed: await derived(engine, slug, 'f lapsed', { valid_until: new Date('2001-01-01T00:00:00Z') } as never),
    };
    const to = (factId: number, fact: string, from: string | null = null, entitySlug = TARGET, pageSlug = slug) =>
      engine.linkConversationFact('default', { factId, pageSlug, fact, entitySlug, context: 'relinked', from });
    const outcomes = {
      changedClaim: await to(ids.plain, 'a met at the bar'),
      otherPage: await to(ids.plain, 'a met at the cafe', null, TARGET, 'conversations/other'),
      deletedTarget: await to(ids.plain, 'a met at the cafe', null, 'people/gone-example'),
      assistant: await to(ids.assistant, 'b said by the assistant'),
      audit: await to(ids.audit, 'c audit row'),
      chat: await to(ids.chat, 'd chat row'),
      namedWithoutFrom: await to(ids.named, 'e on a name key'),
      namedEmptyFrom: await to(ids.named, 'e on a name key', ''),
      namedOtherFrom: await to(ids.named, 'e on a name key', 'bob'),
      lapsed: await to(ids.lapsed, 'f lapsed'),
      plain: await to(ids.plain, 'a met at the cafe'),
      named: await to(ids.named, 'e on a name key', 'alice'),
      plainAgain: await to(ids.plain, 'a met at the cafe'),
    };
    expect(outcomes).toEqual({
      changedClaim: false, otherPage: false, deletedTarget: false, assistant: false, audit: false, chat: false,
      namedWithoutFrom: false, namedEmptyFrom: false, namedOtherFrom: false, lapsed: false, plain: true, named: true, plainAgain: false,
    });
    const target = await onTarget(engine);
    expect(target).toEqual([
      { fact: 'a met at the cafe', context: 'relinked', expired: false },
      { fact: 'e on a name key', context: 'relinked', expired: false },
    ]);
    return { outcomes, target };
  });

  parityTest('listConversationRelinkPages picks pages by row count, then slug in byte order', { methods: ['listConversationRelinkPages', 'insertFacts', 'upsertFactRelinkAttempt', 'expireFact'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage(TARGET, note('Alice'));
    await engine.putPage('bob', note('Bob'));
    const rows = async (slug: string, n: number, extra: Partial<NewFact> = {}) => {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) ids.push(await derived(engine, slug, `${slug} claim ${i}`, extra));
      return ids;
    };
    await rows('conversations/top', 3);
    await rows('conversations/B-page', 2);
    await rows('conversations/a-page', 2);
    await derived(engine, 'conversations/a-page', 'a row of another source', {}, 'other');
    const miss = (factId: number, reason: string) => engine.upsertFactRelinkAttempt('default',
      { factId, outcome: CONVERSATION_UNRESOLVED, reason, tier: 'mention', model: null, targetSlug: null, runId: null });
    for (const id of await rows('conversations/tried', 2)) await miss(id, 'ambiguous');
    for (const id of await rows('conversations/rearmed', 1)) await miss(id, 'no_page');
    // A page created after the attempt re-arms a no_page miss; the wait keeps its created_at strictly later on a coarse clock.
    await Bun.sleep(20);
    await engine.putPage('people/new-example', note('New'));
    await rows('conversations/noise', 1, { attributed_to: 'assistant' } as never);
    await rows('conversations/noise', 1, { source: TERMINAL });
    await rows('conversations/noise', 1, { source: 'chat' });
    await rows('conversations/noise', 1, { entity_slug: TARGET });
    await rows('conversations/noise', 1, { valid_until: new Date('2001-01-01T00:00:00Z') } as never);
    for (const id of await rows('conversations/noise', 1)) await engine.expireFact(id);
    await rows('conversations/named', 2, { entity_slug: 'alice' });
    await rows('conversations/named', 1, { entity_slug: 'bob' });

    const pick = (limit: number, unbacked = false, skipTried = !unbacked) => engine.listConversationRelinkPages('default', { limit, unbacked, skipTried });
    const picks = {
      untried: await pick(50),
      all: await pick(50, false, false),
      cut: await pick(2),
      unbacked: await pick(50, true),
      none: await pick(0),
      other: await engine.listConversationRelinkPages('other', { limit: 50, unbacked: false, skipTried: true }),
    };
    expect(picks).toEqual({
      untried: ['conversations/top', 'conversations/B-page', 'conversations/a-page', 'conversations/rearmed'],
      all: ['conversations/top', 'conversations/B-page', 'conversations/a-page', 'conversations/tried', 'conversations/rearmed'],
      cut: ['conversations/top', 'conversations/B-page'],
      unbacked: ['conversations/named'],
      none: [],
      other: ['conversations/a-page'],
    });
    return picks;
  });
});
