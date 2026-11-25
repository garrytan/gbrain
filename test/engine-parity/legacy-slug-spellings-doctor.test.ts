/**
 * BrainEngine parity: the `legacy_slug_spellings` doctor check (src/commands/doctor/checks/legacy-slug-spellings.ts) and
 * the two reads it makes: which brain tables row-level security applies to (`readRowSecurityTables`) and the pages
 * whose slug may not be normal (`listSlugSpellingCandidates`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the check answers ok with
 *    a count of 0 on a brain whose slugs are all normal, a non-ASCII normal slug included, and the two reads answer the
 *    same rows: no row-security table, and the candidate pages (an ASCII capital or a character outside printable ASCII)
 *    of every source, deleted pages included, in id order after an id.
 *  - Regression: both reads were raw SQL in the check (repair/slug-spelling-guards.ts, repair/slug-spelling.ts), so on a
 *    Rust brain the check stopped on the typed raw_sql refusal and gbrain doctor reported it on every Rust brain.
 *  - Why existing coverage misses it: test/repair-slug-spelling*.test.ts run on PGLite and Postgres only, and
 *    test/rust-cli-parity.serial.test.ts pinned the refusal.
 *  - Seam: none. Real engines; slugs in normal form only, since the Rust store holds every slug in normal form (a stored
 *    legacy spelling is covered on PGLite and Postgres by test/repair-slug-spelling*.test.ts).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { legacySlugSpellingsEntry } from '../../src/commands/doctor/checks/legacy-slug-spellings.ts';

const { parityTest } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, sourceId = 'default') =>
  engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });

async function seed(engine: BrainEngine): Promise<void> {
  await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
  for (const slug of ['notes/plain', 'notes/caf\u00e9', 'people/\u65e5\u672c', 'notes/ok-1']) await put(engine, slug);
  await put(engine, 'notes/na\u00efve', 'other-example');
  await engine.softDeletePage('people/\u65e5\u672c', { sourceId: 'default' });
}

describe('engine parity: the legacy_slug_spellings doctor check', () => {
  parityTest('the check is ok with a count of 0 on a brain whose slugs are all normal', {
    methods: ['readRowSecurityTables', 'listSlugSpellingCandidates'], timeout: 90_000,
  }, async (engine) => {
    await seed(engine);
    const checks = await legacySlugSpellingsEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    const shown = checks.map(c => ({ name: c.name, status: c.status, count: c.details?.count, by_source: c.details?.by_source, truncated: c.details?.truncated }));
    expect(shown).toEqual([{ name: 'legacy_slug_spellings', status: 'ok', count: 0, by_source: [], truncated: false }]);
    return shown;
  });

  parityTest('readRowSecurityTables and listSlugSpellingCandidates answer the same rows', {
    methods: ['readRowSecurityTables', 'listSlugSpellingCandidates', 'insertSource', 'putPage', 'softDeletePage'], timeout: 90_000,
  }, async (engine) => {
    await seed(engine);
    const all = await engine.listSlugSpellingCandidates(0);
    const view = (rows: typeof all) => rows.map(r => ({ source_id: r.source_id, slug: r.slug }));
    const answers = {
      rowSecurity: await engine.readRowSecurityTables(['pages', 'facts']),
      all: view(all),
      // The page ids differ by engine; the rows after the first candidate's id do not.
      afterFirst: view(await engine.listSlugSpellingCandidates(Number(all[0]!.id))),
      afterLast: view(await engine.listSlugSpellingCandidates(Number(all[all.length - 1]!.id))),
    };
    expect(answers).toEqual({
      rowSecurity: [],
      all: [{ source_id: 'default', slug: 'notes/caf\u00e9' }, { source_id: 'default', slug: 'people/\u65e5\u672c' }, { source_id: 'other-example', slug: 'notes/na\u00efve' }],
      afterFirst: [{ source_id: 'default', slug: 'people/\u65e5\u672c' }, { source_id: 'other-example', slug: 'notes/na\u00efve' }],
      afterLast: [],
    });
    return answers;
  });
});
