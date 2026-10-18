/**
 * The explicit-lane cosine supersession threshold, per embedding model.
 *
 * A new fact whose closest eligible candidate scores at or above this cosine
 * replaces (or deduplicates against) it. The cutoff is a property of the
 * embedding model: the C2 follow-up eval (docs/eval/decisions/
 * supersession-threshold-dev) found 0.95 to be the guarded optimum for
 * voyage-4 at 1024 dimensions, while for openai text-embedding-3-large no
 * threshold separates corrections from coexisting claims (at 0.95 it
 * replaced 54% of new coexisting claims). So the threshold is looked up by
 * `provider:model@dims`, and a model with no calibrated entry does not
 * supersede by cosine at all: the new fact is inserted, and the conflict
 * review sweep (decide slot `conflict`, where enabled) judges the pair.
 * Exact-text duplicates (`gbrain_fact_fingerprint`) are decided before any
 * cosine and are unaffected.
 *
 * Operators register a measured value without a release:
 *   gbrain config set facts.supersession_thresholds '{"openai:text-embedding-3-large@1536": 0.97}'
 * A value of "off" disables cosine supersession for a calibrated model.
 */
export const SUPERSESSION_THRESHOLDS_KEY = 'facts.supersession_thresholds';

/** Measured thresholds, keyed `provider:model@dims`. Add a row only with an eval behind it. */
export const SUPERSESSION_CALIBRATIONS: Readonly<Record<string, { threshold: number; evidence: string }>> = {
  'voyage:voyage-4@1024': { threshold: 0.95, evidence: 'docs/eval/decisions/supersession-threshold-dev' },
};

export type SupersessionThresholdSource = 'calibrated' | 'override' | 'uncalibrated';

export interface SupersessionThreshold {
  /** `provider:model@dims`, the table and override key. */
  key: string;
  /** Null: this model never supersedes by cosine. */
  threshold: number | null;
  source: SupersessionThresholdSource;
}

export function calibrationKey(model: string | null | undefined, dims: number): string {
  return `${(model ?? '').trim().toLowerCase()}@${dims}`;
}

/** `{ "<provider:model@dims>": number in (0, 1] | "off" }`; malformed JSON or values are ignored. */
export function parseThresholdOverrides(raw: string | null | undefined): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (v === 'off') out.set(key, null);
    else if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) out.set(key, v);
  }
  return out;
}

export function resolveSupersessionThreshold(model: string | null | undefined, dims: number, overrides: Map<string, number | null> = new Map()): SupersessionThreshold {
  const key = calibrationKey(model, dims);
  if (overrides.has(key)) return { key, threshold: overrides.get(key)!, source: 'override' };
  const calibrated = SUPERSESSION_CALIBRATIONS[key];
  return calibrated ? { key, threshold: calibrated.threshold, source: 'calibrated' } : { key, threshold: null, source: 'uncalibrated' };
}

/** The threshold for this brain's facts embedded with `model` at `dims`; config errors read as no overrides. */
export async function readSupersessionThreshold(
  engine: { getConfig(key: string): Promise<string | null> },
  model: string | null | undefined,
  dims: number,
): Promise<SupersessionThreshold> {
  const raw = await engine.getConfig(SUPERSESSION_THRESHOLDS_KEY).catch(() => null);
  return resolveSupersessionThreshold(model, dims, parseThresholdOverrides(raw));
}
