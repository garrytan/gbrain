/**
 * hidden_by_search_policy doctor check (issue #1777)
 *
 * Counts CHUNKED pages withheld from default search by the hard-exclude prefix
 * policy. Verifies:
 *  - default-only excludes (test/) → status ok with a prescriptive message
 *  - a NON-default env exclude hiding pages → status warn
 *  - multi-chunk page counted once (DISTINCT)
 *  - soft-deleted / quarantined pages NOT counted (visibility mirror)
 *  - archive/ never appears (it's demoted, not excluded)
 *  - SQL error → warn, not throw
 *  - the check name categorizes as a brain check
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkHiddenBySearchPolicy } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { buildQuarantineMarker } from '../src/core/quarantine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

async function seed(
  slug: string,
  opts: { chunks?: number; frontmatter?: Record<string, unknown> } = {},
): Promise<void> {
  const chunks = opts.chunks ?? 1;
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `body for ${slug}`,
    timeline: '',
    ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}),
  });
  if (chunks > 0) {
    const rows: ChunkInput[] = [];
    for (let i = 0; i < chunks; i++) {
      rows.push({
        chunk_index: i,
        chunk_text: `chunk ${i} of ${slug}`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(100 + i),
        token_count: 4,
      });
    }
    await engine.upsertChunks(slug, rows);
  }
}

beforeAll(async () => {
  // Pin the embedding dim to 1536 BEFORE initSchema. basisEmbedding()
  // hardcodes Float32Array(1536) vectors, but initSchema sizes vector
  // columns from process-global gateway state (getEmbeddingDimensions(),
  // default 1280 = zeroentropyai). Whether this file passes therefore
  // depended on which test files happened to run before it in the shard: a
  // predecessor that leaves the gateway configured without dims (or a bare
  // CI env) yields vector(1280) and every upsertChunks here dies with
  // "expected 1280 dimensions, not 1536". Adding test files to the repo
  // reshuffles the weight-packed shards, so unrelated PRs trip it (seen on
  // #2800 CI, test (1)). Same fix + rationale as
  // engine-find-trajectory.test.ts and cosine-rescore-column.test.ts, which
  // document this exact class.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test-hidden-by-search-policy' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('checkHiddenBySearchPolicy', () => {
  test('default-only excludes → ok, prescriptive message, names test/ not archive/concepts', async () => {
    await seed('test/fixtures/widget');
    await seed('concepts/widget-pattern');
    await seed('archive/old/widget-2020');

    const r = await checkHiddenBySearchPolicy(engine);
    expect(r.name).toBe('hidden_by_search_policy');
    expect(r.status).toBe('ok'); // test/ is a DEFAULT exclude → not a warn
    expect(r.message).toContain("under 'test/'");
    expect(r.message).toContain('chunked');
    expect(r.message).not.toContain('searchable'); // honest superset, not "searchable"
    expect(r.message).toContain('include_slug_prefixes'); // prescriptive guidance
    // archive/ is demoted, not excluded — must never surface here.
    expect(r.message).not.toContain('archive/');
    // concepts/ is not excluded at all.
    expect(r.message).not.toContain('concepts/');
    const counts = (r.details?.counts ?? {}) as Record<string, number>;
    expect(counts['test/']).toBe(1);
    expect(counts['archive/']).toBeUndefined();
    expect(counts['concepts/']).toBeUndefined();
  });

  test('a NON-default env exclude hiding pages → warn', async () => {
    await withEnv({ GBRAIN_SEARCH_EXCLUDE: 'scratch/' }, async () => {
      await seed('scratch/notes');
      await seed('concepts/keeper');
      const r = await checkHiddenBySearchPolicy(engine);
      expect(r.status).toBe('warn');
      expect(r.message).toContain("under 'scratch/'");
    });
  });

  test('multi-chunk page counted once (DISTINCT)', async () => {
    await seed('test/multi', { chunks: 3 });
    const r = await checkHiddenBySearchPolicy(engine);
    const counts = (r.details?.counts ?? {}) as Record<string, number>;
    expect(counts['test/']).toBe(1);
  });

  test('soft-deleted and quarantined pages are NOT counted', async () => {
    await seed('test/soft-deleted');
    await engine.softDeletePage('test/soft-deleted');
    await seed('test/quarantined', {
      frontmatter: { quarantine: buildQuarantineMarker('junk_pattern', 'test fixture') },
    });
    await seed('concepts/keeper');

    const r = await checkHiddenBySearchPolicy(engine);
    // Both test/ pages are hidden by the visibility clause, so 0 remain counted.
    expect(r.status).toBe('ok');
    expect(r.message).toBe('No pages hidden by search-exclude policy.');
    const counts = (r.details?.counts ?? {}) as Record<string, number>;
    expect(counts['test/']).toBeUndefined();
  });

  test('zero hidden (only curated content) → ok', async () => {
    await seed('concepts/keeper');
    const r = await checkHiddenBySearchPolicy(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toBe('No pages hidden by search-exclude policy.');
  });

  test('SQL error → warn, not throw', async () => {
    const broken = {
      executeRaw: async () => {
        throw new Error('boom');
      },
    } as unknown as BrainEngine;
    const r = await checkHiddenBySearchPolicy(broken);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('Could not check');
  });
});

describe('hidden_by_search_policy categorization', () => {
  test('categorizes as a brain check', () => {
    expect(categorizeCheck('hidden_by_search_policy')).toBe('brain');
  });
});
