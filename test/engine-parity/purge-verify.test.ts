/**
 * BrainEngine parity — the purge receipt's store probes (builders in src/core/engine-sql/purge-verify.ts, served by
 * countPurgeProbe and listPurgeProbeItems in engine-sql/facts-purge-plan.ts), which src/core/facts/purge-verify.ts ran
 * through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: countPurgeProbe counts each receipt probe kind's rows within the source and stops one row past its row
 *    bound; listPurgeProbeItems names the rows a named-row or effect probe matches, in item order. Both return the
 *    same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1). verifyPagePurge builds the same receipt on every engine: the Rust arm serves the page
 *    purge's store probes, the ledger report's recorded values (listBeliefEventsForPurgeProbe, lane 3) and the
 *    source-prose scan (listPageProseHits, lane 4). The all-kinds count case runs on the Rust arm: its `fingerprint` and `claim_text` probes are served
 *    (rust/crates/gbrain-store/src/facts/purge_claim_probe.rs; test/engine-parity/fact-purge-probes.test.ts pins them in full).
 *  - Regression: an engine that counts a probe differently reports a purged page or claim as gone while a store still
 *    holds it (or the reverse); the Rust engine has no SQL, so each probe has to exist as a typed member it can
 *    implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), and test/page-purge.test.ts runs one engine at a time. The ledger, prose, tombstone, effect and fingerprint
 *    reads are pinned by test/engine-parity/facts-purge-sites.test.ts and fact-purge-sites.test.ts.
 *  - Seam: rows are seeded through the typed putPage, insertFact, addLink and addTimelineEntry. Generated ids are
 *    compared by shape (digits folded), never by value.
  */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import { verifyPagePurge } from '../../src/core/facts/purge-verify.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const ROWS = 100;
const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });
/** Ids differ across arms: fold the id of each `kind:id ...` or `f<id>` item. */
const fold = (items: readonly string[]) => items.map(item => item.replace(/^([a-z_]+:|f)\d+/, '$1#'));

/** A page stating the claim, a fact quoting it in its context, a timeline entry and a link naming it. */
async function seed(engine: BrainEngine) {
  await engine.putPage('notes/gone', note('Gone', 'The Secret Plan is written here.'));
  await engine.putPage('notes/other', note('Other', 'Nothing to see.'));
  const fact = await engine.insertFact({ fact: 'The secret plan', entity_slug: 'notes/gone', source: 'chat', context: 'it quotes the secret plan' }, { source_id: SRC });
  await engine.addTimelineEntry('notes/gone', { date: '2026-01-02', summary: 'Secret plan noted' });
  await engine.addLink('notes/gone', 'notes/other', 'mentions the secret plan');
  const page = await engine.getPage('notes/gone');
  const target = await engine.loadPurgeTarget(fact.id, SRC);
  return { pageId: Number(page!.id), factId: fact.id, factHash: target!.fact_hash };
}

describe('engine parity: purge receipt reads', () => {
  parityTest('countPurgeProbe counts each probe kind within the source and stops one row past its bound', { methods: ['countPurgeProbe'] }, async (engine) => {
    const { pageId, factId, factHash } = await seed(engine);
    const count = (probe: PurgeProbe, rows = ROWS) => engine.countPurgeProbe(probe, rows);
    const out = {
      page: await count({ kind: 'slug_key', store: 'pages', sourceId: SRC, slug: 'notes/gone' }),
      pageElsewhere: await count({ kind: 'slug_key', store: 'pages', sourceId: 'elsewhere', slug: 'notes/gone' }),
      missingSlug: await count({ kind: 'slug_key', store: 'pages', sourceId: SRC, slug: 'notes/missing' }),
      alias: await count({ kind: 'slug_key', store: 'slug_aliases', sourceId: SRC, slug: 'notes/gone' }),
      edges: await count({ kind: 'slug_key', store: 'retrieval_event_links', sourceId: SRC, slug: 'notes/gone' }),
      evalCandidates: await count({ kind: 'slug_key', store: 'eval_candidates.retrieved_slugs', sourceId: SRC, slug: 'notes/gone' }),
      timeline: await count({ kind: 'page_rows', store: 'timeline_entries', pageId }),
      versionsOfNone: await count({ kind: 'page_rows', store: 'page_versions', pageId: pageId + 100_000 }),
      decide: await count({ kind: 'fact_refs', store: 'decide_proposals', sourceId: SRC, factIds: [factId] }),
      review: await count({ kind: 'fact_refs', store: 'decide_review_queue', sourceId: SRC, factIds: [factId] }),
      trust: await count({ kind: 'trust_proposals', sourceId: SRC, pageId, factIds: [factId] }),
      requests: await count({ kind: 'page_requests', sourceId: SRC, slug: 'notes/gone', requestId: randomUUID(), needles: ['Secret Plan'], reasons: ['tidy'] }),
      ownTexts: await count({ kind: 'page_segment_texts', sourceId: SRC, shas: ['00'], forms: ['secret plan'] }),
      orphanTexts: await count({ kind: 'segment_texts', sourceId: SRC, needles: ['secret plan'], referenced: false }),
      effects: await count({ kind: 'effect_payload', sourceId: SRC, forms: ['secret plan'], page: { slug: 'notes/gone', reasonForms: ['tidy'] } }),
      facts: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'private', subject: '*' }),
      factsBySubject: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'private', subject: 'notes/other' }),
      factsWorld: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'world', subject: '*' }),
      takes: await count({ kind: 'fingerprint', store: 'takes', sourceId: SRC, factHash, visibility: 'private', subject: '*' }),
      prose: await count({ kind: 'claim_text', store: 'pages', sourceId: SRC, claim: 'secret plan', json: 'secret plan', reason: 'secret plan', reasonJson: 'secret plan' }),
      proseMiss: await count({ kind: 'claim_text', store: 'page_versions', sourceId: SRC, claim: 'never stated', json: 'never stated', reason: 'never stated', reasonJson: 'never stated' }),
      notices: await count({ kind: 'claim_text', store: 'core_edit_notices', sourceId: SRC, claim: 'secret plan', json: 'secret plan', reason: 'secret plan', reasonJson: 'secret plan' }),
      // More rows than the bound: the count stops one row past it, so the caller sees the bound was passed.
      bounded: await count({ kind: 'slug_key', store: 'pages', sourceId: SRC, slug: 'notes/gone' }, 0),
    };
    expect(out).toMatchObject({ page: 1, pageElsewhere: 0, missingSlug: 0, timeline: 1, facts: 1, factsBySubject: 0, factsWorld: 0,
      prose: 1, proseMiss: 0, bounded: 1 });
    // A row bound that is not a non-negative integer never reaches the SQL text.
    const refused = await count({ kind: 'query_cache', sourceId: SRC }, Number.NaN).then(() => 'ran', (e: unknown) => (e as Error).message);
    expect(refused).toContain('the row bound must be a non-negative integer');
    return { out, refused };
  });

  parityTest('listPurgeProbeItems names the rows a named-row or effect probe matches, in item order', { methods: ['listPurgeProbeItems'] }, async (engine) => {
    await seed(engine);
    const links = fold(await engine.listPurgeProbeItems({ kind: 'named', table: 'links', sourceId: SRC, needles: ['secret plan'] }));
    const timeline = fold(await engine.listPurgeProbeItems({ kind: 'named', table: 'timeline_entries', sourceId: SRC, needles: ['secret plan'] }));
    const none = await engine.listPurgeProbeItems({ kind: 'named', table: 'raw_data', sourceId: SRC, needles: ['secret plan'] });
    const elsewhere = await engine.listPurgeProbeItems({ kind: 'named', table: 'links', sourceId: 'elsewhere', needles: ['secret plan'] });
    const effects = await engine.listPurgeProbeItems({ kind: 'effect_payload', sourceId: SRC, forms: ['secret plan'] });
    expect(links).toEqual(['link:# notes/gone -> notes/other']);
    expect(timeline).toEqual(['timeline:# notes/gone 2026-01-02']);
    expect({ none, elsewhere, effects }).toEqual({ none: [], elsewhere: [], effects: [] });
    return { links, timeline };
  });

  parityTest('verifyPagePurge builds the same receipt on every engine', {
    methods: ['countPurgeProbe', 'listPurgeProbeItems', 'listPageProseHits', 'countPagePurgeTombstones', 'listBeliefEventsForPurgeProbe'] }, async (engine) => {
    const { pageId, factId } = await seed(engine);
    const receipt = await verifyPagePurge(engine, { sourceId: SRC, slug: 'notes/gone', requestId: randomUUID(), removed: {}, blobsRemaining: [],
      context: { needles: ['Secret Plan'], reasons: ['tidy'], factIds: [factId], pageId, paths: [], segmentShas: [] } });
    const blind = await verifyPagePurge(engine, { sourceId: SRC, slug: 'notes/missing', requestId: randomUUID(), removed: {}, blobsRemaining: [], context: null });
    type Report = { store: string; status: string; remaining?: number; reason?: string; items?: unknown[] };
    const shape = (r: Record<string, unknown>) => ({
      stores: (r.stores as Report[]).map(s => ({ store: s.store, status: s.status, remaining: s.remaining ?? null, reason: s.reason ?? null,
        items: s.items ? fold(s.items.map(String)) : null })),
      residuals: (r.residuals as Report[]).map(s => `${s.store}:${s.status}`), page_tombstones: r.page_tombstones, completion: r.completion ?? null });
    const out = { receipt: shape(receipt), blind: shape(blind) };
    const byStore = new Map(out.receipt.stores.map(s => [s.store, s]));
    expect(byStore.get('pages')).toMatchObject({ status: 'incomplete', remaining: 1 });
    expect(byStore.get('links')).toMatchObject({ status: 'out_of_scope', reason: 'probed_reported', items: ['link:# notes/gone -> notes/other'] });
    expect(byStore.get('source_prose')).toMatchObject({ status: 'out_of_scope', items: ['notes/gone'] });
    expect(out.blind.stores.find(s => s.store === 'source_prose')).toMatchObject({ status: 'unverified', reason: 'prose_probe_unavailable' });
    expect(out.blind.stores.find(s => s.store === 'pages')).toMatchObject({ status: 'not_present' });
    return out;
  });
});
