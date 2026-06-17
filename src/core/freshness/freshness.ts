import type { DecayClass, FreshnessMeta, FreshnessStatus } from './types.ts';

export function computeFreshness(meta: FreshnessMeta): { status: FreshnessStatus; days_since_verified: number } {
  const lastVerified = new Date(meta.last_verified_at).getTime();
  if (isNaN(lastVerified)) {
    throw new Error(`Invalid last_verified_at date: ${meta.last_verified_at}`);
  }
  const now = Date.now();
  const msSinceVerified = now - lastVerified;
  const daysSinceVerified = msSinceVerified / (1000 * 60 * 60 * 24);

  const threshold = meta.stale_after_days;

  let status: FreshnessStatus;
  if (daysSinceVerified < 0.5 * threshold) {
    status = 'fresh';
  } else if (daysSinceVerified <= threshold) {
    status = 'aging';
  } else {
    status = 'stale';
  }

  return { status, days_since_verified: daysSinceVerified };
}

const TYPE_DECAY_MAP: Record<string, DecayClass> = {
  decision: 'slow',
  meeting: 'medium',
  status: 'fast',
  deal: 'fast',
};

export function getDecayClassForType(pageType: string): DecayClass {
  return TYPE_DECAY_MAP[pageType] ?? 'medium';
}

const DECAY_STALE_DAYS: Record<DecayClass, number> = {
  slow: 365,
  medium: 90,
  fast: 30,
};

export function getDefaultStaleDays(decayClass: DecayClass): number {
  return DECAY_STALE_DAYS[decayClass];
}

interface SourcePrecision {
  source_precision: 'high' | 'medium' | 'low';
  confidence: number;
}

const SOURCE_PRECISION_MAP: Record<string, SourcePrecision> = {
  voice: { source_precision: 'low', confidence: 0.6 },
  meeting: { source_precision: 'low', confidence: 0.6 },
  document: { source_precision: 'medium', confidence: 0.8 },
  email: { source_precision: 'medium', confidence: 0.8 },
  linkedin: { source_precision: 'high', confidence: 0.9 },
  manual: { source_precision: 'high', confidence: 0.9 },
};

export function getSourcePrecision(source: string): SourcePrecision {
  return SOURCE_PRECISION_MAP[source] ?? { source_precision: 'medium', confidence: 0.8 };
}
