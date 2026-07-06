/**
 * Regression: `gbrain whoknows <topic> --explain` must render the per-result
 * factor breakdown (expertise / recency / salience).
 *
 * The bug: `--explain` is a GLOBAL flag (cli-options.ts) stripped from argv
 * before op dispatch, so it never reached the `find_experts` op's `explain`
 * param. The live CLI output for `gbrain whoknows` goes through
 * formatResult('find_experts') (op-dispatch), which had no case → fell through
 * to the raw-JSON default, so `--explain` was a silent no-op at the human
 * layer.
 *
 * The fix mirrors the search/query `--explain` pattern: formatResult reads the
 * global flag via getCliOptions().explain and renders the readable breakdown.
 * These tests lock that wiring (the exact thing that was broken) plus the
 * shared formatter, and assert the non-explain path keeps its prior raw-JSON
 * output (no behavior change for existing consumers).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { formatWhoknowsResults, type WhoknowsResult } from '../src/commands/whoknows.ts';
import { formatResult } from '../src/cli.ts';
import {
  setCliOptions,
  _resetCliOptionsForTest,
  DEFAULT_CLI_OPTIONS,
} from '../src/core/cli-options.ts';

const SAMPLE: WhoknowsResult[] = [
  {
    slug: 'wiki/people/alice-example',
    source_id: 'default',
    title: 'Alice Example',
    type: 'person',
    score: 0.257,
    factors: {
      expertise: 0.405,
      recency_decay: 0.846,
      recency_factor: 0.846,
      salience: 0.5,
      salience_factor: 0.75,
      days_since_effective: 30,
      raw_match: 0.5,
    },
  },
  {
    // cold-start: null effective date → renders as "cold" / floored recency.
    slug: 'wiki/companies/acme-example',
    source_id: 'default',
    title: 'Acme Example',
    type: 'company',
    score: 0.041,
    factors: {
      expertise: 0.405,
      recency_decay: 0.1,
      recency_factor: 0.1,
      salience: 0.5,
      salience_factor: 0.75,
      days_since_effective: null,
      raw_match: 0.5,
    },
  },
];

afterEach(() => {
  _resetCliOptionsForTest();
});

describe('formatWhoknowsResults — shared human formatter', () => {
  test('with explain: every result gets an expertise/recency/salience breakdown line', () => {
    const out = formatWhoknowsResults(SAMPLE, { explain: true });
    // table rows present
    expect(out).toContain('wiki/people/alice-example');
    expect(out).toContain('Alice Example');
    expect(out).toContain('wiki/companies/acme-example');
    // factor breakdown present for each result
    const breakdownLines = out.split('\n').filter((l) => l.includes('expertise='));
    expect(breakdownLines.length).toBe(SAMPLE.length);
    expect(out).toMatch(/expertise=0\.405 \(raw=0\.500\)/);
    expect(out).toMatch(/recency=/);
    expect(out).toMatch(/salience=0\.500 → factor=0\.750/);
    // recency age: a day count for dated rows, "cold" for null effective date
    expect(out).toContain('(30d)');
    expect(out).toContain('(cold)');
  });

  test('without explain: table rows only, no factor breakdown', () => {
    const out = formatWhoknowsResults(SAMPLE, { explain: false });
    expect(out).toContain('wiki/people/alice-example');
    expect(out).not.toMatch(/expertise=/);
    expect(out).not.toMatch(/recency=/);
  });

  test('empty results: friendly message, with and without topic', () => {
    expect(formatWhoknowsResults([], { topic: 'lab automation' })).toContain(
      'no person or company pages match "lab automation"',
    );
    expect(formatWhoknowsResults([])).toContain('no person or company pages match');
  });
});

describe('formatResult(find_experts) — live --explain wiring (the regression locus)', () => {
  test('global --explain (getCliOptions().explain=true) renders the factor breakdown', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, explain: true });
    const out = formatResult('find_experts', SAMPLE);
    expect(out).toMatch(/expertise=/);
    expect(out).toMatch(/recency=/);
    expect(out).toMatch(/salience=/);
    expect(out).toContain('wiki/people/alice-example');
  });

  test('without --explain: preserves the prior raw-JSON default (no behavior change)', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, explain: false });
    const out = formatResult('find_experts', SAMPLE);
    // Parseable JSON that still carries the factor data, but NOT the readable
    // `expertise=` breakdown line that --explain adds.
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].slug).toBe('wiki/people/alice-example');
    expect(out).not.toMatch(/expertise=/);
  });
});
