/**
 * Wave B PR 2 (spec 7.4, 7.5): evidence delivery and dedup regions on a
 * segmented page.
 *
 * 1. Protects: assemble_evidence on a segmented page cuts its window,
 *    section and page units from windows read around the hits through the
 *    segment reader, so a remote caller never sees a takes block, a private
 *    or withdrawn facts row, or a private key, whichever side of a block the
 *    window starts; every delivered run is a slice of the read projection
 *    whole-body sanitization gives the same stored body (parity with an
 *    inline page); hits far apart come back as one block of separate
 *    windows; segmentRegions gives dedup each chunk's occurrence position.
 * 2. Fails when: evidence degrades to the hit chunk on a segmented page (PR 1
 *    read the NULL body columns: every unit came back `chunk` with
 *    `anchor_not_located`), a window is read from the stored body instead of
 *    the remote read projection, or windows are cut from anything other than
 *    the projection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { EVIDENCE_OMISSION, PAGE_OVER_INLINE_BYTES } from '../../src/core/search/evidence-delivery.ts';
import { segmentRegions } from '../../src/core/search/dedup.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import {
  PRIVATE, PUBLIC, importSegmented, inlineProjection, pageContent, privacyText, privateTokensIn, seedLedger, storedOffsets,
} from '../helpers/segmented-privacy-fixture.ts';

let engine: BrainEngine;
const assemble = operations.find(o => o.name === 'assemble_evidence')!;
const ctx = (): OperationContext => ({ engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
  emitResponseMeta: () => {} } as unknown as OperationContext);

interface Delivered { chunk_text: string; delivered: { unit: string; chunk_ids: number[]; match_spans: Array<{ chunk_id: number; start: number; end: number }>; fallback_reason?: string } }

async function evidence(slug: string, chunkIds: number[], unit: string): Promise<Delivered[]> {
  const out = await assemble.handler(ctx(), { hits: chunkIds.map(chunk_id => ({ source_id: 'default', slug, chunk_id })), return_unit: unit, return_window: 2, token_budget: 30_000 }) as { results: Delivered[] };
  return out.results;
}

/** Chunks of the segments holding the first occurrences of `tokens` in the stored body, at most `per` per segment. */
async function chunksNear(pageId: number, tokens: string[], per = 4): Promise<number[]> {
  const body = await openSegmentedBody(engine, { pageId });
  const occurrences = new Set<number>();
  for (const token of tokens) {
    for (const at of (await storedOffsets(engine, pageId, token)).slice(0, 4)) {
      const row = body.rows.find(r => r.byteStart <= at && at < r.byteStart + r.byteLen);
      if (row) occurrences.add(row.occurrenceId);
    }
  }
  const rows = await engine.executeRaw<{ id: number; occurrence_id: number }>(
    'SELECT id, occurrence_id FROM content_chunks WHERE page_id=$1 AND occurrence_id = ANY($2::bigint[]) ORDER BY chunk_index', [pageId, [...occurrences]]);
  const picked: number[] = [];
  for (const occurrence of occurrences) {
    const mine = rows.filter(r => Number(r.occurrence_id) === occurrence);
    for (let i = 0; i < per && mine.length; i++) picked.push(Number(mine[Math.floor((i * mine.length) / per)]!.id));
  }
  return [...new Set(picked)];
}

/** Every unit for every hit: no private token, runs are slices of the inline projection, the public tokens show. */
async function expectSafeEvidence(slug: string, pageId: number, hits: number[], ledger: boolean) {
  const projection = (await inlineProjection(engine, slug, pageId)).toString('utf8');
  const seen = new Set<string>();
  let windows = 0;
  for (const chunkId of hits) {
    for (const unit of ['window', 'section', 'page']) {
      for (const r of await evidence(slug, [chunkId], unit)) {
        expect({ chunkId, unit, leaked: privateTokensIn(r.chunk_text, { ledger }) }).toEqual({ chunkId, unit, leaked: [] });
        for (const token of Object.values(PUBLIC)) if (r.chunk_text.includes(token)) seen.add(token);
        if (r.delivered.unit === 'chunk') continue;
        windows++;
        for (const run of r.chunk_text.split(EVIDENCE_OMISSION)) expect(projection.includes(run.trim())).toBe(true);
      }
    }
  }
  expect(windows).toBeGreaterThan(hits.length * 2);
  expect([...seen].sort()).toEqual(Object.values(PUBLIC).sort());
}

for (const kind of testBackends()) {
  describe(`evidence on a segmented page (${kind})`, () => {
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);

    afterAll(async () => { await close(); });

    beforeEach(async () => {
      for (const table of ['pages', 'fact_withdrawals', 'fact_purges', 'write_gate_holds']) await engine.executeRaw(`DELETE FROM ${table}`);
    });

    test('a window, section or page around a hit is read from the segments and is a slice of the read projection', async () => {
      const r = mulberry32(301);
      const slug = 'chat/evidence-units';
      const pageId = await importSegmented(engine, slug, pageContent(`${privacyText(r, 700_000)}\nzzevidenceneedle sits here once\n${privacyText(r, 700_000)}`));
      const [hit] = await engine.executeRaw<{ id: number }>("SELECT id FROM content_chunks WHERE page_id=$1 AND chunk_text LIKE '%zzevidenceneedle%'", [pageId]);
      const projection = (await inlineProjection(engine, slug, pageId)).toString('utf8');
      for (const unit of ['window', 'section', 'page']) {
        const [block] = await evidence(slug, [Number(hit!.id)], unit);
        expect(block!.delivered.unit).toBe(unit === 'page' ? 'window' : unit);
        expect(block!.delivered.fallback_reason).toBe(unit === 'page' ? PAGE_OVER_INLINE_BYTES : undefined);
        expect(block!.chunk_text).toContain('zzevidenceneedle');
        const span = block!.delivered.match_spans.find(s => s.chunk_id === Number(hit!.id))!;
        expect(block!.chunk_text.slice(span.start, span.end)).toContain('zzevidenceneedle');
        for (const run of block!.chunk_text.split(EVIDENCE_OMISSION)) expect(projection.includes(run.trim())).toBe(true);
      }
    }, 240_000);

    test('hits far apart on one page come back as one block of separate windows', async () => {
      const r = mulberry32(307);
      const slug = 'chat/evidence-far';
      const words = ['zzfarone', 'zzfartwo', 'zzfarthree'];
      const pageId = await importSegmented(engine, slug, pageContent(words.map(w => `${privacyText(r, 600_000, { keys: false })}\n${w} marks this region\n`).join('')));
      const hits = await engine.executeRaw<{ id: number; chunk_text: string }>(
        "SELECT id, chunk_text FROM content_chunks WHERE page_id=$1 AND chunk_text ~ 'zzfar(one|two|three)' ORDER BY chunk_index", [pageId]);
      expect(hits.length).toBe(3);
      const [block] = await evidence(slug, hits.map(h => Number(h.id)), 'window');
      expect(block!.delivered.unit).toBe('window');
      expect(block!.chunk_text.split(EVIDENCE_OMISSION).length).toBeGreaterThanOrEqual(3);
      for (const [i, h] of hits.entries()) {
        const span = block!.delivered.match_spans.find(s => s.chunk_id === Number(h.id))!;
        expect(block!.chunk_text.slice(span.start, span.end)).toContain(words[i]!);
      }
      const regions = await segmentRegions(engine, hits.map(h => ({ slug, source_id: 'default', chunk_id: Number(h.id) }) as SearchResult));
      const starts = hits.map(h => regions.get(Number(h.id))!);
      expect(starts.every(s => Number.isInteger(s))).toBe(true);
      expect(starts[2]! - starts[0]!).toBeGreaterThan(1024 * 1024);
    }, 240_000);

    test('a segment read that fails returns the hit chunk with segment_read_failed, never a guessed window', async () => {
      const r = mulberry32(317);
      const slug = 'chat/evidence-read-failed';
      const pageId = await importSegmented(engine, slug, pageContent(`${privacyText(r, 600_000)}\nzzreadfailneedle sits here once\n${privacyText(r, 600_000)}`));
      const [hit] = await engine.executeRaw<{ id: number; chunk_text: string }>("SELECT id, chunk_text FROM content_chunks WHERE page_id=$1 AND chunk_text LIKE '%zzreadfailneedle%'", [pageId]);
      const read = engine.readSegmentTexts;
      engine.readSegmentTexts = async () => { throw new Error('forced segment read failure'); };
      try {
        for (const unit of ['window', 'section', 'page']) {
          const [block] = await evidence(slug, [Number(hit!.id)], unit);
          expect({ unit, delivered: block!.delivered.unit, reason: block!.delivered.fallback_reason }).toEqual({ unit, delivered: 'chunk', reason: 'segment_read_failed' });
          expect(block!.chunk_text).toBe(hit!.chunk_text);
        }
      } finally {
        engine.readSegmentTexts = read;
      }
    }, 240_000);

    test('no evidence block shows takes, private facts or keys, wherever its window starts', async () => {
      const r = mulberry32(311);
      const slug = 'chat/evidence-private';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_500_000), privacyText(r, 300_000)));
      await expectSafeEvidence(slug, pageId, await chunksNear(pageId, [PRIVATE.takes, PRIVATE.privateFact, PRIVATE.key]), false);
    }, 600_000);

    test('withdrawn, purged and held rows recorded after the import stay out of every evidence block', async () => {
      const r = mulberry32(313);
      const slug = 'chat/evidence-ledger';
      const pageId = await importSegmented(engine, slug, pageContent(privacyText(r, 1_400_000), privacyText(r, 200_000)));
      await seedLedger(engine, slug);
      // Forget bumps the revision and clears the projection; the rebuild rechunks from the overlaid text.
      await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid(), text_projection_revision=NULL WHERE id=$1', [pageId]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1', [pageId]);
      expect((await buildSegmentedProjection(engine, { sourceId: 'default', slug })).sealed).toBe(true);
      await expectSafeEvidence(slug, pageId, await chunksNear(pageId, [PRIVATE.withdrawn, PRIVATE.purged, PRIVATE.held]), true);
    }, 600_000);
  });
}
