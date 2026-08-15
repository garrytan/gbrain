/**
 * Shared "rebuild the DB pool after a retryable connection failure" helper.
 *
 * PostgresEngine exposes reconnect(); PGLite and test doubles may not. Absence
 * is a no-op so non-Postgres callers preserve their legacy behavior.
 *
 * Extracted from MinionWorker's private method (#1491/#3555) so the inline
 * child drain (#2050, cycle/synthesize.ts runSubagentsInline) recovers from
 * the same transient pooler reaps instead of throwing out of the drain and
 * stranding children in a per-run queue no worker will ever claim.
 */
export async function reconnectAfterConnectionError(
  engine: unknown,
  site: string,
  error: unknown,
): Promise<void> {
  const reconnect = (engine as { reconnect?: (ctx?: { error?: unknown }) => Promise<void> }).reconnect;
  if (!reconnect) return;
  try {
    await reconnect.call(engine, { error });
  } catch (re) {
    console.error(`[minions] reconnect after ${site} error failed: ${re instanceof Error ? re.message : String(re)}`);
  }
}
