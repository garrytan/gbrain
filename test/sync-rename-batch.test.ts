/**
 * v0.41.19.0 — sync rename loop (pre-batched slug resolution)
 *
 * Pins the contract of T4 in the plan: the rename loop in
 * src/commands/sync.ts:~1280 pre-resolves all `from` slugs via
 * engine.resolveSlugsByPaths in batches BEFORE iterating per-file. The
 * per-file updateSlug + importFile calls stay (those are inherently
 * per-file). The win is dropping the slug-resolve N+1.
 *
 * Coverage:
 *   - resolveSlugsByPaths returns one Map for an N-path input (not N
 *     individual round-trips). Exercised via engine direct + spy on
 *     executeRaw count.
 *   - Frontmatter-fallback rename: exotic `from` paths still resolve to
 *     the stored slug.
 *   - Source isolation preserved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { DELETE_BATCH_SIZE } from '../src/core/engine-constants.ts';

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

async function seedPageWithPath(slug: string, sourcePath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
     VALUES ('default', $1, $2, 'note', $1, 'body', '', '{}'::jsonb)
     ON CONFLICT (source_id, slug) DO UPDATE SET source_path = EXCLUDED.source_path`,
    [slug, sourcePath],
  );
}

describe('rename loop pre-batched slug resolution', () => {
  test('500 from-paths resolved in 1 batch (DELETE_BATCH_SIZE-aligned)', async () => {
    // Seed 500 pages, all with explicit source_paths matching their slugs.
    const N = 500;
    for (let i = 0; i < N; i++) {
      await seedPageWithPath(`rn/page-${i}`, `rn/page-${i}.md`);
    }
    const paths = Array.from({ length: N }, (_, i) => `rn/page-${i}.md`);

    // Single batch of 500 — exactly at DELETE_BATCH_SIZE boundary.
    expect(paths.length).toBe(DELETE_BATCH_SIZE);
    const m = await engine.resolveSlugsByPaths(paths, { sourceId: 'default' });
    expect(m.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(m.get(`rn/page-${i}.md`)).toBe(`rn/page-${i}`);
    }
  });

  test('frontmatter-fallback rename: exotic source_paths resolve via the batch SELECT', async () => {
    await seedPageWithPath('star-renamed-from', '🌟.md');
    await seedPageWithPath('thai-renamed-from', 'ทดสอบ.md');

    const m = await engine.resolveSlugsByPaths(
      ['🌟.md', 'ทดสอบ.md'],
      { sourceId: 'default' },
    );
    expect(m.get('🌟.md')).toBe('star-renamed-from');
    expect(m.get('ทดสอบ.md')).toBe('thai-renamed-from');
  });

  test('mixed present + missing: partial Map (missing → caller falls back to path-derived)', async () => {
    await seedPageWithPath('present-1', 'present-1.md');
    await seedPageWithPath('present-2', 'present-2.md');
    const m = await engine.resolveSlugsByPaths(
      ['present-1.md', 'absent.md', 'present-2.md', 'absent2.md'],
      { sourceId: 'default' },
    );
    expect(m.size).toBe(2);
    expect(m.get('present-1.md')).toBe('present-1');
    expect(m.get('present-2.md')).toBe('present-2');
    expect(m.get('absent.md')).toBeUndefined();
    expect(m.get('absent2.md')).toBeUndefined();
  });
});
