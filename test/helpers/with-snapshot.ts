/**
 * Scoped GBRAIN_PGLITE_SNAPSHOT overrides. Extracts the inline W0 pattern
 * from test/migrate.test.ts (save → delete → restore-exact-prior, including
 * was-undefined → delete) into a composable helper.
 *
 * Why: PGLiteEngine.connect() reads GBRAIN_PGLITE_SNAPSHOT to warm-start from
 * a schema snapshot. Tests whose premise is an EMPTY PGLite (no config table,
 * pre-migration state) must opt out for the connect they own — and restore
 * the exact prior value so later engines in the same shard process still get
 * the fast path.
 *
 * Scope note: unlike migrate.test.ts's micro-optimization (restore
 * immediately after connect()), these helpers restore in `finally` AFTER fn
 * completes — the generic helper can't know when fn's connect happens. Any
 * engine fn itself connects runs snapshot-less; don't nest an unrelated
 * cold-start-sensitive connect inside.
 *
 * Same caveat as withEnv: process.env is process-global — cross-test safe,
 * NOT intra-file concurrent-safe.
 */
import { withEnv } from './with-env.ts';

/**
 * Run fn with GBRAIN_PGLITE_SNAPSHOT set to `value` (undefined = deleted),
 * restoring the exact prior state via try/finally.
 */
export async function withSnapshotValue<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withEnv({ GBRAIN_PGLITE_SNAPSHOT: value }, fn);
}

/** Run fn with the PGLite snapshot fast path disabled (true cold start). */
export async function withColdPglite<T>(fn: () => Promise<T>): Promise<T> {
  return withSnapshotValue(undefined, fn);
}
