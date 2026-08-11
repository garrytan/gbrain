/**
 * One-round-trip config reads.
 *
 * Two startup paths need dozens of config keys before the CLI does any work:
 * `loadConfigWithEngine()` merges the DB plane over file/env, and
 * `reconfigureGatewayWithEngine()` resolves six models through a precedence
 * chain that reads up to four keys each. Read one key at a time and that is
 * one network round trip per key.
 *
 * On PGLite each read costs microseconds, so the pattern stayed invisible for
 * a long time. On a hosted Postgres it is the wall clock: `gbrain stats`
 * against a Supabase brain spent over 3 seconds on config reads that
 * pg_stat_statements showed the server answering in under 3ms total.
 *
 * The config table is a handful of rows, so read it once and answer every key
 * from memory. The snapshot lives for one resolution pass, not for the life of
 * the process, so a `gbrain config set` from another process is picked up by
 * the next command exactly as before.
 */

/** The only thing config resolution needs from an engine. */
export interface ConfigReader {
  getConfig(key: string): Promise<string | null | undefined>;
}

/** An engine that can read its whole config table in one query. */
export interface BulkConfigReader extends ConfigReader {
  getAllConfig?(): Promise<Record<string, string>>;
}

/**
 * Read the whole config table as a key -> value map.
 *
 * Returns null when the bulk read is unavailable or fails — a brain
 * mid-migration has no config table, and an engine implemented outside this
 * repo may not have `getAllConfig`. Callers fall back to per-key reads, at the
 * old cost but with the old behavior.
 */
export async function loadConfigSnapshot(
  engine: BulkConfigReader | null | undefined,
): Promise<Record<string, string> | null> {
  if (!engine || typeof engine.getAllConfig !== 'function') return null;
  try {
    return await engine.getAllConfig();
  } catch {
    return null;
  }
}

/**
 * Return a reader that answers every key from a single snapshot, or the engine
 * itself when the snapshot is unavailable.
 */
export async function snapshotConfigReader(
  engine: BulkConfigReader | null | undefined,
): Promise<ConfigReader | null> {
  if (!engine) return null;
  const rows = await loadConfigSnapshot(engine);
  if (!rows) return engine;
  return {
    async getConfig(key: string): Promise<string | null> {
      return rows[key] ?? null;
    },
  };
}
