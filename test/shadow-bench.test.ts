/**
 * `gbrain engine shadow bench --import <receipt>` and swap readiness criterion 8 (docs/designs/RUST_ENGINE.md D14, D17, D23).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the speed evidence the swap report shows: an engine-bench receipt must
 * fill criterion 8 honestly (every loss and every unmeasured class named, "no worse" only when everything was measured
 * against both TypeScript engines) and never block the swap. (2) Fails when a receipt that leaves a class or metric out
 * reads as "no worse", when a malformed number, a pipe or a refusal replaces or corrupts good evidence, when benchmark-corpus
 * numbers lose their label, or when criterion 8 gates. (3) test/engine-swap-readiness.test.ts feeds readiness a hand-made
 * document; nothing produced the `bench` fields. (4) No seam on the data: real shadow files under a temporary GBRAIN_HOME,
 * the real `runEngineShadow`, and receipts serialized with JSON.stringify so a missing metric is the real `null`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { readBoundedFile } from '../src/shadow/bench-file.ts';
import { benchSummaryPath, EXPECTED_METRICS, EXPECTED_OPS, importBenchReceipt, MAX_RECEIPT_BYTES } from '../src/shadow/bench-receipt.ts';
import { MAX_METRICS_PER_PAIR, MAX_OPERATIONS_PER_PAIR } from '../src/shadow/bench-receipt.ts';
import { classifyBench, readBenchSummary } from '../src/shadow/bench.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { SHADOW_STATE_VERSION, shadowBrainKey, shadowDirFor, writeShadowState, type ShadowState } from '../src/shadow/state.ts';
import { shadowStatusDocument } from '../src/shadow/status-document.ts';
import { withEnv } from './helpers/with-env.ts';

const CONFIG = { engine: 'pglite' as const, database_path: '/brains/example.pglite' };
const PG_CONFIG = { engine: 'postgres' as const, database_url: 'postgres://db.example:5432/brain' };
const STATE: ShadowState = { version: SHADOW_STATE_VERSION, enabled: true, started_at: '2026-11-01T00:00:00.000Z', sample_rate: 0.1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
const COMMIT = 'a'.repeat(40);
const ADDON = 'b'.repeat(64);
const NOW = new Date('2026-11-25T12:00:00Z');
const ENGINES = ['pglite', 'postgres'] as const;
const LOSS = 'bench corpus: ';

// ─── receipts, shaped like eval/runner/engine-bench/perf.ts output ───

type R = any;
const better = { ratio: 0.9, ci95: [0.85, 0.95] };
function pairFor(e: string): R {
  const metrics = [
    ...EXPECTED_OPS.flatMap((op) => ['p50', 'p99'].map((q) => ({ metric: `${op} ${q}`, against: e, direction: 'lower_is_better', ratio: 0.9, ci95: [0.85, 0.95], margin: 1.1, status: 'pass', core: op === 'get_page' }))),
    ...EXPECTED_METRICS.map((m) => {
      const lower = m.direction === 'lower_is_better';
      return { metric: m.name, against: e, direction: m.direction, ratio: lower ? 0.9 : 1.1, ci95: m.kind === 'point' ? null : lower ? [0.85, 0.95] : [1.05, 1.15], margin: 1, status: 'pass', core: false };
    }),
  ];
  return {
    reference: e, other: 'rust', missing: {},
    latency: Object.fromEntries(EXPECTED_OPS.map((op) => [op, { n: 2000, p50_ratio: { ...better }, p99_ratio: { ...better } }])),
    throughput: [1, 4, 16].flatMap((clients) => ['read', 'write'].map((kind) => ({ clients, kind, reps: 10, ratio: { ratio: 1.1, ci95: [1.05, 1.15] } }))),
    metrics, rows: { dropped: 'raw timing rows' },
  };
}
const receipt = (edit?: (r: R) => void): R => {
  const r: R = {
    schema_version: 1, benchmark: 'engine-bench', stage: 'speed', counted: false, preregistration_attestation: null, generated_at: '2026-11-24T00:00:00.000Z',
    options: { scale: 10000, tpReps: 10, coldReps: 11 }, evals_commit: 'c'.repeat(40),
    gbrain: { product: { loaded_git_head: COMMIT }, overlay: { ref: 'main', commit: COMMIT, checkout_dirty: false }, version: '0.61.0', rust_addon: { sha256: ADDON, target: 'x86_64-unknown-linux-gnu', engine_build: 'eb1' } },
    margins: { latency_ratio: 1.1, throughput_ratio: 0.9, point_ratio: 1.1, exception_ratio: 1.5, bootstrap_draws: 10000, quantile_draws: 2000 },
    core_ops: ['get_page'], speed: { applies: true, verdict: 'no_slower' },
    arms: { rust: { cold_start: { reps: new Array(11).fill({ total_ms: 1 }) } }, pglite: { cold_start: { reps: new Array(11).fill({ total_ms: 1 }) } }, postgres: { cold_start: { reps: new Array(11).fill({ total_ms: 1 }) } } },
    pairs: { 'rust-vs-pglite': pairFor('pglite'), 'rust-vs-postgres': pairFor('postgres') },
  };
  edit?.(r);
  return r;
};
const pair = (r: R, e: string): R => r.pairs[`rust-vs-${e}`];
const lat = (r: R, e: string, op: string, q: 'p50' | 'p99', patch: object): void => { Object.assign(pair(r, e).latency[op][`${q}_ratio`], patch); };
const nPairs = (r: R, e: string, op: string, n: number): void => { pair(r, e).latency[op].n = n; };
const met = (r: R, e: string, name: string, patch: object): void => { Object.assign(pair(r, e).metrics.find((m: R) => m.metric === name), patch); };
const missingMetric = { ratio: NaN, ci95: null, margin: NaN, status: 'missing' };

// ─── a shadow under a temporary GBRAIN_HOME ───

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) { try { chmodSync(t, 0o700); } catch { /* gone */ } rmSync(t, { recursive: true, force: true }); } });
const tmp = (): string => { const t = mkdtempSync(join(tmpdir(), 'gbrain-bench-')); tmps.push(t); return t; };

interface Run { code: number; out: string; err: string }
interface Ctx { dir: string; file: (r: unknown, name?: string) => string; run: (args: string[]) => Promise<Run>; json: (args: string[]) => Promise<{ code: number; out: any; err: string }>; status: () => any }
async function withShadow(fn: (c: Ctx) => Promise<void>, o: { config?: typeof CONFIG | typeof PG_CONFIG; state?: ShadowState | null } = {}): Promise<void> {
  const home = tmp();
  const config = o.config ?? CONFIG;
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const dir = shadowDirFor(shadowBrainKey(config)!);
    if (o.state !== null) writeShadowState(dir, o.state ?? { ...STATE, primary_engine: config.engine });
    const run = async (args: string[]): Promise<Run> => {
      let out = ''; let err = '';
      const code = await runEngineShadow(args, { config: () => config, out: (l) => { out += `${l}\n`; }, err: (l) => { err += `${l}\n`; }, now: () => NOW });
      return { code, out, err };
    };
    await fn({
      dir, run,
      file: (r, name = 'receipt.json') => { const p = join(home, name); writeFileSync(p, typeof r === 'string' ? r : JSON.stringify(r)); return p; },
      json: async (args) => { const x = await run(args); return { code: x.code, out: x.out.trim() ? JSON.parse(x.out) : null, err: x.err }; },
      status: () => shadowStatusDocument({ key: shadowBrainKey(config)!, dir }, NOW),
    });
  });
}
const importOk = async (c: Ctx, r: unknown): Promise<any> => { const x = await c.json(['bench', '--import', c.file(r), '--json']); expect(x.err).toBe(''); expect(x.code).toBe(0); return x.out; };
const readiness = (bench: any): ShadowStatus['bench'] => { const { filtered_vector_margin_met: _m, ...rest } = bench; return { pairs: rest.pairs, rust_no_worse: rest.rust_no_worse, losses: rest.losses }; };

describe('criterion 8 with no receipt', () => {
  test('both sources read not measured, the D14 margin is unset, and criterion 8 stays reported and not gating', async () => {
    await withShadow(async (c) => {
      const { bench } = await c.status();
      expect(bench.sources.owner_brain.state).toBe('not_measured');
      expect(bench.sources.bench_corpus.state).toBe('not_measured');
      expect(bench.filtered_vector_margin).toBe('D14 margin not set');
      for (const k of ['pairs', 'rust_no_worse', 'losses', 'filtered_vector_margin_met']) expect(k in bench).toBe(false);
      const row8 = evaluateReadiness({ ...(await c.status()) } as never, NOW).criteria.find((x) => x.n === 8)!;
      expect(row8.state).toBe('reported');
      expect(row8.detail).toContain('not measured yet');
      expect(row8.gating).toBe(false);
      const text = (await c.run(['status'])).out;
      expect(text).toContain('bench corpus (engine-bench, not this brain): not measured');
      expect(text).toContain('this brain (gbrain engine shadow bench): not measured');
      expect(text).toContain('filtered vector margin: not evaluated (D14 margin not set)');
    });
  });
});

describe('the loss rule (gbrain-evals criterion8())', () => {
  test('one worse class is named, the readiness fields are filled, and the swap verdict does not move', async () => {
    const r = receipt((x) => {
      lat(x, 'pglite', 'get_page', 'p99', { ratio: 1.06, ci95: [1.02, 1.1] });
      lat(x, 'postgres', 'search_hybrid', 'p50', { ratio: 1, ci95: [0.95, 1.05] });
      nPairs(x, 'pglite', 'list_pages', 150);
    });
    await withShadow(async (c) => {
      const bench = await importOk(c, r);
      expect(bench.pairs).toBe(150);
      expect(bench.rust_no_worse).toBe(false);
      expect(bench.losses).toEqual([`${LOSS}get_page p99 vs PGLite 1.060x (95% CI 1.020 to 1.100 over 2000 pairs)`]);
      expect('filtered_vector_margin_met' in bench).toBe(false);
      const ready: ShadowStatus = { ...readyDoc(), bench: readiness(bench) };
      const v = evaluateReadiness(ready, new Date('2026-12-01T00:00:00Z'));
      expect(v.criteria.filter((x) => x.state !== 'pass' && x.n !== 8).map((x) => [x.n, x.state, x.detail])).toEqual([]);
      expect(v.verdict).toBe('READY');
      const row8 = v.criteria.find((x) => x.n === 8)!;
      expect(row8.gating).toBe(false);
      expect(row8.detail).toContain(bench.losses[0]);
      expect(row8.detail).toContain('Rust slower on at least one class');
    });
  });

  test('every class better or not shown, measured against both engines: no worse, no losses; a worse class flips it', async () => {
    const good = receipt((x) => { lat(x, 'postgres', 'get_timeline', 'p99', { ratio: 1, ci95: [0.97, 1.03] }); });
    await withShadow(async (c) => {
      const bench = await importOk(c, good);
      expect(bench.rust_no_worse).toBe(true);
      expect(bench.losses).toEqual([]);
      expect(bench.pairs).toBe(2000);
      const bad = await importOk(c, receipt((x) => { lat(x, 'postgres', 'get_timeline', 'p99', { ratio: 1.3, ci95: [1.2, 1.4] }); }));
      expect(bad.rust_no_worse).toBe(false);
      expect(bad.losses).toHaveLength(1);
    });
  });

  test('boundaries match criterion8(): an interval edge at 1 is not shown, 99 pairs is not measured, 100 is measured', () => {
    const run = (edit: (x: R) => void) => { const home = tmp(); const p = join(home, 'r.json'); writeFileSync(p, JSON.stringify(receipt(edit))); const dir = join(home, 'shadow'); const res = importBenchReceipt(dir, p, { now: NOW }); if (!res.ok) throw new Error(res.error.message); return classifyBench(res.summary); };
    const rowOf = (c: ReturnType<typeof classifyBench>, name: string, e = 'pglite') => c.rows.find((x) => x.name === name && x.against === e)!;
    const lo = run((x) => lat(x, 'pglite', 'get_page', 'p50', { ratio: 1.1, ci95: [1, 1.2] }));
    expect(rowOf(lo, 'get_page p50').status).toBe('not_shown');
    const hi = run((x) => lat(x, 'pglite', 'get_page', 'p50', { ratio: 0.9, ci95: [0.8, 1] }));
    expect(rowOf(hi, 'get_page p50').status).toBe('not_shown');
    const n99 = run((x) => nPairs(x, 'pglite', 'get_page', 99));
    expect(rowOf(n99, 'get_page p50').status).toBe('too_few_pairs');
    expect(n99.losses).toContain(`${LOSS}get_page p50 vs PGLite not measured: 99 pairs (needs 100)`);
    expect(n99.losses).toContain(`${LOSS}get_page p99 vs PGLite not measured: 99 pairs (needs 100)`);
    expect(n99.rust_no_worse).toBe(false);
    expect(n99.pairs).toBe(99);
    expect(rowOf(run((x) => nPairs(x, 'pglite', 'get_page', 100)), 'get_page p50').status).toBe('better');
    const noCi = run((x) => lat(x, 'pglite', 'get_page', 'p50', { ci95: null }));
    expect(rowOf(noCi, 'get_page p50').status).toBe('too_few_pairs');
    const refused = run((x) => { delete pair(x, 'postgres').latency.graph_walk_d3; pair(x, 'postgres').missing.graph_walk_d3 = 'engine_capability_missing: graph walk, refused'; });
    expect(refused.losses).toContain(`${LOSS}graph_walk_d3 p50 vs Postgres not measured (Rust refused: engine_capability_missing: graph walk refused)`);
    expect(refused.rust_no_worse).toBe(false);
  });

  test('non-latency metrics: a throughput interval below 1 is a loss, a point RSS above 1 is a loss, below 1 is not', async () => {
    await withShadow(async (c) => {
      const bench = await importOk(c, receipt((x) => {
        met(x, 'pglite', 'read throughput at 16 clients', { ratio: 0.71, ci95: [0.65, 0.78] });
        met(x, 'postgres', 'peak RSS', { ratio: 1.4, ci95: null, status: 'fail' });
        met(x, 'pglite', 'peak RSS', { ratio: 0.9, ci95: null });
        met(x, 'postgres', 'cold start', { ratio: 1.6, ci95: [1.5, 1.7] });
      }));
      expect(bench.losses).toEqual([
        `${LOSS}read throughput at 16 clients vs PGLite 0.710x (95% CI 0.650 to 0.780 over 10 reps)`,
        `${LOSS}cold start vs Postgres 1.600x (95% CI 1.500 to 1.700 over 11 Rust and 11 Postgres starts)`,
        `${LOSS}peak RSS vs Postgres 1.400x (point estimate no interval)`,
      ]);
    });
  });
});

describe('coverage: a receipt that leaves things out never reads as no worse', () => {
  const never = (r: R, why: string, check?: (bench: any) => void) => test(why, async () => {
    await withShadow(async (c) => {
      const bench = await importOk(c, r);
      expect(bench.rust_no_worse).toBe(false);
      check?.(bench);
    });
  });
  never(receipt((x) => { for (const e of ENGINES) { pair(x, e).latency = {}; pair(x, e).missing = {}; pair(x, e).metrics = []; } }), 'two empty pairs: zero pairs, every row named not measured', (b) => {
    expect(b.pairs).toBe(0);
    expect(b.sources.bench_corpus.rows).toHaveLength(2 * (EXPECTED_OPS.length * 2 + EXPECTED_METRICS.length));
    expect(b.losses).toHaveLength(b.sources.bench_corpus.rows.length);
    expect(b.losses).toContain(`${LOSS}search_hybrid p99 vs Postgres not measured (absent from the receipt)`);
  });
  never(receipt((x) => { for (const e of ENGINES) for (const op of EXPECTED_OPS.slice(1)) delete pair(x, e).latency[op]; }), 'one operation measured and twelve named nowhere', (b) => {
    expect(b.losses.filter((l: string) => l.includes('absent from the receipt') && !l.includes('read ') && !l.includes('write '))).toHaveLength(12 * 2 * 2);
  });
  test('a losing class removed from both maps is a missing row, and with the class present it is a loss', async () => {
    await withShadow(async (c) => {
      const losing = (x: R) => { for (const e of ENGINES) { lat(x, e, 'search_vector', 'p99', { ratio: 2, ci95: [1.8, 2.2] }); } };
      const withLoss = await importOk(c, receipt(losing));
      expect(withLoss.losses).toHaveLength(2);
      const removed = await importOk(c, receipt((x) => { losing(x); for (const e of ENGINES) { delete pair(x, e).latency.search_vector; pair(x, e).metrics = pair(x, e).metrics.filter((m: R) => !m.metric.startsWith('search_vector ')); } }));
      expect(removed.rust_no_worse).toBe(false);
      expect(removed.losses).toContain(`${LOSS}search_vector p99 vs PGLite not measured (absent from the receipt)`);
    });
  });
  test('an extra operation gets rows and a worse extra operation is a loss', async () => {
    await withShadow(async (c) => {
      const bench = await importOk(c, receipt((x) => { pair(x, 'pglite').latency.new_op = { n: 500, p50_ratio: { ratio: 3, ci95: [2.5, 3.5] }, p99_ratio: { ratio: 1, ci95: [0.5, 1.5] } }; }));
      expect(bench.losses).toEqual([`${LOSS}new_op p50 vs PGLite 3.000x (95% CI 2.500 to 3.500 over 500 pairs)`]);
      expect(bench.sources.bench_corpus.rows.some((r: R) => r.name === 'new_op p99')).toBe(true);
    });
  });
  never(receipt((x) => { for (const e of ENGINES) met(x, e, 'write throughput at 4 clients', missingMetric); met(x, 'pglite', 'read throughput at 1 client', { ratio: 0.5, ci95: [0.4, 0.6] }); }), 'a refused write-throughput axis (real JSON null) is named not measured beside a measured loss', (b) => {
    expect(b.losses).toContain(`${LOSS}write throughput at 4 clients vs Postgres not measured (the receipt marks it missing: Rust did not produce it)`);
    expect(b.losses.some((l: string) => l.includes('read throughput at 1 client vs PGLite 0.500x'))).toBe(true);
    expect(JSON.stringify(receipt((x) => met(x, 'pglite', 'peak RSS', missingMetric)))).toContain('"ratio":null');
  });
  never(receipt((x) => { pair(x, 'postgres').metrics = pair(x, 'postgres').metrics.filter((m: R) => m.metric !== 'cold start'); delete pair(x, 'pglite').metrics; }), 'an omitted metric and an omitted metrics array', (b) => {
    expect(b.losses).toContain(`${LOSS}cold start vs Postgres not measured (absent from the receipt)`);
    expect(b.losses).toContain(`${LOSS}peak RSS vs PGLite not measured (absent from the receipt)`);
  });
  never(receipt((x) => { delete x.pairs['rust-vs-postgres']; }), 'only a PGLite pair: Postgres is not measured', (b) => {
    expect(b.losses.at(-1)).toContain('vs Postgres not measured');
  });
});

describe('refusals keep the earlier evidence and say how to fix it', () => {
  const CASES: Array<[string, (x: R) => void, string]> = [
    ['wrong benchmark', (x) => { x.benchmark = 'other'; }, 'benchmark is "other" (expected "engine-bench")'],
    ['wrong stage', (x) => { x.stage = 'answers'; }, 'stage is "answers"'],
    ['schema 2', (x) => { x.schema_version = 2; }, 'schema_version 2 is unsupported (expected 1)'],
    ['other margins', (x) => { x.margins.bootstrap_draws = 500; }, 'margins differ from the preregistration'],
    ['no Rust pair', (x) => { delete x.pairs['rust-vs-pglite']; delete x.pairs['rust-vs-postgres']; x.pairs['postgres-vs-pglite'] = { reference: 'pglite', other: 'postgres' }; }, 'no Rust pair'],
    ['Rust unavailable', (x) => { x.arms.rust = { unavailable: { stage: 'import', reason: 'addon missing' } }; }, 'the Rust arm refused at stage import: addon missing'],
    ['NaN as a number on a measured metric', (x) => met(x, 'pglite', 'peak RSS', { ratio: NaN }), 'ratio of a measured metric'],
    ['reversed interval', (x) => lat(x, 'pglite', 'get_page', 'p50', { ci95: [1.2, 1.1] }), 'is reversed'],
  ];
  for (const [name, edit, text] of CASES) {
    test(`${name}: exit 2, nothing replaced, one parseable envelope`, async () => {
      await withShadow(async (c) => {
        await importOk(c, receipt());
        const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
        const x = await c.json(['bench', '--import', c.file(receipt(edit)), '--json']);
        expect(x.code).toBe(2);
        expect(x.out.code).toBe('invalid_params');
        expect(x.out.message).toContain(text);
        expect(x.err).toContain('previous bench evidence unchanged');
        expect(x.err).toContain('Fix:');
        expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      });
    });
  }
  test('schema 2 gives the exact text and never tells the agent to edit the receipt', async () => {
    await withShadow(async (c) => {
      const x = await c.run(['bench', '--import', c.file(receipt((r) => { r.schema_version = 2; })), '--json']);
      expect(x.err).toContain('schema_version 2 is unsupported (expected 1); previous bench evidence unchanged [invalid_params; docs/ENGINES.md#rust-engine-shadow-mode]');
      expect(x.err).toContain('Do not edit the receipt to make it pass');
    });
  });
  test('no shadow for this brain: not_found, nothing written, the owner decides', async () => {
    await withShadow(async (c) => {
      const x = await c.json(['bench', '--import', c.file(receipt()), '--json']);
      expect(x.code).toBe(1);
      expect(x.out.code).toBe('not_found');
      expect(x.err).toContain('Ask the brain owner');
      expect(existsSync(c.dir)).toBe(false);
    }, { state: null });
  });
  test('plain bench, --import without a value, a missing file and an unknown flag', async () => {
    await withShadow(async (c) => {
      const plain = await c.json(['bench', '--json']);
      expect(plain.code).toBe(2);
      expect(plain.err).toContain('is not built');
      expect(plain.err).toContain('--import loads an engine-bench speed receipt');
      expect((await c.json(['bench', '--import'])).code).toBe(2);
      expect((await c.json(['bench', '--frobnicate'])).code).toBe(2);
      const gone = await c.json(['bench', '--import', join(tmp(), 'nope.json'), '--json']);
      expect(gone.out.code).toBe('not_found');
    });
  });
  test('values are checked by meaning, each case a refusal with the earlier summary intact', async () => {
    const bad: Array<[string, (x: R) => void]> = [
      ['string ratio', (x) => met(x, 'pglite', 'cold start', { ratio: '1.2' })],
      ['null ratio on a measured metric', (x) => met(x, 'pglite', 'cold start', { ratio: null })],
      ['a number on a missing metric', (x) => met(x, 'pglite', 'peak RSS', { status: 'missing', ratio: 1 })],
      ['object interval', (x) => met(x, 'pglite', 'cold start', { ci95: { lo: 1, hi: 2 } })],
      ['negative ratio', (x) => met(x, 'pglite', 'cold start', { ratio: -1 })],
      ['fractional n', (x) => nPairs(x, 'pglite', 'get_page', 2.5)],
      ['negative n', (x) => nPairs(x, 'pglite', 'get_page', -1)],
      ['wrong direction', (x) => met(x, 'pglite', 'cold start', { direction: 'higher_is_better' })],
      ['wrong status', (x) => met(x, 'pglite', 'cold start', { status: 'great' })],
      ['measured throughput without an interval', (x) => met(x, 'pglite', 'read throughput at 1 client', { ci95: null })],
      ['duplicate metric', (x) => { pair(x, 'pglite').metrics.push({ ...pair(x, 'pglite').metrics[0] }); }],
      ['duplicate pair', (x) => { x.pairs.again = pairFor('pglite'); }],
      ['an operation both measured and missing', (x) => { pair(x, 'pglite').missing.get_page = 'x'; }],
    ];
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      for (const [name, edit] of bad) {
        const x = await c.json(['bench', '--import', c.file(receipt(edit)), '--json']);
        expect([name, x.code]).toEqual([name, 2]);
        expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      }
      const nan = await c.json(['bench', '--import', c.file('{"ratio": NaN}'), '--json']);
      expect(nan.err).toContain('not valid JSON');
    });
  });
});

describe('build identity is reported and never gates', () => {
  const epoch = (dir: string, o: { addon?: string | null; build?: boolean } = {}) => ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: o.addon === undefined ? ADDON : o.addon, comparator_version: 1, adapter_version: 'a', capability_set_hash: null, readiness_policy_hash: 'p' }, NOW.getTime(), o.build === false ? undefined : { gbrain_commit: COMMIT, gbrain_version: '0.61.0', addon_target: 'x86_64-unknown-linux-gnu' });
  const match = async (c: Ctx, r: R) => (await importOk(c, r)).sources.bench_corpus.build_match;
  test('same, differs, unknown (no addon in the receipt, no build in the epoch); the fields are filled each time', async () => {
    await withShadow(async (c) => {
      epoch(c.dir);
      expect(await match(c, receipt())).toEqual({ commit: 'same', addon: 'same', target: 'same', epoch_id: expect.any(String) });
      const diff = receipt((x) => { x.gbrain.rust_addon.sha256 = 'd'.repeat(64); });
      const bench = await importOk(c, diff);
      expect(bench.sources.bench_corpus.build_match.addon).toBe('differs');
      expect(bench.pairs).toBe(2000);
      expect((await c.run(['status'])).out).toContain('addon differs (reported, not gating)');
      expect((await c.run(['report'])).out).toContain('addon differs (reported, not gating)');
      expect((await match(c, receipt((x) => { x.gbrain.rust_addon = null; }))).addon).toBe('unknown');
    });
    await withShadow(async (c) => {
      epoch(c.dir, { build: false });
      const m = await match(c, receipt());
      expect([m.commit, m.target, m.addon]).toEqual(['unknown', 'unknown', 'same']);
    });
  });
});

describe('labels and rendering come from one block', () => {
  test('status text and report Markdown carry the labels, every class row and the dirty warning; the primary engine is marked', async () => {
    const r = receipt((x) => {
      x.gbrain.overlay.checkout_dirty = true;
      lat(x, 'pglite', 'get_page', 'p50', { ratio: 1, ci95: [0.9, 1.1] });
    });
    for (const config of [CONFIG, PG_CONFIG]) {
      await withShadow(async (c) => {
        await importOk(c, r);
        for (const text of [(await c.run(['status'])).out, (await c.run(['report'])).out]) {
          for (const s of ['bench corpus (engine-bench, not this brain)', 'development run (uncounted)', 'this brain (gbrain engine shadow bench): not measured', 'filtered vector margin: not evaluated (D14 margin not set)', 'ran from a gbrain checkout with uncommitted changes', 'get_page p50: 2000 pairs, ratio 1.000, 95% CI 0.900 to 1.100, not shown (inconclusive, not faster)', 'list_pages p99: 2000 pairs, ratio 0.900, 95% CI 0.850 to 0.950, better', 'write throughput at 16 clients: ratio 1.100']) expect(text).toContain(s);
          expect(text.split('\n').filter((l) => /: (\d+ pairs|ratio)/.test(l) || / not measured /.test(l)).length).toBeGreaterThanOrEqual(2 * (EXPECTED_OPS.length * 2 + EXPECTED_METRICS.length));
          const primary = config.engine === 'pglite' ? 'vs PGLite' : 'vs Postgres';
          expect(text).toContain(`${primary} (this brain's primary):`);
          expect(text.match(/this brain's primary/g)).toHaveLength(1);
        }
        const doc = await c.status();
        expect(doc.bench.sources.bench_corpus.receipt.counted).toBe(false);
        for (const l of doc.bench.losses) expect(l.startsWith(LOSS) && !l.includes(', ') && !l.includes(';')).toBe(true);
      }, { config });
    }
    await withShadow(async (c) => {
      await importOk(c, receipt());
      expect((await c.run(['status'])).out).not.toContain('uncommitted changes');
    });
  });
  test('a counted receipt reads counted', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt((x) => { x.counted = true; }));
      expect((await c.run(['status'])).out).toContain(', counted, gbrain');
    });
  });
});

describe('storage', () => {
  test('the stored file keeps no raw rows and only the base name, and a re-import replaces it', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const text = readFileSync(benchSummaryPath(c.dir), 'utf8');
      expect(text).not.toContain('"rows"');
      expect(text).not.toContain(tmpdir());
      expect(JSON.parse(text).source_file).toBe('receipt.json');
      expect(statSync(benchSummaryPath(c.dir)).mode & 0o777).toBe(0o600);
      const again = await importOk(c, receipt((x) => lat(x, 'pglite', 'get_page', 'p99', { ratio: 2, ci95: [1.5, 2.5] })));
      expect(again.losses).toHaveLength(1);
      expect((await c.status()).bench.losses).toHaveLength(1);
    });
  });
  test('a corrupt or semantically corrupt stored file reads unreadable with no readiness fields and no zeros', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const path = benchSummaryPath(c.dir);
      const good = JSON.parse(readFileSync(path, 'utf8'));
      const corrupt: Array<(s: any) => void> = [
        (s) => { s.pairs[0].latency.get_page.p50_ratio.ratio = 'fast'; },
        (s) => { s.pairs[0].latency.get_page.p50_ratio.ci95 = [2, 1]; },
        (s) => { s.pairs.push({ ...s.pairs[0] }); },
        (s) => { s.pairs[0].metrics[0].direction = 'sideways'; },
        (s) => { s.pairs[0].missing.x = 'a, b'; },
        (s) => { s.version = 2; },
      ];
      for (const edit of corrupt) {
        const s = structuredClone(good); edit(s);
        writeFileSync(path, JSON.stringify(s));
        const b = (await c.status()).bench;
        expect(b.sources.bench_corpus.state).toBe('unreadable');
        expect(b.sources.bench_corpus.reason).toContain('gbrain engine shadow bench --import');
        for (const k of ['pairs', 'rust_no_worse', 'losses']) expect(k in b).toBe(false);
      }
      writeFileSync(path, '{not json');
      expect((await c.status()).bench.sources.bench_corpus.state).toBe('unreadable');
    });
  });
  test('a failed rename leaves the earlier summary active and no temp file; a retry after the cause is gone works', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const path = benchSummaryPath(c.dir);
      rmSync(path);
      mkdirSync(join(path, 'blocker'), { recursive: true });
      const x = await c.json(['bench', '--import', c.file(receipt()), '--json']);
      expect(x.code).toBe(1);
      expect(x.out.code).toBe('storage_error');
      expect(x.err).toContain('the previous bench evidence is still active');
      expect(x.err).not.toContain(c.dir);
      expect(readdirSync(join(c.dir, 'evidence', 'bench')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      rmSync(path, { recursive: true });
      expect((await c.json(['bench', '--import', c.file(receipt()), '--json'])).code).toBe(0);
      expect(readFileSync(path, 'utf8')).toContain('"version": 1');
    });
  });
  test.skipIf(process.getuid?.() === 0)('an unwritable directory is a storage_error naming the OS error only', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const bench = join(c.dir, 'evidence', 'bench');
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      chmodSync(bench, 0o500);
      const x = await c.json(['bench', '--import', c.file(receipt()), '--json']);
      expect(x.out.code).toBe('storage_error');
      expect(x.err).toContain('EACCES');
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      chmodSync(bench, 0o700);
    });
  });
});

describe('actual sample counts survive import, reload and report', () => {
  test('non-default throughput repetitions and cold-start counts are printed, not the producer defaults', async () => {
    await withShadow(async (c) => {
      const bench = await importOk(c, receipt((x) => {
        for (const t of pair(x, 'pglite').throughput) t.reps = 7;
        x.arms.rust.cold_start.reps = new Array(5).fill({ total_ms: 1 });
        x.arms.pglite.cold_start.reps = new Array(9).fill({ total_ms: 1 });
        met(x, 'pglite', 'write throughput at 4 clients', { ratio: 0.5, ci95: [0.4, 0.6] });
        met(x, 'pglite', 'cold start', { ratio: 2, ci95: [1.8, 2.2] });
      }));
      expect(bench.losses).toEqual([
        `${LOSS}write throughput at 4 clients vs PGLite 0.500x (95% CI 0.400 to 0.600 over 7 reps)`,
        `${LOSS}cold start vs PGLite 2.000x (95% CI 1.800 to 2.200 over 5 Rust and 9 PGLite starts)`,
      ]);
      expect((await c.status()).bench.losses).toEqual(bench.losses);
      expect((await c.run(['report'])).out).toContain('over 7 reps');
    });
  });
  test('a receipt that records no count prints sample count not recorded', async () => {
    await withShadow(async (c) => {
      const bench = await importOk(c, receipt((x) => {
        pair(x, 'pglite').throughput = [];
        met(x, 'pglite', 'read throughput at 1 client', { ratio: 0.5, ci95: [0.4, 0.6] });
      }));
      expect(bench.losses).toEqual([`${LOSS}read throughput at 1 client vs PGLite 0.500x (95% CI 0.400 to 0.600 with sample count not recorded)`]);
    });
  });
});

describe('the receipt file is read safely and never blocks', () => {
  const SCRIPT = `import { importBenchReceipt } from ${JSON.stringify(join(import.meta.dir, '../src/shadow/bench-receipt.ts'))};
const r = importBenchReceipt(process.argv[1], process.argv[2], { maxBytes: Number(process.argv[3]) });
console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, code: r.error.code, message: r.error.message, fix: r.error.suggestion }));`;
  const child = (dir: string, path: string, maxBytes = MAX_RECEIPT_BYTES) => {
    const t0 = Date.now();
    const p = Bun.spawnSync([process.execPath, '-e', SCRIPT, dir, path, String(maxBytes)], { timeout: 20_000, stdout: 'pipe', stderr: 'pipe' });
    return { elapsed: Date.now() - t0, timedOut: p.exitedDueToTimeout === true, result: JSON.parse(new TextDecoder().decode(p.stdout).trim().split('\n').at(-1) ?? '{}') };
  };
  const seeded = () => {
    const home = tmp(); const dir = join(home, 'shadow');
    const good = join(home, 'good.json'); writeFileSync(good, JSON.stringify(receipt()));
    expect(importBenchReceipt(dir, good, { now: NOW }).ok).toBe(true);
    return { home, dir, before: readFileSync(benchSummaryPath(dir), 'utf8') };
  };
  const refused = (name: string, make: (home: string) => string, maxBytes?: number, message?: string) => test(name, () => {
    const s = seeded();
    const path = make(s.home);
    const x = child(s.dir, path, maxBytes);
    expect(x.timedOut).toBe(false);
    expect(x.result.ok).toBe(false);
    expect(x.result.code).toBe('invalid_params');
    expect(x.result.fix).toBeTruthy();
    if (message) expect(x.result.message).toContain(message);
    expect(readFileSync(benchSummaryPath(s.dir), 'utf8')).toBe(s.before);
  });
  refused('a named pipe with no writer is refused at once', (home) => { const p = join(home, 'pipe'); Bun.spawnSync(['mkfifo', p]); return p; }, undefined, 'a named pipe');
  refused('a directory is refused', (home) => home, undefined, 'a directory');
  refused('a symbolic link is refused, even to a good receipt', (home) => { const p = join(home, 'link.json'); symlinkSync(join(home, 'good.json'), p); return p; }, undefined, 'a symbolic link');
  refused('a file over the cap is refused', (home) => join(home, 'good.json'), 1000, 'larger than 1000 bytes');
  refused('a file that keeps growing is refused promptly', (home) => {
    const p = join(home, 'grow.json');
    writeFileSync(p, 'x'.repeat(900_000));
    Bun.spawn([process.execPath, '-e', `const fs=require('fs');for(let i=0;i<300;i++){fs.appendFileSync(${JSON.stringify(p)},'y'.repeat(1<<16));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}`], { stdout: 'ignore', stderr: 'ignore' });
    return p;
  }, 1_000_000);
  test('the read loop, not the reported size, bounds the bytes (a procfs file reports size 0)', () => {
    if (!existsSync('/proc/cpuinfo')) return;
    const r = readBoundedFile('/proc/cpuinfo', 64);
    expect(r).toMatchObject({ ok: false, failure: 'too_large' });
  });
  test('the real cap is 256 MiB', () => { expect(MAX_RECEIPT_BYTES).toBe(256 * 1024 * 1024); });
  test('a device is refused where one exists', () => {
    if (!existsSync('/dev/zero')) return;
    expect(readBoundedFile('/dev/zero', 1000)).toMatchObject({ ok: false, failure: 'not_regular' });
  });
});

describe('the stored summary read', () => {
  test('absent reads absent', () => { expect(readBenchSummary(tmp())).toEqual({ state: 'absent' }); });
});

describe('round 1 review fixes: attribution, stored size, zero samples, and not measured is not slower', () => {
  test('a metric attributed to another engine than its pair is refused and the earlier evidence stays byte for byte', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      const x = await c.json(['bench', '--import', c.file(receipt((r) => met(r, 'pglite', 'read throughput at 1 client', { against: 'postgres' }))), '--json']);
      expect(x.code).toBe(2);
      expect(x.out.code).toBe('invalid_params');
      expect(x.out.message).toContain('against');
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
    });
  });

  test('a summary over the stored-size cap is refused before anything is replaced: no temp file, the earlier evidence is still read', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      const big = receipt((r) => { for (let i = 0; i < 45000; i++) pair(r, 'pglite').missing[`extra_op_${i}`] = 'x'.repeat(190); });
      const x = await c.json(['bench', '--import', c.file(big), '--json']);
      expect(x.code).toBe(2);
      expect(x.out.code).toBe('invalid_params');
      expect(x.out.message).toContain('larger than');
      expect(x.err).toContain('previous bench evidence unchanged');
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      expect(readdirSync(join(c.dir, 'evidence', 'bench')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect((await c.status()).bench.sources.bench_corpus.state).toBe('measured');
    });
  });

  test('zero recorded samples are not measured, are named in the losses, and never read as no worse', async () => {
    await withShadow(async (c) => {
      const reps = await importOk(c, receipt((r) => { pair(r, 'pglite').throughput[0].reps = 0; }));
      expect(reps.rust_no_worse).toBe(false);
      expect(reps.losses).toEqual([`${LOSS}read throughput at 1 client vs PGLite not measured (the receipt records zero samples)`]);
      const cold = await importOk(c, receipt((r) => { r.arms.rust.cold_start.reps = []; }));
      expect(cold.rust_no_worse).toBe(false);
      expect(cold.losses).toEqual([`${LOSS}cold start vs PGLite not measured (the receipt records zero samples)`, `${LOSS}cold start vs Postgres not measured (the receipt records zero samples)`]);
    });
  });

  test('readiness says not measured, not slower, when the only open rows are unmeasured; a measured loss still says slower (status to plan path)', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt((r) => { nPairs(r, 'pglite', 'get_page', 50); }));
      const row8 = async (): Promise<{ detail: string; gating: boolean }> => evaluateReadiness({ ...readyDoc(), bench: readiness((await c.status()).bench) }, new Date('2026-12-01T00:00:00Z')).criteria.find((x) => x.n === 8)! as never;
      const unmeasured = await row8();
      expect(unmeasured.detail).toContain('Rust not shown to be no worse (rows not measured)');
      expect(unmeasured.detail).not.toContain('Rust slower');
      expect(unmeasured.detail).toContain(`${LOSS}get_page p50 vs PGLite not measured: 50 pairs (needs 100)`);
      expect(unmeasured.gating).toBe(false);
      await importOk(c, receipt((r) => { nPairs(r, 'pglite', 'get_page', 50); lat(r, 'postgres', 'get_timeline', 'p99', { ratio: 1.3, ci95: [1.2, 1.4] }); }));
      expect((await row8()).detail).toContain('Rust slower on at least one class');
    });
  });
});

describe('round 2 review fixes: a recorded sample count is never read as absent', () => {
  test.each([[-1], [0.5], ['0'], [null]])('a throughput that records reps %p is refused and the earlier evidence stays byte for byte', async (reps) => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      const x = await c.json(['bench', '--import', c.file(receipt((r) => { pair(r, 'pglite').throughput[0].reps = reps; })), '--json']);
      expect(x.code).toBe(2);
      expect(x.out.code).toBe('invalid_params');
      expect(x.out.message).toContain('records reps');
      expect(x.err).toContain('previous bench evidence unchanged');
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
    });
  });

  test.each([['0'], [5]])('cold-start repetitions recorded as %p (not a list) are refused', async (reps) => {
    await withShadow(async (c) => {
      const x = await c.json(['bench', '--import', c.file(receipt((r) => { r.arms.rust.cold_start.reps = reps; })), '--json']);
      expect(x.code).toBe(2);
      expect(x.out.message).toContain('cold-start repetitions');
    });
  });

  test('a recorded zero cold-start count stays known when the other arm count is absent, whichever arm it is', async () => {
    await withShadow(async (c) => {
      const zero = `${LOSS}cold start vs PGLite not measured (the receipt records zero samples)`;
      const rustZero = await importOk(c, receipt((r) => { r.arms.rust.cold_start.reps = []; delete r.arms.pglite.cold_start.reps; }));
      expect(rustZero.rust_no_worse).toBe(false);
      expect(rustZero.losses).toContain(zero);
      const refZero = await importOk(c, receipt((r) => { delete r.arms.rust.cold_start.reps; r.arms.pglite.cold_start.reps = []; }));
      expect(refZero.rust_no_worse).toBe(false);
      expect(refZero.losses).toContain(zero);
      const bothAbsent = await importOk(c, receipt((r) => { r.arms.rust.cold_start.reps = []; delete r.arms.pglite.cold_start.reps; delete r.arms.postgres.cold_start.reps; }));
      expect(bothAbsent.rust_no_worse).toBe(false);
      expect(bothAbsent.losses).toEqual([zero, `${LOSS}cold start vs Postgres not measured (the receipt records zero samples)`]);
      // positive control: a known non-zero Rust count with the other arm's count absent is measured, and its text says what is unrecorded
      const known = await importOk(c, receipt((r) => { r.arms.rust.cold_start.reps = new Array(5).fill({ total_ms: 1 }); delete r.arms.pglite.cold_start.reps; }));
      expect(known.rust_no_worse).toBe(true);
      expect((await c.run(['status'])).out).toContain('over 5 Rust and an unrecorded number of PGLite starts');
    });
  });
});

describe('an accepted receipt can never stop report from rendering (review of the master-based head)', () => {
  // Grows both pairs to `ops` operations (a mix of measured and refused extras) and `metrics` metric rows, the way a very wide receipt would.
  const grow = (ops: number, metrics: number) => (x: R): void => {
    for (const e of ENGINES) {
      const p = pair(x, e);
      for (let i = EXPECTED_OPS.length; i < ops; i++) {
        if (i % 2) p.latency[`extra_op_${i}`] = { n: 2000, p50_ratio: { ...better }, p99_ratio: { ...better } };
        else p.missing[`extra_op_${i}`] = 'not implemented';
      }
      for (let i = p.metrics.length; i < metrics; i++) p.metrics.push({ metric: `extra metric ${i}`, against: e, direction: 'lower_is_better', ratio: 0.9, ci95: [0.85, 0.95], margin: 1, status: 'pass', core: false, });
    }
  };
  test('at the cap the import is accepted and report renders in text and JSON', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt(grow(MAX_OPERATIONS_PER_PAIR, MAX_METRICS_PER_PAIR)));
      const text = await c.run(['report']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('## Speed');
      expect(text.out).toContain(`extra_op_${MAX_OPERATIONS_PER_PAIR - 1}`);
      const json = await c.json(['report', '--json']);
      expect(json.code).toBe(0);
      expect(json.out.bench.sources.bench_corpus.state).toBe('measured');
    });
  });
  test('above the cap the import is refused with a named reason and the earlier evidence is unchanged', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const before = readFileSync(benchSummaryPath(c.dir), 'utf8');
      const ops = await c.json(['bench', '--import', c.file(receipt(grow(MAX_OPERATIONS_PER_PAIR + 1, 0))), '--json']);
      expect(ops.code).not.toBe(0);
      expect(ops.out.code).toBe('invalid_params');
      expect(ops.out.message).toContain(`more than ${MAX_OPERATIONS_PER_PAIR} operations`);
      expect(ops.out.message).toContain('previous bench evidence unchanged');
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      const met = await c.json(['bench', '--import', c.file(receipt(grow(0, MAX_METRICS_PER_PAIR + 1))), '--json']);
      expect(met.code).not.toBe(0);
      expect(met.out.message).toContain(`more than ${MAX_METRICS_PER_PAIR} metrics`);
      expect(readFileSync(benchSummaryPath(c.dir), 'utf8')).toBe(before);
      expect((await c.run(['report'])).code).toBe(0);
    });
  });
  test('the report appends lines one at a time: one million loss lines render and none is dropped', async () => {
    await withShadow(async (c) => {
      await importOk(c, receipt());
      const r = buildProvisionalReport(c.dir, 'b', STATE, NOW);
      const bench = r.bench as any;
      bench.rust_no_worse = false;
      bench.losses = Array.from({ length: 1_000_000 }, (_, i) => `${LOSS}synthetic_${i} vs PGLite not measured (test)`);
      const md = renderProvisionalMarkdown(r);
      expect(md).toContain('synthetic_0 vs PGLite');
      expect(md).toContain('synthetic_999999 vs PGLite');
    });
  });
});

function readyDoc(): ShadowStatus {
  return {
    epoch_id: 'e1', epoch_started_at: '2026-11-10T00:00:00Z',
    follower: { state: 'following', lag_ms: 0, lag_ms_p99_24h: 900, lag_ms_p99_epoch: 1200, queue_depth: 0, applied_rows: 5000, coverage_watermark: { valid: true, through: 'x', invalidated_reason: null } },
    reconcile: { state: 'idle', consecutive_clean_full_passes: 3 },
    write_comparisons: { state: 'on', sample_rate: 1, comparable: 1500, unexplained_difference: 0, uncomparable: 2, capability_missing: 0 },
    fingerprints: { checked_rows: 900, mismatches: 0, probe: { state: 'pass', checked_at: '2026-11-30T00:00:00Z', server_version: '16', collation: 'C' } },
    allocators: { verified: true, checked_at: '2026-11-30T00:00:00Z' },
    seed: { seed_id: 's', finished_at: '2026-11-10T01:00:00Z', unseeded_gap_rows_total: 0 },
    reads: { ops: [{ op: 'search', successful: 8000, minimum: 1000 }, { op: 'get_page', successful: 4000, minimum: 1000 }], capability_missing_7d: 0, rust_error_unresolved_7d: 0, diverged_unexplained_7d: 0 },
    search: { trigram_exact_disagreements: 0, keyword_title: { ranker: 'ts_rank', exact_disagreements: 0 }, vector_recall_at_10: 0.99, primary_recall_at_10: 0.985 },
    privacy_diverged: 0, child: { panics: 0, faults: 0 }, drills: { backup_restore_passed: true, eval_gates_e1_e3: true },
    eligibility: { writer_hosts_7d: 1, unknown_writer_paths: 0, team_brain: false, preview_target: true },
  } as unknown as ShadowStatus;
}
