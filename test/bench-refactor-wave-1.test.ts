/**
 * Pure helpers of scripts/bench-refactor-wave-1.ts (T-G15 perf bench). The
 * import also brings the script under `bun run typecheck`, whose tsconfig
 * includes only src/ and test/. The bench itself never runs here.
 */
import { describe, expect, test } from 'bun:test';
import {
  PgFrontendCounter, benchQueries, buildCorpus, percentile, stubVector, summarize,
} from '../scripts/bench-refactor-wave-1.ts';

function message(type: string, body: number[] = []): number[] {
  const len = body.length + 4;
  return [type.charCodeAt(0), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body];
}

function untyped(code: number, extra: number[] = []): number[] {
  const len = 8 + extra.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    (code >>> 24) & 255, (code >>> 16) & 255, (code >>> 8) & 255, code & 255, ...extra];
}

describe('bench statistics', () => {
  test('nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(summarize([3, 1, 2])).toEqual({ n: 3, min: 1, median: 2, p95: 3, max: 3, mean: 2 });
  });
});

describe('PgFrontendCounter', () => {
  test('skips SSLRequest + StartupMessage and counts Sync/Query as round trips across split chunks', () => {
    const stream = new Uint8Array([
      ...untyped(80877103),
      ...untyped(196608, [117, 115, 101, 114, 0, 120, 0, 0]),
      ...message('P', [0, 0, 0, 0]), ...message('D', [83, 0]), ...message('S'),
      ...message('B', [0, 0, 0, 0, 0, 0, 0]), ...message('E', [0, 0, 0, 0, 0]), ...message('S'),
      ...message('Q', [83, 69, 76, 69, 67, 84, 0]),
    ]);
    const counter = new PgFrontendCounter();
    for (let i = 0; i < stream.length; i += 3) counter.feed(stream.slice(i, i + 3));
    expect(counter.counts).toEqual({ roundTrips: 3, parses: 1, messages: 7 });
  });

  test('typed-only mode (PGLite protocol batches)', () => {
    const counter = new PgFrontendCounter(false);
    counter.feed(new Uint8Array([...message('P', [0, 0, 0, 0]), ...message('S')]));
    expect(counter.counts).toEqual({ roundTrips: 1, parses: 1, messages: 2 });
  });
});

describe('deterministic fixtures', () => {
  test('stub vectors are unit-length and text-determined', () => {
    const a = stubVector('alpha', 16);
    expect(stubVector('alpha', 16)).toEqual(a);
    expect(stubVector('beta', 16)).not.toEqual(a);
    expect(Math.abs(Math.sqrt(a.reduce((s, v) => s + v * v, 0)) - 1)).toBeLessThan(1e-9);
  });

  test('corpus and queries are fixed', () => {
    const corpus = buildCorpus(3, 2);
    expect(corpus.map(p => p.slug)).toEqual(['bench/topic-0000', 'bench/topic-0001', 'bench/topic-0002']);
    expect(buildCorpus(3, 2)).toEqual(corpus);
    expect(benchQueries(20)).toEqual(benchQueries(20));
    expect(new Set(benchQueries(20)).size).toBeGreaterThan(15);
  });
});
