/**
 * runPostFusionStages issues every read keyed only by the entry result set
 * (page ids, {slug, source_id} refs, array order) at once, then applies the
 * stages in their fixed order. On a pooled Postgres each serial read cost one
 * round trip; the scores and ordering must stay bit-for-bit identical to the
 * sequential stages.
 */
import { afterEach, describe, expect, test, setSystemTime } from 'bun:test';
import {
  applyBacklinkBoost,
  applyChronicleTypeBoost,
  applyRecencyBoost,
  applySalienceBoost,
  applySupersedeDownrank,
  applyTitleBoost,
  computeFloorThreshold,
  runPostFusionStages,
  type PostFusionOpts,
} from '../../src/core/search/hybrid.ts';
import { applyGraphSignals } from '../../src/core/search/graph-signals.ts';
import type { AdjacencyRow, SearchResult } from '../../src/core/types.ts';

type ReadName = 'backlinks' | 'salience' | 'dates' | 'graph' | 'alias' | 'supersede-probe' | 'supersede';

const NOW = new Date('2026-06-01T00:00:00Z');
const DECAY_MAP = { 'daily/': { halflifeDays: 30, coefficient: 0.4 }, 'concepts/': { halflifeDays: 0, coefficient: 0 } };
const FALLBACK = { halflifeDays: 90, coefficient: 0.3 };

function row(slug: string, page_id: number, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body`,
    chunk_source: 'compiled_truth',
    chunk_id: page_id,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
    ...extra,
  } as SearchResult;
}

function fixture(): SearchResult[] {
  return [
    row('people/alice-example', 1, 0.92, { title: 'Alice Example' }),
    row('companies/acme-example', 2, 0.88),
    row('daily/2026-05-20/standup', 3, 0.81, { type: 'event' }),
    row('daily/2026-05-20/retro', 4, 0.79, { type: 'diary' }),
    row('concepts/widget-pricing', 5, 0.74, { source_id: 'source-a' }),
    row('companies/acme-example', 6, 0.70, { source_id: 'source-a' }),
    row('notes/weak-hub', 7, 0.30),
    row('notes/alice-example-old', 8, 0.65),
  ];
}

const backlinkCounts = new Map([[1, 4], [2, 12], [3, 1], [6, 3], [7, 40]]);
const salience = new Map([['default::people/alice-example', 3], ['source-a::concepts/widget-pricing', 6], ['default::notes/weak-hub', 9]]);
const dates = new Map([
  ['default::daily/2026-05-20/standup', new Date('2026-05-20T00:00:00Z')],
  ['default::daily/2026-05-20/retro', new Date('2026-05-21T00:00:00Z')],
  ['default::companies/acme-example', new Date('2026-01-10T00:00:00Z')],
  ['source-a::concepts/widget-pricing', new Date('2025-02-01T00:00:00Z')],
]);
const adjacency = new Map<number, AdjacencyRow>([
  [2, { hits: 3, cross_source_hits: 2 } as AdjacencyRow],
  [1, { hits: 2, cross_source_hits: 0 } as AdjacencyRow],
  [7, { hits: 5, cross_source_hits: 3 } as AdjacencyRow],
]);
const aliasRows = [{ source_id: 'default', canonical_slug: 'people/alice-example' }];
const supersedeRows = [{ to_page_id: 8, by_slug: 'people/alice-example' }];

const answers: Record<ReadName, unknown> = {
  backlinks: backlinkCounts,
  salience,
  dates,
  graph: adjacency,
  alias: aliasRows,
  'supersede-probe': [{ one: 1 }],
  supersede: supersedeRows,
};

function classify(sql: string): ReadName {
  if (/slug_aliases/.test(sql)) return 'alias';
  if (/SELECT 1 AS one FROM links/.test(sql)) return 'supersede-probe';
  if (/supersedes/.test(sql)) return 'supersede';
  throw new Error(`unexpected executeRaw: ${sql}`);
}

/**
 * Fake engine. `mode(name)` decides per read: 'resolve' answers at once,
 * 'defer' parks the read until release(), 'reject' fails it immediately.
 */
function fakeEngine(mode: (name: ReadName) => 'resolve' | 'defer' | 'reject' = () => 'resolve') {
  const issued: ReadName[] = [];
  const parked: Array<() => void> = [];
  const read = (name: ReadName) => {
    issued.push(name);
    const how = mode(name);
    if (how === 'reject') return Promise.reject(new Error(`${name} failed`));
    if (how === 'resolve') return Promise.resolve(answers[name]);
    return new Promise(resolve => parked.push(() => resolve(answers[name])));
  };
  const engine = {
    getBacklinkCounts: () => read('backlinks'),
    getSalienceScores: () => read('salience'),
    getEffectiveDates: () => read('dates'),
    getAdjacencyBoosts: () => read('graph'),
    executeRaw: (sql: string) => read(classify(sql)),
  };
  return { engine, issued, release: () => { while (parked.length) parked.shift()!(); } };
}

const opts = (overrides: Partial<PostFusionOpts> = {}): PostFusionOpts => ({
  applyBacklinks: true,
  salience: 'on',
  recency: 'strong',
  decayMap: DECAY_MAP,
  fallback: FALLBACK,
  floorRatio: 0.5,
  graphSignalsEnabled: true,
  query: 'alice example',
  titleBoost: 1.25,
  ...overrides,
});

/** The stages one after another, in runPostFusionStages' order. */
async function sequential(results: SearchResult[], o: PostFusionOpts, skip: ReadName[] = []): Promise<void> {
  for (const r of results) r.base_score = r.score;
  const floor = computeFloorThreshold(results, o.floorRatio);
  if (!skip.includes('backlinks')) applyBacklinkBoost(results, backlinkCounts, floor);
  if (!skip.includes('salience')) applySalienceBoost(results, salience, 'on', floor);
  if (!skip.includes('dates')) applyRecencyBoost(results, dates, 'strong', DECAY_MAP, FALLBACK, Date.now(), floor);
  applyChronicleTypeBoost(results, 'strong', floor);
  applyTitleBoost(results, o.query!, o.titleBoost!, floor);
  if (!skip.includes('graph')) {
    await applyGraphSignals(results, {} as never, { enabled: true, floorThreshold: floor, adjacencyFn: async () => adjacency });
  }
  if (!skip.includes('alias')) {
    for (const r of results) {
      if (r.source_id === 'default' && r.slug === 'people/alice-example') {
        r.score *= 1.05;
        r.alias_resolved_boost = 1.05;
      }
    }
  }
  if (!skip.includes('supersede')) await applySupersedeDownrank(results, fakeEngine().engine as never);
}

/** Release parked reads until the run settles (the supersede query parks only after its probe answers). */
async function settle(done: Promise<void>, release: () => void): Promise<void> {
  const tick = () => new Promise<boolean>(r => setTimeout(() => r(false), 0));
  while (!(await Promise.race([done.then(() => true), tick()]))) release();
  await done;
}

afterEach(() => { setSystemTime(); });

describe('runPostFusionStages — id-keyed reads run concurrently', () => {
  test('every enabled read is issued before any of them resolves', async () => {
    const { engine, issued, release } = fakeEngine(() => 'defer');
    const results = fixture();
    const done = runPostFusionStages(engine as never, results, opts());
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect([...issued].sort()).toEqual(['alias', 'backlinks', 'dates', 'graph', 'salience', 'supersede-probe']);
    await settle(done, release);
    expect(issued).toContain('supersede');
    expect(results[1].backlink_boost).toBeGreaterThan(1);
    expect(results[0].alias_resolved_boost).toBe(1.05);
    expect(results[7].superseded).toBe(true);
  });

  test('disabled stages issue no read', async () => {
    const { engine, issued } = fakeEngine();
    await runPostFusionStages(engine as never, fixture(), opts({ applyBacklinks: false, salience: 'off', recency: 'off', graphSignalsEnabled: false }));
    expect([...issued].sort()).toEqual(['alias', 'supersede', 'supersede-probe']);
    const skipped = fakeEngine();
    await runPostFusionStages(skipped.engine as never, fixture(), opts({ skipMetadataBoosts: true }));
    expect([...skipped.issued].sort()).toEqual(['supersede', 'supersede-probe']);
  });

  test('final scores, stamps and order equal the sequential stages bit for bit', async () => {
    setSystemTime(NOW);
    const expected = fixture();
    await sequential(expected, opts());
    const actual = fixture();
    await runPostFusionStages(fakeEngine().engine as never, actual, opts());
    expect(actual).toEqual(expected);
    const order = (rs: SearchResult[]) => [...rs].sort((a, b) => b.score - a.score).map(r => `${r.source_id}::${r.slug}#${r.page_id}`);
    expect(order(actual)).toEqual(order(expected));
    for (const stamp of ['backlink_boost', 'salience_boost', 'recency_boost', 'chronicle_boost', 'title_match_boost', 'graph_adjacency_boost', 'graph_session_demoted', 'alias_resolved_boost', 'superseded'] as const) {
      expect(actual.some(r => r[stamp] !== undefined)).toBe(true);
    }
    const weak = actual.find(r => r.slug === 'notes/weak-hub')!;
    expect(weak.score).toBe(weak.base_score!);
  });

  for (const failing of ['backlinks', 'salience', 'dates', 'graph', 'alias', 'supersede-probe', 'supersede'] as const) {
    test(`a rejecting ${failing} read skips only its own stage`, async () => {
      setSystemTime(NOW);
      const skip: ReadName[] = failing === 'supersede-probe' ? [] : [failing];
      const expected = fixture();
      await sequential(expected, opts(), skip);
      const actual = fixture();
      const { engine, release } = fakeEngine(name => (name === failing ? 'reject' : 'defer'));
      await settle(runPostFusionStages(engine as never, actual, opts()), release);
      expect(actual).toEqual(expected);
    });
  }
});
