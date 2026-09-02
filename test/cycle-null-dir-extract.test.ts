/**
 * The extract phase on a brain with NO checkout (brainDir null). Before this
 * change the phase was skipped outright (`no_brain_dir`), which made the
 * in-cycle stale-link drain (#4062) unreachable on every database-only
 * brain: links_extracted_at backlogs only ever grew there. Now the phase
 * runs the drain alone and reports `ok` with `fs_walk: 'no_brain_dir'`.
 *
 * Also pins the `[cycle.phase]` stderr lines every phase boundary emits.
 *
 * Same fixture as cycle-stale-drain.test.ts: two DB-only pages, one linking
 * to the other, both stale. GBRAIN_HOME isolated for the PGLite file lock.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle, formatPhaseLogLine } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);
afterAll(async () => { await engine.disconnect(); }, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-null-dir-extract-home-'));
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', NULL)
     ON CONFLICT (id) DO UPDATE SET local_path = NULL`,
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES
       ('people/alice', 'wiki', 'person', 'Alice', 'Met [[people/bob]] today.', ''),
       ('people/bob', 'wiki', 'person', 'Bob', 'Quiet page.', '')`,
  );
});
afterEach(() => { rmSync(gbrainHome, { recursive: true, force: true }); });

describe('extract phase with brainDir null', () => {
  test('runs the stale drain alone: status ok, fs_walk no_brain_dir, counts reported, links persisted', async () => {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['extract'] }));
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('ok');
    expect(extract?.details?.fs_walk).toBe('no_brain_dir');
    expect(extract?.details?.reason).toBeUndefined(); // not a skip record
    expect(Number(extract?.details?.stale_pages_drained ?? -1)).toBe(2);
    expect(Number(extract?.details?.staleRemaining ?? -1)).toBe(0);
    expect(Number(extract?.details?.stale_links_created ?? 0)).toBeGreaterThanOrEqual(1);
    // Same shape as the checkout branch, so totals see the work.
    expect(Number(extract?.details?.linksCreated ?? 0)).toBeGreaterThanOrEqual(1);
    expect(report.totals.pages_extracted).toBeGreaterThanOrEqual(1);
    expect(report.status).toBe('ok');
    expect(report.brain_dir).toBeNull();

    const links = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug
       FROM links l JOIN pages pf ON pf.id = l.from_page_id JOIN pages pt ON pt.id = l.to_page_id`,
    );
    expect(links.some((l) => l.from_slug === 'people/alice' && l.to_slug === 'people/bob')).toBe(true);
  });

  test('second null-dir cycle is a no-op drain (clean, nothing stale)', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['extract'] }));
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['extract'] }));
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('ok');
    expect(Number(extract?.details?.stale_pages_drained ?? -1)).toBe(0);
    expect(report.status).toBe('clean');
  });

  test('dry-run keeps the honest skip (no dry-run mode for extract) and still names fs_walk', async () => {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['extract'], dryRun: true }));
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('skipped');
    expect(extract?.details?.reason).toBe('no_dry_run_support');
    expect(extract?.details?.fs_walk).toBe('no_brain_dir');
  });
});

describe('[cycle.phase] log lines', () => {
  test('formatPhaseLogLine: exact start/end shapes', () => {
    expect(formatPhaseLogLine('lint', 'start')).toBe('[cycle.phase] name=lint event=start');
    expect(formatPhaseLogLine('extract', 'end', 'ok', 1234)).toBe('[cycle.phase] name=extract event=end status=ok duration_ms=1234');
    expect(formatPhaseLogLine('lint', 'end', 'skipped', 0)).toBe('[cycle.phase] name=lint event=end status=skipped duration_ms=0');
  });

  test('a running phase emits start then end with its status; a no_brain_dir skip emits end status=skipped', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['lint', 'extract'] }));
    } finally {
      spy.mockRestore();
    }
    const phaseLines = lines.filter((l) => l.startsWith('[cycle.phase] '));
    expect(phaseLines).toContain('[cycle.phase] name=lint event=end status=skipped duration_ms=0');
    expect(phaseLines).toContain('[cycle.phase] name=extract event=start');
    expect(phaseLines.some((l) => /^\[cycle\.phase\] name=extract event=end status=ok duration_ms=\d+$/.test(l))).toBe(true);
    // start precedes end for the phase that ran
    const start = phaseLines.findIndex((l) => l === '[cycle.phase] name=extract event=start');
    const end = phaseLines.findIndex((l) => l.startsWith('[cycle.phase] name=extract event=end'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  });
});
