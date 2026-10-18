/**
 * Wave B PR 2 (spec 7.4): evidence on a large segmented page costs the hits'
 * windows, not the page.
 *
 * 1. Protects: assemble_evidence with three hits spread over a 40 MiB
 *    conversation page loads at most two segment texts per hit from storage
 *    (a window can straddle one cut) and delivers each hit's window.
 * 2. Fails when: the segmented path reads the page whole (a whole-text
 *    projection, a materialized body, or every segment of the read
 *    projection), which loads all ~40 MiB.
 * 3. Seams: the engine's readSegmentTexts, wrapped to count the bytes it
 *    returns (every segment text the reader loads goes through it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { EVIDENCE_OMISSION } from '../../src/core/search/evidence-delivery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const PAGE_BYTES = 40 * 2 ** 20;
const NEEDLES = [{ at: 0.1, word: 'zzcostone' }, { at: 0.5, word: 'zzcosttwo' }, { at: 0.9, word: 'zzcostthree' }];
const assemble = operations.find(o => o.name === 'assemble_evidence')!;
const dir = mkdtempSync(join(tmpdir(), 'segmented-evidence-cost-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const kind of testBackends()) {
  describe(`evidence read cost on a 40 MiB segmented page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
      const file = join(dir, `${kind}.md`);
      writeFileSync(file, conversationPage(PAGE_BYTES, { seed: 7, needles: NEEDLES }));
      const result = await importFromFile(engine, file, 'chat/cost-example.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
      rmSync(file, { force: true });
      expect(result.status).toBe('imported');
    }, 600_000);

    afterAll(async () => { await close(); });

    test('three hits load at most two segment texts each and come back as their windows', async () => {
      const [page] = await engine.executeRaw<{ id: number; body_storage: string; body_bytes: number }>("SELECT id, body_storage, body_bytes FROM pages WHERE slug='chat/cost-example'");
      expect(page!.body_storage).toBe('segmented');
      expect(Number(page!.body_bytes)).toBeGreaterThan(PAGE_BYTES - 1024);
      const [{ max_segment }] = await engine.executeRaw<{ max_segment: number }>('SELECT max(byte_len)::int AS max_segment FROM page_body_manifest WHERE page_id=$1', [page!.id]);
      const rows = await engine.executeRaw<{ id: number; chunk_text: string }>("SELECT id, chunk_text FROM content_chunks WHERE page_id=$1 AND chunk_text ~ 'zzcost(one|two|three)' ORDER BY chunk_index", [page!.id]);
      const hits = NEEDLES.map(({ word }) => rows.find(r => r.chunk_text.includes(word))!);
      expect(hits.every(Boolean)).toBe(true);

      let loaded = 0;
      const read = engine.readSegmentTexts.bind(engine);
      engine.readSegmentTexts = async (sourceId, shas) => {
        const texts = await read(sourceId, shas);
        for (const text of texts.values()) loaded += text.byteLength;
        return texts;
      };
      const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default', emitResponseMeta: () => {} } as unknown as OperationContext;
      const out = await assemble.handler(ctx, { hits: hits.map(h => ({ source_id: 'default', slug: 'chat/cost-example', chunk_id: Number(h.id) })), return_unit: 'window', token_budget: 20_000 }) as { results: Array<{ chunk_text: string; delivered: { unit: string } }> };
      engine.readSegmentTexts = read;

      expect(out.results.length).toBe(1);
      expect(out.results[0]!.delivered.unit).toBe('window');
      for (const { word } of NEEDLES) expect(out.results[0]!.chunk_text).toContain(word);
      expect(out.results[0]!.chunk_text.split(EVIDENCE_OMISSION).length).toBeGreaterThanOrEqual(3);
      expect(loaded).toBeGreaterThan(0);
      expect(loaded).toBeLessThanOrEqual(hits.length * 2 * Number(max_segment));
    }, 600_000);
  });
}
