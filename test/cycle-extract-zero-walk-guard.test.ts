/**
 * Regression guard for the dream/autopilot extract phase: an empty *defined*
 * incremental queue (`changedSlugs: []`) must NOT silently skip a full walk
 * when the source has pages but an empty link graph.
 *
 * Scenario: an out-of-band process drains git→DB before the cycle's own sync
 * runs. Sync then sees HEAD == HEAD and returns `pagesAffected: []`. Treating
 * that as "incremental queue of length 0" walks zero slugs even though links
 * were never extracted — link coverage stays at zero indefinitely after a
 * brain rebuild. resolveExtractSlugs() converts that degenerate `[]` to
 * `undefined` (full walk) when pages exist but no links originate from the
 * source, while preserving the fast empty-incremental path on brains that
 * already have links.
 *
 * Uses PGLite/in-memory — no DB connection required.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { resolveExtractSlugs } from '../src/core/cycle.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const SRC = 'default';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPage(slug: string, body: string): Promise<void> {
  const [type, name] = slug.split('/');
  await engine.putPage(slug, {
    type: type as 'person' | 'company',
    title: name,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    content_hash: 'h',
  });
}

describe('resolveExtractSlugs — empty-queue zero-walk guard', () => {
  test('undefined queue is passed through unchanged (full walk)', async () => {
    await seedPage('people/alice-example', '# alice');
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, undefined, SRC)).toBeUndefined();
  });

  test('non-empty incremental queue is passed through unchanged', async () => {
    await seedPage('people/alice-example', '# alice');
    const slugs = ['people/alice-example'];
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, slugs, SRC)).toEqual(slugs);
  });

  test('empty queue with pages but NO links → falls back to full walk (undefined)', async () => {
    await seedPage('people/alice-example', '# alice');
    await seedPage('people/bob-example', '# bob');
    // No links inserted → empty link graph.
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, [], SRC)).toBeUndefined();
  });

  test('empty queue with NO pages stays empty (nothing to rebuild)', async () => {
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, [], SRC)).toEqual([]);
  });

  test('empty queue keeps fast empty-incremental path once links exist', async () => {
    await seedPage('people/alice-example', '# alice\n\n[bob](people/bob-example)');
    await seedPage('people/bob-example', '# bob');
    await engine.addLinksBatch([
      { from_slug: 'people/alice-example', to_slug: 'people/bob-example' },
    ]);
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, [], SRC)).toEqual([]);
  });

  test('empty queue without a sourceId is left untouched (cannot count)', async () => {
    await seedPage('people/alice-example', '# alice');
    expect(await resolveExtractSlugs(engine as unknown as BrainEngine, [], undefined)).toEqual([]);
  });
});
