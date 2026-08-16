/**
 * Param normalization + validation for MCP tool dispatch (WP3).
 *
 * Extracted from src/mcp/dispatch.ts so the branch-heavy validation logic has
 * a direct unit-test surface (amendment 12). Call order is load-bearing and
 * preserved from the dispatch layer: `normalizeOptionalParams` FIRST (absent
 * idioms become truly absent), THEN `validateParams` (types + enums), THEN
 * `findUnknownParams` (strict/warn unknown-key detection on the normalized
 * object — so a null/'' optional idiom is never mistaken for an unknown key).
 *
 * dispatch.ts re-exports `normalizeOptionalParams` and `validateParams` so
 * existing imports keep working.
 */

import type { Operation } from '../core/operations.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { suggestNearest } from '../core/levenshtein.ts';

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
      // WP3: enum membership is a TYPE error, enforced in BOTH strict modes
      // (warn and reject). The message names the declared values only — the
      // caller's raw value is never echoed (it can land in persistent logs
      // via the error_message column; declared values are safe by definition).
      if (def.enum && typeof val === 'string' && !def.enum.includes(val)) {
        return `Parameter "${key}" must be one of: ${def.enum.join(', ')}`;
      }
    }
  }
  return null;
}

/**
 * Normalize the absent-idioms real MCP clients send for OPTIONAL params
 * before validation and dispatch: `null` (any type) and `''` (string-typed
 * params) become "not provided".
 *
 * Why: non-Claude models routinely fill optional params with `""` or `null`
 * instead of omitting them. `validateParams` already reads null as absent
 * for the required-param check (see above); handlers do not — some guard
 * with `typeof p.x === 'string' && p.x.length > 0` (entity / session_id in
 * `recall`), others with `p.x !== undefined` (since in `recall`), so
 * `recall {since: ""}` silently returned zero facts where the same call
 * with `since` omitted returns rows. Normalizing once at the shared
 * dispatch layer gives every handler one canonical absence instead of
 * per-handler guards.
 *
 * Deliberately narrow:
 *   - Required params are untouched — null on a required param still fails
 *     validation loudly, and `''` on a required string still reaches the
 *     handler exactly as before.
 *   - Type-mismatched junk is untouched — `limit: ""` keeps its loud
 *     "must be a number" error rather than silently succeeding.
 *   - Undeclared keys are untouched (they were already ignored).
 * Copy-on-write: callers' param objects are never mutated.
 */
export function normalizeOptionalParams(op: Operation, params: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required) continue;
    const val = params[key];
    const isAbsentIdiom = val === null || (val === '' && def.type === 'string');
    if (!isAbsentIdiom) continue;
    if (out === null) out = { ...params };
    delete out[key];
  }
  return out ?? params;
}

// ---------------------------------------------------------------------------
// WP3 — strict/warn unknown-argument validation
// ---------------------------------------------------------------------------

/**
 * Top-level keys that are legitimate on ANY tool call without being declared
 * in the op's params: `_meta` is the MCP client metadata slot (several
 * clients fold it into `arguments`; dispatch reads `_meta.session_id` from
 * it), and `dry_run` is the contract-wide preview flag consumed by
 * buildOperationContext.
 */
export const UNKNOWN_PARAM_ALLOWLIST: ReadonlySet<string> = new Set(['_meta', 'dry_run']);

/**
 * `_meta.warnings` entry shape (amendment 13) — documented in
 * docs/protocol/MCP_META_CHANNELS.md. `suggestion` is the nearest DECLARED
 * param name when one is within edit distance; the candidates are ONLY the
 * op's declared params, so a suggestion can never leak another op's surface.
 */
export interface UnknownParamWarning {
  code: 'unknown_param';
  param: string;
  suggestion?: string;
}

/**
 * Detect submitted top-level keys the op does not declare. Runs on the
 * NORMALIZED params object (normalizeOptionalParams only deletes DECLARED
 * optional keys, so null/'' absent-idioms are never reported here).
 *
 * Privacy note (amendment 11 / C8 class): the raw unknown key names returned
 * here reach the CALLER (warn block, `_meta.warnings`, reject `suggestion`)
 * but must NEVER be written to `mcp_request_log` — the redacted summarizer
 * counts unknown keys without naming them, and the reject-mode envelope keeps
 * the raw key out of `message` (the one field serve-http persists to
 * error_message).
 */
export function findUnknownParams(op: Operation, params: Record<string, unknown>): UnknownParamWarning[] {
  const declared = Object.keys(op.params);
  const declaredSet = new Set(declared);
  const warnings: UnknownParamWarning[] = [];
  for (const key of Object.keys(params)) {
    if (declaredSet.has(key) || UNKNOWN_PARAM_ALLOWLIST.has(key)) continue;
    const nearest = suggestNearest(key, declared);
    warnings.push({ code: 'unknown_param', param: key, ...(nearest ? { suggestion: nearest } : {}) });
  }
  return warnings;
}

/**
 * Render the model-visible warn-mode notice lines (one per unknown key) that
 * dispatch appends as an extra text content block on the RESULT — the same
 * D8 second-block mechanism that carries empty-retrieval loudness, so the
 * grace period actually corrects clients instead of warning into a void.
 */
export function buildUnknownParamWarnBlock(warnings: UnknownParamWarning[]): string {
  return warnings
    .map(w => w.suggestion
      ? `warning: unknown parameter "${w.param}" ignored — did you mean "${w.suggestion}"? A future release rejects unknown parameters.`
      : `warning: unknown parameter "${w.param}" ignored. A future release rejects unknown parameters.`)
    .join('\n');
}

export type StrictParamsMode = 'warn' | 'reject';

/** Strict value parse: anything but the two known modes resolves null. */
export function parseStrictParamsMode(v: unknown): StrictParamsMode | null {
  return v === 'warn' || v === 'reject' ? v : null;
}

/**
 * Dual-plane resolution for `mcp.strict_params`: DB plane (`engine.getConfig`)
 * wins, file plane (`config.mcp.strict_params`) is the fallback, absent or
 * unparseable on both = 'warn' (the grace-period default). A failed DB read
 * holds the LAST successfully resolved DB mode (per process) before falling
 * to the file plane — a transient config outage on a reject-mode server must
 * not silently re-open the warn-mode grace period. Validation posture never
 * takes a tool call down. Resolved once per dispatch (amendment 12);
 * serve-http's tools/list also reads it per request so `gbrain config set
 * mcp.strict_params reject` flips the advertised schema without a restart
 * (stdio + the legacy bearer transport resolve once at startup — restart to
 * flip there, deliberate).
 */
let lastKnownDbStrictMode: StrictParamsMode | null = null;

/** Test seam: clear the last-known-good DB mode between cases. */
export function resetStrictParamsModeCache(): void {
  lastKnownDbStrictMode = null;
}

export async function resolveStrictParamsMode(
  engine: BrainEngine,
  config: GBrainConfig | null | undefined,
): Promise<StrictParamsMode> {
  try {
    const dbMode = parseStrictParamsMode(await engine.getConfig('mcp.strict_params'));
    lastKnownDbStrictMode = dbMode;
    if (dbMode) return dbMode;
  } catch {
    // Engine without a config table / transient error: last-known-good DB
    // mode wins; with no prior successful read, the file plane decides.
    if (lastKnownDbStrictMode) return lastKnownDbStrictMode;
  }
  return parseStrictParamsMode(config?.mcp?.strict_params) ?? 'warn';
}
