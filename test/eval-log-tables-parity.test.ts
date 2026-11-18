/**
 * Eval caches and log tables parity: the contradiction probe runs and judge
 * cache, the dream verdict cache, the ingest log and eval capture return the
 * same rows, values and refusals on PGLite and Postgres (in-memory PGLite;
 * Postgres too when DATABASE_URL is set).
 *
 * Rust engine contract. Differences pinned here, with the engine the Rust
 * engine must match:
 * - Clock resolution. PGLite's now() and clock_timestamp() tick in whole
 *   milliseconds; Postgres ticks in microseconds. Two writes in the same
 *   millisecond tie on PGLite only. Rust matches Postgres (microseconds).
 *   Readers that sort on a write time break ties by id, newest first
 *   (getIngestLog, listEvalCaptureFailures, listEvalCandidates), so the order
 *   does not depend on the clock.
 * - A JSON null outside the declared types. putContradictionCacheEntry with
 *   verdict null stores a JSON null on PGLite and is refused (23502) on
 *   Postgres. putDreamVerdict with null arrays stores JSON null on PGLite and
 *   SQL NULL on Postgres; both read back []. With undefined arrays, PGLite
 *   stores SQL NULL and Postgres refuses (UNDEFINED_VALUE). Rust matches
 *   Postgres: a null JSON argument binds SQL NULL.
 * Everything else below is one answer on both engines, and Rust must give it.
 *
 * 1. Protects: writeContradictionsRun, loadContradictionsTrend,
 *    get/put/sweepContradictionCache(Entry), get/put/sweepDreamVerdict(s),
 *    logIngest, getIngestLog, logEvalCandidate, listEvalCandidates,
 *    deleteEvalCandidatesBefore, logEvalCaptureFailure and
 *    listEvalCaptureFailures: stored values (REAL and DOUBLE rounding, NaN and
 *    Infinity, large JSON numbers, unicode, empty keys), cache expiry and TTLs,
 *    sweep counts, limit and since boundaries, tie order, and the refusal code
 *    for each invalid input (NUL, lone surrogate, non-integer, overflow, CHECK).
 * 2. Fails when: an engine's statement or driver changes a stored or returned
 *    value, an expired row is served or not swept, a TTL moves, a since/before
 *    boundary flips between inclusive and exclusive, a limit default changes,
 *    the id tiebreaker is dropped from a reader, or an invalid input starts
 *    to be accepted or refused with another code.
 * 3. Existing coverage: test/engine-parity/takes.test.ts (typed-methods branch)
 *    has one happy-path case per cache; test/e2e/eval-capture*.test.ts and
 *    test/eval-capture*.test.ts cover capture on one engine at a time. No
 *    file compares expiry, refusals or tie order across the two engines.
 * 4. Real seams: the engines' public methods. Expired rows, tied write times
 *    and old candidates are set up with SQL so every time is pinned.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

/** One case result per engine, compared at the end of the file. */
const seen = new Map<TestBackend, Record<string, unknown>>();
/** Results that differ by design, checked against the pinned values per engine. */
const pinned = new Map<TestBackend, Record<string, unknown>>();
const backends = testBackends();

function record(kind: TestBackend, name: string, value: unknown, into = seen): void {
  const run = into.get(kind) ?? {};
  run[name] = value;
  into.set(kind, run);
}

/** The value of a call, or the refusal code. A refusal raised before SQL has no code; its message is kept. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await fn() };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { refused: err.code ?? String(err.message) };
  }
}

/** JSON-comparable form: Dates, NaN and Infinity become tagged strings. */
function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => {
    if (x instanceof Date) return `Date`;
    if (typeof x === 'number' && !Number.isFinite(x)) return `Num(${x})`;
    return x;
  }));
}

function typesOf(row: object): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    v === null ? 'null' : v instanceof Date ? 'Date' : Array.isArray(v) ? `array<${v.map((x) => typeof x).join(',')}>` : typeof v]));
}

const RUN = {
  judge_model: 'judge-m1', prompt_version: 'v1', queries_evaluated: 20, queries_with_contradiction: 4, total_contradictions_flagged: 6,
  wilson_ci_lower: 0.1, wilson_ci_upper: 0.123456789, judge_errors_total: 0, cost_usd_total: 1234.5678, duration_ms: 5,
  source_tier_breakdown: { curated: 3 }, report_json: {},
};
const KEY = { chunk_a_hash: 'hash-a', chunk_b_hash: 'hash-b', model_id: 'judge-m1', prompt_version: 'v1', truncation_policy: 'head-2k' };
const VERDICT = {
  worth_processing: true, reasons: ['names a person'], score: 0.5, content_type: 'meeting',
  segments: [{ quote: 'we ship in Q3' }], entities: ['people/alice-example'], model: 'triage-m1', triage_version: 1,
};
const CANDIDATE = {
  tool_name: 'query' as const, query: 'what did acme-example ship', retrieved_slugs: [] as string[], retrieved_chunk_ids: [1, 2],
  source_ids: [] as string[], expand_enabled: null, detail: null, detail_resolved: null, vector_enabled: true,
  expansion_applied: false, latency_ms: 3, remote: false, job_id: null, subagent_id: null,
};

for (const kind of backends) {
  describe(`eval caches and log tables (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('clock resolution: PGLite ticks in milliseconds, Postgres in microseconds', async () => {
      const [{ sub_ms }] = await engine.executeRaw<{ sub_ms: number[] }>(
        `SELECT array_agg((extract(microseconds FROM clock_timestamp())::bigint % 1000)::int) AS sub_ms FROM generate_series(1, 50)`,
      );
      // 50 samples all on a whole millisecond by chance is about 1 in 10^150.
      const resolution = sub_ms.every((x) => Number(x) === 0) ? 'milliseconds' : 'microseconds';
      expect(resolution).toBe(kind === 'pglite' ? 'milliseconds' : 'microseconds');
      record(kind, 'clockResolution', resolution, pinned);
    });

    test('contradiction runs: one row per run_id, REAL rounding, JSON fidelity, refusal codes, trend window', async () => {
      const wrote = [
        await engine.writeContradictionsRun({ ...RUN, run_id: 'run-a', wilson_ci_lower: 1e-8, cost_usd_total: 0.37 }),
        await engine.writeContradictionsRun({ ...RUN, run_id: 'run-a', queries_evaluated: 999 }),
        await engine.writeContradictionsRun({
          ...RUN, run_id: 'run-json',
          report_json: { big: 1e20, huge: 12345678901234567890, neg0: -0, sum: 0.1 + 0.2, uni: 'é😀', arr: [1, 'a', null, true], nested: { a: { b: [] } }, empty: { '': 1 } },
        }),
        await engine.writeContradictionsRun({ ...RUN, run_id: 'run-nan', wilson_ci_lower: NaN }),
      ];
      expect(wrote).toEqual([true, false, true, true]);
      const refusals = {
        nulInJson: await outcome(() => engine.writeContradictionsRun({ ...RUN, run_id: 'r-nul', report_json: { s: 'a\u0000b' } })),
        loneSurrogateInJson: await outcome(() => engine.writeContradictionsRun({ ...RUN, run_id: 'r-lone', report_json: { s: 'a\ud800b' } })),
        nonInteger: await outcome(() => engine.writeContradictionsRun({ ...RUN, run_id: 'r-frac', queries_evaluated: 1.5 })),
        intOverflow: await outcome(() => engine.writeContradictionsRun({ ...RUN, run_id: 'r-big', duration_ms: 3_000_000_000 })),
      };
      expect(refusals).toEqual({
        nulInJson: { refused: '22P05' }, loneSurrogateInJson: { refused: '22P02' }, nonInteger: { refused: '22P02' }, intOverflow: { refused: '22003' },
      });
      const trend = await engine.loadContradictionsTrend(7);
      expect(trend.every((r) => typeof r.ran_at === 'string' && Number.isFinite(Date.parse(r.ran_at)))).toBe(true);
      const byId = Object.fromEntries(trend.map(({ ran_at: _ranAt, ...rest }) => [rest.run_id, plain(rest)]));
      expect(Object.keys(byId).sort()).toEqual(['run-a', 'run-json', 'run-nan']);
      expect(byId['run-a']).toMatchObject({ queries_evaluated: 20, wilson_ci_lower: 1e-8, wilson_ci_upper: 0.12345679, cost_usd_total: 0.37 });
      expect(byId['run-json']).toMatchObject({
        cost_usd_total: 1234.5677,
        report_json: { big: 1e20, huge: 12345678901234567000, neg0: 0, sum: 0.30000000000000004, uni: 'é😀', arr: [1, 'a', null, true], nested: { a: { b: [] } }, empty: { '': 1 } },
      });
      expect((byId['run-nan'] as { wilson_ci_lower: unknown }).wilson_ci_lower).toBe('Num(NaN)');
      const windows = {
        negativeDays: (await engine.loadContradictionsTrend(-3)).length,
        nanDays: await outcome(() => engine.loadContradictionsTrend(NaN)),
      };
      expect(windows).toEqual({ negativeDays: 0, nanDays: { refused: 'Invalid Date' } });
      record(kind, 'contradictionRuns', { wrote, refusals, byId, windows });
    });

    test('judge cache: expired rows miss and are swept, a put revives an expired key, TTL floor and refusals', async () => {
      await engine.putContradictionCacheEntry({ ...KEY, verdict: { contradicts: true } });
      await engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'floor', verdict: { contradicts: false }, ttl_seconds: 1 });
      await engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'array', verdict: [1, 2] as never });
      await engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'string', verdict: 'yes' as never });
      await engine.executeRaw(
        `INSERT INTO eval_contradictions_cache (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy, verdict, expires_at)
         VALUES ('expired', 'hash-b', 'judge-m1', 'v1', 'head-2k', '{"old":true}'::jsonb, now() - interval '1 second'),
                ('revive',  'hash-b', 'judge-m1', 'v1', 'head-2k', '{"old":true}'::jsonb, now() - interval '1 day')`,
      );
      const ttls = await engine.executeRaw<{ chunk_a_hash: string; secs: number }>(
        `SELECT chunk_a_hash, round(extract(epoch FROM expires_at - created_at))::int AS secs
           FROM eval_contradictions_cache WHERE chunk_a_hash IN ('hash-a', 'floor') ORDER BY chunk_a_hash`,
      );
      // expires_at comes from the caller's clock and created_at from the database clock: allow 5 s of skew.
      const ttl = Object.fromEntries(ttls.map((r) => [r.chunk_a_hash, Number(r.secs)]));
      expect(Math.abs(ttl['hash-a'] - 30 * 86400)).toBeLessThanOrEqual(5);
      expect(Math.abs(ttl.floor - 60)).toBeLessThanOrEqual(5);
      const reads = {
        live: await engine.getContradictionCacheEntry(KEY),
        floor: await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'floor' }),
        array: await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'array' }),
        string: await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'string' }),
        expired: await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'expired' }),
        caseSensitive: await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'HASH-A' }),
      };
      expect(reads as unknown).toEqual({
        live: { contradicts: true }, floor: { contradicts: false }, array: [1, 2], string: 'yes',
        expired: null, caseSensitive: null,
      });
      await engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'revive', verdict: { fresh: true } });
      const revived = await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'revive' });
      expect(revived).toEqual({ fresh: true });
      const swept = [await engine.sweepContradictionCache(), await engine.sweepContradictionCache()];
      expect(swept).toEqual([1, 0]);
      const refusals = {
        nul: await outcome(() => engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'nul', verdict: { s: 'x\u0000' } })),
        // Unlike putDreamVerdict, the judge cache does not repair a lone surrogate: it refuses.
        loneSurrogate: await outcome(() => engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'lone', verdict: { s: 'x\udc00' } })),
        nanTtl: await outcome(() => engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'nan', verdict: {}, ttl_seconds: NaN })),
        hugeTtl: await outcome(() => engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'huge', verdict: {}, ttl_seconds: 1e12 })),
      };
      expect(refusals).toEqual({ nul: { refused: '22P05' }, loneSurrogate: { refused: '22P02' }, nanTtl: { refused: 'Invalid Date' }, hugeTtl: { refused: '22009' } });
      record(kind, 'judgeCache', { reads, revived, swept, refusals });

      const nullVerdict = await outcome(() => engine.putContradictionCacheEntry({ ...KEY, chunk_a_hash: 'null', verdict: null as never }));
      const nullRead = await engine.getContradictionCacheEntry({ ...KEY, chunk_a_hash: 'null' });
      record(kind, 'nullVerdict', { nullVerdict, nullRead }, pinned);
    });

    test('dream verdicts: 30-day server-side TTL, expiry and sweep, DOUBLE and INT fidelity, text repair and refusals', async () => {
      await engine.putDreamVerdict('transcripts/a.md', 'third', { ...VERDICT, score: 1 / 3, triage_version: 2147483647 });
      await engine.putDreamVerdict('transcripts/a.md', 'nan', { ...VERDICT, score: NaN });
      await engine.putDreamVerdict('transcripts/a.md', 'inf', { ...VERDICT, score: Infinity });
      await engine.putDreamVerdict('transcripts/a.md', 'lone', { ...VERDICT, reasons: ['a\ud800'], segments: [{ quote: 'q\udfff', note: 'n' }] });
      await engine.putDreamVerdict('transcripts/a.md', 'expired', VERDICT);
      const [{ secs }] = await engine.executeRaw<{ secs: number }>(
        `SELECT extract(epoch FROM expires_at - judged_at)::int AS secs FROM dream_verdicts WHERE content_hash = 'third'`,
      );
      expect(Number(secs)).toBe(30 * 86400);
      await engine.executeRaw(`UPDATE dream_verdicts SET expires_at = now() - interval '1 second' WHERE content_hash = 'expired'`);
      const strip = (v: Awaited<ReturnType<BrainEngine['getDreamVerdict']>>) => (v ? plain({ ...v, judged_at: typeof v.judged_at }) : v);
      const reads = {
        third: strip(await engine.getDreamVerdict('transcripts/a.md', 'third')),
        nan: strip(await engine.getDreamVerdict('transcripts/a.md', 'nan')),
        inf: strip(await engine.getDreamVerdict('transcripts/a.md', 'inf')),
        lone: strip(await engine.getDreamVerdict('transcripts/a.md', 'lone')),
        expired: strip(await engine.getDreamVerdict('transcripts/a.md', 'expired')),
      };
      expect(reads.third).toMatchObject({ score: 1 / 3, triage_version: 2147483647, judged_at: 'string' });
      expect(reads.nan).toMatchObject({ score: 'Num(NaN)' });
      expect(reads.inf).toMatchObject({ score: 'Num(Infinity)' });
      expect(reads.lone).toMatchObject({ reasons: ['a\ufffd'], segments: [{ quote: 'q\ufffd', note: 'n' }] });
      expect(reads.expired).toBeNull();
      const swept = [await engine.sweepDreamVerdicts(), await engine.sweepDreamVerdicts()];
      expect(swept).toEqual([1, 0]);
      const refusals = {
        nul: await outcome(() => engine.putDreamVerdict('transcripts/a.md', 'nul', { ...VERDICT, reasons: ['a\u0000b'] })),
        fractionalVersion: await outcome(() => engine.putDreamVerdict('transcripts/a.md', 'frac', { ...VERDICT, triage_version: 1.5 })),
      };
      expect(refusals).toEqual({ nul: { refused: '22P05' }, fractionalVersion: { refused: '22P02' } });
      record(kind, 'dreamVerdicts', { reads, swept, refusals });

      // Arrays outside the declared type: both engines read back [], but they store and refuse differently.
      const nullArrays = { reasons: null, segments: null, entities: null } as never;
      const undefinedArrays = { reasons: undefined, segments: undefined, entities: undefined } as never;
      const nullPut = await outcome(() => engine.putDreamVerdict('transcripts/a.md', 'null-arrays', { ...VERDICT, ...(nullArrays as object) } as never));
      const undefinedPut = await outcome(() => engine.putDreamVerdict('transcripts/a.md', 'undef-arrays', { ...VERDICT, ...(undefinedArrays as object) } as never));
      const stored = await engine.executeRaw<{ content_hash: string; stored: string }>(
        `SELECT content_hash, CASE WHEN reasons IS NULL THEN 'sql null' ELSE 'json ' || jsonb_typeof(reasons) END AS stored
           FROM dream_verdicts WHERE content_hash IN ('null-arrays', 'undef-arrays') ORDER BY content_hash`,
      );
      const nullRead = strip(await engine.getDreamVerdict('transcripts/a.md', 'null-arrays'));
      expect(nullRead).toMatchObject({ reasons: [], segments: [], entities: [] });
      record(kind, 'dreamNullArrays', { nullPut, undefinedPut, stored: stored.map((r) => `${r.content_hash}: ${r.stored}`) }, pinned);
    });

    test('ingest log: round trip, default source, limit rules, source scope, refusals, ties newest id first', async () => {
      await engine.logIngest({ source_type: 'meeting', source_ref: 'r1', pages_updated: ['a', 'b,c', '"q"', 'NULL', ''], summary: 'first' });
      await engine.logIngest({ source_id: 'not-a-source', source_type: 'meeting', source_ref: 'r2', pages_updated: [], summary: '' });
      const refusals = {
        nulSummary: await outcome(() => engine.logIngest({ source_type: 't', source_ref: 'x', pages_updated: [], summary: 'x\u0000' })),
        nulPage: await outcome(() => engine.logIngest({ source_type: 't', source_ref: 'x', pages_updated: ['x\u0000'], summary: '' })),
        loneSurrogate: await outcome(() => engine.logIngest({ source_type: 't', source_ref: 'x', pages_updated: ['x\ud800'], summary: '' })),
      };
      expect(refusals).toEqual({ nulSummary: { refused: '22021' }, nulPage: { refused: '22P05' }, loneSurrogate: { refused: '22P02' } });
      const all = await engine.getIngestLog();
      expect(all.map((r) => r.source_ref).sort()).toEqual(['r1', 'r2']);
      const r1 = all.find((r) => r.source_ref === 'r1')!;
      expect(typesOf(r1)).toEqual({
        id: 'number', source_id: 'string', source_type: 'string', source_ref: 'string', pages_updated: 'array<string,string,string,string,string>', summary: 'string', created_at: 'Date',
      });
      expect(r1).toMatchObject({ source_id: 'default', pages_updated: ['a', 'b,c', '"q"', 'NULL', ''], summary: 'first' });
      const [stamp] = await engine.executeRaw<{ has_version: boolean; segment_reader: boolean }>(
        `SELECT writer_version IS NOT NULL AS has_version, writer_segment_reader AS segment_reader FROM ingest_log WHERE source_ref = 'r1'`,
      );
      expect(stamp).toEqual({ has_version: true, segment_reader: true });
      for (const ref of ['t1', 't2', 't3', 't4']) await engine.logIngest({ source_type: 'tie', source_ref: ref, pages_updated: [], summary: '' });
      await engine.executeRaw(`UPDATE ingest_log SET created_at = '2026-03-01T00:00:00Z' WHERE source_type = 'tie'`);
      await engine.executeRaw(`UPDATE ingest_log SET created_at = '2026-01-01T00:00:00Z' WHERE source_type <> 'tie'`);
      const order = (await engine.getIngestLog()).map((r) => r.source_ref);
      expect(order).toEqual(['t4', 't3', 't2', 't1', 'r2', 'r1']);
      const limits = {
        zeroMeansDefault: (await engine.getIngestLog({ limit: 0 })).length,
        two: (await engine.getIngestLog({ limit: 2 })).map((r) => r.source_ref),
        negative: await outcome(() => engine.getIngestLog({ limit: -1 })),
        fractional: await outcome(() => engine.getIngestLog({ limit: 1.5 })),
      };
      expect(limits).toEqual({ zeroMeansDefault: 6, two: ['t4', 't3'], negative: { refused: '2201W' }, fractional: { refused: '22P02' } });
      const scope = {
        one: (await engine.getIngestLog({ sourceIds: ['not-a-source'] })).map((r) => r.source_ref),
        emptyIsUnscoped: (await engine.getIngestLog({ sourceIds: [] })).length,
        none: (await engine.getIngestLog({ sourceIds: ['nothing-here'] })).length,
      };
      expect(scope).toEqual({ one: ['r2'], emptyIsUnscoped: 6, none: 0 });
      record(kind, 'ingestLog', { refusals, r1: { ...r1, id: typeof r1.id, created_at: 'Date' }, order, limits, scope });
    });

    test('eval capture: row shape, limit rules, since is inclusive, delete-before is exclusive, refusals, ties newest id first', async () => {
      const id = await engine.logEvalCandidate(CANDIDATE as never);
      expect(typeof id).toBe('number');
      const refusals = {
        badTool: await outcome(() => engine.logEvalCandidate({ ...CANDIDATE, tool_name: 'bogus' } as never)),
        nulQuery: await outcome(() => engine.logEvalCandidate({ ...CANDIDATE, query: 'a\u0000' } as never)),
        tooLong: await outcome(() => engine.logEvalCandidate({ ...CANDIDATE, query: 'x'.repeat(51201) } as never)),
        fractionalLatency: await outcome(() => engine.logEvalCandidate({ ...CANDIDATE, latency_ms: 2.5 } as never)),
        badReason: await outcome(() => engine.logEvalCaptureFailure('bogus' as never)),
        invalidBefore: await outcome(() => engine.deleteEvalCandidatesBefore(new Date('nope'))),
        invalidSince: await outcome(() => engine.listEvalCaptureFailures({ since: new Date('nope') })),
      };
      expect(refusals).toEqual({
        badTool: { refused: '23514' }, nulQuery: { refused: '22021' }, tooLong: { refused: '23514' }, fractionalLatency: { refused: '22P02' },
        badReason: { refused: '23514' }, invalidBefore: { refused: 'Invalid Date' }, invalidSince: { refused: 'Invalid Date' },
      });
      const [row] = await engine.listEvalCandidates({ limit: 1 });
      expect(typesOf(row)).toMatchObject({ id: 'number', retrieved_slugs: 'array<>', retrieved_chunk_ids: 'array<number,number>', created_at: 'Date', as_of_ts: 'null' });
      const { id: _id, created_at: _at, ...shape } = row;
      expect(shape).toMatchObject({ ...CANDIDATE, retrieved_slugs: [] });
      await engine.logEvalCandidate({ ...CANDIDATE, tool_name: 'search', query: 'second' } as never);
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'third' } as never);
      await engine.executeRaw(`UPDATE eval_candidates SET created_at = '2026-01-01T00:00:00Z' WHERE query = 'what did acme-example ship'`);
      await engine.executeRaw(`UPDATE eval_candidates SET created_at = '2026-02-01T00:00:00Z' WHERE query <> 'what did acme-example ship'`);
      const lists = {
        all: (await engine.listEvalCandidates()).map((r) => r.query),
        nanLimitMeansDefault: (await engine.listEvalCandidates({ limit: NaN })).length,
        halfLimitFloorsToZero: (await engine.listEvalCandidates({ limit: 0.5 })).length,
        search: (await engine.listEvalCandidates({ tool: 'search' })).map((r) => r.query),
        sinceExact: (await engine.listEvalCandidates({ since: new Date('2026-01-01T00:00:00Z') })).length,
        sinceAfter: (await engine.listEvalCandidates({ since: new Date('2026-01-01T00:00:00.001Z') })).length,
      };
      expect(lists).toEqual({
        all: ['third', 'second', 'what did acme-example ship'], nanLimitMeansDefault: 3, halfLimitFloorsToZero: 0,
        search: ['second'], sinceExact: 3, sinceAfter: 2,
      });
      const deleted = {
        atExactTime: await engine.deleteEvalCandidatesBefore(new Date('2026-01-01T00:00:00Z')),
        oneMsLater: await engine.deleteEvalCandidatesBefore(new Date('2026-01-01T00:00:00.001Z')),
      };
      expect(deleted).toEqual({ atExactTime: 0, oneMsLater: 1 });

      for (const reason of ['db_down', 'other', 'rls_reject', 'check_violation'] as const) await engine.logEvalCaptureFailure(reason);
      await engine.executeRaw(`UPDATE eval_capture_failures SET ts = '2026-03-01T00:00:00Z' WHERE reason <> 'db_down'`);
      await engine.executeRaw(`UPDATE eval_capture_failures SET ts = '2026-02-01T00:00:00Z' WHERE reason = 'db_down'`);
      const failures = (await engine.listEvalCaptureFailures()).map((r) => ({ ...typesOf(r), reason: r.reason }));
      expect(failures.map((r) => r.reason)).toEqual(['check_violation', 'rls_reject', 'other', 'db_down']);
      expect(failures[0] as unknown).toEqual({ id: 'number', ts: 'Date', reason: 'check_violation' });
      const failureWindows = {
        sinceExact: (await engine.listEvalCaptureFailures({ since: new Date('2026-03-01T00:00:00Z') })).length,
        future: (await engine.listEvalCaptureFailures({ since: new Date('2027-01-01T00:00:00Z') })).length,
      };
      expect(failureWindows).toEqual({ sinceExact: 3, future: 0 });
      record(kind, 'evalCapture', { refusals, shape: plain(shape), lists, deleted, failures, failureWindows });
    });
  });
}

describe('eval caches and log tables: engines agree', () => {
  test('every shared case gives one answer, and each pinned difference holds', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    const expected: Record<TestBackend, Record<string, unknown>> = {
      pglite: {
        clockResolution: 'milliseconds',
        nullVerdict: { nullVerdict: { ok: undefined }, nullRead: null },
        dreamNullArrays: { nullPut: { ok: undefined }, undefinedPut: { ok: undefined }, stored: ['null-arrays: json null', 'undef-arrays: sql null'] },
      },
      postgres: {
        clockResolution: 'microseconds',
        nullVerdict: { nullVerdict: { refused: '23502' }, nullRead: null },
        dreamNullArrays: { nullPut: { ok: undefined }, undefinedPut: { refused: 'UNDEFINED_VALUE' }, stored: ['null-arrays: sql null'] },
      },
    };
    for (const b of backends) expect({ engine: b, pins: pinned.get(b) }).toEqual({ engine: b, pins: expected[b] });
  });
});
