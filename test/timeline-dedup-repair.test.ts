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

  test('rebuilds the 3-column index to the md5-keyed 4-column shape (no dupes to collapse)', async () => {
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
    // #3737: canonical shape keys md5(summary).
    expect(after.columns).toEqual(['page_id', 'date', 'md5(summary)', 'source']);
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
    expect(after.columns).toEqual(['page_id', 'date', 'md5(summary)', 'source']);
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

// ─── #3737: raw-summary btree overflow → md5-keyed dedup tuple ──────────

import { parseIndexColumns } from '../src/core/timeline-dedup-repair.ts';
import { randomBytes } from 'crypto';

/** Regress to the pre-#3737 raw-summary 4-column shape. */
async function regressToRaw4Col() {
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DROP INDEX IF EXISTS idx_timeline_dedup`);
  await engine.executeRaw(
    `CREATE UNIQUE INDEX idx_timeline_dedup ON timeline_entries(page_id, date, summary, source)`,
  );
}

describe('#3737 md5-keyed dedup index', () => {
  test('parseIndexColumns keeps md5(summary) whole (first-paren fix)', () => {
    expect(parseIndexColumns(
      'CREATE UNIQUE INDEX idx_timeline_dedup ON public.timeline_entries USING btree (page_id, date, md5(summary), source)',
    )).toEqual(['page_id', 'date', 'md5(summary)', 'source']);
    // Raw shape still parses (drift detection input).
    expect(parseIndexColumns(
      'CREATE UNIQUE INDEX idx_timeline_dedup ON public.timeline_entries USING btree (page_id, date, summary, source)',
    )).toEqual(['page_id', 'date', 'summary', 'source']);
  });

  test('the pre-#3737 raw-summary shape reads as drift and rebuilds to md5', async () => {
    await regressToRaw4Col();
    const status = await checkTimelineDedupIndex(engine);
    expect(status.needsRepair).toBe(true);
    const res = await repairTimelineDedupIndex(engine);
    expect(res.repaired).toBe(true);
    const after = await checkTimelineDedupIndex(engine);
    expect(after.columns).toEqual(['page_id', 'date', 'md5(summary)', 'source']);
    expect(after.needsRepair).toBe(false);
  });

  test('healthy md5 index is NOT rebuilt on every pass (self-heal must not revert)', async () => {
    await regressToRaw4Col();
    await repairTimelineDedupIndex(engine);
    const second = await repairTimelineDedupIndex(engine);
    expect(second.repaired).toBe(false);
    expect(second.reason).toBe('already_correct');
  });

  test('3100-char incompressible summary inserts and dedups (single + batch)', async () => {
    await regressToRaw4Col();
    await repairTimelineDedupIndex(engine);
    const big = randomBytes(1550).toString('hex'); // 3100 chars, incompressible

    // Pre-fix: "index row size 3128 exceeds btree version 4 maximum 2704".
    const first = await engine.addTimelineEntry(
      'people/alice-example',
      { date: '2026-01-05', source: 'meeting', summary: big, detail: '' },
    );
    expect(first).toBe(true);
    // Same tuple again → deduped via the md5 conflict target, not an error.
    const dup = await engine.addTimelineEntry(
      'people/alice-example',
      { date: '2026-01-05', source: 'meeting', summary: big, detail: '' },
    );
    expect(dup).toBe(false);

    const batchDup = await engine.addTimelineEntriesBatch([
      { slug: 'people/alice-example', date: '2026-01-05', source: 'meeting', summary: big, detail: '', source_id: 'default' },
    ]);
    expect(batchDup).toBe(0);
    const batchNew = await engine.addTimelineEntriesBatch([
      { slug: 'people/alice-example', date: '2026-01-06', source: 'meeting', summary: big, detail: '', source_id: 'default' },
    ]);
    expect(batchNew).toBe(1);

    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2);
  });
});

// ─── #3957: legacy (source='') row shape repair ──────────────────────────

import { repairLegacyTimelineSourceRows } from '../src/core/timeline-dedup-repair.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';

describe("#3957 legacy-row (source='') shape repair", () => {
  const PIPE_BULLET = '- **2026-01-05** | meeting — Discussed the wiki';
  const DASH_BULLET = '- **2026-01-06** - moved to Berlin - permanently';

  async function resetLegacyState() {
    // Canonical md5 index back in place (earlier describe blocks regress it),
    // then a clean slate for rows + repair-target pages.
    await repairTimelineDedupIndex(engine);
    await engine.executeRaw(`DELETE FROM timeline_entries`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'legacy/%'`);
  }

  async function seedLegacyPage(slug: string, content: string): Promise<string> {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ($1, 'default', 'note', $1, $2, '')`,
      [slug, content],
    );
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id::text AS id FROM pages WHERE slug = $1 AND source_id = 'default'`,
      [slug],
    );
    return rows[0]!.id;
  }

  async function timelineRowsFor(pid: string) {
    return engine.executeRaw<{ source: string; summary: string }>(
      `SELECT source, summary FROM timeline_entries WHERE page_id = $1 ORDER BY id`,
      [pid],
    );
  }

  test('THE review case: legacy pipe-bullet row + re-extract → exactly one split row after repair', async () => {
    await resetLegacyState();
    const pid = await seedLegacyPage('legacy/pipe', `# Pipe\n\n${PIPE_BULLET}\n`);
    // Pre-#3957 DB-path shape: source='' + the UNSPLIT `Source — Summary`.
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, '2026-01-05', '', 'meeting — Discussed the wiki', '')`,
      [pid],
    );

    const r = await repairLegacyTimelineSourceRows(engine);
    expect(r.rowsRewritten).toBe(1);
    expect(r.rowsDeleted).toBe(0);

    // Rewritten in place to the split shape the new parser emits.
    let rows = await timelineRowsFor(pid);
    expect(rows).toEqual([{ source: 'meeting', summary: 'Discussed the wiki' }]);

    // Re-extract (the stale sweep) now DEDUPS onto the repaired row instead
    // of duplicating — pre-repair this left TWO rows.
    await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
    });
    rows = await timelineRowsFor(pid);
    expect(rows).toEqual([{ source: 'meeting', summary: 'Discussed the wiki' }]);
  });

  test('dash-bullet legacy row gets source=markdown and is NEVER split on interior dashes', async () => {
    await resetLegacyState();
    const pid = await seedLegacyPage('legacy/dash', `# Dash\n\n${DASH_BULLET}\n`);
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, '2026-01-06', '', 'moved to Berlin - permanently', '')`,
      [pid],
    );

    const r = await repairLegacyTimelineSourceRows(engine);
    expect(r.rowsRewritten).toBe(1);
    const rows = await timelineRowsFor(pid);
    // A blind split would have produced ('moved to Berlin', 'permanently').
    expect(rows).toEqual([{ source: 'markdown', summary: 'moved to Berlin - permanently' }]);

    await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
    });
    expect(await timelineRowsFor(pid)).toEqual([
      { source: 'markdown', summary: 'moved to Berlin - permanently' },
    ]);
  });

  test('legacy row whose new-shape duplicate already landed is deleted, not collided', async () => {
    await resetLegacyState();
    const pid = await seedLegacyPage('legacy/dupe', `# Dupe\n\n${PIPE_BULLET}\n`);
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, '2026-01-05', '', 'meeting — Discussed the wiki', ''),
              ($1, '2026-01-05', 'meeting', 'Discussed the wiki', '')`,
      [pid],
    );

    const r = await repairLegacyTimelineSourceRows(engine);
    expect(r.rowsDeleted).toBe(1);
    expect(r.rowsRewritten).toBe(0);
    expect(await timelineRowsFor(pid)).toEqual([{ source: 'meeting', summary: 'Discussed the wiki' }]);
  });

  test('legacy row with no matching bullet in current content is left untouched', async () => {
    await resetLegacyState();
    const pid = await seedLegacyPage('legacy/stale-content', `# Edited\n\nNo timeline lines anymore.\n`);
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, '2026-01-05', '', 'meeting — Removed from content', '')`,
      [pid],
    );

    const r = await repairLegacyTimelineSourceRows(engine);
    expect(r.rowsSkipped).toBe(1);
    expect(r.rowsRewritten).toBe(0);
    expect(await timelineRowsFor(pid)).toEqual([
      { source: '', summary: 'meeting — Removed from content' },
    ]);
  });

  test('idempotent — a second repair pass finds nothing to do', async () => {
    await resetLegacyState();
    const pid = await seedLegacyPage('legacy/idem', `# Idem\n\n${PIPE_BULLET}\n`);
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, '2026-01-05', '', 'meeting — Discussed the wiki', '')`,
      [pid],
    );
    await repairLegacyTimelineSourceRows(engine);
    const second = await repairLegacyTimelineSourceRows(engine);
    expect(second).toEqual({ pagesScanned: 0, rowsRewritten: 0, rowsDeleted: 0, rowsSkipped: 0 });
  });

  test('migration v139 ships the repair (handler-only, idempotent)', () => {
    const m = MIGRATIONS.find(x => x.version === 139);
    expect(m).toBeDefined();
    expect(m!.name).toBe('timeline_legacy_source_split_repair');
    expect(typeof m!.handler).toBe('function');
    expect(m!.sql).toBe('');
    expect(m!.idempotent).toBe(true);
  });
});
