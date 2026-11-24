/**
 * BrainEngine parity: keyword search reads a non-ASCII space in the query as PGLite does.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `searchKeyword` builds its query with `websearch_to_tsquery`. On PGLite (the engine a
 *    Rust brain replaces) a query word pair split by a Unicode space of the `[[:space:]]` class
 *    (U+2000-U+200A except U+2007, U+2028, U+2029, U+205F, U+3000, U+0085) is two words joined by AND;
 *    every engine must find the same pages for such a query.
 *  - Regression: an engine that keeps those characters inside one word turns the query into a
 *    phrase, so a page holding both words apart is no longer found (a user typing an ideographic
 *    space between two words loses results).
 *  - Why existing coverage misses it: the keyword goldens (rust/crates/gbrain-store/tests/fixtures/
 *    tsearch.json) hold no such character, and the search parity files use ASCII queries.
 *  - Seam: none. Real engines, typed members only.
 *
 * A Postgres host reads `[[:space:]]` with its own locale: a glibc or ICU host differs from PGLite on
 * U+0085 and U+1680, and PostgreSQL 18 reads only ASCII whitespace here. The arms compare only the
 * code points on which the Postgres arm parses the query as PGLite does; every arm but Postgres (so
 * PGLite and Rust) must also give PGLite's answer, written below, for every code point. A code point
 * the Postgres host reads differently is printed as a named host difference, never hidden on Rust.
 */
import { beforeAll, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const suite = parityArms(testBackends());
const { parityTest } = suite;

/** PGLite's `[[:space:]]` outside ASCII, plus characters that look like spaces but are not in it. */
const CODE_POINTS = [
  0x85, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000, 0x1680, 0x2007, 0xa0, 0x202f, 0x200b, 0xfeff,
];
/** PGLite's answer per code point (the pages `dogs<cp>cats` finds): a separator gives AND, anything else a phrase or one word. */
const BOTH = 'notes/adjacent,notes/apart';
const PGLITE_ANSWER: Record<number, string> = {
  0x85: BOTH, 0x2000: BOTH, 0x2001: BOTH, 0x2002: BOTH, 0x2003: BOTH, 0x2004: BOTH, 0x2005: BOTH, 0x2006: BOTH,
  0x2008: BOTH, 0x2009: BOTH, 0x200a: BOTH, 0x2028: BOTH, 0x2029: BOTH, 0x205f: BOTH, 0x3000: BOTH,
  0x1680: 'notes/adjacent', 0x2007: 'notes/adjacent', 0xa0: 'notes/adjacent', 0x202f: 'notes/adjacent',
  0x200b: '', 0xfeff: '',
};
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const probe = (cp: number) => `dogs${String.fromCodePoint(cp)}cats`;

/**
 * PGLite's `websearch_to_tsquery('english', probe(cp))::text`, pinned so the Postgres arm can be calibrated on its own
 * (a Postgres-only run, `GBRAIN_TEST_BACKEND=postgres`, has no PGLite arm to compare with). A run that has the PGLite
 * arm checks these pins against it first.
 */
const AND_QUERY = "'dog' & 'cat'";
const PHRASE_QUERY = "'dog' <-> 'cat'";
const PGLITE_QUERY = (cp: number): string => {
  if (PGLITE_ANSWER[cp] === BOTH) return AND_QUERY;
  if (PGLITE_ANSWER[cp] === 'notes/adjacent') return PHRASE_QUERY;
  return `'dogs${String.fromCodePoint(cp)}cat'`;
};

/** Code points whose query the Postgres arm parses differently from PGLite (host locale). */
let hostDifferences = new Set<number>();

beforeAll(async () => {
  const parse = async (engine: BrainEngine) => {
    const out = new Map<number, string>();
    for (const cp of CODE_POINTS) {
      const [row] = await engine.executeRaw<{ q: string }>(`SELECT websearch_to_tsquery('english', $1)::text AS q`, [probe(cp)]);
      out.set(cp, row!.q);
    }
    return out;
  };
  const pglite = suite.arms().find((arm) => arm.backend === 'pglite');
  if (pglite) {
    const read = await parse(pglite.engine);
    for (const cp of CODE_POINTS) expect({ code_point: hex(cp), query: read.get(cp) }).toEqual({ code_point: hex(cp), query: PGLITE_QUERY(cp) });
  }
  const pg = suite.arms().find((arm) => arm.backend === 'postgres');
  if (!pg) return;
  const read = await parse(pg.engine);
  hostDifferences = new Set(CODE_POINTS.filter((cp) => read.get(cp) !== PGLITE_QUERY(cp)));
}, 120_000);

parityTest(
  'a query split by a non-ASCII space finds the same pages on every engine',
  { methods: ['searchKeyword'] },
  async (engine, backend) => {
    await seedPage(engine, {
      slug: 'notes/apart',
      input: { type: 'note', title: 'Apart', compiled_truth: 'the cats slept while the dogs barked', timeline: '' },
      chunks: [chunk(0, 'the cats slept while the dogs barked')],
    });
    await seedPage(engine, {
      slug: 'notes/adjacent',
      input: { type: 'note', title: 'Adjacent', compiled_truth: 'many dogs cats and birds', timeline: '' },
      chunks: [chunk(0, 'many dogs cats and birds')],
    });
    const found: string[] = [];
    for (const cp of CODE_POINTS) {
      const slugs = (await engine.searchKeyword(probe(cp), { limit: 10 })).map((r) => r.slug).sort().join(',');
      if (backend === 'postgres' && hostDifferences.has(cp)) {
        console.log(`[host difference] ${hex(cp)}: this Postgres host's websearch_to_tsquery reads it unlike PGLite; its search found "${slugs}", PGLite "${PGLITE_ANSWER[cp]}"`);
        continue;
      }
      expect({ backend, code_point: hex(cp), slugs }).toEqual({ backend, code_point: hex(cp), slugs: PGLITE_ANSWER[cp]! });
      if (!hostDifferences.has(cp)) found.push(`${hex(cp)} ${slugs}`);
    }
    // Not vacuous: an ASCII space finds both pages, and U+3000 (a separator on PGLite) is compared unless the Postgres host
    // reads it differently (then it is a named host difference, and PGLite and Rust still gave PGLite's answer above).
    const space = (await engine.searchKeyword('dogs cats', { limit: 10 })).map((r) => r.slug).sort();
    expect(space).toEqual(['notes/adjacent', 'notes/apart']);
    expect(hostDifferences.has(0x3000) || found.some((line) => line.startsWith('U+3000 '))).toBe(true);
    return found;
  },
);
