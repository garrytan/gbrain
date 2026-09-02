/**
 * #4583 — integration proof against real PGLite.
 *
 * The hermetic suite stubs executeRaw, so it never exercises the actual guard
 * SQL (COALESCE + CASE + `COUNT(DISTINCT ...) FILTER (...)`). This drives the
 * real aggregate against a real brain and confirms the end-to-end resolve →
 * assess flow: a 2+ non-default-source brain resolves to tier `seed_default`
 * AND the guard then fires.
 *
 * `.serial` because it owns a real PGLite instance (shared-state harness).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  assessDefaultWriteGuard,
  resolveSourceWithTier,
} from '../src/core/source-resolver.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function addSource(id: string, localPath: string | null) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, localPath],
  );
}

async function seedPage(slug: string, sourceId: string) {
  await importFromContent(engine, slug, `---\ntype: note\ntitle: ${slug}\n---\n# ${slug}\n`, {
    noEmbed: true,
    sourceId,
  });
}

describe('real-PGLite guard SQL', () => {
  test('bulk-in-non-default brain: unscoped resolve → seed_default AND guard fires', async () => {
    // Two non-default sources hold the content; default is empty.
    await addSource('vault', '/tmp/test-vault');
    await addSource('gstack', '/tmp/gstack-vault');
    await seedPage('a/one', 'vault');
    await seedPage('a/two', 'vault');
    await seedPage('b/one', 'gstack');

    // Resolve with NO signal, from a dir under neither source → seed_default
    // (sole_non_default can't fire with 2 non-default sources).
    const resolved = await resolveSourceWithTier(engine, null, '/nowhere');
    expect(resolved.tier).toBe('seed_default');

    const a = await assessDefaultWriteGuard(engine);
    expect(a.shouldGuard).toBe(true);
    expect(a.defaultPages).toBe(0);
    expect(a.nonDefaultPages).toBe(3);
    expect(a.nonDefaultSources).toBe(2);
  });

  test('default-dominant brain: guard does NOT fire', async () => {
    await addSource('vault', '/tmp/test-vault');
    await seedPage('d/one', 'default');
    await seedPage('d/two', 'default');
    await seedPage('d/three', 'default');
    await seedPage('j/one', 'vault');

    const a = await assessDefaultWriteGuard(engine);
    expect(a.defaultPages).toBe(3);
    expect(a.nonDefaultPages).toBe(1);
    expect(a.nonDefaultSources).toBe(1);
    expect(a.shouldGuard).toBe(false);
  });

  test('fresh brain (no pages): guard does NOT fire', async () => {
    const a = await assessDefaultWriteGuard(engine);
    expect(a.shouldGuard).toBe(false);
    expect(a.nonDefaultPages).toBe(0);
  });

  test('soft-deleted pages are excluded from the distribution (review fix)', async () => {
    // Live content: default-dominant (3 live in default vs 2 live outside).
    await addSource('vault', '/tmp/test-vault');
    await addSource('gstack', '/tmp/gstack-vault');
    await seedPage('d/one', 'default');
    await seedPage('d/two', 'default');
    await seedPage('d/three', 'default');
    await seedPage('v/live', 'vault');
    await seedPage('g/live', 'gstack');
    // Graveyard: 5 soft-deleted pages in vault. Counting them would flip the
    // verdict to shouldGuard=true (nonDefault 7 > default 3) — every sibling
    // predicate in this brain filters deleted_at IS NULL, and so must this.
    for (let i = 0; i < 5; i++) await seedPage(`v/dead-${i}`, 'vault');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = NOW() WHERE source_id = 'vault' AND slug LIKE 'v/dead-%'`,
    );

    const a = await assessDefaultWriteGuard(engine);
    expect(a.defaultPages).toBe(3);
    expect(a.nonDefaultPages).toBe(2);
    expect(a.shouldGuard).toBe(false);
  });
});
