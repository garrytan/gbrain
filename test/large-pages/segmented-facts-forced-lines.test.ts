/**
 * Wave B PR 2 fix lane H (finding H4): the facts fence view skips forced cuts that fall at a line boundary.
 *
 * 1. Protects: a segmented page cut only by force at line boundaries (short lines, no blank line or heading) and
 *    holding no facts marker reads no segment for its facts fence view: no marker holds a newline, so a forced cut
 *    after one cannot split a marker. A page of the same lines with a facts fence still gives factsFenceView of its
 *    strings (its fence sits in the page's one forced run, which is read whole).
 * 2. Fails when: markerSeqs selects every cut_kind='forced' row, so the view reads every segment of the forced run
 *    of a page that has no fence at all.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: none; the readSegmentTexts spy wraps the engine
 * method and counts segment texts read (a work count, not time).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { factsFenceView, FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MB = 1024 * 1024;

/** About `bytes` of lines of at most 49 bytes: no blank line, no heading, so every cut is forced at a line boundary. */
function shortLines(bytes: number, from = 0): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = from; size < bytes; i++) {
    const line = 'line ' + String(i).padStart(8, '0') + ' acme-example noted the plan\n';
    lines.push(line);
    size += line.length;
  }
  return lines.join('');
}

const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const FENCE = FACTS_FENCE_BEGIN + '\n' + HEADER + '| 1 | Works at Beta Example | fact | 0.9 | world | high | 2022-01-01 |  | notes |  |\n' + FACTS_FENCE_END + '\n';

for (const kind of testBackends()) {
  describe('facts fence view over forced cuts at line boundaries (' + kind + ')', () => {
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

    const view = async (slug: string) => {
      const p = await engine.getPage(slug, { sourceId: 'default' });
      expect((p as { body_storage?: string } | null)?.body_storage).toBe('segmented');
      const [cuts] = await engine.executeRaw<{ forced: number; rows: number }>(
        "SELECT count(*) FILTER (WHERE cut_kind='forced')::int AS forced, count(*)::int AS rows FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL", [p!.id]);
      const original = engine.readSegmentTexts.bind(engine);
      let reads = 0;
      engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => { reads += shas.length; return original(sourceId, shas); }) as BrainEngine['readSegmentTexts'];
      try {
        return { result: await segmentedFactsFenceView(engine, { id: p!.id, slug, source_id: 'default' }), reads, forced: cuts!.forced, rows: cuts!.rows, page: p! };
      } finally {
        delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
      }
    };

    test('a page with no facts marker, cut only by force at line boundaries, reads no segment', async () => {
      const content = '---\ntitle: Short lines\ntype: note\n---\n' + shortLines(3 * MB);
      expect((await importFromContent(engine, 'notes/forced-no-fence', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const { result, reads, forced, rows, page } = await view('notes/forced-no-fence');
      console.log('[facts-forced-lines] ' + kind + ' no fence: ' + reads + ' segment reads of ' + rows + ' rows (' + forced + ' forced)');
      expect(forced).toBeGreaterThanOrEqual(2);
      expect(result).toEqual(factsFenceView(await materializedPage(engine, page)));
      expect(reads).toBe(0);
    }, 300_000);

    test('the same lines with a facts fence still give the strings view', async () => {
      const content = '---\ntitle: Short lines with a fence\ntype: note\n---\n' + shortLines(2 * MB) + FENCE + shortLines(2 * MB, 1_000_000);
      expect((await importFromContent(engine, 'notes/forced-fence', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const { result, reads, rows, page } = await view('notes/forced-fence');
      console.log('[facts-forced-lines] ' + kind + ' fence: ' + reads + ' segment reads of ' + rows + ' rows');
      expect(result).toEqual(factsFenceView(await materializedPage(engine, page)));
      expect(result.body.facts).toHaveLength(1);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(rows);
    }, 300_000);
  });
}
