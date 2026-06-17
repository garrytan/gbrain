export type DecayClass = 'slow' | 'medium' | 'fast';

export interface FreshnessMeta {
  last_verified_at: string;
  decay_class: DecayClass;
  source_precision: 'high' | 'medium' | 'low';
  confidence: number;
  stale_after_days: number;
}

export type FreshnessStatus = 'fresh' | 'aging' | 'stale';
