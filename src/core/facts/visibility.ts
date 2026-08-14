/**
 * [ENG-8] Facts default-visibility resolver — the ONE helper behind every
 * "caller didn't say" visibility decision.
 *
 * The 'private' default used to be duplicated at four sites (backstop.ts
 * minion-payload + pipeline, operations.ts extract_facts + ontology_propose),
 * and the op-layer ternaries coerced ANY non-'world' value — including unset —
 * to 'private' before a config default could run. This module centralizes the
 * ladder:
 *
 *   explicit caller value ('private' | 'world')  — always wins
 *     → config key `facts.default_visibility`     — operator-set brain default
 *       → 'private'                               — fail-closed floor
 *
 * Security note (stated intent, per the eng review): setting
 * `facts.default_visibility = world` widens what remote/MCP callers can read
 * back through the hot-memory meta hook and turn_context — that is the
 * DELIBERATE single-principal posture bootstrap configures (CX-P1.1), not a
 * leak. Invalid or unreadable config always resolves 'private'.
 */

import type { BrainEngine } from '../engine.ts';

export type FactVisibility = 'private' | 'world';

export const FACTS_DEFAULT_VISIBILITY_KEY = 'facts.default_visibility';

/**
 * Resolve the brain-level default visibility for facts writes when the caller
 * did not specify one. Reads `facts.default_visibility` via engine.getConfig
 * (the extract.ts:isFactsExtractionEnabled precedent). Returns 'world' only on
 * an explicit, well-formed opt-in; anything else — unset, invalid, or a config
 * read failure — fails closed to 'private'.
 */
export async function resolveDefaultVisibility(engine: BrainEngine): Promise<FactVisibility> {
  try {
    const val = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (val == null) return 'private';
    return val.trim().toLowerCase() === 'world' ? 'world' : 'private';
  } catch {
    return 'private'; // config read failure must never widen visibility
  }
}

/**
 * Op-layer param resolution shared by extract_facts and ontology_propose.
 * Contract (the :4468-ternary fix):
 *   - explicit 'world'  → 'world'  (caller wins)
 *   - explicit 'private'→ 'private' (caller wins — even over a world default)
 *   - unset (null/undefined) → resolveDefaultVisibility(engine)
 *   - any other garbage value → 'private' (fail-closed, matches the historic
 *     coercion for invalid input; only genuinely-unset reaches the config).
 */
export async function resolveVisibilityParam(
  engine: BrainEngine,
  value: unknown,
): Promise<FactVisibility> {
  if (value === 'world') return 'world';
  if (value === 'private') return 'private';
  if (value == null) return resolveDefaultVisibility(engine);
  return 'private';
}
