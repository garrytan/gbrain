import { describe, it, expect } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  jaccardAtK,
  topKHit,
  readFixture,
  HIT_RATE_THRESHOLD,
  REGRESSION_THRESHOLD,
  MIN_REPLAY_ROWS,
  type FixtureRow,
} from '../src/commands/eval-whoknows.ts';

/**
 * v0.33 eval harness unit tests — pure functions only.
 *
 * Integration coverage (real engine, fixture grading end-to-end) lives in
 * test/e2e/whoknows.test.ts. This file verifies the math and the parser.
 */

describe('eval-whoknows / jaccardAtK', () => {
  it('identical 3-element sets → 1.0', () => {
    expect(jaccardAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 3)).toBeCloseTo(1.0, 5);
  });

  it('disjoint sets → 0', () => {
    expect(jaccardAtK(['a', 'b', 'c'], ['x', 'y', 'z'], 3)).toBe(0);
  });

  it('partial overlap (2 of 3 match) → 2/4 = 0.5', () => {
    expect(jaccardAtK(['a', 'b', 'c'], ['a', 'b', 'z'], 3)).toBeCloseTo(0.5, 5);
  });

  it('respects k cutoff — ignores beyond top-k', () => {
    expect(jaccardAtK(['a', 'b', 'x'], ['a', 'b', 'y'], 2)).toBeCloseTo(1.0, 5);
  });

  it('empty both sets → 1.0 (vacuously stable)', () => {
    expect(jaccardAtK([], [], 3)).toBe(1);
  });

  it('empty one side, non-empty other → 0', () => {
    expect(jaccardAtK([], ['a', 'b', 'c'], 3)).toBe(0);
  });

  it('duplicates in input collapse via Set semantics', () => {
    // Set-Jaccard, not multiset — duplicates collapse.
    expect(jaccardAtK(['a', 'a', 'a'], ['a'], 3)).toBe(1);
  });
});

describe('eval-whoknows / topKHit', () => {
  it('expected slug at position 1 → hit', () => {
    expect(topKHit(['alice', 'bob', 'carol'], ['alice'], 3)).toBe(true);
  });

  it('expected slug at position 3 → hit (within top-3)', () => {
    expect(topKHit(['x', 'y', 'alice'], ['alice'], 3)).toBe(true);
  });

  it('expected slug at position 4 → miss (beyond top-3)', () => {
    expect(topKHit(['x', 'y', 'z', 'alice'], ['alice'], 3)).toBe(false);
  });

  it('no expected match anywhere → miss', () => {
    expect(topKHit(['x', 'y', 'z'], ['alice'], 3)).toBe(false);
  });

  it('multiple expected slugs — hit if ANY appears in top-3', () => {
    expect(topKHit(['x', 'bob', 'z'], ['alice', 'bob', 'carol'], 3)).toBe(true);
  });

  it('empty actual results → miss', () => {
    expect(topKHit([], ['alice'], 3)).toBe(false);
  });

  it('empty expected → miss (cannot match anything)', () => {
    expect(topKHit(['alice', 'bob'], [], 3)).toBe(false);
  });
});

describe('eval-whoknows / readFixture', () => {
  function tmpFixture(content: string): string {
    const path = join(tmpdir(), `whoknows-eval-test-${Date.now()}-${Math.random()}.jsonl`);
    writeFileSync(path, content);
    return path;
  }

  it('parses well-formed JSONL', () => {
    const path = tmpFixture(
      '{"query":"lab automation","expected_top_3_slugs":["wiki/people/alice","wiki/people/bob"]}\n' +
        '{"query":"fintech","expected_top_3_slugs":["wiki/companies/acme"],"notes":"hot topic"}\n',
    );
    try {
      const rows = readFixture(path);
      expect(rows.length).toBe(2);
      expect(rows[0].query).toBe('lab automation');
      expect(rows[0].expected_top_3_slugs.length).toBe(2);
      expect(rows[1].notes).toBe('hot topic');
    } finally {
      unlinkSync(path);
    }
  });

  it('skips blank lines and comments (#, //)', () => {
    const path = tmpFixture(
      '# this is a comment\n' +
        '\n' +
        '// another comment\n' +
        '{"query":"x","expected_top_3_slugs":["y"]}\n',
    );
    try {
      const rows = readFixture(path);
      expect(rows.length).toBe(1);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws on missing file', () => {
    expect(() => readFixture('/nonexistent/path/abc.jsonl')).toThrow(/fixture not found/);
  });

  it('throws on malformed JSON line', () => {
    const path = tmpFixture('{not json\n');
    try {
      expect(() => readFixture(path)).toThrow(/malformed JSONL line/);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws on row missing required fields', () => {
    const path = tmpFixture('{"query":"x"}\n'); // missing expected_top_3_slugs
    try {
      expect(() => readFixture(path)).toThrow(/missing required fields/);
    } finally {
      unlinkSync(path);
    }
  });

  it('filters non-string entries in expected_top_3_slugs', () => {
    const path = tmpFixture(
      '{"query":"x","expected_top_3_slugs":["alice", null, 42, "bob"]}\n',
    );
    try {
      const rows = readFixture(path);
      expect(rows[0].expected_top_3_slugs).toEqual(['alice', 'bob']);
    } finally {
      unlinkSync(path);
    }
  });
});

describe('eval-whoknows / thresholds', () => {
  it('HIT_RATE_THRESHOLD locked at 0.8 per ENG-D2', () => {
    expect(HIT_RATE_THRESHOLD).toBe(0.8);
  });

  it('REGRESSION_THRESHOLD locked at 0.4 per ENG-D2', () => {
    expect(REGRESSION_THRESHOLD).toBe(0.4);
  });

  it('MIN_REPLAY_ROWS sparseness fallback at 20', () => {
    expect(MIN_REPLAY_ROWS).toBe(20);
  });
});
