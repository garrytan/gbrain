/**
 * embed-cache.ts — content-addressed embedding cache for fixed-corpus evals.
 *
 * INVARIANT: a cached vector is served ONLY for the exact (model@dims, text,
 * side) it was computed for, and every row is integrity-checked on read
 * (declared dims == stored byte length / 4 == vector length). A mismatch is a
 * HARD error naming the file and the key — never a silent re-embed, because a
 * silently corrupted cache would make every arm's vectors non-comparable.
 *
 * Why it exists: every LongMemEval arm re-embeds the same ~500-question
 * haystack (~$2, ~2 h cold). One shared cache makes every arm see
 * byte-identical vectors, so paired deltas measure the ranking change and
 * nothing else. The canonical hash (`canonicalSha256`) goes into each
 * receipt's `run_config.cache` so two runs can prove they saw the same
 * vectors (plan D18).
 *
 * Key = `${model}@${dims}` + (`#query` for query-side asymmetric embeds) +
 * ':' + sha256(text). The side marker lives in the model segment so the
 * default (document / symmetric) key is exactly `model@dims:sha256(text)` and
 * asymmetric providers (zembed-1, Voyage v3+) can never be served a
 * document-side vector for a query-side embed (sibling audit longmemeval-06).
 *
 * Storage: bun:sqlite, WAL journal + synchronous=NORMAL (eng D7), one
 * transaction per question's embeds via `withTransaction`. Local filesystem
 * only (WAL sidecars), never NFS.
 *
 * TRANSPORT SEAM (eng D3): this wave installs the cache through the gateway's
 * existing test seam `__setEmbedTransportForTests` — deliberately. gateway.ts
 * sits at its module-size ceiling and the sibling gbrain-evals runner set the
 * precedent (eval/runner/longmemeval-cache.ts). Promoting this to a named
 * `setEmbedTransport()` / `GBRAIN_EMBED_CACHE_DIR` hook is a filed P3
 * follow-up. Because the seam exposes no getter for the current transport,
 * `installEmbedCache` restores `opts.realTransport ?? null` (the real SDK
 * `embedMany`) on uninstall — pass the previous transport explicitly when a
 * caller had already swapped it.
 *
 * Port of gbrain-evals `eval/runner/longmemeval-cache.ts` onto gbrain's seam.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedMany } from 'ai';
import {
  __setEmbedTransportForTests,
  getEmbeddingDimensions,
  getEmbeddingModel,
} from '../../core/ai/gateway.ts';

/** Same shape the gateway's `_embedTransport` has (`typeof embedMany`). */
export type EmbedTransportFn = typeof embedMany;

export type EmbedSide = 'query' | 'document';

export interface EmbedCacheStats {
  hits: number;
  /** Values served by the real transport — genuine misses PLUS every value of
   *  a batch that fell open on an infrastructure fault (see `infra_faults`). */
  misses: number;
  /** Batches passed straight through because the SDK model id did not match
   *  the resolved model this cache was installed for (never cached). */
  bypassed: number;
  /** Cache infrastructure faults (file deleted mid-run, table dropped, disk
   *  error) that made a batch re-embed uncached or skip its write-back. A run
   *  that never touched a healthy cache shows `infra_faults > 0`, never a
   *  clean `misses: 0`. */
  infra_faults: number;
  path: string;
}

/** Hard error: a stored row disagrees with its own declared shape. */
export class EmbedCacheIntegrityError extends Error {
  readonly path: string;
  readonly key: string;
  constructor(path: string, key: string, detail: string) {
    super(`embed cache integrity error in ${path} for key ${key}: ${detail}`);
    this.name = 'EmbedCacheIntegrityError';
    this.path = path;
    this.key = key;
  }
}

const BUSY_TIMEOUT_MS = 10_000;
const BUSY_RETRIES = 3;
/** fileSha256 read-chunk size: bounded memory regardless of cache size. */
const FILE_HASH_CHUNK_BYTES = 1 << 20;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function withBusyRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isBusyError(err)) throw err;
    }
  }
  throw lastErr;
}

function toBlob(vector: ArrayLike<number>): Uint8Array {
  const f32 = Float32Array.from(vector as ArrayLike<number>);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBlob(blob: Uint8Array, dims: number): number[] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export class EmbeddingCache {
  readonly path: string;
  private db: Database | null = null;
  private txDepth = 0;
  private hits = 0;
  private misses = 0;
  private bypassed = 0;
  private infraFaults = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Open (creating the file + schema if needed). Idempotent. */
  open(): void {
    if (this.db) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const db = withBusyRetry(() => new Database(this.path));
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS embed_cache (
        key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        byte_len INTEGER NOT NULL,
        vector BLOB NOT NULL
      ) WITHOUT ROWID
    `);
    this.db = db;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error(`embed cache ${this.path} is not open (call open() first)`);
    return this.db;
  }

  /** `model@dims[#query]:sha256(text)` — see the module header. */
  key(model: string, dims: number, text: string, side: EmbedSide = 'document'): string {
    const modelSeg = side === 'query' ? `${model}@${dims}#query` : `${model}@${dims}`;
    return `${modelSeg}:${sha256Hex(text)}`;
  }

  /** Cached vector (number[] — the ai-sdk `embedMany` shape) or null. */
  get(model: string, dims: number, text: string, side: EmbedSide = 'document'): number[] | null {
    const db = this.requireDb();
    const key = this.key(model, dims, text, side);
    const row = withBusyRetry(() =>
      db
        .query<{ dims: number; byte_len: number; vector: Uint8Array }, [string]>(
          'SELECT dims, byte_len, vector FROM embed_cache WHERE key = ?',
        )
        .get(key),
    );
    if (!row) {
      this.misses++;
      return null;
    }
    if (row.dims !== dims) {
      throw new EmbedCacheIntegrityError(this.path, key, `row declares dims=${row.dims}, lookup expects ${dims}`);
    }
    if (row.byte_len !== dims * 4 || row.vector.byteLength !== row.byte_len) {
      throw new EmbedCacheIntegrityError(
        this.path,
        key,
        `byte length mismatch: declared ${row.byte_len}, stored ${row.vector.byteLength}, expected ${dims * 4}`,
      );
    }
    this.hits++;
    return fromBlob(row.vector, dims);
  }

  put(model: string, dims: number, text: string, vector: ArrayLike<number>, side: EmbedSide = 'document'): void {
    const db = this.requireDb();
    const key = this.key(model, dims, text, side);
    if (vector.length !== dims) {
      throw new EmbedCacheIntegrityError(this.path, key, `vector has ${vector.length} dims, expected ${dims}`);
    }
    const blob = toBlob(vector);
    withBusyRetry(() =>
      db
        .query('INSERT OR REPLACE INTO embed_cache (key, model, dims, byte_len, vector) VALUES (?, ?, ?, ?, ?)')
        .run(key, model, dims, blob.byteLength, blob),
    );
  }

  private txBegin(db: Database, depth: number): void {
    withBusyRetry(() => db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT embed_cache_sp_${depth}`));
    this.txDepth++;
  }

  private txEnd(db: Database, depth: number, ok: boolean): void {
    try {
      if (ok) db.exec(depth === 0 ? 'COMMIT' : `RELEASE embed_cache_sp_${depth}`);
      else db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO embed_cache_sp_${depth}; RELEASE embed_cache_sp_${depth}`);
    } catch (err) {
      if (ok) throw err;
      /* rolling back: the original error is the one worth surfacing */
    } finally {
      this.txDepth--;
    }
  }

  /**
   * Run `fn` inside one transaction (BEGIN/COMMIT at depth 0, SAVEPOINT when
   * nested). Accepts sync or async `fn`; rolls back on throw. Per-question
   * batching: wrap one question's embeds so its writes hit the WAL once.
   *
   * NOT safe for CONCURRENT async callers: SQLite savepoints are a stack, so
   * two interleaved async bodies release each other's savepoints (`no such
   * savepoint`). The harness calls this once per question, sequentially; the
   * caching transport's write-back (which IS concurrent under expansion's
   * parallel query/variant embeds) uses `transactionSync` instead.
   */
  async withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const db = this.requireDb();
    const depth = this.txDepth;
    this.txBegin(db, depth);
    let out: T;
    try {
      out = await fn();
    } catch (err) {
      this.txEnd(db, depth, false);
      throw err;
    }
    this.txEnd(db, depth, true);
    return out;
  }

  /**
   * Synchronous sibling of `withTransaction`: `fn` runs to completion without
   * yielding, so the savepoint it opens is always the innermost one when it is
   * released — safe when many async callers write back concurrently inside
   * one outer `withTransaction` (or with none).
   */
  transactionSync(fn: () => void): void {
    const db = this.requireDb();
    const depth = this.txDepth;
    this.txBegin(db, depth);
    try {
      fn();
    } catch (err) {
      this.txEnd(db, depth, false);
      throw err;
    }
    this.txEnd(db, depth, true);
  }

  /** Bypass accounting for the caching transport (see installEmbedCache). */
  noteBypass(): void {
    this.bypassed++;
  }

  /**
   * Infrastructure-fault accounting for the caching transport. A read fault
   * re-embeds the WHOLE batch uncached: every value of that batch is a miss
   * (the transport served it), and any hits/misses `get()` had already counted
   * for the batch before the fault are retracted so nothing is double-counted.
   * A write fault (`values = 0`) only bumps the fault counter — the batch's
   * misses were already counted by the successful reads.
   */
  noteInfraFault(batch: { values: number; hitsCounted: number; missesCounted: number }): void {
    this.infraFaults++;
    this.hits -= batch.hitsCounted;
    this.misses += batch.values - batch.missesCounted;
  }

  stats(): EmbedCacheStats {
    return { hits: this.hits, misses: this.misses, bypassed: this.bypassed, infra_faults: this.infraFaults, path: this.path };
  }

  size(): number {
    const row = this.requireDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM embed_cache').get();
    return row?.n ?? 0;
  }

  /**
   * Receipt hash (plan D18): `PRAGMA wal_checkpoint(TRUNCATE)` first so the
   * WAL is folded into the main file, then sha256 over the canonical sorted
   * rows `key \0 dims \0 sha256(vector) \n`. Independent of insertion order
   * and WAL state; stable across close/reopen.
   *
   * Streams: rows are pulled one at a time through the statement's
   * `iterate()` (a wave-sized cache holds hundreds of MB of vectors, which
   * `.all()` would materialize at once). The hash INPUT is byte-identical to
   * the eager form — same `ORDER BY key`, same separators — so the value is
   * stable across this change (pinned by test/longmemeval-embed-cache.test.ts).
   */
  canonicalSha256(): string {
    const db = this.requireDb();
    if (this.txDepth === 0) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* checkpoint is best-effort; the row hash below does not depend on it */
      }
    }
    const h = createHash('sha256');
    const rows = db
      .query<{ key: string; dims: number; vector: Uint8Array }, []>(
        'SELECT key, dims, vector FROM embed_cache ORDER BY key',
      )
      .iterate();
    for (const r of rows) {
      h.update(r.key).update('\0').update(String(r.dims)).update('\0').update(sha256Hex(r.vector)).update('\n');
    }
    return h.digest('hex');
  }

  /** sha256 of the main database file bytes (after a checkpoint), read in
   *  fixed-size chunks — never the whole file in memory. Cheap complement to
   *  `canonicalSha256` for `run_config.cache`. */
  fileSha256(): string {
    const db = this.requireDb();
    if (this.txDepth === 0) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort */
      }
    }
    const h = createHash('sha256');
    const fd = openSync(this.path, 'r');
    try {
      const buf = new Uint8Array(FILE_HASH_CHUNK_BYTES);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.byteLength, null);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    return h.digest('hex');
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

export interface InstallEmbedCacheOpts {
  /** gbrain model string the cache is keyed on. Default: the gateway's
   *  resolved `getEmbeddingModel()` at install time. */
  model?: string;
  /** Expected dims. Default: the gateway's `getEmbeddingDimensions()`. */
  dims?: number;
  /** Transport that serves misses. Default: the real ai-sdk `embedMany`.
   *  Restored verbatim by `uninstall()` (or `null` → real embedMany). */
  realTransport?: EmbedTransportFn | null;
}

export interface InstalledEmbedCache {
  model: string;
  dims: number;
  /** Restore the previous transport. Idempotent. */
  uninstall(): void;
}

/** Extract the asymmetric side from ai-sdk embedMany params (absent → document). */
export function sideFromParams(params: Record<string, unknown>): EmbedSide {
  const po = params.providerOptions as { openaiCompatible?: { input_type?: unknown } } | undefined;
  return po?.openaiCompatible?.input_type === 'query' ? 'query' : 'document';
}

/**
 * True when the SDK model object plausibly IS the resolved gbrain model.
 * gbrain model strings are `provider:modelId`; ai-sdk exposes `modelId`.
 * Unknown shape → trust the caller (the cache still verifies dims on put).
 */
function modelMatches(resolved: string, sdkModel: unknown): boolean {
  const id = (sdkModel as { modelId?: unknown } | null)?.modelId;
  if (typeof id !== 'string' || id.length === 0) return true;
  return resolved === id || resolved.endsWith(`:${id}`) || resolved.endsWith(`/${id}`);
}

/**
 * Install a caching transport through the gateway test seam. Hits are served
 * from the cache; misses are batched into ONE call to the real transport and
 * written back inside a single transaction. The cache key is the resolved
 * `model@dims`, so an embedder change (different model or dims) can never be
 * served stale vectors — a batch whose SDK model id disagrees with the
 * resolved model bypasses the cache entirely (counted in `stats().bypassed`).
 *
 * Fail-open ONLY for cache infrastructure faults (file deleted mid-run, disk
 * error): the batch is re-embedded, EVERY value of it is counted as a miss
 * (hits already counted for the batch are retracted) and `infra_faults` is
 * bumped, so `misses > 0` / `infra_faults > 0` flag the run (plan D14/D28) —
 * a run never served from the cache can never report a clean `misses: 0`.
 * Integrity errors are never swallowed.
 */
export function installEmbedCache(cache: EmbeddingCache, opts: InstallEmbedCacheOpts = {}): InstalledEmbedCache {
  const model = opts.model ?? getEmbeddingModel();
  const dims = opts.dims ?? getEmbeddingDimensions();
  if (!Number.isInteger(dims) || dims <= 0) throw new Error(`installEmbedCache: invalid dims ${dims}`);
  const real: EmbedTransportFn = opts.realTransport ?? embedMany;
  cache.open();

  let warnedInfra = false;
  const cachingTransport = (async (params: Parameters<EmbedTransportFn>[0]) => {
    const values = params.values as string[];
    if (!modelMatches(model, params.model)) {
      cache.noteBypass();
      return real(params);
    }
    const side = sideFromParams(params as unknown as Record<string, unknown>);
    const cached: Array<number[] | null> = new Array(values.length).fill(null);
    let cacheHealthy = true;
    const before = cache.stats();
    try {
      for (let i = 0; i < values.length; i++) cached[i] = cache.get(model, dims, values[i], side);
    } catch (err) {
      if (err instanceof EmbedCacheIntegrityError) throw err;
      cacheHealthy = false;
      // Explicit accounting: the whole batch is now served by the transport.
      const after = cache.stats();
      cache.noteInfraFault({
        values: values.length,
        hitsCounted: after.hits - before.hits,
        missesCounted: after.misses - before.misses,
      });
      if (!warnedInfra) {
        warnedInfra = true;
        process.stderr.write(`[embed-cache] read failed, re-embedding uncached (misses += ${values.length}, infra_faults > 0): ${(err as Error).message}\n`);
      }
      cached.fill(null);
    }
    const missing: number[] = [];
    for (let i = 0; i < cached.length; i++) if (cached[i] === null) missing.push(i);
    if (missing.length === 0) {
      return { embeddings: cached as number[][], values, warnings: [] } as unknown as Awaited<ReturnType<EmbedTransportFn>>;
    }
    const realResult = await real({ ...params, values: missing.map((i) => values[i]) });
    const got = realResult.embeddings as number[][];
    if (!Array.isArray(got) || got.length !== missing.length) {
      throw new Error(`embed transport returned ${got?.length ?? 0} embedding(s) for ${missing.length} input(s)`);
    }
    for (let j = 0; j < missing.length; j++) cached[missing[j]] = got[j];
    if (cacheHealthy) {
      try {
        // Synchronous: concurrent batches (expansion embeds query + variants in
        // parallel) must not interleave savepoints inside the per-question tx.
        cache.transactionSync(() => {
          for (let j = 0; j < missing.length; j++) cache.put(model, dims, values[missing[j]], got[j], side);
        });
      } catch (err) {
        if (err instanceof EmbedCacheIntegrityError) throw err;
        // Reads succeeded (misses already counted); only the write-back is lost.
        cache.noteInfraFault({ values: 0, hitsCounted: 0, missesCounted: 0 });
        if (!warnedInfra) {
          warnedInfra = true;
          process.stderr.write(`[embed-cache] write failed, continuing uncached (infra_faults > 0): ${(err as Error).message}\n`);
        }
      }
    }
    return {
      ...realResult,
      embeddings: cached as number[][],
      values,
      warnings: (realResult as { warnings?: unknown[] }).warnings ?? [],
    } as unknown as Awaited<ReturnType<EmbedTransportFn>>;
  }) as unknown as EmbedTransportFn;

  __setEmbedTransportForTests(cachingTransport);
  let installed = true;
  return {
    model,
    dims,
    uninstall() {
      if (!installed) return;
      installed = false;
      __setEmbedTransportForTests(opts.realTransport ?? null);
    },
  };
}
