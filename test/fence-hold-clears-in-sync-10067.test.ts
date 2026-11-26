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

    const put = (body: string) => engine.putPage(SLUG, { title: 'Alice Example', type: 'person', compiled_truth: body, frontmatter: {}, timeline: '' });
    const holds = async () => (await listFenceHolds(engine, ['default'], SLUG)).map(h => `${h.kind}:${h.reason}`);
    const active = async () => (await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL ORDER BY row_num', [SLUG])).map(r => r.fact);

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
  });
}
