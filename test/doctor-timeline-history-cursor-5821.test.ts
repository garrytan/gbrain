/**
 * #5821: timeline_history scans a bounded number of pages per doctor run. It
 * used to restart from the first page id every run, so a scope with more
 * timeline pages than the cap warned "scan incomplete" forever, even with
 * nothing to repair. The cursor now persists between runs: successive runs
 * finish a pass, a clean pass reports ok, and rows past the cap are found.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { timelineHistoryCheck } from '../src/commands/doctor/checks/timeline-history.ts';

let engine: PGLiteEngine;
const PAGES = 5;
const CAP = 2;
const run = () => timelineHistoryCheck(engine, 'default', { pageCap: CAP });

async function seedPage(i: number): Promise<void> {
  const slug = `notes/timeline-${i}`;
  await importFromContent(engine, slug, `---\ntitle: Timeline ${i}\ntype: note\n---\nBody ${i}.\n\n## Timeline\n\n- **2026-07-0${i + 1}** | Event ${i} happened\n`, { noEmbed: true });
  await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
    SELECT id, $2::date, '', $3, '' FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug, `2026-07-0${i + 1}`, `Event ${i} happened`]);
}

async function addDatabaseOnlyRow(i: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
    SELECT id, '2026-08-01', 'legacy', 'A database-only event', '' FROM pages WHERE slug = $1 AND source_id = 'default'`, [`notes/timeline-${i}`]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'doctor.timeline_history.scan%'");
  for (let i = 0; i < PAGES; i++) await seedPage(i);
});

test('a clean scope larger than the cap reaches ok and stays ok while the next pass runs', async () => {
  const first = await run();
  expect(first.status).toBe('warn');
  expect(first.details).toMatchObject({ truncated: true, pages_inspected: CAP });
  const second = await run();
  const third = await run();
  expect(third).toMatchObject({ status: 'ok', details: { count: 'exact', truncated: false, pages_inspected: PAGES, materializable_rows: 0 } });
  expect(second.status).toBe('warn');
  const fourth = await run();
  expect(fourth.status).toBe('ok');
  expect(fourth.details).toMatchObject({ truncated: true, last_full_pass: { pages_inspected: PAGES } });
});

test('a database-only row on a page past the cap is found by a later run', async () => {
  await addDatabaseOnlyRow(PAGES - 1);
  let last;
  for (let i = 0; i < 3; i++) last = await run();
  expect(last).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: 1, pages_affected: 1, pages_inspected: PAGES } });
  expect(last!.message).toContain('gbrain repair timeline --apply');
});

test('a timeline row written after a clean pass withdraws the trust in that pass', async () => {
  for (let i = 0; i < 3; i++) await run();
  await addDatabaseOnlyRow(PAGES - 1);
  const next = await run();
  expect(next.status).toBe('warn');
  expect(next.details).toMatchObject({ count: 'lower_bound', materializable_rows: 0 });
  expect(next.message).toContain('scan incomplete');
});

test('a row repaired between runs of one pass is not counted when the pass ends', async () => {
  await addDatabaseOnlyRow(0);
  const first = await run();
  expect(first.details).toMatchObject({ count: 'lower_bound', materializable_rows: 1 });
  await engine.executeRaw("DELETE FROM timeline_entries WHERE source = 'legacy'");
  await run();
  const last = await run();
  expect(last).toMatchObject({ status: 'ok', details: { count: 'exact', materializable_rows: 0, pages_inspected: PAGES } });
});

test('a recount that runs out of budget carries every found page and never completes the pass', async () => {
  for (let i = 0; i < PAGES; i++) await addDatabaseOnlyRow(i);
  const first = await run();
  expect(first.details).toMatchObject({ truncated: true, count: 'lower_bound', materializable_rows: CAP, pages_inspected: CAP });
  const key = 'doctor.timeline_history.scan:default';
  const before = JSON.parse((await engine.getConfig(key))!);
  // An already expired budget: the recount reaches no page, so the scan must wait.
  const expired = await timelineHistoryCheck(engine, 'default', { pageCap: CAP, timeBudgetMs: -1 });
  expect(expired.details).toMatchObject({ truncated: true, count: 'lower_bound', pages_inspected: CAP });
  const after = JSON.parse((await engine.getConfig(key))!);
  expect(after.cursor).toBe(before.cursor);
  expect([...after.found].sort()).toEqual([...before.found].sort());
  expect(after.last).toBeUndefined();
  let last;
  for (let i = 0; i < 3; i++) { last = await run(); if ((last.details as { count?: string }).count === 'exact') break; }
  expect(last).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: PAGES, pages_affected: PAGES, pages_inspected: PAGES } });
});

test('an unfinished recount never completes the pass, even when the scan has nothing left', async () => {
  for (let i = 0; i < PAGES; i++) await addDatabaseOnlyRow(i);
  const first = await timelineHistoryCheck(engine, 'default', { pageCap: PAGES - 1 });
  expect(first.details).toMatchObject({ truncated: true, materializable_rows: PAGES - 1 });
  // The only page past the cursor loses its timeline rows: the next scan finds nothing to inspect.
  await engine.executeRaw(`DELETE FROM timeline_entries WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`, [`notes/timeline-${PAGES - 1}`]);
  const expired = await timelineHistoryCheck(engine, 'default', { pageCap: PAGES - 1, timeBudgetMs: -1 });
  expect(expired.details).toMatchObject({ truncated: true, count: 'lower_bound' });
  expect(JSON.parse((await engine.getConfig('doctor.timeline_history.scan:default'))!).last).toBeUndefined();
});
