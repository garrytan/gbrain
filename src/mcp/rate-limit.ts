/**
 * Rate limiter for `gbrain serve --http`.
 *
 * Token-bucket per key, stored in a bounded LRU map so attacker-controlled keys
 * can't grow memory unbounded. TTL prune on every access (entries older than
 * 2× window are evicted) so abandoned keys don't sit around forever.
 *
 * Two buckets in the request pipeline (see http-transport.ts):
 *   1. Pre-auth IP bucket — fires BEFORE the DB lookup so we actually limit
 *      brute-force load against access_tokens, not just response codes.
 *   2. Post-auth token-id bucket — fires after auth so legitimate-but-runaway
 *      clients get throttled at the right principal.
 *
 * Both buckets behave identically; only the key differs.
 */

export interface RateLimitOpts {
  /** Maximum requests in the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** LRU cap on distinct keys. Evicts least-recently-used on overflow. */
  lruCap: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until next request would be allowed (only set when !allowed). */
  retryAfter?: number;
  /** Tokens remaining in the bucket after this check. */
  remaining: number;
}

interface Bucket {
  tokens: number;
  /** Used for refill math: tokens accrue based on elapsed time since this. */
  lastRefillMs: number;
  /** Used for TTL eviction: time of last check, regardless of refill. Prevents bucket-reset attack
   *  where an exhausted key would otherwise get TTL-evicted and recreated fresh. */
  lastTouchedMs: number;
}

/** Clock function — defaults to Date.now, overridable for tests. */
type Clock = () => number;

export class RateLimiter {
  readonly opts: RateLimitOpts;
  private readonly buckets: Map<string, Bucket> = new Map();
  private readonly clock: Clock;

  constructor(opts: RateLimitOpts, clock: Clock = Date.now) {
    if (opts.limit <= 0) throw new Error('RateLimiter: limit must be > 0');
    if (opts.windowMs <= 0) throw new Error('RateLimiter: windowMs must be > 0');
    if (opts.lruCap <= 0) throw new Error('RateLimiter: lruCap must be > 0');
    this.opts = opts;
    this.clock = clock;
  }

  check(key: string): RateLimitResult {
    const now = this.clock();
    this.prune(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.limit, lastRefillMs: now, lastTouchedMs: now };
    } else {
      // Refill: tokens accrue continuously over the window. limit/windowMs tokens per ms.
      const elapsed = now - bucket.lastRefillMs;
      const refilled = Math.floor((elapsed * this.opts.limit) / this.opts.windowMs);
      if (refilled > 0) {
        bucket.tokens = Math.min(this.opts.limit, bucket.tokens + refilled);
        bucket.lastRefillMs = now;
      }
      bucket.lastTouchedMs = now;
      // LRU bookkeeping: re-insert to move to end (Map iteration order = insertion).
      this.buckets.delete(key);
    }

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      this.evictIfOver();
      return { allowed: true, remaining: bucket.tokens };
    }

    // No tokens. Compute Retry-After from when the next token will accrue.
    const msPerToken = this.opts.windowMs / this.opts.limit;
    const msUntilNext = msPerToken - (now - bucket.lastRefillMs);
    const retryAfter = Math.max(1, Math.ceil(msUntilNext / 1000));
    this.buckets.set(key, bucket);
    this.evictIfOver();
    return { allowed: false, retryAfter, remaining: 0 };
  }

  /** Evict TTL-expired entries (older than 2× window since last touch). Cheap: O(n) but n is bounded by lruCap.
   *  Uses lastTouchedMs (not lastRefillMs) so an attacker can't reset their bucket by hammering an exhausted key
   *  past the TTL — every check updates lastTouchedMs even when refill produces 0 tokens. */
  private prune(now: number): void {
    const ttl = this.opts.windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastTouchedMs > ttl) {
        this.buckets.delete(key);
      } else {
        // Map iteration is in insertion order; once we hit a fresh entry, the rest are also fresh
        // ONLY if we maintain insertion-order = recency. That holds because check() does delete+set on every call.
        break;
      }
    }
  }

  private evictIfOver(): void {
    while (this.buckets.size > this.opts.lruCap) {
      // Map iteration starts at oldest (first-inserted). Delete it.
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  /** Test helper: current key count. */
  get size(): number {
    return this.buckets.size;
  }
}

/** Parse a positive integer env var, falling back to default. */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build limiters from env. Keep this lazy — tests can construct RateLimiter directly. */
export function buildDefaultLimiters(clock: Clock = Date.now): { ip: RateLimiter; token: RateLimiter } {
  const lruCap = envInt('GBRAIN_HTTP_RATE_LIMIT_LRU', 10000);
  const windowMs = 60_000;
  return {
    ip: new RateLimiter({ limit: envInt('GBRAIN_HTTP_RATE_LIMIT_IP', 30), windowMs, lruCap }, clock),
    token: new RateLimiter({ limit: envInt('GBRAIN_HTTP_RATE_LIMIT_TOKEN', 60), windowMs, lruCap }, clock),
  };
}
