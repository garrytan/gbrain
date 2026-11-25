/**
 * BrainEngine parity — the facts statements the doctor checks ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listConversationFactRows, countRedactedFacts, listOutsideContentFenceCounts, countAtomFacts,
 *    listUnpreviewedTrustFacts, countUnlinkedFactsByOrigin, countUnlinkedFactStats, countFactRelinkOutcomes,
 *    listUnlinkedConversationSlugs and countFactEmbeddingCoverage return the same observable result on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what the conversation_outcomes_stale,
 *    facts_redaction_marker, outside_content_fences, queue_health, trust_release_unpreviewed_fields, unlinked_facts and
 *    fact_take_vectors doctor checks report; the Rust engine has no SQL, so each read has to exist as a typed method it
 *    can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none for the facts, pages, takes, links and relink attempts, which are seeded through typed methods on every
 *    arm (the attempts through upsertFactRelinkAttempt). listUnpreviewedTrustFacts reads `write_gate_holds`, which has no
 *    typed writer: its case seeds nothing and compares the empty answer, so it pins the statement's validity, not its
 *    filters. The 7-day cutoffs of countFactRelinkOutcomes and
 *    countUnlinkedFactStats have no case either, because neither an attempt's `attempted_at` nor a fact's
 *    `created_at` can be set through a typed method. countFactRelinkOutcomes' cutoff is pinned per engine instead:
 *    test/engine-sql-fact-relink-attempts.test.ts (SQL) and the store's tests/facts_doctor.rs (Rust).
 *    Generated values (ids, timestamps) are never returned. The one-tick memo cases stop the process clock with
 *    bun:test setSystemTime, which PGLite reads in whole milliseconds; Postgres and the Rust store keep their own
 *    clocks, so on those arms the case is the plain memo case.
 */
import { afterEach, describe, expect, setSystemTime } from 'bun:test';
import { archiveSource, basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { REARMED_REASONS } from '../../src/core/facts/conversation-memo.ts';

const { parityTest } = parityArms(testBackends());

const TERMINAL = 'cli:extract-conversation-facts:terminal:v2';
const NON_EXTRACTABLE = 'cli:extract-conversation-facts:non-extractable:v2';
const LEGACY_TERMINAL = 'cli:extract-conversation-facts:terminal';
const CONVERSATION = 'cli:extract-conversation-facts';
const MODEL = 'model-a';

let seq = 0;

/** A fact that names no page, through insertFact. */
async function fact(engine: BrainEngine, text: string, extra: Partial<NewFact> = {}, sourceId = 'default'): Promise<number> {
  return (await engine.insertFact({ fact: text, source: 'chat', ...extra }, { source_id: sourceId })).id;
}

/** A fact that names a page, through insertFacts (the only writer of the fence columns); a fresh row_num unless given. */
async function pageFact(engine: BrainEngine, slug: string, text: string, extra: Partial<NewFact> & { row_num?: number } = {}, sourceId = 'default'): Promise<number> {
  const { row_num, ...rest } = extra;
  const out = await engine.insertFacts([{ fact: text, source: 'chat', ...rest, row_num: row_num ?? ++seq, source_markdown_slug: slug }], { source_id: sourceId });
  return out.ids[0]!;
}

const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: 'body', frontmatter });

describe('engine parity: doctor-check facts statements', () => {
  // A one-tick case stops the process clock (seedMemos); a case that fails before conv/b exists still gets it back.
  afterEach(() => setSystemTime());
  parityTest('listConversationFactRows returns the unexpired extraction-outcome rows of the named sources, newest first', { methods: ['listConversationFactRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await pageFact(engine, 'conv/a', 'a', { source: TERMINAL, context: 'ctx-a' });
    await pageFact(engine, 'conv/b', 'b', { source: NON_EXTRACTABLE });
    await pageFact(engine, 'conv/legacy', 'legacy', { source: LEGACY_TERMINAL });
    await pageFact(engine, 'conv/plain', 'plain', { source: CONVERSATION });
    await pageFact(engine, 'conv/c', 'c', { source: TERMINAL, context: 'ctx-c' }, 'other');
    const gone = await pageFact(engine, 'conv/gone', 'gone', { source: TERMINAL });
    await engine.expireFact(gone);
    const both = await engine.listConversationFactRows(['default', 'other'], 10);
    const one = await engine.listConversationFactRows(['default'], 1);
    const none = await engine.listConversationFactRows([], 5);
    expect(both.map(r => r.slug)).toEqual(['conv/c', 'conv/b', 'conv/a']);
    expect(none).toEqual([]);
    return { both, one, none };
  });

  parityTest('countRedactedFacts counts the active redaction-marker rows of the live, named sources', { methods: ['countRedactedFacts'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    await fact(engine, 'key is [redacted:token]');
    await fact(engine, 'all clear');
    await fact(engine, '[redacted', {}, 'other');
    await fact(engine, '[redacted] too', {}, 'old');
    const expired = await fact(engine, '[redacted] expired');
    await engine.expireFact(expired);
    const successor = await fact(engine, '[redacted] successor');
    const superseded = await fact(engine, '[redacted] superseded');
    await engine.insertFact({ fact: 'replacement', source: 'chat' }, { source_id: 'default', supersedeId: superseded });
    await archiveSource(engine, backend, 'old');
    const all = await engine.countRedactedFacts();
    const named = await engine.countRedactedFacts(['default']);
    const archived = await engine.countRedactedFacts(['old']);
    const empty = await engine.countRedactedFacts([]);
    expect(successor).toBeGreaterThan(0);
    expect(all).toBe(3);
    return { all, named, archived, empty };
  });

  parityTest('listOutsideContentFenceCounts counts fence rows indexed from pages a third party wrote', { methods: ['listOutsideContentFenceCounts'] }, async (engine, backend) => {
    await createSource(engine, backend, 'mail', { kind: 'google' });
    await createSource(engine, backend, 'gh', { kind: 'github' });
    await createSource(engine, backend, 'dead', { kind: 'github' });
    const email = await engine.putPage('inbox/one', note('One', {}, 'email'), { sourceId: 'mail' });
    await engine.putPage('notes/own', note('Own'), { sourceId: 'mail' });
    await engine.putPage('repo/issue', note('Issue'), { sourceId: 'gh' });
    await engine.putPage('repo/deleted', note('Deleted'), { sourceId: 'gh' });
    await engine.putPage('calls/standup', note('Standup', { transcript_import: true }));
    await engine.putPage('calls/plain', note('Plain'));
    await engine.putPage('repo/x', note('X'), { sourceId: 'dead' });
    await engine.softDeletePage('repo/deleted', { sourceId: 'gh' });
    await pageFact(engine, 'inbox/one', 'e1', { visibility: 'world' }, 'mail');
    await pageFact(engine, 'inbox/one', 'e2', { visibility: 'private' }, 'mail');
    await pageFact(engine, 'notes/own', 'o1', { visibility: 'world' }, 'mail');
    await pageFact(engine, 'repo/issue', 'g1', { visibility: 'world' }, 'gh');
    await pageFact(engine, 'repo/deleted', 'g2', { visibility: 'world' }, 'gh');
    await pageFact(engine, 'calls/standup', 's1', { visibility: 'private' });
    await pageFact(engine, 'calls/plain', 'p1', { visibility: 'world' });
    await pageFact(engine, 'repo/x', 'x1', { visibility: 'world' }, 'dead');
    const expired = await pageFact(engine, 'inbox/one', 'e3', { visibility: 'world' }, 'mail');
    await engine.expireFact(expired);
    await archiveSource(engine, backend, 'dead');
    await engine.addTakesBatch([
      { page_id: Number(email.id), row_num: 1, claim: 'c', kind: 'fact', holder: 'h', weight: 0.5, active: true },
      { page_id: Number(email.id), row_num: 2, claim: 'd', kind: 'fact', holder: 'h', weight: 0.5, active: false },
    ]);
    await engine.addLink('inbox/one', 'repo/issue', '', 'x', undefined, 'inbox/one', 'links_fence', { fromSourceId: 'mail', toSourceId: 'gh', originSourceId: 'mail' });
    const rows = await engine.listOutsideContentFenceCounts();
    expect(rows.map(({ source_id, slug, type, facts, world_facts, takes, links }) => [source_id, slug, type, facts, world_facts, takes, links])).toEqual([
      ['default', 'calls/standup', 'note', 1, 0, 0, 0],
      ['gh', 'repo/issue', 'note', 1, 1, 0, 0],
      ['mail', 'inbox/one', 'email', 2, 1, 1, 1],
    ]);
    return rows;
  });

  parityTest('countAtomFacts counts the unexpired rows whose page or context starts with atoms/', { methods: ['countAtomFacts'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await pageFact(engine, 'atoms/one', 'a');
    await fact(engine, 'b', { context: 'atoms/two' }, 'other');
    await pageFact(engine, 'notes/atoms/x', 'c');
    await fact(engine, 'd', { context: 'Atoms/x' });
    await fact(engine, 'plain');
    const gone = await fact(engine, 'e', { context: 'atoms/expired' });
    await engine.expireFact(gone);
    const count = await engine.countAtomFacts();
    expect(count).toBe(2);
    return count;
  });

  parityTest('listUnpreviewedTrustFacts reads the trust-release holds', { methods: ['listUnpreviewedTrustFacts'] }, async (engine) => {
    // No typed writer exists for write_gate_holds or the trust columns, so only the empty answer is compared.
    await pageFact(engine, 'notes/trusted', 'a user-confirmed fact', { entity_slug: 'people/a' });
    const rows = await engine.listUnpreviewedTrustFacts(10);
    expect(rows).toEqual([]);
    return rows;
  });

  /** Fixture for the window reads: oldest first, one insert per call so `created_at` orders them. Returns the ids the memo cases name. */
  async function seedWindow(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<Record<'c1' | 'c2' | 'c3' | 'plain', number>> {
    await createSource(engine, backend, 'other');
    await pageFact(engine, 'conv/old', 'old', { source: CONVERSATION });
    await pageFact(engine, 'conv/a', 'linked', { source: CONVERSATION, entity_slug: 'people/a' });
    const c1 = await pageFact(engine, 'conv/b', 'c1', { source: CONVERSATION });
    const c2 = await pageFact(engine, 'conv/b', 'c2', { source: CONVERSATION });
    const c3 = await pageFact(engine, 'conv/c', 'c3', { source: CONVERSATION });
    await pageFact(engine, 'notes/f', 'fence', { source: 'chat', row_num: 1 });
    await pageFact(engine, 'conv/z', 'audit', { source: TERMINAL });
    const plain = await fact(engine, 'plain');
    await fact(engine, 'assistant said', { attributed_to: 'assistant' });
    await fact(engine, 'put page', { source: 'mcp:put_page' });
    await fact(engine, 'hooked', { source: 'hook:capture' });
    await fact(engine, 'o', {}, 'other');
    return { c1, c2, c3, plain };
  }

  const attempt = (engine: BrainEngine, factId: number, outcome: string, reason: string | null, tier: string | null, targetSlug: string | null = null) =>
    engine.upsertFactRelinkAttempt('default', { factId, outcome, reason, tier, model: null, targetSlug, runId: null });

  /**
   * The free-relink memos of the window fixture: c1's miss is memoized (`ambiguous`), c2's re-armed (`no_mention`), c3's
   * NULL; `plain` has no subject. `page()` then creates conv/b, which re-arms c2 and c3, and `paid(hash)` records a paid
   * re-extraction of conv/b (on a negative id, which no fact has) with the given content hash. With `oneTick`, the
   * process clock stops from the first attempt until conv/b exists, so on PGLite (whose clock is the process clock, in
   * whole milliseconds) the attempts and the page share one timestamp, as on a fast machine.
   */
  async function seedMemos(engine: BrainEngine, ids: Awaited<ReturnType<typeof seedWindow>>, oneTick = false) {
    expect([REARMED_REASONS.includes('no_mention'), REARMED_REASONS.includes('ambiguous')]).toEqual([true, false]);
    if (oneTick) setSystemTime(new Date());
    await attempt(engine, ids.c1, 'conversation_unresolved', 'ambiguous', 'mention');
    await attempt(engine, ids.c2, 'conversation_unresolved', 'no_mention', 'mention');
    await attempt(engine, ids.c3, 'conversation_unresolved', null, 'mention');
    await attempt(engine, ids.plain, 'no_subject', 'no_subject', 'model');
    return {
      page: async () => {
        try { await engine.putPage('conv/b', note('b')); } finally { if (oneTick) setSystemTime(); }
        return (await engine.getPage('conv/b'))?.content_hash ?? '';
      },
      paid: (hash: string, factId = -1) => attempt(engine, factId, 'paid_reextract', hash, 'paid_reextract', 'conv/b'),
    };
  }

  const originOpts = (windowPerSource: number, sourceIds = ['default', 'other']) =>
    ({ sourceIds, auditSources: [TERMINAL], windowPerSource, hasAttempts: false });
  const memoCounts = (rows: Array<{ origin: string; conversation_tried: number; conversation_paid: number }>) =>
    rows.filter(r => r.origin === 'conversation').map(r => [r.conversation_tried, r.conversation_paid]);

  parityTest('countUnlinkedFactsByOrigin counts each source\'s newest window of active facts by origin', { methods: ['countUnlinkedFactsByOrigin'] }, async (engine, backend) => {
    await seedWindow(engine, backend);
    const key = (r: { source_id: string; origin: string }) => `${r.source_id}:${r.origin}`;
    const wide = sorted(await engine.countUnlinkedFactsByOrigin(originOpts(100)), key);
    const narrow = sorted(await engine.countUnlinkedFactsByOrigin(originOpts(3, ['default'])), key);
    const none = await engine.countUnlinkedFactsByOrigin(originOpts(0, ['default']));
    const twice = sorted(await engine.countUnlinkedFactsByOrigin(originOpts(100, ['other', 'other'])), key);
    expect(wide.map(key)).toEqual(['default:conversation', 'default:extraction', 'default:mcp:put_page', 'default:remember', 'other:remember']);
    // The newest three active rows are the hooked, put-page and plain facts (the assistant's is not an entity fact).
    expect(narrow.map(key)).toEqual(['default:extraction', 'default:mcp:put_page', 'default:remember']);
    expect(wide.map(r => [key(r), r.active, r.unlinked, r.fence_owned, r.conversation, r.conversation_tried, r.conversation_paid])).toEqual([
      ['default:conversation', 5, 4, 0, 4, 0, 0],
      ['default:extraction', 1, 1, 0, 0, 0, 0],
      ['default:mcp:put_page', 1, 1, 0, 0, 0, 0],
      ['default:remember', 2, 2, 1, 0, 0, 0],
      ['other:remember', 1, 1, 0, 0, 0, 0],
    ]);
    expect(twice.map(r => r.active)).toEqual([2]);
    expect(none).toEqual([]);
    return { wide, narrow, none, twice };
  });

  async function originMemos(engine: BrainEngine, backend: Parameters<typeof createSource>[1], oneTick: boolean) {
    const memo = await seedMemos(engine, await seedWindow(engine, backend), oneTick);
    const read = async () => sorted(await engine.countUnlinkedFactsByOrigin({ ...originOpts(100, ['default']), hasAttempts: true }), r => `${r.source_id}:${r.origin}`);
    const unpaged = await read();
    const hash = await memo.page();
    const rearmed = await read();
    await memo.paid('stale');
    const stale = await read();
    await memo.paid(hash, -2);
    const paid = await read();
    const without = sorted(await engine.countUnlinkedFactsByOrigin(originOpts(100, ['default'])), r => `${r.source_id}:${r.origin}`);
    // No page yet: c1, c2 and c3 are tried. conv/b re-arms c2 (a re-armed reason) and c3 (a NULL reason); only the
    // current content hash covers c1's page.
    expect([memoCounts(unpaged), memoCounts(rearmed), memoCounts(stale), memoCounts(paid), memoCounts(without)])
      .toEqual([[[3, 0]], [[1, 0]], [[1, 0]], [[1, 1]], [[0, 0]]]);
    return { unpaged, rearmed, stale, paid, without };
  }

  parityTest('countUnlinkedFactsByOrigin with hasAttempts counts the tried and paid conversation rows', { methods: ['countUnlinkedFactsByOrigin', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    originMemos(engine, backend, false));
  parityTest('countUnlinkedFactsByOrigin with hasAttempts re-arms on a page created in the clock tick of the attempt', { methods: ['countUnlinkedFactsByOrigin', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    originMemos(engine, backend, true));

  parityTest('countUnlinkedFactStats counts the last 7 days of active facts and the inferred tiers', { methods: ['countUnlinkedFactStats'] }, async (engine) => {
    const infer = (tier: string, prefix = '', linked = false) =>
      fact(engine, tier, { context: `${prefix}entity inferred from ${tier}`, ...(linked ? { entity_slug: 'people/a' } : {}) });
    await infer('page');
    await infer('mention', '', true);
    await infer('page', 'met on Monday — ');
    await infer('other');
    await fact(engine, 'plain');
    await fact(engine, 'audit', { source: TERMINAL });
    await fact(engine, 'assistant said', { attributed_to: 'assistant' });
    const gone = await fact(engine, 'expired', { context: 'entity inferred from page' });
    await engine.expireFact(gone);
    const stats = await engine.countUnlinkedFactStats({ sourceIds: ['default'], auditSources: [TERMINAL], hasAttempts: false });
    const none = await engine.countUnlinkedFactStats({ sourceIds: [], auditSources: [TERMINAL], hasAttempts: false });
    expect(stats).toEqual({ facts: 5, unlinked: 4, no_subject: 0, conversation_unresolved: 0, inferred_page: 2, inferred_mention: 1 });
    expect(none?.facts).toBe(0);
    return { stats, none };
  });

  async function statsMemos(engine: BrainEngine, backend: Parameters<typeof createSource>[1], oneTick: boolean) {
    const memo = await seedMemos(engine, await seedWindow(engine, backend), oneTick);
    const opts = { sourceIds: ['default'], auditSources: [TERMINAL], hasAttempts: true };
    const unpaged = await engine.countUnlinkedFactStats(opts);
    await memo.page();
    const rearmed = await engine.countUnlinkedFactStats(opts);
    const without = await engine.countUnlinkedFactStats({ ...opts, hasAttempts: false });
    expect([unpaged, rearmed, without].map(s => [s?.no_subject, s?.conversation_unresolved])).toEqual([[1, 3], [1, 1], [0, 0]]);
    return { unpaged, rearmed, without };
  }

  parityTest('countUnlinkedFactStats with hasAttempts counts the no-subject and unresolved rows', { methods: ['countUnlinkedFactStats', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    statsMemos(engine, backend, false));
  parityTest('countUnlinkedFactStats with hasAttempts re-arms on a page created in the clock tick of the attempt', { methods: ['countUnlinkedFactStats', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    statsMemos(engine, backend, true));

  parityTest('countFactRelinkOutcomes counts the no-subject and recently linked attempts by outcome and tier', { methods: ['countFactRelinkOutcomes', 'upsertFactRelinkAttempt'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const put = (sourceId: string, factId: number, outcome: string, tier: string | null) =>
      engine.upsertFactRelinkAttempt(sourceId, { factId, outcome, reason: null, tier, model: null, targetSlug: null, runId: null });
    await put('default', 1, 'no_subject', 'model');
    await put('default', 2, 'linked', 'mention');
    await put('default', 3, 'linked', 'mention');
    await put('default', 4, 'linked', null);
    await put('default', 5, 'deduped', 'model');
    await put('default', 6, 'conversation_unresolved', 'mention');
    await put('other', 1, 'linked', 'page');
    const key = (r: { outcome: string; tier: string | null }) => `${r.outcome}:${r.tier ?? '~'}`;
    const one = sorted(await engine.countFactRelinkOutcomes(['default']), key);
    const both = sorted(await engine.countFactRelinkOutcomes(['default', 'other', 'default']), key);
    const none = await engine.countFactRelinkOutcomes([]);
    expect(one).toEqual([
      { outcome: 'linked', tier: 'mention', n: 2 }, { outcome: 'linked', tier: null, n: 1 }, { outcome: 'no_subject', tier: 'model', n: 1 },
    ]);
    expect(both.map(key)).toEqual(['linked:mention', 'linked:page', 'linked:~', 'no_subject:model']);
    expect(none).toEqual([]);
    return { one, both, none };
  });

  const slugOpts = (fix: 'relink' | 'reextract' | 'manual', windowPerSource: number, hasAttempts = false) =>
    ({ sourceId: 'default', auditSources: [TERMINAL], windowPerSource, fix, hasAttempts });

  parityTest('listOutsideContentFenceCounts and listUnlinkedConversationSlugs sort sources and slugs in byte order', { methods: ['listOutsideContentFenceCounts', 'listUnlinkedConversationSlugs'] }, async (engine, backend) => {
    // Byte order and a linguistic collation disagree on each pair here: '-' < '.' < '_' < 'a', and 'B' < '_' < 'a'.
    await createSource(engine, backend, 'ab', { kind: 'github' });
    await createSource(engine, backend, 'a-z', { kind: 'github' });
    for (const src of ['ab', 'a-z']) {
      await engine.putPage('repo/x', note('X'), { sourceId: src });
      await pageFact(engine, 'repo/x', `g-${src}`, { visibility: 'world' }, src);
    }
    for (const slug of ['calls/ab', 'calls/a_b', 'calls/a.d', 'calls/a-c']) {
      await engine.putPage(slug, note(slug, { transcript_import: true }));
      await pageFact(engine, slug, `s-${slug}`);
    }
    for (const slug of ['conv/b', 'conv/B', 'conv/_b', 'conv/a-b']) await pageFact(engine, slug, `c-${slug}`, { source: CONVERSATION });
    await pageFact(engine, 'conv/z', 'z1', { source: CONVERSATION });
    await pageFact(engine, 'conv/z', 'z2', { source: CONVERSATION });
    const fences = (await engine.listOutsideContentFenceCounts()).map(r => `${r.source_id}:${r.slug}`);
    const slugs = (await engine.listUnlinkedConversationSlugs(slugOpts('relink', 100))).map(r => r.slug);
    expect(fences).toEqual(['a-z:repo/x', 'ab:repo/x', 'default:calls/a-c', 'default:calls/a.d', 'default:calls/a_b', 'default:calls/ab']);
    // conv/z has two rows and ranks first; the one-row pages tie on the count and fall back to byte order.
    expect(slugs).toEqual(['conv/z', 'conv/B', 'conv/_b', 'conv/a-b', 'conv/b']);
    return { fences, slugs };
  });

  parityTest('listUnlinkedConversationSlugs ranks the pages of the targeted unlinked conversation rows by row count', { methods: ['listUnlinkedConversationSlugs'] }, async (engine, backend) => {
    await seedWindow(engine, backend);
    const relink = await engine.listUnlinkedConversationSlugs(slugOpts('relink', 100));
    const reextract = await engine.listUnlinkedConversationSlugs(slugOpts('reextract', 100));
    const manual = await engine.listUnlinkedConversationSlugs(slugOpts('manual', 100));
    // The window holds the newest rows: hooked, put page, plain, fence, c3 for 5; the assistant row is not an entity fact.
    const w5 = await engine.listUnlinkedConversationSlugs(slugOpts('relink', 5));
    const w7 = await engine.listUnlinkedConversationSlugs(slugOpts('relink', 7));
    expect(relink.map(r => r.slug)).toEqual(['conv/b', 'conv/c', 'conv/old']);
    expect(reextract).toEqual([]);
    expect(manual).toEqual([]);
    return { relink, reextract, manual, w5, w7 };
  });

  async function slugMemos(engine: BrainEngine, backend: Parameters<typeof createSource>[1], oneTick: boolean) {
    const memo = await seedMemos(engine, await seedWindow(engine, backend), oneTick);
    const read = async () => {
      const out: Record<string, string[]> = {};
      for (const fix of ['relink', 'reextract', 'manual'] as const) {
        out[fix] = (await engine.listUnlinkedConversationSlugs(slugOpts(fix, 100, true))).map(r => r.slug);
      }
      return out;
    };
    const unpaged = await read();
    const hash = await memo.page();
    const rearmed = await read();
    await memo.paid(hash);
    const paid = await read();
    expect(unpaged).toEqual({ relink: ['conv/old'], reextract: ['conv/b', 'conv/c'], manual: [] });
    expect(rearmed).toEqual({ relink: ['conv/b', 'conv/c', 'conv/old'], reextract: ['conv/b'], manual: [] });
    expect(paid).toEqual({ relink: ['conv/b', 'conv/c', 'conv/old'], reextract: [], manual: ['conv/b'] });
    return { unpaged, rearmed, paid };
  }

  parityTest('listUnlinkedConversationSlugs with hasAttempts targets each fix from the relink-attempt memos', { methods: ['listUnlinkedConversationSlugs', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    slugMemos(engine, backend, false));
  parityTest('listUnlinkedConversationSlugs with hasAttempts re-arms on a page created in the clock tick of the attempt', { methods: ['listUnlinkedConversationSlugs', 'upsertFactRelinkAttempt', 'putPage'] }, (engine, backend) =>
    slugMemos(engine, backend, true));

  parityTest('countFactEmbeddingCoverage counts missing, stale and partially embedded facts of each live source', { methods: ['countFactEmbeddingCoverage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'old');
    const vec = basisEmbedding(1);
    const embedded = (text: string, extra: Partial<NewFact> = {}, sourceId = 'default') =>
      fact(engine, text, { embedding: vec, embedding_model: MODEL, ...extra }, sourceId);
    await embedded('fresh');
    await fact(engine, 'no vector');
    await embedded('other model', { embedding_model: 'model-b' });
    await embedded('x'.repeat(8001));
    await embedded('x'.repeat(8000));
    await embedded('😀'.repeat(4001));
    await embedded('😀'.repeat(2500));
    await embedded('audit', { source: TERMINAL, embedding_model: 'model-b' });
    await engine.putPage('gone', note('Gone'));
    await pageFact(engine, 'gone', 'on deleted page', { embedding: vec, embedding_model: 'model-b' });
    await engine.softDeletePage('gone');
    const expired = await embedded('expired', { embedding_model: 'model-b' });
    await engine.expireFact(expired);
    await embedded('lapsed', { embedding_model: 'model-b', valid_until: new Date('2000-01-01T00:00:00Z') });
    await fact(engine, 'o', {}, 'other');
    await fact(engine, 'archived', {}, 'old');
    await archiveSource(engine, backend, 'old');
    const view = async (opts: { sourceId?: string; dims: number }) =>
      sorted(await engine.countFactEmbeddingCoverage({ model: MODEL, ...opts }), r => r.source_id);
    const all = await view({ dims: 1536 });
    const one = await view({ sourceId: 'other', dims: 1536 });
    const archived = await view({ sourceId: 'old', dims: 1536 });
    const narrow = await view({ sourceId: 'default', dims: 1024 });
    const counts = (rows: typeof all) => rows.map(r => [r.source_id, r.missing, r.stale, r.partial]);
    // default: one fact without a vector, one of another model; 8001 ascii and 4001 astral characters are over 8000 UTF-16
    // units, 8000 ascii and 2500 astral characters are not.
    expect(counts(all)).toEqual([['default', 1, 2, 2], ['other', 1, 1, 0]]);
    expect(counts(one)).toEqual([['other', 1, 1, 0]]);
    expect(archived).toEqual([]);
    expect(counts(narrow)).toEqual([['default', 1, 7, 0]]);
    return { all, one, archived, narrow };
  });
});
