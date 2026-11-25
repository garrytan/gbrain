import { describe, expect, test } from 'bun:test';
import { acceptBaseline, BAR_MS, checkArm, combine, failureMessage, missingBaseline, RELEASE_PAGES, summarize, type Baseline, type Call, type Config } from '../../scripts/bench/production-soak/search-gate.ts';
import { SOAK_SHAPE } from '../../scripts/stable-daily.ts';

const calls = (ms: number[], meta = 0): Call[] => ms.map(m => ({ ms: m, timings: { stages_ms: { rerank: 300, response: meta + 30 }, parts_ms: { response: { meta, evidence: 30 } } } }));
const base: Baseline = { version: '0.60.722.0', run_url: null, arms: [{ jit: 'off', p50_ms: 1007, p95_ms: 1300 }, { jit: 'on', p50_ms: 1100, p95_ms: 1400 }] };

describe('production soak search speed gate', () => {
  test('a reading reports p50, p95, failed calls and the slowest timed part', () => {
    const r = summarize([...calls([900, 1000, 1100, 3000], 2300), { ms: 5, error: 'boom' }], 'off');
    expect(r).toMatchObject({ n: 5, errors: 1, p50_ms: 1050, server_jit: 'off' });
    expect(r.p95_ms).toBeGreaterThan(2000);
    expect(r.slowest).toEqual({ part: 'response.meta', p50_ms: 2300 });
  });

  test('the v0.60.723-759 shape fails the fixed bars and the regression bar; the fixed shape passes both', () => {
    const slow = summarize(calls(Array.from({ length: 60 }, (_, i) => 3100 + i)), 'off');
    const failed = checkArm({ jit: 'off', ...slow }, base).filter(c => !c.pass).map(c => c.id);
    expect(failed).toEqual(['p50', 'p95', 'p50_vs_last_release', 'p95_vs_last_release']);
    const fixed = summarize(calls(Array.from({ length: 60 }, (_, i) => (i < 54 ? 960 + i : 1950))), 'off');
    expect(checkArm({ jit: 'off', ...fixed }, base).every(c => c.pass)).toBe(true);
  });

  test('the regression bar needs both the ratio and the absolute floor, so small brains and noise pass', () => {
    const r = summarize(calls(Array.from({ length: 60 }, () => 1450)), 'off');
    expect(checkArm({ jit: 'off', ...r }, base).find(c => c.id === 'p50_vs_last_release')).toMatchObject({ pass: true, limit: 1511 });
    const tiny: Baseline = { ...base, arms: [{ jit: 'off', p50_ms: 100, p95_ms: 150 }] };
    expect(checkArm({ jit: 'off', ...summarize(calls([300, 300, 300]), 'off') }, tiny).every(c => c.pass)).toBe(true);
    expect(checkArm({ jit: 'off', ...summarize(calls([400, 400, 400]), 'off') }, tiny).find(c => c.id === 'p50_vs_last_release')!.pass).toBe(false);
  });

  test('p95 has its own 3 s bar: a 2.2 s tail passes, a 3.1 s tail fails', () => {
    const tail = (ms: number) => summarize(calls(Array.from({ length: 60 }, (_, i) => (i < 54 ? 1000 : ms))), 'off');
    expect(checkArm({ jit: 'off', ...tail(2200) }, null).every(c => c.pass)).toBe(true);
    expect(checkArm({ jit: 'off', ...tail(3100) }, null).filter(c => !c.pass).map(c => c.id)).toEqual(['p95']);
  });

  test('a failed search, an empty reading or a server that ignored the JIT setting fails the arm', () => {
    const r = summarize([...calls([900, 900]), { ms: 3, error: 'x' }], 'on');
    expect(checkArm({ jit: 'off', ...r }, null).filter(c => !c.pass).map(c => c.id)).toEqual(['server_jit', 'errors']);
    expect(checkArm({ jit: 'on', ...summarize([], 'on') }, null).filter(c => !c.pass).map(c => c.id)).toEqual(['errors', 'p50', 'p95']);
  });

  test('a passing second reading is kept whole, so one noisy reading cannot fail a release', () => {
    const noisy = summarize(calls(Array.from({ length: 60 }, (_, i) => (i > 50 ? 3600 : 1200))), 'on');
    const clean = summarize(calls(Array.from({ length: 60 }, () => 1250)), 'on');
    const arm = combine('on', [noisy, clean], null);
    expect(arm).toMatchObject({ p50_ms: 1250, p95_ms: 1250, errors: 0 });
    expect(checkArm(arm, null).every(c => c.pass)).toBe(true);
    expect(arm.readings).toHaveLength(2);
  });

  test('two failing readings cannot pass by mixing one reading\'s error count with the other\'s latency', () => {
    const fastWithErrors = summarize([...calls(Array(55).fill(900)), ...Array.from({ length: 5 }, () => ({ ms: 5, error: 'x' }))], 'on');
    const slowClean = summarize(calls(Array(60).fill(2500)), 'on');
    const arm = combine('on', [fastWithErrors, slowClean], null);
    expect(checkArm(arm, null).every(c => c.pass)).toBe(false);
    expect(arm.errors === 5 ? arm.p50_ms : arm.errors).toBe(900);
  });

  test('an unreadable earlier result or a non-release fixture holds the gate instead of silently dropping the regression check', () => {
    const config: Config = { fixture_pages: RELEASE_PAGES, rtt_ms: 2, n: 60, warmup: 5, embed_ms: 200, rerank_ms: 300, parked: 9400 };
    expect(RELEASE_PAGES).toBe(SOAK_SHAPE.pages);
    expect(missingBaseline([], config)).toEqual({ baseline: null, lookup: 'none' });
    const failed = missingBaseline(['v0.60.760.0 download failed (HTTP 403: API rate limit exceeded)'], config);
    expect(failed.lookup).toBe('failed');
    expect(failed.detail).toContain('API rate limit exceeded');
    expect(missingBaseline([], { ...config, fixture_pages: 800_000 }).lookup).toBe('failed');
    const arm = combine('off', [summarize(calls(Array(60).fill(1000)), 'off')], null);
    const checks = checkArm(arm, null, failed.detail);
    expect(checks.filter(c => !c.pass).map(c => c.id)).toEqual(['baseline']);
    const msg = failureMessage(arm, checks, 2, 601_357, null);
    expect(msg).toContain('could not be compared with the last release');
    expect(msg).toContain('API rate limit exceeded');
    expect(msg).toContain('held from stable until the check runs');
    expect(msg).toContain('search_gate_override');
    expect(msg).not.toContain('too slow');
  });

  test('only a passing, unoverridden result on the same fixture size and probe becomes the baseline', () => {
    const config: Config = { fixture_pages: 600_000, rtt_ms: 2, n: 60, warmup: 5, embed_ms: 200, rerank_ms: 300, parked: 9400 };
    const g = { pass: true, override: null, config, arms: base.arms };
    expect(acceptBaseline(g, 'v0.60.760.0', 'u', config)).toEqual({ version: '0.60.760.0', run_url: 'u', arms: base.arms });
    expect(acceptBaseline({ ...g, pass: false }, 'v1', null, config)).toBeNull();
    expect(acceptBaseline({ ...g, override: { reason: 'noise' } }, 'v1', null, config)).toBeNull();
    expect(acceptBaseline({ ...g, config: { ...config, fixture_pages: 20_000 } }, 'v1', null, config)).toBeNull();
    expect(acceptBaseline({ ...g, config: { ...config, n: 10 } }, 'v1', null, config)).toBeNull();
  });

  test('the failure message names the numbers, the slowest part, the hold and the override', () => {
    const arm = combine('on', [summarize(calls(Array.from({ length: 60 }, () => 3800), 3027), 'on')], null);
    const msg = failureMessage(arm, checkArm(arm, null), 2, 601_357, null);
    expect(msg).toContain('601k-page brain at 2 ms RTT with Postgres JIT on');
    expect(msg).toContain('p50 3,800 ms, bar under ' + BAR_MS.p50.toLocaleString('en-US') + ' ms');
    expect(msg).toContain('p95 3,800 ms, bar under ' + BAR_MS.p95.toLocaleString('en-US') + ' ms');
    expect(msg).toContain('Slowest timed part: response.meta at 3,027 ms');
    expect(msg).toContain('held from stable');
    expect(msg).toContain('search_gate_override');
    const recorded = failureMessage(arm, checkArm(arm, null), 65, 601_357, null, false);
    expect(recorded).not.toContain('held from stable');
    expect(recorded).toContain('Not blocking this run');
  });
});
