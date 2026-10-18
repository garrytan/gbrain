/**
 * #6495 keyword timeout negative cache: after hybrid search's keyword arm
 * hits the Postgres statement timeout (SQLSTATE 57014 from
 * `search.keyword_statement_timeout_ms`), the engine remembers that exact
 * statement for `search.keyword_timeout_negative_cache_seconds` (default 600,
 * 0 = off) and, until the entry expires, refuses to run it again with
 * `KeywordSkippedAfterTimeoutError` instead of holding a backend for the full
 * timeout once more. The arm reports `keyword_arm_failed` with reason
 * `skipped_after_timeout` and the vector arm still answers.
 *
 * What makes two searches "the same": the key is a hash of the statement
 * text, every bound parameter (the tsquery text, types, dates, slug
 * exclusions, limits), the RLS source scope and the statement timeout in
 * effect. The visibility and trust floor of the caller live in the statement
 * text, so a narrower, differently scoped or differently trusted query is a
 * different key and still runs. The strict statement and the relaxed (OR)
 * retry are separate keys. Each engine instance (one per brain) owns its
 * cache, so another brain in the same process is never affected.
 *
 * Admission: only a genuine statement-timeout diagnostic records an entry;
 * a user or admin cancel (`canceling statement due to user request`), a lock
 * timeout or a connection failure never does. Entries expire at the TTL, so a
 * transient contention spike recovers by itself, and the map is bounded
 * (MAX_ENTRIES, oldest dropped first). A caller that passes `useCache: false`
 * to hybrid search does not consult the cache.
 *
 * Cost: a search that never times out does nothing extra (no statement, no
 * config read). The TTL is read once, on the first timeout after the engine
 * is created; each timeout then writes one bounded counter row
 * (`search.keyword_timeout_stats`: timeouts, skips counted since the previous
 * write, last timeout time), never one per search. Doctor `keyword_plan`
 * reads it. The cache lives in process memory, so `gbrain serve` and MCP
 * sessions benefit; a one-shot CLI command starts empty.
 *
 * Postgres only: PGLite runs keyword search with no statement timeout.
 */
import { createHash } from 'node:crypto';

export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY = 'search.keyword_timeout_negative_cache_seconds';
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S = 600;
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_S = 86_400;
/** The bounded counter row a timeout writes and doctor `keyword_plan` reads (not a `config set` key). */
export const KEYWORD_TIMEOUT_STATS_KEY = 'search.keyword_timeout_stats';
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES = 256;
const COUNTER_CAP = 1_000_000_000;

/** The configured seconds when `raw` is an integer in 0..86400, else undefined. */
export function keywordTimeoutNegativeCacheSeconds(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_S ? n : undefined;
}

/** `config set` refusal text, or null when the value is valid. */
export function keywordTimeoutNegativeCacheValueProblem(value: string): string | null {
  return keywordTimeoutNegativeCacheSeconds(value) !== undefined
    ? null
    : `${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY} must be an integer number of seconds from 0 (off) to ${KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_S} (got '${value}'). Nothing was written.`;
}

/** A genuine `statement_timeout` cancel: SQLSTATE 57014 with the timeout diagnostic, never a user or admin cancel. */
export function isGenuineStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === '57014' && typeof message === 'string' && /due to statement timeout/i.test(message);
}

/** Thrown instead of running a keyword statement that timed out within the TTL. */
export class KeywordSkippedAfterTimeoutError extends Error {
  readonly code = 'keyword_skipped_after_timeout';
  constructor(readonly retryAfterSeconds: number) {
    super(`keyword statement skipped: the same statement hit the keyword statement timeout and is skipped for ${retryAfterSeconds}s more (${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY})`);
    this.name = 'KeywordSkippedAfterTimeoutError';
  }
}

export function isKeywordSkippedAfterTimeout(error: unknown): error is KeywordSkippedAfterTimeoutError {
  return error instanceof KeywordSkippedAfterTimeoutError;
}

export interface KeywordTimeoutStats { timeouts: number; skips: number; last_timeout_at: string | null }

/** Parse the counter row; anything unreadable is no record. */
export function parseKeywordTimeoutStats(raw: string | null | undefined): KeywordTimeoutStats | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<KeywordTimeoutStats>;
    const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
    return { timeouts: count(v.timeouts), skips: count(v.skips), last_timeout_at: typeof v.last_timeout_at === 'string' ? v.last_timeout_at : null };
  } catch {
    return null;
  }
}

// engine-sql-ok: Postgres-only counter row the keyword timeout cache writes once per statement timeout (keys inlined; scalar binds); PGLite has no keyword statement timeout
export const KEYWORD_TIMEOUT_TTL_CONFIG_SQL = `SELECT value FROM config WHERE key = '${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY}'`;
// engine-sql-ok: one upsert per statement timeout; the counters stay bounded by COUNTER_CAP and a malformed row restarts at zero
export const KEYWORD_TIMEOUT_STATS_UPSERT_SQL = `INSERT INTO config (key, value)
  VALUES ('${KEYWORD_TIMEOUT_STATS_KEY}', json_build_object('timeouts', 1, 'skips', LEAST($1::bigint, ${COUNTER_CAP}), 'last_timeout_at', $2::text)::text)
  ON CONFLICT (key) DO UPDATE SET value = json_build_object(
    'timeouts', LEAST(CASE WHEN config.value ~ '"timeouts"[[:space:]]*:[[:space:]]*[0-9]+' THEN substring(config.value from '"timeouts"[[:space:]]*:[[:space:]]*([0-9]+)')::numeric ELSE 0 END + 1, ${COUNTER_CAP}),
    'skips', LEAST(CASE WHEN config.value ~ '"skips"[[:space:]]*:[[:space:]]*[0-9]+' THEN substring(config.value from '"skips"[[:space:]]*:[[:space:]]*([0-9]+)')::numeric ELSE 0 END + $1::bigint, ${COUNTER_CAP}),
    'last_timeout_at', $2::text)::text`;

export interface KeywordTimeoutDb { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }

/** One engine's negative cache (see the module comment). */
export class KeywordTimeoutNegativeCache {
  private entries = new Map<string, number>();
  private ttlMs?: Promise<number>;
  private pendingSkips = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Run one keyword statement. With `enabled` false (no hybrid opt-in, or a
   * fresh search) this is `exec()`. Otherwise a key recorded within its TTL
   * throws KeywordSkippedAfterTimeoutError without running anything, and a
   * genuine statement timeout records the key before the error propagates.
   */
  async run<T>(enabled: boolean, db: KeywordTimeoutDb, keyParts: unknown[], exec: () => Promise<T>): Promise<T> {
    if (!enabled) return exec();
    const key = createHash('sha256').update(JSON.stringify(keyParts)).digest('hex');
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined) {
      const remaining = expiresAt - this.now();
      if (remaining > 0) {
        this.pendingSkips++;
        throw new KeywordSkippedAfterTimeoutError(Math.ceil(remaining / 1000));
      }
      this.entries.delete(key);
    }
    try {
      return await exec();
    } catch (error) {
      if (isGenuineStatementTimeout(error)) await this.recordTimeout(key, db);
      throw error;
    }
  }

  private async recordTimeout(key: string, db: KeywordTimeoutDb): Promise<void> {
    const ttlMs = await (this.ttlMs ??= db.executeRaw<{ value: string }>(KEYWORD_TIMEOUT_TTL_CONFIG_SQL)
      .then(rows => (keywordTimeoutNegativeCacheSeconds(rows[0]?.value) ?? KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S) * 1000)
      .catch(() => KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S * 1000));
    if (ttlMs > 0) {
      this.entries.delete(key);
      this.entries.set(key, this.now() + ttlMs);
      for (const oldest of this.entries.keys()) {
        if (this.entries.size <= KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES) break;
        this.entries.delete(oldest);
      }
    }
    const skips = this.pendingSkips;
    this.pendingSkips = 0;
    await db.executeRaw(KEYWORD_TIMEOUT_STATS_UPSERT_SQL, [skips, new Date(this.now()).toISOString()])
      .catch(() => { this.pendingSkips += skips; });
  }
}
