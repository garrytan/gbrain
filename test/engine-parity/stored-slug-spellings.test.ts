/**
 * BrainEngine parity: the stored-spelling scan a scalar slug read makes (`readStoredSlugSpellings`,
 * engine-sql/slug-spellings.ts; called from `chooseSpelling` in src/core/ops/slug-params.ts), called directly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), the scan answers the
 *    same distinct stored slugs whose spelling key (letters and digits of the slug's normal form) is the key asked for,
 *    in byte order, after the slug given; it counts soft-deleted pages, and its scope is the source list when given (an
 *    empty list matches nothing), else the one source, else every source.
 *  - Regression: the scan was raw SQL in chooseSpelling, which the Rust engine refuses, so a read that missed under the
 *    caller's spelling fell back to the normal form without looking for the stored spelling.
 *  - Why existing coverage misses it: test/slug-legacy-rows.test.ts and test/slug-normalize-reads.test.ts run on PGLite
 *    only, and the world-only parity cases reach the scan only through a read that finds nothing.
 *  - Seam: none. Real engines; slugs in normal form only, since the Rust store holds every slug in normal form.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, sourceId = 'default') =>
  engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });

describe('engine parity: the stored-spelling scan', () => {
  parityTest('readStoredSlugSpellings lists the slugs that share a key, by bytes, after a slug, in each scope', {
    methods: ['readStoredSlugSpellings', 'insertSource', 'putPage', 'softDeletePage'],
    timeout: 90_000,
  }, async (engine) => {
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    for (const slug of ['notes/a-b', 'notes/ab', 'notes/a.b', 'notes/abc', 'people/ab', 'notes/caf\u00e9']) await put(engine, slug);
    await put(engine, 'notes/a_b', 'other-example');
    // A soft-deleted page keeps its spelling: the scan has no live filter.
    await engine.softDeletePage('notes/a.b', { sourceId: 'default' });
    const answers = {
      source: await engine.readStoredSlugSpellings('notesab', { sourceId: 'default' }, ''),
      after: await engine.readStoredSlugSpellings('notesab', { sourceId: 'default' }, 'notes/a.b'),
      every: await engine.readStoredSlugSpellings('notesab', {}, ''),
      list: await engine.readStoredSlugSpellings('notesab', { sourceId: 'default', sourceIds: ['other-example'] }, ''),
      emptyList: await engine.readStoredSlugSpellings('notesab', { sourceId: 'default', sourceIds: [] }, ''),
      // The accent is not a key character: `notes/café` keys to `notescaf`.
      accent: await engine.readStoredSlugSpellings('notescaf', { sourceId: 'default' }, ''),
      none: await engine.readStoredSlugSpellings('nosuchkey', {}, ''),
    };
    expect(answers).toEqual({
      source: ['notes/a-b', 'notes/a.b', 'notes/ab'], after: ['notes/ab'], every: ['notes/a-b', 'notes/a.b', 'notes/a_b', 'notes/ab'],
      list: ['notes/a_b'], emptyList: [], accent: ['notes/caf\u00e9'], none: [],
    });
    return answers;
  });
});
