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
 * (MAX_ENTRIES, oldest dropped first).
 *
 * Background re-runs (#7082): a timeout on a cold cache is often gone a
 * minute later, while the TTL kept every search keyword-less for its whole
 * length. A serving process turns re-runs on (`enableReruns`, from
 * `gbrain serve` through PostgresEngine#enableKeywordTimeoutReruns); each
 * recorded timeout then re-runs the same statement, scope, settings and bound
 * in the background KEYWORD_TIMEOUT_RERUN_FIRST_MS after the timeout, doubling
 * the wait after every failed or skipped re-run and never scheduling one past
 * the entry's expiry, so the TTL stays the longest skip. The first re-run that
 * answers deletes the entry. Foreground searches skip exactly as before while
 * the entry stands. A re-run starts only when the gate reports an open engine
 * with an idle pooled connection and no waiting query (otherwise it waits for
 * the next step instead of queueing), at most one runs per engine, its rows
 * are thrown away, it writes no counter row, and it runs in the serve's
 * start-up async context, never in the request that recorded the timeout, so
 * no request signal, connection budget or capture rides along. Shutdown
 * (`disableReruns`) cancels every scheduled re-run. A caller that passes `useCache: false`
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
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY = 'search.keyword_timeout_negative_cache_seconds';
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S = 600;
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_S = 86_400;
/** The bounded counter row a timeout writes and doctor `keyword_plan` reads (not a `config set` key). */
export const KEYWORD_TIMEOUT_STATS_KEY = 'search.keyword_timeout_stats';
export const KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES = 256;
/** A serve's first background re-run of a timed-out statement starts this long after the timeout; each failed or skipped one doubles it. */
export const KEYWORD_TIMEOUT_RERUN_FIRST_MS = 30_000;
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

/** When a serve has turned re-runs on: whether a background re-run may start now (open engine, an idle pooled connection). */
export interface KeywordRerunGate { canRerun(): boolean }

/** Starts `fn` after `ms` and returns its cancel; the default never keeps the process alive. */
export type KeywordRerunScheduler = (fn: () => void, ms: number) => () => void;

const unrefTimer: KeywordRerunScheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

interface Entry { expiresAt: number; rerunAfterMs: number; exec: () => Promise<unknown>; cancel?: () => void }

/** One engine's negative cache (see the module comment). */
export class KeywordTimeoutNegativeCache {
  private entries = new Map<string, Entry>();
  private ttlMs?: Promise<number>;
  private pendingSkips = 0;
  private gate: KeywordRerunGate | null = null;
  private detached: (fn: () => void) => void = fn => fn();
  private rerunning = false;

  constructor(private readonly now: () => number = Date.now, private readonly schedule: KeywordRerunScheduler = unrefTimer) {}

  /**
   * A serving process turns background re-runs on once, at start-up: re-runs then start in the context this call
   * runs in, never in the search that recorded the timeout, so no request's signal, budget or caller rides along.
   */
  enableReruns(gate: KeywordRerunGate): void {
    this.gate = gate;
    this.detached = AsyncResource.bind((fn: () => void) => fn());
  }

  /** Shutdown: no re-run starts again, and every scheduled one is cancelled. */
  disableReruns(): void {
    this.gate = null;
    for (const entry of this.entries.values()) entry.cancel?.();
  }

  /**
   * Run one keyword statement. With `enabled` false (no hybrid opt-in, or a
   * fresh search) this is `exec()`. Otherwise a key recorded within its TTL
   * throws KeywordSkippedAfterTimeoutError without running anything, and a
   * genuine statement timeout records the key before the error propagates.
   */
  async run<T>(enabled: boolean, db: KeywordTimeoutDb, keyParts: unknown[], exec: () => Promise<T>): Promise<T> {
    if (!enabled) return exec();
    const key = createHash('sha256').update(JSON.stringify(keyParts)).digest('hex');
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      const remaining = entry.expiresAt - this.now();
      if (remaining > 0) {
        this.pendingSkips++;
        throw new KeywordSkippedAfterTimeoutError(Math.ceil(remaining / 1000));
      }
      this.drop(key);
    }
    try {
      return await exec();
    } catch (error) {
      if (isGenuineStatementTimeout(error)) await this.recordTimeout(key, db, exec);
      throw error;
    }
  }

  private drop(key: string): void {
    this.entries.get(key)?.cancel?.();
    this.entries.delete(key);
  }

  private async recordTimeout(key: string, db: KeywordTimeoutDb, exec: () => Promise<unknown>): Promise<void> {
    const ttlMs = await (this.ttlMs ??= db.executeRaw<{ value: string }>(KEYWORD_TIMEOUT_TTL_CONFIG_SQL)
      .then(rows => (keywordTimeoutNegativeCacheSeconds(rows[0]?.value) ?? KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S) * 1000)
      .catch(() => KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S * 1000));
    if (ttlMs > 0) {
      this.drop(key);
      this.entries.set(key, { expiresAt: this.now() + ttlMs, rerunAfterMs: KEYWORD_TIMEOUT_RERUN_FIRST_MS, exec });
      for (const oldest of this.entries.keys()) {
        if (this.entries.size <= KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES) break;
        this.drop(oldest);
      }
      this.scheduleRerun(key);
    }
    const skips = this.pendingSkips;
    this.pendingSkips = 0;
    await db.executeRaw(KEYWORD_TIMEOUT_STATS_UPSERT_SQL, [skips, new Date(this.now()).toISOString()])
      .catch(() => { this.pendingSkips += skips; });
  }

  /** The next re-run of `key`, unless re-runs are off or it would start after the entry expires anyway. */
  private scheduleRerun(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || !this.gate || this.now() + entry.rerunAfterMs >= entry.expiresAt) return;
    entry.cancel = this.schedule(() => this.detached(() => void this.rerun(key, entry)), entry.rerunAfterMs);
  }

  /**
   * One background re-run: the same statement, scope, settings and bound, its rows thrown away. Success ends the
   * skip; a failure, or a moment with no idle connection or another re-run in flight, doubles the wait instead.
   */
  private async rerun(key: string, entry: Entry): Promise<void> {
    entry.cancel = undefined;
    if (this.entries.get(key) !== entry || !this.gate) return;
    if (this.rerunning || !this.gate.canRerun()) return this.backOff(key, entry);
    this.rerunning = true;
    try {
      await entry.exec();
      if (this.entries.get(key) === entry) this.entries.delete(key);
    } catch {
      this.backOff(key, entry);
    } finally {
      this.rerunning = false;
    }
  }

  private backOff(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    entry.rerunAfterMs *= 2;
    this.scheduleRerun(key);
  }
}
