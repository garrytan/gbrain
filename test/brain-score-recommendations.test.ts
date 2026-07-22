import { describe, test, expect } from 'bun:test';
import {
  computeRecommendations,
  classifyChecks,
  maxReachableScore,
  estimateAnthropicCost,
  embeddingProviderConfigured,
  HOSTED_EMBED_KEY_CONFIG,
} from '../src/core/brain-score-recommendations.ts';
import type { BrainHealth } from '../src/core/types.ts';

/**
 * v0.40.x — recipe-aware embedding-provider check (shared by doctor +
 * autopilot). Pure: `resolveKey` is injected, so no env mutation (R1-safe).
 */
describe('embeddingProviderConfigured (recipe-aware helper)', () => {
  const alwaysTrue = () => true;
  const alwaysFalse = () => false;

  test('empty / undefined model → false', () => {
    expect(embeddingProviderConfigured(undefined, alwaysTrue)).toBe(false);
    expect(embeddingProviderConfigured('', alwaysTrue)).toBe(false);
  });

  test('local providers (empty auth_env.required) → true regardless of keys', () => {
    // The core fix: ollama / llama-server need no hosted key.
    expect(embeddingProviderConfigured('ollama:nomic-embed-text', alwaysFalse)).toBe(true);
    expect(embeddingProviderConfigured('llama-server:my-gguf', alwaysFalse)).toBe(true);
  });

  test('hosted provider configured iff its required key resolves', () => {
    expect(embeddingProviderConfigured('openai:text-embedding-3-small', (k) => k === 'OPENAI_API_KEY')).toBe(true);
    // REGRESSION: hosted without its key still blocks.
    expect(embeddingProviderConfigured('openai:text-embedding-3-small', alwaysFalse)).toBe(false);
  });

  test('behavior-change: voyage judged by VOYAGE_API_KEY, not an OpenAI key', () => {
    // New (correct) behavior — pre-fix doctor judged voyage by whether any
    // openai/ZE key existed.
    expect(embeddingProviderConfigured('voyage:voyage-3', (k) => k === 'VOYAGE_API_KEY')).toBe(true);
    expect(embeddingProviderConfigured('voyage:voyage-3', (k) => k === 'OPENAI_API_KEY')).toBe(false);
  });

  test('unknown provider (no recipe) → false', () => {
    expect(embeddingProviderConfigured('made-up-provider:foo', alwaysTrue)).toBe(false);
  });

  test('malformed model id → false (parseModelId throws, caught)', () => {
    expect(embeddingProviderConfigured('noColon', alwaysTrue)).toBe(false);
    expect(embeddingProviderConfigured('::', alwaysTrue)).toBe(false);
    expect(embeddingProviderConfigured(':model', alwaysTrue)).toBe(false);
    expect(embeddingProviderConfigured('provider:', alwaysTrue)).toBe(false);
  });

  // Regression (codex review of the local-embeddings PR): the producer closures
  // (doctor + autopilot) consult HOSTED_EMBED_KEY_CONFIG to decide which config
  // field backs each env key. Only keys that buildGatewayConfig actually folds
  // into the gateway env may appear, or a config-plane key the gateway ignores
  // would make the provider look "configured" and dispatch a doomed embed job.
  test('HOSTED_EMBED_KEY_CONFIG only maps gateway-propagated config keys', () => {
    expect(HOSTED_EMBED_KEY_CONFIG.OPENAI_API_KEY).toBe('openai_api_key');
    expect(HOSTED_EMBED_KEY_CONFIG.ZEROENTROPY_API_KEY).toBe('zeroentropy_api_key');
    // Not propagated to the gateway today → must NOT be backed by a config field
    // (producer closures fall through to process.env only for these).
    expect(HOSTED_EMBED_KEY_CONFIG.VOYAGE_API_KEY).toBeUndefined();
    expect(HOSTED_EMBED_KEY_CONFIG.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });
});

/**
 * D6 #5 + D13 + D14 pinning tests for brain-score-recommendations.
 *
 * Pure-function tests — no engine, no I/O. Every assertion below maps
 * to an invariant the doctor-remediate loop assumes.
 */

function makeHealth(overrides: Partial<BrainHealth> = {}): BrainHealth {
  return {
    page_count: 100,
    embed_coverage: 1.0,
    stale_pages: 0,
    orphan_pages: 0,
    missing_embeddings: 0,
    brain_score: 100,
    dead_links: 0,
    link_coverage: 1.0,
    timeline_coverage: 1.0,
    most_connected: [],
    embed_coverage_score: 35,
    link_density_score: 25,
    timeline_coverage_score: 15,
    no_orphans_score: 15,
    no_dead_links_score: 10,
    ...overrides,
  };
}

describe('computeRecommendations', () => {
  test('healthy brain (score 100) produces empty plan', () => {
    const health = makeHealth();
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    expect(recs).toEqual([]);
  });

  test('missing embeddings produces embed.stale remediation', () => {
    const health = makeHealth({ missing_embeddings: 1432, brain_score: 65 });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const ids = recs.map((r) => r.id);
    expect(ids).toContain('embed.stale');
    const embedRec = recs.find((r) => r.id === 'embed.stale')!;
    expect(embedRec.severity).toBe('critical');
    expect(embedRec.job).toBe('embed');
    expect(embedRec.params.stale).toBe(true);
  });

  test('missing embeddings + API key absent: NOT emitted (blocked surfaces separately)', () => {
    const health = makeHealth({ missing_embeddings: 1432 });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: false });
    expect(recs.find((r) => r.id === 'embed.stale')).toBeUndefined();
  });

  test('stale pages + dead links produce sync + backlinks + extract', () => {
    const health = makeHealth({
      stale_pages: 25,
      dead_links: 8,
      brain_score: 70,
    });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const ids = recs.map((r) => r.id);
    expect(ids).toContain('sync.repo');
    expect(ids).toContain('backlinks.fix');
    expect(ids).toContain('extract.all');
  });

  test('extract.all depends on sync.repo (D14: stable ids)', () => {
    const health = makeHealth({ stale_pages: 10 });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const extract = recs.find((r) => r.id === 'extract.all');
    expect(extract?.depends_on).toContain('sync.repo');
  });

  test('embed.stale depends on sync.repo when sync also needed', () => {
    const health = makeHealth({
      stale_pages: 10,
      missing_embeddings: 100,
    });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const embed = recs.find((r) => r.id === 'embed.stale');
    expect(embed?.depends_on).toContain('sync.repo');
  });

  test('embed.stale has no sync dependency when nothing stale', () => {
    const health = makeHealth({ missing_embeddings: 100 });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const embed = recs.find((r) => r.id === 'embed.stale');
    expect(embed?.depends_on).toEqual([]);
  });

  test('severity ordering: critical before high before medium', () => {
    const health = makeHealth({
      missing_embeddings: 100,  // critical
      stale_pages: 80,          // high
    });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    const critIdx = recs.findIndex((r) => r.severity === 'critical');
    const highIdx = recs.findIndex((r) => r.severity === 'high');
    expect(critIdx).toBeLessThan(highIdx);
  });

  // D6 #5 — THE critical regression test for the agent contract.
  test('D6 #5: determinism — same input twice produces identical output', () => {
    const health = makeHealth({
      stale_pages: 10,
      missing_embeddings: 50,
      dead_links: 3,
    });
    const ctx = { repoPath: '/brain', embeddingProviderConfigured: true, sourceId: 'default' };
    const run1 = computeRecommendations(health, ctx);
    const run2 = computeRecommendations(health, ctx);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  test('D9: idempotency keys are content-hash, no time-slot', () => {
    const health = makeHealth({ missing_embeddings: 50 });
    const recs = computeRecommendations(health, {
      repoPath: '/brain',
      embeddingProviderConfigured: true,
      sourceId: 'default',
    });
    const embed = recs.find((r) => r.id === 'embed.stale')!;
    // No date in the key — content-hash only
    expect(embed.idempotency_key).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Format: source:job:sha8
    expect(embed.idempotency_key).toMatch(/^default:embed:[a-f0-9]{8}$/);
  });

  test('D9: different sources produce different idempotency keys', () => {
    const health = makeHealth({ missing_embeddings: 50 });
    const a = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true, sourceId: 'A' });
    const b = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true, sourceId: 'B' });
    expect(a[0]!.idempotency_key).not.toBe(b[0]!.idempotency_key);
  });

  test('status field is always remediable in the output list (D13)', () => {
    const health = makeHealth({ missing_embeddings: 50 });
    const recs = computeRecommendations(health, { repoPath: '/brain', embeddingProviderConfigured: true });
    for (const r of recs) expect(r.status).toBe('remediable');
  });

  test('+A cost estimate populated for embed', () => {
    const health = makeHealth({ missing_embeddings: 1000 });
    const recs = computeRecommendations(health, {
      repoPath: '/brain',
      embeddingProviderConfigured: true,
      embeddingModel: 'openai:text-embedding-3-large',
      embeddingDimensions: 3072,
    });
    const embed = recs.find((r) => r.id === 'embed.stale')!;
    expect(embed.est_usd_cost).toBeGreaterThan(0);
  });
});

describe('classifyChecks (D13)', () => {
  test('remediable: missing_embeddings with API key', () => {
    const result = classifyChecks([{ name: 'missing_embeddings', status: 'fail' }], {
      embeddingProviderConfigured: true,
    });
    expect(result[0]).toEqual({ check: 'missing_embeddings', status: 'remediable' });
  });

  test('blocked: missing_embeddings without API key', () => {
    const result = classifyChecks([{ name: 'missing_embeddings', status: 'fail' }], {
      embeddingProviderConfigured: false,
    });
    expect(result[0]?.status).toBe('blocked');
    expect(result[0]?.reason).toContain('embedding');
  });

  test('blocked: dead_links without repoPath', () => {
    const result = classifyChecks([{ name: 'dead_links', status: 'warn' }], {});
    expect(result[0]?.status).toBe('blocked');
  });

  test('human_only: orphan_pages (archive is product judgment)', () => {
    const result = classifyChecks([{ name: 'orphan_pages', status: 'warn' }], { repoPath: '/brain' });
    expect(result[0]?.status).toBe('human_only');
  });

  test('human_only: unknown check defaults to operator judgment', () => {
    const result = classifyChecks([{ name: 'mystery_check', status: 'warn' }], {});
    expect(result[0]?.status).toBe('human_only');
  });
});

describe('maxReachableScore (D13)', () => {
  test('all remediable: full 100', () => {
    const health = makeHealth({
      embed_coverage_score: 0,
      no_dead_links_score: 0,
      no_orphans_score: 0,
    });
    const classes = [
      { check: 'missing_embeddings', status: 'remediable' as const },
      { check: 'dead_links', status: 'remediable' as const },
      { check: 'orphan_pages', status: 'remediable' as const },
    ];
    expect(maxReachableScore(health, classes)).toBe(100);
  });

  test('all blocked: stays at current', () => {
    const health = makeHealth({
      brain_score: 50,
      embed_coverage_score: 5,
      no_dead_links_score: 5,
      no_orphans_score: 10,
    });
    const classes = [
      { check: 'missing_embeddings', status: 'blocked' as const },
      { check: 'dead_links', status: 'blocked' as const },
      { check: 'orphan_pages', status: 'human_only' as const },
    ];
    // 5 + 25 + 15 + 10 + 5 = 60
    expect(maxReachableScore(health, classes)).toBe(60);
  });
});

describe('estimateAnthropicCost', () => {
  test('returns 0 for unknown model', () => {
    expect(estimateAnthropicCost('unknown-model', 10)).toBe(0);
  });

  test('returns positive for known model', () => {
    const cost = estimateAnthropicCost('claude-sonnet-4-6', 10);
    expect(cost).toBeGreaterThan(0);
  });
});
