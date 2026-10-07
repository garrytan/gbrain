// #6161: a concept merge done by hand (the concept-synthesis skill: aliases and
// a `## Facets` section on the canonical page, the merged page archived under
// concepts/_merged/ with `merged_into`, the original deleted) survives the next
// synthesize_concepts run.
//
// Protects: atoms of a merged-away concept join the canonical concept (by
// `merged_into` or a canonical alias) instead of recreating it; a concept page
// deleted without a redirect is never resurrected; the canonical page's
// `## Facets` section survives republication; alias cycles are ignored.
// Fails when: grouping ignores redirects, the pre-check misses tombstones, or
// republication keeps only the facts/takes fences.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { composeConceptRepublication } from '../../src/core/cycle/concept-publication.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { loadConceptRedirects } from '../../src/core/cycle/concept-redirects.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); }, 120000);

type Atom = { slug: string; title: string; body: string; concept_refs: string[]; visibility: 'world' };
const atom = (slug: string, ref: string): Atom => ({ slug, title: slug, body: `Body of ${slug}.`, concept_refs: [ref], visibility: 'world' });
const ATOMS = [atom('atoms/a0', 'concept-a'), atom('atoms/a1', 'concept-a'), atom('atoms/b0', 'concept-b'), atom('atoms/b1', 'concept-b')];
const run = (atoms: Atom[] = ATOMS) => runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
const page = (slug: string) => engine.getPage(slug, { sourceId: 'default' });
const FACETS = '## Facets\n\n- **concept-b**: the narrower framing, merged here.';

async function mergeBIntoA(): Promise<void> {
  const a = (await page('concepts/concept-a'))!;
  await importFromContent(engine, 'concepts/concept-a', serializeMarkdown({ ...a.frontmatter, aliases: ['concept-b'] },
    `${a.compiled_truth.trim()}\n\n${FACETS}`, '', { type: 'concept', title: a.title, tags: [] }), { sourceId: 'default', noEmbed: true });
  const b = (await page('concepts/concept-b'))!;
  await importFromContent(engine, 'concepts/_merged/c/concept-b', serializeMarkdown({ ...b.frontmatter, merged_into: 'concepts/concept-a' },
    b.compiled_truth, '', { type: 'concept', title: b.title, tags: [] }), { sourceId: 'default', noEmbed: true });
}

describe('synthesize_concepts honors concept merges (#6161)', () => {
  test('a merged-away concept is not recreated after purge; its atoms join the canonical concept', async () => {
    await run();
    expect(await page('concepts/concept-b')).not.toBeNull();
    await mergeBIntoA();
    await engine.deletePage('concepts/concept-b', { sourceId: 'default' });
    await run();
    expect(await page('concepts/concept-b')).toBeNull();
    const a = (await page('concepts/concept-a'))!;
    expect(a.frontmatter.mention_count).toBe(4);
    expect(a.compiled_truth).toContain(FACETS);
  }, 120000);

  test('merged_into alone redirects, even without an alias on the canonical page', async () => {
    await run();
    const b = (await page('concepts/concept-b'))!;
    await importFromContent(engine, 'concepts/_merged/c/concept-b', serializeMarkdown({ ...b.frontmatter, merged_into: 'concepts/concept-a' },
      b.compiled_truth, '', { type: 'concept', title: b.title, tags: [] }), { sourceId: 'default', noEmbed: true });
    await engine.deletePage('concepts/concept-b', { sourceId: 'default' });
    await run();
    expect(await page('concepts/concept-b')).toBeNull();
    expect((await page('concepts/concept-a'))!.frontmatter.mention_count).toBe(4);
  }, 120000);

  test('a concept deleted without a redirect is not resurrected', async () => {
    await run();
    await engine.softDeletePage('concepts/concept-b', { sourceId: 'default' });
    const r = await run();
    expect(await page('concepts/concept-b')).toBeNull();
    expect((r.details as { skipped_deleted?: string[] }).skipped_deleted).toEqual(['concepts/concept-b']);
  }, 120000);

  test('alias cycles are ignored safely', async () => {
    await run();
    for (const [slug, alias] of [['concepts/concept-a', 'concept-b'], ['concepts/concept-b', 'concept-a']] as const) {
      const p = (await page(slug))!;
      await importFromContent(engine, slug, serializeMarkdown({ ...p.frontmatter, aliases: [alias] }, p.compiled_truth, '',
        { type: 'concept', title: p.title, tags: [] }), { sourceId: 'default', noEmbed: true });
    }
    await run();
    expect((await page('concepts/concept-a'))!.frontmatter.mention_count).toBe(2);
    expect((await page('concepts/concept-b'))!.frontmatter.mention_count).toBe(2);
  }, 120000);

  test('republication keeps a ## Facets section verbatim and drops one the model wrote', () => {
    const existing = { type: 'concept' as const, title: 'concept a', timeline: '', frontmatter: { synthesized_by: 'synthesize_concepts-v0.41' },
      compiled_truth: `Old narrative.\n\n${FACETS}\n` };
    const out = composeConceptRepublication(existing, [], { tier: 'T3' }, 'New narrative.\n\n## Facets\n\n- invented by the model');
    expect(out).toContain('New narrative.');
    expect(out).toContain(FACETS);
    expect(out).not.toContain('invented by the model');
  });
});

// The redirect query on both engines (Postgres when DATABASE_URL is set).
for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: loadConceptRedirects reads merged_into and canonical aliases`, async () => {
    const { engine: e, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await e.putPage('concepts/concept-a', { type: 'concept', title: 'a', compiled_truth: 'A.',
        frontmatter: { synthesized_by: 'synthesize_concepts-v0.41', aliases: ['Concept C'] } });
      await e.putPage('concepts/_merged/c/concept-b', { type: 'concept', title: 'b', compiled_truth: 'B.', frontmatter: { merged_into: 'concepts/concept-a' } });
      await e.putPage('concepts/human', { type: 'concept', title: 'h', compiled_truth: 'H.', frontmatter: { aliases: ['concept-d'] } });
      const stem = (ref: string) => ref.split('/').pop()!.toLowerCase().replace(/\s+/g, '-');
      const redirects = await loadConceptRedirects(e, 'default', stem);
      expect([...redirects].sort()).toEqual([['concept-b', 'concept-a'], ['concept-c', 'concept-a']]);
    } finally { await close(); }
  }, 120000);
}
