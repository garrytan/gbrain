/**
 * BrainEngine parity — a read cut by a limit picks the same row among tied sort keys on every engine arm: the purge
 * receipt's paraphrase probe and request lookup, `file_list`, the page-to-link sample, and the fact pool's nearest arm.
 * The two vector reads keep `ORDER BY <distance> LIMIT k` alone in an inner query (so the HNSW index serves it) and
 * break ties by fact id in an outer sort: the cases put every tie inside the k rows, because which rows tie at the cut
 * of an ANN read is approximate by design.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a tie on the sort key falls to the table's primary key, lowest first. verifyFactPurge's vector probe lists the
 *    five nearest same-model facts, equal distances by fact id (five tied facts and three far ones); verifyPagePurge reads the newest delete_page request of
 *    the (source, request id), equal created_at by request id; `file_list` returns the first 100 files by page slug and
 *    filename, equal names by file id; runPageToLinkCore reads the first pages of a type by slug, one slug in two
 *    sources by page id; collectFactCandidates' nearest arm lists the `depth.cosine` closest facts, equal distances by
 *    fact id (three tied facts and five far ones).
 *  - Regression: each statement ordered only by the key that tied (embedding distance; created_at; page slug and
 *    filename; slug), so rows with one value came back in whatever order the sort met them, and the limit could cut a
 *    different row or set on one database than on another, or between two runs of the same one.
 *  - Why existing coverage misses it: the cases seeded one row per key (distinct distances, one request per id, distinct
 *    file names, one source per slug), so no limit ever cut through a tie.
 *  - Seam: every reader runs raw SQL, so the Rust arm stops on its raw_sql refusal at the first raw call. Facts go in
 *    through insertFacts; requests, files and the page rewrite are harness-only SQL (no engine writer).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { verifyFactPurge, verifyPagePurge } from '../../src/core/facts/purge-verify.ts';
import { planFactPurge } from '../../src/core/facts/purge.ts';
import { collectFactCandidates } from '../../src/core/search/fact-relevance.ts';
import { getEmbeddingModel } from '../../src/core/ai/gateway.ts';
import { runPageToLinkCore } from '../../src/core/schema-pack/page-to-link.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const DIMS = 1536;
/** The vector of every tied fact: their distances to it tie at 0. */
const SAME = Float32Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0));
/** An orthogonal vector: a far fact sits at cosine distance 1 from SAME. */
const FAR = Float32Array.from({ length: DIMS }, (_, i) => (i === 1 ? 1 : 0));

function ctxFor(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

/**
 * Eight world facts of one source and model; the positions in `tied` get SAME, the rest FAR. Returns the ids in id
 * order. The rows at odd positions are then rewritten, so heap order is not id order: ordered by distance alone, the
 * tied rows come back out of id order on PGLite and Postgres (seen: positions 7, 2, 4, 6, 1 and 6, 4, 1).
 */
async function seedTiedFacts(engine: BrainEngine, backend: ParityBackend, model: string, tied: number[]): Promise<number[]> {
  const rows = Array.from({ length: 8 }, (_, i) => ({ fact: `Ana keeps tied bee colony ${i}`, entity_slug: null, kind: 'fact', visibility: 'world',
    source: 'test', embedding: tied.includes(i) ? SAME : FAR, embedding_model: model, row_num: null, source_markdown_slug: 'notes/seed' }));
  const ids = (await engine.insertFacts(rows as never, { source_id: SRC })).ids.map(Number).sort((a, b) => a - b);
  // Heap order exists only on the SQL engines; the Rust store keeps rows by key, so there is nothing to shuffle there.
  if (backend !== 'rust') await engine.executeRaw(`UPDATE facts SET source = 'test' WHERE id = ANY($1::bigint[])`, [ids.filter((_, i) => i % 2 === 1)]);
  return ids;
}

describe('a limit over tied sort keys cuts the same rows on every engine arm', () => {
  parityTest('the purge receipt probe lists tied nearest facts by fact id', { methods: ['insertFacts', 'loadPurgeTarget'] }, async (engine, backend) => {
    const ids = await seedTiedFacts(engine, backend, 'test:model', [1, 2, 4, 6, 7]);
    const target = (await engine.loadPurgeTarget(ids[7]!, SRC))!;
    const plan = await planFactPurge(engine, target, false);
    const receipt = await verifyFactPurge(engine, { target, plan, dryRun: true }) as unknown as { vector_probe: { status: string; candidates: Array<{ fact_id: number }> } };
    expect(receipt.vector_probe.status).toBe('checked');
    const ranks = receipt.vector_probe.candidates.map(c => ids.indexOf(c.fact_id));
    expect(ranks).toEqual([1, 2, 4, 6, 7]);
    return ranks;
  });

  // Named Rust stop owned by the page purge port (lane 13, rust-engine/page-purge-rust): the receipt's delete-request read and
  // its seeded persistence_requests rows go through executeRaw, which the Rust engine refuses. When that port serves the
  // receipt read with typed seeding, this case turns equal.
  parityTest('the page purge receipt reads the delete request of the lowest id among equal created_at', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const request = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
    const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id=$1`, [SRC]);
    // Ids 3 < 4 < 5 < 7 < 8; the lowest id (3) is the committed one and goes in third, so no insert order is id order.
    const rows: Array<[string, string]> = [['5', 'failed'], ['8', 'cancelled'], ['3', 'committed'], ['7', 'conflict'], ['4', 'failed']];
    for (const [n, state] of rows) {
      await engine.executeRaw(`INSERT INTO persistence_requests(id,principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
          terminal_reservation,state,created_at)
        VALUES ($1::uuid,'local_cli',$2,$3::uuid,'delete_page',$4,$5::uuid,'notes/tied','d','{}'::jsonb,1,16384,$6,'2026-03-01T10:00:00Z')`,
      [`${n.repeat(8)}-0000-4000-8000-000000000000`, `cli:tie-${n}`, request, SRC, source!.incarnation, state]);
    }
    const receipt = await verifyPagePurge(engine, { sourceId: SRC, slug: 'notes/tied', requestId: request, removed: {}, blobsRemaining: [], context: null }) as { completion?: string; exit_code?: number };
    expect({ completion: receipt.completion, exit_code: receipt.exit_code }).toEqual({ completion: 'complete', exit_code: 0 });
    return { completion: receipt.completion, exit_code: receipt.exit_code };
  });

  parityTest('file_list returns the first 100 files by file id when slug and filename tie', { methods: ['upsertCliFileRow', 'listReadableFileRows'] }, async (engine, backend) => {
    const op = operations.find(o => o.name === 'file_list')!;
    // 120 files of one page and one filename, through the typed write `gbrain files upload` uses; storage paths run opposite to
    // ids, and on the SQL engines every third row is rewritten so heap order is not id order (the Rust store has no heap).
    for (let g = 1; g <= 120; g++) {
      await engine.upsertCliFileRow({ page_slug: 'tie/page', filename: 'same.txt', storage_path: `tie/${String(121 - g).padStart(3, '0')}`, mime_type: null,
        size_bytes: 0, content_hash: 'h' }, {});
    }
    if (backend !== 'rust') await engine.executeRaw(`UPDATE files SET mime_type = 'text/plain' WHERE id % 3 = 0`);
    const first100 = Array.from({ length: 100 }, (_, i) => `tie/${String(120 - i).padStart(3, '0')}`);
    const all = await op.handler(ctxFor(engine), {}) as Array<{ storage_path: string }>;
    expect(all.map(r => r.storage_path)).toEqual(first100);
    const one = await op.handler(ctxFor(engine), { slug: 'tie/page' }) as Array<{ storage_path: string }>;
    expect(one.map(r => r.storage_path)).toEqual(first100);
    return { all: all.map(r => r.storage_path), one: one.map(r => r.storage_path) };
  });

  parityTest('runPageToLinkCore reads the lowest page id when one slug sits in two sources', { methods: ['putPage', 'listLinkCandidatePages'] }, async (engine, backend) => {
    for (const id of ['src-b', 'src-c']) await createSource(engine, backend, id);
    const page = (body: string, canonical?: string) => ({ type: 'legacy-note', title: 'tie/x', compiled_truth: body, timeline: '', frontmatter: canonical ? { canonical } : {} });
    await engine.putPage('notes/target', { type: 'note', title: 'target', compiled_truth: 'target', timeline: '' });
    // The lowest page id is src-c's page, which names no target; it is then rewritten so heap order is not id order.
    await engine.putPage('tie/x', page('c body') as never, { sourceId: 'src-c' });
    await engine.putPage('tie/x', page('default body', 'notes/target') as never, { sourceId: 'default' });
    await engine.putPage('tie/x', page('b body', 'notes/target') as never, { sourceId: 'src-b' });
    await engine.putPage('tie/x', page('c body again') as never, { sourceId: 'src-c' });
    const result = await runPageToLinkCore(ctxFor(engine), { rules: [{ from_type: 'legacy-note', link_type: 'mentions',
      source_slug_from: 'slug', target_slug_from: { frontmatter_field: 'canonical' } }], apply: true, perRuleLimit: 1 });
    const rule = result.per_rule[0]!;
    expect({ would_convert: rule.would_convert, converted: rule.converted, unresolved: rule.unresolved })
      .toEqual({ would_convert: 1, converted: 0, unresolved: [{ slug: 'tie/x', reason: 'no_target' }] });
    return { would_convert: rule.would_convert, converted: rule.converted, unresolved: rule.unresolved };
  });

  parityTest('the fact pool nearest arm lists tied nearest facts by fact id', { methods: ['insertFacts'] }, async (engine, backend) => {
    const ids = await seedTiedFacts(engine, backend, getEmbeddingModel(), [1, 4, 6]);
    const pool = await collectFactCandidates(engine, 'zzqx', { sourceIds: [SRC], worldOnly: true, excludePrivate: false }, SAME,
      { depth: { keyword: 5, cosine: 3, entity: 5 } });
    const ranks = pool.candidates.map(c => ids.indexOf(c.id));
    expect(pool.cosine).toBe(true);
    expect(ranks).toEqual([1, 4, 6]);
    const inTransaction = await collectFactCandidates(engine, 'zzqx', { sourceIds: [SRC], worldOnly: true, excludePrivate: false }, SAME,
      { depth: { keyword: 5, cosine: 3, entity: 5 }, hnswIterativeScan: 'off' });
    expect(inTransaction.candidates.map(c => ids.indexOf(c.id))).toEqual([1, 4, 6]);
    return ranks;
  });
});
