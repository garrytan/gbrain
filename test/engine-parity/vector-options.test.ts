/**
 * BrainEngine parity — the page filters `searchVector` takes beside type, slug and source scope: the frontmatter
 * `where` filter, the `afterDate` / `beforeDate` bounds, the trust floor (`minTrust`) and the flagged-page filter
 * (`suppressFlagged`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `searchVector` drops the pages a filter rejects inside its candidate scan, before it ranks and before
 *    LIMIT (`buildVectorSearchStatement`, search/vector-statement.ts): `where` keeps a page whose top-level frontmatter
 *    field equals one of a key's values or is a list holding one, with a numeric or boolean reading of a string value
 *    (`frontmatterWhereClauses`). A date bound compares the page's `effective_date`, else its `updated_at`, with the
 *    bound read as `timestamptz`, strictly unless its `*Inclusive` flag is set. Under `minTrust` it drops the pages
 *    whose stamped trust tier ranks below the floor, and under `suppressFlagged` the pages at or below `agent_written`
 *    with a flag receipt in an activation reason family (`pageEligibleSql`, applied by `buildVisibilityClause` in the
 *    inner CTE). Every engine arm returns the same rows and scores.
 *  - Regression: an engine that refuses the option, ignores it, applies it after LIMIT (a limited read comes back
 *    short), misses list containment or the numeric and boolean readings, ORs two keys, compares a bound off by its
 *    inclusive flag or its zone, or drops an undated page instead of reading its `updated_at`; one that ignores the
 *    trust floor, reads an empty floor as a tier, or applies the floor after LIMIT; one that ignores the flag, reads a
 *    flag receipt outside the activation families, or suppresses a flagged page above `agent_written`.
 *  - Why existing coverage misses it: search.test.ts passes `where` and the date bounds to the keyword members and to
 *    hybrid search only, and keyword-visibility.test.ts passes the trust options to the keyword members only; no case
 *    passes them to `searchVector`, so the Rust arm's refusal of them never ran.
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

/** One page per trust case: [name, declared tier (none: the default), flag receipt reason families]. */
const TRUSTED: Array<[name: string, tier: string | null, flag: string[] | null]> = [
  ['curated', 'operator_curated', null],
  ['curated-flagged', 'operator_curated', ['override']],
  ['observed', 'tool_observed', null],
  ['agent', 'agent_written', null],
  ['agent-flagged', 'agent_written', ['override']],
  ['agent-other-flag', 'agent_written', ['other']],
  ['unknown-flagged', null, ['credential']],
  ['outside', 'external_untrusted', null],
];

/** Writes each `TRUSTED` page under its tier, the less trusted pages nearer the query, so a filter must run before LIMIT. */
async function trustFixture(engine: BrainEngine): Promise<void> {
  for (const [i, [name, tier, flag]] of TRUSTED.entries()) {
    const slug = `notes/${name}`;
    const text = `vector trust page ${name}`;
    const write = (e: BrainEngine) => seedPage(e, {
      slug,
      input: { type: 'note', title: name, compiled_truth: text, timeline: '' },
      chunks: [chunk(0, text, { embedding: vectorAt(0.5 + i * 0.05, 200 + i) })],
    });
    if (tier) {
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
        await write(tx);
      });
    } else {
      await write(engine);
    }
    if (flag) {
      await engine.upsertPageWriteGateReceipt('default', slug, {
        content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: flag,
        reasons: flag, detector_error: false, request_id: null,
      });
    }
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

  parityTest(
    'searchVector applies the date bounds before it ranks and limits',
    { methods: ['putPage', 'sealChunks', 'searchVector'] },
    async (engine) => {
      const on = (iso: string): Partial<PageInput> => ({ effective_date: new Date(iso), effective_date_source: 'date' });
      // `undated` has no effective date, so its `updated_at` (the seed time) dates it.
      await seedRanked(engine, [
        ['late', on('2026-05-10T12:00:00Z')],
        ['undated', {}],
        ['edge', on('2026-02-01T00:00:00Z')],
        ['early', on('2026-01-15T00:00:00.123Z')],
        ['old', on('2019-07-04T00:00:00Z')],
      ]);
      const out = {
        all: await search(engine, {}),
        after: await search(engine, { afterDate: '2026-02-01' }),
        afterInclusive: await search(engine, { afterDate: '2026-02-01', afterDateInclusive: true }),
        afterZoned: await search(engine, { afterDate: '2026-02-01T08:00:00+08:00', afterDateInclusive: true }),
        afterFirst: await search(engine, { limit: 1, afterDate: '2026-02-01', afterDateInclusive: true, exclude_slugs: ['notes/late', 'notes/undated'] }),
        before: await search(engine, { beforeDate: '2026-02-01' }),
        beforeInclusive: await search(engine, { beforeDate: '2026-02-01', beforeDateInclusive: true }),
        beforeFraction: await search(engine, { beforeDate: '2026-01-15T00:00:00.123Z', beforeDateInclusive: true }),
        beforeFractionStrict: await search(engine, { beforeDate: '2026-01-15T00:00:00.123Z' }),
        window: await search(engine, { afterDate: '2020-01-01', beforeDate: '2026-03-01' }),
        windowPaged: await search(engine, { limit: 1, offset: 1, afterDate: '2020-01-01', beforeDate: '2026-03-01' }),
        undatedAfter: await search(engine, { afterDate: '2000-01-01', types: ['note'], where: {} }),
        undatedBefore: await search(engine, { beforeDate: '2000-01-01' }),
        inclusiveAlone: await search(engine, { afterDateInclusive: true, beforeDateInclusive: true }),
      };
      const slugs = (rows: string[]) => rows.map((r) => r.split(':')[0]);
      expect(out.all.length).toBe(5);
      expect(slugs(out.after)).toEqual(['notes/late', 'notes/undated']);
      expect(slugs(out.afterInclusive)).toEqual(['notes/late', 'notes/undated', 'notes/edge']);
      expect(out.afterZoned).toEqual(out.afterInclusive);
      expect(slugs(out.afterFirst)).toEqual(['notes/edge']);
      expect(slugs(out.before)).toEqual(['notes/early', 'notes/old']);
      expect(slugs(out.beforeInclusive)).toEqual(['notes/edge', 'notes/early', 'notes/old']);
      expect(slugs(out.beforeFraction)).toEqual(['notes/early', 'notes/old']);
      expect(slugs(out.beforeFractionStrict)).toEqual(['notes/old']);
      expect(slugs(out.window)).toEqual(['notes/edge', 'notes/early']);
      expect(slugs(out.windowPaged)).toEqual(['notes/early']);
      expect(out.undatedAfter).toEqual(out.all);
      expect(out.undatedBefore).toEqual([]);
      expect(out.inclusiveAlone).toEqual(out.all);
      return out;
    },
  );

  parityTest(
    'searchVector drops pages below the trust floor before it ranks and limits',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt',
      'searchVector'] },
    async (engine) => {
      await trustFixture(engine);
      const scopes: Record<string, SearchOpts> = {
        none: {},
        emptyFloor: { minTrust: '' as never },
        curated: { minTrust: 'operator_curated' },
        observed: { minTrust: 'tool_observed' },
        agent: { minTrust: 'agent_written' },
        any: { minTrust: 'external_untrusted' },
      };
      const out: Record<string, { top: string[]; all: string[] }> = {};
      for (const [name, scope] of Object.entries(scopes)) {
        out[name] = { top: await search(engine, { limit: 2, ...scope }), all: await search(engine, scope) };
      }
      const slugs = (name: string) => out[name]!.all.map((r) => r.split(':')[0]!).sort();
      expect(out.none!.all.length).toBe(TRUSTED.length);
      expect(out.emptyFloor).toEqual(out.none);
      expect(out.any).toEqual(out.none);
      expect(slugs('curated')).toEqual(['notes/curated', 'notes/curated-flagged']);
      expect(slugs('agent')).toEqual(['notes/agent', 'notes/agent-flagged', 'notes/agent-other-flag', 'notes/curated',
        'notes/curated-flagged', 'notes/observed']);
      expect(out.curated!.top.map((r) => r.split(':')[0])).toEqual(['notes/curated-flagged', 'notes/curated']);
      return out;
    },
  );

  parityTest(
    'searchVector drops flagged pages before it ranks and limits',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt',
      'searchVector'] },
    async (engine) => {
      await trustFixture(engine);
      const scopes: Record<string, SearchOpts> = {
        none: {},
        suppressed: { suppressFlagged: true },
        agentSuppressed: { minTrust: 'agent_written', suppressFlagged: true },
      };
      const out: Record<string, { top: string[]; all: string[] }> = {};
      for (const [name, scope] of Object.entries(scopes)) {
        out[name] = { top: await search(engine, { limit: 2, ...scope }), all: await search(engine, scope) };
      }
      const slugs = (name: string) => out[name]!.all.map((r) => r.split(':')[0]!).sort();
      expect(out.none!.all.length).toBe(TRUSTED.length);
      // A flag outside the activation families, or on a page above agent_written, suppresses nothing.
      expect(slugs('suppressed')).toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/curated-flagged',
        'notes/observed', 'notes/outside']);
      expect(slugs('agentSuppressed')).toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated',
        'notes/curated-flagged', 'notes/observed']);
      expect(out.suppressed!.top.map((r) => r.split(':')[0])).toEqual(['notes/outside', 'notes/agent-other-flag']);
      return out;
    },
  );
});
