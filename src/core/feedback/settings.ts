/**
 * Resolved `feedback.*` configuration with a short in-process cache per
 * engine, so the search hot path never pays a config read per query.
 */
import type { BrainEngine } from '../engine.ts';
import { engineCacheKey } from '../statement-deadline.ts';

export interface FeedbackSettings {
  /** Master switch: recording, ratings, answer ids and the ranking effect. */
  enabled: boolean;
  /** Write new learning (ratings and the citation signal). Off keeps applying learned weights. */
  learn: boolean;
  /** Ranking influence λ: multiplier range [1-λ, 1+λ]. 0 = no ranking effect. */
  influence: number;
  /** Learn from think/synthesize citations (trusted local callers only). */
  implicit: boolean;
  /** Learning rate of the moving average; implicit signals use half. */
  alpha: number;
  maxRatingsPerHour: number;
  eventRetentionDays: number;
  /** Show the one-line "how to rate" line on answers. */
  ratingPrompt: boolean;
}

export const FEEDBACK_DEFAULTS: FeedbackSettings = Object.freeze({
  enabled: false,
  learn: true,
  influence: 0.1,
  implicit: false,
  alpha: 0.1,
  maxRatingsPerHour: 120,
  eventRetentionDays: 30,
  ratingPrompt: true,
});

export const FEEDBACK_CONFIG_KEYS = [
  'feedback.enabled',
  'feedback.learn',
  'feedback.influence',
  'feedback.implicit',
  'feedback.alpha',
  'feedback.max_ratings_per_hour',
  'feedback.event_retention_days',
  'feedback.rating_prompt',
] as const;

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<object, { ts: number; value: FeedbackSettings }>();

function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(v)) return true;
  if (['false', '0', 'off', 'no'].includes(v)) return false;
  return fallback;
}

function parseNumber(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function loadFeedbackSettings(engine: BrainEngine): Promise<FeedbackSettings> {
  const now = Date.now();
  const key = engineCacheKey(engine);
  const cached = cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.value;
  const read = async (key: string): Promise<string | null> => {
    try {
      return await engine.getConfig(key);
    } catch {
      return null;
    }
  };
  const [enabled, learn, influence, implicit, alpha, maxRatings, retention, ratingPrompt] = await Promise.all(
    FEEDBACK_CONFIG_KEYS.map(read),
  );
  const d = FEEDBACK_DEFAULTS;
  const value: FeedbackSettings = {
    enabled: parseBool(enabled, d.enabled),
    learn: parseBool(learn, d.learn),
    influence: parseNumber(influence, d.influence, 0, 0.5),
    implicit: parseBool(implicit, d.implicit),
    alpha: parseNumber(alpha, d.alpha, 0.001, 1),
    maxRatingsPerHour: Math.round(parseNumber(maxRatings, d.maxRatingsPerHour, 1, 100_000)),
    eventRetentionDays: Math.round(parseNumber(retention, d.eventRetentionDays, 1, 3650)),
    ratingPrompt: parseBool(ratingPrompt, d.ratingPrompt),
  };
  cache.set(key, { ts: now, value });
  return value;
}

/** λ actually applied to ranking: 0 whenever the feature is off. */
export function effectiveInfluence(s: FeedbackSettings): number {
  return s.enabled ? s.influence : 0;
}

export function _resetFeedbackSettingsCacheForTests(): void {
  cache = new WeakMap();
}
