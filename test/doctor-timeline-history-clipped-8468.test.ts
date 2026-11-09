/**
 * #8468: timeline_history keeps the ids of pages earlier runs of a pass found,
 * capped at FOUND_CAP, and recounts only those when the pass ends. A pass that
 * found more pages than the cap dropped the rest, yet reported the final count
 * as exact and could record a clean pass while the dropped pages still held
 * database-only rows. A clipped pass is now a lower bound and never clean.
 * `foundCap` lowers the cap the way `pageCap` lowers the per-run budget.
 * A pass state saved before the clipped flag existed records no flag; one
 * whose kept list is at the cap may have dropped pages and is a lower bound.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { timelineHistoryCheck } from '../src/commands/doctor/checks/timeline-history.ts';

let engine: PGLiteEngine;
const PAGES = 5;
const run = () => timelineHistoryCheck(engine, 'default', { pageCap: 2, foundCap: 1 });

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

async function runPass() {
  for (let i = 0; i < 10; i++) {
    const check = await run();
    if (!(check.details as { truncated?: boolean }).truncated) return check;
  }
  throw new Error('pass did not finish');
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
  await addDatabaseOnlyRow(0);
  await addDatabaseOnlyRow(1);
});

test('a pass that found more pages than it keeps reports its count as a lower bound', async () => {
  const end = await runPass();
  expect(end.status).toBe('warn');
  expect(end.details).toMatchObject({ count: 'lower_bound', truncated: false, materializable_rows: 1, pages_inspected: PAGES });
  expect(end.message).toContain('at least 1 timeline row(s)');
});

test('a clipped pass whose kept pages were repaired keeps warning and is not trusted as clean', async () => {
  await run();
  await engine.executeRaw("DELETE FROM timeline_entries WHERE source = 'legacy' AND page_id = (SELECT id FROM pages WHERE slug = 'notes/timeline-0')");
  const end = await runPass();
  expect(end.status).toBe('warn');
  expect(end.details).toMatchObject({ count: 'lower_bound', truncated: false, materializable_rows: 0 });
  expect(end.message).toContain('gbrain repair timeline');
  const next = await run();
  expect(next.status).toBe('warn');
  expect(next.details).not.toHaveProperty('last_full_pass');
});

test('a saved pass from before the clipped flag, with its list at the cap, is a lower bound (no cap seam)', async () => {
  const [{ max_entry }] = await engine.executeRaw<{ max_entry: number | string }>('SELECT COALESCE(max(id), 0) AS max_entry FROM timeline_entries');
  const legacy = { materializable: 0, unrenderable: 0, affected: 0, inspected: PAGES, runs: 1, cursor: 2 ** 31 - 1,
    found: Array.from({ length: 10_000 }, (_, i) => 1_000_000 + i), started_max_entry: Number(max_entry) };
  await engine.setConfig('doctor.timeline_history.scan:default', JSON.stringify(legacy));
  const end = await timelineHistoryCheck(engine, 'default');
  expect(end.status).toBe('warn');
  expect(end.details).toMatchObject({ count: 'lower_bound', truncated: false });
  expect(end.message).toContain('gbrain repair timeline');
  const fresh = await timelineHistoryCheck(engine, 'default');
  expect(fresh.status).toBe('warn');
  expect(fresh.details).toMatchObject({ count: 'exact', materializable_rows: 2 });
});
