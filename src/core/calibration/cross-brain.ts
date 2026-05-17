/**
 * v0.36.0.0 (T14 / E8 + D18) — cross-brain calibration query semantics.
 *
 * Team-brain sharing: when a holder's calibration profile is not present in
 * the local brain, optionally fall back to mounted brains that have
 * `published=true` profiles for that holder. The four cross-brain leak
 * test cases from D18 are pinned in test/cross-brain-calibration.test.ts.
 *
 * D18 semantics (committed):
 *
 * 1. LOCAL-FIRST ORDERING. Query the local brain first. If a profile exists,
 *    return it. Do NOT also query mounts (avoids stale-mount-overrides-fresh-
 *    local).
 *
 * 2. MOUNT FALLBACK. Only when local has no profile AND the request context
 *    allows mount-read (CLI yes; MCP read-scope yes; SUBAGENT no), query
 *    mounts in priority order, filtered by published=true.
 *
 * 3. CROSS-BRAIN ATTRIBUTION. Every returned profile carries `source_brain_id`
 *    so consumers see which brain answered. Consumers MUST surface it in
 *    user-visible output.
 *
 * 4. SUBAGENT PROHIBITION. ctx.remote=true && !trustedWorkspace cannot read
 *    mounted profiles. Closes the OAuth-token-to-cross-brain-leak surface.
 *
 * E2E tests (D18 spec):
 *   - mounted brain has published=false profile → query returns null
 *   - published=true but consumer lacks mount-read scope → null
 *   - subagent context attempts mount fallback → returns local-only result
 *   - attribution test: profile returns with source_brain_id; consumer
 *     surfaces it in output
 *
 * v0.36.0.0 ship state scope:
 *   - The CALIBRATION query path supports cross-brain. The actual MOUNT
 *     infrastructure (gbrain mounts add — v0.19+) is reused as-is. This
 *     module adds the cross-brain READ filter on top of mount discovery.
 *   - Mount engine access is via injected `mountResolver` callback so tests
 *     drive the cross-brain shape without needing a real multi-brain setup.
 */

import type { CalibrationProfileRow } from '../../commands/calibration.ts';
import type { BrainEngine } from '../engine.ts';
import { getLatestProfile } from '../../commands/calibration.ts';

/**
 * Cross-brain query options. Tests drive these directly; production paths
 * compose them from OperationContext.
 */
export interface CrossBrainQueryOpts {
  /** The holder to look up. */
  holder: string;
  /** Local brain's identifier (e.g. 'garry-personal'). */
  localBrainId: string;
  /** Local-side source scoping. */
  sourceId?: string;
  sourceIds?: string[];
  /**
   * When false, mount fallback is DISABLED (subagent / untrusted-context
   * gate per D18 rule 4). The query short-circuits to local-only.
   */
  canReadMounts: boolean;
  /**
   * Mount resolver — production wires this to the mounts subsystem
   * (gbrain mounts add). Tests inject a stub returning an ordered list
   * of mounted-brain engines. Each mount must declare its brain id so
   * the response can carry source_brain_id attribution.
   */
  mountResolver?: () => Promise<Array<{ brainId: string; engine: BrainEngine }>>;
}

/** Result type extends the canonical row with attribution. */
export interface CrossBrainProfileResult extends CalibrationProfileRow {
  /** Brain id of the brain that answered. Local brain id when local hit; mount id when fallback. */
  source_brain_id: string;
  /** True when the profile came from a mount (not the local brain). */
  from_mount: boolean;
}

/**
 * Resolve the active calibration profile for a holder across local +
 * mounted brains per the D18 4-rule contract. Returns null when no
 * matching profile exists in any reachable brain.
 */
export async function queryAcrossBrains(
  localEngine: BrainEngine,
  opts: CrossBrainQueryOpts,
): Promise<CrossBrainProfileResult | null> {
  // Rule 1: LOCAL-FIRST.
  const localProfile = await getLatestProfile(localEngine, {
    holder: opts.holder,
    ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
    ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
  });
  if (localProfile) {
    return {
      ...localProfile,
      source_brain_id: opts.localBrainId,
      from_mount: false,
    };
  }

  // Rule 4: SUBAGENT PROHIBITION. canReadMounts=false short-circuits to null.
  if (!opts.canReadMounts) {
    return null;
  }

  // Rule 2: MOUNT FALLBACK. Walk mounts in priority order; first
  // published=true match wins.
  if (!opts.mountResolver) {
    // No mounts configured → null is the right answer.
    return null;
  }
  const mounts = await opts.mountResolver();
  for (const mount of mounts) {
    const mountProfile = await getLatestProfile(mount.engine, { holder: opts.holder });
    if (!mountProfile) continue;
    // Mount-side filter: only published=true profiles are visible to
    // consumers. Authoring brain controls publication per D15 asymmetric
    // opt-in.
    if (!mountProfile.published) continue;
    return {
      ...mountProfile,
      source_brain_id: mount.brainId,
      from_mount: true,
    };
  }
  return null;
}

/**
 * Determine whether the current OperationContext is allowed to read
 * mounted brains. Per D18:
 *
 *   CLI → yes (trusted local operator)
 *   MCP read-scope → yes
 *   MCP subagent context (remote=true && !trustedWorkspace) → no
 *
 * The function returns FALSE when the context is a subagent loop because
 * that's where the OAuth-token-to-cross-brain-leak surface lives. Anything
 * else gets true.
 */
export function canReadMountsForCtx(ctx: {
  remote: boolean;
  viaSubagent?: boolean;
  allowedSlugPrefixes?: string[];
}): boolean {
  // Local CLI: always yes.
  if (ctx.remote === false) return true;
  // Subagent tool-loop: never yes. (Trusted-workspace synthesize/patterns
  // phases pass `allowedSlugPrefixes` set; those are still subagents per
  // viaSubagent semantics, but they're trusted. Match that gate.)
  if (ctx.viaSubagent === true) {
    return Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0;
  }
  // MCP non-subagent (regular OAuth-scoped read): yes.
  return true;
}

/**
 * Render the attribution suffix that consumers (E1 think rewrite, E3
 * contradictions output, E7 nudge text, E6 dashboard) MUST surface so
 * the user sees which brain answered.
 */
export function attributionSuffix(result: CrossBrainProfileResult): string {
  if (!result.from_mount) {
    return ''; // local — no suffix needed (assume local is default)
  }
  return ` (from mounted brain: ${result.source_brain_id})`;
}
