// v0.39 T16 — aggregator unit test.
// Pins the pass-criterion codex finding #9 demanded: filing accuracy
// delta is the gate, NOT manifest correctness.

import { describe, test, expect } from 'bun:test';
import { aggregateVerdict, parseArgs } from '../src/commands/eval-schema-authoring.ts';

describe('v0.39 T16 — eval-schema-authoring aggregator', () => {
  test('pass when baseline already high + no suggestions needed', () => {
    const v = aggregateVerdict(0.95, 0.95, 0, 0);
    expect(v.verdict).toBe('pass');
  });

  test('pass when filing accuracy improves >=10pp', () => {
    const v = aggregateVerdict(0.4, 0.6, 5, 1);
    expect(v.verdict).toBe('pass');
    expect(v.delta).toBeCloseTo(0.2, 2);
  });

  test('inconclusive when delta improvement is <10pp', () => {
    const v = aggregateVerdict(0.6, 0.65, 3, 0);
    expect(v.verdict).toBe('inconclusive');
  });

  test('inconclusive when baseline is low but no suggestions returned', () => {
    const v = aggregateVerdict(0.4, 0.4, 0, 0);
    expect(v.verdict).toBe('inconclusive');
  });

  test('fail when filing accuracy regresses', () => {
    const v = aggregateVerdict(0.7, 0.55, 5, 3);
    expect(v.verdict).toBe('fail');
    expect(v.reasoning).toContain('REGRESSED');
  });

  test('parseArgs --fixture + --source + --json', () => {
    const a = parseArgs(['--fixture', '/tmp/brain', '--source', 'dept-x', '--json']);
    expect(a.fixture).toBe('/tmp/brain');
    expect(a.source).toBe('dept-x');
    expect(a.json).toBe(true);
  });

  test('parseArgs accepts --source-id alias', () => {
    const a = parseArgs(['--source-id', 'alt']);
    expect(a.source).toBe('alt');
  });
});
