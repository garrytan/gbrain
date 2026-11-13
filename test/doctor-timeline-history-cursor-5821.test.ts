/**
 * #5821: timeline_history scans a bounded number of pages per doctor run. It
 * used to restart from the first page id every run, so a scope with more
 * timeline pages than the cap warned "scan incomplete" forever, even with
 * nothing to repair. The cursor now persists between runs: successive runs
 * finish a pass, a clean pass reports ok, and rows past the cap are found.
 *
 * #7038: the recount of pages earlier runs found had no deadline, so a large
 * found list could keep a doctor run from ever saving its state. It now shares
 * the run's deadline; a page it does not reach is carried, and a pass never
 * ends with a found page left unrecounted.
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

const KEY = 'doctor.timeline_history.scan:default';
const readState = async () => JSON.parse((await engine.getConfig(KEY))!);
const pageId = async (i: number) => Number((await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [`notes/timeline-${i}`]))[0].id);

test('a run out of time keeps its cursor and every found page, and a later run still ends the pass', async () => {
  for (let i = 0; i < PAGES; i++) await addDatabaseOnlyRow(i);
  await run();
  const saved = await readState();
  expect(saved.found).toHaveLength(CAP);
  const outOfTime = await timelineHistoryCheck(engine, 'default', { pageCap: CAP, timeBudgetMs: -1000 });
  expect(outOfTime.details).toMatchObject({ count: 'lower_bound', truncated: true, pages_inspected: CAP });
  const kept = await readState();
  expect(kept.cursor).toBe(saved.cursor);
  expect(new Set(kept.found)).toEqual(new Set(saved.found));
  expect(kept.last).toBeUndefined();
  const results = [];
  for (let i = 0; i < 4 && results.at(-1)?.details?.count !== 'exact'; i++) results.push(await run());
  expect(results.at(-1)).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: PAGES, pages_affected: PAGES, pages_inspected: PAGES } });
});

test('a finished scan does not end the pass while found pages wait for their recount', async () => {
  for (let i = 0; i < PAGES; i++) await addDatabaseOnlyRow(i);
  await timelineHistoryCheck(engine, 'default', { pageCap: 3 });
  for (const i of [3, 4]) await engine.executeRaw(`DELETE FROM timeline_entries WHERE page_id = $1`, [await pageId(i)]);
  const outOfTime = await timelineHistoryCheck(engine, 'default', { pageCap: 3, timeBudgetMs: -1000 });
  expect(outOfTime.details).toMatchObject({ count: 'lower_bound', truncated: true });
  const waiting = await readState();
  expect(waiting.last).toBeUndefined();
  expect(waiting.scan_done).toBe(true);
  expect(new Set(waiting.pending)).toEqual(new Set([await pageId(0), await pageId(1), await pageId(2)]));
  const done = await run();
  expect(done).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: 3, pages_affected: 3, pages_inspected: 3 } });
});

test('found pages from an older state without counts are kept until recounted', async () => {
  for (let i = 0; i < PAGES; i++) await addDatabaseOnlyRow(i);
  const [{ max_entry }] = await engine.executeRaw<{ max_entry: number }>('SELECT max(id) AS max_entry FROM timeline_entries');
  const found = [await pageId(0), await pageId(1)];
  await engine.setConfig(KEY, JSON.stringify({ materializable: 2, unrenderable: 0, affected: 2, inspected: CAP, runs: 1, cursor: found[1], found, started_max_entry: Number(max_entry) }));
  await timelineHistoryCheck(engine, 'default', { pageCap: CAP, timeBudgetMs: -1 });
  expect([...(await readState()).found].sort()).toEqual([...found].sort());
  let last;
  for (let i = 0; i < 3; i++) { last = await run(); if ((last.details as { count?: string }).count === 'exact') break; }
  expect(last).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: PAGES, pages_affected: PAGES, pages_inspected: PAGES } });
});

test('after the scan ends, found pages already recounted are recounted again when the budget allows', async () => {
  for (let i = 0; i < 2; i++) await addDatabaseOnlyRow(i);
  const [{ max_entry }] = await engine.executeRaw<{ max_entry: number }>('SELECT max(id) AS max_entry FROM timeline_entries');
  const [p0, p1] = [await pageId(0), await pageId(1)];
  await engine.setConfig(KEY, JSON.stringify({ materializable: 2, unrenderable: 0, affected: 2, inspected: PAGES, runs: 3, cursor: await pageId(PAGES - 1),
    found: [p0, p1], found_counts: { [p0]: [1, 0], [p1]: [1, 0] }, scan_done: true, pending: [p0], started_max_entry: Number(max_entry) }));
  await engine.executeRaw(`DELETE FROM timeline_entries WHERE source = 'legacy' AND page_id = $1`, [p1]);
  const last = await run();
  expect(last).toMatchObject({ status: 'warn', details: { count: 'exact', materializable_rows: 1, pages_affected: 1, pages_inspected: PAGES } });
});
