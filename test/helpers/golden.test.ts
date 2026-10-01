import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'os';
import {
  defineNormalizer,
  expectNormalizerStable,
  mapStrings,
  scrubDurations,
  scrubKeys,
  scrubPaths,
  scrubTimestamps,
  sortKeysDeep,
  stableStringify,
} from './golden.ts';

describe('golden harness', () => {
  test('stableStringify sorts keys recursively, keeps array order, sorts Sets, renders Maps', () => {
    const text = stableStringify({ b: 1, a: [3, 1], s: new Set(['z', 'a']), m: new Map([['y', 1], ['x', 2]]) });
    expect(text).toBe(
      JSON.stringify({ a: [3, 1], b: 1, m: { x: 2, y: 1 }, s: ['a', 'z'] }, null, 2) + '\n',
    );
    expect(sortKeysDeep(10n)).toBe('10n');
  });

  test('scrubbers replace volatile text', () => {
    expect(scrubTimestamps('at 2026-09-30T12:00:01.123Z ok')).toBe('at <ts> ok');
    expect(scrubDurations('took 12ms and 1.5s')).toBe('took <dur> and <dur>');
    expect(scrubPaths(`${tmpdir()}/x/y and /home/me/brain/z`, { '<brain>': '/home/me/brain' })).toBe('<tmp>/x/y and <brain>/z');
    expect(scrubKeys({ a: 1, took_ms: 5, n: { duration: 3 } }, /_ms$|^duration$/)).toEqual({
      a: 1,
      took_ms: '<volatile>',
      n: { duration: '<volatile>' },
    });
    expect(mapStrings({ a: ['x1'] }, (s) => s.toUpperCase())).toEqual({ a: ['X1'] });
  });

  test('expectNormalizerStable passes for a stable normalizer and fails for an unstable capture', async () => {
    let n = 0;
    const scrub = defineNormalizer('test-ts', (v: { at: string }) => ({ at: scrubTimestamps(v.at) }));
    await expectNormalizerStable(() => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString() }), scrub);
    const identity = defineNormalizer('identity', (v: { n: number }) => v);
    let threw = false;
    try {
      await expectNormalizerStable(() => ({ n: n++ }), identity);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
