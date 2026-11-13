/**
 * A body-only stale sweep (the default: `autopilot.incremental_extract_include_frontmatter` off) settles an origin
 * that a frontmatter wanted row made stale. The sweep does not re-derive frontmatter rows, so before the fix their
 * `checked_at` never moved past the target's `updated_at`: the origin stayed stale after every sweep, and the
 * `extract --stale` job chained a continuation for it on every run.
 *
 * Authoring gate: (1) protects "a stale sweep that processed a page leaves it fresh", and that a brain with the knob
 * on still gets its frontmatter edge; (2) the first test fails when the body-only sweep leaves other producers' rows
 * unchecked, the second when any body-only write settles them; (3) the #9140 scenarios run on a managed brain, whose
 * sweep rewrites both producers, so they never take the body-only path; (4) no seam.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

const staleSlugs = async () =>
  (await engine.listStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS, batchSize: 100 })).map(page => page.slug).sort();
const sweep = (includeFrontmatter?: boolean) => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true,
  ...(includeFrontmatter === undefined ? {} : { includeFrontmatter }) });

test('a frontmatter wanted row whose target changed does not keep its origin stale under the body-only sweep', async () => {
  await engine.putPage('acme-toolkit', { type: 'note', title: 'Acme toolkit', compiled_truth: 'Acme toolkit.', timeline: '' });
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '',
    frontmatter: { founded: ['acme-toolkit'] } });
  // A frontmatter-aware extraction (put_page, link reconciliation, or this flag) records the unresolved name.
  await sweep(true);
  expect(await engine.executeRaw('SELECT producer, ref_kind, target_ref FROM wanted_links'))
    .toEqual([{ producer: 'frontmatter', ref_kind: 'name', target_ref: 'acme-toolkit' }]);
  expect(await staleSlugs()).toEqual([]);

  // The target changes: its origin is stale once.
  await engine.putPage('acme-toolkit', { type: 'note', title: 'Acme toolkit', compiled_truth: 'Acme toolkit, edited.', timeline: '' });
  expect(await staleSlugs()).toEqual(['acme-toolkit', 'people/alice-example']);

  // The default sweep processes the origin and settles it; a second sweep has nothing to do.
  const first = await sweep();
  expect(first.pagesProcessed).toBe(2);
  expect(await staleSlugs()).toEqual([]);
  const second = await sweep();
  expect(second.pagesProcessed).toBe(0);
  expect(second.staleRemaining).toBe(0);
  // The row is kept for a frontmatter-aware extraction; only its check time moved.
  expect(await engine.executeRaw('SELECT producer, ref_kind, target_ref FROM wanted_links'))
    .toEqual([{ producer: 'frontmatter', ref_kind: 'name', target_ref: 'acme-toolkit' }]);
}, 120_000);

test('with the knob on, a body-only pass leaves a frontmatter wake-up for the frontmatter-aware sweep', async () => {
  await engine.setConfig('autopilot.incremental_extract_include_frontmatter', 'true');
  await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'Origin.', timeline: '',
    frontmatter: { related: ['[[people/bob-example]]'] } });
  await sweep();
  expect(await engine.executeRaw("SELECT producer, ref_kind FROM wanted_links WHERE target_ref = 'people/bob-example'"))
    .toEqual([{ producer: 'frontmatter', ref_kind: 'slug' }]);
  await engine.putPage('people/bob-example', { type: 'person', title: 'Bob', compiled_truth: 'Bob.', timeline: '' });
  // `extract links --source db` without --include-frontmatter rewrites body rows only, whatever the knob says.
  const quiet = spyOn(console, 'log').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`extract exited ${code}`); });
  try { await runExtract(engine, ['links', '--source', 'db']); } finally { exit.mockRestore(); quiet.mockRestore(); }
  await sweep();
  expect(await engine.executeRaw(`SELECT f.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    WHERE t.slug = 'people/bob-example'`)).toEqual([{ slug: 'notes/origin' }]);
}, 120_000);
