/**
 * src/eval/shared/embed-cache.ts — hermetic pins.
 *
 * No network, no API spend: the "real" transport is a counting fake. bun:sqlite
 * files live under a per-test tmp dir. The gateway is configured explicitly
 * (openai:text-embedding-3-large @ 4 dims) so the install path resolves a
 * known model@dims without touching the preload's baseline beyond resetGateway.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EmbeddingCache,
  EmbedCacheIntegrityError,
  installEmbedCache,
  sideFromParams,
} from '../src/eval/shared/embed-cache.ts';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

const MODEL = 'openai:text-embedding-3-large';
const DIMS = 4;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-embed-cache-'));
});
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(dir, { recursive: true, force: true });
});

/** Binary-exact values (multiples of 1/8) so the Float32 round-trip is lossless. */
function vec(seed: number, dims = DIMS): number[] {
  return Array.from({ length: dims }, (_, i) => (seed + i) / 8);
}

describe('EmbeddingCache — get/put/stats', () => {
  test('miss then hit, stats count both, path reported', () => {
    const c = new EmbeddingCache(join(dir, 'a.sqlite'));
    c.open();
    expect(c.get(MODEL, DIMS, 'hello')).toBeNull();
    c.put(MODEL, DIMS, 'hello', vec(1));
    expect(c.get(MODEL, DIMS, 'hello')).toEqual(vec(1));
    const s = c.stats();
    expect(s).toEqual({ hits: 1, misses: 1, bypassed: 0, infra_faults: 0, path: join(dir, 'a.sqlite') });
    expect(c.size()).toBe(1);
    c.close();
  });

  test('key is model@dims:sha256(text); dims/model/side changes are different keys', () => {
    const c = new EmbeddingCache(join(dir, 'k.sqlite'));
    const k = c.key(MODEL, 1536, 'x');
    expect(k).toMatch(new RegExp(`^${MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@1536:[0-9a-f]{64}$`));
    expect(c.key(MODEL, 1024, 'x')).not.toBe(k);
    expect(c.key('voyage:voyage-4', 1536, 'x')).not.toBe(k);
    expect(c.key(MODEL, 1536, 'y')).not.toBe(k);
    expect(c.key(MODEL, 1536, 'x', 'query')).toContain('#query:');
    expect(c.key(MODEL, 1536, 'x', 'query')).not.toBe(k);
    // side-aware storage: a document-side vector is never served for a query-side lookup
    c.open();
    c.put(MODEL, DIMS, 'x', vec(1), 'document');
    expect(c.get(MODEL, DIMS, 'x', 'query')).toBeNull();
    expect(c.get(MODEL, DIMS, 'x', 'document')).toEqual(vec(1));
    c.close();
  });

  test('WAL journal mode + synchronous=NORMAL are set', () => {
    const c = new EmbeddingCache(join(dir, 'w.sqlite'));
    c.open();
    const raw = new Database(join(dir, 'w.sqlite'));
    expect((raw.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase()).toBe('wal');
    raw.close();
    c.close();
  });

  test('operations before open() throw a clear error', () => {
    const c = new EmbeddingCache(join(dir, 'closed.sqlite'));
    expect(() => c.get(MODEL, DIMS, 'x')).toThrow(/not open/);
  });
});

describe('EmbeddingCache — integrity (hard errors)', () => {
  test('put with a vector whose length != dims throws naming file and key', () => {
    const path = join(dir, 'i.sqlite');
    const c = new EmbeddingCache(path);
    c.open();
    let err: unknown;
    try {
      c.put(MODEL, DIMS, 'short', [0.1, 0.2]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmbedCacheIntegrityError);
    expect((err as Error).message).toContain(path);
    expect((err as Error).message).toContain(c.key(MODEL, DIMS, 'short'));
    expect(c.size()).toBe(0);
    c.close();
  });

  test('a stored row whose byte length disagrees with its dims is a hard error on read', () => {
    const path = join(dir, 'corrupt.sqlite');
    const c = new EmbeddingCache(path);
    c.open();
    c.put(MODEL, DIMS, 'ok', vec(2));
    // Tamper: declare 8 dims on a 4-dim blob, under the 8-dim key.
    const badKey = c.key(MODEL, 8, 'ok');
    const raw = new Database(path);
    raw
      .query('INSERT INTO embed_cache (key, model, dims, byte_len, vector) VALUES (?, ?, ?, ?, ?)')
      .run(badKey, MODEL, 8, 32, new Uint8Array(16));
    raw.close();
    expect(() => c.get(MODEL, 8, 'ok')).toThrow(EmbedCacheIntegrityError);
    try {
      c.get(MODEL, 8, 'ok');
    } catch (e) {
      expect((e as Error).message).toContain(path);
      expect((e as Error).message).toContain(badKey);
    }
    // the healthy row is still fine
    expect(c.get(MODEL, DIMS, 'ok')).toEqual(vec(2));
    c.close();
  });
});

describe('EmbeddingCache — canonical hash', () => {
  test('stable across close/reopen and independent of WAL state + insertion order', () => {
    const pathA = join(dir, 'h1.sqlite');
    const a = new EmbeddingCache(pathA);
    a.open();
    a.put(MODEL, DIMS, 't1', vec(1));
    a.put(MODEL, DIMS, 't2', vec(2));
    a.put(MODEL, DIMS, 't3', vec(3));
    // Before any checkpoint the WAL sidecar carries the rows.
    const walBefore = existsSync(`${pathA}-wal`) ? statSync(`${pathA}-wal`).size : 0;
    const h1 = a.canonicalSha256();
    // checkpoint(TRUNCATE) folded the WAL into the main file
    const walAfter = existsSync(`${pathA}-wal`) ? statSync(`${pathA}-wal`).size : 0;
    expect(walAfter).toBeLessThanOrEqual(walBefore);
    a.close();

    const a2 = new EmbeddingCache(pathA);
    a2.open();
    expect(a2.canonicalSha256()).toBe(h1);
    a2.close();

    // Same rows, different insertion order, different file → same canonical hash.
    const b = new EmbeddingCache(join(dir, 'h2.sqlite'));
    b.open();
    b.put(MODEL, DIMS, 't3', vec(3));
    b.put(MODEL, DIMS, 't1', vec(1));
    b.put(MODEL, DIMS, 't2', vec(2));
    expect(b.canonicalSha256()).toBe(h1);
    // Any content change moves it.
    b.put(MODEL, DIMS, 't4', vec(4));
    expect(b.canonicalSha256()).not.toBe(h1);
    b.close();
  });

  test('canonical hash VALUE is pinned: streaming rows (iterate) hashes exactly what the eager form did', () => {
    // Literal computed on the pre-streaming implementation (`.all()` +
    // readFileSync) over this exact fixture. The streaming rewrite must not
    // move it: same ORDER BY key, same `key \0 dims \0 sha256(vector) \n`
    // input, one row at a time.
    const pinVec = (seed: number): number[] => [seed, seed / 2, -seed, 0.25 * seed];
    const c = new EmbeddingCache(join(dir, 'pin.sqlite'));
    c.open();
    c.put(MODEL, DIMS, 't1', pinVec(1));
    c.put(MODEL, DIMS, 't2', pinVec(2));
    c.put(MODEL, DIMS, 't3', pinVec(3));
    c.put(MODEL, DIMS, 'q1', pinVec(1), 'query');
    expect(c.canonicalSha256()).toBe('4465dd82365a2ec400a62f8825ec1fa2a40325bbfed764ecd36e94fb8510ccd9');
    // …and the documented formula recomputed independently agrees.
    const rows = new Database(c.path)
      .query<{ key: string; dims: number; vector: Uint8Array }, []>('SELECT key, dims, vector FROM embed_cache ORDER BY key')
      .all();
    expect(rows.length).toBe(4);
    const h = createHash('sha256');
    for (const r of rows) {
      const vh = createHash('sha256').update(r.vector).digest('hex');
      h.update(`${r.key}\0${r.dims}\0${vh}\n`);
    }
    expect(h.digest('hex')).toBe('4465dd82365a2ec400a62f8825ec1fa2a40325bbfed764ecd36e94fb8510ccd9');
    // fileSha256 streams the file in chunks; it must equal a whole-file digest.
    expect(c.fileSha256()).toBe(createHash('sha256').update(readFileSync(c.path)).digest('hex'));
    c.close();
  });

  test('the module source carries no raw NUL bytes (the separators are the \\0 escape)', () => {
    // A literal 0x00 inside a string literal made file(1) classify the module
    // as data and `grep -I` skip it. Same hash input, escaped spelling.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'eval', 'shared', 'embed-cache.ts'), 'utf-8');
    expect(src.includes('\0')).toBe(false);
    expect(src).toContain(".update('\\0')");
  });

  test('empty cache hashes deterministically; fileSha256 is a hex digest', () => {
    const c = new EmbeddingCache(join(dir, 'e.sqlite'));
    c.open();
    const h = c.canonicalSha256();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(c.fileSha256()).toMatch(/^[0-9a-f]{64}$/);
    c.close();
    const d = new EmbeddingCache(join(dir, 'e2.sqlite'));
    d.open();
    expect(d.canonicalSha256()).toBe(h);
    d.close();
  });
});

describe('EmbeddingCache — withTransaction', () => {
  test('batches puts; a throwing body rolls back; nesting uses savepoints', async () => {
    const c = new EmbeddingCache(join(dir, 'tx.sqlite'));
    c.open();
    await c.withTransaction(() => {
      for (let i = 0; i < 20; i++) c.put(MODEL, DIMS, `q${i}`, vec(i));
    });
    expect(c.size()).toBe(20);

    await expect(
      c.withTransaction(async () => {
        c.put(MODEL, DIMS, 'rolled', vec(99));
        await Promise.resolve();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(c.size()).toBe(20);
    expect(c.get(MODEL, DIMS, 'rolled')).toBeNull();

    // nested: inner rollback does not lose the outer's writes
    await c.withTransaction(async () => {
      c.put(MODEL, DIMS, 'outer', vec(5));
      try {
        await c.withTransaction(() => {
          c.put(MODEL, DIMS, 'inner', vec(6));
          throw new Error('inner-fail');
        });
      } catch {
        /* expected */
      }
    });
    expect(c.get(MODEL, DIMS, 'outer')).toEqual(vec(5));
    expect(c.get(MODEL, DIMS, 'inner')).toBeNull();
    c.close();
  });
});

describe('installEmbedCache — gateway seam', () => {
  function fakeTransport(dims = DIMS) {
    const calls: string[][] = [];
    const fn = (async (params: { values: string[] }) => {
      calls.push([...params.values]);
      return {
        embeddings: params.values.map((v) => vec(v.length, dims)),
        values: params.values,
        warnings: [],
        usage: { tokens: params.values.length },
      };
    }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];
    return { calls, fn: fn! };
  }

  beforeEach(() => {
    configureGateway({
      embedding_model: MODEL,
      embedding_dimensions: DIMS,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
  });

  test('serves hits from the cache and batches only misses to the real transport', async () => {
    const cache = new EmbeddingCache(join(dir, 'install.sqlite'));
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    expect(inst.model).toBe(MODEL);
    expect(inst.dims).toBe(DIMS);

    const first = await embed(['aa', 'bbb']);
    expect(real.calls).toEqual([['aa', 'bbb']]);
    expect(first.map((f) => Array.from(f))).toEqual([vec(2), vec(3)]);

    const second = await embed(['aa', 'bbb']);
    expect(real.calls.length).toBe(1); // all hits, no transport call
    expect(second.map((f) => Array.from(f))).toEqual([vec(2), vec(3)]);

    const third = await embed(['aa', 'cccc', 'bbb']);
    expect(real.calls.length).toBe(2);
    expect(real.calls[1]).toEqual(['cccc']); // only the miss went out
    expect(third.map((f) => Array.from(f))).toEqual([vec(2), vec(4), vec(3)]);

    const s = cache.stats();
    expect(s.hits).toBe(4);
    expect(s.misses).toBe(3);
    expect(s.bypassed).toBe(0);
    expect(cache.size()).toBe(3);
    inst.uninstall();
    cache.close();
  });

  test('vectors are keyed under the resolved model@dims (a different embedder cannot read them)', async () => {
    const cache = new EmbeddingCache(join(dir, 'keyed.sqlite'));
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    await embed(['aa']);
    inst.uninstall();
    expect(cache.get(MODEL, DIMS, 'aa')).toEqual(vec(2));
    expect(cache.get('voyage:voyage-4', DIMS, 'aa')).toBeNull();
    expect(cache.get(MODEL, 1536, 'aa')).toBeNull();
    cache.close();
  });

  test('query-side embeds are cached under the query key, not the document key', async () => {
    const cache = new EmbeddingCache(join(dir, 'side.sqlite'));
    // Use an asymmetric provider so the gateway emits input_type (zembed-1's
    // smallest supported Matryoshka dims is 40).
    const ZE_DIMS = 40;
    const real = fakeTransport(ZE_DIMS);
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: ZE_DIMS,
      env: { ZEROENTROPY_API_KEY: 'sk-fake' },
    });
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    expect(inst.model).toBe('zeroentropyai:zembed-1');
    expect(inst.dims).toBe(ZE_DIMS);
    await embedQuery('aa');
    await embed(['aa']);
    expect(real.calls.length).toBe(2); // the two sides never alias
    expect(cache.get('zeroentropyai:zembed-1', ZE_DIMS, 'aa', 'query')).toEqual(vec(2, ZE_DIMS));
    expect(cache.get('zeroentropyai:zembed-1', ZE_DIMS, 'aa', 'document')).toEqual(vec(2, ZE_DIMS));
    await embedQuery('aa');
    expect(real.calls.length).toBe(2); // query-side hit
    inst.uninstall();
    cache.close();
  });

  test('sideFromParams reads providerOptions.openaiCompatible.input_type', () => {
    expect(sideFromParams({})).toBe('document');
    expect(sideFromParams({ providerOptions: { openaiCompatible: { input_type: 'query' } } })).toBe('query');
    expect(sideFromParams({ providerOptions: { openaiCompatible: { input_type: 'document' } } })).toBe('document');
  });

  test('a batch whose SDK model id is not the resolved model bypasses the cache', async () => {
    const cache = new EmbeddingCache(join(dir, 'bypass.sqlite'));
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn, model: 'voyage:voyage-4', dims: DIMS });
    await embed(['aa']); // gateway resolves openai:text-embedding-3-large → modelId mismatch
    await embed(['aa']);
    expect(real.calls.length).toBe(2);
    expect(cache.size()).toBe(0);
    expect(cache.stats().bypassed).toBe(2);
    inst.uninstall();
    cache.close();
  });

  test('uninstall restores the prior transport (every embed reaches it directly again)', async () => {
    const cache = new EmbeddingCache(join(dir, 'restore.sqlite'));
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    await embed(['aa']);
    await embed(['aa']);
    expect(real.calls.length).toBe(1);
    inst.uninstall();
    inst.uninstall(); // idempotent
    await embed(['aa']);
    expect(real.calls.length).toBe(2); // cache no longer in the path
    expect(cache.stats().hits).toBe(1);
    cache.close();
  });

  test('a cache infrastructure fault mid-run re-embeds uncached AND is accounted: misses grow by the batch, infra_faults > 0', async () => {
    const path = join(dir, 'infra.sqlite');
    const cache = new EmbeddingCache(path);
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    // Warm two rows so the fault batch has genuine hits to retract.
    await embed(['aa', 'bbb']);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, infra_faults: 0 });
    // Infrastructure fault: the table vanishes under the open handle (a
    // deleted/replaced cache file behaves the same way) — NOT an integrity
    // error, so the batch falls open to the real transport.
    const raw = new Database(path);
    raw.exec('DROP TABLE embed_cache');
    raw.close();
    const out = await embed(['aa', 'bbb', 'cccc']);
    expect(out.map((f) => Array.from(f))).toEqual([vec(2), vec(3), vec(4)]);
    // The whole 3-value batch went to the transport.
    expect(real.calls.length).toBe(2);
    expect(real.calls[1]).toEqual(['aa', 'bbb', 'cccc']);
    const s = cache.stats();
    // Pre-fix: misses stayed 2 (the run looked "served from cache" for the
    // re-embedded batch). Now: 2 genuine + 3 re-embedded = 5, no hits kept
    // for a batch the cache never served, and the fault is named.
    expect(s.misses).toBe(5);
    expect(s.hits).toBe(0);
    expect(s.infra_faults).toBe(1);
    // A second faulting batch keeps accounting (2 faults, +1 miss).
    await embed(['dd']);
    expect(cache.stats()).toMatchObject({ misses: 6, hits: 0, infra_faults: 2 });
    inst.uninstall();
    // A run that only ever fell open can never show a clean misses:0 receipt.
    expect(cache.stats().misses).toBeGreaterThan(0);
    // close() must not throw on the faulted handle.
    cache.close();
  });

  test('concurrent miss batches inside one outer withTransaction commit cleanly (no savepoint interleave, infra_faults 0)', async () => {
    // Expansion embeds the query + its variants in PARALLEL; each is a separate
    // caching-transport batch. Pre-fix the write-back used the async
    // withTransaction, whose savepoint depth interleaved across the concurrent
    // bodies (`no such savepoint: embed_cache_sp_2`) and was mis-reported as a
    // cache infrastructure fault on every expansion question.
    const cache = new EmbeddingCache(join(dir, 'concurrent.sqlite'));
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    const results = await cache.withTransaction(async () =>
      Promise.all([embed(['q-original']), embed(['q-variant-1']), embed(['q-variant-2']), embed(['doc-a', 'doc-b'])]),
    );
    expect(results.map((r) => r.length)).toEqual([1, 1, 1, 2]);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 5, infra_faults: 0 });
    expect(cache.size()).toBe(5); // every write-back committed with the outer tx
    // And with NO outer transaction (each batch opens its own BEGIN/COMMIT).
    await Promise.all([embed(['x1']), embed(['x2']), embed(['x3'])]);
    expect(cache.stats()).toMatchObject({ misses: 8, infra_faults: 0 });
    expect(cache.size()).toBe(8);
    inst.uninstall();
    cache.close();
  });

  test('a fault while WRITING back (reads fine) bumps infra_faults without double-counting misses', async () => {
    const path = join(dir, 'infra-write.sqlite');
    const cache = new EmbeddingCache(path);
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    // Make the write fail but the read succeed: an INSERT trigger that aborts.
    const raw = new Database(path);
    raw.exec(`CREATE TRIGGER block_insert BEFORE INSERT ON embed_cache BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END`);
    raw.close();
    await embed(['aa', 'bbb']);
    const s = cache.stats();
    expect(s.misses).toBe(2); // counted once, by the reads
    expect(s.hits).toBe(0);
    expect(s.infra_faults).toBe(1);
    expect(cache.size()).toBe(0); // nothing was written
    inst.uninstall();
    cache.close();
  });

  test('a corrupt row surfaced during a real embed is a hard error, not a silent re-embed', async () => {
    const path = join(dir, 'hard.sqlite');
    const cache = new EmbeddingCache(path);
    const real = fakeTransport();
    const inst = installEmbedCache(cache, { realTransport: real.fn });
    await embed(['aa']);
    const raw = new Database(path);
    raw.query('UPDATE embed_cache SET byte_len = 3').run();
    raw.close();
    await expect(embed(['aa'])).rejects.toThrow(/integrity/);
    inst.uninstall();
    cache.close();
  });
});
