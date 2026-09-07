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
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';
import { extractStaleFromDB, runExtractCore } from '../src/commands/extract.ts';

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
  test('extraction totals count scanned pages rather than links', async () => {
    writeFileSync(join(brainDir, 'quiet.md'), '# Quiet page\nNo outgoing links.\n');
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
      expect(report.phases[0]?.details?.linksCreated).toBe(0);
      expect(report.phases[0]?.details?.pages_processed).toBe(1);
      expect(report.phases[0]?.details?.stale_pages_drained).toBe(2);
      expect(report.totals.pages_extracted).toBe(3);
    });
  });

  test('working and no-op drains leave stdout available for the cycle JSON report', async () => {
    writeFileSync(join(brainDir, 'quiet.md'), '# Quiet page\nNo outgoing links.\n');
    // A checkout page whose [[link]] resolves to another checkout page (both
    // present in the DB under the same source) so the fs-walk link-extraction
    // branch actually runs — and writes an edge — under the stdout spy.
    writeFileSync(join(brainDir, 'linker.md'), '# Linker\nSee [[quiet]].\n');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('quiet', 'wiki', 'concept', 'Quiet page', 'No outgoing links.', ''),
              ('linker', 'wiki', 'concept', 'Linker', 'See [[quiet]].', '')`,
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const first = await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
        const second = await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
        expect(first.phases[0]?.details?.pages_processed).toBe(2);
        expect(first.phases[0]?.details?.linksCreated).toBe(1);
        expect(first.phases[0]?.details?.stale_pages_drained).toBe(2);
        expect(second.phases[0]?.details?.stale_pages_drained).toBe(0);
      });
      expect(log).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      const links = await engine.getLinks('linker', { sourceId: 'wiki' });
      expect(links.some(l => l.to_slug === 'quiet')).toBe(true);
    } finally {
      log.mockRestore();
      stdout.mockRestore();
    }
  });
  for (const dryRun of [false, true]) {
    for (const jsonMode of [false, true]) {
      test(`quiet stale helper suppresses output (dryRun=${dryRun}, jsonMode=${jsonMode})`, async () => {
        const log = spyOn(console, 'log').mockImplementation(() => {});
        const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
        try {
          const result = await extractStaleFromDB(engine, {
            dryRun, jsonMode, quiet: true, includeFrontmatter: false,
            sourceIdFilter: 'wiki', catchUp: false,
          });
          expect(result.pagesProcessed).toBe(dryRun ? 0 : 2);
          expect(log).not.toHaveBeenCalled();
          expect(stdout).not.toHaveBeenCalled();
        } finally {
          log.mockRestore();
          stdout.mockRestore();
        }
      });
    }
  }

  test('standalone stale helper still emits its JSON result', async () => {
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, includeFrontmatter: false,
        sourceIdFilter: 'wiki', catchUp: false,
      });
      expect(stdout).toHaveBeenCalledTimes(1);
      const result = JSON.parse(String(stdout.mock.calls[0]?.[0]));
      expect(result.action).toBe('extract_stale_done');
      expect(result.pages_processed).toBe(2);
    } finally {
      stdout.mockRestore();
    }
  });

  test('standalone stale helper prints its human summary when neither quiet nor JSON', async () => {
    // The quiet/JSON variants above pin silence; this pins that the default
    // CLI path (`gbrain extract --stale`) still tells the operator what ran.
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const result = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: false, includeFrontmatter: false,
        sourceIdFilter: 'wiki', catchUp: false,
      });
      expect(result.pagesProcessed).toBe(2);
      const summary = log.mock.calls.map(c => String(c[0])).find(l => l.startsWith('Extract --stale:'));
      expect(summary).toBeDefined();
      expect(summary).toContain('from 2 page(s)');
      // Human output goes through console.log; nothing is written raw to stdout.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      stdout.mockRestore();
    }
  });

  test('DB-only extraction contributes to totals and a working status', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract'] });
      expect(report.phases[0]?.details?.pages_processed).toBe(0);
      expect(report.phases[0]?.details?.stale_pages_drained).toBe(2);
      expect(report.totals.pages_extracted).toBe(2);
      expect(report.status).toBe('ok');
    });
  });

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

  test('the cycle-shaped slug-scoped extract keeps batch-loss diagnostics on stderr', async () => {
    // The cycle calls runExtractCore with jsonMode: true so the helper's human
    // summary never lands ahead of the dream --json report. Quiet must not mean
    // silent: a flush that drops rows still has to surface on stderr.
    writeFileSync(join(brainDir, 'alice.md'), '# Alice\nMet [[bob]] today.\n');
    writeFileSync(join(brainDir, 'bob.md'), '# Bob\nQuiet page.\n');
    const addLinks = spyOn(engine, 'addLinksBatch').mockRejectedValueOnce(new Error('pool exhausted'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await runExtractCore(engine, { mode: 'all', dir: brainDir, slugs: ['alice'], jsonMode: true, sourceId: 'wiki' });
      expect(addLinks).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      const diagnostics = [...err.mock.calls, ...stderr.mock.calls].map(c => String(c[0]));
      expect(diagnostics.some(d => d.includes('batch_error') && d.includes('pool exhausted'))).toBe(true);
    } finally {
      addLinks.mockRestore();
      log.mockRestore();
      stdout.mockRestore();
      err.mockRestore();
      stderr.mockRestore();
    }
  });

  test('the cycle-shaped extract keeps TIMELINE batch-loss diagnostics on stderr too (#4890 sibling branch)', async () => {
    // Same two-channel contract as the links flush: under jsonMode a dropped
    // timeline batch must land on stderr as a batch_error event, never on stdout.
    writeFileSync(join(brainDir, 'carol.md'), '# Carol\n\n## Timeline\n- **2026-01-02** | Signed the term sheet\n');
    const addTimeline = spyOn(engine, 'addTimelineEntriesBatch').mockRejectedValueOnce(new Error('pool exhausted'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const stdout = spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await runExtractCore(engine, { mode: 'all', dir: brainDir, slugs: ['carol'], jsonMode: true, sourceId: 'wiki' });
      expect(addTimeline).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      const diagnostics = [...err.mock.calls, ...stderr.mock.calls].map(c => String(c[0]));
      expect(diagnostics.some(d => d.includes('"event":"batch_error"') && d.includes('pool exhausted'))).toBe(true);
    } finally {
      addTimeline.mockRestore();
      log.mockRestore();
      stdout.mockRestore();
      err.mockRestore();
      stderr.mockRestore();
    }
  });
});
