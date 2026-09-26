/**
 * #5532 -- `gbrain migrate` must copy every page, not the first listPages
 * batch. The copy used one `listPages({ limit: 100000 })` read, so the
 * engine's LIMIT silently dropped every page past it. Here the source
 * engine caps each listPages read at 2 rows (standing in for that LIMIT
 * without inserting 100k rows); the migration must still land all pages,
 * same-slug pages from two sources included.
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

describe('runMigrateEngine reads the whole page set (#5532)', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('pages past the first listPages batch reach the target', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;
    const originalLog = console.log;

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
      const expected = [
        'connector-a:notes/p1',
        'connector-a:people/alice-example',
        'default:notes/p2',
        'default:notes/p3',
        'default:people/alice-example',
      ];
      for (const key of expected) {
        const [sourceId, slug] = key.split(':');
        await source.putPage(
          slug,
          { type: 'note', title: slug, compiled_truth: `body ${key}`, timeline: '', frontmatter: {} },
          { sourceId },
        );
      }

      const real = PGLiteEngine.prototype.listPages;
      const clampedSource = source;
      (clampedSource as unknown as { listPages: unknown }).listPages = (filters?: PageFilters) =>
        real.call(clampedSource, { ...filters, limit: Math.min(filters?.limit ?? 100, 2) });

      const logLines: string[] = [];
      console.log = (...args: unknown[]) => { logLines.push(args.join(' ')); };
      try {
        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);
      } finally {
        console.log = originalLog;
      }
      expect(currentExitCode()).toBe(0);
      expect(logLines.join('\n')).toContain('Migrating 5 pages (5 total, 0 already done)');

      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });
      const rows = await target.executeRaw<{ source_id: string; slug: string; compiled_truth: string }>(
        `SELECT source_id, slug, compiled_truth FROM pages ORDER BY source_id, slug`,
      );
      expect(rows.map((r) => `${r.source_id}:${r.slug}`)).toEqual(expected);
      for (const r of rows) expect(r.compiled_truth).toContain(`body ${r.source_id}:${r.slug}`);
    } finally {
      console.log = originalLog;
      if (source) await source.disconnect();
      if (target) await target.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 60000);
});
