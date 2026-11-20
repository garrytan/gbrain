/**
 * BrainEngine parity — the purge receipt's reads (src/core/engine-sql/purge-verify.ts), which
 * src/core/facts/purge-verify.ts ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: countPurgeProbe counts each probe kind's rows under its row bound and refuses a table or column the
 *    deletion inventory does not list; listPurgeProbeItems names the rows a named-row probe matches;
 *    listBeliefEventValuesAfter, listLiveFactContextsAfter, listSegmentedProseBodies, listPurgeProseSlugs,
 *    countPagePurgeTombstones, readPagePurgeRequest, listPurgeEffectStates and countPurgeFingerprintRows return the same
 *    observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1). verifyPagePurge builds the same receipt on PGLite and Postgres; the Rust arm does not
 *    serve the probe yet, so the receipt stops on the typed `engine_capability_missing` refusal naming countPurgeProbe.
 *  - Regression: an engine that counts a probe differently reports a purged page or claim as gone while a store still
 *    holds it (or the reverse), and a probe built from caller text would splice SQL; the Rust engine has no SQL, so
 *    each read has to exist as a typed member it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), and test/page-purge.test.ts runs one engine at a time.
 *  - Seam: rows are seeded through the typed putPage, insertFact, addLink and addTimelineEntry. Generated ids are
 *    compared by shape (digits folded), never by value.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/purge-verify.ts';
import { verifyPagePurge } from '../../src/core/facts/purge-verify.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const BOUNDS = { rows: 100, statementMs: 5_000 };
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
  parityTest('countPurgeProbe counts each probe kind within the source and stops at its row bound', { methods: ['countPurgeProbe'] }, async (engine) => {
    const { pageId, factId, factHash } = await seed(engine);
    const count = (probe: PurgeProbe, bounds = BOUNDS) => engine.countPurgeProbe(probe, bounds);
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
      inventory: await count({ kind: 'inventory_text', table: 'timeline_entries', columns: ['summary', 'detail'], sourceId: SRC, forms: ['secret plan'] }),
      inventoryMiss: await count({ kind: 'inventory_text', table: 'timeline_entries', columns: ['summary'], sourceId: SRC, forms: ['never stated'] }),
      linkRows: await count({ kind: 'named_rows', table: 'links', sourceId: SRC, forms: ['secret plan'] }),
      timelineRows: await count({ kind: 'named_rows', table: 'timeline_entries', sourceId: SRC, forms: ['secret plan'] }),
      effects: await count({ kind: 'effect_payload', sourceId: SRC, forms: ['secret plan'], page: { slug: 'notes/gone', reasonForms: ['tidy'] } }),
      facts: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'private', subject: '*' }),
      factsBySubject: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'private', subject: 'notes/other' }),
      factsWorld: await count({ kind: 'fingerprint', store: 'facts', sourceId: SRC, factHash, visibility: 'world', subject: '*' }),
      takes: await count({ kind: 'fingerprint', store: 'takes', sourceId: SRC, factHash, visibility: 'private', subject: '*' }),
      prose: await count({ kind: 'claim_text', store: 'pages', sourceId: SRC, claim: 'secret plan', json: 'secret plan', reason: 'secret plan', reasonJson: 'secret plan' }),
      proseMiss: await count({ kind: 'claim_text', store: 'page_versions', sourceId: SRC, claim: 'never stated', json: 'never stated', reason: 'never stated', reasonJson: 'never stated' }),
      notices: await count({ kind: 'claim_text', store: 'core_edit_notices', sourceId: SRC, claim: 'secret plan', json: 'secret plan', reason: 'secret plan', reasonJson: 'secret plan' }),
      // More rows than the bound: the probe never reports a partial count.
      bounded: await count({ kind: 'slug_key', store: 'pages', sourceId: SRC, slug: 'notes/gone' }, { rows: 0, statementMs: 5_000 }),
    };
    expect(out).toMatchObject({ page: { count: 1 }, pageElsewhere: { count: 0 }, missingSlug: { count: 0 }, timeline: { count: 1 }, inventory: { count: 1 },
      inventoryMiss: { count: 0 }, linkRows: { count: 1 }, timelineRows: { count: 1 }, facts: { count: 1 }, factsBySubject: { count: 0 }, factsWorld: { count: 0 },
      prose: { count: 1 }, proseMiss: { count: 0 }, bounded: { unverified: 'row_bound' } });
    // Names a caller passes are refused unless the deletion inventory lists them; values never reach the SQL text.
    const refused = async (probe: PurgeProbe, bounds = BOUNDS) => count(probe, bounds).then(() => 'ran', (e: unknown) => (e as Error).message);
    const refusals = {
      table: await refused({ kind: 'inventory_text', table: 'pg_class', columns: ['relname'], sourceId: SRC, forms: ['x'] }),
      column: await refused({ kind: 'inventory_text', table: 'timeline_entries', columns: ['summary) OR (true'], sourceId: SRC, forms: ['x'] }),
      bounds: await refused({ kind: 'query_cache', sourceId: SRC }, { rows: Number.NaN, statementMs: 5_000 }),
    };
    expect(refusals.table).toContain('pg_class is not an inventory table');
    expect(refusals.column).toContain('is not an inventory column');
    expect(refusals.bounds).toContain('bad bounds');
    return { out, refusals };
  });

  parityTest('listPurgeProbeItems names the rows a named-row or effect probe matches, in order and under its limit', { methods: ['listPurgeProbeItems'] }, async (engine) => {
    await seed(engine);
    const links = fold(await engine.listPurgeProbeItems({ kind: 'named_rows', table: 'links', sourceId: SRC, forms: ['secret plan'] }, 20));
    const timeline = fold(await engine.listPurgeProbeItems({ kind: 'named_rows', table: 'timeline_entries', sourceId: SRC, forms: ['secret plan'] }, 20));
    const none = await engine.listPurgeProbeItems({ kind: 'named_rows', table: 'raw_data', sourceId: SRC, forms: ['secret plan'] }, 20);
    const elsewhere = await engine.listPurgeProbeItems({ kind: 'named_rows', table: 'links', sourceId: 'elsewhere', forms: ['secret plan'] }, 20);
    const capped = await engine.listPurgeProbeItems({ kind: 'named_rows', table: 'links', sourceId: SRC, forms: ['secret plan'] }, 0);
    const effects = await engine.listPurgeProbeItems({ kind: 'effect_payload', sourceId: SRC, forms: ['secret plan'] }, 20);
    expect(links).toEqual(['link:# notes/gone -> notes/other']);
    expect(timeline).toEqual(['timeline:# notes/gone 2026-01-02']);
    expect({ none, elsewhere, capped, effects }).toEqual({ none: [], elsewhere: [], capped: [], effects: [] });
    return { links, timeline };
  });

  parityTest('the ledger, fact-context, segmented-body and prose-slug batches read the source in key order', {
    methods: ['listBeliefEventValuesAfter', 'listLiveFactContextsAfter', 'listSegmentedProseBodies', 'listPurgeProseSlugs'] }, async (engine) => {
    const { factId } = await seed(engine);
    await engine.insertFact({ fact: 'Other claim', entity_slug: 'notes/other', source: 'chat' }, { source_id: SRC });
    const contexts = await engine.listLiveFactContextsAfter(SRC, 0, 10);
    expect(contexts).toEqual([{ id: factId, context: 'it quotes the secret plan' }]);
    const after = await engine.listLiveFactContextsAfter(SRC, factId, 10);
    const ledger = await engine.listBeliefEventValuesAfter('elsewhere', 0, 10);
    const bodies = await engine.listSegmentedProseBodies(SRC, 'pages', 10);
    const versionBodies = await engine.listSegmentedProseBodies(SRC, 'page_versions', 10);
    const prose = {
      pages: await engine.listPurgeProseSlugs('pages', SRC, ['secret plan'], 20),
      timeline: await engine.listPurgeProseSlugs('timeline_entries', SRC, ['secret plan'], 20),
      versions: await engine.listPurgeProseSlugs('page_versions', SRC, ['never stated'], 20),
      elsewhere: await engine.listPurgeProseSlugs('pages', 'elsewhere', ['secret plan'], 20),
      capped: await engine.listPurgeProseSlugs('pages', SRC, ['secret plan', 'nothing'], 0),
      both: await engine.listPurgeProseSlugs('pages', SRC, ['secret plan', 'nothing'], 20),
    };
    expect(prose).toEqual({ pages: ['notes/gone'], timeline: ['notes/gone'], versions: [], elsewhere: [], capped: [], both: ['notes/gone', 'notes/other'] });
    expect({ after, ledger, bodies, versionBodies }).toEqual({ after: [], ledger: [], bodies: [], versionBodies: [] });
    return { contexts: contexts.map(c => c.context), prose };
  });

  parityTest('the completion reads: tombstones, the purge request row, its effects and the fingerprint counts', {
    methods: ['countPagePurgeTombstones', 'readPagePurgeRequest', 'listPurgeEffectStates', 'countPurgeFingerprintRows'] }, async (engine) => {
    const { factHash } = await seed(engine);
    const out = {
      tombstones: await engine.countPagePurgeTombstones(SRC, 'notes/gone'),
      request: await engine.readPagePurgeRequest(SRC, randomUUID()),
      effects: await engine.listPurgeEffectStates(randomUUID()),
      all: await engine.countPurgeFingerprintRows(SRC, factHash, '*'),
      bySubject: await engine.countPurgeFingerprintRows(SRC, factHash, 'notes/gone'),
      other: await engine.countPurgeFingerprintRows(SRC, factHash, 'notes/other'),
      elsewhere: await engine.countPurgeFingerprintRows('elsewhere', factHash, '*'),
    };
    expect(out).toEqual({ tombstones: 0, request: null, effects: [], all: { facts: 1, takes: 0 }, bySubject: { facts: 1, takes: 0 },
      other: { facts: 0, takes: 0 }, elsewhere: { facts: 0, takes: 0 } });
    return out;
  });

  parityTest('verifyPagePurge builds the same receipt; the Rust arm refuses naming the probe', {
    methods: ['countPurgeProbe', 'listPurgeProbeItems', 'listPurgeProseSlugs', 'countPagePurgeTombstones', 'readPagePurgeRequest'] }, async (engine) => {
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
