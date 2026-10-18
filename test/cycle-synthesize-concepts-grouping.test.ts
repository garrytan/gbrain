// #5965: hyphenation variants of one concept label (`network-effects`,
// `networkeffects`, `Network Effects`) used to be three grouping keys, so one
// concept got two pages. synthesize_concepts now folds stems that differ only
// by ASCII `-`, `_` and `.` into one page per run.
//
// Protects: one page per spelling group; a spelling that already has a live
// page keeps winning across reruns (no page is re-created under a new
// spelling); a group with no live page takes the most frequent spelling, a tie
// the hyphenated one; the losing spellings are in-run redirects only (no page
// write); and two spellings that BOTH have live pages (`re-sign` / `resign`,
// `co-op` / `coop`) are never merged automatically ([R28]: the human redirect
// path of #6161 owns that).
// Fails when: the grouping key keeps the punctuation, the live-page rule
// yields to atom count, or the fold merges two live pages.
// Why not existing coverage: synthesize-concepts-merge.test.ts pins explicit
// human redirects; nothing pins spelling folds.
// No new production seam: `_atoms` and `_chat` already exist.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); }, 120000);

type Atom = { slug: string; title: string; body: string; concept_refs: string[]; visibility: 'world' };
const atom = (slug: string, ...refs: string[]): Atom => ({ slug, title: slug, body: `Body of ${slug}.`, concept_refs: refs, visibility: 'world' });
const atoms = (...labels: string[]): Atom[] => labels.map((label, i) => atom(`atoms/a${i}`, label));
// No model is ever called: a T1/T2 group whose chat throws falls back to the
// deterministic narrative, which still writes the page.
const noModel = (): never => { throw new Error('no model calls in this test'); };
const run = (list: Atom[]) => runPhaseSynthesizeConcepts(engine, { _atoms: list, sourceId: 'default', _chat: noModel });
const page = (slug: string) => engine.getPage(slug, { sourceId: 'default' });
const conceptSlugs = async (): Promise<string[]> => (await engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id = 'default' AND slug LIKE 'concepts/%' AND deleted_at IS NULL ORDER BY slug`)).map((r) => r.slug);
const folded = (r: Awaited<ReturnType<typeof run>>) => (r.details as { folded_spellings?: Array<{ from: string; to: string }> }).folded_spellings;

describe('synthesize_concepts folds punctuation spelling variants (#5965)', () => {
  test('network-effects ×2, networkeffects ×2, Network Effects ×1 → one page with every atom', async () => {
    const r = await run(atoms('network-effects', 'networkeffects', 'Network Effects', 'network-effects', 'networkeffects'));
    expect(await conceptSlugs()).toEqual(['concepts/network-effects']);
    expect((await page('concepts/network-effects'))!.frontmatter.mention_count).toBe(5);
    expect(folded(r)).toEqual([{ from: 'networkeffects', to: 'network-effects' }]);
  }, 120000);

  test('the spelling that already has a live page wins, even against more atoms', async () => {
    await run(atoms('networkeffects', 'networkeffects'));
    expect(await conceptSlugs()).toEqual(['concepts/networkeffects']);
    await run(atoms('network-effects', 'network-effects', 'network-effects', 'networkeffects', 'networkeffects'));
    expect(await conceptSlugs()).toEqual(['concepts/networkeffects']);
    expect((await page('concepts/networkeffects'))!.frontmatter.mention_count).toBe(5);
  }, 120000);

  test('no live page: the most frequent spelling wins', async () => {
    await run(atoms('net_work', 'net_work', 'net_work', 'net-work', 'net-work', 'network'));
    expect(await conceptSlugs()).toEqual(['concepts/net_work']);
    expect((await page('concepts/net_work'))!.frontmatter.mention_count).toBe(6);
  }, 120000);

  test('no live page, equal counts: the hyphenated spelling wins', async () => {
    await run(atoms('networkeffects', 'networkeffects', 'network-effects', 'network-effects'));
    expect(await conceptSlugs()).toEqual(['concepts/network-effects']);
  }, 120000);

  test('an atom naming two spellings of one concept counts once', async () => {
    await run([atom('atoms/x', 'network-effects', 'networkeffects'), atom('atoms/y', 'network-effects'), atom('atoms/z', 'networkeffects')]);
    expect(await conceptSlugs()).toEqual(['concepts/network-effects']);
    expect((await page('concepts/network-effects'))!.frontmatter.mention_count).toBe(3);
  }, 120000);

  test('[R28] two spellings that both have live pages are not merged (re-sign / resign, co-op / coop)', async () => {
    // Each spelling earned its own page in earlier runs (atoms of different meanings).
    await run([...atoms('re-sign', 're-sign'), atom('atoms/c0', 'co-op'), atom('atoms/c1', 'co-op')]);
    await run([...atoms('resign', 'resign'), atom('atoms/c0', 'coop'), atom('atoms/c1', 'coop')]);
    expect(await conceptSlugs()).toEqual(['concepts/co-op', 'concepts/coop', 'concepts/re-sign', 'concepts/resign']);
    const r = await run([
      ...atoms('re-sign', 're-sign', 'resign', 'resign', 'resign'),
      atom('atoms/c0', 'co-op'), atom('atoms/c1', 'co-op'), atom('atoms/c2', 'coop'), atom('atoms/c3', 'coop'),
    ]);
    expect(await conceptSlugs()).toEqual(['concepts/co-op', 'concepts/coop', 'concepts/re-sign', 'concepts/resign']);
    expect(folded(r)).toEqual([]);
    expect((await page('concepts/re-sign'))!.frontmatter.mention_count).toBe(2);
    expect((await page('concepts/resign'))!.frontmatter.mention_count).toBe(3);
  }, 120000);

  test('a deleted page is not a live spelling', async () => {
    await run(atoms('networkeffects', 'networkeffects'));
    await engine.softDeletePage('concepts/networkeffects', { sourceId: 'default' });
    await run(atoms('network-effects', 'network-effects', 'network-effects', 'networkeffects', 'networkeffects'));
    expect(await conceptSlugs()).toEqual(['concepts/network-effects']);
    expect((await page('concepts/network-effects'))!.frontmatter.mention_count).toBe(5);
  }, 120000);

  test('losing spellings are redirects for the run only: no page is written for them', async () => {
    await run(atoms('network-effects', 'networkeffects'));
    expect(await conceptSlugs()).toEqual(['concepts/network-effects']);
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/%' AND (frontmatter->>'merged_into') IS NOT NULL`);
    expect(Number(n)).toBe(0);
  }, 120000);
});
