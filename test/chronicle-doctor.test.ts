/**
 * v0.42.x — Life Chronicle (#2390) doctor chronicle_projection_health (Phase B.13).
 * Verifies the orphan-detection query the doctor check runs: a timeline
 * projection whose event page is soft-deleted is counted (hidden at read time,
 * flagged for cleanup).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runChronicleExtract, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';

let engine: PGLiteEngine;

const orphanQuery = `SELECT count(*)::int AS n FROM timeline_entries te
   JOIN pages ep ON ep.id = te.event_page_id
   WHERE te.event_page_id IS NOT NULL AND ep.deleted_at IS NOT NULL`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('chronicle_projection_health detection', () => {
  test('counts projections whose event page is soft-deleted; zero otherwise', async () => {
    await engine.putPage('meetings/d', { type: 'meeting', title: 'd', compiled_truth: 'x'.repeat(120), effective_date: new Date('2026-06-18T12:00:00Z') });
    const judge: ChronicleJudge = async () => ({ events: [{ when: '2026-06-18T12:00:00Z', who: [], what: 'an event', kind: 'meeting' }] });
    await runChronicleExtract(engine, { slug: 'meetings/d', judge });

    let r = await engine.executeRaw<{ n: number }>(orphanQuery);
    expect(Number(r[0].n)).toBe(0); // healthy: event page live

    // Soft-delete the event page → its projection becomes an orphan.
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE type = 'event'`);
    r = await engine.executeRaw<{ n: number }>(orphanQuery);
    expect(Number(r[0].n)).toBe(1);
  });
});
