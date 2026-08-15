/**
 * 24-hour content-hash dedup window for ingestion events.
 *
 * Daemon-side defense against duplicate events. Two scenarios in practice:
 *
 *   1. Overlapping sources: a file-watcher and an inbox-folder source both
 *      observe the same path (the inbox dir is inside the brain repo). Both
 *      emit. Dedup catches the second.
 *
 *   2. At-least-once delivery: a source emits, the daemon hasn't acked the
 *      Minion queue insert when the source crashes, source restarts and
 *      re-emits the same content. Dedup catches the replay.
 *
 * Design constraints:
 *
 *   - In-memory only. Surviving daemon restart is NOT a goal — at-least-once
 *     across daemon restarts is the existing Minion queue's job
 *     (idempotency_key). This LRU only catches same-process duplicates.
 *
 *   - Bounded by entry count, not memory. We cap at MAX_ENTRIES so a runaway
 *     source can't OOM the daemon. Each entry is ~96 bytes
 *     (source_kind + 64-hex hash + Date ts), so the worst case is ~480KB at
 *     5000 entries.
 *
 *   - 24h TTL. Pages don't get rewritten more than once per 24h in normal
 *     operation. Beyond that window, treat the same content as a new event
 *     (probably a re-import or a user explicitly re-saving).
 *
 *   - Pure functions + a class for the stateful instance. Tests inject the
 *     clock via the constructor.
 *
 * Concurrency: the daemon runs single-threaded JS, so we don't need locks.
 * If we ever move source emit to a worker thread, this needs revisiting.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 5000;

export interface DedupOpts {
  /** Time-to-live for each entry. Default 24 hours. */
  ttlMs?: number;
  /** Max entries before LRU eviction. Default 5000. */
  maxEntries?: number;
  /** Test seam for the clock. Defaults to Date.now. */
  _now?: () => number;
}

export interface DedupStats {
  /** Total events seen since daemon start. */
  total: number;
  /** Number that were dedup hits (silent drop). */
  hits: number;
  /** Number of LRU evictions performed. */
  evictions: number;
  /** Current cache size. */
  size: number;
}

/**
 * Bounded LRU keyed on `${source_kind}:${content_hash}`. Insertion-ordered
 * Map preserves LRU semantics: re-touching an existing key moves it to the
 * back via delete-then-set so eviction picks the oldest entry.
 *
 * Returns:
 *   - `mark(kind, hash)` → true if the key is new (proceed with emit),
 *     false if already seen (silent dedup).
 *   - `prune(now?)` → removes entries past TTL.
 *   - `stats()` → live counters.
 */
export class DedupWindow {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries: Map<string, number> = new Map();
  private _total = 0;
  private _hits = 0;
  private _evictions = 0;

  constructor(opts: DedupOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts._now ?? Date.now;
  }

  /**
   * Probe-and-mark the dedup window. Returns true if the event is new
   * (caller should proceed); false if this content was seen within the
   * TTL (caller drops silently).
   *
   * Internally this also performs lazy TTL pruning on the touched key and
   * LRU eviction when the cap is exceeded. Pruning the entire window every
   * call would be O(n) per emit; we let the window grow up to maxEntries
   * and prune in batches via the explicit `prune()` method.
   */
  mark(source_kind: string, content_hash: string): boolean {
    this._total++;
    const key = `${source_kind}:${content_hash}`;
    const ts = this.now();

    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // Within TTL? Hit.
      if (ts - existing < this.ttlMs) {
        this._hits++;
        // Re-set the entry to bump it to the back (LRU touch). The hit's
        // timestamp doesn't matter for the dedup decision, but does for
        // eviction order.
        this.entries.delete(key);
        this.entries.set(key, ts);
        return false;
      }
      // Outside TTL: treat as new. Update the timestamp by setting fresh.
      this.entries.delete(key);
    }

    // New entry. Enforce cap before insert so we never exceed maxEntries
    // even transiently. Map.keys() returns keys in insertion order, so the
    // first one is the oldest.
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this._evictions++;
    }

    this.entries.set(key, ts);
    return true;
  }

  /**
   * Sweep entries past their TTL. Caller decides when to run this. The
   * daemon calls it every ~5 minutes as part of the supervisor tick.
   * Returns the count of entries removed for the audit log.
   */
  prune(now?: number): number {
    const cutoff = (now ?? this.now()) - this.ttlMs;
    let removed = 0;
    for (const [key, ts] of this.entries) {
      if (ts < cutoff) {
        this.entries.delete(key);
        removed++;
      } else {
        // Entries are in insertion order; the first non-expired one means
        // everything after it is also non-expired. Bail early. The Map
        // iteration spec guarantees insertion order so this short-circuit is
        // safe.
        break;
      }
    }
    return removed;
  }

  stats(): DedupStats {
    return {
      total: this._total,
      hits: this._hits,
      evictions: this._evictions,
      size: this.entries.size,
    };
  }

  /** Test seam: reset all state. Never call from production. */
  _resetForTest(): void {
    this.entries.clear();
    this._total = 0;
    this._hits = 0;
    this._evictions = 0;
  }
}
