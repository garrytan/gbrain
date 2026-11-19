/**
 * BrainEngine parity — the page filters `searchVector` takes beside type, slug and source scope: the frontmatter
 * `where` filter.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `searchVector` drops the pages a filter rejects inside its candidate scan, before it ranks and before
 *    LIMIT (`buildVectorSearchStatement`, search/vector-statement.ts): `where` keeps a page whose top-level frontmatter
 *    field equals one of a key's values or is a list holding one, with a numeric or boolean reading of a string value
 *    (`frontmatterWhereClauses`). Every engine arm returns the same rows and scores.
 *  - Regression: an engine that refuses the option, ignores it, applies it after LIMIT (a limited read comes back
 *    short), misses list containment or the numeric and boolean readings, or ORs two keys.
 *  - Why existing coverage misses it: search.test.ts passes `where` to the keyword members and to hybrid search only;
 *    no case passes it to `searchVector`, so the Rust arm's refusal of it never ran.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput, SearchOpts, SearchResult } from '../../src/core/types.ts';
import { basisEmbedding, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** The query axis: every seeded page's vector has a share of it, so every page is a candidate. */
const AXIS = 100;

/** A unit vector with `cos` on the query axis and the rest on the page's own axis. */
function vectorAt(cos: number, own: number): Float32Array {
  const e = new Float32Array(1536);
  e[AXIS] = cos;
  e[own] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return e;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const view = (rows: SearchResult[]) => rows.map((r) => `${r.slug}:${round(r.score)}`);

/**
 * Seeds `notes/<name>` pages in order, the first with the highest cosine to the query axis, so a filter applied after
 * LIMIT would return the first pages and then drop them.
 */
async function seedRanked(engine: BrainEngine, pages: Array<[name: string, input: Partial<PageInput>]>): Promise<void> {
  for (const [i, [name, input]] of pages.entries()) {
    const text = `vector option page ${name}`;
    await seedPage(engine, {
      slug: `notes/${name}`,
      input: { type: 'note', title: name, compiled_truth: text, timeline: '', ...input },
      chunks: [chunk(0, text, { embedding: vectorAt(0.95 - i * 0.05, 200 + i) })],
    });
  }
}

async function search(engine: BrainEngine, opts: SearchOpts): Promise<string[]> {
  return view(await engine.searchVector(basisEmbedding(AXIS), { limit: 20, ...opts }));
}

describe('engine parity: searchVector page filters', () => {
  parityTest(
    'searchVector applies the frontmatter where filter before it ranks and limits',
    { methods: ['putPage', 'sealChunks', 'searchVector'] },
    async (engine) => {
      await seedRanked(engine, [
        ['plain', {}],
        ['draft', { frontmatter: { status: 'draft' } }],
        ['listed', { frontmatter: { status: ['active', 'review'] } }],
        ['active', { frontmatter: { status: 'active' } }],
        ['ranked', { frontmatter: { rank: 3, status: 'active' } }],
        ['pinned', { frontmatter: { pinned: true } }],
      ]);
      const out = {
        all: await search(engine, {}),
        empty: await search(engine, { where: {} }),
        active: await search(engine, { where: { status: ['active'] } }),
        activeFirst: await search(engine, { limit: 1, where: { status: ['active'] } }),
        activePaged: await search(engine, { limit: 1, offset: 1, where: { status: ['active'] } }),
        anyOf: await search(engine, { where: { status: ['draft', 'review'] } }),
        numeric: await search(engine, { where: { rank: ['3'] } }),
        boolean: await search(engine, { where: { pinned: ['true'] } }),
        bothKeys: await search(engine, { where: { status: ['active'], rank: ['3'] } }),
        noMatch: await search(engine, { where: { status: ['archived'] } }),
        typed: await search(engine, { type: 'note', where: { status: ['draft'] } }),
      };
      const slugs = (rows: string[]) => rows.map((r) => r.split(':')[0]);
      expect(out.all.length).toBe(6);
      expect(out.empty).toEqual(out.all);
      expect(slugs(out.active)).toEqual(['notes/listed', 'notes/active', 'notes/ranked']);
      expect(slugs(out.activeFirst)).toEqual(['notes/listed']);
      expect(slugs(out.activePaged)).toEqual(['notes/active']);
      expect(slugs(out.anyOf)).toEqual(['notes/draft', 'notes/listed']);
      expect(slugs(out.numeric)).toEqual(['notes/ranked']);
      expect(slugs(out.boolean)).toEqual(['notes/pinned']);
      expect(slugs(out.bothKeys)).toEqual(['notes/ranked']);
      expect(out.noMatch).toEqual([]);
      expect(slugs(out.typed)).toEqual(['notes/draft']);
      return out;
    },
  );
});
