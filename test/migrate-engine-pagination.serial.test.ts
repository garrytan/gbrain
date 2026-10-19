/**
 * #5532 -- `gbrain migrate` must copy every live page. The copy used one
 * `listPages({ limit: 100000 })` read, so the engine's LIMIT silently dropped
 * every page past it. Here the source engine caps each listPages read at 2
 * rows (standing in for that LIMIT without inserting 100k rows); the
 * migration must still land all pages, same-slug pages from two sources
 * included. A page soft-deleted after the listing is skipped without
 * failing the run and without costing any live page.
 *
 * Serial: mutates GBRAIN_HOME / DATABASE_URL for the migration's config reads.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { PageFilters } from '../src/core/types.ts';

const PAGES = [
  'connector-a:notes/p1',
  'connector-a:people/alice-example',
  'default:notes/p2',
  'default:notes/p3',
  'default:people/alice-example',
];

/**
 * Migrate a seeded PGLite brain into a fresh PGLite target. `afterListing`
 * runs once, after the listing began and before the first page is read:
 * on the second capped listPages call or the first getPage call, whichever
 * comes first.
 */
async function migrate(afterListing?: (source: PGLiteEngine) => Promise<void>) {
  const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
  const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
  const prev = {
    home: process.env.GBRAIN_HOME,
    url: process.env.DATABASE_URL,
    gbrainUrl: process.env.GBRAIN_DATABASE_URL,
    exitCode: process.exitCode,
    log: console.log,
  };
  let source: PGLiteEngine | null = null;
  let target: PGLiteEngine | null = null;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    process.env.GBRAIN_HOME = gbrainHome;
    saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

    source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
    await source.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('connector-a', 'Connector A') ON CONFLICT DO NOTHING`,
    );
    for (const key of PAGES) {
      const [sourceId, slug] = key.split(':');
      await source.putPage(
        slug,
        { type: 'note', title: slug, compiled_truth: `body ${key}`, timeline: '' },
        { sourceId },
      );
    }

    const seeded = source;
    let hookRan = !afterListing;
    const runHook = async () => {
      if (hookRan) return;
      hookRan = true;
      await afterListing!(seeded);
    };
    const realList = PGLiteEngine.prototype.listPages;
    const realGet = PGLiteEngine.prototype.getPage;
    let listCalls = 0;
    (seeded as unknown as { listPages: unknown }).listPages = async (filters?: PageFilters) => {
      if (++listCalls === 2) await runHook();
      return realList.call(seeded, { ...filters, limit: Math.min(filters?.limit ?? 100, 2) });
    };
    (seeded as unknown as { getPage: unknown }).getPage = async (...args: Parameters<PGLiteEngine['getPage']>) => {
      await runHook();
      return realGet.apply(seeded, args);
    };

    const logLines: string[] = [];
    console.log = (...args: unknown[]) => { logLines.push(args.join(' ')); };
    try {
      await runMigrateEngine(seeded, ['--to', 'pglite', '--path', targetDbPath]);
    } finally {
      console.log = prev.log;
    }
    const exitCode = currentExitCode();

    target = new PGLiteEngine();
    await target.connect({ database_path: targetDbPath });
    const rows = await target.executeRaw<{ source_id: string; slug: string; compiled_truth: string }>(
      `SELECT source_id, slug, compiled_truth FROM pages ORDER BY source_id, slug`,
    );
    return { exitCode, log: logLines.join('\n'), rows };
  } finally {
    console.log = prev.log;
    if (source) await source.disconnect();
    if (target) await target.disconnect();
    _resetCliExitVerdictForTests();
    process.exitCode = prev.exitCode ?? 0;
    if (prev.home !== undefined) process.env.GBRAIN_HOME = prev.home; else delete process.env.GBRAIN_HOME;
    if (prev.url !== undefined) process.env.DATABASE_URL = prev.url;
    if (prev.gbrainUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prev.gbrainUrl;
    rmSync(gbrainHome, { recursive: true, force: true });
    rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
  }
}

describe('runMigrateEngine reads the whole page set (#5532)', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('pages past a capped listPages read reach the target', async () => {
    const { exitCode, log, rows } = await migrate();
    expect(exitCode).toBe(0);
    expect(log).toContain('Migrating 5 pages (5 total, 0 already done)');
    expect(rows.map((r) => `${r.source_id}:${r.slug}`)).toEqual(PAGES);
    for (const r of rows) expect(r.compiled_truth).toContain(`body ${r.source_id}:${r.slug}`);
  }, 60000);

  test('a page soft-deleted after the listing is skipped and every live page lands', async () => {
    const { exitCode, log, rows } = await migrate(async (source) => {
      await source.executeRaw(
        `UPDATE pages SET deleted_at = now() WHERE source_id = 'connector-a' AND slug = 'notes/p1'`,
      );
    });
    expect(exitCode).toBe(0);
    expect(log).toContain('1 page(s) were deleted on the source during the copy and were not migrated.');
    expect(rows.map((r) => `${r.source_id}:${r.slug}`)).toEqual(PAGES.filter((k) => k !== 'connector-a:notes/p1'));
  }, 60000);
});
