/**
 * GST-2735: keyless keyword search fills a short all-words result with
 * any-word matches, on PGLite here and on PostgreSQL when DATABASE_URL is set.
 *
 * Repro of the GBRA-524 first-run miss: on a brain with no embedding provider,
 * "SSO Starter plan" matched the pricing and decisions pages (they hold every
 * word) and never reached the call transcript that holds two of the three.
 * The fill runs the keyword arm's own statement, so it applies the caller's
 * read policy exactly as the strict query does: restricted pages that repeat
 * the fill words (they would rank first among fill rows) surface for a local
 * caller and never for a remote one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { TargetTrace, diagnoseTrace } from '../../src/core/search/explain-target.ts';
import { keywordArmRows } from '../../src/core/search/keyword-identifier-probe.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const QUERY = 'SSO Starter plan';
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
      expect(d.arms.find(a => a.arm === 'keyword')?.relaxed).toBe(true);
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
      await engine.putPage('events/quokka-offsite', { type: 'note', title: 'Offsite', compiled_truth: dated, frontmatter: {} });
      await installFixtureChunks(engine, 'events/quokka-offsite', [{ chunk_index: 0, chunk_text: dated, chunk_source: 'compiled_truth' }]);
      await engine.executeRaw(`UPDATE pages SET effective_date = '2026-03-02', effective_date_source = 'frontmatter' WHERE slug = 'events/quokka-offsite'`);
      const rows = await hybridSearch(engine, 'when quokka workshop', { limit: 20, expansion: false });
      const firstFill = rows.findIndex(r => r.keyword_fill === true);
      expect(firstFill).toBeGreaterThan(0);
      expect(rows.slice(firstFill).every(r => r.keyword_fill === true)).toBe(true);
      expect(rows.map(r => r.slug).indexOf('events/quokka-offsite')).toBeGreaterThanOrEqual(firstFill);
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
