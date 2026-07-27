/**
 * DB-contention pacing mode bundles (paced-backfill internals).
 *
 * Named modes that bundle the DB-pacer knobs into a single config key so an
 * operator picks once and stops thinking about it. Mirrors the v0.32.3
 * search-mode pattern at `src/core/search/mode.ts` (named bundle + per-key
 * overrides + per-call opts), with ONE deliberate difference: the resolution
 * chain puts ENV ABOVE CONFIG so `GBRAIN_PACE_*` is a real incident escape
 * hatch — an operator can override bad production config without a redeploy.
 *
 *   per-call flag → GBRAIN_PACE_* env → config (pace.*) → MODE_BUNDLES[mode] → off
 *
 * `DEFAULT_PACE_MODE` is `'off'`: pacing is strictly opt-in and never changes
 * default behavior. `off` resolves to `enabled: false`, which the DB-pacer
 * turns into a no-op (unbounded concurrency, zero sleeps).
 *
 * This module is PURE — no DB calls, no env reads inside `resolvePaceMode`.
 * The caller pre-loads config (`loadPaceModeConfig`) and env (`readPaceEnv`)
 * and passes them in, so the resolver is trivially testable.
 */

export type PaceMode = 'off' | 'gentle' | 'balanced' | 'aggressive';

export const PACE_MODES: ReadonlyArray<PaceMode> = Object.freeze([
  'off',
  'gentle',
  'balanced',
  'aggressive',
]);

export const DEFAULT_PACE_MODE: PaceMode = 'off';

/**
 * A complete knob set for one pace mode. Every field is required so the bundle
 * is self-contained and per-key overrides are obvious diffs.
 */
export interface PaceBundle {
  /** Master switch. `false` ⇒ the DB-pacer is a no-op (off mode / PGLite). */
  enabled: boolean;
  /**
   * Primary lever: cap on simultaneous in-flight DB writes. For single-pool
   * paths (embed) this becomes the worker count; for multi-pool paths (sync)
   * it's enforced by the shared `acquire()` permit. The real defense against
   * pooler-slot starvation.
   */
  maxConcurrency: number;
  /** EWMA of observed DB-op latency (ms) above which `pace()` starts sleeping. */
  paceAtMs: number;
  /** Ceiling on a single cooperative sleep (ms). Jittered downward per call. */
  maxSleepMs: number;
  /** EWMA smoothing factor in (0, 1]. Higher = reacts faster to recent latency. */
  ewmaAlpha: number;
}

/**
 * The four bundles. Frozen at import so a typo can't redefine "balanced" to
 * mean different things on different installs. `off` is the disabled sentinel;
 * its numeric fields are inert (the pacer short-circuits on `enabled: false`).
 *
 * Concurrency picks are deliberately well below the default embed concurrency
 * (`GBRAIN_EMBED_CONCURRENCY`, 20) — the whole point is to hold fewer pooler
 * slots than an unpaced run.
 */
export const PACE_BUNDLES: Readonly<Record<PaceMode, Readonly<PaceBundle>>> = Object.freeze({
  off: Object.freeze({
    enabled: false,
    maxConcurrency: 0,
    paceAtMs: 0,
    maxSleepMs: 0,
    ewmaAlpha: 0,
  }),
  gentle: Object.freeze({
    enabled: true,
    maxConcurrency: 4,
    paceAtMs: 250,
    maxSleepMs: 2000,
    ewmaAlpha: 0.3,
  }),
  balanced: Object.freeze({
    enabled: true,
    maxConcurrency: 8,
    paceAtMs: 500,
    maxSleepMs: 1500,
    ewmaAlpha: 0.3,
  }),
  aggressive: Object.freeze({
    enabled: true,
    maxConcurrency: 16,
    paceAtMs: 1000,
    maxSleepMs: 1000,
    ewmaAlpha: 0.3,
  }),
});

export function isPaceMode(x: unknown): x is PaceMode {
  return typeof x === 'string' && (PACE_MODES as ReadonlyArray<string>).includes(x);
}

/**
 * Per-key overrides (from the config table OR from env). Every field optional;
 * undefined ⇒ fall through to the next precedence layer.
 */
export interface PaceKeyOverrides {
  enabled?: boolean;
  maxConcurrency?: number;
  paceAtMs?: number;
  maxSleepMs?: number;
  ewmaAlpha?: number;
}

/**
 * Resolve the active pace knob set. Pure: the caller supplies the resolved
 * config + env layers.
 *
 * Mode precedence:  perCallMode → envMode → mode(config) → DEFAULT_PACE_MODE
 * Knob precedence:  perCall → env → config → MODE_BUNDLES[mode]
 *
 * Env above config is intentional (incident escape hatch — see file header).
 */
export interface ResolvePaceModeInput {
  /** `config.pace.mode`. */
  mode?: string;
  /** `GBRAIN_PACE_MODE`. */
  envMode?: string;
  /** `--pace=<mode>` (or bare `--pace` resolved to 'balanced' by the caller). */
  perCallMode?: string;
  /** Per-key overrides from the config table. */
  configOverrides?: PaceKeyOverrides;
  /** Per-key overrides from `GBRAIN_PACE_*` env. */
  envOverrides?: PaceKeyOverrides;
  /** Per-call overrides (e.g. `--pace-max-concurrency`). */
  perCall?: PaceKeyOverrides;
}

export interface ResolvedPaceKnobs extends PaceBundle {
  /** Which bundle supplied the defaults (after fallback). */
  resolved_mode: PaceMode;
  /** True if the resolved mode string was a recognized PaceMode. */
  mode_valid: boolean;
}

export function resolvePaceMode(input: ResolvePaceModeInput): ResolvedPaceKnobs {
  const rawMode =
    firstString(input.perCallMode) ?? firstString(input.envMode) ?? firstString(input.mode);
  const normalized = rawMode ? rawMode.trim().toLowerCase() : '';
  const valid = isPaceMode(normalized);
  const resolved_mode: PaceMode = valid ? (normalized as PaceMode) : DEFAULT_PACE_MODE;
  const bundle = PACE_BUNDLES[resolved_mode];

  const pc = input.perCall ?? {};
  const env = input.envOverrides ?? {};
  const cfg = input.configOverrides ?? {};

  const pick = <K extends keyof PaceBundle>(key: K): PaceBundle[K] => {
    if (pc[key] !== undefined) return pc[key] as PaceBundle[K];
    if (env[key] !== undefined) return env[key] as PaceBundle[K];
    if (cfg[key] !== undefined) return cfg[key] as PaceBundle[K];
    return bundle[key];
  };

  const enabled = pick('enabled');
  // Clamp to safe ranges so a fat-fingered override can't disable the cap
  // (maxConcurrency must be >= 1 when enabled) or wedge the EWMA.
  let maxConcurrency = pick('maxConcurrency');
  if (enabled && (!Number.isFinite(maxConcurrency) || maxConcurrency < 1)) {
    maxConcurrency = bundle.enabled ? bundle.maxConcurrency : 8;
  }
  let ewmaAlpha = pick('ewmaAlpha');
  if (!Number.isFinite(ewmaAlpha) || ewmaAlpha <= 0 || ewmaAlpha > 1) {
    ewmaAlpha = bundle.enabled ? bundle.ewmaAlpha : 0.3;
  }
  const paceAtMs = Math.max(0, pick('paceAtMs'));
  const maxSleepMs = Math.max(0, pick('maxSleepMs'));

  return {
    enabled,
    maxConcurrency,
    paceAtMs,
    maxSleepMs,
    ewmaAlpha,
    resolved_mode,
    mode_valid: valid,
  };
}

function firstString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Config-table key for the mode selection (separate from the override keys). */
export const PACE_MODE_KEY = 'pace.mode';

/** Per-knob config keys this module reads. Used by a future `--reset`. */
export const PACE_MODE_CONFIG_KEYS: ReadonlyArray<string> = Object.freeze([
  'pace.enabled',
  'pace.max_concurrency',
  'pace.pace_at_ms',
  'pace.max_sleep_ms',
  'pace.ewma_alpha',
]);

/** Build PaceKeyOverrides from a flat config-table snapshot (sparse). */
export function loadOverridesFromConfig(
  configMap: Record<string, string | undefined>,
): PaceKeyOverrides {
  return parseOverrides((k) => configMap[k], {
    enabled: 'pace.enabled',
    maxConcurrency: 'pace.max_concurrency',
    paceAtMs: 'pace.pace_at_ms',
    maxSleepMs: 'pace.max_sleep_ms',
    ewmaAlpha: 'pace.ewma_alpha',
  });
}

/** Build PaceKeyOverrides from `GBRAIN_PACE_*` env (incident escape hatch). */
export function readPaceEnv(env: Record<string, string | undefined> = process.env): {
  envMode?: string;
  envOverrides: PaceKeyOverrides;
} {
  const overrides = parseOverrides((k) => env[k], {
    enabled: 'GBRAIN_PACE_ENABLED',
    maxConcurrency: 'GBRAIN_PACE_MAX_CONCURRENCY',
    paceAtMs: 'GBRAIN_PACE_AT_MS',
    maxSleepMs: 'GBRAIN_PACE_MAX_SLEEP_MS',
    ewmaAlpha: 'GBRAIN_PACE_EWMA_ALPHA',
  });
  return { envMode: env.GBRAIN_PACE_MODE, envOverrides: overrides };
}

function parseOverrides(
  get: (k: string) => string | undefined,
  keys: Record<keyof PaceKeyOverrides, string>,
): PaceKeyOverrides {
  const out: PaceKeyOverrides = {};
  const en = get(keys.enabled);
  if (en !== undefined) out.enabled = en === '1' || en.toLowerCase() === 'true';
  const mc = get(keys.maxConcurrency);
  if (mc !== undefined) {
    const n = parseInt(mc, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 256) out.maxConcurrency = n;
  }
  const pa = get(keys.paceAtMs);
  if (pa !== undefined) {
    const n = parseInt(pa, 10);
    if (Number.isFinite(n) && n >= 0) out.paceAtMs = n;
  }
  const ms = get(keys.maxSleepMs);
  if (ms !== undefined) {
    const n = parseInt(ms, 10);
    if (Number.isFinite(n) && n >= 0) out.maxSleepMs = n;
  }
  const ea = get(keys.ewmaAlpha);
  if (ea !== undefined) {
    const n = parseFloat(ea);
    if (Number.isFinite(n) && n > 0 && n <= 1) out.ewmaAlpha = n;
  }
  return out;
}

/**
 * Load the live pace config (mode + per-key overrides) from the brain engine.
 * Errors swallowed → mode-bundle defaults (the config table may predate this
 * feature on old brains). Does NOT read env — the caller layers `readPaceEnv`
 * on top so env can beat config.
 */
export async function loadPaceModeConfig(engine: {
  getConfig(key: string): Promise<string | null>;
}): Promise<{ mode?: string; configOverrides: PaceKeyOverrides }> {
  const safeGet = async (k: string): Promise<string | undefined> => {
    try {
      const v = await engine.getConfig(k);
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const [mode, ...vals] = await Promise.all([
    safeGet(PACE_MODE_KEY),
    ...PACE_MODE_CONFIG_KEYS.map(safeGet),
  ]);
  const configMap: Record<string, string | undefined> = {};
  PACE_MODE_CONFIG_KEYS.forEach((key, i) => {
    if (vals[i] !== undefined) configMap[key] = vals[i];
  });
  return { mode, configOverrides: loadOverridesFromConfig(configMap) };
}
