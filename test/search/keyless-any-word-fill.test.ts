/**
 * GST-2762: keyless keyword search fills a short all-words result with
 * any-word matches, on PGLite here and on PostgreSQL when DATABASE_URL is set.
 *
 * Repro of a first-run miss: on a brain with no embedding provider,
 * "SSO Starter plan" matched the pricing and decisions pages (they hold every
 * word) and never reached the call transcript that holds two of the three.
 * The fill runs the keyword arm's own statement, so it applies the caller's
 * read policy exactly as the strict query does: restricted pages that repeat
 * the fill words (they would rank first among fill rows) surface for a local
 * caller and never for a remote one.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { chooseFill } from '../../src/core/ops/search.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch, _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { TargetTrace, diagnoseTrace } from '../../src/core/search/explain-target.ts';
import { keywordArmRows } from '../../src/core/search/keyword-identifier-probe.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const QUERY = 'SSO Starter plan';
/** The same engine with the any-word fill unavailable: search runs exactly as before GST-2762. */
const fillOff = (engine: BrainEngine): BrainEngine => new Proxy(engine, {
  get: (target, prop) => prop === 'searchKeyword'
    ? (q: string, o?: Record<string, unknown>) => target.searchKeyword(q, { ...o, orFill: false } as never)
    : Reflect.get(target, prop, target),
});
const CAROL = 'company/calls/carol-example';
const PAGES: Array<[string, string, string, Record<string, unknown>?, string?]> = [
  ['company/pricing', 'Pricing', 'Our Starter plan costs 29 dollars a month. The Pro plan adds SSO and audit logs. Every plan bills monthly.'],
  ['company/decisions', 'Decisions log', '2026-09-12: no free plan. We keep SSO on the Pro plan, not the Starter plan, because support load grows.'],
  [CAROL, 'Call with carol-example', 'carol-example asked whether SSO could come with Starter. Her team is twelve people and needs Okta.'],
  ['company/onboarding', 'Onboarding playbook', 'Send the welcome email, book the kickoff call and share the setup guide.'],
  ['company/starter-checklist', 'Starter checklist', 'Starter accounts get the checklist on day one.'],
  ['company/private-call', 'Private call', 'SSO SSO SSO Starter Starter Starter: the board call about acme-example.', { visibility: 'private' }],
  ['company/readers-call', 'Readers call', 'SSO SSO SSO Starter Starter Starter: the hiring call.', { readable_by: ['alice-example'] }],
  ['side/call', 'Side call', 'SSO SSO SSO Starter Starter Starter: a call in another source.', {}, 'side'],
];
const RESTRICTED = ['company/private-call', 'company/readers-call', 'side/call'];

for (const kind of testBackends()) {
  describe(`keyless any-word fill (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let ctx: OperationContext;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side') ON CONFLICT DO NOTHING`);
      for (const [slug, title, body, frontmatter = {}, sourceId = 'default'] of PAGES) {
        await engine.putPage(slug, { type: 'note', title, compiled_truth: body, frontmatter }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
      }
      ctx = { engine, remote: false, config: { engine: kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    }, 180_000);

    afterAll(async () => {
      await close?.();
      resetGateway();
    });

    test('a page holding most of the query words is found when other pages hold all of them', async () => {
      const rows = await operationsByName.query!.handler(ctx, { query: QUERY, expand: false }) as Array<{ slug: string }>;
      const slugs = rows.map(r => r.slug);
      expect(slugs).toContain(CAROL);
      for (const full of ['company/decisions', 'company/pricing']) expect(slugs.indexOf(full)).toBeLessThan(slugs.indexOf(CAROL));
      expect(slugs.indexOf('company/decisions')).toBeGreaterThan(-1);
      expect(slugs.indexOf('company/pricing')).toBeGreaterThan(-1);
    });

    test('the fill only adds pages, after every row search returns without it', async () => {
      const rows = await hybridSearch(engine, QUERY, { limit: 20, expansion: false });
      const firstFill = rows.findIndex(r => r.keyword_fill === true);
      expect(firstFill).toBeGreaterThan(0);
      expect(rows.slice(firstFill).every(r => r.keyword_fill === true)).toBe(true);
      expect(rows.slice(0, firstFill).map(r => r.slug)).toContain('company/starter-checklist');
    });

    test('a fill row is marked keyword_relaxed and ranks below every all-words row', async () => {
      const rows = await hybridSearch(engine, QUERY, { limit: 10, expansion: false });
      const firstFill = rows.findIndex(r => r.keyword_fill === true);
      const before = rows.slice(0, firstFill);
      expect(before.map(r => r.slug)).toEqual(expect.arrayContaining(['company/decisions', 'company/pricing']));
      expect(before.filter(r => r.slug !== 'company/starter-checklist').every(r => r.keyword_relaxed === undefined)).toBe(true);
      const fill = rows.slice(firstFill);
      expect(fill.map(r => r.slug)).toContain(CAROL);
      expect(fill.every(r => r.keyword_relaxed === true && r.score < Math.min(...before.map(b => b.score)))).toBe(true);
    });

    test('explain_target names the fill: the arm rank is marked relaxed and the why says some words matched', async () => {
      const trace = new TargetTrace({ slug: CAROL });
      const rows = await hybridSearch(engine, QUERY, { limit: 10, expansion: false, explainTarget: trace });
      const d = diagnoseTrace(trace, rows, { tool: 'query', arguments: { query: QUERY } });
      expect(d.state).toBe('retrieved');
      expect(d.arms.find(a => a.arm === 'keyword_fill')?.relaxed).toBe(true);
      expect(d.why).toContain('matched only some of the query');
    });

    test('the fill applies the caller read policy: restricted pages fill for a local caller, never for a remote one', async () => {
      const local = (await hybridSearch(engine, QUERY, { limit: 20, expansion: false })).map(r => r.slug);
      for (const slug of RESTRICTED) expect(local).toContain(slug);
      const remote = await hybridSearch(engine, QUERY, { limit: 20, expansion: false, excludePrivate: true, requireSafeChunks: true, sourceIds: ['default'] });
      expect(remote.map(r => r.slug)).toContain(CAROL);
      for (const slug of RESTRICTED) expect(remote.map(r => r.slug)).not.toContain(slug);
    });

    test('a fill row never pushes an all-words page out through the type-diversity cap', async () => {
      for (let i = 1; i <= 5; i++) {
        const body = `Quokka workshop notes, part ${i}: agenda and follow-ups.`;
        await engine.putPage(`notes/quokka-${i}`, { type: 'note', title: `Quokka ${i}`, compiled_truth: body, frontmatter: {} });
        await installFixtureChunks(engine, `notes/quokka-${i}`, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
      }
      const partial = 'Quokka Inc. is a company in the directory.';
      await engine.putPage('companies/quokka', { type: 'company', title: 'Directory entry', compiled_truth: partial, frontmatter: {} });
      await installFixtureChunks(engine, 'companies/quokka', [{ chunk_index: 0, chunk_text: partial, chunk_source: 'compiled_truth' }]);
      const rows = await hybridSearch(engine, 'quokka workshop', { limit: 10, expansion: false });
      const notes = rows.filter(r => !r.keyword_fill).map(r => r.slug).sort();
      expect(notes).toEqual(['notes/quokka-1', 'notes/quokka-2', 'notes/quokka-3', 'notes/quokka-4', 'notes/quokka-5']);
      expect(rows.map(r => r.slug)).toContain('companies/quokka');
    });

    test('a dated fill row stays below the all-words rows when the query asks when', async () => {
      const dated = 'Quokka offsite on 2026-03-02.';
      await engine.putPage('events/quokka-offsite', { type: 'event', title: 'Offsite', compiled_truth: dated, frontmatter: {} });
      await installFixtureChunks(engine, 'events/quokka-offsite', [{ chunk_index: 0, chunk_text: dated, chunk_source: 'compiled_truth' }]);
      await engine.executeRaw(`UPDATE pages SET effective_date = '2026-03-02', effective_date_source = 'frontmatter' WHERE slug = 'events/quokka-offsite'`);
      const rows = await hybridSearch(engine, 'when quokka workshop', { limit: 20, expansion: false });
      const firstFill = rows.findIndex(r => r.keyword_fill === true);
      expect(firstFill).toBeGreaterThan(0);
      expect(rows.slice(firstFill).every(r => r.keyword_fill === true)).toBe(true);
      expect(rows.map(r => r.slug).indexOf('events/quokka-offsite')).toBeGreaterThanOrEqual(firstFill);
    });

    test('a redirect stub that only fills is replaced by its target, as in an ordinary result', async () => {
      const put = async (slug: string, type: string, body: string, frontmatter: Record<string, unknown> = {}) => {
        await engine.putPage(slug, { type, title: 'Record', compiled_truth: body, frontmatter });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
      };
      await put('notes/heron-audit', 'note', 'Heron ledger audit for the spring count.');
      await put('records/heron-old', 'concept-redirect', 'Heron ledger moved. See [current](/records/heron-current).', { redirect_to: '/records/heron-current' });
      await put('records/heron-current', 'concept', 'The marsh registry for this year.');
      const rows = await hybridSearch(engine, 'heron ledger audit', { limit: 10, expansion: false });
      const slugs = rows.map(r => r.slug);
      expect(slugs[0]).toBe('notes/heron-audit');
      expect(slugs).not.toContain('records/heron-old');
      expect(rows.find(r => r.slug === 'records/heron-current')?.keyword_fill).toBe(true);
    });

    test('a superseded page that only fills carries its superseded warning', async () => {
      const put = async (slug: string, body: string) => {
        await engine.putPage(slug, { type: 'note', title: 'Record', compiled_truth: body, frontmatter: {} });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
      };
      await put('notes/egret-review', 'Egret roster review notes.');
      await put('records/egret-old', 'Egret roster from the old survey.');
      await put('records/egret-new', 'The colony count from the new survey.');
      await engine.addLink('records/egret-new', 'records/egret-old', '', 'supersedes', 'manual');
      _resetSupersedeProbeForTests();
      const rows = await hybridSearch(engine, 'egret roster review', { limit: 10, expansion: false });
      const old = rows.find(r => r.slug === 'records/egret-old');
      expect(old?.keyword_fill).toBe(true);
      expect(old?.superseded).toBe(true);
      expect(old?.superseded_by).toBe('records/egret-new');
    });

    describe('a declared alias beats the fill', () => {
      beforeAll(async () => {
        const target = 'Light falls through the glass roof onto the stage.';
        await engine.putPage('projects/atrium', { type: 'project', title: 'Atrium', compiled_truth: target, frontmatter: {} });
        await installFixtureChunks(engine, 'projects/atrium', [{ chunk_index: 0, chunk_text: target, chunk_source: 'compiled_truth' }]);
        await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'hall of light', 'projects/atrium') ON CONFLICT DO NOTHING`);
        const other = 'Concert notes from the hall: the light show ran late.';
        await engine.putPage('notes/concert', { type: 'note', title: 'Concert', compiled_truth: other, frontmatter: {} });
        await installFixtureChunks(engine, 'notes/concert', [{ chunk_index: 0, chunk_text: other, chunk_source: 'compiled_truth' }]);
      });

      test('the alias target leads at limit 1', async () => {
        const rows = await hybridSearch(engine, 'hall of light', { limit: 1, expansion: false });
        expect(rows.map(r => r.slug)).toEqual(['projects/atrium']);
      });

      test('the alias target, which also qualifies as a fill row, appears once, first, at the default limit', async () => {
        const kw = await engine.searchKeyword('hall of light', { limit: 50, orFallback: true, orFill: true });
        expect(kw.find(r => r.slug === 'projects/atrium')?.keyword_fill).toBe(true);
        const slugs = (await hybridSearch(engine, 'hall of light', { expansion: false })).map(r => r.slug);
        expect(slugs[0]).toBe('projects/atrium');
        expect(slugs.filter(s => s === 'projects/atrium')).toHaveLength(1);
        expect(slugs).toContain('notes/concert');
      });
    });

    test('a fill page never changes the boosts of the rows above it', async () => {
      for (const [slug, body] of [['notes/first', 'Zebra parade route along the river.'], ['notes/second', 'Zebra parade route through the old town.']]) {
        await engine.putPage(slug, { type: 'note', title: slug === 'notes/first' ? 'First' : 'Second', compiled_truth: body, frontmatter: {} });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
      }
      for (const fan of ['notes/fan-1', 'notes/fan-2']) {
        const body = 'A zebra drawing for the fan club.';
        await engine.putPage(fan, { type: 'note', title: 'Fan', compiled_truth: body, frontmatter: {} });
        await installFixtureChunks(engine, fan, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
        await engine.addLink(fan, 'notes/second');
      }
      const on = await hybridSearch(engine, 'zebra parade route', { limit: 1, expansion: false });
      const off = await hybridSearch(fillOff(engine), 'zebra parade route', { limit: 1, expansion: false });
      expect(on.map(r => [r.slug, r.score])).toEqual(off.map(r => [r.slug, r.score]));
    });

    test('a fill page in the same document family as a returned page is folded away, never listed beside it', async () => {
      const plan = 'Walrus budget review: the walrus team reviewed the budget for spring and summer.';
      const summary = 'Walrus team budget for spring and summer.';
      await engine.putPage('docs/walrus-plan', { type: 'note', title: 'Walrus plan', compiled_truth: plan, frontmatter: {} });
      await installFixtureChunks(engine, 'docs/walrus-plan', [{ chunk_index: 0, chunk_text: plan, chunk_source: 'compiled_truth' }]);
      await engine.putPage('docs/walrus-plan-summary', { type: 'note', title: 'Walrus plan summary', compiled_truth: summary, frontmatter: {} });
      await installFixtureChunks(engine, 'docs/walrus-plan-summary', [{ chunk_index: 0, chunk_text: summary, chunk_source: 'compiled_truth' }]);
      const kw = await engine.searchKeyword('walrus budget review', { limit: 50, orFallback: true, orFill: true });
      expect(kw.find(r => r.slug === 'docs/walrus-plan-summary')?.keyword_fill).toBe(true);
      const slugs = (await hybridSearch(engine, 'walrus budget review', { expansion: false })).map(r => r.slug);
      expect(slugs).toContain('docs/walrus-plan');
      expect(slugs).not.toContain('docs/walrus-plan-summary');
    });

    test('a later page (offset above zero) gets no fill', async () => {
      const on = await hybridSearch(engine, QUERY, { limit: 1, offset: 1, expansion: false });
      expect(on.some(r => r.keyword_fill)).toBe(false);
      const off = await hybridSearch(fillOff(engine), QUERY, { limit: 1, offset: 1, expansion: false });
      expect(on.map(r => [r.slug, r.score])).toEqual(off.map(r => [r.slug, r.score]));
    });

    test('the fill never exceeds the limit and never repeats a page', async () => {
      for (const limit of [1, 2, 3, 5, 8]) {
        const rows = await hybridSearch(engine, QUERY, { limit, expansion: false });
        expect(rows.length).toBeLessThanOrEqual(limit);
        const pages = rows.map(r => `${r.source_id ?? 'default'}:${r.slug}`);
        expect(new Set(pages).size).toBe(pages.length);
      }
    });

    test('property: with the fill on, the rows begin with exactly the rows returned with it off (order and scores)', async () => {
      setSystemTime(new Date('2026-11-15T00:00:00Z'));
      const queries = [QUERY, 'sso', 'starter plan', 'starter checklist day one', 'quokka workshop', 'when quokka workshop', 'hall of light', 'zebra parade route', 'walrus budget review', 'pricing plan bills monthly', 'nothing matches this xylophone'];
      for (const query of queries) {
        for (const limit of [1, 3, 10, 20]) {
          const on = await hybridSearch(engine, query, { limit, expansion: false });
          const off = await hybridSearch(fillOff(engine), query, { limit, expansion: false });
          const row = (r: SearchResult) => [r.source_id ?? 'default', r.slug, r.chunk_id, r.score];
          expect(on.slice(0, off.length).map(row)).toEqual(off.map(row));
          expect(on.slice(off.length).every(r => r.keyword_fill === true)).toBe(true);
          if (off.length >= limit) expect(on.length).toBe(off.length);
        }
      }
      setSystemTime();
    });

    describe('the search and query operations', () => {
      const run = async (op: 'search' | 'query', on: boolean, params: Record<string, unknown>) =>
        [...await operationsByName[op]!.handler(on ? ctx : { ...ctx, engine: fillOff(engine) }, { ...params, ...(op === 'query' ? { expand: false } : {}) }) as SearchResult[]];

      beforeAll(async () => {
        const pages: Array<[string, string, string, string]> = [
          ['people/dana-example', 'person', 'Dana Example', 'Dana Example leads the harbor team.'],
          ['notes/budget-memo', 'note', 'Budget memo', 'Dana Example wrote the budget memo for the harbor team.'],
          ['notes/lantern-memo', 'note', 'Travel', 'The lantern lead sent a memo about travel.'],
          ['notes/budget-approval', 'note', 'Approval', 'The budget was approved in March.'],
        ];
        for (const [slug, type, title, body] of pages) {
          await engine.putPage(slug, { type, title, compiled_truth: body, frontmatter: {} } as never);
          await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
        }
        await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'lantern lead', 'people/dana-example') ON CONFLICT DO NOTHING`);
      });

      test('a page the alias fan-out returns comes back exactly as it does without the fill, never as a fill row', async () => {
        const params = { query: 'Dana Example budget memo', limit: 10 };
        const kw = await engine.searchKeyword(params.query, { limit: 50, orFallback: true, orFill: true });
        expect(kw.find(r => r.slug === 'notes/lantern-memo')?.keyword_fill).toBe(true);
        for (const op of ['search', 'query'] as const) {
          const off = await run(op, false, params);
          const on = await run(op, true, params);
          const alias = off.find(r => r.slug === 'notes/lantern-memo');
          expect(alias?.matched_alias).toBe('lantern lead');
          expect(on.slice(0, off.length)).toEqual(off);
          expect(on.filter(r => r.slug === 'notes/lantern-memo')).toEqual([alias!]);
        }
      });

      test('the rest of the fill still comes back, after every other row, when the alias fan-out already returns one of its pages', async () => {
        const params = { query: 'Dana Example budget memo', limit: 10 };
        const kw = await engine.searchKeyword(params.query, { limit: 50, orFallback: true, orFill: true });
        expect(kw.filter(r => r.keyword_fill).map(r => r.slug)).toEqual(expect.arrayContaining(['notes/lantern-memo', 'notes/budget-approval']));
        for (const op of ['search', 'query'] as const) {
          const off = await run(op, false, params);
          const on = await run(op, true, params);
          expect(off.find(r => r.slug === 'notes/lantern-memo')?.matched_alias).toBe('lantern lead');
          expect(on.slice(0, off.length)).toEqual(off);
          expect(on.length).toBeGreaterThan(off.length);
          expect(on.slice(off.length).every(r => r.keyword_fill === true)).toBe(true);
          expect(new Set(on.map(r => r.slug)).size).toBe(on.length);
        }
      });

      test('property: every row returned without the fill comes back unchanged, in the same order, and every other row is marked keyword_fill', async () => {
        setSystemTime(new Date('2026-11-15T00:00:00Z'));
        const queries = [QUERY, 'sso', 'starter plan', 'starter checklist day one', 'quokka workshop', 'hall of light', 'zebra parade route', 'walrus budget review', 'Dana Example budget memo', 'pricing plan bills monthly', 'nothing matches this xylophone'];
        let filled = 0;
        for (const op of ['search', 'query'] as const) {
          for (const query of queries) {
            for (const limit of [1, 3, 10]) {
              const off = await run(op, false, { query, limit });
              const on = await run(op, true, { query, limit });
              expect(on.slice(0, off.length)).toEqual(off);
              expect(on.slice(off.length).every(r => r.keyword_fill === true)).toBe(true);
              expect(on.length).toBeLessThanOrEqual(Math.max(limit, off.length));
              expect(new Set(on.map(r => (r.source_id ?? 'default') + ' ' + r.slug)).size).toBe(on.length);
              filled += on.length - off.length;
            }
          }
        }
        expect(filled).toBeGreaterThan(0);
        setSystemTime();
      });
    });

    test('a keyword-only retrieval the caller asked for (decide.keywordOnly, used on brains with embeddings too) gets no fill', async () => {
      const rows = await hybridSearch(engine, QUERY, { limit: 20, expansion: false, decide: { keywordOnly: true } } as never);
      expect(rows.some(r => r.keyword_fill)).toBe(false);
      expect(rows.map(r => r.slug)).not.toContain(CAROL);
    });

    test('without orFill the keyword arm keeps its strict rows only (the path brains with embeddings take)', async () => {
      const rows = await engine.searchKeyword(QUERY, { limit: 50, orFallback: true });
      expect(rows.map(r => r.slug).sort()).toEqual(['company/decisions', 'company/pricing']);
      expect(rows.some(r => r.keyword_relaxed)).toBe(false);
    });
  });
}

test('a failed any-word fill keeps the all-words rows and reports the keyword arm incomplete', async () => {
  const reasons: string[] = [];
  const row = { page_id: 1, slug: 'company/pricing', score: 0.5 } as never;
  const rows = await keywordArmRows<never>({
    query: 'sso starter plan', strict: [row], orFallback: true, orFill: true, limit: 10, offset: 0, toResult: r => r,
    runProbe: async () => [],
    runRelaxed: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
    onIncomplete: reason => reasons.push(reason),
  });
  expect(rows.map(r => r.slug)).toEqual(['company/pricing']);
  expect(reasons).toEqual(['timeout']);
});

describe('chooseFill: the fill is returned only when it leaves every other row as it was', () => {
  const row = (slug: string, extra: Partial<SearchResult> = {}) => ({ slug, score: 1, chunk_text: slug, ...extra }) as SearchResult;
  const fill = row('fill', { keyword_fill: true });
  const reference = { results: [row('a'), row('b')] };
  const compared = (t: { results: SearchResult[] }) => t.results;
  const deliver = async (rows: SearchResult[]) => ({ rows });

  test('no fill rows: the reference is returned and no stage runs twice', async () => {
    let reruns = 0;
    const page = await chooseFill(reference.results, reference, 10, async () => { reruns++; return reference; }, compared, deliver);
    expect(page).toBe(reference);
    expect(reruns).toBe(0);
  });

  test('the fill is returned, with its delivery, when every other row is unchanged', async () => {
    const page = await chooseFill([...reference.results, fill], reference, 10, async hits => ({ results: hits }), compared, deliver);
    expect(page.results.map(r => r.slug)).toEqual(['a', 'b', 'fill']);
    expect(page.delivered?.rows.map(r => r.slug)).toEqual(['a', 'b', 'fill']);
  });

  test('a stage that drops, moves or rewrites another row when the fill is present: the fill is withheld', async () => {
    for (const changed of [[row('a'), fill], [row('b'), row('a'), fill], [row('a'), row('b', { score: 0.5 }), fill], [row('a'), row('b'), row('c'), fill]]) {
      const page = await chooseFill([...reference.results, fill], reference, 10, async () => ({ results: changed }), compared, deliver);
      expect(page).toBe(reference);
    }
  });

  test('a delivery that shortens or drops another row when the fill is present: the reference and its own delivery are returned', async () => {
    const squeezed = async (rows: SearchResult[]) => ({ rows: rows.some(r => r.keyword_fill) ? rows.filter(r => r.slug !== 'b') : rows });
    const page = await chooseFill([...reference.results, fill], reference, 10, async hits => ({ results: hits }), compared, squeezed);
    expect(page.results).toBe(reference.results);
    expect(page.delivered?.rows.map(r => r.slug)).toEqual(['a', 'b']);
  });

  test('a fill row for a page another stage already returns is left out before the stages run again; the rest of the fill is returned last', async () => {
    const other = row('other', { keyword_fill: true });
    const seen: string[][] = [];
    const stages = async (hits: SearchResult[]) => { seen.push(hits.map(r => r.slug)); return { results: [...hits, reference.results[1]!] }; };
    const page = await chooseFill([row('a'), row('b', { keyword_fill: true }), other], reference, 10, stages, compared, deliver);
    expect(seen).toEqual([['a', 'other']]);
    expect(page.results.map(r => r.slug)).toEqual(['a', 'b', 'other']);
    expect(page.results[1]).toBe(reference.results[1]!);
  });

  test('the fill never takes the page past the limit, and nothing runs again when no room is left', async () => {
    const more = [fill, row('fill-2', { keyword_fill: true }), row('fill-3', { keyword_fill: true })];
    const page = await chooseFill([...reference.results, ...more], reference, 3, async hits => ({ results: hits }), compared, deliver);
    expect(page.results.map(r => r.slug)).toEqual(['a', 'b', 'fill']);
    let reruns = 0;
    expect(await chooseFill([...reference.results, ...more], reference, 2, async hits => { reruns++; return { results: hits }; }, compared, deliver)).toBe(reference);
    expect(reruns).toBe(0);
  });

  test('anything else the operation reports from its stages must match too', async () => {
    const page = await chooseFill([...reference.results, fill], { ...reference, fanout: 1 }, 10, async hits => ({ results: hits, fanout: 2 }), t => [t.results, t.fanout], deliver);
    expect(page.results).toBe(reference.results);
  });
});
