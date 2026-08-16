/**
 * #4152 two-stage cascade — runTriagePass + buildTriageMapBlock +
 * parseSynthV2Key unit tests.
 *
 * runTriagePass touches the engine only through get/putDreamVerdict, so a
 * Map-backed fake engine keeps these tests fast and deterministic (no PGLite
 * startup). The judge is injected via cfg.judge; the clock via cfg.now — no
 * real sleeps anywhere.
 *
 * Run: bun test test/cycle-synthesize-triage.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  runTriagePass,
  buildTriageMapBlock,
  parseSynthV2Key,
  dreamInlineQueueAgeMs,
  DREAM_INLINE_LIVE_GRACE_MS,
  TRIAGE_VERSION,
  type JudgeClient,
  type TriagePassCfg,
} from '../src/core/cycle/synthesize.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../src/core/engine.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';

function makeTranscript(name: string, content = `content of ${name} `.repeat(50)): DiscoveredTranscript {
  return {
    filePath: `/corpus/${name}.txt`,
    contentHash: `hash-${name}`.padEnd(20, '0'),
    content,
    basename: name,
    inferredDate: null,
  };
}

/** Map-backed fake engine exposing only the two verdict methods runTriagePass uses. */
function makeFakeEngine(): { engine: BrainEngine; rows: Map<string, DreamVerdict>; putCalls: number } {
  const rows = new Map<string, DreamVerdict>();
  const state = { putCalls: 0 };
  const engine = {
    async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
      return rows.get(`${filePath}|${contentHash}`) ?? null;
    },
    async putDreamVerdict(filePath: string, contentHash: string, v: DreamVerdictInput): Promise<void> {
      state.putCalls++;
      rows.set(`${filePath}|${contentHash}`, { ...v, judged_at: new Date().toISOString() });
    },
  } as unknown as BrainEngine;
  return {
    engine,
    rows,
    get putCalls() { return state.putCalls; },
  };
}

function scoredJudge(score: number, extra: Record<string, unknown> = {}): JudgeClient {
  return {
    create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ score, reasons: ['mock'], ...extra }) }],
      stop_reason: 'end_turn',
    } as never),
  };
}

function baseCfg(judge: JudgeClient | null, over: Partial<TriagePassCfg> = {}): TriagePassCfg {
  return {
    model: MODEL,
    maxChars: 24_000,
    maxTokens: 2048,
    threshold: 0.5,
    concurrency: 4,
    maxMs: 0,
    judge,
    ...over,
  };
}

function seedVerdict(rows: Map<string, DreamVerdict>, t: DiscoveredTranscript, v: Partial<DreamVerdict>): void {
  rows.set(`${t.filePath}|${t.contentHash}`, {
    worth_processing: true,
    reasons: ['seed'],
    judged_at: new Date().toISOString(),
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: MODEL,
    triage_version: TRIAGE_VERSION,
    ...v,
  });
}

describe('runTriagePass — cache validity (C8)', () => {
  test('valid cached row is a HIT: no judge call, no cache write, report cached=true, byPath populated', async () => {
    const fake = makeFakeEngine();
    const t = makeTranscript('cached');
    seedVerdict(fake.rows, t, { score: 0.8 });
    let judgeCalls = 0;
    const judge: JudgeClient = { create: async () => { judgeCalls++; throw new Error('should not be called'); } };
    const r = await runTriagePass(fake.engine, [t], baseCfg(judge));
    expect(judgeCalls).toBe(0);
    expect(fake.putCalls).toBe(0); // hit path never re-writes the row
    expect(r.cacheHits).toBe(1);
    expect(r.reports[0].cached).toBe(true);
    expect(r.reports[0].worth).toBe(true);
    expect(r.byPath.get(t.filePath)?.score).toBe(0.8);
  });

  test('legacy boolean-era row (score null) is a MISS — re-judged and overwritten', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('legacy');
    seedVerdict(rows, t, { score: null, triage_version: null, model: null });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.7)));
    expect(r.judged).toBe(1);
    expect(r.cacheHits).toBe(0);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.7);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.triage_version).toBe(TRIAGE_VERSION);
  });

  test('model mismatch is a MISS — switching models re-judges (C8)', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('model-switch');
    seedVerdict(rows, t, { score: 0.9, model: 'anthropic:some-other-model' });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.3)));
    expect(r.judged).toBe(1);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.model).toBe(MODEL);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.3);
  });

  test('triage_version mismatch is a MISS', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('version-bump');
    seedVerdict(rows, t, { score: 0.9, triage_version: TRIAGE_VERSION + 1 });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.6)));
    expect(r.judged).toBe(1);
  });

  test('staleBefore treats older rows as misses; force ignores the cache entirely', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('stale');
    seedVerdict(rows, t, { score: 0.9, judged_at: '2020-01-01T00:00:00.000Z' });
    const stale = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.6), { staleBefore: new Date('2025-01-01') }));
    expect(stale.judged).toBe(1);
    // Fresh again now; force still re-judges.
    const forced = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.2), { force: true }));
    expect(forced.judged).toBe(1);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.2);
  });
});

describe('runTriagePass — gate + threshold', () => {
  test('>= threshold boundary: exactly-at passes, just-below does not', async () => {
    const { engine, rows } = makeFakeEngine();
    const at = makeTranscript('at');
    const below = makeTranscript('below');
    seedVerdict(rows, at, { score: 0.5 });
    seedVerdict(rows, below, { score: 0.4999 });
    const r = await runTriagePass(engine, [at, below], baseCfg(null, { threshold: 0.5 }));
    expect(r.reports.find(x => x.filePath === at.filePath)?.worth).toBe(true);
    expect(r.reports.find(x => x.filePath === below.filePath)?.worth).toBe(false);
  });

  test('threshold 0 gates everything judged in (a low score still passes)', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('zero');
    seedVerdict(rows, t, { score: 0 });
    const r = await runTriagePass(engine, [t], baseCfg(null, { threshold: 0 }));
    expect(r.reports[0].worth).toBe(true);
  });
});

describe('runTriagePass — time budget (1C) + shouldStop', () => {
  test('maxMs expiry defers remaining MISSES (uncached) while cache hits stay free', async () => {
    const { engine, rows } = makeFakeEngine();
    const miss1 = makeTranscript('m1');
    const miss2 = makeTranscript('m2');
    const miss3 = makeTranscript('m3');
    const hit = makeTranscript('hit');
    seedVerdict(rows, hit, { score: 0.9 });
    // Fake clock: each now() call advances 40ms; budget 100ms → the first
    // miss judges, later misses defer. concurrency 1 for determinism.
    let clock = 0;
    const now = (): number => { clock += 40; return clock; };
    const r = await runTriagePass(engine, [miss1, miss2, miss3, hit], baseCfg(scoredJudge(0.8), {
      concurrency: 1,
      maxMs: 100,
      now,
    }));
    expect(r.judged).toBeGreaterThanOrEqual(1);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect(r.cacheHits).toBe(1); // the hit is NEVER deferred
    const deferredReports = r.reports.filter(x => x.deferred);
    expect(deferredReports.length).toBe(r.deferred);
    for (const d of deferredReports) {
      expect(d.worth).toBe(false);
      expect(d.score).toBeNull();
      // Deferred files are NOT cached — next pass continues.
      expect([...rows.keys()].some(k => k.startsWith(d.filePath))).toBe(false);
    }
  });

  test('in-flight semantics: a judge call started inside the budget completes and IS cached', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('inflight');
    // Clock: 0 at start; stays 0 until the judge call BEGINS, then jumps past
    // the budget while the call is in flight. The pull happened inside the
    // budget, so the verdict must complete and be cached (no torn judgments).
    let clock = 0;
    const now = (): number => clock;
    const judge: JudgeClient = {
      create: async (p) => {
        clock = 10_000; // budget (500ms) expires mid-call
        return scoredJudge(0.7).create(p);
      },
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge, { maxMs: 500, now }));
    expect(r.judged).toBe(1);
    expect(r.deferred).toBe(0);
    expect(rows.size).toBe(1); // cached despite expiry mid-flight
  });

  test('CX3: shouldStop is ticked on UNRELIABLE judge attempts too (paid calls count)', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('u1'), makeTranscript('u2'), makeTranscript('u3')];
    let ticks = 0;
    // Judge always truncates — every attempt is unreliable but still paid.
    const judge: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text: '{"scor' }], stop_reason: 'max_tokens' } as never),
    };
    const r = await runTriagePass(engine, ts, baseCfg(judge, {
      concurrency: 1,
      shouldStop: () => { ticks++; return ticks >= 2; },
    }));
    expect(ticks).toBe(2);       // budget consumed by unreliable attempts
    expect(r.unreliable).toBe(2);
    expect(r.deferred).toBe(1);  // third file never pulled
  });

  test('shouldStop stops pulling new misses (retriage --max-usd seam)', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('s1'), makeTranscript('s2'), makeTranscript('s3'), makeTranscript('s4')];
    let judged = 0;
    const judge = scoredJudge(0.6);
    const counting: JudgeClient = { create: async (p) => { judged++; return judge.create(p); } };
    const r = await runTriagePass(engine, ts, baseCfg(counting, {
      concurrency: 1,
      shouldStop: () => judged >= 2,
    }));
    expect(r.judged).toBe(2);
    expect(r.deferred).toBe(2);
  });
});

describe('runTriagePass — degrade + failure contracts', () => {
  test('null judge (no provider) degrades per transcript; nothing cached; cache hits still served', async () => {
    const { engine, rows } = makeFakeEngine();
    const hit = makeTranscript('hit');
    const miss = makeTranscript('miss');
    seedVerdict(rows, hit, { score: 0.9 });
    const r = await runTriagePass(engine, [hit, miss], baseCfg(null));
    expect(r.cacheHits).toBe(1);
    const missReport = r.reports.find(x => x.filePath === miss.filePath)!;
    expect(missReport.worth).toBe(false);
    expect(missReport.reasons[0]).toContain('no configured provider');
    expect(rows.size).toBe(1); // only the seed
  });

  test('AIConfigError degrades per transcript (gateway error reason), pass continues', async () => {
    const { engine } = makeFakeEngine();
    const bad = makeTranscript('bad');
    const good = makeTranscript('good');
    let call = 0;
    const judge: JudgeClient = {
      create: async (p) => {
        call++;
        if (call === 1) throw new AIConfigError('simulated revoked key');
        return scoredJudge(0.8).create(p);
      },
    };
    const r = await runTriagePass(engine, [bad, good], baseCfg(judge, { concurrency: 1 }));
    expect(r.reports[0].reasons[0]).toContain('gateway error');
    expect(r.reports[1].score).toBe(0.8);
  });

  test('hard (non-AIConfig) error aborts new pulls and rethrows — phase fails', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('h1'), makeTranscript('h2'), makeTranscript('h3')];
    const judge: JudgeClient = { create: async () => { throw new Error('database on fire'); } };
    await expect(runTriagePass(engine, ts, baseCfg(judge, { concurrency: 1 }))).rejects.toThrow('database on fire');
  });

  test('unreliable judgments are reported but never cached', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('trunc');
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: '{"scor' }],
        stop_reason: 'max_tokens',
      } as never),
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge));
    expect(r.unreliable).toBe(1);
    expect(r.reports[0].unreliable).toBe('truncated');
    expect(rows.size).toBe(0);
    expect(r.byPath.has(t.filePath)).toBe(false);
  });
});

describe('runTriagePass — pool + reports + lock tick', () => {
  test('reports are index-stable in discovery order regardless of concurrency', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 9 }, (_, i) => makeTranscript(`ord${i}`));
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 4 }));
    expect(r.reports.map(x => x.filePath)).toEqual(ts.map(t => t.filePath));
  });

  test('yieldDuringPhase ticks are coarse: at most one per 30s window (C11)', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 6 }, (_, i) => makeTranscript(`tick${i}`));
    let ticks = 0;
    // Fake clock advances 10s per now() call — several items settle inside
    // each 30s window, so ticks must be well below the item count.
    let clock = 0;
    const now = (): number => { clock += 10_000; return clock; };
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 1, now }), async () => { ticks++; });
    expect(r.judged).toBe(6);
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(6);
  });

  test('yieldDuringPhase throwing is swallowed (best-effort)', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 3 }, (_, i) => makeTranscript(`yt${i}`));
    let clock = 0;
    const now = (): number => { clock += 40_000; return clock; };
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 1, now }),
      async () => { throw new Error('tick boom'); });
    expect(r.judged).toBe(3);
  });
});

describe('buildTriageMapBlock', () => {
  const verdict = {
    score: 0.82,
    content_type: 'reflection',
    segments: [
      { quote: 'the future of memory is a database that dreams', note: 'thesis' },
      { quote: 'we should charge for durability not storage', note: 'pricing frame' },
    ],
    entities: ['acme-example', 'fund-a'],
  };

  test('empty for undefined verdict and for legacy (score null) — prompt stays byte-identical', () => {
    expect(buildTriageMapBlock(undefined, 'text', 1)).toBe('');
    expect(buildTriageMapBlock({ score: null, content_type: null, segments: [], entities: [] }, 'text', 1)).toBe('');
  });

  test('single-chunk block carries score, type, entities, and verbatim-verified segments', () => {
    // The presence filter applies to EVERY chunk count (fabricated quotes are
    // dropped), so the chunk text must actually contain the quotes.
    const fullText = 'intro… the future of memory is a database that dreams. later: '
      + 'we should charge for durability not storage. outro.';
    const block = buildTriageMapBlock(verdict, fullText, 1);
    expect(block).toContain('TRIAGE MAP');
    expect(block).toContain('signal score: 0.82');
    expect(block).toContain('content type: reflection');
    expect(block).toContain('acme-example, fund-a');
    expect(block).toContain('database that dreams');
    expect(block).toContain('charge for durability');
    expect(block).not.toContain('bounded sample');
    expect(block).toContain('Work from the candidate segments first');
  });

  test('fabricated quotes are dropped even for single-chunk transcripts (security)', () => {
    const block = buildTriageMapBlock(verdict, 'text that contains neither quote', 1);
    expect(block).not.toContain('database that dreams');
    expect(block).not.toContain('charge for durability');
    // Score/type/entities still ride (they are advisory labels, not quotes).
    expect(block).toContain('signal score: 0.82');
  });

  test('chunked: segments filter to those whose quote prefix appears in THIS chunk + caveat line', () => {
    const chunkWithFirst = 'blah blah the future of memory is a database that dreams blah';
    const block = buildTriageMapBlock(verdict, chunkWithFirst, 3);
    expect(block).toContain('database that dreams');
    expect(block).not.toContain('charge for durability');
    expect(block).toContain('bounded sample of the full transcript');
  });

  test('whitespace-normalized matching: quote with collapsed spacing still matches', () => {
    const chunk = 'x  the   future\nof memory   is a database    that dreams y';
    const block = buildTriageMapBlock(verdict, chunk, 2);
    expect(block).toContain('database that dreams');
  });

  test('size bound: worst-case block stays bounded', () => {
    const segments = Array.from({ length: 8 }, (_, i) => ({ quote: `q${i} ` + 'x'.repeat(300), note: 'n'.repeat(200) }));
    const fat = {
      score: 0.99,
      content_type: 'mixed',
      segments,
      entities: Array.from({ length: 12 }, (_, i) => `entity-${i}-` + 'e'.repeat(70)),
    };
    // Chunk text contains every quote so the presence filter keeps all 8.
    const chunkText = segments.map(s => s.quote).join(' ');
    const block = buildTriageMapBlock(fat, chunkText, 1);
    expect(block).toContain('q7 ');
    expect(block.length).toBeLessThan(6000); // clipped upstream at judge-parse time; this is the structural bound
  });
});

describe('dreamInlineQueueAgeMs (CX1 liveness)', () => {
  test('parses the embedded timestamp; null outside the grammar', () => {
    expect(dreamInlineQueueAgeMs('dream-inline-1700000000000-deadbeef', 1700000001000)).toBe(1000);
    expect(dreamInlineQueueAgeMs('dream-inline-not-a-ts-deadbeef', 1)).toBeNull();
    expect(dreamInlineQueueAgeMs('default', 1)).toBeNull();
    expect(dreamInlineQueueAgeMs('dream-inline-1700000000000-NOTHEX!', 1)).toBeNull();
  });

  test('grace boundary: a fresh queue is within the liveness grace; an old one is past it', () => {
    const nowMs = 1_800_000_000_000;
    const young = `dream-inline-${nowMs - 60_000}-abcd1234`;
    const old = `dream-inline-${nowMs - DREAM_INLINE_LIVE_GRACE_MS - 60_000}-abcd1234`;
    expect(dreamInlineQueueAgeMs(young, nowMs)! <= DREAM_INLINE_LIVE_GRACE_MS).toBe(true);
    expect(dreamInlineQueueAgeMs(old, nowMs)! > DREAM_INLINE_LIVE_GRACE_MS).toBe(true);
  });
});

describe('parseSynthV2Key', () => {
  test('single-chunk key round-trips source + basename + hash16', () => {
    const k = parseSynthV2Key('dream:synth-v2:my-source:filename:2026-05-01-session.txt:0123456789abcdef');
    expect(k).toEqual({ source: 'my-source', basename: '2026-05-01-session.txt', hash16: '0123456789abcdef' });
  });

  test('chunked key carries chunk index + total', () => {
    const k = parseSynthV2Key('dream:synth-v2:default:filename:fat.txt:0123456789abcdef:c2of5');
    expect(k?.chunk).toEqual({ i: 2, n: 5 });
  });

  test('percent-encoded basename decodes (spaces, unicode)', () => {
    const enc = encodeURIComponent('весёлый файл (1).txt');
    const k = parseSynthV2Key(`dream:synth-v2:default:filename:${enc}:0123456789abcdef`);
    expect(k?.basename).toBe('весёлый файл (1).txt');
  });

  test('null on: legacy v1 keys, malformed hash, malformed encoding, foreign keys', () => {
    expect(parseSynthV2Key('dream:synth:/abs/path.txt:0123456789abcdef')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:x.txt:SHORT')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:%E0%A4%A:0123456789abcdef')).toBeNull();
    expect(parseSynthV2Key('embed-backfill:source:x')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:x.txt:0123456789abcdef:c1of')).toBeNull();
  });
});
