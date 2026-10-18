/**
 * The per-request stage-timing collector (src/core/search/stage-timings.ts):
 * critical-path attribution, nesting, overlapped work, integer apportioning,
 * the --explain line, and that timing never serializes concurrent work.
 */
import { describe, expect, test } from 'bun:test';
import { SearchTimings, UNTIMED, formatTimingsSummary } from '../../src/core/search/stage-timings.ts';
import { formatResultsExplain } from '../../src/core/search/explain-formatter.ts';

/** A manual clock: `tick(ms)` advances it. */
function manualClock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('SearchTimings attribution', () => {
  test('each moment goes to the current stage; untimed time is other; total is the whole span', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    c.tick(3);
    await t.stage('setup', async () => { c.tick(5); });
    c.tick(2);
    await t.stage('lexical', async () => { c.tick(10); });
    await t.stage('response', async () => { c.tick(4); });
    c.tick(1);
    expect(t.snapshot()).toEqual({ total_ms: 25, stages_ms: { setup: 5, lexical: 10, response: 4 }, other_ms: 6 });
  });

  test('a nested stage takes the clock and hands it back: a nested hybrid call is booked once', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    await t.stage('alias_fanout', async () => {
      c.tick(2);
      await t.stage('lexical', async () => { c.tick(7); });
      await t.stage('vector', async () => { c.tick(5); });
      c.tick(1);
    });
    const s = t.snapshot();
    expect(s.stages_ms).toEqual({ alias_fanout: 3, lexical: 7, vector: 5 });
    expect(sum(s.stages_ms) + s.other_ms).toBe(s.total_ms);
  });

  test('repeated stages (retries, a discarded escalation) accumulate', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    for (const ms of [4, 6]) await t.stage('lexical', async () => { c.tick(ms); });
    expect(t.snapshot().stages_ms.lexical).toBe(10);
  });

  test('a stage that throws still ends, and its time stays booked', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    await expect(t.stage('rerank', async () => { c.tick(8); throw new Error('provider down'); })).rejects.toThrow('provider down');
    c.tick(2);
    expect(t.snapshot()).toEqual({ total_ms: 10, stages_ms: { rerank: 8 }, other_ms: 2 });
  });

  test('a stage that ran in under a millisecond is reported as 0, not dropped', async () => {
    const t = new SearchTimings(manualClock().now);
    await t.stage('relational', async () => {});
    expect(t.snapshot().stages_ms).toEqual({ relational: 0 });
  });

  test('a snapshot inside a stage counts the stage so far', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    let inner: ReturnType<SearchTimings['snapshot']> | undefined;
    await t.stage('response', async () => { c.tick(6); inner = t.snapshot(); });
    expect(inner).toEqual({ total_ms: 6, stages_ms: { response: 6 }, other_ms: 0 });
  });

  test('overlapped work is reported per label and never added to a stage or the total', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    await t.stage('lexical', async () => {
      const a = t.overlap('keyword_arm', (async () => { await sleep(0); c.tick(9); })());
      const b = t.overlap('title_arm', Promise.reject(new Error('arm failed')).catch(() => undefined));
      await Promise.all([a, b]);
    });
    const s = t.snapshot();
    expect(s.stages_ms).toEqual({ lexical: 9 });
    expect(s.total_ms).toBe(9);
    expect(s.overlapped_ms).toEqual({ keyword_arm: 9, title_arm: 0 });
  });

  test('a rejected overlapped promise rejects to its caller and is still timed', async () => {
    const t = new SearchTimings();
    const failing = Promise.reject(new Error('boom'));
    await expect(t.overlap('keyword_arm', failing)).rejects.toThrow('boom');
    expect(t.snapshot().overlapped_ms).toHaveProperty('keyword_arm');
  });
});

describe('integer apportioning', () => {
  test('fractional stages round so stages + other sum to total exactly, and other is never negative', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    for (const stage of ['setup', 'lexical', 'vector', 'fuse', 'rerank'] as const) {
      await t.stage(stage, async () => { c.tick(0.4); });
      c.tick(0.05);
    }
    const s = t.snapshot();
    expect(s.total_ms).toBe(2);
    expect(sum(s.stages_ms) + s.other_ms).toBe(s.total_ms);
    expect(s.other_ms).toBeGreaterThanOrEqual(0);
    for (const ms of Object.values(s.stages_ms)) expect(Number.isInteger(ms) && ms >= 0 && ms <= 1).toBe(true);
  });
});

describe('timing never serializes execution', () => {
  test('two delayed overlapping works inside one stage finish in one delay, not two', async () => {
    const t = new SearchTimings();
    const started = performance.now();
    await t.stage('lexical', () => Promise.all([
      t.overlap('keyword_arm', sleep(150)),
      t.overlap('title_arm', sleep(150)),
    ]));
    const wall = performance.now() - started;
    const s = t.snapshot();
    expect(wall).toBeLessThan(270);
    expect(s.stages_ms.lexical).toBeGreaterThanOrEqual(145);
    expect(s.stages_ms.lexical).toBeLessThan(270);
    expect(s.overlapped_ms!.keyword_arm).toBeGreaterThanOrEqual(145);
    expect(s.overlapped_ms!.title_arm).toBeGreaterThanOrEqual(145);
    expect(s.total_ms).toBeLessThan(s.overlapped_ms!.keyword_arm + s.overlapped_ms!.title_arm);
  });

  test('a branch runs alongside: overlapped until joined, then the wait is booked to its current stage', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    const b = t.branch();
    const gates = [0, 1, 2].map(() => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; });
    const side = (async () => {
      await b.stage('expansion', () => gates[0].p);
      await b.stage('embed', () => gates[1].p);
      await b.stage('vector', () => gates[2].p);
      return 'side';
    })();
    await t.stage('lexical', async () => {
      c.tick(30);
      gates[0].open();
      await sleep(0);
      c.tick(10);
    });
    const joined = t.join(b, side);
    c.tick(15);
    gates[1].open();
    await sleep(0);
    c.tick(8);
    gates[2].open();
    expect(await joined).toBe('side');
    await t.stage('fuse', async () => { c.tick(2); });
    const s = t.snapshot();
    expect(s.overlapped_ms).toEqual({ expansion: 30, embed: 10 });
    expect(s.stages_ms).toEqual({ expansion: 0, embed: 15, vector: 8, lexical: 40, fuse: 2 });
    expect(s.other_ms).toBe(0);
    expect(s.total_ms).toBe(65);
  });

  test('a branch that finished before the join books nothing to the critical path but keeps its stage keys', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    const b = t.branch();
    const side = b.stage('embed', async () => { c.tick(12); return 1; });
    await side;
    await t.stage('lexical', async () => { c.tick(30); });
    await t.join(b, side);
    const s = t.snapshot();
    expect(s.stages_ms).toEqual({ embed: 0, lexical: 30 });
    expect(s.overlapped_ms).toEqual({ embed: 12 });
    expect(s.total_ms).toBe(42);
    expect(s.other_ms).toBe(12);
  });

  test('a join inside a stage hands the clock back to that stage, also between branch stages', async () => {
    const c = manualClock();
    const t = new SearchTimings(c.now);
    await t.stage('alias_fanout', async () => {
      const b = t.branch();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const side = (async () => { await gate; c.tick(3); await b.stage('embed', async () => { c.tick(9); }); })();
      const joined = t.join(b, side);
      release();
      await joined;
      c.tick(1);
    });
    expect(t.snapshot().stages_ms).toEqual({ alias_fanout: 4, embed: 9 });
  });

  test("the untimed timer's branch and join pass work straight through", async () => {
    const b = UNTIMED.branch();
    expect(await UNTIMED.join(b, b.stage('embed', async () => 7))).toBe(7);
  });

  test('the untimed timer passes work straight through', async () => {
    const p = Promise.resolve(7);
    expect(UNTIMED.overlap('keyword_arm', p)).toBe(p);
    expect(await UNTIMED.stage('lexical', async () => 8)).toBe(8);
  });
});

describe('--explain line', () => {
  const timings = { total_ms: 142, stages_ms: { setup: 3, lexical: 12, embed: 30, response: 4 }, other_ms: 2, overlapped_ms: { keyword_arm: 11, title_arm: 9 } };

  test('formatTimingsSummary names every stage, other, and the overlapped arms', () => {
    expect(formatTimingsSummary(timings)).toBe('timings: 142ms total — setup 3, lexical 12, embed 30, response 4, other 2 (overlapped: keyword_arm 11, title_arm 9)');
    expect(formatTimingsSummary(undefined)).toBeNull();
  });

  test('formatResultsExplain prints the timings line in its header', () => {
    const out = formatResultsExplain([{ slug: 'notes/a', score: 1, chunk_text: 'x' } as never], { vector_enabled: false, expansion_applied: false, detail_resolved: null, timings } as never);
    expect(out.split('\n')).toContain(formatTimingsSummary(timings)!);
  });
});
