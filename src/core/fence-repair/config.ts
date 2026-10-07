/**
 * #6188: fence settings. `fences.normalize` (default true, opt-out) lets
 * Tier 1 rewrite a fixable facts or takes fence on write paths; false
 * restores refusing (coordinated writers) or storing as written (legacy
 * importers). It is read only when a write actually has something to
 * normalize, so a clean write never pays the config read.
 *
 * `fences.repair.enabled` (default true, opt-out) lets the maintenance cycle's
 * `fence_repair` phase repair held and stored malformed fences; false pauses
 * it (an explicit `gbrain repair fences --apply` still runs).
 * `fences.repair.llm` (default true, opt-out) lets that repair send residual
 * fence rows to the configured chat model (Tier 3); false keeps it to the
 * free tiers everywhere and holds Tier 3 candidates with `llm_disabled`.
 *
 * `fences.repair.max_usd_per_page` (default $0.30) and
 * `fences.repair.max_usd_per_day` (default $1.00) cap model (Tier 3) fence
 * repair: per page, and per UTC day across every process through the daily
 * USD ledger. 0 means no Tier 3 spend. They are validated at `config set`
 * and shown by `gbrain doctor` (`fence_integrity`); the fence repair reads
 * them.
 */
import type { BrainEngine } from '../engine.ts';

export const FENCES_NORMALIZE_KEY = 'fences.normalize';
export const FENCE_REPAIR_ENABLED_KEY = 'fences.repair.enabled';
export const FENCE_REPAIR_LLM_KEY = 'fences.repair.llm';
export const FENCE_REPAIR_MAX_USD_PER_PAGE_KEY = 'fences.repair.max_usd_per_page';
export const FENCE_REPAIR_MAX_USD_PER_DAY_KEY = 'fences.repair.max_usd_per_day';
/** Defaults of the Tier 3 caps (USD). */
export const FENCE_REPAIR_DEFAULT_MAX_USD_PER_PAGE = 0.3;
export const FENCE_REPAIR_DEFAULT_MAX_USD_PER_DAY = 1;
const USD_KEYS: readonly string[] = [FENCE_REPAIR_MAX_USD_PER_PAGE_KEY, FENCE_REPAIR_MAX_USD_PER_DAY_KEY];
/** Every `fences.*` key `gbrain config set` accepts. */
export const FENCE_CONFIG_KEYS: readonly string[] = [FENCES_NORMALIZE_KEY, FENCE_REPAIR_ENABLED_KEY, FENCE_REPAIR_LLM_KEY, ...USD_KEYS];

const TRUE = /^(true|1|on|yes)$/i;
const FALSE = /^(false|0|off|no)$/i;

/** Null when the value is valid for the key; otherwise the refusal text (nothing is written). */
export function validateFenceConfigValue(key: string, value: string): string | null {
  if (!FENCE_CONFIG_KEYS.includes(key)) return `Unknown config key "${key}". fences keys: ${FENCE_CONFIG_KEYS.join(', ')}. Nothing was written.`;
  if (USD_KEYS.includes(key)) {
    return parseUsd(value) === null ? `${key} must be a non-negative USD amount such as 0.05 (0 means no model spend on fence repair; got "${value}"). Nothing was written.` : null;
  }
  if (TRUE.test(value.trim()) || FALSE.test(value.trim())) return null;
  return `${key} must be true or false (got "${value}"). Nothing was written.`;
}

function parseUsd(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const usd = Number(text);
  return Number.isFinite(usd) ? usd : null;
}

export interface FenceRepairCaps {
  perPageUsd: number;
  perDayUsd: number;
  /** `user` when the setting is stored, `default` otherwise (an unpriced model is refused only under a user cap). */
  perPageSource: 'user' | 'default';
  perDaySource: 'user' | 'default';
}

/** The Tier 3 caps; an unset or unreadable value keeps its default. */
export async function readFenceRepairCaps(engine: Pick<BrainEngine, 'getConfig'>): Promise<FenceRepairCaps> {
  const read = async (key: string): Promise<number | null> => {
    try {
      const value = await engine.getConfig(key);
      return typeof value === 'string' ? parseUsd(value) : null;
    } catch {
      return null;
    }
  };
  const [page, day] = await Promise.all([read(FENCE_REPAIR_MAX_USD_PER_PAGE_KEY), read(FENCE_REPAIR_MAX_USD_PER_DAY_KEY)]);
  return { perPageUsd: page ?? FENCE_REPAIR_DEFAULT_MAX_USD_PER_PAGE, perDayUsd: day ?? FENCE_REPAIR_DEFAULT_MAX_USD_PER_DAY,
    perPageSource: page === null ? 'default' : 'user', perDaySource: day === null ? 'default' : 'user' };
}

/** A boolean switch that is on unless explicitly set false; a config read error keeps it on. */
async function switchOn(engine: Pick<BrainEngine, 'getConfig'>, key: string): Promise<boolean> {
  try {
    const value = await engine.getConfig(key);
    return !(typeof value === 'string' && FALSE.test(value.trim()));
  } catch {
    return true;
  }
}

/** The effective switch: on unless explicitly set false. A config read error keeps the default (on). */
export function fencesNormalizeEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return switchOn(engine, FENCES_NORMALIZE_KEY);
}

/** `fences.repair.enabled`: the maintenance cycle repairs fences (default on). */
export function fenceRepairEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return switchOn(engine, FENCE_REPAIR_ENABLED_KEY);
}

/** `fences.repair.llm`: fence repair may call the chat model (Tier 3; default on). */
export function fenceRepairLlmEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return switchOn(engine, FENCE_REPAIR_LLM_KEY);
}
