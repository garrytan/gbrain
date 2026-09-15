/**
 * The single predicate for `config.syncEnabled === false` (#4399).
 *
 * The flag means "excluded from AUTOMATIC/bulk sync": the `sync --all` fan-out
 * filter (sync.ts), autopilot's freshness dispatcher (autopilot.ts), the
 * full-cycle fan-out (autopilot-fanout.ts) and the `sync_enabled` column of
 * the sources status report (sync-status-report.ts, fed RAW `SELECT config`
 * rows) all read it here so they cannot drift apart. It deliberately does
 * NOT gate performSync() itself — an
 * explicit `gbrain sync --source <id>` naming a disabled source still runs.
 * (sync-cost-gate.ts keeps its own inline check: it also feeds the explicit
 * single-source cost preview.)
 */

import { parseSourceConfig } from './sources-load.ts';

/**
 * True iff `config` explicitly sets `syncEnabled: false`. parseSourceConfig
 * unwraps PGLite's JSON-string scalar shape (same pattern as
 * sourceConfigHasRemoteUrl); absent/undefined is NOT disabled.
 */
export function isSyncDisabledConfig(config: unknown): boolean {
  return parseSourceConfig(config).syncEnabled === false;
}
