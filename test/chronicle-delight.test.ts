/**
 * v0.42.x — Life Chronicle (#2390) delight bundle (Phase A.6): on-this-day + narrative.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderTimelineNarrative } from '../src/core/chronicle/narrative.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { ChronicleTimelineRow } from '../src/core/types.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);

async function seedEntry(slug: string, date: string, summary: string) {
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary)
     SELECT id, $1::date, 'test', $2 FROM pages WHERE slug = $3 AND source_id = 'default'`,
    [date, summary, slug],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.putPage('meetings/m', { type: 'meeting', title: 'm', compiled_truth: 'x'.repeat(120) });
  await seedEntry('meetings/m', '2024-06-15', 'June 15 two years ago');
  await seedEntry('meetings/m', '2025-06-15', 'June 15 last year');
  await seedEntry('meetings/m', '2023-01-01', 'unrelated day');
});
afterAll(async () => { await engine.disconnect(); });

describe('renderTimelineNarrative', () => {
  test('renders prose grouped by date', () => {
    const rows = [
      { date: '2026-06-18', summary: 'Project sync', kind: 'meeting' },
      { date: '2026-06-18', summary: 'Vendor call', kind: 'call' },
    ] as ChronicleTimelineRow[];
    const out = renderTimelineNarrative(rows);
    expect(out).toContain('2026-06-18 — 2 events');
    expect(out).toContain('Project sync (meeting)');
  });
  test('empty window', () => {
    expect(renderTimelineNarrative([])).toBe('No events in this window.');
  });
});

describe('getOnThisDay', () => {
  test('returns same month-day in prior years, excludes other days', async () => {
    const rows = await engine.getOnThisDay({ date: '2026-06-15' });
    const summaries = rows.map((r) => r.summary).sort();
    expect(summaries).toEqual(['June 15 last year', 'June 15 two years ago']);
  });

  test('op surfaces on-this-day', async () => {
    const rows = await operationsByName.chronicle_on_this_day.handler(mkCtx(), { date: '2026-06-15' }) as ChronicleTimelineRow[];
    expect(rows).toHaveLength(2);
  });

  test('chronicle_day --narrative returns prose + events', async () => {
    const r = await operationsByName.chronicle_day.handler(mkCtx(), { date: '2024-06-15', narrative: true }) as { narrative: string; events: ChronicleTimelineRow[] };
    expect(r.events).toHaveLength(1);
    expect(r.narrative).toContain('2024-06-15');
  });
});
