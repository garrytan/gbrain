import type { BrainEngine } from './engine.ts';
import { LATEST_SCHEMA_VERSION } from './schema-migrations/latest.generated.ts';

/**
 * Cheap probe: does this engine have schema migrations pending?
 *
 * Reads the `version` config row in a single round-trip (no schema replay,
 * no migration apply) and compares it with the generated latest version, so
 * it never loads the migration modules themselves (migrate.ts does; it
 * re-exports this). Used by `connectEngine` to gate `initSchema()` so
 * short-lived CLI invocations on already-migrated brains don't pay the
 * full bootstrap-probe + SCHEMA_SQL replay + ledger-check cost on every
 * `gbrain stats` / `gbrain query` / `gbrain doctor`.
 *
 * Defensive: treats a getConfig failure (config table missing, query error)
 * as "yes pending" so the caller falls through to the full initSchema path.
 * Worst case on a wedged brain is one extra schema replay — same as before.
 *
 * Closes #651 in cooperation with the post-upgrade auto-apply hook (X1)
 * without the perf cost #652 would have introduced on every CLI call.
 */
export async function hasPendingMigrations(engine: BrainEngine): Promise<boolean> {
  try {
    const currentStr = await engine.getConfig('version');
    const current = parseInt(currentStr || '1', 10);
    return current < LATEST_SCHEMA_VERSION;
  } catch {
    return true;
  }
}
