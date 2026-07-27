/**
 * #1928 regression — extract_facts must NOT wipe conversation facts.
 *
 * `extract-conversation-facts` writes facts with source='cli:...' and
 * source_markdown_slug=<transcript slug>. Those pages carry no `## Facts`
 * fence, so the cycle's wipe-and-reinsert reconcile (deleteFactsForPage +
 * insertFactsBatch) used to delete them and reinsert nothing — a brain-wide
 * conversation-facts wipe on a failed-sync full walk (status `ok`, 0
 * inserted, 1829 rows gone in the original report).
 *
 * The fix scopes the cycle delete with excludeSourcePrefixes: ['cli:'].
 * These tests pin: (a) the exclusion protects cli:-origin rows while still
 * deleting fence-owned rows on the same page coordinate, and (b) the default
 * (no opts) behavior is unchanged — every fact on the coordinate is deleted.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function seedPageWithMixedFacts(slug: string, sourceId: string) {
  await engine.insertFacts(
    [
      // Fence-owned row (what extract_facts recreates from the page fence).
      { fact: 'fence fact', kind: 'fact', source: 'fence', row_num: 1, source_markdown_slug: slug },
      // Empty-source row — also fence-default; must stay deletable.
      { fact: 'blank-source fact', kind: 'fact', source: '', row_num: 2, source_markdown_slug: slug },
      // Conversation fact — NOT fence-owned; must survive the reconcile.
      { fact: 'conversation fact', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 3, source_markdown_slug: slug },
    ],
    { source_id: sourceId },
  );
}

async function factSourcesOnPage(slug: string, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ source: string }>(
    `SELECT COALESCE(source, '') AS source FROM facts
       WHERE source_id = $1 AND source_markdown_slug = $2 ORDER BY row_num`,
    [sourceId, slug],
  );
  return rows.map(r => r.source);
}

describe('#1928 deleteFactsForPage excludeSourcePrefixes', () => {
  test('protects cli:-origin facts, still deletes fence + empty-source rows', async () => {
    await seedPageWithMixedFacts('transcripts/2026-06-01', 'default');
    expect((await factSourcesOnPage('transcripts/2026-06-01', 'default')).length).toBe(3);

    const { deleted } = await engine.deleteFactsForPage('transcripts/2026-06-01', 'default', {
      excludeSourcePrefixes: ['cli:'],
    });

    expect(deleted).toBe(2); // fence + blank-source removed
    const survivors = await factSourcesOnPage('transcripts/2026-06-01', 'default');
    expect(survivors).toEqual(['cli:extract-conversation-facts']);
  });

  test('default behavior (no opts) deletes every fact on the coordinate', async () => {
    await seedPageWithMixedFacts('transcripts/2026-06-02', 'default');
    expect((await factSourcesOnPage('transcripts/2026-06-02', 'default')).length).toBe(3);

    const { deleted } = await engine.deleteFactsForPage('transcripts/2026-06-02', 'default');

    expect(deleted).toBe(3);
    expect((await factSourcesOnPage('transcripts/2026-06-02', 'default')).length).toBe(0);
  });
});
