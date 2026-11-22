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
 *    only `facts` and `pages`, closedLoopWithActiveFact and loopFactDrift over its open loops, countLabelFacts and
 *    countPurgedPageFacts over its `page_purges` ledger, listUnwithdrawnFacts over its generation ledger and
 *    listExtractorFactsForClassification over its write journal's requests (rust/docs/store/facts.md).
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: page_purges rows are written through the typed upsertPagePurges the page purge sweep uses, on every arm.
 *    recordFenceRetirement (harness.ts) writes a facts-fence generation through the typed ledger writers the fence
 *    publish uses (activateGenerationRows, recordHeldGenerationRow), so every arm runs the listUnwithdrawnFacts cases.
 *    Every fact, page, loop and withdrawal is seeded through the typed members. The write journal behind listExtractorFactsForClassification's receipts (persistence_requests) has no
 *    typed writer that can complete a request at a fact's expiry instant, so its case asserts the answer with no receipt;
 *    the receipt join is pinned by the store test rust/crates/gbrain-store/tests/facts_extractor_classify.rs. Generated
 *    values (ids) are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, recordFenceRetirement, recordPagePurge } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { METADATA_LABELS } from '../../src/core/conversation-parser/builtins.ts';

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

  parityTest('loopFactDrift lists the closed loops of the sources whose fact is active and held by no open loop, in id order', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'upsertOpenLoop', 'closeOpenLoop', 'loopFactDrift'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const live = await fenced(engine, 'send the deck', { kind: 'commitment', source_markdown_slug: 'notes/deck' });
    const held = await fact(engine, 'call back', { kind: 'commitment' });
    const gone = await fact(engine, 'book the room', { kind: 'commitment' });
    const elsewhere = await fact(engine, 'pay the invoice', { kind: 'commitment' }, 'other');
    const at = '2026-03-01T10:00:00.000Z';
    const open = async (dedupKey: string, factId: number | null, sourceId = 'default') => Number((await engine.upsertOpenLoop({ sourceId, dedupKey,
      loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: dedupKey, evidence: [], detector: 'manual',
      factId, lastActivityAt: at, openedAt: at })).id);
    const ids: Record<string, string> = {};
    const name = async (key: string, factId: number | null, sourceId = 'default') => { const id = await open(key, factId, sourceId); ids[id] = key; return id; };
    const done = await name('done', live);
    const dropped = await name('dropped', live);
    const heldClosed = await name('held-closed', held);
    await name('held-open', held);
    const expired = await name('expired', gone);
    const stale = await name('stale', live);
    const noFact = await name('no-fact', null);
    const other = await name('other', elsewhere, 'other');
    const crossed = await name('crossed', elsewhere);
    await engine.closeOpenLoop('default', done, 'done', 'manual');
    await engine.closeOpenLoop('default', dropped, 'dropped', 'manual');
    await engine.closeOpenLoop('default', heldClosed, 'done', 'manual');
    await engine.closeOpenLoop('default', expired, 'done', 'manual');
    await engine.closeOpenLoop('default', stale, 'stale', 'manual');
    await engine.closeOpenLoop('default', noFact, 'done', 'manual');
    await engine.closeOpenLoop('other', other, 'dropped', 'manual');
    await engine.closeOpenLoop('default', crossed, 'done', 'manual');
    expect(await engine.expireFact(gone)).toBe(true);
    const facts: Record<string, string> = { [live]: 'live', [held]: 'held', [gone]: 'gone', [elsewhere]: 'elsewhere' };
    const view = (rows: Awaited<ReturnType<BrainEngine['loopFactDrift']>>) =>
      rows.map(r => ({ loop: ids[Number(r.loop_id)] ?? String(r.loop_id), source_id: r.source_id, fact: facts[Number(r.fact_id)] ?? String(r.fact_id), status: r.status, slug: r.slug }));
    const out = {
      both: view(await engine.loopFactDrift(['other', 'default'], null)),
      one: view(await engine.loopFactDrift(['default'], dropped)),
      notInSource: view(await engine.loopFactDrift(['other'], done)),
      held: view(await engine.loopFactDrift(['default'], heldClosed)),
    };
    expect(out).toEqual({
      both: [
        { loop: 'done', source_id: 'default', fact: 'live', status: 'done', slug: 'notes/deck' },
        { loop: 'dropped', source_id: 'default', fact: 'live', status: 'dropped', slug: 'notes/deck' },
        { loop: 'other', source_id: 'other', fact: 'elsewhere', status: 'dropped', slug: null },
      ],
      one: [{ loop: 'dropped', source_id: 'default', fact: 'live', status: 'dropped', slug: 'notes/deck' }],
      notInSource: [],
      held: [],
    });
    return out;
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

  parityTest('countLabelFacts folds case, allows spaces before the colon, needs the label at a line start and skips covered facts', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'upsertOpenLoop', 'countLabelFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const page = (slug: string, body: string, timeline = '', sourceId = 'default') =>
      engine.putPage(slug, { ...note(slug, body), timeline }, { sourceId });
    await page('chats/fold', 'intro\n**DATE\u2003\t :** today');
    await page('chats/first', '**Action Items:** call back');
    await page('chats/timeline', 'no label in the body', '- 2026-01-01 a call\n**Organiser:** someone');
    await page('chats/crlf', 'intro\r\n**notes:**\r\nmore');
    await page('chats/mid', 'see **Date:** inline');
    await page('chats/near', '**Dates:** soon\n**Dat:** x');
    await page('chats/audited', '**Date:** done');
    await page('chats/audit-open', '**Date:** not done');
    await page('chats/gone', '**Date:** gone');
    await page('chats/away', '**Date:** elsewhere', '', 'other');
    await engine.softDeletePage('chats/gone');
    const ctx = 'segment 1970-01-01 x';
    const label = (slug: string, text: string, extra: Record<string, unknown> = {}, sourceId = 'default') =>
      fenced(engine, text, { source: EXTRACTOR, visibility: 'private', source_markdown_slug: slug, context: ctx, ...extra }, sourceId);
    await label('chats/fold', 'fold counted');
    await label('chats/first', 'first counted');
    await label('chats/timeline', 'timeline counted');
    await label('chats/crlf', 'crlf counted');
    await label('chats/mid', 'mid not counted');
    await label('chats/near', 'near not counted');
    await label('chats/audited', 'audited not counted');
    await label('chats/audit-open', 'audit-open counted');
    await label('chats/gone', 'gone not counted');
    await label('chats/missing', 'missing page not counted');
    await label('chats/away', 'away counted in other', {}, 'other');
    await label('chats/fold', 'wrong context', { context: 'segment 2020-01-01' });
    await label('chats/fold', 'no context', { context: null });
    await label('chats/fold', 'versioned source', { source: `${EXTRACTOR}:v1` });
    const expired = await label('chats/fold', 'expired');
    expect(await engine.expireFact(expired)).toBe(true);
    await label('chats/fold', 'withdrawn for all');
    await label('chats/fold', 'withdrawn for its entity', { entity_slug: 'people/a' });
    await label('chats/fold', 'withdrawn for another entity', { entity_slug: 'people/b' });
    await label('chats/fold', 'withdrawn in world only');
    const looped = await label('chats/fold', 'held by a loop');
    const [r1, r2] = [nextRow(engine), nextRow(engine)];
    await engine.insertFacts([
      { row_num: r1, source_markdown_slug: 'chats/first', fact: 'superseded', entity_slug: null, kind: 'fact', visibility: 'private', source: EXTRACTOR, context: ctx, superseded_by_row: r2 },
      { row_num: r2, source_markdown_slug: 'chats/first', fact: 'the successor', entity_slug: null, kind: 'fact', visibility: 'private', source: EXTRACTOR, context: ctx },
    ] as never, { source_id: 'default' });
    const audit = (slug: string, source: string, context: string) => fenced(engine, `audit ${slug} ${context}`, { source, visibility: 'private', source_markdown_slug: slug, context });
    await audit('chats/audited', 'audit:terminal', 'decided extractor_version=3');
    await audit('chats/audit-open', 'audit:terminal', 'extractor_version=3 later');
    await audit('chats/audit-open', 'audit:other', 'decided extractor_version=3');
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for all', '*', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for its entity', 'people/a', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for another entity', 'people/c', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'world', 'withdrawn in world only', '*', null)).toBe(true);
    const at = '2026-03-01T10:00:00.000Z';
    await engine.upsertOpenLoop({ sourceId: 'default', dedupKey: 'loop', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com',
      summary: 'loop', evidence: [], detector: 'manual', factId: looped, lastActivityAt: at, openedAt: at });
    const labelLine = `(^|\\n)\\*\\*(${METADATA_LABELS.join('|')})[[:space:]]*:\\*\\*`;
    const args = { segmentSource: EXTRACTOR, contextLike: '%segment 1970-01-01%', labelLine, terminalSource: 'audit:terminal', nonExtractableSource: 'audit:non-extractable' };
    const counted = await engine.countLabelFacts(['default'], 100, args);
    const both = await engine.countLabelFacts(['other', 'default', 'other'], 100, args);
    const atCap = await engine.countLabelFacts(['default'], 7, args);
    const under = await engine.countLabelFacts(['default'], 6, args);
    const other = await engine.countLabelFacts(['other'], 100, args);
    expect({ counted, both, atCap, under, other }).toEqual({
      counted: { count: 7, capped: false }, both: { count: 8, capped: false }, atCap: { count: 7, capped: false },
      under: { count: 6, capped: true }, other: { count: 1, capped: false },
    });
    return { counted, both, atCap, under, other };
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

  parityTest('listExtractorFactsForClassification carries the page, withdrawal, duplicate and fence evidence of each fact', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'listExtractorFactsForClassification'],
  }, async (engine) => {
    await engine.putPage('chats/two', note('Two', 'a chat'));
    await engine.putPage('chats/deleted', note('Deleted', 'a chat'));
    const ex = (text: string, slug: string, extra: Record<string, unknown> = {}) =>
      fenced(engine, text, { source: EXTRACTOR, visibility: 'private', source_markdown_slug: slug, row_num: null, ...extra });
    const twin = await ex('twin claim', 'chats/two');
    await ex('twin claim', 'chats/two');
    const lone = await ex('lone claim', 'chats/two', { entity_slug: 'people/ann' });
    const retired = await ex('retired claim', 'chats/two', { context: 'retired: conversation-labels' });
    const held = await fenced(engine, 'fence claim', { source: 'fence', visibility: 'world', source_markdown_slug: 'chats/two' });
    const deleted = await ex('withdrawn claim', 'chats/deleted');
    const nowhere = await ex('nowhere claim', 'chats/nowhere');
    for (const id of [twin, lone, retired, held, deleted, nowhere]) expect(await engine.expireFact(id)).toBe(true);
    expect(await engine.softDeletePage('chats/deleted')).toBeTruthy();
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn claim', '*', null)).toBe(true);
    const rows = await engine.listExtractorFactsForClassification(['default'], null);
    const one = await engine.listExtractorFactsForClassification(['default'], 'chats/two');
    expect(rows.map(r => Number(r.id))).toEqual([deleted, nowhere, twin, lone]);
    const view = (list: typeof rows) => list.map(({ id: _id, page_id, expired_at, ...r }) => ({ ...r, has_page: page_id !== null, expired: /^\d{4}-\d{2}-\d{2}T/.test(expired_at) }));
    return { rows: view(rows), one: view(one) };
  });

  parityTest('countPurgedPageFacts counts the active page-extraction facts of a page that is gone', {
    methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'countPurgedPageFacts'],
  }, async (engine) => {
    await engine.putPage('notes/soft', note('Soft', 'a page'));
    expect(await engine.softDeletePage('notes/soft')).toBeTruthy();
    const at = (text: string, context: string, extra: Record<string, unknown> = {}) => fact(engine, text, { source: 'mcp:put_page', context, ...extra });
    await at('soft deleted page', 'notes/soft \u2014 a note');
    await at('no slash', 'gone');
    await at('whitespace', 'gone/a page');
    await at('gone page', 'gone/page \u2014 a note');
    await at('another', 'gone/other');
    await at('sync import', 'gone/synced', { source: 'sync:import' });
    await at('other source', 'gone/elsewhere', { source: 'mcp:other' });
    await fenced(engine, 'on a page', { source: 'mcp:put_page', context: 'gone/held', source_markdown_slug: 'gone/held', visibility: 'private' });
    await at('withdrawn', 'gone/withdrawn');
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn', '*', null)).toBe(true);
    expect(await engine.expireFact(await at('expired', 'gone/expired'))).toBe(true);
    const counted = await engine.countPurgedPageFacts(['default'], 10);
    const atCap = await engine.countPurgedPageFacts(['default'], 3);
    const under = await engine.countPurgedPageFacts(['default'], 2);
    const none = await engine.countPurgedPageFacts(['default'], 0);
    const elsewhere = await engine.countPurgedPageFacts(['other'], 10);
    expect({ counted, atCap, under, none, elsewhere }).toEqual({
      counted: { evidenced: 0, ambiguous: 3, capped: false }, atCap: { evidenced: 0, ambiguous: 3, capped: false },
      under: { evidenced: 0, ambiguous: 2, capped: true }, none: { evidenced: 0, ambiguous: 0, capped: true },
      elsewhere: { evidenced: 0, ambiguous: 0, capped: false },
    });
    return { counted, atCap, under, none, elsewhere };
  });

  parityTest('countPurgedPageFacts counts a fact as evidenced when the purge ledger names its page after it was written', {
    methods: ['insertFact', 'countPurgedPageFacts'],
  }, async (engine, backend) => {
    const at = (text: string, context: string) => fact(engine, text, { source: 'mcp:put_page', context });
    await at('purged after', 'gone/purged \u2014 a note');
    await at('bare purged after', 'bare');
    await at('bare never purged', 'other');
    await recordPagePurge(engine, backend, 'default', 'gone/purged', 'h1');
    await recordPagePurge(engine, backend, 'default', 'bare', 'h2');
    await recordPagePurge(engine, backend, 'default', 'gone/early', 'h3');
    await recordPagePurge(engine, backend, 'default', 'early', 'h4');
    // A purge in another source is no evidence for a fact of this one.
    await createSource(engine, backend, 'other');
    await recordPagePurge(engine, backend, 'other', 'other', 'h5');
    // Written after the purge: the ledger row is no evidence for these. PGLite's now() ticks in whole milliseconds, and the
    // evidence test is `purged_at >= created_at`, so a fact written in the purge's millisecond counted as evidenced (the
    // CI failure on da99c637a7: evidenced 3, ambiguous 0). Let the clock move past the purges first.
    const purgedBy = Date.now();
    while (Date.now() <= purgedBy + 1) await Bun.sleep(1);
    await at('slash written after the purge', 'gone/early');
    await at('bare written after the purge', 'early');
    const counted = await engine.countPurgedPageFacts(['default'], 10);
    const capped = await engine.countPurgedPageFacts(['default'], 1);
    const elsewhere = await engine.countPurgedPageFacts(['other'], 10);
    const total = (c: { evidenced: number; ambiguous: number }) => c.evidenced + c.ambiguous;
    expect({ counted, capped: { total: total(capped), capped: capped.capped }, elsewhere }).toEqual({
      counted: { evidenced: 2, ambiguous: 1, capped: false }, capped: { total: 1, capped: true },
      elsewhere: { evidenced: 0, ambiguous: 0, capped: false },
    });
    return { counted, capped: { total: total(capped), capped: capped.capped }, elsewhere };
  });

  parityTest('listExtractorFactsForClassification marks a fact with no page as not on a deleted page', {
    methods: ['insertFacts', 'expireFact', 'listExtractorFactsForClassification'],
  }, async (engine) => {
    const orphan = await fenced(engine, 'orphan fact', { source: EXTRACTOR, visibility: 'private', source_markdown_slug: 'chats/never', row_num: null });
    expect(await engine.expireFact(orphan)).toBe(true);
    const rows = await engine.listExtractorFactsForClassification(['default'], null);
    expect(rows.map(r => ({ id: Number(r.id), page_id: r.page_id, page_deleted: r.page_deleted }))).toEqual([{ id: orphan, page_id: null, page_deleted: false }]);
    return rows.map(({ id: _id, expired_at: _at, ...r }) => r);
  });

  parityTest('countPurgedPageFacts counts no fact of a page that was never purged', { methods: ['putPage', 'insertFacts', 'countPurgedPageFacts'] }, async (engine) => {
    await engine.putPage('notes/open', note('Open', 'a page'));
    await fenced(engine, 'a fact', { source: 'mcp:put_page', context: 'notes/open', visibility: 'private' });
    const counted = await engine.countPurgedPageFacts(['default'], 10);
    const capped = await engine.countPurgedPageFacts(['default'], 0);
    expect(counted).toEqual({ evidenced: 0, ambiguous: 0, capped: false });
    return { counted, capped };
  });

  parityTest('countPurgedPageFacts counts the active page-extraction facts of a gone page that nothing else holds', {
    methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'upsertOpenLoop', 'countPurgedPageFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', note('Open', 'a page'));
    await engine.putPage('notes/soft', note('Soft', 'a page'));
    await engine.softDeletePage('notes/soft');
    const gone = (context: string | null, text: string, extra: Record<string, unknown> = {}, sourceId = 'default') =>
      fact(engine, text, { source: 'mcp:put_page', context, ...extra }, sourceId);
    // Counted: a gone page with a '/' in its slug, by every page-extraction source.
    await gone('notes/gone \u2014 a note', 'put page fact');
    await gone('notes/gone', 'sync fact', { source: 'sync:import' });
    await gone('notes/other-gone \u2014 x', 'upload fact', { source: 'file_upload' });
    await gone('code/gone.ts \u2014 x', 'code fact', { source: 'code_import' });
    await gone('notes/x \u2014 a \u2014 b', 'two separators');
    // Not counted: no '/' and no purge record, an empty or missing context, white space in the head, a page row
    // (live or soft-deleted), another source of the fact, an expired fact.
    await gone('gone \u2014 x', 'no slash');
    await gone('', 'empty context');
    await gone(null, 'no context');
    await gone('notes/a b \u2014 x', 'a space');
    await gone('notes/a\u2003b', 'an em space');
    await gone('notes/gone \u2014x', 'no space after the dash');
    await gone('notes/open \u2014 x', 'live page');
    await gone('notes/soft \u2014 x', 'soft-deleted page');
    await gone('notes/gone \u2014 x', 'a lane fact', { source: LANE });
    expect(await engine.expireFact(await gone('notes/gone \u2014 x', 'expired'))).toBe(true);
    // Filed on a page: not a gone-page fact.
    await fenced(engine, 'filed', { source: 'mcp:put_page', context: 'notes/filed', source_markdown_slug: 'notes/filed', visibility: 'private' });
    // Withdrawals: '*' and the fact's entity exclude; another entity and the other visibility do not.
    await gone('notes/gone \u2014 x', 'withdrawn for all');
    await gone('notes/gone \u2014 x', 'withdrawn for its entity', { entity_slug: 'people/a' });
    await gone('notes/gone \u2014 x', 'withdrawn for another entity', { entity_slug: 'people/b' });
    await gone('notes/gone \u2014 x', 'withdrawn in world only');
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for all', '*', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for its entity', 'people/a', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn for another entity', 'people/c', null)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'world', 'withdrawn in world only', '*', null)).toBe(true);
    const looped = await gone('notes/gone \u2014 x', 'held by a loop');
    const at = '2026-03-01T10:00:00.000Z';
    await engine.upsertOpenLoop({ sourceId: 'default', dedupKey: 'loop', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com',
      summary: 'loop', evidence: [], detector: 'manual', factId: looped, lastActivityAt: at, openedAt: at });
    await gone('notes/gone \u2014 x', 'elsewhere', {}, 'other');
    const counted = await engine.countPurgedPageFacts(['default'], 100);
    const both = await engine.countPurgedPageFacts(['other', 'default', 'other'], 100);
    const atCap = await engine.countPurgedPageFacts(['default'], 7);
    const under = await engine.countPurgedPageFacts(['default'], 6);
    const zero = await engine.countPurgedPageFacts(['default'], 0);
    const other = await engine.countPurgedPageFacts(['other'], 100);
    const none = await engine.countPurgedPageFacts([], 100);
    expect({ counted, both, atCap, under, zero, other, none }).toEqual({
      counted: { evidenced: 0, ambiguous: 7, capped: false },
      both: { evidenced: 0, ambiguous: 8, capped: false },
      atCap: { evidenced: 0, ambiguous: 7, capped: false },
      under: { evidenced: 0, ambiguous: 6, capped: true },
      zero: { evidenced: 0, ambiguous: 0, capped: true },
      other: { evidenced: 0, ambiguous: 1, capped: false },
      none: { evidenced: 0, ambiguous: 0, capped: false },
    });
    return { counted, both, atCap, under, zero, other, none };
  });

  parityTest('countPurgedPageFacts takes a purge record of the head slug written after the fact as evidence', {
    methods: ['insertFact', 'upsertPagePurges', 'countPurgedPageFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const gone = (context: string, text: string) => fact(engine, text, { source: 'mcp:put_page', context });
    const purge = (sourceId: string, slug: string, ...contentHashes: string[]) => engine.upsertPagePurges({ sourceId, contentHashes, slug, requestId: null });
    await purge('default', 'early', 'h-early');
    await purge('default', 'notes/early', 'h-notes-early');
    await purge('default', 'moved', 'h-moved');
    await gone('purged \u2014 x', 'no slash, purged after');
    await gone('notes/purged \u2014 x', 'slash, purged after');
    await gone('early \u2014 x', 'no slash, purged before');
    await gone('notes/early \u2014 x', 'slash, purged before');
    await gone('elsewhere \u2014 x', 'purged in another source');
    await gone('moved \u2014 x', 'its tombstone moved to another slug');
    await gone('restamped \u2014 x', 'an earlier tombstone re-recorded under it after');
    await purge('default', 'purged', 'h-purged');
    await purge('default', 'notes/purged', 'h-notes-purged');
    await purge('other', 'elsewhere', 'h-elsewhere');
    // The conflict update moves h-moved to the new slug and time: 'moved' loses its tombstone, 'restamped' gains one.
    await purge('default', 'restamped', 'h-moved');
    const counted = await engine.countPurgedPageFacts(['default'], 100);
    expect(counted).toEqual({ evidenced: 3, ambiguous: 1, capped: false });
    return { counted };
  });

  parityTest('upsertPagePurges tombstones a page body so no page of that source can store it again', {
    methods: ['putPage', 'getPage', 'upsertPagePurges'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const body = note('Gone', 'a purged body');
    await engine.putPage('notes/gone', body);
    const hash = (await engine.getPage('notes/gone', { sourceId: 'default' }))?.content_hash;
    expect(typeof hash).toBe('string');
    const request = 'c0000000-0000-4000-8000-000000000001';
    await engine.upsertPagePurges({ sourceId: 'missing', contentHashes: [], slug: 'notes/none', requestId: null });
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: [hash!, 'h-other'], slug: 'notes/gone', requestId: request });
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: [hash!], slug: 'notes/gone', requestId: request });
    const refused = async (run: () => Promise<unknown>) => run().then(() => 'stored', (e: unknown) => /purged_content/.test(String((e as Error)?.message ?? e)) ? 'purged_content' : 'error');
    const answers = {
      // putPage is an upsert, so the purge trigger refuses the tombstoned body for every page of the source, the one
      // that already holds it included; another source and another body are stored.
      samePage: await refused(() => engine.putPage('notes/gone', body)),
      newPage: await refused(() => engine.putPage('notes/copy', body)),
      otherSource: await refused(() => engine.putPage('notes/copy', body, { sourceId: 'other' })),
      changedBody: await refused(() => engine.putPage('notes/fresh', note('Fresh', 'another body'))),
      repeatedHash: await refused(() => engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['h-x', 'h-x'], slug: 'notes/x', requestId: null })),
      notUuid: await refused(() => engine.upsertPagePurges({ sourceId: 'default', contentHashes: ['h-y'], slug: 'notes/y', requestId: 'nope' })),
      missingSource: await refused(() => engine.upsertPagePurges({ sourceId: 'missing', contentHashes: ['h-z'], slug: 'notes/z', requestId: null })),
      copy: (await engine.getPage('notes/copy', { sourceId: 'default' }))?.slug ?? null,
    };
    expect(answers).toEqual({ samePage: 'purged_content', newPage: 'purged_content', otherSource: 'stored', changedBody: 'stored',
      repeatedHash: 'error', notUuid: 'error', missingSource: 'error', copy: null });
    return answers;
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

  parityTest('listUnwithdrawnFacts lists the expired facts a fence generation retired, by source and page in C order, with withdrawal and duplicate', {
    methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'transaction', 'readLiveGenerationRow',
      'activateGenerationRows', 'recordHeldGenerationRow', 'listUnwithdrawnFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/bb', note('BB', 'a page'));
    await engine.putPage('notes/b-c', note('BC', 'a page'));
    await engine.putPage('notes/gone', note('Gone', 'a page'));
    await engine.softDeletePage('notes/gone');
    const retire = async (slug: string, text: string, opts: { visibility?: string; extra?: Record<string, unknown>; expire?: boolean; sourceId?: string;
      state?: 'live' | 'held'; preimage?: Record<string, unknown> } = {}) => {
      const visibility = opts.visibility ?? 'world';
      const sourceId = opts.sourceId ?? 'default';
      const id = await fact(engine, text, { visibility, source_markdown_slug: slug, ...opts.extra }, sourceId);
      if (opts.expire !== false) expect(await engine.expireFact(id)).toBe(true);
      await recordFenceRetirement(engine, sourceId, slug, id, { fact: text, visibility, state: opts.state, preimage: opts.preimage });
      return id;
    };
    await retire('notes/bb', 'retired on bb');
    await retire('notes/b-c', 'retired on b-c');
    await retire('notes/b-c', 'withdrawn on b-c', { visibility: 'private' });
    expect(await engine.insertFactWithdrawal('default', 'private', 'withdrawn on b-c', '*', null)).toBe(true);
    await retire('notes/bb', 'still active', { expire: false });
    await retire('notes/held', 'held generation', { state: 'held' });
    await retire('notes/bb', 'expired in the preimage', { preimage: { expired_at: '2026-01-01T00:00:00Z' } });
    await retire('notes/bb', 'no row number in the preimage', { preimage: { row_num: null } });
    await retire('notes/bb', 'changed text', { preimage: { fact: 'other text' } });
    await retire('notes/bb', 'a conversation fact', { extra: { source: EXTRACTOR } });
    await retire('notes/gone', 'on a deleted page');
    await retire('notes/none', 'on no page');
    await retire('notes/bb', 'in another source', { sourceId: 'other' });
    const twin = await retire('notes/bb', 'has an active twin');
    await fenced(engine, 'has an active twin', { source_markdown_slug: 'notes/bb' });
    const newer = await retire('notes/b-c', 'retired twice');
    await recordFenceRetirement(engine, 'default', 'notes/b-c', newer, { fact: 'retired twice', visibility: 'world', generation: 7, state: 'live' });
    const view = (rows: Awaited<ReturnType<BrainEngine['listUnwithdrawnFacts']>>) => rows.map(r => ({
      source: r.source_id, slug: r.slug, fact: r.fact, visibility: r.visibility, superseded: r.superseded, generation: Number(r.generation),
      same_id: Number(r.preimage.id) === Number(r.id), withdrawn: r.withdrawn, active_duplicate: r.active_duplicate, history_gap: r.history_gap,
      page: r.page_id === null ? (r.page_deleted === false ? 'none' : 'bad') : r.page_deleted ? 'deleted' : 'live', dated: typeof r.retired_at === 'string' && typeof r.expired_at === 'string',
    }));
    const all = view(await engine.listUnwithdrawnFacts(['default', 'other'], null, 'fact_fence'));
    const one = view(await engine.listUnwithdrawnFacts(['default'], 'notes/b-c', 'fact_fence'));
    const takes = await engine.listUnwithdrawnFacts(['default'], null, 'take_fence');
    const row = (source: string, slug: string, text: string, more: Record<string, unknown> = {}) => ({
      source, slug, fact: text, visibility: 'world', superseded: false, generation: 1, same_id: true, withdrawn: false, active_duplicate: false,
      history_gap: false, page: 'live', dated: true, ...more,
    });
    expect(all).toEqual([
      row('default', 'notes/b-c', 'retired on b-c'),
      row('default', 'notes/b-c', 'withdrawn on b-c', { visibility: 'private', withdrawn: true }),
      row('default', 'notes/b-c', 'retired twice', { generation: 7 }),
      row('default', 'notes/bb', 'retired on bb'),
      row('default', 'notes/bb', 'has an active twin', { active_duplicate: true }),
      row('default', 'notes/gone', 'on a deleted page', { page: 'deleted' }),
      row('default', 'notes/none', 'on no page', { page: 'none' }),
      row('other', 'notes/bb', 'in another source', { page: 'none' }),
    ]);
    expect(one).toEqual(all.filter(r => r.source === 'default' && r.slug === 'notes/b-c'));
    expect({ twin: twin > 0, takes }).toEqual({ twin: true, takes: [] });
    return { all, one, takes };
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
