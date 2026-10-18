/**
 * Wave B PR 2 fix lane C1 (finding C3): a forced cut at a clean line boundary is a block boundary.
 *
 * 1. Protects: a segmented page with no structural cut candidate (ordinary short lines with no blank line or
 *    heading, or a timeline of dated bullets) is cut only by force at each segment bound; bodyBlocks reads it as
 *    blocks of at most one segment each (each forced cut fell after a newline before a line the segmenter's no-cut
 *    rules allow), so the derived passes (timeline text, the stored canonical timeline the write path compares
 *    against) and a rewrite of the page complete. A code fence that really spans forced cuts stays one block, and
 *    one longer than BLOCK_MAX_BYTES still refuses page_body_segmented.
 * 2. Fails when: bodyBlocks joins every run of forced cuts into one block, so a 9.8 MB page of short lines or a
 *    12 MiB timeline of bullets is refused as one unsplittable run over 8 MiB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { BLOCK_MAX_BYTES, bodyBlocks } from '../../src/core/page-body/segment-blocks.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { segmentedTimelineText } from '../../src/core/timeline-extract.ts';
import { storedCanonicalTimeline } from '../../src/core/persistence/canonical-projections.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MB = 1024 * 1024;

/** 9,799,999 bytes of lines of at most 49 bytes: no blank line, no heading, so every cut is forced. */
function shortLines(): string {
  const head = '---\ntitle: Short lines\ntype: note\n---\n';
  const lines: string[] = [];
  let bytes = Buffer.byteLength(head);
  for (let i = 0; bytes < 9_799_999 - 60; i++) {
    const line = 'line ' + String(i).padStart(8, '0') + ' acme-example noted the plan\n';
    lines.push(line);
    bytes += line.length;
  }
  const last = 'x'.repeat(9_799_999 - bytes - 1) + '\n';
  return head + lines.join('') + last;
}

/** A short truth, then a 12 MiB timeline of dated bullets with no blank line. */
function bulletTimeline(): { content: string; bullets: number } {
  const bullets: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 12 * MB; i++) {
    const line = '- **20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Met acme-example about item ' + i + '\n';
    bullets.push(line);
    bytes += line.length;
  }
  return { content: '---\ntitle: Bullet timeline\ntype: note\n---\nA short truth.\n\n<!-- timeline -->\n\n' + bullets.join(''), bullets: bullets.length };
}

/** A code fence of about 28/32 x `bytes` spanning forced cuts, between two paragraphs. */
function longFence(bytes: number): string {
  const body = Array.from({ length: Math.ceil(bytes / 32) }, (_, i) => 'code line ' + String(i).padStart(10, '0') + ' x = 1;\n').join('');
  return '---\ntitle: Long fence\ntype: note\n---\nBefore the fence.\n\n```ts\n' + body + '```\n\nAfter the fence.\n';
}

async function forcedCuts(engine: BrainEngine, slug: string): Promise<{ id: number; forced: number; rows: number }> {
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]);
  const [row] = await engine.executeRaw<{ forced: unknown; rows: unknown }>(
    "SELECT count(*) FILTER (WHERE cut_kind='forced') AS forced, count(*) AS rows FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL", [page!.id]);
  return { id: Number(page!.id), forced: Number(row!.forced), rows: Number(row!.rows) };
}

async function blocks(engine: BrainEngine, page: { id: number; slug: string }): Promise<string[]> {
  const out: string[] = [];
  for await (const block of bodyBlocks(engine, page)) out.push(block.text);
  return out;
}

for (const kind of testBackends()) {
  describe('forced cuts at line boundaries (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
    }, 120_000);

    afterAll(async () => { await close(); });

    test('a 9,799,999-byte page of short lines cut only by force reads as one block per segment', async () => {
      const content = shortLines();
      expect(Buffer.byteLength(content)).toBe(9_799_999);
      expect((await importFromContent(engine, 'notes/short-lines', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const cuts = await forcedCuts(engine, 'notes/short-lines');
      expect(cuts.forced).toBeGreaterThanOrEqual(9);
      const texts = await blocks(engine, { id: cuts.id, slug: 'notes/short-lines' });
      expect(texts.length).toBeGreaterThanOrEqual(cuts.rows);
      for (const text of texts) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      expect(texts.join('')).toBe(content.slice(content.indexOf('---\n', 4) + 4).trim() + '\n');
      expect((await segmentedTimelineText(engine, { id: cuts.id, slug: 'notes/short-lines', source_id: 'default' })).entries).toEqual([]);
    }, 300_000);

    test('a 12 MiB timeline of dated bullets: the stored canonical timeline and a rewrite of the page complete', async () => {
      const { content, bullets } = bulletTimeline();
      expect((await importFromContent(engine, 'notes/bullets', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const cuts = await forcedCuts(engine, 'notes/bullets');
      expect(cuts.forced).toBeGreaterThanOrEqual(12);
      const snapshot = (await engine.readPageSnapshot('notes/bullets', { sourceId: 'default' }))!;
      expect(snapshot.page.body_storage).toBe('segmented');
      expect((await storedCanonicalTimeline(engine, snapshot.page, 'notes/bullets')).size).toBe(bullets);
      const rewrite = content + '- **2026-01-01** | One more item\n';
      expect((await importFromContent(engine, 'notes/bullets', rewrite, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const after = (await engine.readPageSnapshot('notes/bullets', { sourceId: 'default' }))!;
      expect((await storedCanonicalTimeline(engine, after.page, 'notes/bullets')).size).toBe(bullets + 1);
    }, 600_000);

    test('a code fence spanning forced cuts stays one block, and over BLOCK_MAX_BYTES it still refuses', async () => {
      expect((await importFromContent(engine, 'notes/fence', longFence(3 * MB), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const fence = await forcedCuts(engine, 'notes/fence');
      expect(fence.forced).toBeGreaterThanOrEqual(2);
      const texts = await blocks(engine, { id: fence.id, slug: 'notes/fence' });
      const holding = texts.filter(text => text.includes('```ts'));
      expect(holding).toHaveLength(1);
      const last = 'code line ' + String(Math.ceil(3 * MB / 32) - 1).padStart(10, '0') + ' x = 1;\n```\n';
      expect(holding[0]!.includes('code line 0000000000') && holding[0]!.includes(last)).toBe(true);
      expect(Buffer.byteLength(holding[0]!)).toBeGreaterThan(2.5 * MB);
      expect((await importFromContent(engine, 'notes/fence-long', longFence(BLOCK_MAX_BYTES + 2 * MB), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const long = await forcedCuts(engine, 'notes/fence-long');
      const error = await blocks(engine, { id: long.id, slug: 'notes/fence-long' }).then(() => null, (e: unknown) => e as { code?: string });
      expect(error?.code).toBe('page_body_segmented');
    }, 600_000);
  });
}
