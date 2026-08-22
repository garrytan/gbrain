/**
 * #4062 — the cycle's extract phase drains the stale-extraction backlog.
 *
 * Pre-fix, runPhaseExtract only ran runExtractCore over the slugs sync
 * reported (or an fs walk of brainDir). Pages left stale for any other
 * reason — an extractor version bump, DB-only writes, a prior aborted
 * sweep — never re-extracted on the cycle, so the links_extracted_at
 * backlog grew unboundedly until someone hand-ran `gbrain extract --stale`.
 * This pins that the extract phase follows the targeted pass with a
 * bounded, source-scoped extractStaleFromDB drain and reports
 * staleRemaining in the phase details.
 *
 * GBRAIN_HOME is isolated per test because the PGLite cycle path takes a
 * file lock at ~/.gbrain/cycle.lock (see cycle-extract-source.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Empty checkout: the targeted fs-walk pass finds nothing, so any links
  // created can only come from the stale DB drain.
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-stale-drain-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-cycle-stale-drain-home-'));

  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [brainDir],
  );
  // DB-only pages (never present in the checkout) with links_extracted_at
  // NULL → stale. alice's body links to bob.
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES
       ('people/alice', 'wiki', 'person', 'Alice', 'Met [[people/bob]] today.', ''),
       ('people/bob', 'wiki', 'person', 'Bob', 'Quiet page.', '')`,
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

describe('cycle extract phase stale drain (#4062)', () => {
  test('drains stale DB-only pages after the targeted pass and reports staleRemaining', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'wiki',
        phases: ['extract'],
      });
      const extractPhase = report.phases.find(p => p.phase === 'extract');
      expect(extractPhase?.status).toBe('ok');
      // Both stale pages processed by the drain; none left stale.
      expect(Number(extractPhase?.details?.stale_pages_drained ?? -1)).toBe(2);
      expect(Number(extractPhase?.details?.staleRemaining ?? -1)).toBe(0);
      expect(Number(extractPhase?.details?.stale_links_created ?? 0)).toBeGreaterThanOrEqual(1);
    });

    // The stale drain persisted alice → bob.
    const links = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id`,
    );
    expect(links.some(l => l.from_slug === 'people/alice' && l.to_slug === 'people/bob')).toBe(true);

    // Stamped fresh: a second cycle's drain is a no-op.
    const stale = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pages WHERE links_extracted_at IS NULL AND deleted_at IS NULL`,
    );
    expect(Number(stale[0]?.n ?? -1)).toBe(0);
  });

  test('second cycle is a no-op drain (nothing stale, staleRemaining 0)', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
      const report = await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
      const extractPhase = report.phases.find(p => p.phase === 'extract');
      expect(extractPhase?.status).toBe('ok');
      expect(Number(extractPhase?.details?.stale_pages_drained ?? -1)).toBe(0);
      expect(Number(extractPhase?.details?.staleRemaining ?? -1)).toBe(0);
    });
  });
});
