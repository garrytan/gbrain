/**
 * BrainEngine parity — the stores a page purge scrubs by slug outside the slug-store set
 * (src/core/feedback/store.ts scrubPurgedSlugs, persistence/purge-name-stores.ts scrubPurgedNameStores and
 * persistence/rebuildable-cache.ts clearRebuildableCache).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the feedback scrub strips a purged slug from the retrieved slugs of the eval candidates that cover its source (a
 *    slug a page of another covered source still holds stays; a candidate that does not cover the source is left alone), counts
 *    the rows it removed or rewrote as the purge receipt names them, and answers zero for the stores that hold nothing; the name
 *    store scrub answers its two counts; clearing the query cache answers a count and never null on a brain that has the table:
 *    each answers the same, and leaves the same rows, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm with GBRAIN_TEST_RUST_ARM=1) over one seeded slug with candidates around it (another source, none covered).
 *  - Regression: an engine that scrubs a candidate differently leaves a purged page's name in an eval export (or strips another
 *    source's slug), and the receipt counts the wrong rows; one that reports the query cache missing makes the receipt claim a
 *    cache the purge could not reach. The Rust engine has no SQL, so each statement has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    only the PGLite and Postgres purge suites (test/purge-retrieval-feedback-8821.test.ts, test/purge-scrub-followups-9068.test.ts)
 *    exercised them.
 *  - Seam: the exported functions of the three files above, called with the arm's engine (a transaction handle). Candidates and
 *    pages are seeded through typed writers (putPage, logEvalCandidate) and read back with listEvalCandidates. The retrieval
 *    event, rating, volunteer log, gazetteer and query cache tables have no typed writer, so their counts are the empty-store
 *    answer on every arm; the PGLite and Postgres suites above seed them.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { EvalCandidateInput } from '../../src/core/types.ts';
import { scrubPurgedSlugs } from '../../src/core/feedback/store.ts';
import { scrubPurgedNameStores } from '../../src/core/persistence/purge-name-stores.ts';
import { clearRebuildableCache } from '../../src/core/persistence/rebuildable-cache.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const SLUG = 'notes/doomed';

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });

const candidate = (query: string, slugs: string[], sources: string[]): EvalCandidateInput => ({
  tool_name: 'query', query, retrieved_slugs: slugs, retrieved_chunk_ids: [], source_ids: sources, expand_enabled: true, detail: 'medium',
  detail_resolved: 'high', vector_enabled: true, expansion_applied: false, latency_ms: 42, remote: false, job_id: null, subagent_id: null, embedding_column: 'embedding',
});

describe('engine parity: the stores a page purge scrubs by slug', () => {
  parityTest('scrubPurgedSlugs strips a purged slug from the candidates that cover its source, keeps a slug another covered source holds, and counts what it rewrote', {
    methods: ['putPage', 'logEvalCandidate', 'listEvalCandidates', 'transaction', 'deletePurgedFeedbackRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    await engine.putPage('notes/shared', note('Shared', 'Held by both sources.'));
    await engine.putPage('notes/shared', note('Shared', 'Held by both sources.'), { sourceId: OTHER } as never);
    await engine.putPage(SLUG, note('Doomed', 'Another source holds the same name.'), { sourceId: OTHER } as never);
    await engine.logEvalCandidate(candidate('covers default', [SLUG, 'notes/keeper', 'notes/shared'], [SRC]));
    await engine.logEvalCandidate(candidate('covers both', [SLUG, 'notes/keeper', 'notes/shared', SLUG], [SRC, OTHER]));
    await engine.logEvalCandidate(candidate('covers other only', [SLUG, 'notes/shared'], [OTHER]));
    await engine.logEvalCandidate(candidate('covers none', [SLUG, 'notes/keeper'], []));
    await engine.logEvalCandidate(candidate('untouched', ['notes/keeper'], [SRC]));
    const state = async () => Object.fromEntries((await engine.listEvalCandidates()).map(c => [c.query, c.retrieved_slugs]));
    const before = await state();
    const none = await engine.transaction(tx => scrubPurgedSlugs(tx, SRC, []));
    const nobody = await engine.transaction(tx => scrubPurgedSlugs(tx, 'nobody', [SLUG]));
    const removed = await engine.transaction(tx => scrubPurgedSlugs(tx, SRC, [SLUG, 'notes/never']));
    const after = await state();
    const again = await engine.transaction(tx => scrubPurgedSlugs(tx, SRC, [SLUG]));
    expect(none).toEqual({});
    expect(removed['eval_candidates.retrieved_slugs']).toBe(1);
    return { before, none, nobody, removed, after, again };
  });

  parityTest('scrubPurgedNameStores answers its two counts, an empty object for no slugs, and zero for a source it does not know', {
    methods: ['transaction', 'deletePurgedNameStoreRows'],
  }, async (engine) => {
    const none = await engine.transaction(tx => scrubPurgedNameStores(tx, SRC, []));
    const removed = await engine.transaction(tx => scrubPurgedNameStores(tx, SRC, [SLUG, 'notes/other']));
    const unknown = await engine.transaction(tx => scrubPurgedNameStores(tx, 'nobody', [SLUG]));
    expect(none).toEqual({});
    return { none, removed, unknown };
  });

  parityTest('clearRebuildableCache empties the query cache and answers how many rows it removed, never null on a brain that has the table', {
    methods: ['transaction', 'clearQueryCache'],
  }, async (engine) => {
    const cleared = await engine.transaction(tx => clearRebuildableCache(tx, 'query_cache'));
    const again = await engine.transaction(tx => clearRebuildableCache(tx, 'query_cache'));
    const refused = await engine.transaction(tx => clearRebuildableCache(tx, 'pages')).then(() => 'cleared', (error: Error) => error.message);
    expect(cleared).toBe(0);
    return { cleared, again, refused };
  });

  parityTest('the scrub members answer their counts directly: the five feedback stores, the two name stores and the query cache', {
    methods: ['putPage', 'logEvalCandidate', 'listEvalCandidates', 'deletePurgedFeedbackRows', 'deletePurgedNameStoreRows', 'clearQueryCache'],
  }, async (engine) => {
    await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    await engine.logEvalCandidate(candidate('keeps', ['notes/keeper', SLUG], [SRC]));
    const empty = await engine.deletePurgedFeedbackRows(SRC, []);
    const unknown = await engine.deletePurgedFeedbackRows('nobody', [SLUG]);
    const stripped = await engine.deletePurgedFeedbackRows(SRC, [SLUG]);
    const again = await engine.deletePurgedFeedbackRows(SRC, [SLUG]);
    const names = await engine.deletePurgedNameStoreRows(SRC, [SLUG]);
    const noNames = await engine.deletePurgedNameStoreRows(SRC, []);
    const cache = await engine.clearQueryCache();
    const slugs = (await engine.listEvalCandidates()).map(c => c.retrieved_slugs);
    expect(Object.keys(stripped)).toEqual(['retrieval_event_pages', 'retrieval_event_links', 'retrieval_feedback', 'retrieval_weights', 'eval_candidates.retrieved_slugs']);
    return { empty, unknown, stripped, again, names, noNames, cache, slugs };
  });
});
