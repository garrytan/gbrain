/**
 * BrainEngine parity: the group 5 facts statements of the repair classifiers and loop retirement
 * (src/core/engine-sql/facts-repair.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: loopFactDrift, closedLoopWithActiveFact, listSessionFactsForClassification, listSessionFactTwins,
 *    listCapturedFactsForClassification, countLabelFacts, listExtractorFactsForClassification, countPurgedPageFacts,
 *    listUnwithdrawnFacts and listWorldFactsFromPrivateSources return the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what the repair commands classify and
 *    repair, which loops_close retires and which world facts the visibility check flags; the Rust engine has no SQL,
 *    so each read has to exist as a typed method it can implement or refuse. The Rust store serves the four that read
 *    only `facts` and `pages`, and closedLoopWithActiveFact over its open loops; the other five read a table it does
 *    not hold and refuse (rust/docs/store/facts.md).
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none. Every fact, page and loop is seeded through the typed members. The tables behind the five refused members
 *    (open_loops, fact_withdrawals, persistence_requests, page_purges, derived_generations) have no typed writer on the
 *    engine, so those cases seed the facts the statement joins from and assert the answer an empty table gives; the
 *    Rust arm counts each as a typed refusal. Generated values (ids) are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const LANE = 'hook:agent-session';
const LANES = [LANE, 'hook:agent-session-raw'];
const EXTRACTOR = 'cli:extract-conversation-facts';

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** One fact through the typed `insertFact`; `extra` overrides the defaults. Returns the id as a number. */
async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = 'default'): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: LANE, embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** A fact held by a page's fence: `insertFacts` keeps `row_num` and `source_markdown_slug`. */
async function fenced(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = 'default'): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  return Number(res.ids[0]);
}

describe('engine parity: group 5 facts repair statements', () => {
  parityTest('loopFactDrift lists the closed loops whose commitment fact is still active (none with no loop)', { methods: ['insertFact', 'loopFactDrift'] }, async (engine) => {
    const f = await fact(engine, 'send the deck', { kind: 'commitment' });
    expect(f).toBeGreaterThan(0);
    const all = await engine.loopFactDrift(['default'], null);
    const one = await engine.loopFactDrift(['default'], 1);
    const none = await engine.loopFactDrift([], null);
    expect({ all, one, none }).toEqual({ all: [], one: [], none: [] });
    return { all, one, none };
  });

  parityTest('closedLoopWithActiveFact finds no loop that does not exist, scoped or not', { methods: ['closedLoopWithActiveFact'] }, async (engine) => {
    const scoped = await engine.closedLoopWithActiveFact('default', 1);
    const unscoped = await engine.closedLoopWithActiveFact(null, 1);
    expect({ scoped, unscoped }).toEqual({ scoped: null, unscoped: null });
    return { scoped, unscoped };
  });

  parityTest('closedLoopWithActiveFact returns a closed loop only while its fact is unexpired, in its own source', {
    methods: ['insertFact', 'expireFact', 'upsertOpenLoop', 'closeOpenLoop', 'closedLoopWithActiveFact'],
  }, async (engine) => {
    const live = await fact(engine, 'send the deck', { kind: 'commitment' });
    const gone = await fact(engine, 'call back', { kind: 'commitment' });
    const at = '2026-03-01T10:00:00.000Z';
    const open = async (dedupKey: string, factId: number | null) => Number((await engine.upsertOpenLoop({ sourceId: 'default', dedupKey,
      loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: dedupKey, evidence: [], detector: 'manual',
      factId, lastActivityAt: at, openedAt: at })).id);
    const a = await open('a', live);
    const b = await open('b', gone);
    const c = await open('c', null);
    const d = await open('d', live);
    const stillOpen = await engine.closedLoopWithActiveFact(null, a);
    await engine.closeOpenLoop('default', a, 'done', 'manual');
    await engine.closeOpenLoop('default', b, 'dropped', 'manual');
    await engine.closeOpenLoop('default', c, 'done', 'manual');
    await engine.closeOpenLoop('default', d, 'stale', 'manual');
    expect(await engine.expireFact(gone)).toBe(true);
    const view = (row: Awaited<ReturnType<BrainEngine['closedLoopWithActiveFact']>>) =>
      row ? { id: Number(row.id) === a ? 'a' : String(row.id), status: row.status, fact: Number(row.fact_id) === live ? 'live' : String(row.fact_id) } : null;
    const out = {
      stillOpen: view(stillOpen),
      scoped: view(await engine.closedLoopWithActiveFact('default', a)),
      unscoped: view(await engine.closedLoopWithActiveFact(null, a)),
      otherSource: view(await engine.closedLoopWithActiveFact('other', a)),
      expiredFact: view(await engine.closedLoopWithActiveFact(null, b)),
      noFact: view(await engine.closedLoopWithActiveFact(null, c)),
      stale: view(await engine.closedLoopWithActiveFact(null, d)),
    };
    expect(out).toEqual({ stillOpen: null, scoped: { id: 'a', status: 'done', fact: 'live' }, unscoped: { id: 'a', status: 'done', fact: 'live' },
      otherSource: null, expiredFact: null, noFact: null, stale: null });
    return out;
  });

  parityTest('listSessionFactsForClassification lists the active user-or-unset lane facts by source then id, or only the named ones', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'listSessionFactsForClassification'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await fenced(engine, 'alpha', { source: LANE, visibility: 'private', source_session: 's1', context: 'ctx', entity_slug: 'people/a', source_markdown_slug: 'notes/a' });
    await fact(engine, 'bravo', { attributed_to: 'assistant' });
    const c = await fact(engine, 'charlie', { attributed_to: 'user' });
    await fact(engine, 'delta', { source: 'mcp:remember' });
    const e = await fact(engine, 'echo', {}, 'other');
    const f = await fact(engine, 'foxtrot');
    expect(await engine.expireFact(f)).toBe(true);
    const g = await fact(engine, 'golf');
    const g2 = await fact(engine, 'golf two');
    expect(await engine.expireFact(g, { supersededBy: g2 })).toBe(true);
    const view = (rows: Awaited<ReturnType<BrainEngine['listSessionFactsForClassification']>>) =>
      rows.map(({ id, ...r }) => ({ id: Number(id), ...r }));
    const all = view(await engine.listSessionFactsForClassification(['other', 'default'], LANES, null));
    expect(all.map(r => r.id)).toEqual([a, c, g2, e]);
    expect(all[0]).toMatchObject({ source_session: 's1', context: 'ctx', entity_slug: 'people/a', row_num: 1, source_markdown_slug: 'notes/a', attributed_to: null });
    const named = view(await engine.listSessionFactsForClassification(['default', 'other'], LANES, [e, a, 999_999]));
    expect(named.map(r => r.id)).toEqual([a, e]);
    const empty = await engine.listSessionFactsForClassification(['default'], LANES, []);
    const noLane = await engine.listSessionFactsForClassification(['default'], [], null);
    expect(empty).toEqual([]);
    expect(noLane).toEqual([]);
    return { all: all.map(({ id: _id, ...r }) => r), named: named.map(({ id: _id, ...r }) => r), empty, noLane };
  });

  parityTest('listSessionFactTwins names the owner twin and the lane sessions of each fact, by id', {
    methods: ['insertFact', 'expireFact', 'listSessionFactTwins'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const lane = (text: string, session: string | null, extra: Record<string, unknown> = {}) =>
      fact(engine, text, { entity_slug: 'people/a', ...(session === null ? {} : { source_session: session }), ...extra });
    const a = await lane('Alice moved to Paris', 's2');
    await lane('alice  MOVED to paris', 's1');
    const c = await lane('Alice moved to Paris', null);
    await lane('Alice moved to Paris', 's1', { attributed_to: 'assistant' });
    const expired = await lane('Alice moved to Paris', 's9');
    expect(await engine.expireFact(expired)).toBe(true);
    await fact(engine, 'Alice moved to Paris', { source: 'mcp:remember', entity_slug: 'people/a', visibility: 'world' });
    const lone = await lane('Only one', 's3');
    await fact(engine, 'Only one', { entity_slug: 'people/a', source_session: 's7' }, 'other');
    const view = (rows: Awaited<ReturnType<BrainEngine['listSessionFactTwins']>>) =>
      rows.map(r => ({ id: Number(r.id), owner_twin: r.owner_twin, twin_sessions: [...(r.twin_sessions ?? [])].sort() }));
    const rows = view(await engine.listSessionFactTwins([lone, c, a, a, 999_999], LANES));
    expect(rows.map(r => r.id)).toEqual([a, c, lone]);
    expect(rows.map(r => r.owner_twin)).toEqual([true, true, false]);
    expect(rows.map(r => r.twin_sessions)).toEqual([['', 's1'], ['s1', 's2'], []]);
    const noLane = view(await engine.listSessionFactTwins([a], []));
    expect(noLane).toEqual([{ id: a, owner_twin: true, twin_sessions: [] }]);
    const noIds = await engine.listSessionFactTwins([], LANES);
    expect(noIds).toEqual([]);
    return { rows: rows.map(({ id: _id, ...r }) => r), noLane: noLane.map(({ id: _id, ...r }) => r), noIds };
  });

  parityTest('listCapturedFactsForClassification carries each lane fact fingerprint and whether a legitimate twin exists', {
    methods: ['insertFact', 'expireFact', 'listCapturedFactsForClassification'],
  }, async (engine) => {
    const a = await fact(engine, 'Alice moved to Paris', { entity_slug: 'people/a' });
    const owner = await fact(engine, 'alice MOVED to paris', { source: 'mcp:remember', entity_slug: 'people/a' });
    const b = await fact(engine, 'Bob likes tea', { entity_slug: 'people/b' });
    await fact(engine, 'Bob likes tea', { source: 'mcp:remember', visibility: 'world', entity_slug: 'people/b' });
    const c = await fact(engine, 'Carol likes jam', { entity_slug: 'people/c' });
    await fact(engine, 'Carol likes jam', { source: 'mcp:remember', entity_slug: 'people/other' });
    const d = await fact(engine, 'Dan likes figs');
    const dx = await fact(engine, 'Dan likes figs', { source: 'mcp:remember' });
    expect(await engine.expireFact(dx)).toBe(true);
    const view = (rows: Awaited<ReturnType<BrainEngine['listCapturedFactsForClassification']>>) => rows.map(({ id, ...r }) => ({ id: Number(id), ...r }));
    const all = view(await engine.listCapturedFactsForClassification(['default'], LANES, null));
    expect(all.map(r => r.id)).toEqual([a, b, c, d]);
    expect(all.map(r => r.legit_twin)).toEqual([true, false, false, false]);
    expect(all[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const ownerRow = view(await engine.listCapturedFactsForClassification(['default'], ['mcp:remember'], [owner]));
    expect(ownerRow[0]!.fingerprint).toBe(all[0]!.fingerprint);
    const named = view(await engine.listCapturedFactsForClassification(['default'], LANES, [c]));
    expect(named.map(r => r.id)).toEqual([c]);
    return { all: all.map(({ id: _id, ...r }) => r), named: named.map(({ id: _id, ...r }) => r) };
  });

  parityTest('countLabelFacts counts the label facts of a page that carries a metadata label line, capped', {
    methods: ['putPage', 'insertFacts', 'countLabelFacts'],
  }, async (engine) => {
    await engine.putPage('chats/one', note('One', 'a chat\n**Date:** yesterday\nmore'));
    await engine.putPage('chats/two', note('Two', 'a chat with no label line'));
    await fenced(engine, 'labelled', { source: EXTRACTOR, visibility: 'private', source_markdown_slug: 'chats/one', context: 'segment 1970-01-01 x' });
    await fenced(engine, 'unlabelled', { source: EXTRACTOR, visibility: 'private', source_markdown_slug: 'chats/two', context: 'segment 1970-01-01 x' });
    const args = { segmentSource: EXTRACTOR, contextLike: '%segment 1970-01-01%', labelLine: '(^|\\n)\\*\\*(Date|Time)[[:space:]]*:\\*\\*', terminalSource: 'audit:terminal', nonExtractableSource: 'audit:non-extractable' };
    const counted = await engine.countLabelFacts(['default'], 10, args);
    const capped = await engine.countLabelFacts(['default'], 0, args);
    const none = await engine.countLabelFacts([], 10, args);
    expect(counted).toEqual({ count: 1, capped: false });
    expect(capped).toEqual({ count: 0, capped: true });
    expect(none).toEqual({ count: 0, capped: false });
    return { counted, capped, none };
  });

  parityTest('listExtractorFactsForClassification lists the expired fenceless extractor facts with their evidence', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'listExtractorFactsForClassification'],
  }, async (engine) => {
    await engine.putPage('chats/one', note('One', 'a chat'));
    const kept = await fenced(engine, 'kept fact', { source: `${EXTRACTOR}:v1`, visibility: 'private', source_markdown_slug: 'chats/one', row_num: null });
    const active = await fenced(engine, 'still active', { source: EXTRACTOR, visibility: 'private', source_markdown_slug: 'chats/one', row_num: null });
    expect(await engine.expireFact(kept)).toBe(true);
    expect(active).toBeGreaterThan(0);
    const rows = await engine.listExtractorFactsForClassification(['default'], null);
    const bySlug = await engine.listExtractorFactsForClassification(['default'], 'chats/one');
    const elsewhere = await engine.listExtractorFactsForClassification(['default'], 'chats/none');
    expect(rows.map(r => Number(r.id))).toEqual([kept]);
    expect(elsewhere).toEqual([]);
    const view = (list: typeof rows) => list.map(({ id: _id, page_id: _page, expired_at, ...r }) => { expect(expired_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/); return r; });
    return { rows: view(rows), bySlug: view(bySlug), elsewhere };
  });

  parityTest('countPurgedPageFacts counts no fact of a page that was never purged', { methods: ['putPage', 'insertFacts', 'countPurgedPageFacts'] }, async (engine) => {
    await engine.putPage('notes/open', note('Open', 'a page'));
    await fenced(engine, 'a fact', { source: 'mcp:put_page', context: 'notes/open', visibility: 'private' });
    const counted = await engine.countPurgedPageFacts(['default'], 10);
    const capped = await engine.countPurgedPageFacts(['default'], 0);
    expect(counted).toEqual({ evidenced: 0, ambiguous: 0, capped: false });
    return { counted, capped };
  });

  parityTest('listUnwithdrawnFacts lists no fact when no facts-fence generation retired one', { methods: ['putPage', 'insertFacts', 'expireFact', 'listUnwithdrawnFacts'] }, async (engine) => {
    await engine.putPage('notes/open', note('Open', 'a page'));
    const id = await fenced(engine, 'a retired fact', { source_markdown_slug: 'notes/open', visibility: 'world' });
    expect(await engine.expireFact(id)).toBe(true);
    const all = await engine.listUnwithdrawnFacts(['default'], null, 'fact_fence');
    const one = await engine.listUnwithdrawnFacts(['default'], 'notes/open', 'fact_fence');
    expect({ all, one }).toEqual({ all: [], one: [] });
    return { all, one };
  });

  parityTest('listWorldFactsFromPrivateSources follows the holding page and the page a fact was extracted from', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'listWorldFactsFromPrivateSources'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', note('Open', 'open'));
    await engine.putPage('notes/private', note('Private', 'private', { visibility: 'private' }));
    await engine.putPage('notes/alias', note('Alias', 'alias', { access: ' Confidential ' }));
    await engine.putPage('notes/readers', note('Readers', 'readers', { readable_by: ['x'] }));
    await engine.putPage('notes/derived', note('Derived', 'derived', {}, 'atom'));
    await engine.putPage('notes/pinned', note('Pinned', 'pinned', { pinned_question: true }));
    await engine.putPage('notes/gone', note('Gone', 'gone', { visibility: 'private' }));
    await engine.putPage('notes/elsewhere', note('Elsewhere', 'elsewhere', { visibility: 'private' }), { sourceId: 'other' });
    await engine.softDeletePage('notes/gone');
    const held = (slug: string, extra: Record<string, unknown> = {}) => fenced(engine, `held by ${slug}`, { source_markdown_slug: slug, ...extra });
    const named = (text: string, extra: Record<string, unknown>) => fact(engine, text, { visibility: 'world', ...extra });
    const open = await held('notes/open');
    const priv = await held('notes/private', { entity_slug: 'people/a' });
    const alias = await held('notes/alias');
    const readers = await held('notes/readers');
    const derived = await held('notes/derived');
    const pinned = await held('notes/pinned');
    await held('notes/gone');
    await held('notes/missing');
    const bySession = await named('named by session', { source: 'mcp:put_page', source_session: 'put_page:notes/private.md' });
    const byContext = await named('named by context', { source: 'sync:import', context: ' notes/private.md rest of it ' });
    const byContextAlias = await named('named by context alias', { source: 'code_import', context: 'notes/alias' });
    await named('a source that names no page', { source: 'cli', context: 'notes/private' });
    await named('an empty session name', { source: 'mcp:put_page', source_session: 'sync:', context: 'notes/private' });
    await named('page lives in another source', { source: 'mcp:put_page', context: 'notes/elsewhere' });
    await fenced(engine, 'a private fact', { visibility: 'private', source_markdown_slug: 'notes/private' });
    const expired = await held('notes/private');
    expect(await engine.expireFact(expired)).toBe(true);
    const view = async (ids: number[] | null, sourceIds = ['default']) => (await engine.listWorldFactsFromPrivateSources(sourceIds, ids)).map(({ id, ...r }) => ({ id: Number(id), ...r }));
    const all = await view(null);
    expect(all.map(r => r.id)).toEqual([priv, alias, readers, derived, pinned, bySession, byContext, byContextAlias]);
    const readable = (id: number) => all.find(r => r.id === id)!.readable;
    expect([priv, readers, derived, pinned, bySession, byContextAlias].map(readable)).toEqual([false, true, false, false, true, true]);
    expect(open).toBeGreaterThan(0);
    const named2 = await view([readers, alias, open]);
    expect(named2.map(r => r.id)).toEqual([alias, readers]);
    const empty = await view([]);
    const noSource = await view(null, []);
    const otherSource = await view(null, ['other']);
    expect({ empty, noSource, otherSource }).toEqual({ empty: [], noSource: [], otherSource: [] });
    const strip = (rows: typeof all) => rows.map(({ id: _id, ...r }) => r);
    return { all: strip(all), named: strip(named2), empty, noSource, otherSource };
  });
});
