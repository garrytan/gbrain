/**
 * #2057 regression — addTimelineEntriesBatch must accept JS Date `date` values.
 *
 * The original bug: callers source `date` from SQL rows (e.g.
 * `meeting.effective_date`), which arrive as JS Date objects. The OLD insert
 * bound them into `${dates}::text[]`, which threw `cannot cast type timestamp
 * with time zone to text[]`, and a bare `catch {}` in the meetings extractor
 * swallowed it — timeline stayed empty forever.
 *
 * The #1861 refactor moved the insert to `jsonb_to_recordset` + `v.date::date`,
 * where a Date serializes to an ISO string that casts cleanly. This test pins
 * that a Date-bearing batch round-trips, so a future refactor can't silently
 * reintroduce the cast failure. (The companion fix un-silences the extractor's
 * catch so any future failure is visible rather than a phantom "0 entries".)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { TimelineBatchInput } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'people/alice-example', `---\ntitle: Alice\ntype: note\n---\n\n# Alice\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: 'people/alice-example.md',
  });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('#2057 addTimelineEntriesBatch with Date date values', () => {
  test('a Date `date` is inserted and round-trips as the right calendar day', async () => {
    // Mimic the real caller: `date` typed string on the interface, but a JS
    // Date at runtime (straight off a TIMESTAMPTZ column). The cast must hold.
    const effectiveDate = new Date('2026-04-03T00:00:00.000Z');
    const batch: TimelineBatchInput[] = [
      {
        slug: 'people/alice-example',
        date: effectiveDate as unknown as string,
        source: 'cli:test',
        summary: 'met alice',
        source_id: 'default',
      },
    ];

    const inserted = await engine.addTimelineEntriesBatch(batch);
    expect(inserted).toBe(1);

    const rows = await engine.executeRaw<{ date: string }>(
      `SELECT date::text AS date FROM timeline_entries WHERE summary = 'met alice'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe('2026-04-03');
  });

  test('a plain ISO string `date` still works (no regression)', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      {
        slug: 'people/alice-example',
        date: '2026-05-01',
        source: 'cli:test',
        summary: 'string-dated entry',
        source_id: 'default',
      },
    ]);
    expect(inserted).toBe(1);
  });
});
