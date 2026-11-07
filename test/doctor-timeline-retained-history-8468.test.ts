import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { timelineHistoryCheck } from '../src/commands/doctor/checks/timeline-history.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages (id, source_id, slug, type, title)
    VALUES (20001, 'default', 'notes/first', 'note', 'First'),
      (20002, 'default', 'notes/second', 'note', 'Second'),
      (20003, 'default', 'notes/third', 'note', 'Third')`);
  await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary, detail)
    VALUES (20001, '2026-01-01', 'legacy', 'First database-only event', ''),
      (20002, '2026-01-01', 'legacy', 'Second database-only event', ''),
      (20003, '2026-01-01', 'legacy', 'Third database-only event', '')`);
  await engine.setConfig('doctor.timeline_history.scan:default', JSON.stringify({
    cursor: 20001,
    found: Array.from({ length: 10_000 }, (_, i) => i + 1),
    materializable: 10_001,
    unrenderable: 0,
    affected: 10_001,
    inspected: 10_001,
    runs: 5,
    started_max_entry: 3,
  }));
});

afterAll(async () => { await engine.disconnect(); });

test('a recount after the retained page cap stays a lower bound', async () => {
  const continuing = await timelineHistoryCheck(engine, 'default', { pageCap: 1 });
  expect(continuing.details).toMatchObject({ count: 'lower_bound', truncated: true });

  const completed = await timelineHistoryCheck(engine, 'default', { pageCap: 1 });
  expect(completed.status).toBe('warn');
  expect(completed.details).toMatchObject({ count: 'lower_bound', truncated: false });
});
