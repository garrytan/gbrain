/**
 * #2038 — idx_timeline_dedup schema-drift self-heal.
 *
 * A brain that ran the pre-renumber v99 variant of the dedup migration is
 * stamped past v102 with the OLD 3-column index. `runMigrations` early-returns
 * (nothing pending) so a migration verify-hook can't fix it. The repair is
 * keyed off the index SHAPE and runs regardless. These tests simulate the
 * drifted states directly and pin: detection, rebuild, dedupe-before-rebuild
 * (only possible when the index was absent), and idempotency.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  checkTimelineDedupIndex,
  repairTimelineDedupIndex,
} from '../src/core/timeline-dedup-repair.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let pageId: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'people/alice-example', `---\ntitle: Alice\ntype: note\n---\n\n# Alice\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: 'people/alice-example.md',
  });
  const pid = await engine.executeRaw<{ id: string }>(
    `SELECT id::text AS id FROM pages WHERE slug = 'people/alice-example' AND source_id = 'default'`,
  );
  pageId = pid[0].id;
});

afterAll(async () => {
  await engine.disconnect();
});

/** Force the index back to the broken pre-v102 3-column shape. */
async function regressTo3Col() {
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DROP INDEX IF EXISTS idx_timeline_dedup`);
  await engine.executeRaw(
    `CREATE UNIQUE INDEX idx_timeline_dedup ON timeline_entries(page_id, date, summary)`,
  );
}

/** The other drift shape: the index was dropped entirely, letting true
 * 4-tuple duplicates accumulate that would block a naive CREATE UNIQUE INDEX. */
async function regressToAbsentWithDupes() {
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DROP INDEX IF EXISTS idx_timeline_dedup`);
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, summary, source, detail)
       VALUES ($1, '2026-04-03', 'met alice', 'meeting', ''),
              ($1, '2026-04-03', 'met alice', 'meeting', ''),
              ($1, '2026-04-03', 'met alice', 'cli:extract', '')`,
    [pageId],
  );
}

describe('#2038 idx_timeline_dedup drift repair', () => {
  test('detects the 3-column drift', async () => {
    await regressTo3Col();
    const status = await checkTimelineDedupIndex(engine);
    expect(status.tablePresent).toBe(true);
    expect(status.indexPresent).toBe(true);
    expect(status.columns).toEqual(['page_id', 'date', 'summary']);
    expect(status.needsRepair).toBe(true);
  });

  test('rebuilds the 3-column index to 4 columns (no dupes to collapse)', async () => {
    await regressTo3Col();
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary, source, detail)
         VALUES ($1, '2026-04-03', 'met alice', 'meeting', '')`,
      [pageId],
    );

    const res = await repairTimelineDedupIndex(engine);
    expect(res.repaired).toBe(true);
    expect(res.reason).toBe('rebuilt');
    expect(res.collapsedDuplicates).toBe(0);

    const after = await checkTimelineDedupIndex(engine);
    expect(after.columns).toEqual(['page_id', 'date', 'summary', 'source']);
    expect(after.needsRepair).toBe(false);
  });

  test('dedupes true 4-tuple duplicates before building the unique index', async () => {
    await regressToAbsentWithDupes(); // index absent + a real (meeting) dup

    const before = await checkTimelineDedupIndex(engine);
    expect(before.indexPresent).toBe(false);
    expect(before.needsRepair).toBe(true);

    const res = await repairTimelineDedupIndex(engine);
    expect(res.repaired).toBe(true);
    expect(res.collapsedDuplicates).toBe(1); // one of the two 'meeting' rows removed

    const after = await checkTimelineDedupIndex(engine);
    expect(after.columns).toEqual(['page_id', 'date', 'summary', 'source']);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2); // meeting (deduped) + cli:extract
  });

  test('idempotent — a second repair is a no-op', async () => {
    await regressTo3Col();
    await repairTimelineDedupIndex(engine);
    const second = await repairTimelineDedupIndex(engine);
    expect(second.repaired).toBe(false);
    expect(second.reason).toBe('already_correct');
  });
});
