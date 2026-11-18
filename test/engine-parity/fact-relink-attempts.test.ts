/**
 * BrainEngine parity — the relink-attempt record (engine-sql/fact-relink-attempts.ts): upsertFactRelinkAttempt,
 * listFactRelinkOutcomes and deleteFactRelinkMemos.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    keeps one attempt per (source, fact) where the latest write wins, lists the stored outcomes of the named facts in
 *    fact-id order filtered by outcome, deletes only the named tier and page of one source, and keeps an attempt when its
 *    fact or page goes away (the table has no foreign key).
 *  - Regression: an engine that keeps a stale outcome, sorts ids as text, deletes another page's paid memo or drops the
 *    attempts with their fact makes `gbrain facts relink` pay again for a fact a model already judged, or makes the
 *    unlinked_facts doctor check name the wrong fix for a conversation page.
 *  - Why existing coverage misses it: the statements ran through `executeRaw` inside facts/relink.ts,
 *    facts/conversation-relink.ts, facts/relink-publish.ts and facts/conversation-memo.ts, which the parity cases
 *    cannot call (D18).
 *  - Seam: the attempts are written and read through the typed members only, and the memo reads through the doctor
 *    reads (test/engine-parity/facts-doctor.test.ts). `model` and `run_id` have no typed reader, so the
 *    `keepModelAndRun` option is pinned by the Rust store's unit test and test/engine-sql-fact-relink-attempts.test.ts
 *    (both SQL engines), not here. Times are
 *    never returned: each engine stamps its own clock. The fact ids are literals the case writes, never generated ids
 *    (the table has no foreign key), so they compare across arms however the sequences stand.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const ALL = ['linked', 'deduped', 'no_subject', 'conversation_unresolved', 'paid_reextract'];

const put = (engine: BrainEngine, sourceId: string, factId: number, outcome: string, tier: string | null = null, targetSlug: string | null = null) =>
  engine.upsertFactRelinkAttempt(sourceId, { factId, outcome, reason: null, tier, model: null, targetSlug, runId: null });

describe('engine parity: fact relink attempts', () => {
  parityTest('upsertFactRelinkAttempt keeps one attempt per source and fact, and the latest write wins', { methods: ['upsertFactRelinkAttempt', 'listFactRelinkOutcomes'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await put(engine, 'default', 10, 'no_subject', 'model');
    await put(engine, 'default', 9, 'linked', 'mention');
    await put(engine, 'default', 100, 'conversation_unresolved', 'mention');
    await put(engine, 'other', 9, 'deduped', 'page');
    await put(engine, 'default', -5, 'no_subject', 'model');
    await put(engine, 'default', 10, 'linked', 'model');
    await engine.upsertFactRelinkAttempt('default', { factId: 100, outcome: 'deduped', reason: 'r', tier: 'model', model: 'm', targetSlug: 'people/a', runId: 'run-1' }, { keepModelAndRun: true });
    const all = await engine.listFactRelinkOutcomes('default', [100, 10, 9, 7, 10, -5], ALL);
    const linked = await engine.listFactRelinkOutcomes('default', [9, 10, 100], ['linked']);
    const other = await engine.listFactRelinkOutcomes('other', [9, 10, 100], ALL);
    const noIds = await engine.listFactRelinkOutcomes('default', [], ALL);
    const noOutcomes = await engine.listFactRelinkOutcomes('default', [9, 10], []);
    // Numeric order (-5, 9, 10, 100), not text order.
    expect(all).toEqual([{ fact_id: -5, outcome: 'no_subject' }, { fact_id: 9, outcome: 'linked' }, { fact_id: 10, outcome: 'linked' }, { fact_id: 100, outcome: 'deduped' }]);
    expect(linked.map(r => r.fact_id)).toEqual([9, 10]);
    expect(other).toEqual([{ fact_id: 9, outcome: 'deduped' }]);
    expect([noIds, noOutcomes]).toEqual([[], []]);
    return { all, linked, other, noIds, noOutcomes };
  });

  parityTest('deleteFactRelinkMemos deletes only the attempts of the named source, tier and page', { methods: ['deleteFactRelinkMemos', 'upsertFactRelinkAttempt', 'listFactRelinkOutcomes'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await put(engine, 'default', 1, 'paid_reextract', 'paid_reextract', 'conv/a');
    await put(engine, 'default', 2, 'paid_reextract', 'paid_reextract', 'conv/a');
    await put(engine, 'default', 3, 'paid_reextract', 'paid_reextract', 'conv/b');
    await put(engine, 'default', 4, 'linked', 'mention', 'conv/a');
    await put(engine, 'default', 5, 'paid_reextract', null, 'conv/a');
    await put(engine, 'other', 1, 'paid_reextract', 'paid_reextract', 'conv/a');
    // A rewrite moves fact 6 onto conv/a after a first write named conv/b: the delete follows the stored page.
    await put(engine, 'default', 6, 'paid_reextract', 'paid_reextract', 'conv/b');
    await put(engine, 'default', 6, 'paid_reextract', 'paid_reextract', 'conv/a');
    await engine.deleteFactRelinkMemos('default', 'paid_reextract', 'conv/a');
    await engine.deleteFactRelinkMemos('default', 'paid_reextract', 'conv/none');
    const ids = [1, 2, 3, 4, 5, 6];
    const left = (await engine.listFactRelinkOutcomes('default', ids, ALL)).map(r => r.fact_id);
    const other = (await engine.listFactRelinkOutcomes('other', ids, ALL)).map(r => r.fact_id);
    await engine.deleteFactRelinkMemos('default', 'paid_reextract', 'conv/b');
    const after = (await engine.listFactRelinkOutcomes('default', ids, ALL)).map(r => r.fact_id);
    expect({ left, other, after }).toEqual({ left: [3, 4, 5], other: [1], after: [4, 5] });
    return { left, other, after };
  });

  parityTest('an attempt outlives its fact and its page (no foreign key)', { methods: ['upsertFactRelinkAttempt', 'listFactRelinkOutcomes', 'deleteFactsForPage', 'deletePage'] }, async (engine) => {
    await engine.putPage('conv/gone', { type: 'note', title: 'gone', compiled_truth: 'body', frontmatter: {} });
    const { ids } = await engine.insertFacts([{ fact: 'f', source: 'chat', row_num: 1, source_markdown_slug: 'conv/gone' }], { source_id: 'default' });
    const id = ids[0]!;
    await put(engine, 'default', id, 'linked', 'mention', 'conv/gone');
    const { deleted } = await engine.deleteFactsForPage('conv/gone', 'default');
    await engine.deletePage('conv/gone');
    const left = (await engine.listFactRelinkOutcomes('default', [id], ALL)).map(r => r.outcome);
    expect({ deleted, left }).toEqual({ deleted: 1, left: ['linked'] });
    return { deleted, left };
  });
});
