/**
 * Severity-classify tests — parse, sort, bucket, hot-page rollup.
 */

import { describe, test, expect } from 'bun:test';
import {
  bucketBySeverity,
  buildHotPages,
  compareSeverityDesc,
  parseSeverity,
} from '../src/core/eval-contradictions/severity-classify.ts';
import type { ContradictionFinding, Severity } from '../src/core/eval-contradictions/types.ts';

function mkFinding(opts: {
  slugA: string;
  slugB: string;
  severity: Severity;
}): ContradictionFinding {
  return {
    kind: 'cross_slug_chunks',
    a: {
      slug: opts.slugA,
      chunk_id: 1,
      take_id: null,
      source_tier: 'curated',
      holder: null,
      text: 'A',
    },
    b: {
      slug: opts.slugB,
      chunk_id: 2,
      take_id: null,
      source_tier: 'bulk',
      holder: null,
      text: 'B',
    },
    combined_score: 1,
    severity: opts.severity,
    axis: 'test',
    confidence: 0.9,
    resolution_kind: 'manual_review',
    resolution_command: '',
  };
}

describe('parseSeverity', () => {
  test('accepts the three valid values', () => {
    expect(parseSeverity('low')).toBe('low');
    expect(parseSeverity('medium')).toBe('medium');
    expect(parseSeverity('high')).toBe('high');
  });

  test('defaults to low on garbage input', () => {
    expect(parseSeverity(null)).toBe('low');
    expect(parseSeverity(undefined)).toBe('low');
    expect(parseSeverity('critical')).toBe('low');
    expect(parseSeverity(7)).toBe('low');
    expect(parseSeverity({})).toBe('low');
  });
});

describe('compareSeverityDesc', () => {
  test('high > medium > low', () => {
    expect(compareSeverityDesc('high', 'low')).toBeLessThan(0);
    expect(compareSeverityDesc('medium', 'low')).toBeLessThan(0);
    expect(compareSeverityDesc('high', 'medium')).toBeLessThan(0);
    expect(compareSeverityDesc('low', 'high')).toBeGreaterThan(0);
    expect(compareSeverityDesc('medium', 'medium')).toBe(0);
  });

  test('sorts a list to high-medium-low', () => {
    const sevs: Severity[] = ['low', 'high', 'medium', 'low', 'high'];
    sevs.sort(compareSeverityDesc);
    expect(sevs).toEqual(['high', 'high', 'medium', 'low', 'low']);
  });
});

describe('bucketBySeverity', () => {
  test('preserves order within each bucket', () => {
    const findings = [
      mkFinding({ slugA: 'a/1', slugB: 'b/1', severity: 'low' }),
      mkFinding({ slugA: 'a/2', slugB: 'b/2', severity: 'high' }),
      mkFinding({ slugA: 'a/3', slugB: 'b/3', severity: 'low' }),
      mkFinding({ slugA: 'a/4', slugB: 'b/4', severity: 'medium' }),
    ];
    const buckets = bucketBySeverity(findings);
    expect(buckets.low.length).toBe(2);
    expect(buckets.medium.length).toBe(1);
    expect(buckets.high.length).toBe(1);
    expect(buckets.low[0].a.slug).toBe('a/1');
    expect(buckets.low[1].a.slug).toBe('a/3');
  });

  test('empty input yields three empty buckets', () => {
    const buckets = bucketBySeverity([]);
    expect(buckets.low).toEqual([]);
    expect(buckets.medium).toEqual([]);
    expect(buckets.high).toEqual([]);
  });
});

describe('buildHotPages', () => {
  test('counts appearances across both pair ends', () => {
    const findings = [
      mkFinding({ slugA: 'people/alice', slugB: 'companies/acme', severity: 'high' }),
      mkFinding({ slugA: 'people/alice', slugB: 'companies/widget', severity: 'medium' }),
      mkFinding({ slugA: 'companies/acme', slugB: 'people/bob', severity: 'low' }),
    ];
    const hot = buildHotPages(findings);
    const alice = hot.find((p) => p.slug === 'people/alice');
    const acme = hot.find((p) => p.slug === 'companies/acme');
    expect(alice?.appearances).toBe(2);
    expect(acme?.appearances).toBe(2);
  });

  test('max_severity reflects the worst severity that hit the page', () => {
    const findings = [
      mkFinding({ slugA: 'people/alice', slugB: 'x/1', severity: 'low' }),
      mkFinding({ slugA: 'people/alice', slugB: 'x/2', severity: 'high' }),
      mkFinding({ slugA: 'people/alice', slugB: 'x/3', severity: 'medium' }),
    ];
    const hot = buildHotPages(findings);
    expect(hot[0].slug).toBe('people/alice');
    expect(hot[0].max_severity).toBe('high');
  });

  test('does not double-count when both ends share the same slug', () => {
    const findings = [
      mkFinding({ slugA: 'same/page', slugB: 'same/page', severity: 'medium' }),
    ];
    const hot = buildHotPages(findings);
    expect(hot[0].slug).toBe('same/page');
    expect(hot[0].appearances).toBe(1);
  });

  test('sorts by appearances DESC then by max severity DESC', () => {
    const findings = [
      mkFinding({ slugA: 'a/1', slugB: 'b/1', severity: 'low' }),
      mkFinding({ slugA: 'a/2', slugB: 'b/1', severity: 'low' }),
      mkFinding({ slugA: 'people/star', slugB: 'q/1', severity: 'high' }),
    ];
    const hot = buildHotPages(findings);
    // b/1 appears twice; people/star + a/1 + a/2 + q/1 appear once each.
    // Within ties, max_severity DESC orders people/star above a/1 etc.
    expect(hot[0].slug).toBe('b/1');
    expect(hot[0].appearances).toBe(2);
    expect(hot[1].slug).toBe('people/star');
  });

  test('respects the limit argument', () => {
    const findings: ContradictionFinding[] = [];
    for (let i = 0; i < 30; i++) {
      findings.push(mkFinding({ slugA: `p/${i}`, slugB: `q/${i}`, severity: 'low' }));
    }
    expect(buildHotPages(findings, 5).length).toBe(5);
  });
});
