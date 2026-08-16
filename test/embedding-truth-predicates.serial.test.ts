/**
 * Truth-predicate pins (split-brain fix): after a schema rebuild NULLs every
 * vector, every status surface must tell the truth even though `embedded_at`
 * used to stay stamped.
 *
 *   1. Post-rebuild: getStats().embedded_count === 0,
 *      getHealth().embed_coverage === 0, missing_embeddings === all chunks,
 *      and embedded_at is cleared (post-tx hygiene batches).
 *   2. Per-slug embed re-embeds rebuild-darkened chunks instead of the
 *      "all chunks already embedded" silent no-op (embedding_is_null).
 *   3. getChunks exposes embedding_is_null truthfully on both engines'
 *      shared row shape (PGLite here; SQL text is parity-pinned).
 *   4. embed_skip chunks are excluded from BOTH sides of coverage; a brain
 *      whose only chunks are embed_skip reads vacuous 100%, not 0%.
 *   5. Nullable signature (D9 honesty): currentEmbeddingSignature() is
 *      `provider:model:dims` when the gateway resolves (same shape as
 *      migrationSignature) and null when it can't; a chunk embedded while
 *      the signature is null gets NO embedding_signature stamp, and only
 *      the includeNullSignature widening counts it stale.
 *
 * Named `.serial.test.ts`: installs a fake embed transport + temp
 * GBRAIN_HOME for its whole lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
  __unconfigureGatewayForTests,
} from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runSchemaTransition, migrationSignature } from '../src/core/embedding-migration.ts';
import { currentEmbeddingSignature } from '../src/core/embedding.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';

const DIMS = 1280;
const PAGES = ['truth-1', 'truth-2', 'truth-3'];

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let embedCalls = 0;

/** File-baseline gateway config. Re-applied by the nullable-signature test
 *  after it deliberately unconfigures the gateway. */
function configureBaselineGateway(): void {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake' },
  });
}

/** CRITICAL: must be re-installed after every resetGateway /
 *  __unconfigureGatewayForTests (both wipe transports) or tests hit the
 *  real embedding API. */
function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    embedCalls += values.length;
    return {
      embeddings: values.map(() => new Array(DIMS).fill(0).map((_, i) => Math.cos(i) * 0.01 + 0.002)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-truth-pred-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: DIMS,
    zeroentropy_api_key: 'ze-test-fake',
  }, null, 2));

  resetGateway();
  configureBaselineGateway();
  installTransport();

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('truth predicates survive a schema rebuild', () => {
  test('seed: pages embedded through the real pipeline read as covered', async () => {
    for (const slug of PAGES) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody of ${slug}` });
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: `chunk for ${slug}`, chunk_source: 'compiled_truth', token_count: 4 },
      ]);
    }
    const seeded = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(seeded.embedded).toBe(PAGES.length);

    const stats = await engine.getStats();
    expect(stats.embedded_count).toBe(PAGES.length);
    const health = await engine.getHealth();
    expect(health.embed_coverage).toBe(1);
    expect(health.missing_embeddings).toBe(0);

    const chunks = await engine.getChunks(PAGES[0]!);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.embedding_is_null).toBe(false);
  }, 30000);

  test('post-rebuild: every surface reports the dark column truthfully', async () => {
    // Same-width rebuild — the destructive path with no dim change, the
    // hardest case for embedded_at-keyed surfaces.
    await runSchemaTransition(engine, DIMS);

    const stats = await engine.getStats();
    expect(stats.embedded_count).toBe(0);

    const health = await engine.getHealth();
    expect(health.embed_coverage).toBe(0);
    expect(health.missing_embeddings).toBe(PAGES.length);

    // Post-tx hygiene: embedded_at cleared in batches after the DDL commit.
    const stale = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedded_at IS NOT NULL`,
    );
    expect(Number(stale[0]?.n)).toBe(0);

    const chunks = await engine.getChunks(PAGES[0]!);
    expect(chunks[0]!.embedding_is_null).toBe(true);
  }, 30000);

  test('per-slug embed re-embeds rebuild-darkened chunks (no silent no-op)', async () => {
    // Re-stamp embedded_at WITHOUT restoring vectors — the exact residue an
    // interrupted hygiene pass (or a pre-fix rebuild) leaves behind. The old
    // `!c.embedded_at` filter no-ops here; embedding_is_null must not.
    await engine.executeRaw(`UPDATE content_chunks SET embedded_at = now()`);
    embedCalls = 0;

    const result = await runEmbedCore(engine, { slugs: [PAGES[0]!], quiet: true });
    expect(result.embedded).toBe(1);
    expect(embedCalls).toBeGreaterThan(0);

    const chunks = await engine.getChunks(PAGES[0]!);
    expect(chunks[0]!.embedding_is_null).toBe(false);
  }, 30000);

  test('embed_skip is excluded from both sides; all-skip brain reads vacuous 100%', async () => {
    // Mark every page embed_skip: eligible set becomes empty.
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": true}'::jsonb`,
    );
    // Darken the vectors again so the old predicate would have read 0%.
    await runSchemaTransition(engine, DIMS);

    const health = await engine.getHealth();
    expect(health.embed_coverage).toBe(1); // vacuous: zero eligible chunks
    expect(health.missing_embeddings).toBe(0); // nothing remediable

    // Cleanup for any later suites in this file.
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'embed_skip'`);
  }, 30000);
});

describe('nullable embedding signature (D9 honesty)', () => {
  test('currentEmbeddingSignature: provider:model:dims when configured, null when the gateway cannot resolve', () => {
    // Configured path: exact canonical shape, and shape-parity with
    // migrationSignature (embedding-migration.ts documents "must match
    // currentEmbeddingSignature()'s shape").
    expect(currentEmbeddingSignature()).toBe('zeroentropyai:zembed-1:1280');
    expect(currentEmbeddingSignature()).toBe(migrationSignature('zeroentropyai:zembed-1', DIMS));

    // Null path: plain resetGateway() restores a CONFIGURED test baseline
    // (the #3554 preload), so a truly-unconfigured gateway is only reachable
    // through the sanctioned __unconfigureGatewayForTests seam. The old
    // fallback silently claimed the OpenAI default signature here — a lie.
    try {
      __unconfigureGatewayForTests();
      expect(currentEmbeddingSignature()).toBeNull();
    } finally {
      // __unconfigureGatewayForTests wipes transports too — restore BOTH.
      configureBaselineGateway();
      installTransport();
    }
    expect(currentEmbeddingSignature()).toBe('zeroentropyai:zembed-1:1280');
  });

  test('null-signature embed: no embedding_signature stamp; only includeNullSignature widening counts it stale', async () => {
    // Quarantine the earlier suites' pages (currently dark from the last
    // rebuild) so this test's stale set is exactly one page.
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": true}'::jsonb`,
    );
    try {
      await engine.putPage('truth-nullsig', {
        type: 'note', title: 'truth-nullsig', compiled_truth: '# truth-nullsig\n\nnull provenance body',
      });
      await engine.upsertChunks('truth-nullsig', [
        { chunk_index: 0, chunk_text: 'chunk for truth-nullsig', chunk_source: 'compiled_truth', token_count: 4 },
      ]);

      // The exact caller-level null contract: embed-backfill.ts spreads
      // `embeddingSignature` ONLY when currentEmbeddingSignature() !== null
      // (and embed.ts's bulk path passes `?? undefined`) — so a null
      // signature reaches embedStaleForSource as an ABSENT option. Drive the
      // real pipeline (gateway + fake transport) through that shape.
      embedCalls = 0;
      const res = await embedStaleForSource(engine, 'default', {});
      expect(res.done).toBe(true);
      expect(res.embedded).toBe(1);
      expect(embedCalls).toBeGreaterThan(0);

      // The vector landed...
      const chunks = await engine.getChunks('truth-nullsig');
      expect(chunks[0]!.embedding_is_null).toBe(false);
      // ...but provenance stays honestly NULL (no signature, no stamp).
      const sig = await engine.executeRaw<{ embedding_signature: string | null }>(
        `SELECT embedding_signature FROM pages WHERE slug = 'truth-nullsig' AND source_id = 'default'`,
      );
      expect(sig[0]?.embedding_signature).toBeNull();

      // Staleness accounting: unknown provenance is grandfathered by the
      // narrow predicate and surfaced only by the includeNullSignature
      // widening (the migrate-embeddings drain uses the widened form).
      const probeSig = 'probe-provider:probe-model:999';
      expect(await engine.countStaleChunks({ signature: probeSig, includeNullSignature: true })).toBe(1);
      expect(await engine.countStaleChunks({ signature: probeSig })).toBe(0);
    } finally {
      await engine.executeRaw(
        `UPDATE pages SET frontmatter = frontmatter - 'embed_skip' WHERE slug <> 'truth-nullsig'`,
      );
    }
  }, 30000);
});
