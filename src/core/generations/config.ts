/**
 * GBRA-161: the generation primitive's settings, their bounds and the one reader. `gbrain config set` refuses a value
 * out of range with the shared bound-refusal shape; a stored value that fails the bound (written before validation, or
 * by hand) reads as the default here, so a typo never widens a limit.
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';

interface Bound { key: string; min: number; max: number; fallback: number; integer: boolean; example: string }

export const GENERATION_BOUNDS = {
  restoreDays: { key: 'generations.restore_days', min: 3, max: 365, fallback: 30, integer: true, example: '30' },
  shrinkFloor: { key: 'generations.shrink_floor', min: 0.05, max: 1, fallback: 0.5, integer: false, example: '0.5' },
  maxItems: { key: 'generations.max_items', min: 8, max: 1024, fallback: 64, integer: true, example: '64' },
  valveMaxPerRun: { key: 'generations.valve.max_per_run', min: 1, max: 100_000, fallback: 500, integer: true, example: '500' },
  valveMaxRatio: { key: 'generations.valve.max_ratio', min: 0.01, max: 1, fallback: 0.5, integer: false, example: '0.5' },
} as const satisfies Record<string, Bound>;

export interface GenerationsConfig { restoreDays: number; shrinkFloor: number; maxItems: number; valveMaxPerRun: number; valveMaxRatio: number }

/** The refusal for a value outside its bound, or null when `key` is not a generations key or the value fits. */
export function generationsConfigRefusal(key: string, value: string): { message: string; example: string } | null {
  const bound = Object.values(GENERATION_BOUNDS).find(entry => entry.key === key);
  if (!bound) return null;
  return parseBound(bound, value) === null
    ? { message: `${key} must be ${bound.integer ? 'an integer' : 'a number'} from ${bound.min} to ${bound.max} (got "${value}"); nothing was written.`, example: bound.example }
    : null;
}

function parseBound(bound: Bound, raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!(bound.integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(text)) return null;
  const value = Number(text);
  return value >= bound.min && value <= bound.max ? value : null;
}

/** Last value read, so synchronous listings (repair notices, the remediation plan) print the configured restore window. */
let restoreDaysSeen: number = GENERATION_BOUNDS.restoreDays.fallback;
export function restoreDaysHint(): number { return restoreDaysSeen; }

/** Reads the five settings; a failed read keeps the default for that setting, the same as an out-of-range value. */
export async function readGenerationsConfig(engine: Pick<BrainEngine, 'getConfig'>): Promise<GenerationsConfig> {
  const read = async (bound: Bound) => parseBound(bound, await Promise.resolve().then(() => engine.getConfig(bound.key)).catch(() => null)) ?? bound.fallback;
  const config = { restoreDays: await read(GENERATION_BOUNDS.restoreDays), shrinkFloor: await read(GENERATION_BOUNDS.shrinkFloor),
    maxItems: await read(GENERATION_BOUNDS.maxItems), valveMaxPerRun: await read(GENERATION_BOUNDS.valveMaxPerRun), valveMaxRatio: await read(GENERATION_BOUNDS.valveMaxRatio) };
  restoreDaysSeen = config.restoreDays;
  return config;
}

/** The policy a held row binds: a changed floor, cap or valve setting lets an unchanged input be computed again. */
export function policyHash(config: GenerationsConfig): string {
  return digest(['generation-policy-v1', config.shrinkFloor, config.maxItems, config.valveMaxPerRun, config.valveMaxRatio]).slice(0, 16);
}

/**
 * SQL for the configured restore window in days, read inside the statement so the constant purge predicates
 * (derived-retirement-hold.ts) need no parameter: a missing or out-of-range stored value reads as the default.
 */
export const RESTORE_DAYS_SQL = `(SELECT COALESCE(MAX(CASE WHEN c.value ~ '^[0-9]{1,3}$' THEN CASE WHEN c.value::int BETWEEN ${GENERATION_BOUNDS.restoreDays.min} AND ${GENERATION_BOUNDS.restoreDays.max}
  THEN c.value::int END END), ${GENERATION_BOUNDS.restoreDays.fallback}) FROM config c WHERE c.key = '${GENERATION_BOUNDS.restoreDays.key}')`;
