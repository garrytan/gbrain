/**
 * #10067: a fence that parses again answers a held `fence_absent` generation even when the page's stored rows already
 * match it. The extract_facts reconcile returned early on an in-sync plan without asking the generation primitive, so
 * once a page lost its facts fence and got it back unchanged, doctor `generation_held` reported the hold forever.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { listFenceHolds } from '../src/core/generations/fence.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SLUG = 'people/alice-example';
const FENCED = `# Alice Example

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice Example founded acme-example. | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->
`;

for (const kind of testBackends()) {
  describe(`#10067 a fence that parses again clears its fence_absent hold (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    const put = (body: string, slug = SLUG) => engine.putPage(slug, { title: 'Alice Example', type: 'person', compiled_truth: body, frontmatter: {}, timeline: '' });
    const holds = async (slug = SLUG) => (await listFenceHolds(engine, ['default'], slug)).map(h => `${h.kind}:${h.reason}`);
    const active = async (slug = SLUG) => (await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL ORDER BY row_num', [slug])).map(r => r.fact);

    test('the fence comes back unchanged: the rows stay and the hold clears', async () => {
      await put(FENCED);
      await runExtractFacts(engine, { slugs: [SLUG] });
      expect(await active()).toEqual(['Alice Example founded acme-example.']);
      await put('# Alice Example\n\nThe facts section was lost in an edit.\n');
      await runExtractFacts(engine, { slugs: [SLUG] });
      expect(await holds()).toEqual(['fact_fence:fence_absent']);
      expect(await active()).toEqual(['Alice Example founded acme-example.']);

      await put(FENCED);
      await runExtractFacts(engine, { slugs: [SLUG] });
      expect(await holds()).toEqual([]);
      expect(await active()).toEqual(['Alice Example founded acme-example.']);
    }, 120_000);

    test('a no_proof hold clears the same way and keeps the rows and their trust tier', async () => {
      const slug = 'people/alice-example-2';
      const tiers = async () => (await engine.executeRaw<{ fact: string; trust_tier: string }>(
        'SELECT fact, trust_tier FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num', [slug]));
      await put(FENCED, slug);
      await runExtractFacts(engine, { slugs: [slug] });
      const before = await tiers();
      await put('# Alice Example\n\nThe facts section was lost in an edit.\n', slug);
      await runExtractFacts(engine, { slugs: [slug] });
      await engine.executeRaw(
        `UPDATE derived_generations SET held_reason = 'no_proof' WHERE state = 'held' AND held_reason = 'fence_absent' AND owner_key LIKE $1`, [`%${slug}%`]);
      expect(await holds(slug)).toEqual(['fact_fence:no_proof']);

      await put(FENCED, slug);
      await runExtractFacts(engine, { slugs: [slug] });
      expect(await holds(slug)).toEqual([]);
      expect(await active(slug)).toEqual(['Alice Example founded acme-example.']);
      expect(await tiers()).toEqual(before);
    }, 120_000);
  });
}
