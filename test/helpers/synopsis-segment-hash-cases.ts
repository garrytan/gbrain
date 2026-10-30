/**
 * Contextual synopsis per segment (wave-b spec 8.6, PR 4 lane 4c), shared by the PGLite arm
 * (test/large-pages/synopsis-segment-hash.test.ts) and the Postgres arm (test/e2e/synopsis-segment-hash-postgres.test.ts).
 * The synopsis model is a fake with a call counter (the service's generateSynopsis seam) and the embedder is the brain's
 * fake; no provider is called.
 *
 * 1. Protects: under per_chunk_synopsis a segmented page leaves the title tier: every live chunk gets a synopsis vector
 *    whose document is the title, the projected lead and one window of its own segment (within SYNOPSIS_DOC_MAX_CHARS),
 *    one synopsis derivation row per live occurrence. A rerun calls nothing and reads no chunk row. An append (by a
 *    remote writer) re-synopsizes only the chunks of the windows it changed: the rewritten tail segment's unchanged
 *    windows carry their synopsis vectors onto the new rows at staging, so calls equal the changed windows' chunks, one
 *    segment is read, and every other chunk keeps its embedding_input_hash and vector. An exhausted per-page cap leaves the page on the title tier
 *    with no synopsis call; with room, the same page takes the synopsis tier. A refused synopsis embeds its window at
 *    the title tier and settles. An inline page keeps the synopsisBodyHash input.
 * 2. Fails when: a segmented page never leaves the title tier (the pre-lane skip), the synopsis input is hashed over every
 *    chunk of the page (an append changes every chunk's input), the rewritten tail is re-synopsized whole (staging drops
 *    the synopsis vectors of its unchanged windows), a settled segment is read or paid for again, or a refused
 *    reservation still calls the model.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { reembedPageWithContextualRetrieval } from '../../src/core/contextual-retrieval-service.ts';
import { DEFAULT_SYNOPSIS_MODEL, SYNOPSIS_DOC_MAX_CHARS, segmentSynopsisWindows, type GeneratePerChunkSynopsisArgs, type GeneratePerChunkSynopsisResult } from '../../src/core/page-summary.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { segmentSynopsisInputHashes, segmentSynopsisLead } from '../../src/core/page-body/segment-synopsis.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { reservationCostUsd } from '../../src/core/budget/reservation-cost.ts';
import { chunkGenerationFilter } from '../../src/core/search/safe-chunks.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { embedStalePages } from '../../src/core/embed-stale.ts';
import { acquirePageEmbeddingLease, pageEmbeddingLeaseId, pageEmbeddingLeaseProbe } from '../../src/core/page-embedding-lease.ts';
import { installSegmentedVectors, readSegmentedEmbedPage } from '../../src/core/page-body/segmented-embedding.ts';
import type { AppendBrain } from './append-brain.ts';
import { needlePage, needlePageBody, sealAtOldChunker } from './rechunk-segmented-cases.ts';
import { runSegmentedRechunk } from '../../src/core/page-body/rechunk.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer'];
const paragraph = (d: number, k: number) =>
  [`day${d}`, `para${k}`, ...Array.from({ length: 98 }, (_, i) => WORDS[(d * 7 + k * 3 + i) % WORDS.length])].join(' ') + '.';
export const day = (d: number) => `## Day ${d}\n\n${[1, 2, 3, 4].map(k => paragraph(d, k)).join('\n\n')}\n\n`;
export const TITLE = 'Daily log';
export const LEAD = 'Opening note: this log tracks the acme-example launch.';
const page = (body: string) => `---\ntitle: ${TITLE}\ntype: note\n---\n\n${LEAD}\n\n${body}`;
function days(bytes: number): { body: string; count: number } {
  let body = '';
  let count = 0;
  while (Buffer.byteLength(body) < bytes) body += day(++count);
  return { body, count };
}

interface ChunkRow { chunk_index: number; chunk_text: string; chunk_source: string; occurrence_id: number | null; embedding_input_hash: string | null; vector: string | null }

/** The service's segment chunk read (listSegmentChunkRows); counted to prove a settled segment is never read. */
const SEGMENT_CHUNK_READ = 'cc.occurrence_id = $2';

export function defineSynopsisSegmentHashCases(opts: { getBrain: () => AppendBrain }): void {
  const calls: GeneratePerChunkSynopsisArgs[] = [];
  let segmentReads = 0;
  let refuse: ((args: GeneratePerChunkSynopsisArgs) => boolean) | null = null;
  let onSynopsis: ((args: GeneratePerChunkSynopsisArgs) => Promise<void>) | null = null;
  const generateSynopsis = async (args: GeneratePerChunkSynopsisArgs): Promise<GeneratePerChunkSynopsisResult> => {
    calls.push(args);
    await onSynopsis?.(args);
    if (refuse?.(args)) return { kind: 'refusal', detail: 'fixture refusal' };
    return { kind: 'success', synopsis: `Synopsis of chunk ${args.chunkIndex}.` };
  };
  const counting = (engine: BrainEngine): BrainEngine => new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => { if (sql.includes(SEGMENT_CHUNK_READ)) segmentReads++; return target.executeRaw(sql, params); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const reset = () => { calls.length = 0; segmentReads = 0; opts.getBrain().embedded.length = 0; };
  const run = (slug: string, globalMode: 'per_chunk_synopsis' | 'title' | 'none' = 'per_chunk_synopsis') =>
    reembedPageWithContextualRetrieval({ engine: counting(opts.getBrain().engine), pageSlug: slug, sourceId: 'default', globalMode, generateSynopsis, chunkConcurrency: 4 });
  const chunks = async (slug: string): Promise<ChunkRow[]> => (await opts.getBrain().engine.executeRaw<ChunkRow>(
    `SELECT c.chunk_index, c.chunk_text, c.chunk_source, c.occurrence_id, c.embedding_input_hash, c.embedding::text AS vector
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = 'default' AND p.slug = $1 AND ${chunkGenerationFilter('p', 'c')} ORDER BY c.chunk_index`, [slug]))
    .map(row => ({ ...row, chunk_index: Number(row.chunk_index), occurrence_id: row.occurrence_id === null ? null : Number(row.occurrence_id) }));
  const pageRow = async (slug: string) => (await opts.getBrain().engine.executeRaw<{ id: number; mode: string | null; generation: string | null; body_storage: string }>(
    "SELECT id, contextual_retrieval_mode AS mode, corpus_generation AS generation, body_storage FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))
    .map(row => ({ ...row, id: Number(row.id) }))[0]!;
  const titleHash = async (c: ChunkRow) => embeddingInputHash(embeddingInputContext(await embeddingWriteTarget(opts.getBrain().engine), TITLE, null, []), 'title', c);
  const synopsisRows = async (pageId: number) => opts.getBrain().engine.readSegmentDerivations(pageId, { kind: 'synopsis' });
  const nonCode = (rows: ChunkRow[]) => rows.filter(c => c.chunk_source !== 'fenced_code');
  /** The cap is set high enough for a whole 2.3 MB page at the upper-bound estimate (uncached prompts at list price). */
  const roomyCap = async () => {
    await opts.getBrain().engine.setConfig(PAGE_EMBED_CAP_KEY, '1000');
    await opts.getBrain().engine.setConfig(PAGE_DERIVATION_CAP_KEY, '1000');
  };

  test('append invalidation: a segmented page leaves the title tier, a rerun does no work, an append pays only for the windows it changed', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-log';
    const { body, count } = days(2_300_000);
    await brain.seed(slug, page(body));
    const seeded = await pageRow(slug);
    expect(seeded.body_storage).toBe('segmented');
    const before = await chunks(slug);
    const occurrences = new Set(before.map(c => c.occurrence_id));
    expect(occurrences.size).toBeGreaterThan(1);

    reset();
    const first = await run(slug);
    expect(first).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: before.length });
    expect(calls.length).toBe(nonCode(before).length);
    expect(brain.embedded.length).toBe(before.length);
    expect(segmentReads).toBe(occurrences.size);
    for (const call of calls) {
      expect(call.documentText.length).toBeLessThanOrEqual(SYNOPSIS_DOC_MAX_CHARS);
      expect(call.documentText.startsWith(LEAD)).toBe(true);
      expect(call.documentText).toContain(call.chunkText);
    }
    expect(brain.embedded.every(text => text.includes('Synopsis of chunk'))).toBe(true);
    expect(await pageRow(slug)).toMatchObject({ mode: 'per_chunk_synopsis', generation: first.kind === 'success' ? first.corpus_generation : 'unset' });
    const done = await chunks(slug);
    expect(done.every(c => c.vector !== null)).toBe(true);
    for (const c of done) expect(c.embedding_input_hash).not.toBe(await titleHash(c));
    const rows = await synopsisRows(seeded.id);
    expect(rows.map(r => r.occurrenceId).sort()).toEqual([...occurrences].map(Number).sort());
    expect(rows.every(r => r.state === 'done')).toBe(true);

    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect({ calls: calls.length, embedded: brain.embedded.length, segmentReads }).toEqual({ calls: 0, embedded: 0, segmentReads: 0 });

    const appended = await brain.call('append_page', { slug, text: day(count + 1), request_id: randomUUID() }, { remote: true });
    expect(appended.isError).toBe(false);
    const after = await chunks(slug);
    const fresh = after.filter(c => !occurrences.has(c.occurrence_id));
    const freshOccurrences = new Set(fresh.map(c => c.occurrence_id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.length).toBeLessThan(after.length / 2);
    const kept = new Map(done.map(c => [c.chunk_index, c]));
    for (const c of after.filter(row => occurrences.has(row.occurrence_id))) {
      expect(c.embedding_input_hash).toBe(kept.get(c.chunk_index)!.embedding_input_hash);
      expect(c.vector).toBe(kept.get(c.chunk_index)!.vector);
    }
    // The changed windows, from the window documents alone: a fresh chunk whose (document, text) no retired window had.
    const lead = await segmentSynopsisLead(brain.engine, { id: seeded.id, slug, source_id: 'default' });
    const retired = done.filter(c => !after.some(a => a.occurrence_id === c.occurrence_id));
    const oldInputs = new Map<string, ChunkRow>();
    for (const w of segmentSynopsisWindows(retired, lead)) for (const c of w.chunks) oldInputs.set(`${w.document}\0${c.chunk_text}`, c);
    const changed: number[] = [];
    const carried: Array<[ChunkRow, ChunkRow]> = [];
    for (const w of segmentSynopsisWindows(fresh, lead)) {
      for (const c of w.chunks) {
        const old = oldInputs.get(`${w.document}\0${c.chunk_text}`);
        if (old) carried.push([c, old]); else if (c.chunk_source !== 'fenced_code') changed.push(c.chunk_index);
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(fresh.length / 2);
    expect(carried.length).toBe(fresh.length - changed.length);
    for (const [c, old] of carried) {
      expect(c.embedding_input_hash).toBe(old.embedding_input_hash);
      expect(c.vector).toBe(old.vector);
    }

    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: changed.length });
    expect(calls.map(call => call.chunkIndex).sort((a, b) => a - b)).toEqual(changed);
    expect(segmentReads).toBe(freshOccurrences.size);
    for (const [c] of carried) expect((await chunks(slug)).find(row => row.chunk_index === c.chunk_index)!.embedding_input_hash).toBe(c.embedding_input_hash);
    expect(calls.some(call => call.documentText.includes(`## Day ${count + 1}`))).toBe(true);
    const settled = await synopsisRows(seeded.id);
    expect(new Set(settled.map(r => r.occurrenceId))).toEqual(new Set(after.map(c => c.occurrence_id!)));
    expect((await chunks(slug)).every(c => c.vector !== null)).toBe(true);
  }, 600_000);

  test('cap: an exhausted per-page cap keeps the title tier with no synopsis call; with room the page takes the synopsis tier', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-capped';
    await brain.seed(slug, page(days(1_300_000).body));
    const { id } = await pageRow(slug);
    await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, '1');
    await brain.engine.executeRaw(`INSERT INTO page_derivation_spend (page_id, family, spent_usd) VALUES ($1, 'synopsis', 1)
      ON CONFLICT (page_id, family) DO UPDATE SET spent_usd = 1`, [id]);
    const before = await pageRow(slug);
    reset();
    expect(await run(slug)).toEqual({ kind: 'skipped', reason: 'budget_limited' });
    expect({ calls: calls.length, embedded: brain.embedded.length }).toEqual({ calls: 0, embedded: 0 });
    expect(await pageRow(slug)).toEqual(before);
    expect((await chunks(slug)).some(c => c.vector !== null)).toBe(false);

    await roomyCap();
    reset();
    const all = await chunks(slug);
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: all.length });
    expect(calls.length).toBe(nonCode(all).length);
    expect((await pageRow(slug)).mode).toBe('per_chunk_synopsis');
  }, 300_000);

  test('a refused synopsis embeds its window at the title tier and settles; title and none stay with the segmented embedding path', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-refused';
    await brain.seed(slug, page(days(1_300_000).body + '\nRefusal fixture.\n'));
    for (const mode of ['title', 'none'] as const) expect(await run(slug, mode)).toEqual({ kind: 'skipped', reason: 'page_body_segmented' });
    const all = await chunks(slug);
    const refused = all[Math.floor(all.length / 2)]!;
    refuse = args => args.chunkIndex === refused.chunk_index;
    try {
      expect(await run(slug)).toMatchObject({ kind: 'page_fallback', mode_applied: 'per_chunk_synopsis', fallback_kind: 'refusal', chunks_embedded: all.length });
    } finally {
      refuse = null;
    }
    const after = await chunks(slug);
    const titled: number[] = [];
    for (const c of after) if (c.embedding_input_hash === await titleHash(c)) titled.push(c.chunk_index);
    expect(titled).toContain(refused.chunk_index);
    expect(titled.length).toBeLessThan(after.length);
    expect(after.every(c => c.vector !== null)).toBe(true);
    const rows = await synopsisRows((await pageRow(slug)).id);
    expect(rows.find(r => r.occurrenceId === refused.occurrence_id)).toMatchObject({ state: 'done', receipt: { fallback_kind: 'refusal' } });
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect(calls.length).toBe(0);
  }, 300_000);

  const unitVectors = async (n: number) => {
    const dims = (await embeddingWriteTarget(opts.getBrain().engine)).column.dimensions;
    return Array.from({ length: n }, () => Float32Array.from({ length: dims }, (_, j) => (j === 1 ? 1 : 0)));
  };

  test('race: a title-tier embed in flight on a stamped page with new rows when the synopsis pass starts installs first; the pass waits for the page lease and its install wins', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-race-lease';
    const { body, count } = days(1_300_000);
    await brain.seed(slug, page(body));
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
    const stamped = await pageRow(slug);
    // The state an append leaves (the page stays stamped per_chunk_synopsis, the new rows have no vector), written
    // locally so no post-write embedding effect races the fixture.
    await brain.seed(slug, page(body + day(count + 1)));
    await brain.engine.executeRaw('UPDATE pages SET contextual_retrieval_mode = $2, corpus_generation = $3 WHERE id = $1', [stamped.id, stamped.mode, stamped.generation]);
    const pending = (await chunks(slug)).filter(c => c.vector === null);
    expect(pending.length).toBeGreaterThan(0);
    reset();
    let pass: Promise<unknown> | null = null;
    let contended!: () => void;
    const waited = new Promise<void>(resolve => { contended = resolve; });
    pageEmbeddingLeaseProbe.contended = () => contended();
    let titleTexts = 0;
    try {
      const titled = await embedStalePages(brain.engine, [slug], 'default', { embedFn: async texts => {
        titleTexts += texts.length;
        if (!pass) { pass = run(slug); await Promise.race([pass, waited]); }
        return unitVectors(texts.length);
      } });
      expect(titled.embedded).toBe(pending.length);
      expect(await pass).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: pending.length });
    } finally {
      pageEmbeddingLeaseProbe.contended = undefined;
    }
    expect({ titleTexts, calls: calls.length, synopsisEmbeds: brain.embedded.length })
      .toEqual({ titleTexts: pending.length, calls: nonCode(pending).length, synopsisEmbeds: pending.length });
    const after = await chunks(slug);
    for (const c of after) expect(c.embedding_input_hash).not.toBe(await titleHash(c));
    expect(after.every(c => c.vector !== null)).toBe(true);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect(calls.length).toBe(0);
  }, 300_000);

  test('lease busy: with the page lease held elsewhere through the wait, the pass makes no provider call and returns a retryable result; once released it runs', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-lease-busy';
    await brain.seed(slug, page(days(1_300_000).body + '\nLease busy fixture.\n'));
    const { id } = await pageRow(slug);
    const all = await chunks(slug);
    let contentions = 0;
    pageEmbeddingLeaseProbe.contended = () => { contentions++; };
    pageEmbeddingLeaseProbe.waitBoundMs = 300;
    reset();
    try {
      await using held = await acquirePageEmbeddingLease(brain.engine, id);
      expect(held.busy).toBe(false);
      const result = await run(slug);
      expect(result).toMatchObject({ kind: 'transient_error', cause: 'db' });
      expect(result.kind === 'transient_error' ? result.detail : '').toContain('Another path is embedding this page');
    } finally {
      pageEmbeddingLeaseProbe.contended = undefined;
      pageEmbeddingLeaseProbe.waitBoundMs = undefined;
    }
    expect(contentions).toBeGreaterThan(0);
    expect({ calls: calls.length, embedded: brain.embedded.length }).toEqual({ calls: 0, embedded: 0 });
    expect((await chunks(slug)).every(c => c.vector === null)).toBe(true);
    expect(await synopsisRows(id)).toEqual([]);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: all.length });
    expect(calls.length).toBe(nonCode(all).length);
  }, 300_000);

  test('lease lost: a pass whose lease another path took over before the install installs nothing and returns a retryable result', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-lease-lost';
    await brain.seed(slug, page(days(1_300_000).body + '\nLease lost fixture.\n'));
    const { id } = await pageRow(slug);
    const all = await chunks(slug);
    reset();
    onSynopsis = async () => {
      onSynopsis = null;
      expect((await brain.engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token = $2::uuid WHERE id = $1 RETURNING id',
        [pageEmbeddingLeaseId(id), randomUUID()])).length).toBe(1);
    };
    const result = await run(slug);
    expect(result).toMatchObject({ kind: 'transient_error', cause: 'db' });
    expect(result.kind === 'transient_error' ? result.detail : '').toContain('lease was lost');
    expect(calls.length).toBeGreaterThan(0);
    expect(brain.embedded.length).toBe(calls.length);
    expect((await chunks(slug)).every(c => c.vector === null)).toBe(true);
    expect(await synopsisRows(id)).toEqual([]);
    await brain.engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [pageEmbeddingLeaseId(id)]);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: all.length });
    expect(calls.length).toBe(nonCode(all).length);
  }, 300_000);

  test('race: a row another writer installed after the synopsis pass read it keeps that install; the stale synopsis install is a no-op and the retry pays for that row and the windows not reached', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-race-cas';
    await brain.seed(slug, page(days(1_300_000).body));
    const all = await chunks(slug);
    const target = all.filter(c => c.chunk_source !== 'fenced_code')[Math.floor(all.length / 2)]!;
    const engine = brain.engine;
    reset();
    onSynopsis = async args => {
      if (args.chunkIndex !== target.chunk_index) return;
      onSynopsis = null;
      const seg = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug }))!;
      expect(await installSegmentedVectors(engine, seg, await embeddingWriteTarget(engine), [{ chunk_index: target.chunk_index, chunk_text: target.chunk_text,
        vector: (await unitVectors(1))[0]!, hash: await titleHash(target), expected: null }])).toBe(1);
    };
    expect(await run(slug)).toMatchObject({ kind: 'transient_error', cause: 'db' });
    const halted = await chunks(slug);
    expect(halted.find(c => c.chunk_index === target.chunk_index)!.embedding_input_hash).toBe(await titleHash(target));
    const unreached = halted.filter(c => c.vector === null);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: unreached.length + 1 });
    expect(calls.map(call => call.chunkIndex).sort((a, b) => a - b)).toEqual([target, ...nonCode(unreached)].map(c => c.chunk_index).sort((a, b) => a - b));
    const after = await chunks(slug);
    for (const c of after) expect(c.embedding_input_hash).not.toBe(await titleHash(c));
    expect(after.every(c => c.vector !== null)).toBe(true);
  }, 300_000);

  test('lead edit: a write that changes the page lead carries no synopsis vector onto its new rows (every window opens with the new lead)', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-lead-edit';
    const { body } = days(1_300_000);
    await brain.seed(slug, page(body));
    const { id } = await pageRow(slug);
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
    const before = await chunks(slug);
    const stampedGeneration = (await pageRow(slug)).generation;
    const oldLead = await segmentSynopsisLead(brain.engine, { id, slug, source_id: 'default' });
    const editedLead = LEAD.replace('launch.', 'pilots.');
    expect(Buffer.byteLength(editedLead)).toBe(Buffer.byteLength(LEAD));
    await brain.seed(slug, page(body).replace(LEAD, editedLead));
    const after = await chunks(slug);
    const occurrences = new Set(before.map(c => c.occurrence_id));
    const fresh = after.filter(c => !occurrences.has(c.occurrence_id));
    expect(fresh.length).toBeGreaterThan(1);
    const newLead = await segmentSynopsisLead(brain.engine, { id, slug, source_id: 'default' });
    expect(newLead).not.toBe(oldLead);
    // Under the stored (old) lead, every fresh chunk but the edited one's window would match a retired row's input.
    const retiredHashes = new Set(before.filter(c => !after.some(a => a.occurrence_id === c.occurrence_id)).map(c => c.embedding_input_hash));
    const base = embeddingInputContext(await embeddingWriteTarget(brain.engine), TITLE, stampedGeneration, []);
    const underOld = segmentSynopsisInputHashes(base, oldLead, fresh);
    expect(fresh.filter(c => retiredHashes.has(underOld.get(c) ?? null)).length).toBeGreaterThan(0);
    expect(fresh.filter(c => c.vector !== null)).toEqual([]);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: after.length });
    expect(calls.length).toBe(nonCode(after).length);
    expect(calls.every(call => call.documentText.startsWith(editedLead))).toBe(true);
  }, 300_000);

  test('re-chunk: segments settled at the old chunker go unsettled after reindex --segmented --apply; the pass synopsizes every re-chunked row once', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-rechunk';
    await brain.seed(slug, needlePage(needlePageBody()));
    const id = await sealAtOldChunker(brain.engine, slug);
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
    expect((await chunks(slug)).every(c => c.vector !== null)).toBe(true);
    const receipt = await runSegmentedRechunk(brain.engine, { apply: true, slug });
    expect(receipt.pages).toMatchObject([{ slug, state: 'rechunked' }]);
    const rechunked = await chunks(slug);
    const pending = rechunked.filter(c => c.vector === null);
    expect(pending.length).toBeGreaterThan(0);
    const segments = new Set(rechunked.map(c => c.occurrence_id)).size;
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: pending.length });
    expect({ calls: calls.length, embedded: brain.embedded.length, segmentReads }).toEqual({ calls: nonCode(pending).length, embedded: pending.length, segmentReads: segments });
    const done = await chunks(slug);
    expect(done.every(c => c.vector !== null)).toBe(true);
    for (const c of done) expect(c.embedding_input_hash).not.toBe(await titleHash(c));
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect({ calls: calls.length, segmentReads }).toEqual({ calls: 0, segmentReads: 0 });
    expect((await synopsisRows(id)).every(r => r.state === 'done')).toBe(true);
  }, 300_000);

  test('doctor: synopsis receipts (a title-tier fallback, a refused reservation) are not extraction truncation and raise no extraction_input_truncated warning', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const fallbackSlug = 'notes/synopsis-doctor-fallback';
    await brain.seed(fallbackSlug, page(days(1_300_000).body + '\nDoctor fallback fixture.\n'));
    refuse = args => args.chunkIndex === 0;
    try {
      expect(await run(fallbackSlug)).toMatchObject({ kind: 'page_fallback', fallback_kind: 'refusal' });
    } finally {
      refuse = null;
    }
    const cappedSlug = 'notes/synopsis-doctor-capped';
    await brain.seed(cappedSlug, page(days(1_300_000).body + '\nDoctor cap fixture.\n'));
    await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, '0.000001');
    try {
      reset();
      expect(await run(cappedSlug)).toEqual({ kind: 'skipped', reason: 'budget_limited' });
      expect(calls.length).toBe(0);
    } finally {
      await roomyCap();
    }
    const receipts = [...await synopsisRows((await pageRow(fallbackSlug)).id), ...await synopsisRows((await pageRow(cappedSlug)).id)].map(r => r.receipt);
    expect(receipts).toContainEqual({ fallback_kind: 'refusal' });
    expect(receipts.some(r => (r as { reason?: string } | null)?.reason === 'budget_limited')).toBe(true);
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string }> }).groups;
    expect(groups.filter(g => g.pipeline === 'synopsis')).toEqual([]);
    expect(check.status).not.toBe('warn');
  }, 300_000);

  test('a pending fact purge sweep covering the page skips its synopsis as purge_sweep_pending (no call), and doctor points at the sweep, not the cap', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-purge-sweep';
    await brain.seed(slug, page(days(1_300_000).body + '\nPurge sweep fixture.\n'));
    const { id } = await pageRow(slug);
    const requestId = randomUUID();
    await brain.engine.executeRaw(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids)
      VALUES ($1::uuid, 'default', ARRAY[' purge example never stated '], ARRAY['%purge%example%never%stated%'], ARRAY[$2::int])`, [requestId, id]);
    try {
      reset();
      expect(await run(slug)).toEqual({ kind: 'skipped', reason: 'purge_sweep_pending' });
      expect(calls.length).toBe(0);
      const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
      const group = (check.details as { groups: Array<{ pipeline: string; kind: string; remedy: string | null }> }).groups.find(g => g.pipeline === 'synopsis');
      expect({ kind: group?.kind, sweep: group?.remedy?.includes('derivation_purge_sweeps'), cap: group?.remedy?.includes(PAGE_DERIVATION_CAP_KEY), fix: check.fix?.argv })
        .toEqual({ kind: 'purge_sweep_pending', sweep: true, cap: false, fix: ['gbrain', 'doctor', '--only', 'derivation_purge_sweeps', '--json'] });
    } finally {
      await brain.engine.executeRaw('DELETE FROM page_segment_derivation_purges WHERE request_id = $1::uuid', [requestId]);
    }
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
  }, 300_000);

  const ledger = async (pageId: number, table: 'page_derivation_spend' | 'page_embedding_budget') => (await opts.getBrain().engine.executeRaw<{ spent: number | string; reserved: number | string }>(
    `SELECT spent_usd AS spent, reserved_usd AS reserved FROM ${table} WHERE page_id = $1${table === 'page_derivation_spend' ? " AND family = 'synopsis'" : ''}`, [pageId]))
    .map(r => ({ spent: Number(r.spent), reserved: Number(r.reserved) }))[0] ?? null;
  /** The real synopsis call (generatePerChunkSynopsis) through the gateway's chat transport: usage on a priced model, a quarter token per input character and 20 output tokens. */
  const runPaid = (slug: string, answer: (o: ChatOpts) => ChatResult | Error, answered: ChatResult[]) => {
    __setChatTransportForTests(async (o: ChatOpts) => {
      const out = answer(o);
      if (out instanceof Error) throw out;
      answered.push(out);
      return out;
    });
    return reembedPageWithContextualRetrieval({ engine: opts.getBrain().engine, pageSlug: slug, sourceId: 'default', globalMode: 'per_chunk_synopsis', chunkConcurrency: 4 })
      .finally(() => __setChatTransportForTests(null));
  };
  const paidAnswer = (o: ChatOpts): ChatResult => {
    const chars = o.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) + (o.system?.length ?? 0);
    return { text: 'A short synopsis of the chunk.', blocks: [], stopReason: 'end', model: DEFAULT_SYNOPSIS_MODEL, providerId: 'anthropic',
      usage: { input_tokens: Math.ceil(chars / 4), output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  };
  const answeredUsd = (answered: readonly ChatResult[]) => answered.reduce((n, a) => n + reservationCostUsd(a.model, 'chat', a.usage.input_tokens, a.usage.output_tokens)!, 0);

  test('spend: a window whose synopsis is rate limited books the calls the provider answered and never the rejected one or an embedding; the embedding ledger is untouched', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-spend-synopsis-failure';
    await brain.seed(slug, page(days(1_300_000).body + '\nSpend fixture one.\n'));
    const { id } = await pageRow(slug);
    const answered: ChatResult[] = [];
    let rejected = 0;
    reset();
    const result = await runPaid(slug, o => rejected++ === 0 ? Object.assign(new Error('fixture rate limit'), { status: 429 }) : paidAnswer(o), answered);
    expect(result).toMatchObject({ kind: 'transient_error', cause: 'rate_limit' });
    expect(brain.embedded.length).toBe(0);
    const spend = await ledger(id, 'page_derivation_spend');
    expect(spend!.reserved).toBeCloseTo(0, 12);
    expect(spend!.spent).toBeCloseTo(answeredUsd(answered), 12);
    expect(await ledger(id, 'page_embedding_budget')).toBeNull();
  }, 300_000);

  test('spend: a window whose embedding fails books its answered synopsis calls and not the embedding', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-spend-embed-failure';
    await brain.seed(slug, page(days(1_300_000).body + '\nSpend fixture two.\n'));
    const { id } = await pageRow(slug);
    const dims = (await embeddingWriteTarget(brain.engine)).column.dimensions;
    const answered: ChatResult[] = [];
    __setEmbedTransportForTests((async () => { throw new Error('fixture embedding outage'); }) as never);
    reset();
    try {
      expect(await runPaid(slug, paidAnswer, answered)).toMatchObject({ kind: 'transient_error' });
    } finally {
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        brain.embedded.push(...values);
        return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
      }) as never);
    }
    expect(answered.length).toBeGreaterThan(0);
    const spend = await ledger(id, 'page_derivation_spend');
    expect(spend!.reserved).toBeCloseTo(0, 12);
    expect(spend!.spent).toBeCloseTo(answeredUsd(answered), 12);
    expect(await ledger(id, 'page_embedding_budget')).toBeNull();
  }, 300_000);

  test('an inline page keeps the synopsisBodyHash input', async () => {
    const brain = opts.getBrain();
    const slug = 'notes/synopsis-inline';
    await brain.seed(slug, page(days(40_000).body));
    expect((await pageRow(slug)).body_storage).toBe('inline');
    reset();
    const result = await run(slug);
    expect(result).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
    const stored = await chunks(slug);
    const provenance = embeddingInputContext(await embeddingWriteTarget(brain.engine), TITLE, result.kind === 'success' ? result.corpus_generation : null, stored);
    for (const c of stored) expect(c.embedding_input_hash).toBe(embeddingInputHash(provenance, 'per_chunk_synopsis', c));
    expect(calls.every(call => call.documentText === stored.filter(c => c.chunk_source !== 'image_asset').map(c => c.chunk_text).join('\n\n'))).toBe(true);
  }, 300_000);
}
