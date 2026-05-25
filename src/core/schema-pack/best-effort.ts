// v0.40.6.0 Schema Cathedral v3 — best-effort active pack loader.
//
// Single source of truth for the T1.5 wiring sites (whoknows,
// find-experts, facts/eligibility, enrichment-service). All four call
// sites consume this helper so the empty-filter fallback contract lives
// in ONE place. Without this helper, the four sites would each open-code
// their own `try { load pack } catch { ... }` block, and one of them
// WILL drift to silently use hardcoded defaults — the bug class D4
// closed.
//
// Contract (D4 from /plan-eng-review):
//   - Pack load succeeds → return the ResolvedPack.
//   - Pack load fails (any reason: corrupt file, missing pack, federation
//     divergence, trust-gate reject) → return null.
//   - Caller MUST interpret null as "EMPTY FILTER" semantics. A null
//     return is NOT a license to fall back to hardcoded defaults like
//     ['person', 'company']; that silently re-introduces types the
//     user packed out.
//
// The empty-filter contract is the load-bearing design choice. Pack-load
// failure should be loud (query returns empty results, agent debugs the
// pack-load problem) — not silent (results look normal but contradict
// user intent).

import { loadConfig } from '../config.ts';
import type { OperationContext } from '../operations.ts';
import { loadActivePack } from './load-active.ts';
import type { ResolvedPack } from './registry.ts';

/**
 * Best-effort loader for the active schema pack. Returns null on any
 * failure path so callers can apply empty-filter semantics.
 *
 * NEVER throws. Never logs to stderr (callers don't need the noise on
 * routine queries; the underlying pack-load errors surface through
 * `gbrain doctor`'s schema_pack_coverage / schema_pack_writability
 * checks).
 *
 * @example
 *   // In whoknows.ts (T1.5 wiring site):
 *   const pack = await loadActivePackBestEffort(ctx);
 *   const types = pack
 *     ? expertTypesFromPack(pack)
 *     : [];  // EMPTY filter, NOT hardcoded defaults
 *   const results = await search(query, { types });
 */
export async function loadActivePackBestEffort(
  ctx: OperationContext,
): Promise<ResolvedPack | null> {
  try {
    return await loadActivePack({
      cfg: loadConfig(),
      remote: ctx.remote ?? true,
      sourceId: ctx.sourceId,
    });
  } catch {
    return null;
  }
}
