/**
 * Sync policy: the single predicate for `config.syncEnabled === false`.
 *
 * #4399: a source with a documented "never auto-sync this" standing rule
 * (`config.syncEnabled: false`) got resynced by autopilot's per-source
 * freshness dispatcher anyway, reproducing a slug-collision duplicate-page
 * bug the flag was set specifically to avoid. The freshness dispatch loop
 * (src/commands/autopilot.ts) iterated every source and queued a `sync` job
 * for each stale one without ever checking `syncEnabled`.
 *
 * `syncEnabled: false` already meant "excluded from an automatic/bulk sync
 * pass" at the `sync --all` fan-out filter in sync.ts — this module gives
 * that filter and autopilot's freshness dispatcher one shared predicate
 * instead of two copies of the same inline check, so they can't drift
 * apart. (sync-cost-gate.ts has its own separate inline `syncEnabled`
 * check, deliberately left untouched by this predicate: it also feeds an
 * explicit single-source `--source X` cost preview, a path this predicate
 * does not gate — see the scope note below.)
 *
 * Scope note: this predicate is read by the AUTOMATIC/bulk dispatch call
 * sites only. It intentionally does NOT gate `performSync()` itself, so an
 * explicit `gbrain sync --source <id>` naming a disabled source still runs —
 * `syncEnabled: false` narrows what autopilot and `sync --all` pick up on
 * their own, it does not redefine "prohibited for every invocation."
 */

import { parseSourceConfig } from './sources-load.ts';

/**
 * True iff `config` explicitly sets `syncEnabled: false`. Uses
 * `parseSourceConfig` so callers don't need to care whether the driver
 * handed back a parsed object (Postgres) or a JSON string (PGLite) — see
 * `sourceConfigHasRemoteUrl` in sources-load.ts for the same pattern.
 *
 * Absent/undefined `syncEnabled` (the common case — most sources never set
 * this key) is NOT disabled; only the literal `false` excludes.
 */
export function isSyncDisabledConfig(config: unknown): boolean {
  return parseSourceConfig(config).syncEnabled === false;
}
