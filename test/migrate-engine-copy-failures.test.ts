/**
 * #3194 — migrate-engine must never report success while pages are missing.
 *
 * Pins the three mechanisms added for #3194:
 *   - copyOnePage: full per-page payload copy (page, chunks, tags, timeline).
 *   - copyMigrationLinks: per-link failures are COLLECTED, not fatal — one
 *     bad link no longer aborts the whole link phase.
 *   - comparePageCounts: per-source live-count verification catches silent
 *     drops (soft-deleted pages excluded on both sides by design).
 *
 * Runs against PGLite (same SQL contract as Postgres, DATABASE_URL-free).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  copyOnePage,
  copyMigrationLinks,
  comparePageCounts,
  copyMigrationSources,
} from '../src/commands/migrate-engine.ts';

delete process.env.GBRAIN_PGLITE_SNAPSHOT;

async function setupBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function seedPage(engine: PGLiteEngine, slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note' as any,
    title: slug,
    compiled_truth: `Content of ${slug}`,
    timeline: '',
    frontmatter: {},
  });
}

describe('#3194 migrate-engine copy failure handling', () => {
  let source: PGLiteEngine;
  let target: PGLiteEngine;

  beforeAll(async () => {
    source = await setupBrain();
    target = await setupBrain();
    await seedPage(source, 'pages/a');
    await seedPage(source, 'pages/b');
    await seedPage(source, 'pages/c');
    await source.addLink('pages/a', 'pages/b', 'ctx', 'related');
    await source.addLink('pages/a', 'pages/c', 'ctx', 'related');
    await copyMigrationSources(source, target);
  }, 30000);

  afterAll(async () => {
    await source.disconnect();
    await target.disconnect();
  });

  test('comparePageCounts reports missing pages, then clears once complete', async () => {
    const pages = await source.listPages({ limit: 1000 });
    expect(pages.length).toBe(3);

    // Copy only 2 of 3 — verification must flag the gap.
    await copyOnePage(source, target, pages[0]);
    await copyOnePage(source, target, pages[1]);
    const mismatches = await comparePageCounts(source, target);
    expect(mismatches).toEqual([{ source_id: 'default', source: 3, target: 2 }]);

    // Copy the third — verification clears.
    await copyOnePage(source, target, pages[2]);
    expect(await comparePageCounts(source, target)).toEqual([]);
  });

  test('comparePageCounts ignores soft-deleted pages (deliberately not migrated)', async () => {
    await seedPage(source, 'pages/ghost');
    await source.softDeletePage('pages/ghost');
    expect(await comparePageCounts(source, target)).toEqual([]);
  });

  test('copyMigrationLinks collects per-link failures instead of aborting the phase', async () => {
    const pages = await source.listPages({ limit: 1000 });

    // Fail exactly one addLink; the rest must still be copied.
    const origAddLink = target.addLink.bind(target);
    let failedOnce = false;
    (target as any).addLink = async (...args: Parameters<typeof origAddLink>) => {
      if (!failedOnce && args[1] === 'pages/b') {
        failedOnce = true;
        throw new Error('injected addLink failure');
      }
      return origAddLink(...args);
    };

    const failures = await copyMigrationLinks(source, target, pages);
    (target as any).addLink = origAddLink;

    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('pages/b');
    expect(failures[0]).toContain('injected addLink failure');

    // The other link survived the injected failure.
    const links = await target.getLinks('pages/a');
    const toSlugs = links.map(l => l.to_slug);
    expect(toSlugs).toContain('pages/c');
  });
});
