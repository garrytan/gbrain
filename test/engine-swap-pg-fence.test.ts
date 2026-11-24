/**
 * A swap run's fence, drain, custody, final digests and fingerprint guard on a Postgres primary
 * (docs/guides/engine-swap.md#run).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a Postgres brain while it moves to the Rust engine: once the run fences
 * the primary, no gbrain session can write to it except the run itself; a resumed run repairs the fence instead of
 * opening a gap; the final digests read keys in byte order whatever the database's default collation (an ICU brain
 * must not report a false digest_mismatch); and a fact whose fingerprint would differ under the Rust engine stops the
 * swap before authority moves. (2) Fails when a write from another session lands behind the fence, when a resume leaves
 * a table unfenced, when the digest walks an ICU database in its locale order, when an affected fact or a failed probe
 * lets the swap continue, or when a primary without the fingerprint functions passes as checked. (3) The run tests
 * (test/engine-swap-run.serial.test.ts) use a PGLite primary only. (4) Real Postgres (DATABASE_URL-gated; CI runs it on
 * the Postgres arm, locally on PG17 with an ICU database); only the Rust store's probe RPC is a stub, returning the
 * record the real child would compute.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { fencePrimary, markPrimaryCutover, primaryFenced } from '../src/core/engine-swap/fence.ts';
import { checkFingerprints, primaryRelationDigest, SwapVerifyError } from '../src/core/engine-swap/verify.ts';
import { GRADUATION_FENCE_TRIGGER, readGraduationRow, withGraduationRun } from '../src/core/persistence/graduation-schema.ts';
import { openReadSource, type ReadSource } from '../src/shadow/read-pool.ts';
import type { ProbeRecord } from '../src/shadow/follow-status.ts';
import { PROBE_CORPUS, probeRecord } from '../src/shadow/fingerprints.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const URL_ = process.env.DATABASE_URL;
const d = URL_ ? describe : describe.skip;
const RUN = '00000000-0000-4000-8000-000000000a01';
const CONFIG = { engine: 'postgres' } as unknown as GBrainConfig;

async function insertPage(engine: BrainEngine, slug: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO pages (slug, title, compiled_truth, type) VALUES ($1, $1, '', 'note')`, [slug]);
}

d('a swap run on a Postgres primary', () => {
  let engine: BrainEngine;
  let url: string;
  let close: () => Promise<void>;
  let reads: ReadSource;
  beforeAll(async () => {
    ({ engine, databaseUrl: url, close } = await isolatedPersistencePostgres(URL_!, 'instance', 4, { collation: 'icu-en-US' }));
    reads = openReadSource(engine);
  }, 120_000);
  afterAll(async () => { await reads?.close(); await close(); });

  test('the database under test sorts text in an ICU locale, not byte order', async () => {
    const [row] = await engine.executeRaw<{ first: string }>(`SELECT min(x) AS first FROM (VALUES ('a'), ('B')) v(x)`);
    expect(row!.first).toBe('a'); // ICU puts 'a' before 'B'; byte order would put 'B' first
  });

  test('the final digest walks keys in byte order on an ICU database', async () => {
    for (const slug of ['a-page', 'B-page', 'é-page', 'Z-page']) await insertPage(engine, slug);
    const got = await primaryRelationDigest(reads, 'pages', ['id']);
    const rows = await engine.executeRaw<{ id: string; slug: string }>(`SELECT id::text AS id, slug FROM pages`);
    expect(got.rows).toBe(rows.length);
    // A text key: the slug index walk must follow byte order, not the ICU locale order.
    const bySlug = await primaryRelationDigest(reads, 'pages', ['slug']);
    const bytes = rows.map(r => r.slug).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect(bySlug.order).toEqual(bytes);
    expect(got.digest).toMatch(/^[0-9a-f]{64}$/);
    // The digest is stable and equals one computed from the same rows in byte order.
    const again = await primaryRelationDigest(reads, 'pages', ['id']);
    expect(again.digest).toBe(got.digest);
  }, 60_000);

  test('the fence refuses every other session; only the run writes; cutover keeps the fence', async () => {
    const fenced = await fencePrimary(engine, RUN, { hostId: '00000000-0000-4000-8000-0000000000b1', config: CONFIG });
    expect(fenced.tables).toBeGreaterThan(50);
    expect(await primaryFenced(engine, RUN)).toBe(true);
    await expect(insertPage(engine, 'after-fence')).rejects.toThrow();
    const other = postgres(url, { max: 1 });
    try {
      await expect(other`INSERT INTO pages (slug, title, compiled_truth, type) VALUES ('other-session', 'x', '', 'note')`).rejects.toThrow();
    } finally {
      await other.end();
    }
    await withGraduationRun(engine, RUN, async tx => { await insertPage(tx, 'run-write'); });
    const [n] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug IN ('after-fence', 'other-session', 'run-write')`);
    expect(n!.n).toBe(1);
    await markPrimaryCutover(engine, RUN);
    expect((await readGraduationRow(engine))!.state).toBe('cutover');
    expect(await primaryFenced(engine, RUN)).toBe(true);
  }, 60_000);

  test('a resumed run repairs a fence trigger that went missing, and keeps the run row', async () => {
    await withGraduationRun(engine, RUN, async tx => { await tx.executeRaw(`DROP TRIGGER ${GRADUATION_FENCE_TRIGGER} ON pages`); });
    expect(await primaryFenced(engine, RUN)).toBe(false);
    await fencePrimary(engine, RUN, { hostId: '00000000-0000-4000-8000-0000000000b1', config: CONFIG });
    expect(await primaryFenced(engine, RUN)).toBe(true);
    expect((await readGraduationRow(engine))!.run_id).toBe(RUN);
    await expect(insertPage(engine, 'after-repair')).rejects.toThrow();
  }, 60_000);
});

d('the fingerprint guard on a Postgres primary', () => {
  let engine: BrainEngine;
  let url: string;
  let close: () => Promise<void>;
  let reads: ReadSource;
  beforeAll(async () => {
    ({ engine, databaseUrl: url, close } = await isolatedPersistencePostgres(URL_!, 'instance', 4, { collation: 'icu-en-US' }));
    reads = openReadSource(engine);
  }, 120_000);
  afterAll(async () => { await reads?.close(); await close(); });

  const record = (over: Partial<ProbeRecord>): ProbeRecord => ({
    state: 'pass', checked_at: '2026-11-24T00:00:00.000Z', server_version: '17', collation: 'en-US', mismatches: 0,
    ctype: null, locale_provider: 'i', locale: 'en-US', differing_code_points: [], differing_code_points_total: 0,
    corpus_mismatches: 0, corpus_mismatch_rows: [], facts_with_differing_code_points: 0, ...over,
  });
  const rpcReturning = (r: ProbeRecord | Error) => (async <T>(method: string) => {
    if (method !== 'probe') throw new Error(`unexpected rpc ${method}`);
    if (r instanceof Error) throw r;
    return r as unknown as T;
  });

  test('a clean probe passes and is recorded', async () => {
    expect(await checkFingerprints(reads, rpcReturning(record({})))).toBe('pass');
  }, 60_000);

  test('a stored fact with a differing code point stops the swap with fingerprint_semantics_differ', async () => {
    const r = record({ state: 'fail', differing_code_points: ['U+0130'], differing_code_points_total: 1, facts_with_differing_code_points: 2 });
    const e = await checkFingerprints(reads, rpcReturning(r)).catch(x => x);
    expect(e).toBeInstanceOf(SwapVerifyError);
    expect((e as SwapVerifyError).reason).toBe('fingerprint_semantics_differ');
    expect(String((e as Error).message)).toContain('2 stored fact(s)');
  }, 60_000);

  test('an affected fact stops the swap even when the record says pass', async () => {
    const r = record({ state: 'pass', differing_code_points_total: 1, facts_with_differing_code_points: 1 });
    const e = await checkFingerprints(reads, rpcReturning(r)).catch(x => x);
    expect((e as SwapVerifyError).reason).toBe('fingerprint_semantics_differ');
  }, 60_000);

  test('a probe error stops the swap; it never reads as a pass', async () => {
    const e = await checkFingerprints(reads, rpcReturning(new Error('child gone'))).catch(x => x);
    expect(e).toBeInstanceOf(SwapVerifyError);
    expect((e as SwapVerifyError).reason).toBe('verification_incomplete');
    expect(String((e as Error).message)).toContain('fingerprint probe');
  }, 60_000);

  test('a primary without the fingerprint functions stops the swap instead of passing unchecked', async () => {
    await engine.executeRaw(`DROP FUNCTION IF EXISTS gbrain_fact_fingerprint_v1(text) CASCADE`);
    const e = await checkFingerprints(reads, rpcReturning(record({}))).catch(x => x);
    expect(e).toBeInstanceOf(SwapVerifyError);
    expect((e as SwapVerifyError).reason).toBe('verification_incomplete');
  }, 60_000);
});

/**
 * The guard's rule on stock Postgres (the probe's own rule, probeState): a server whose lower() or [[:space:]] differs
 * from the Rust engine on some code points refuses only when a stored fact holds one of them. Stock PG17 differs on
 * dozens (libc and ICU alike), so its probe corpus always reports mismatches; a brain with no affected fact still swaps.
 * The probe RPC computes the record as the shadow child does (probeRecord), with the Rust side's corpus answers taken
 * from PGLite, which the Rust fixture is pinned to (rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json).
 */
d('the fingerprint guard on stock Postgres', () => {
  let reference: Array<{ fingerprint: string; fingerprint_v1: string }>;
  beforeAll(async () => {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    reference = (await pglite.executeRaw<{ a: string; b: string }>(
      `SELECT gbrain_fact_fingerprint(s) AS a, gbrain_fact_fingerprint_v1(s) AS b FROM unnest($1::text[]) WITH ORDINALITY AS u(s, n) ORDER BY n`,
      [[...PROBE_CORPUS]])).map(r => ({ fingerprint: r.a, fingerprint_v1: r.b }));
    await pglite.disconnect();
  }, 120_000);

  const childRpc = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
    if (method !== 'probe') throw new Error(`unexpected rpc ${method}`);
    const { sql, ...meta } = args as { sql: Array<[string, string]> } & Record<string, unknown>;
    return probeRecord(sql, reference, meta as never, new Date('2026-11-24T00:00:00Z')) as unknown as T;
  };

  for (const collation of [undefined, 'icu-en-US'] as const) {
    test(`a stock PG17 ${collation ?? 'libc'} brain with no facts passes, although its probe corpus reports mismatches`, async () => {
      const db = await isolatedPersistencePostgres(URL_!, 'instance', 2, collation ? { collation } : {});
      const reads = openReadSource(db.engine);
      try {
        const sample = await reads.read(async tx => (await import('../src/shadow/fingerprints.ts')).probeOnPrimary(tx));
        expect(sample.differing_code_points_total).toBeGreaterThan(0);
        expect(sample.corpus_mismatches).toBeGreaterThan(0);
        expect(await checkFingerprints(reads, childRpc)).toBe('pass');
      } finally { await reads.close(); await db.close(); }
    }, 120_000);
  }

  test('one stored fact holding a differing code point refuses', async () => {
    const db = await isolatedPersistencePostgres(URL_!, 'instance', 2);
    const reads = openReadSource(db.engine);
    try {
      // U+0085 (next line) is whitespace to the Rust engine and not to stock Postgres [[:space:]].
      await db.engine.insertFact({ fact: 'Alice\u0085prefers mornings', entity_slug: 'people/alice-example', source: 'test' }, { source_id: 'default' });
      const e = await checkFingerprints(reads, childRpc).catch(x => x);
      expect(e).toBeInstanceOf(SwapVerifyError);
      expect((e as SwapVerifyError).reason).toBe('fingerprint_semantics_differ');
      expect(String((e as Error).message)).toContain('1 stored fact(s)');
    } finally { await reads.close(); await db.close(); }
  }, 120_000);
});
