/**
 * eval-contradictions/cache — P2 persistent judge cache wrapper.
 *
 * Thin orchestration over the engine's getContradictionCacheEntry +
 * putContradictionCacheEntry + sweepContradictionCache methods. Owns:
 *   - Stable content hashing (sha256, lower-case hex).
 *   - The cache key shape that includes prompt_version + truncation_policy
 *     (Codex outside-voice fix).
 *   - Order-independence: (a, b) and (b, a) hash to the same key by
 *     sorting the two hashes lexicographically.
 *   - In-process counters for the run's cache hit-rate report.
 *
 * The judge's response shape (JudgeVerdict) round-trips through JSONB.
 * Reads parse the JSONB column back into a typed verdict; writes accept the
 * verdict object directly (sql.json on Postgres, $N::jsonb on PGLite).
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { PROMPT_VERSION, TRUNCATION_POLICY } from './types.ts';
import type { CacheStats, JudgeVerdict } from './types.ts';

/** Stable sha256 hex of a string. UTF-8 input. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Order-independent cache key: a and b sorted lex so (a, b) and (b, a)
 * collide. This matters because the orchestrator may emit pairs in either
 * direction depending on retrieval order; the verdict is symmetric.
 */
export function buildCacheKey(opts: {
  textA: string;
  textB: string;
  modelId: string;
}): {
  chunk_a_hash: string;
  chunk_b_hash: string;
  model_id: string;
  prompt_version: string;
  truncation_policy: string;
} {
  const hA = hashContent(opts.textA);
  const hB = hashContent(opts.textB);
  const [first, second] = hA <= hB ? [hA, hB] : [hB, hA];
  return {
    chunk_a_hash: first,
    chunk_b_hash: second,
    model_id: opts.modelId,
    prompt_version: PROMPT_VERSION,
    truncation_policy: TRUNCATION_POLICY,
  };
}

/**
 * Type guard: validates a JSONB blob actually parses to a JudgeVerdict.
 * Defensive — if the cache row was written under an older prompt_version
 * but somehow survived a version bump, we want to detect the shape
 * mismatch and treat it as a miss rather than crash downstream.
 */
function isJudgeVerdict(raw: unknown): raw is JudgeVerdict {
  if (!raw || typeof raw !== 'object') return false;
  const v = raw as Record<string, unknown>;
  // v0.34 / Lane A2: shape check matches the new `verdict: Verdict` enum.
  // Old v1-shaped rows (with `contradicts: boolean` instead) fail this guard
  // and get treated as cache misses — same effect as the PROMPT_VERSION '1'
  // rows already being filtered out by the cache-key tuple, but doubly safe.
  return (
    typeof v.verdict === 'string' &&
    typeof v.severity === 'string' &&
    typeof v.confidence === 'number' &&
    typeof v.axis === 'string'
  );
}

/**
 * In-process cache wrapper. One instance per probe run; tracks hits/misses
 * for the report. Uses the BrainEngine's persistent backing.
 */
export class JudgeCache {
  private hits = 0;
  private misses = 0;
  private engine: BrainEngine;
  private modelId: string;
  private ttlSeconds: number;
  private disabled: boolean;

  constructor(opts: {
    engine: BrainEngine;
    modelId: string;
    /** Default 30 days. Zero disables persistence (in-memory only via miss-write skip). */
    ttlSeconds?: number;
    /** If true, never read or write — every call is a miss. */
    disabled?: boolean;
  }) {
    this.engine = opts.engine;
    this.modelId = opts.modelId;
    this.ttlSeconds = opts.ttlSeconds ?? 30 * 86400;
    this.disabled = !!opts.disabled;
  }

  async lookup(textA: string, textB: string): Promise<JudgeVerdict | null> {
    if (this.disabled) {
      this.misses++;
      return null;
    }
    const key = buildCacheKey({ textA, textB, modelId: this.modelId });
    const raw = await this.engine.getContradictionCacheEntry(key);
    if (raw && isJudgeVerdict(raw)) {
      this.hits++;
      return raw;
    }
    this.misses++;
    return null;
  }

  async store(textA: string, textB: string, verdict: JudgeVerdict): Promise<void> {
    if (this.disabled) return;
    const key = buildCacheKey({ textA, textB, modelId: this.modelId });
    await this.engine.putContradictionCacheEntry({
      ...key,
      verdict: verdict as unknown as Record<string, unknown>,
      ttl_seconds: this.ttlSeconds,
    });
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hit_rate: total === 0 ? 0 : this.hits / total,
    };
  }
}
