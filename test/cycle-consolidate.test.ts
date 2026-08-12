/**
 * v0.31 Phase 6 — dream-cycle `consolidate` phase tests.
 *
 * Pins:
 *   - Below-threshold buckets are skipped (count < 3 OR oldest < 24h)
 *   - Cluster of >=2 same-vector facts produces 1 take, marks all facts consolidated
 *   - Never DELETE — facts stay as audit trail
 *   - dryRun honored
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import {
  CONSOLIDATE_MODEL_CONFIG_KEY,
  CONSOLIDATE_THRESHOLD_CONFIG_KEY,
  parseConsolidatedClaim,
  runPhaseConsolidate,
  type ConsolidatePhaseOpts,
} from '../src/core/cycle/phases/consolidate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  // initSchema() bakes the facts.embedding dim from the gateway's configured
  // embedding model; the default is now 1280-d (ZE). This file's fixtures are
  // 1536-d, so pin the legacy 1536-d OpenAI config (matching
  // test/helpers/legacy-embedding-preload.ts) right before initSchema. The
  // global preload sets this, but a co-sharded test that calls resetGateway()
  // in its teardown nulls it, leaving initSchema to fall back to the 1280-d
  // default and build a halfvec(1280) column the 1536-d inserts can't fill.
  // Re-pinning here makes the schema deterministic regardless of shard
  // neighbors (surfaced when #1972's new test files reshuffled the shards).
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Clean facts + takes between tests for hermetic state.
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM takes`);
  await engine.unsetConfig(CONSOLIDATE_THRESHOLD_CONFIG_KEY);
  await engine.unsetConfig(CONSOLIDATE_MODEL_CONFIG_KEY);
});

const oldDate = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const recentDate = () => new Date(Date.now() - 60 * 1000).toISOString();
function unitVec(): string {
  const a = new Float32Array(1536);
  a[0] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

function angledVec(cosine: number, orthogonalAxis: number): string {
  const a = new Float32Array(1536);
  a[0] = cosine;
  a[orthogonalAxis] = Math.sqrt(1 - cosine * cosine);
  return '[' + Array.from(a).join(',') + ']';
}

async function seedPage(slug: string): Promise<number> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title) VALUES ($1, 'concept', 'Test') ON CONFLICT DO NOTHING`,
    [slug],
  );
  const r = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return r[0].id;
}

const testSynthesizer: NonNullable<ConsolidatePhaseOpts['synthesizeClaim']> = async ({ facts }) =>
  facts.reduce((best, fact) => fact.confidence > best.confidence ? fact : best).fact;

async function runConsolidate(opts: ConsolidatePhaseOpts = {}) {
  return runPhaseConsolidate(engine, { synthesizeClaim: testSynthesizer, ...opts });
}

describe('runPhaseConsolidate', () => {
  test('below threshold (count < 3) → skipped', async () => {
    await seedPage('cons-skip-count');
    for (let i = 0; i < 2; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-skip-count', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runConsolidate();
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
  });

  test('all facts too recent → bucket processed but skipped, 0 work', async () => {
    await seedPage('cons-skip-age');
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-skip-age', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`fact ${i}`, recentDate(), unitVec()],
      );
    }
    const r = await runConsolidate();
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.buckets_skipped).toBeGreaterThanOrEqual(1);
  });

  test('invokes the throttled in-phase keepalive while scanning buckets', async () => {
    for (const slug of ['cons-keepalive-a', 'cons-keepalive-b']) {
      await seedPage(slug);
      for (let i = 0; i < 3; i++) {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
           VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz, $4::vector, $3::timestamptz)`,
          [slug, `${slug} fact ${i}`, recentDate(), unitVec()],
        );
      }
    }
    let keepalives = 0;
    const r = await runConsolidate({
      yieldDuringPhase: async () => { keepalives++; },
    });

    expect(r.details.buckets_scanned).toBe(2);
    expect(keepalives).toBe(1);
  });

  test('happy path: 4 same-vector facts on a page → 1 take, all consolidated', async () => {
    const pageId = await seedPage('people/alice-example');
    expect(pageId).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at)
         VALUES ('default', 'people/alice-example', $1, 'fact', 'test', $2::timestamptz, 0.9, $3::vector, $2::timestamptz)`,
        [`alice fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runConsolidate();
    expect(r.details.facts_consolidated).toBe(4);
    expect(r.details.takes_written).toBe(1);

    // Take row created on the right page.
    const takes = await engine.executeRaw<{ page_id: number; kind: string; weight: number; holder: string }>(
      `SELECT page_id, kind, weight, holder FROM takes`,
    );
    expect(takes.length).toBe(1);
    expect(takes[0].page_id).toBe(pageId);
    expect(takes[0].kind).toBe('fact');
    expect(takes[0].holder).toBe('self');
    expect(takes[0].weight).toBeCloseTo(0.9, 2);

    // Facts marked consolidated, NEVER deleted.
    const facts = await engine.executeRaw<{ id: number; consolidated_at: Date | null; consolidated_into: number | null }>(
      `SELECT id, consolidated_at, consolidated_into FROM facts ORDER BY id`,
    );
    expect(facts.length).toBe(4);
    for (const f of facts) {
      expect(f.consolidated_at).not.toBeNull();
      expect(f.consolidated_into).not.toBeNull();
    }
  });

  test('model budget exhaustion leaves the cluster pending without a shortcut fallback', async () => {
    await seedPage('cons-budget-stop');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-budget-stop', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`budget fact ${i}`, oldDate(), unitVec()],
      );
    }
    let synthesisCalls = 0;
    const r = await runPhaseConsolidate(engine, {
      budgetUsd: 0.000001,
      synthesizeClaim: async () => {
        synthesisCalls++;
        return 'must not run';
      },
    });

    expect(r.status).toBe('warn');
    expect(r.details.budget_exhausted).toBe(true);
    expect(r.details.facts_consolidated).toBe(0);
    expect(synthesisCalls).toBe(0);
    const pending = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts WHERE entity_slug = 'cons-budget-stop' AND consolidated_at IS NULL`,
    );
    expect(pending[0].count).toBe(3);
  });

  test('paginates beyond 100 active rows without stranding the oldest facts', async () => {
    await seedPage('cons-large-bucket');
    await engine.executeRaw(
      `INSERT INTO facts
         (source_id, entity_slug, fact, kind, source, valid_from, confidence, embedding, embedded_at)
       SELECT 'default', 'cons-large-bucket', 'large fact ' || i, 'fact', 'test',
              $1::timestamptz, 0.9, $2::vector, $1::timestamptz
       FROM generate_series(1, 103) AS i`,
      [oldDate(), unitVec()],
    );

    const first = await runConsolidate();
    expect(first.details.facts_consolidated).toBe(103);

    const second = await runConsolidate();
    expect(second.details.facts_consolidated).toBe(0);
    const pending = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts
       WHERE entity_slug = 'cons-large-bucket' AND consolidated_at IS NULL`,
    );
    expect(pending[0].count).toBe(0);
  });

  test('dryRun honored: counters tick but no rows written', async () => {
    await seedPage('cons-dryrun');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-dryrun', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`dryrun fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runConsolidate({ dryRun: true });
    expect(r.details.dryRun).toBe(true);
    expect(r.details.facts_consolidated).toBe(3);
    expect(r.details.takes_written).toBe(1);
    const takes = await engine.executeRaw<{ id: number }>(`SELECT id FROM takes`);
    expect(takes.length).toBe(0);
    const facts = await engine.executeRaw<{ id: number; consolidated_at: Date | null }>(
      `SELECT id, consolidated_at FROM facts ORDER BY id`,
    );
    for (const f of facts) {
      expect(f.consolidated_at).toBeNull();
    }
  });

  test('skips bucket when no matching page exists in source', async () => {
    // Don't seed a page — entity_slug 'no-page' won't resolve.
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'no-page', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`orphan fact ${i}`, oldDate(), unitVec()],
      );
    }
    const r = await runConsolidate();
    // Missing-page buckets are diagnosed, not misreported as processed.
    expect(r.status).toBe('warn');
    expect(r.details.buckets_processed).toBe(0);
    expect(r.details.buckets_missing_page).toBe(1);
    expect(r.details.facts_missing_page).toBe(4);
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
  });

  test('warns when a promotion succeeds but another bucket remains blocked', async () => {
    await seedPage('cons-mixed-resolved');
    for (const slug of ['cons-mixed-resolved', 'cons-mixed-missing']) {
      for (let i = 0; i < 3; i++) {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
           VALUES ('default', $1, $2, 'fact', 'test', $3::timestamptz, $4::vector, $3::timestamptz)`,
          [slug, `${slug} fact ${i}`, oldDate(), unitVec()],
        );
      }
    }

    const r = await runConsolidate();
    expect(r.details.facts_consolidated).toBe(3);
    expect(r.details.buckets_missing_page).toBe(1);
    expect(r.status).toBe('warn');
  });

  test('reads a model-calibrated cluster threshold from config', async () => {
    await seedPage('cons-config-threshold');
    const vectors = [unitVec(), angledVec(0.845, 1), angledVec(0.845, 2)];
    for (let i = 0; i < vectors.length; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-config-threshold', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`configured fact ${i}`, oldDate(), vectors[i]],
      );
    }

    const defaultResult = await runConsolidate({ dryRun: true });
    expect(defaultResult.details.facts_consolidated).toBe(0);
    expect(defaultResult.details.buckets_below_similarity_threshold).toBe(1);
    expect(defaultResult.details.cluster_threshold).toBe(0.85);

    await engine.setConfig(CONSOLIDATE_THRESHOLD_CONFIG_KEY, '0.84');
    const configuredResult = await runConsolidate({ dryRun: true });
    expect(configuredResult.details.cluster_threshold).toBe(0.84);
    expect(configuredResult.details.cluster_threshold_source).toBe('config');
    expect(configuredResult.details.facts_consolidated).toBeGreaterThanOrEqual(2);
    expect(configuredResult.details.takes_written).toBe(1);
  });

  test('prefers a valid override and falls back from invalid config', async () => {
    await engine.setConfig(CONSOLIDATE_THRESHOLD_CONFIG_KEY, 'not-a-number');
    const fallbackResult = await runConsolidate({ dryRun: true });
    expect(fallbackResult.details.cluster_threshold).toBe(0.85);
    expect(fallbackResult.details.cluster_threshold_source).toBe('default');

    const overrideResult = await runConsolidate({
      dryRun: true,
      clusterThreshold: 0.82,
    });
    expect(overrideResult.details.cluster_threshold).toBe(0.82);
    expect(overrideResult.details.cluster_threshold_source).toBe('override');
  });

  test('pins threshold validation boundaries and config-read failure fallback', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain(CONSOLIDATE_THRESHOLD_CONFIG_KEY);
    for (const clusterThreshold of [0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await runConsolidate({ dryRun: true, clusterThreshold });
      expect(r.details.cluster_threshold).toBe(0.85);
      expect(r.details.cluster_threshold_source).toBe('default');
    }

    const upperBoundary = await runConsolidate({ dryRun: true, clusterThreshold: 1 });
    expect(upperBoundary.details.cluster_threshold).toBe(1);
    expect(upperBoundary.details.cluster_threshold_source).toBe('override');

    const originalGetConfig = engine.getConfig.bind(engine);
    engine.getConfig = async (key: string) => {
      if (key === CONSOLIDATE_THRESHOLD_CONFIG_KEY) {
        throw new Error('legacy config storage unavailable');
      }
      return originalGetConfig(key);
    };
    try {
      const r = await runConsolidate({ dryRun: true });
      expect(r.details.cluster_threshold).toBe(0.85);
      expect(r.details.cluster_threshold_source).toBe('default');
    } finally {
      engine.getConfig = originalGetConfig;
    }
  });

  test('reports facts that cannot participate because embeddings are missing', async () => {
    await seedPage('cons-no-embedding');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from)
         VALUES ('default', 'cons-no-embedding', $1, 'fact', 'test', $2::timestamptz)`,
        [`unembedded fact ${i}`, oldDate()],
      );
    }

    const r = await runConsolidate({ dryRun: true });
    expect(r.status).toBe('warn');
    expect(r.details.buckets_below_similarity_threshold).toBe(1);
    expect(r.details.facts_without_embedding).toBe(3);
    expect(r.details.facts_consolidated).toBe(0);
  });

  test('honors the configured consolidate model and stores its synthesized claim', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain(CONSOLIDATE_MODEL_CONFIG_KEY);
    await engine.setConfig(CONSOLIDATE_MODEL_CONFIG_KEY, 'openai:gpt-4.1-mini');
    await seedPage('cons-model-backed');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-model-backed', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`raw clustered fact ${i}`, oldDate(), unitVec()],
      );
    }

    let observedModel = '';
    const r = await runPhaseConsolidate(engine, {
      synthesizeClaim: async ({ model }) => {
        observedModel = model;
        return 'The model synthesized one durable claim.';
      },
    });

    expect(observedModel).toBe('openai:gpt-4.1-mini');
    expect(r.details.model).toBe('openai:gpt-4.1-mini');
    expect(r.details.synthesis_calls).toBe(1);
    expect(r.details.synthesis_failures).toBe(0);
    const takes = await engine.executeRaw<{ claim: string }>(
      `SELECT claim FROM takes WHERE page_id = (SELECT id FROM pages WHERE slug = 'cons-model-backed')`,
    );
    expect(takes).toEqual([{ claim: 'The model synthesized one durable claim.' }]);
  });

  test('keeps a cluster pending and warns when model synthesis fails', async () => {
    await seedPage('cons-model-failure');
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from, embedding, embedded_at)
         VALUES ('default', 'cons-model-failure', $1, 'fact', 'test', $2::timestamptz, $3::vector, $2::timestamptz)`,
        [`retryable fact ${i}`, oldDate(), unitVec()],
      );
    }

    const r = await runPhaseConsolidate(engine, {
      synthesizeClaim: async () => { throw new Error('provider unavailable'); },
    });
    expect(r.status).toBe('warn');
    expect(r.details.synthesis_failures).toBe(1);
    expect(r.details.facts_consolidated).toBe(0);
    expect(await engine.executeRaw(`SELECT id FROM takes`)).toHaveLength(0);
    const pending = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts WHERE consolidated_at IS NULL`,
    );
    expect(pending[0].count).toBe(3);
  });
});

describe('parseConsolidatedClaim', () => {
  test('accepts strict JSON with common provider wrappers', () => {
    expect(parseConsolidatedClaim('{"claim":"A durable claim"}')).toBe('A durable claim');
    expect(parseConsolidatedClaim('```json\n{"claim":"Wrapped claim"}\n```')).toBe('Wrapped claim');
    expect(parseConsolidatedClaim('<think>private</think>{"claim":"Reasoned claim"}')).toBe('Reasoned claim');
  });

  test('rejects prose, malformed JSON, and empty claims', () => {
    expect(() => parseConsolidatedClaim('plain prose')).toThrow('no JSON object');
    expect(() => parseConsolidatedClaim('{not json}')).toThrow('malformed JSON');
    expect(() => parseConsolidatedClaim('{"claim":""}')).toThrow('no claim');
  });
});
