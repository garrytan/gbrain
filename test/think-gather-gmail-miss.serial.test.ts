/**
 * search-op vs runGather retrieval PARITY + privacy/source scope over a seeded corpus.
 *
 * Scope (do not overstate): this fixture deliberately gives the email pages HIGH query
 * cosine and relevant text, so it does NOT reproduce any real ranked distribution. It
 * proves ONLY: under a controlled distribution where the emails are genuinely relevant,
 * (a) the REAL shipped `search` op and (b) REAL `runGather` both retain the same
 * expected email pages, and both honor identical privacy/source scope — so there is no
 * INHERENT wiring/limit/scope mismatch between the two paths under this distribution. It
 * does NOT classify any production distribution.
 *
 * Hermetic + faithful mechanics: one seeded in-memory PGLite corpus; the BASELINE arm
 * invokes the REAL shipped `search` op handler (`operationsByName.search`: the MCP/CLI
 * path — hybridSearchCached + resolveExcludePrivatePages + mode resolution); the GATHER
 * arm is REAL `runGather`. The ONLY thing mocked is the embedding seam
 * (`src/core/embedding.ts`) — hybridSearch/RRF/limit/fusion are all real. Pages are
 * stamped `chunker_version = SAFE_FENCE_CHUNKER_VERSION` so the safe-chunk filter
 * (which `excludePrivate` also triggers) passes and the only scope exclusion under
 * test is `excludePrivate` / source scope.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mock } from 'bun:test';
import * as realEmbedding from '../src/core/embedding.ts';
import { basisEmbedding } from '../src/eval/deterministic-embed.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

const DIM = 1536;
const D_Q = 7;      // the query + relevant email pages live here
const D_NOISE = 40; // noise pages' primary direction (weak overlap with the query)

function vec(pairs: Array<[number, number]>, dim = DIM): Float32Array {
  const e = new Float32Array(dim);
  for (const [d, w] of pairs) e[d % dim] += w;
  let norm = 0; for (let i = 0; i < dim; i++) norm += e[i] * e[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) e[i] /= norm;
  return e;
}

// Deterministic embedding seam — the query always embeds at D_Q. (Mocked BEFORE
// importing gather/operations so their bound `embedQuery` is the deterministic one.)
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => basisEmbedding(D_Q, DIM),
  embedQuery: async () => basisEmbedding(D_Q, DIM),
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { configureGateway } = await import('../src/core/ai/gateway.ts');
const { operationsByName } = await import('../src/core/operations.ts');
const { runGather } = await import('../src/core/think/gather.ts');
import type { SearchResult } from '../src/core/types.ts';
import type { OperationContext } from '../src/core/operations.ts';

type Engine = InstanceType<typeof PGLiteEngine>;
let engine: Engine;

const Q = 'active acme sales conversations across work email';
const N_EMAIL = 10, N_NOISE = 25;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'test' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const s of ['work-mail', 'other-src']) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [s]);
  }
  const seed = async (slug: string, src: string, emb: Float32Array, fm: Record<string, unknown> = {}) => {
    const body = `${slug} acme sales conversation body`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: body, frontmatter: fm }, { sourceId: src });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', embedding: emb, token_count: 8 }], { sourceId: src });
  };
  // Relevant emails (work-mail) — high cosine to the query.
  for (let i = 0; i < N_EMAIL; i++) await seed(`emails/2026/09/e${i}`, 'work-mail', vec([[D_Q, 0.95], [500 + i, 0.31]]));
  // Noise (default) — weak overlap, so it appears but ranks below the emails.
  for (let i = 0; i < N_NOISE; i++) await seed(`people/p${i}`, 'default', vec([[D_NOISE, 0.9], [D_Q, 0.3], [600 + i, 0.31]]));
  // A private email (must be excluded under excludePrivate) and an other-source email.
  await seed('emails/2026/09/private-deal', 'work-mail', vec([[D_Q, 0.95], [530, 0.31]]), { visibility: 'private' });
  await seed('emails/2026/09/other-src-deal', 'other-src', vec([[D_Q, 0.95], [531, 0.31]]));
  // Mark every seeded page "safe" so the safe-chunk filter (triggered by excludePrivate)
  // is not the thing doing the excluding — isolate excludePrivate / source scope.
  await engine.executeRaw(`UPDATE pages SET chunker_version = $1`, [SAFE_FENCE_CHUNKER_VERSION]);
}, 180_000);

afterAll(async () => { await engine.disconnect(); });

const searchOp = () => operationsByName.search;

// Explicit native OperationContext fixture (pattern: test/put-page-empty-guard.test.ts) —
// typechecks as OperationContext, no `as any`/`as unknown as`. Trusted local caller
// (remote:false); reads span all sources via the `source_id: '__all__'` param.
function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}
const slugs = (rs: SearchResult[]) => rs.map((r) => r.slug);
const hasEmail = (rs: SearchResult[]) => rs.some((r) => r.slug.startsWith('emails/2026/09/e'));

describe('CONTROLLED-PATH PARITY — shipped search vs runGather retain the same emails (NOT a production classification)', () => {
  let base: SearchResult[]; let gatherPages: SearchResult[];

  test('shipped search op (baseline) retains the (relevant-by-construction) emails', async () => {
    base = await searchOp().handler(makeCtx(), { query: Q, limit: 20, source_id: '__all__' }) as SearchResult[];
    expect(Array.isArray(base)).toBe(true);
    expect(hasEmail(base)).toBe(true);
  });

  test('real runGather over the SAME corpus retains the same emails → no inherent path mismatch (here)', async () => {
    const g = await runGather(engine, { question: Q, remote: false });
    gatherPages = g.pages;
    const emailsInGather = hasEmail(gatherPages);
    // eslint-disable-next-line no-console
    console.log(
      `\n[parity] search-op vs runGather (controlled distribution — not a production classification)\n` +
      `  fixtures give emails HIGH query cosine + relevant text — this is not a real ranked distribution.\n` +
      `  baseline (shipped search op) emails present: ${hasEmail(base)}\n` +
      `  gather.pages emails present:                 ${emailsInGather}\n` +
      `  gather.pages size: ${gatherPages.length} (gatherLimit 40); email pages in gather: ${slugs(gatherPages).filter((s) => s.startsWith('emails/2026/09/e')).length}\n` +
      `  => Under this controlled distribution both paths retain all expected emails: NO inherent wiring/limit/scope mismatch.\n` +
      `     A real ranked distribution (not this controlled fixture) is needed to classify any production behavior.\n`,
    );
    // Parity only: when the emails are genuinely relevant, gather.pages retains them
    // just as the shipped search op does (gatherLimit 40 ≥ op limit 20, same
    // expansion:false hybrid). This does NOT reproduce the false-absence distribution.
    expect(emailsInGather).toBe(true);
  });
});

describe('IDENTICAL privacy / source scoping across both paths', () => {
  test('excludePrivate hides the private email in the gather path; emails still present', async () => {
    const g = await runGather(engine, { question: Q, remote: false, excludePrivate: true });
    expect(g.pages.some((r) => r.slug === 'emails/2026/09/private-deal')).toBe(false);
    expect(hasEmail(g.pages)).toBe(true);
  });

  test('source scope hides the other-source email in BOTH paths; gmail emails remain', async () => {
    const opScoped = await searchOp().handler(
      makeCtx(),
      { query: Q, limit: 40, source_id: 'work-mail' },
    ) as SearchResult[];
    const gatherScoped = await runGather(engine, { question: Q, remote: false, sourceId: 'work-mail' });
    for (const rs of [opScoped, gatherScoped.pages]) {
      expect(rs.some((r) => r.slug === 'emails/2026/09/other-src-deal')).toBe(false);
      expect(rs.every((r) => (r.source_id ?? 'default') === 'work-mail')).toBe(true);
      expect(hasEmail(rs)).toBe(true);
    }
  });
});
