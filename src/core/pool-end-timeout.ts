/**
 * #1972: hard upper bound (seconds) on a single pool `.end()` drain. postgres.js
 * accepts `{ timeout }` but applies it internally — against PgBouncer
 * transaction-mode the drain can still hang, and a stubbed `.end()` ignores it
 * entirely. So `endPoolBounded` (db.ts) ALSO wraps each end in a gbrain-owned
 * Promise.race and passes this value as the postgres.js hint so a healthy drain
 * still finishes fast. Its own module so the CLI exit seam (cli-force-exit.ts)
 * budgets it without loading the Postgres driver into every invocation.
 */
export const POOL_END_TIMEOUT_SECONDS = 2;
