/**
 * BrainEngine parity — vector search over takes (`searchTakesVector`), the takes stream of think's evidence gather
 * when the question has an embedding and of `gbrain takes search --semantic`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: searchTakesVector(embedding, opts) returns the active takes that hold a vector for their current claim,
 *    nearest by cosine distance first, each hit with its take and page ids, page slug, row number, claim, kind, holder,
 *    weight, dates, source and score `1 - distance` (a `real`). It applies the holder allow-list, the source scope
 *    (a non-empty `sourceIds` over `sourceId`), `excludePrivate` (the caller's page policy, reader identities
 *    included), the read-eligibility policy (a soft-deleted or quarantined page hides its takes; `floor` and
 *    `suppressFlagged` filter on the take's stored tier and write-gate flags) and `limit`. A query vector of another
 *    width refuses. Every engine arm answers the same (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: think and `takes search --semantic` call this member; an engine that refuses it drops the vector
 *    stream (gather records GATHER_TAKES_VECTOR_FAILED and answers without it), and one that drops a filter puts a
 *    private, quarantined, deleted or below-floor take into an answer.
 *  - Why existing coverage misses it: takes.test.ts covers ordering, limit, the allow-list and a scalar source scope
 *    only; no test reads the full hit shape or the privacy and eligibility filters of this member.
 *  - Caller policy: one read runs as a member whose identity one page's readers name.
 *  - Seam: none. Typed methods only; tiers are declared through applyTransactionSettings inside a transaction, as the
 *    write paths do. Ids are sequence values, so they are compared only as relations. Every take sits at its own angle
 *    from the query, so no two hits tie on distance.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, TakeBatchInput, TakeHit } from '../../src/core/engine.ts';
import { basisEmbedding, createSource, parityArms } from './harness.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const take = (page_id: number, row_num: number, claim: string, extra: Partial<TakeBatchInput> = {}): TakeBatchInput => ({
  page_id, row_num, claim, kind: 'take', holder: 'garry', weight: 0.5, ...extra,
});

function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown>, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify(origin)]);
    return fn(tx);
  });
}

/** A vector on axis 0 that leans `lean` toward axis `axis`: its cosine to axis 0 is 1/sqrt(1 + lean^2). */
function leaning(axis: number, lean: number): Float32Array {
  const v = basisEmbedding(0);
  v[axis] = lean;
  return v;
}

const QUERY = basisEmbedding(0);

async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'vec-other');
  const put = async (slug: string, frontmatter: Record<string, unknown>, sourceId?: string) =>
    (await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Page ${slug}.`, timeline: '', frontmatter },
      sourceId ? { sourceId } : undefined)).id;
  const pages = {
    open: await put('notes/vec-open', {}),
    private: await put('notes/vec-private', { visibility: 'private' }),
    readers: await put('notes/vec-readers', { readable_by: ['alice-example'] }),
    quarantined: await put('notes/vec-quarantined', { quarantine: { reason: 'probe' } }),
    gone: await put('notes/vec-gone', {}),
    other: await put('notes/vec-other', {}, 'vec-other'),
  };
  await declaredWrite(engine, 'operator_curated', { channel: 'operator' }, tx => tx.addTakesBatch([
    take(pages.open, 1, 'open curated take', { kind: 'bet', weight: 0.7, since_date: '2026-03', until_date: '2026-09-01', source: 'meeting notes' }),
  ]));
  await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.addTakesBatch([
    take(pages.open, 2, 'open agent take', { holder: 'alice' }),
    take(pages.open, 3, 'open flagged take'),
  ]));
  await engine.addTakesBatch([take(pages.open, 4, 'open unembedded take'), take(pages.open, 5, 'open superseded take')]);
  await engine.addTakesBatch([take(pages.private, 1, 'private take', { holder: 'alice' })]);
  await engine.addTakesBatch([take(pages.readers, 1, 'readers take')]);
  await engine.addTakesBatch([take(pages.quarantined, 1, 'quarantined take')]);
  await engine.addTakesBatch([take(pages.gone, 1, 'gone take')]);
  await engine.addTakesBatch([take(pages.other, 1, 'other source take', { holder: 'alice' })]);

  const ids = new Map<string, number>();
  for (const pageId of Object.values(pages)) {
    for (const t of await engine.listTakes({ page_id: pageId })) ids.set(t.claim, Number(t.id));
  }
  // Nearest first: private, quarantined, open curated, gone, readers, open agent, open flagged, other, superseded.
  const lean: Record<string, number> = {
    'private take': 0.05, 'quarantined take': 0.08, 'open curated take': 0.1, 'gone take': 0.12, 'readers take': 0.15,
    'open agent take': 0.2, 'open flagged take': 0.22, 'other source take': 0.25, 'open superseded take': 0.01,
  };
  const written = await engine.updateTakeEmbeddings(Object.entries(lean).map(([claim, l], i) => ({
    take_id: ids.get(claim)!, embedding: leaning(2 + i, l), claim, model: 'embed-m1',
  })));
  expect(written).toBe(9);
  // The superseded take keeps its vector but is no longer active; its successor has none.
  await engine.supersedeTake(pages.open, 5, { claim: 'open successor take', kind: 'take', holder: 'garry' });
  await engine.softDeletePage('notes/vec-gone');
  await engine.upsertWriteGateReceipt({
    target_table: 'takes', target_id: String(ids.get('open flagged take')), source_id: 'default', content_hash: 'h1',
    tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['override'], reasons: ['override found'],
    detector_error: false, request_id: null,
  });
  const pageOf = new Map<number, string>(Object.entries(pages).map(([name, id]) => [id, name]));
  return { ids, pageOf };
}

describe('engine parity: take vector search', () => {
  parityTest('searchTakesVector returns the full hit of every active embedded take, nearest first, with its score', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'addTakesBatch', 'listTakes',
      'updateTakeEmbeddings', 'supersedeTake', 'upsertWriteGateReceipt', 'searchTakesVector'],
  }, async (engine, backend) => {
    const { ids, pageOf } = await fixture(engine, backend);
    const hits = await engine.searchTakesVector(QUERY);
    const view = hits.map((h: TakeHit) => ({
      ...h,
      take_id: h.take_id === ids.get(h.claim) ? 'id of the take' : `wrong id ${h.take_id}`,
      page_id: pageOf.get(h.page_id) ?? `wrong page ${h.page_id}`,
      score: Number(h.score.toFixed(6)),
      idTypes: [typeof h.take_id, typeof h.page_id, typeof h.score, typeof h.weight],
    }));
    expect(view.map(h => h.claim)).toEqual([
      'private take', 'quarantined take', 'open curated take', 'gone take', 'readers take', 'open agent take',
      'open flagged take', 'other source take',
    ]);
    expect(view[2]).toEqual({
      take_id: 'id of the take', page_id: 'open', page_slug: 'notes/vec-open', row_num: 1, claim: 'open curated take',
      kind: 'bet', holder: 'garry', weight: 0.7, since_date: '2026-03', until_date: '2026-09-01', source: 'meeting notes',
      score: Number((1 / Math.sqrt(1 + 0.1 * 0.1)).toFixed(6)), idTypes: ['number', 'number', 'number', 'number'],
    });
    expect(view.every(h => h.take_id === 'id of the take')).toBe(true);
    return view;
  });

  parityTest('searchTakesVector applies the allow-list, source scope, limit, excludePrivate, a reader identity and the eligibility policy', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'addTakesBatch', 'listTakes',
      'updateTakeEmbeddings', 'supersedeTake', 'upsertWriteGateReceipt', 'searchTakesVector'],
  }, async (engine, backend) => {
    await fixture(engine, backend);
    const claims = async (opts: Parameters<BrainEngine['searchTakesVector']>[1]) =>
      (await engine.searchTakesVector(QUERY, opts)).map(h => h.claim);
    const view = {
      limit: await claims({ limit: 2 }),
      alice: await claims({ takesHoldersAllowList: ['alice'] }),
      nobody: await claims({ takesHoldersAllowList: [] }),
      other: await claims({ sourceIds: ['vec-other'] }),
      arrayWins: await claims({ sourceId: 'default', sourceIds: ['vec-other'] }),
      emptyArray: await claims({ sourceId: 'vec-other', sourceIds: [] }),
      hidden: await claims({ excludePrivate: true }),
      reader: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => claims({ excludePrivate: true })),
      eligible: await claims({ eligibility: {} }),
      agentFloor: await claims({ eligibility: { floor: 'agent_written' } }),
      curatedFloor: await claims({ eligibility: { floor: 'operator_curated' } }),
      unflagged: await claims({ eligibility: { suppressFlagged: true } }),
      combined: await claims({ excludePrivate: true, eligibility: {}, sourceIds: ['default'], takesHoldersAllowList: ['garry'] }),
    };
    expect(view).toEqual({
      limit: ['private take', 'quarantined take'],
      alice: ['private take', 'open agent take', 'other source take'],
      nobody: [],
      other: ['other source take'],
      arrayWins: ['other source take'],
      emptyArray: ['other source take'],
      hidden: ['quarantined take', 'open curated take', 'gone take', 'open agent take', 'open flagged take', 'other source take'],
      reader: ['quarantined take', 'open curated take', 'gone take', 'readers take', 'open agent take', 'open flagged take', 'other source take'],
      eligible: ['private take', 'open curated take', 'readers take', 'open agent take', 'open flagged take', 'other source take'],
      agentFloor: ['open curated take', 'open agent take', 'open flagged take'],
      curatedFloor: ['open curated take'],
      unflagged: ['private take', 'open curated take', 'readers take', 'open agent take', 'other source take'],
      combined: ['open curated take', 'open flagged take'],
    });
    return view;
  });

  parityTest('searchTakesVector refuses a query vector of another width', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'applyTransactionSettings', 'addTakesBatch', 'listTakes',
      'updateTakeEmbeddings', 'supersedeTake', 'upsertWriteGateReceipt', 'searchTakesVector'],
  }, async (engine, backend) => {
    await fixture(engine, backend);
    const refused = await engine.searchTakesVector(basisEmbedding(0, 3)).then(() => false, () => true);
    expect(refused).toBe(true);
    return { refused };
  });
});
