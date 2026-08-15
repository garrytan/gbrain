/**
 * Spend posture + USD-limit parsing — the single spend-control surface for
 * gbrain's cost gates (issue #2139). Two concerns live here:
 *
 *  1. `spend.posture` (DB-plane config): `'gated'` (default) makes every cost
 *     gate behave as before; `'tokenmax'` makes them INFORMATIONAL — print the
 *     estimate, proceed, and keep ledgering spend. The operator who sets
 *     `tokenmax` has declared "cost is not my constraint." Posture removes the
 *     CEILING, never the ACCOUNTING (the spend ledger still records every
 *     dollar). It is deliberately SEPARATE from `search.mode=tokenmax` (which
 *     governs retrieval payload size, not embedding spend); the gate prints a
 *     hint linking the two when only the search mode is set.
 *
 *  2. `parseUsdLimit` / `formatUsdLimit`: first-class `off` / `unlimited` /
 *     `none` on the USD gate knobs (so operators stop setting sentinel values
 *     like `100000`). The parse layer represents "no limit" as `Infinity` so
 *     comparisons stay special-case-free (`cost > Infinity` is never true).
 *     `formatUsdLimit` renders it as the string `'unlimited'` — NEVER serialize
 *     raw `Infinity`, because `JSON.stringify(Infinity)` emits `null`, which is
 *     ambiguous in audit/ledger rows. At the budget-machinery boundary, callers
 *     convert `Infinity` → `undefined` ("no cap"), which `BudgetTracker` already
 *     treats as cap-absent.
 *
 * LEAF module: imports only the engine type so any cost-gate site can pull it
 * in without a circular dependency.
 */
import type { BrainEngine } from './engine.ts';

export const SPEND_POSTURE_CONFIG_KEY = 'spend.posture';

export type SpendPosture = 'gated' | 'tokenmax';

/**
 * Resolve `spend.posture` from DB-plane config. Fail-open to `'gated'` on a
 * missing/unknown value or a config-read error — a posture probe must never
 * crash a sync, and an unrecognized value must never silently disable gates.
 */
export async function resolveSpendPosture(engine: BrainEngine): Promise<SpendPosture> {
  try {
    const raw = await engine.getConfig(SPEND_POSTURE_CONFIG_KEY);
    return normalizeSpendPosture(raw);
  } catch {
    return 'gated';
  }
}

/** Pure normalizer (testable without an engine). Anything but `tokenmax` → `gated`. */
export function normalizeSpendPosture(raw: unknown): SpendPosture {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'tokenmax') return 'tokenmax';
  return 'gated';
}

/** True iff `raw` is a valid `spend.posture` value (for `config set` validation). */
export function isValidSpendPosture(raw: unknown): boolean {
  return typeof raw === 'string' && ['gated', 'tokenmax'].includes(raw.trim().toLowerCase());
}

const OFF_TOKENS = new Set(['off', 'unlimited', 'none']);

/**
 * Parse a USD-limit config value.
 *   - `'off'` / `'unlimited'` / `'none'` (case-insensitive) → `Infinity` (no limit)
 *   - a finite positive number (or `0` when `allowZero`) → that number
 *   - anything else (garbage, negative, empty, NaN) → `def`
 *
 * `allowZero` distinguishes the two knob semantics:
 *   - `sync.cost_gate_min_usd` uses `allowZero: true` — `0` means "block on any
 *     nonzero spend" (a real operator choice). `off` is the no-limit escape.
 *   - the backfill caps reject `0` (fall back to the default); only `off`
 *     disables them. `off` semantics ≠ `0` (issue #2139).
 */
export function parseUsdLimit(
  raw: unknown,
  def: number,
  opts: { allowZero?: boolean } = {},
): number {
  if (raw === null || raw === undefined) return def;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === '') return def;
    if (OFF_TOKENS.has(t)) return Infinity;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n < 0) return def;
  if (n === 0) return opts.allowZero ? 0 : def;
  return n;
}

/**
 * Render a USD limit for human/JSON output. `Infinity` → `'unlimited'` (NEVER
 * the raw value — `JSON.stringify(Infinity)` is `null`). Finite values are
 * returned as-is so callers can `$${formatUsdLimit(x)}` or embed in JSON.
 */
export function formatUsdLimit(n: number): string | number {
  return Number.isFinite(n) ? n : 'unlimited';
}

/**
 * Convert a parsed USD limit to the budget-machinery cap representation:
 * `Infinity` → `undefined` ("no cap", which `BudgetTracker` treats as
 * cap-absent), finite → the number. Keeps `null` out of ledger rows.
 */
export function usdLimitToCap(n: number): number | undefined {
  return Number.isFinite(n) ? n : undefined;
}
