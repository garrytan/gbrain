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
import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * One config snapshot per MCP request.
 *
 * A remote MCP `search` resolves its settings in a dozen modules, each with
 * its own `engine.getConfig(key)`, plus loaders that read the whole table.
 * Behind a transaction pooler each read is a round trip, about 30 ms each to
 * a remote database, for a statement the server answers in well under a
 * millisecond (#6721).
 *
 * `withRequestConfigSnapshot(engine, fn)` runs `fn` with one snapshot of that
 * engine's config table: the first read inside it takes the whole table in
 * one statement, and every later `getConfig` / `getAllConfig` on the same
 * engine object answers from it. The snapshot lives exactly as long as `fn`:
 * reads after it settles (background work it started included) and reads on
 * any other engine object (a transaction's, another brain's) go to the
 * database as before. `setConfig` / `unsetConfig` on the engine update the
 * snapshot, so a request reads its own writes. A write operation runs under
 * `withoutRequestConfigSnapshot`: it reads config live, and when it settles
 * the snapshot is dropped, so a later read in the same request takes a fresh
 * one (raw-SQL config writes included). A failed bulk read leaves every key
 * to its per-key read, the same fallback `loadConfigSnapshot` has.
 */
interface RequestSnapshot {
  engine: object;
  open: boolean;
  rows: Promise<Map<string, string> | null> | null;
}

const requestSnapshot = new AsyncLocalStorage<{ held: RequestSnapshot; live: boolean }>();

/** The open snapshot for `engine` in this async context, if any. */
function activeSnapshot(engine: object): RequestSnapshot | undefined {
  const store = requestSnapshot.getStore();
  return store && !store.live && store.held.open && store.held.engine === engine ? store.held : undefined;
}

/** Run `fn` with one config snapshot of `engine`; an enclosing snapshot of the same engine is reused. */
export async function withRequestConfigSnapshot<T>(engine: BulkConfigReader, fn: () => Promise<T>): Promise<T> {
  if (activeSnapshot(engine)) return fn();
  const held: RequestSnapshot = { engine, open: true, rows: null };
  try {
    return await requestSnapshot.run({ held, live: false }, fn);
  } finally {
    held.open = false;
  }
}

/** Run `fn` reading config live (a write operation inside a request); the request's snapshot is retaken after it. */
export async function withoutRequestConfigSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const store = requestSnapshot.getStore();
  if (!store) return fn();
  try {
    return await requestSnapshot.run({ held: store.held, live: true }, fn);
  } finally {
    store.held.rows = null;
  }
}

function snapshotRows(engine: BulkConfigReader, held: RequestSnapshot): Promise<Map<string, string> | null> {
  held.rows ??= requestSnapshot.run({ held, live: true }, () => loadConfigSnapshot(engine))
    .then(rows => rows ? new Map(Object.entries(rows)) : null);
  return held.rows;
}

/**
 * The value of `key` from the request's snapshot of `engine`: a string, null
 * when the key is unset, or undefined when no snapshot applies (no request
 * snapshot, another engine, or the bulk read failed); the engine then reads
 * the key itself.
 */
export async function requestConfigValue(engine: BulkConfigReader, key: string): Promise<string | null | undefined> {
  const held = activeSnapshot(engine);
  if (!held) return undefined;
  const rows = await snapshotRows(engine, held);
  return rows ? rows.get(key) ?? null : undefined;
}

/** The request's whole snapshot of `engine` as `getAllConfig` returns it, or undefined when none applies. */
export async function requestConfigRows(engine: BulkConfigReader): Promise<Record<string, string> | undefined> {
  const held = activeSnapshot(engine);
  if (!held) return undefined;
  const rows = await snapshotRows(engine, held);
  return rows ? Object.fromEntries(rows) : undefined;
}

/** Keep an open snapshot of `engine` equal to a write the engine just made (value null = key removed). */
export function noteRequestConfigWrite(engine: object, key: string, value: string | null): void {
  const held = activeSnapshot(engine);
  if (!held?.rows) return;
  held.rows = held.rows.then(rows => {
    if (!rows) return rows;
    const next = new Map(rows);
    if (value === null) next.delete(key); else next.set(key, value);
    return next;
  });
}
