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
 *  - Seam: none for the facts, pages, takes and links, which are seeded through typed methods on every arm. Two members
 *    read tables that have no typed writer (`write_gate_holds` and `fact_relink_attempts`): their cases seed nothing and
 *    compare the empty answer, so they pin the statement's validity, not its filters. The 7-day cutoff of
 *    countUnlinkedFactStats has no case either, because a fact's `created_at` cannot be set through a typed method.
 *    Generated values (ids, timestamps) are never returned.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';

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

  /** Fixture for the window reads: oldest first, one insert per call so `created_at` orders them. */
  async function seedWindow(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
    await createSource(engine, backend, 'other');
    await pageFact(engine, 'conv/old', 'old', { source: CONVERSATION });
    await pageFact(engine, 'conv/a', 'linked', { source: CONVERSATION, entity_slug: 'people/a' });
    await pageFact(engine, 'conv/b', 'c1', { source: CONVERSATION });
    await pageFact(engine, 'conv/b', 'c2', { source: CONVERSATION });
    await pageFact(engine, 'conv/c', 'c3', { source: CONVERSATION });
    await pageFact(engine, 'notes/f', 'fence', { source: 'chat', row_num: 1 });
    await pageFact(engine, 'conv/z', 'audit', { source: TERMINAL });
    await fact(engine, 'plain');
    await fact(engine, 'assistant said', { attributed_to: 'assistant' });
    await fact(engine, 'put page', { source: 'mcp:put_page' });
    await fact(engine, 'hooked', { source: 'hook:capture' });
    await fact(engine, 'o', {}, 'other');
  }

  const originOpts = (windowPerSource: number, sourceIds = ['default', 'other']) =>
    ({ sourceIds, auditSources: [TERMINAL], windowPerSource, hasAttempts: false });

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

  parityTest('countUnlinkedFactsByOrigin with hasAttempts reads the relink-attempt memos', { methods: ['countUnlinkedFactsByOrigin'] }, async (engine, backend) => {
    await seedWindow(engine, backend);
    const rows = await engine.countUnlinkedFactsByOrigin({ ...originOpts(100, ['default']), hasAttempts: true });
    return sorted(rows, r => `${r.source_id}:${r.origin}`);
  });

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

  parityTest('countUnlinkedFactStats with hasAttempts reads the relink-attempt memos', { methods: ['countUnlinkedFactStats'] }, async (engine) => {
    await fact(engine, 'plain');
    return engine.countUnlinkedFactStats({ sourceIds: ['default'], auditSources: [TERMINAL], hasAttempts: true });
  });

  parityTest('countFactRelinkOutcomes reads the relink attempts', { methods: ['countFactRelinkOutcomes'] }, async (engine) => {
    // No typed writer exists for fact_relink_attempts, so only the empty answer is compared.
    await fact(engine, 'plain');
    const rows = await engine.countFactRelinkOutcomes(['default']);
    expect(rows).toEqual([]);
    return rows;
  });

  const slugOpts = (fix: 'relink' | 'reextract' | 'manual', windowPerSource: number, hasAttempts = false) =>
    ({ sourceId: 'default', auditSources: [TERMINAL], windowPerSource, fix, hasAttempts });

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

  parityTest('listUnlinkedConversationSlugs with hasAttempts reads the relink-attempt memos', { methods: ['listUnlinkedConversationSlugs'] }, async (engine, backend) => {
    await seedWindow(engine, backend);
    return engine.listUnlinkedConversationSlugs(slugOpts('relink', 100, true));
  });

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
