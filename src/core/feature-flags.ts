/**
 * Feature flags (v0.40 D23).
 *
 * Single shared escape hatch for the v0.40 Federated Sync v2 cathedral.
 * Flipping `sync.federated_v2` to `false` reverts to v0.39 sequential
 * behavior without re-installing the binary — useful if a foundational
 * assumption proves wrong in production (e.g. parallel sync trips an
 * undiscovered Postgres lock contention).
 *
 * What the flag gates:
 *   - Parallel branch of `gbrain sync --all` (serial fallback otherwise)
 *   - Auto-enqueue of embed-backfill in the extended `sync` handler
 *   - Autopilot's per-source freshness-gate dispatch (D17)
 *
 * What stays on UNCONDITIONALLY (correctness, not features):
 *   - Per-source sync lock (`syncLockId`)
 *   - Phantom-redirect per-source lock (D16)
 *   - Migration v87 (sources_github_repo index)
 *   - Facts-backstop source-scoping fix (D21)
 *   - safeHexEqual extraction (D15.5)
 *
 * Disable path:
 *   gbrain config set sync.federated_v2 false
 *   gbrain jobs supervisor restart   # autopilot picks up the change
 *
 * Convention: this module is the ONLY place that reads the flag. Callers go
 * through `isFederatedV2Enabled(engine)` so future changes to the flag key,
 * default, or backing store happen in one place.
 */
import type { BrainEngine } from './engine.ts';

export const FEDERATED_V2_CONFIG_KEY = 'sync.federated_v2';

/**
 * True iff Federated Sync v2 behaviors are enabled (default true).
 *
 * Reads `sync.federated_v2` from the DB config plane via `engine.getConfig`.
 * Values: `'false'` → disabled; anything else (including missing/null) →
 * enabled. The default-on posture is deliberate — v0.40 ships expecting the
 * new behavior, and ops opt out by setting the key explicitly.
 *
 * Throwing on engine errors is fine: the flag is only checked at boundary
 * points (CLI dispatch, autopilot tick, sync handler) where an engine error
 * would surface anyway. Callers don't need a try/catch wrapper.
 */
export async function isFederatedV2Enabled(engine: BrainEngine): Promise<boolean> {
  const value = await engine.getConfig(FEDERATED_V2_CONFIG_KEY);
  return value !== 'false';
}
