/**
 * Salience, enrich candidates and anomaly parity: emotional weights, the
 * recent-salience ranking, enrich candidate selection and anomaly detection
 * return the same rows, values and refusals on PGLite and Postgres (in-memory
 * PGLite; Postgres too when DATABASE_URL is set).
 *
 * Rust engine contract. Differences pinned here, with the engine the Rust
 * engine must match:
 * - An undefined weight. setEmotionalWeightBatch with weight undefined is
 *   refused on both engines, but PGLite reports the not-null violation
 *   (23502) and Postgres refuses before SQL (UNDEFINED_VALUE). A null weight
 *   is 23502 on both. Rust matches Postgres: an undefined argument is
 *   refused before SQL.
 * Everything else below is one answer on both engines, and Rust must give it:
 * - Text order is code-point (C collation) order: tags and anomaly page slugs
 *   come back as ['B', 'Z', 'a', 'b', 'é'].
 *   Postgres sorts with the database collation, so its brain here is created
 *   with LC_COLLATE 'C'; on an en_US database Postgres gives en_US order
 *   (follow-up collation_en_us_check).
 * - getRecentSalience breaks score ties by source_id, then slug, ascending.
 * - Anomalies with the same sigma keep tag cohorts before type cohorts, each
 *   by cohort value ascending.
 * - Row order of batchLoadEmotionalInputs and the order of each page's takes
 *   are not part of the contract (no ORDER BY); this file sorts them.
 * - Two rows for one (slug, source_id) in one weight batch change one row;
 *   which weight wins is not part of the contract.
 *
 * 1. Protects: batchLoadEmotionalInputs, setEmotionalWeightBatch,
 *    getRecentSalience, listEnrichCandidates and findAnomalies: REAL rounding,
 *    NaN, Infinity and signed zero, changed-row counts, tag and take
 *    aggregation, score values, tie order, source scope precedence, LIKE
 *    escaping, the briefings exclusion, the holder allow-list, limit and
 *    window clamps, the re-enrich guard, dream-generated pages, code-point
 *    body length, anomaly windows and the refusal for each invalid input.
 * 2. Fails when: an engine's statement or driver changes a stored or returned
 *    value, a same-value weight starts to count as a change, a limit or
 *    window clamp moves, the salience tiebreaker is dropped, a scope or
 *    exclusion stops applying, an anomaly window boundary moves, or an
 *    invalid input starts to be accepted or refused with another code.
 * 3. Existing coverage: test/engine-parity (typed-methods branch) has one
 *    happy-path case per method; test/salience*.test.ts, test/anomal*.test.ts
 *    and test/enrich*.test.ts cover the features on PGLite. No file compares
 *    clamps, refusals or tie order across the two engines.
 * 4. Real seams: the engines' public methods. Write times are set with SQL so
 *    every window and tie is pinned.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SalienceResult } from '../src/core/types.ts';
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

/** Salience rows without the clock: the score is rounded, updated_at is dropped. */
function rank(rows: SalienceResult[]): string[] {
  return rows.map((r) => `${r.source_id}:${r.slug} w=${r.emotional_weight} takes=${r.take_count} avg=${r.take_avg_weight} score=${r.score.toFixed(6)}`);
}

function slugsOf(r: unknown): unknown {
  const v = r as { ok?: Array<{ slug: string; body_len: number; inbound_count: number }> };
  return v.ok ? v.ok.map((x) => `${x.slug} len=${x.body_len} in=${x.inbound_count}`) : r;
}

for (const kind of backends) {
  describe(`salience, enrich and anomalies (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const raw = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql);
    const page = (slug: string, type = 'person', body = 'x', sourceId?: string, frontmatter: Record<string, unknown> = {}) =>
      engine.putPage(slug, { type: type as never, title: slug, compiled_truth: body, timeline: '', frontmatter } as never, sourceId ? { sourceId } as never : undefined);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1, { collation: 'C' }));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await raw(`INSERT INTO sources (id, name) VALUES ('src-b', 'src-b') ON CONFLICT DO NOTHING`);
      // Reverse order, so heap order is not the expected tie order.
      for (const slug of ['people/d', 'people/c', 'people/b', 'people/a', 'briefings/x']) await page(slug);
      await page('people/a', 'person', 'x', 'src-b');
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('emotional weights: REAL rounding, changed-row counts, NaN, Infinity, signed zero, refusals', async () => {
      const set = (rows: Array<{ slug: string; source_id?: string; weight: number }>) =>
        outcome(() => engine.setEmotionalWeightBatch(rows.map((r) => ({ source_id: 'default', ...r }))));
      const counts = {
        first: await set([
          { slug: 'people/a', weight: 0.123456789 }, { slug: 'people/b', weight: 0.5 },
          { slug: 'people/missing', weight: 0.5 }, { slug: 'people/a', source_id: 'src-b', weight: 0.25 },
        ]),
        sameAgain: await set([{ slug: 'people/a', weight: 0.123456789 }, { slug: 'people/b', weight: 0.5 }]),
        nan: await set([{ slug: 'people/c', weight: NaN }]),
        nanAgain: await set([{ slug: 'people/c', weight: NaN }]),
        infinity: await set([{ slug: 'people/c', weight: Infinity }]),
        negZero: await set([{ slug: 'people/c', weight: -0 }]),
        posZeroAfterNegZero: await set([{ slug: 'people/c', weight: 0 }]),
        empty: await set([]),
      };
      expect(counts).toEqual({
        first: { ok: 3 }, sameAgain: { ok: 0 }, nan: { ok: 1 }, nanAgain: { ok: 0 }, infinity: { ok: 1 },
        negZero: { ok: 1 }, posZeroAfterNegZero: { ok: 0 }, empty: { ok: 0 },
      });
      const refusals = {
        overflow: await set([{ slug: 'people/c', weight: 1e40 }]),
        underflow: await set([{ slug: 'people/c', weight: 1e-50 }]),
        nullWeight: await set([{ slug: 'people/c', weight: null as never }]),
      };
      expect(refusals).toEqual({ overflow: { refused: '22003' }, underflow: { refused: '22003' }, nullWeight: { refused: '23502' } });
      const undefinedWeight = await set([{ slug: 'people/c', weight: undefined as never }]);
      const duplicate = await set([{ slug: 'people/d', weight: 0.1 }, { slug: 'people/d', weight: 0.9 }]);
      expect(duplicate).toEqual({ ok: 1 });
      const [{ emotional_weight: dupWeight }] = await raw(`SELECT emotional_weight FROM pages WHERE slug = 'people/d'`);
      expect([0.1, 0.9]).toContain(Number(Number(dupWeight).toFixed(6)));
      await raw(`UPDATE pages SET emotional_weight = 0.9 WHERE slug = 'people/d'`);
      const stored = await raw(`SELECT source_id, slug, emotional_weight, salience_touched_at IS NOT NULL AS touched FROM pages ORDER BY source_id, slug`);
      expect(stored.map((r) => `${r.source_id}:${r.slug} ${r.emotional_weight} ${r.touched}`)).toEqual([
        'default:briefings/x 0 false', 'default:people/a 0.12345679 true', 'default:people/b 0.5 true',
        'default:people/c 0 true', 'default:people/d 0.9 true', 'src-b:people/a 0.25 true',
      ]);
      record(kind, 'weights', { counts, refusals, stored });
      record(kind, 'undefinedWeight', undefinedWeight, pinned);
    });

    test('emotional inputs: tags deduped in code-point order, active takes only, slug filter across sources', async () => {
      for (const tag of ['b', 'B', 'a', 'a', 'é', 'Z']) await engine.addTag('people/a', tag);
      await engine.addTag('people/b', 'x');
      const [{ id }] = await raw(`SELECT id FROM pages WHERE slug = 'people/a' AND source_id = 'default'`);
      expect(await engine.addTakesBatch([
        { page_id: Number(id), row_num: 3, claim: 'c3', kind: 'take' as never, holder: 'z-holder', weight: 0.7 },
        { page_id: Number(id), row_num: 1, claim: 'c1', kind: 'fact' as never, holder: 'a-holder', weight: 0.1 },
        { page_id: Number(id), row_num: 2, claim: 'c2', kind: 'take' as never, holder: 'm-holder', weight: 0.5, active: false },
      ])).toBe(3);
      await page('people/gone');
      await engine.softDeletePage('people/gone');
      const shape = (rows: Awaited<ReturnType<BrainEngine['batchLoadEmotionalInputs']>>) => rows
        .map((r) => ({ ...r, takes: [...r.takes].sort((x, y) => x.holder.localeCompare(y.holder)) }))
        .sort((x, y) => `${x.source_id}:${x.slug}`.localeCompare(`${y.source_id}:${y.slug}`));
      const all = shape(await engine.batchLoadEmotionalInputs());
      const some = shape(await engine.batchLoadEmotionalInputs(['people/a', 'people/nope', 'people/gone']));
      const none = await engine.batchLoadEmotionalInputs([]);
      expect(all.map((r) => `${r.source_id}:${r.slug}`)).toEqual([
        'default:briefings/x', 'default:people/a', 'default:people/b', 'default:people/c', 'default:people/d', 'default:people/gone', 'src-b:people/a',
      ]);
      expect(some).toEqual([
        { slug: 'people/a', source_id: 'default', tags: ['B', 'Z', 'a', 'b', 'é'], takes: [
          { holder: 'a-holder', weight: 0.1, kind: 'fact', active: true },
          { holder: 'z-holder', weight: 0.7, kind: 'take', active: true },
        ] },
        { slug: 'people/gone', source_id: 'default', tags: [], takes: [] },
        { slug: 'people/a', source_id: 'src-b', tags: [], takes: [] },
      ]);
      expect(none).toEqual([]);
      record(kind, 'inputs', { all, some, none });
      await engine.deletePage('people/gone');
    });

    test('recent salience: score, scope precedence, prefix escaping, briefings, holder allow-list, clamps, ties by source and slug', async () => {
      await raw(`UPDATE pages SET updated_at = '2000-01-01T00:00:00Z', salience_touched_at = NULL`);
      const all = { days: 100000 };
      const reads = {
        all: rank(await engine.getRecentSalience(all)),
        prefix: rank(await engine.getRecentSalience({ ...all, slugPrefix: 'people/' })),
        likeMetaIsLiteral: rank(await engine.getRecentSalience({ ...all, slugPrefix: 'people%' })),
        briefingsOptIn: rank(await engine.getRecentSalience({ ...all, slugPrefix: 'briefings' })),
        holders: rank(await engine.getRecentSalience({ ...all, takesHoldersAllowList: ['z-holder'] })),
        scalarScope: rank(await engine.getRecentSalience({ ...all, sourceId: 'src-b' })),
        arrayWins: rank(await engine.getRecentSalience({ ...all, sourceIds: ['src-b'], sourceId: 'default' })),
        recencyOn: (await engine.getRecentSalience({ ...all, recency_bias: 'on' })).map((r) => `${r.source_id}:${r.slug}`),
      };
      expect(reads.all).toEqual([
        'default:people/d w=0.9 takes=0 avg=0 score=4.500102',
        'default:people/b w=0.5 takes=0 avg=0 score=2.500102',
        'default:people/a w=0.12345679 takes=2 avg=0.3999999947845936 score=1.715998',
        'src-b:people/a w=0.25 takes=0 avg=0 score=1.250102',
        'default:people/c w=0 takes=0 avg=0 score=0.000102',
      ]);
      expect(reads.prefix).toEqual(reads.all);
      expect(reads.likeMetaIsLiteral).toEqual([]);
      expect(reads.briefingsOptIn).toEqual(['default:briefings/x w=0 takes=0 avg=0 score=0.000102']);
      // The allow-list zeroes the weight term and counts only allowed holders; ties sort by source, then slug.
      expect(reads.holders).toEqual([
        'default:people/a w=0 takes=1 avg=0.699999988079071 score=0.693249',
        'default:people/b w=0 takes=0 avg=0 score=0.000102', 'default:people/c w=0 takes=0 avg=0 score=0.000102',
        'default:people/d w=0 takes=0 avg=0 score=0.000102', 'src-b:people/a w=0 takes=0 avg=0 score=0.000102',
      ]);
      expect(reads.scalarScope).toEqual(['src-b:people/a w=0.25 takes=0 avg=0 score=1.250102']);
      expect(reads.arrayWins).toEqual(reads.scalarScope);
      const clamps = {
        limitZeroIsDefault: (await engine.getRecentSalience({ ...all, limit: 0 })).length,
        limitFloors: (await engine.getRecentSalience({ ...all, limit: 1.9 })).length,
        limitNaNIsDefault: (await engine.getRecentSalience({ ...all, limit: NaN })).length,
        negativeDaysIsZero: (await engine.getRecentSalience({ days: -5 })).length,
        halfDay: (await engine.getRecentSalience({ days: 0.5 })).length,
        nanDays: await outcome(() => engine.getRecentSalience({ days: NaN })),
        infiniteDays: await outcome(() => engine.getRecentSalience({ days: Infinity })),
      };
      expect(clamps).toEqual({
        limitZeroIsDefault: 5, limitFloors: 1, limitNaNIsDefault: 5, negativeDaysIsZero: 0, halfDay: 0,
        nanDays: { refused: 'Invalid Date' }, infiniteDays: { refused: 'Invalid Date' },
      });
      await raw(`UPDATE pages SET emotional_weight = 0`);
      await raw(`DELETE FROM takes`);
      const ties = (await engine.getRecentSalience(all)).map((r) => `${r.source_id}:${r.slug}`);
      expect(ties).toEqual(['default:people/a', 'default:people/b', 'default:people/c', 'default:people/d', 'src-b:people/a']);
      record(kind, 'salience', { reads, clamps, ties });
    });

    test('enrich candidates: thin filter, inbound links, orders and tiebreak, re-enrich guard, dream pages, clamps, refusals', async () => {
      await page('companies/thin', 'company', 'short');
      await page('companies/fat', 'company', 'x'.repeat(500));
      await page('companies/emoji', 'company', '😀😀😀');
      await page('companies/dream', 'company', 'd', undefined, { dream_generated: true });
      await page('companies/dream-text', 'company', 'd', undefined, { dream_generated: 'TRUE' });
      await page('companies/enriched-now', 'company', 'e', undefined, { enriched_at: new Date().toISOString() });
      await page('companies/enriched-old', 'company', 'e', undefined, { enriched_at: '2001-01-01T00:00:00.000Z' });
      await page('companies/enriched-junk', 'company', 'e', undefined, { enriched_at: 'not a date' });
      await page('companies/thin', 'company', 'other', 'src-b');
      await engine.addLink('people/a', 'companies/thin', 'c', 'mentions');
      await engine.addLink('people/b', 'companies/thin', 'c', 'works_at');
      await engine.addLink('people/b', 'companies/emoji', 'c', 'works_at', 'mentions');
      await raw(`UPDATE pages SET updated_at = '2026-01-01T00:00:00Z' WHERE type = 'company'`);
      await raw(`UPDATE pages SET updated_at = '2026-01-02T00:00:00Z' WHERE slug IN ('companies/emoji', 'companies/enriched-old')`);
      const list = (o: Record<string, unknown>) => outcome(() => engine.listEnrichCandidates({ types: ['company'], thinThreshold: 10, order: 'inbound-links', limit: 50, ...o } as never)).then(slugsOf);
      const byLinks = [
        'companies/thin len=5 in=2', 'companies/dream-text len=1 in=0', 'companies/emoji len=3 in=0', 'companies/enriched-junk len=1 in=0',
        'companies/enriched-now len=1 in=0', 'companies/enriched-old len=1 in=0', 'companies/thin len=5 in=0',
      ];
      const reads = {
        inboundLinks: await list({}),
        updated: await list({ order: 'updated' }),
        salience: await list({ order: 'salience' }),
        unknownOrder: await list({ order: 'drop table' }),
        reenrichGuard: await list({ reenrichAfterMs: 86400000 }),
        reenrichNaN: await list({ reenrichAfterMs: NaN }),
        threshold0: await list({ thinThreshold: 0 }),
        threshold4: await list({ thinThreshold: 4 }),
        limit0IsOne: await list({ limit: 0 }),
        limitHuge: await list({ limit: 1e9 }),
        noTypes: await list({ types: [] }),
        unknownType: await list({ types: ['nope'] }),
        scopedArrayWins: await list({ sourceIds: ['src-b'], sourceId: 'default' }),
      };
      expect(reads).toEqual({
        inboundLinks: byLinks,
        updated: [
          'companies/emoji len=3 in=0', 'companies/enriched-old len=1 in=0', 'companies/dream-text len=1 in=0', 'companies/enriched-junk len=1 in=0',
          'companies/enriched-now len=1 in=0', 'companies/thin len=5 in=2', 'companies/thin len=5 in=0',
        ],
        salience: byLinks,
        unknownOrder: byLinks,
        // A junk enriched_at sorts after every ISO time as text, so it counts as recently enriched.
        reenrichGuard: ['companies/thin len=5 in=2', 'companies/dream-text len=1 in=0', 'companies/emoji len=3 in=0', 'companies/enriched-old len=1 in=0', 'companies/thin len=5 in=0'],
        reenrichNaN: byLinks,
        threshold0: [],
        threshold4: ['companies/dream-text len=1 in=0', 'companies/emoji len=3 in=0', 'companies/enriched-junk len=1 in=0', 'companies/enriched-now len=1 in=0', 'companies/enriched-old len=1 in=0'],
        limit0IsOne: ['companies/thin len=5 in=2'],
        limitHuge: byLinks,
        noTypes: [],
        unknownType: [],
        scopedArrayWins: ['companies/thin len=5 in=0'],
      });
      const refusals = {
        nanThreshold: await list({ thinThreshold: NaN }),
        fractionalThreshold: await list({ thinThreshold: 3.5 }),
        nanLimit: await list({ limit: NaN }),
        fractionalLimit: await list({ limit: 2.5 }),
        hugeReenrich: await list({ reenrichAfterMs: 1e20 }),
      };
      expect(refusals).toEqual({
        nanThreshold: { refused: '22P02' }, fractionalThreshold: { refused: '22P02' }, nanLimit: { refused: '22P02' },
        fractionalLimit: { refused: '22P02' }, hugeReenrich: { refused: 'Invalid Date' },
      });
      record(kind, 'enrich', { reads, refusals });
    });

    test('anomalies: day windows, zero-filled baseline, sigma fallback, tie order, source scope, refusals', async () => {
      await raw(`UPDATE pages SET updated_at = '2026-03-10T12:00:00Z'`);
      await raw(`UPDATE pages SET updated_at = '2026-03-11T00:00:00Z' WHERE slug = 'companies/fat'`);
      await raw(`UPDATE pages SET updated_at = '2026-03-01T23:59:59.999Z' WHERE slug = 'people/d'`);
      for (const slug of ['people/c', 'people/b', 'people/a']) for (const tag of ['t-b', 't-c', 't-a']) await engine.addTag(slug, tag);
      const find = (o: Record<string, unknown>) => outcome(() => engine.findAnomalies({ since: '2026-03-10', lookback_days: 30, ...o }));
      const reads = {
        base: await find({}),
        sigmaZero: await find({ sigma: 0 }),
        lookback0IsOne: await find({ lookback_days: 0 }),
        lookbackFraction: await find({ lookback_days: 1.5 }),
        scoped: await find({ sourceId: 'src-b' }),
      };
      const person = { cohort_kind: 'type', cohort_value: 'person', count: 5, page_slugs: ['briefings/x', 'people/a', 'people/b', 'people/c'] };
      const company = {
        cohort_kind: 'type', cohort_value: 'company', count: 8, baseline_mean: 0, baseline_stddev: 0, sigma_observed: 8,
        page_slugs: ['companies/dream', 'companies/dream-text', 'companies/emoji', 'companies/enriched-junk', 'companies/enriched-now', 'companies/enriched-old', 'companies/thin'],
      };
      const tag = (v: string) => ({ cohort_kind: 'tag', cohort_value: v, count: 3, baseline_mean: 0, baseline_stddev: 0, sigma_observed: 3, page_slugs: ['people/a', 'people/b', 'people/c'] });
      // people/d at 23:59:59.999 on 2026-03-01 is one baseline day of 30; companies/fat at 00:00 next day is outside the target day.
      const withBaseline = { ...person, baseline_mean: 1 / 30, baseline_stddev: 0.18257418583505533, sigma_observed: 27.203553689423256 };
      expect(reads.base).toEqual({ ok: [withBaseline, company, tag('t-a'), tag('t-b'), tag('t-c')] });
      expect(reads.sigmaZero).toEqual(reads.base);
      const noBaseline = { ...person, baseline_mean: 0, baseline_stddev: 0, sigma_observed: 5 };
      expect(reads.lookback0IsOne).toEqual({ ok: [company, noBaseline, tag('t-a'), tag('t-b'), tag('t-c')] });
      expect(reads.lookbackFraction).toEqual(reads.lookback0IsOne);
      expect(reads.scoped).toEqual({ ok: [] });
      const refusals = {
        badMonth: await find({ since: '2026-13-10' }),
        notADate: await find({ since: 'yesterday' }),
        timestamp: await find({ since: '2026-03-10T05:00:00Z' }),
        nanLookback: await find({ lookback_days: NaN }),
      };
      expect(refusals).toEqual({ badMonth: { refused: 'Invalid Date' }, notADate: { refused: 'Invalid Date' }, timestamp: { refused: 'Invalid Date' }, nanLookback: { refused: 'Invalid Date' } });
      record(kind, 'anomalies', { reads, refusals });
    });
  });
}

describe('salience, enrich and anomalies: engines agree', () => {
  test('every shared case gives one answer, and each pinned difference holds', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    const expected: Record<TestBackend, Record<string, unknown>> = {
      pglite: { undefinedWeight: { refused: '23502' } },
      postgres: { undefinedWeight: { refused: 'UNDEFINED_VALUE' } },
    };
    for (const b of backends) expect({ engine: b, pins: pinned.get(b) }).toEqual({ engine: b, pins: expected[b] });
  });
});
