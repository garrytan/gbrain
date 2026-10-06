/**
 * decide.* config keys: the registry `gbrain config set` validates against,
 * and the typed reader every decide surface uses. All keys are DB-plane.
 *
 * Key-aware defaults (owner decision 2026-10-01): with no TypeSafe key every
 * slot defaults off. With a key, the measured winners (`recommendedSlots` for
 * the pinned Jev model: the same set `enable --recommended` turns on) default
 * on with that provider and their reference calibrations, and the key counts
 * as the egress opt-in for the data those slots send. Nothing is written to
 * config. Any explicit setting wins: the slot's mode or provider, an explicit
 * decide.provider none, decide.egress.private deny, or a deny on one of the
 * slot's consent keys. Eval runs never get key defaults; their arms say
 * exactly which slots are on.
 */
import { recommendedSlots } from './reference-calibrations.ts';
import { SLOT_SPECS } from './slots.ts';
import { DECIDE_SLOTS, EVIDENCE_CLASSES, type DecideMode, type DecideSlot, type EvidenceClass } from './types.ts';

export const DEFAULT_TYPESAFE_MODEL = 'jev-1.13.0';
export const DEFAULT_TYPESAFE_PROVIDER = `typesafe:${DEFAULT_TYPESAFE_MODEL}`;
export const TYPESAFE_ALIASES = ['jev-latest', 'jev-preview'] as const;
/** S6 suppression boundary default (decide.slots.recall_needed.suppress_below); 0.05 before 2026-09-30. */
export const RECALL_SUPPRESS_BELOW_DEFAULT = 0.1;

type Validator = (value: string) => string | null;

const oneOf = (...values: string[]): Validator => (v) => values.includes(v) ? null : `must be one of ${values.join(', ')}`;
const number = (min: number, max: number, integer = false): Validator => (v) => {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    return `must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`;
  }
  return null;
};
const bool: Validator = (v) => ['true', 'false', 'on', 'off', '1', '0', 'yes', 'no'].includes(v.trim().toLowerCase()) ? null : 'must be true or false';
const provider: Validator = (v) => isValidProvider(v) ? null : 'must be none, typesafe:<model> or llm:<provider:model>';
const fallback: Validator = (v) => v === 'none' || /^llm:[a-z0-9-]+:.+$/i.test(v) ? null : 'must be none or llm:<provider:model>';
const sourceList: Validator = (v) => {
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) && parsed.every((s) => typeof s === 'string') ? null : 'must be a JSON array of source ids';
  } catch { return 'must be a JSON array of source ids'; }
};
const calibrationRef: Validator = (v) => /^(local:\d+|ref:[a-z0-9._:-]+)$/i.test(v) ? null : 'must be local:<id> or ref:<id>';

export function isValidProvider(v: string): boolean {
  return v === 'none' || /^typesafe:jev-[a-z0-9.-]+$/i.test(v) || /^llm:[a-z0-9-]+:.+$/i.test(v);
}

const GLOBAL_KEYS: Record<string, Validator> = {
  'decide.provider': provider,
  'decide.egress_fallback': fallback,
  'decide.max_concurrency': number(1, 16, true),
  'decide.background_concurrency': number(1, 16, true),
  'decide.margin_floor': number(0, 0.5),
  'decide.timeout_ms': number(50, 60_000, true),
  'decide.query_budget_ms': number(50, 60_000, true),
  'decide.budget.daily_usd': number(0, 1000),
  'decide.budget.remote_share': number(0, 1),
  'decide.egress.private': oneOf('deny', 'allow'),
  'decide.egress.deny_sources': sourceList,
  'decide.receipts.retention_days': number(1, 365, true),
  'decide.calibrate.retest_n': number(0, 1000, true),
  'decide.slots.conflict.proposal_floor': number(0, 1),
  'decide.slots.conflict.review_withdraw': bool,
  'decide.slots.conflict.review_duplicate_page': bool,
  'decide.slots.conflict.review_duplicate_entity': bool,
  'decide.slots.intent.wait_ms': number(0, 2000, true),
  'decide.slots.recall_needed.suppress_below': number(0, 1),
  ...Object.fromEntries(EVIDENCE_CLASSES.map((c) => [`decide.egress.typesafe.${c}`, oneOf('deny', 'allow')])),
};

const SLOT_KEY_VALIDATORS: Record<string, Validator> = {
  mode: oneOf('off', 'on', 'shadow'),
  provider,
  threshold: number(0, 1),
  min_keep: number(0, 100, true),
  force_on: bool,
  min_action_precision: number(0, 1),
  shadow_sample: number(0, 1),
  shadow_wait: oneOf('on', 'off'),
  calibration: calibrationRef,
};

/** Every registered decide.* key (for `config set` suggestions and docs). */
export const DECIDE_CONFIG_KEYS: readonly string[] = [
  ...Object.keys(GLOBAL_KEYS),
  ...DECIDE_SLOTS.flatMap((slot) => Object.keys(SLOT_KEY_VALIDATORS).map((k) => `decide.slots.${slot}.${k}`)),
];

/** Validation error text for a decide.* key/value, or null when valid. Unknown decide.* keys are errors. */
export function validateDecideConfigValue(key: string, value: string): string | null {
  const global = GLOBAL_KEYS[key];
  if (global) {
    const err = global(value);
    return err ? `${key} ${err} (got '${value}')` : null;
  }
  const m = /^decide\.slots\.([a-z_]+)\.([a-z_]+)$/.exec(key);
  if (m && (DECIDE_SLOTS as readonly string[]).includes(m[1]!) && SLOT_KEY_VALIDATORS[m[2]!]) {
    const err = SLOT_KEY_VALIDATORS[m[2]!]!(value);
    return err ? `${key} ${err} (got '${value}')` : null;
  }
  return `${key} is not a decide key. Known slots: ${DECIDE_SLOTS.join(', ')}; see gbrain decide status`;
}

export interface DecideSlotConfig {
  mode: DecideMode;
  /** Resolved provider: slot override, else decide.provider. */
  provider: string;
  threshold?: number;
  minKeep?: number;
  forceOn: boolean;
  minActionPrecision: number;
  shadowSample?: number;
  shadowWait: boolean;
  /** Adopted calibration (`local:<id>` / `ref:<id>`), recorded by enable/adopt. */
  calibration?: string;
  /** S6 only: suppress reflex injection below this probability (decide.slots.recall_needed.suppress_below). */
  suppressBelow?: number;
  /** On by the key-aware default (no explicit setting); the key is this slot's egress opt-in. */
  keyDefault?: true;
}

export interface DecideConfig {
  provider: string;
  egressFallback: string;
  maxConcurrency: number;
  backgroundConcurrency: number;
  marginFloor: number;
  timeoutMs: number;
  queryBudgetMs: number;
  dailyUsd: number;
  remoteShare: number;
  egressPrivate: 'deny' | 'allow';
  denySources: string[];
  consent: Record<EvidenceClass, boolean>;
  retentionDays: number;
  retestN: number;
  /** S2: how long hybridSearch waits for the intent answer (decide.slots.intent.wait_ms). */
  intentWaitMs: number;
  slots: Record<DecideSlot, DecideSlotConfig>;
  /** GBRAIN_DECIDE_SLOTS eval override, honored only when the caller opts in. */
  evalOverride?: string;
}

const num = (raw: string | undefined, fallbackValue: number, validator: Validator): number =>
  raw !== undefined && validator(raw) === null ? Number(raw) : fallbackValue;

const truthy = (raw: string | undefined): boolean => raw !== undefined && ['true', 'on', '1', 'yes'].includes(raw.trim().toLowerCase());

/**
 * Typed decide config from a flat config snapshot (engine.getAllConfig()).
 * Invalid stored values fall back to defaults (config set validates on write).
 * `evalSlots` applies a GBRAIN_DECIDE_SLOTS override (`triage=on,evidence=shadow`);
 * only eval commands pass it, and it never bypasses consent, egress or the daily cap.
 */
let evalOverrideEnabled = false;

/** Eval commands (and `dream --eval-run`) opt in to GBRAIN_DECIDE_SLOTS for this process. */
export function enableDecideEvalOverride(enabled = true): void {
  evalOverrideEnabled = enabled;
}

function processEvalSlots(): string | undefined {
  return evalOverrideEnabled ? process.env.GBRAIN_DECIDE_SLOTS || undefined : undefined;
}

/** The decide.* subset of a config snapshot, or undefined when there is nothing to read (all-off fast path). */
export function pickDecideConfig(snapshot: Record<string, string | undefined> | null | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot ?? {})) if (k.startsWith('decide.') && typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 || processEvalSlots() ? out : undefined;
}

/**
 * `typesafeKey`: a TypeSafe key is present (hasTypesafeKey() in index.ts). Omitted
 * means keyless: every slot without an explicit mode is off.
 */
export function readDecideConfig(snapshot: Record<string, string | undefined> | null, opts: { evalSlots?: string; typesafeKey?: boolean } = {}): DecideConfig {
  const get = (k: string): string | undefined => snapshot?.[k] ?? undefined;
  const evalSlots = opts.evalSlots ?? processEvalSlots();
  const globalProvider = get('decide.provider');
  const providerValue = globalProvider && isValidProvider(globalProvider) ? globalProvider : 'none';
  const evalModes = parseEvalSlots(evalSlots);
  const keyDefaultsApply = opts.typesafeKey === true && !evalOverrideEnabled && !evalSlots && globalProvider !== 'none' && get('decide.egress.private') !== 'deny';
  const slots = Object.fromEntries(DECIDE_SLOTS.map((slot) => {
    const k = (name: string) => get(`decide.slots.${slot}.${name}`);
    const minActionPrecision = num(k('min_action_precision'), 0.9, SLOT_KEY_VALIDATORS.min_action_precision!);
    const slotProvider = k('provider');
    const keyDefault = keyDefaultsApply && k('mode') === undefined && (slotProvider === undefined || slotProvider === DEFAULT_TYPESAFE_PROVIDER)
      && SLOT_SPECS[slot].egressClasses.every((c) => get(`decide.egress.typesafe.${c}`) !== 'deny')
      && recommendedSlots(DEFAULT_TYPESAFE_PROVIDER, () => minActionPrecision).includes(slot);
    const rawMode = keyDefault ? 'on' : evalModes[slot] ?? k('mode');
    const mode: DecideMode = rawMode === 'on' || rawMode === 'shadow' ? rawMode : 'off';
    const threshold = k('threshold');
    const minKeep = k('min_keep');
    const sample = k('shadow_sample');
    const cfg: DecideSlotConfig = {
      mode,
      provider: keyDefault ? DEFAULT_TYPESAFE_PROVIDER : slotProvider && isValidProvider(slotProvider) ? slotProvider : providerValue,
      ...(threshold !== undefined && SLOT_KEY_VALIDATORS.threshold!(threshold) === null ? { threshold: Number(threshold) } : {}),
      ...(minKeep !== undefined && SLOT_KEY_VALIDATORS.min_keep!(minKeep) === null ? { minKeep: Number(minKeep) } : {}),
      forceOn: truthy(k('force_on')),
      minActionPrecision,
      ...(sample !== undefined && SLOT_KEY_VALIDATORS.shadow_sample!(sample) === null ? { shadowSample: Number(sample) } : {}),
      shadowWait: k('shadow_wait') === 'on',
      ...(k('calibration') && calibrationRef(k('calibration')!) === null ? { calibration: k('calibration') } : {}),
      ...(slot === 'recall_needed' ? { suppressBelow: num(k('suppress_below'), RECALL_SUPPRESS_BELOW_DEFAULT, GLOBAL_KEYS['decide.slots.recall_needed.suppress_below']!) } : {}),
      ...(keyDefault ? { keyDefault: true as const } : {}),
    };
    return [slot, cfg];
  })) as Record<DecideSlot, DecideSlotConfig>;
  let denySources: string[] = [];
  try {
    const raw = get('decide.egress.deny_sources');
    if (raw && sourceList(raw) === null) denySources = JSON.parse(raw);
  } catch { /* invalid stored value: no denials beyond the private rule */ }
  const fb = get('decide.egress_fallback');
  return {
    provider: providerValue,
    egressFallback: fb && fallback(fb) === null ? fb : 'none',
    maxConcurrency: num(get('decide.max_concurrency'), 16, GLOBAL_KEYS['decide.max_concurrency']!),
    backgroundConcurrency: num(get('decide.background_concurrency'), 4, GLOBAL_KEYS['decide.background_concurrency']!),
    marginFloor: num(get('decide.margin_floor'), 0.05, GLOBAL_KEYS['decide.margin_floor']!),
    timeoutMs: num(get('decide.timeout_ms'), 1500, GLOBAL_KEYS['decide.timeout_ms']!),
    queryBudgetMs: num(get('decide.query_budget_ms'), 1500, GLOBAL_KEYS['decide.query_budget_ms']!),
    dailyUsd: num(get('decide.budget.daily_usd'), 1, GLOBAL_KEYS['decide.budget.daily_usd']!),
    remoteShare: num(get('decide.budget.remote_share'), 0.5, GLOBAL_KEYS['decide.budget.remote_share']!),
    egressPrivate: get('decide.egress.private') === 'allow' ? 'allow' : 'deny',
    denySources,
    consent: Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, get(`decide.egress.typesafe.${c}`) === 'allow'])) as Record<EvidenceClass, boolean>,
    retentionDays: num(get('decide.receipts.retention_days'), 7, GLOBAL_KEYS['decide.receipts.retention_days']!),
    retestN: num(get('decide.calibrate.retest_n'), 50, GLOBAL_KEYS['decide.calibrate.retest_n']!),
    intentWaitMs: num(get('decide.slots.intent.wait_ms'), 250, GLOBAL_KEYS['decide.slots.intent.wait_ms']!),
    slots,
    ...(evalSlots ? { evalOverride: evalSlots } : {}),
  };
}

/** Parse a GBRAIN_DECIDE_SLOTS value (`triage=on,evidence=shadow`); unknown slots and modes are ignored. */
export function parseEvalSlots(raw: string | undefined): Partial<Record<DecideSlot, DecideMode>> {
  const out: Partial<Record<DecideSlot, DecideMode>> = {};
  for (const part of (raw ?? '').split(',')) {
    const [slot, mode] = part.split('=').map((s) => s.trim());
    if (slot && (DECIDE_SLOTS as readonly string[]).includes(slot) && (mode === 'on' || mode === 'off' || mode === 'shadow')) {
      out[slot as DecideSlot] = mode;
    }
  }
  return out;
}

/** True when every slot is off: callers skip all decide work (byte-identical all-off path). */
export function allSlotsOff(cfg: DecideConfig): boolean {
  return DECIDE_SLOTS.every((slot) => cfg.slots[slot].mode === 'off');
}

export function providerKind(provider: string): 'typesafe' | 'llm' | 'none' {
  if (provider.startsWith('typesafe:')) return 'typesafe';
  if (provider.startsWith('llm:')) return 'llm';
  return 'none';
}

export function isTypesafeAlias(provider: string): boolean {
  return (TYPESAFE_ALIASES as readonly string[]).includes(provider.replace(/^typesafe:/, ''));
}
