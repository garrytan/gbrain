/**
 * #2570 v1 — pure-classifier unit tests for the generated-pages adoption
 * report. No engine: these pin the classification contract (fixed precedence
 * external > generated_cluster > summary_only > none, distinct-origin
 * evaluation, mentions exclusion, self-link handling) and the marker/window
 * predicates.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyInbound,
  classifyOriginKind,
  hasDurableDreamMarker,
  isDreamSummarySlug,
  isValidCycleDate,
  resolveSinceWindow,
  type InboundEdgeRow,
} from '../src/core/generated-report.ts';

// --- fixture helpers ---

const TARGET_ID = 100;
const TARGET_SOURCE = 'default';

let nextOriginId = 1000;

/** External (human/curated) origin edge. */
function externalEdge(over: Partial<InboundEdgeRow> = {}): InboundEdgeRow {
  return {
    origin_id: over.origin_id ?? nextOriginId++,
    origin_slug: 'people/alice-example',
    origin_source_id: TARGET_SOURCE,
    link_source: 'markdown',
    origin_page_type: 'person',
    origin_fm_type: null,
    origin_dream_generated: null,
    origin_cycle_date: null,
    ...over,
  };
}

/** Dream-generated sibling origin edge. */
function generatedEdge(over: Partial<InboundEdgeRow> = {}): InboundEdgeRow {
  return externalEdge({
    origin_slug: 'wiki/originals/ideas/sibling',
    origin_page_type: 'note',
    origin_dream_generated: 'true',
    origin_cycle_date: '2026-07-01',
    ...over,
  });
}

/** Dream-cycle summary index origin edge (same source as target). */
function summaryEdge(over: Partial<InboundEdgeRow> = {}): InboundEdgeRow {
  return externalEdge({
    origin_slug: 'dream-cycle-summaries/2026-07-01',
    origin_page_type: 'note',
    origin_dream_generated: 'true',
    origin_cycle_date: '2026-07-01',
    ...over,
  });
}

function bucketOf(edges: InboundEdgeRow[]): string {
  return classifyInbound(TARGET_ID, TARGET_SOURCE, edges).bucket;
}

// --- marker predicate ---

describe('isValidCycleDate', () => {
  test('accepts a real ISO date', () => {
    expect(isValidCycleDate('2026-07-23')).toBe(true);
  });
  test('rejects non-dates, wrong shapes, and impossible dates', () => {
    expect(isValidCycleDate(null)).toBe(false);
    expect(isValidCycleDate(undefined)).toBe(false);
    expect(isValidCycleDate('')).toBe(false);
    expect(isValidCycleDate('true')).toBe(false);
    expect(isValidCycleDate('2026-7-1')).toBe(false);
    expect(isValidCycleDate('2026-13-01')).toBe(false);
    expect(isValidCycleDate('2026-02-30')).toBe(false);
    expect(isValidCycleDate('2026-07-23T00:00:00Z')).toBe(false);
  });
});

describe('hasDurableDreamMarker', () => {
  const base = {
    dream_generated: 'true',
    dream_cycle_date: '2026-07-01',
    page_type: 'note',
    fm_type: null,
  };
  test('accepts the durable marker', () => {
    expect(hasDurableDreamMarker(base)).toBe(true);
  });
  test('requires dream_generated to be true', () => {
    expect(hasDurableDreamMarker({ ...base, dream_generated: null })).toBe(false);
    expect(hasDurableDreamMarker({ ...base, dream_generated: 'false' })).toBe(false);
  });
  test('requires a valid dream_cycle_date', () => {
    expect(hasDurableDreamMarker({ ...base, dream_cycle_date: null })).toBe(false);
    expect(hasDurableDreamMarker({ ...base, dream_cycle_date: 'soon' })).toBe(false);
  });
  test('excludes extract_receipt marker reuse (pages.type and frontmatter type)', () => {
    expect(hasDurableDreamMarker({ ...base, page_type: 'extract_receipt' })).toBe(false);
    expect(hasDurableDreamMarker({ ...base, fm_type: 'extract_receipt' })).toBe(false);
  });
});

describe('isDreamSummarySlug', () => {
  test('matches the synthesize.ts summary slug shape', () => {
    expect(isDreamSummarySlug('dream-cycle-summaries/2026-07-01')).toBe(true);
  });
  test('rejects non-summary slugs', () => {
    expect(isDreamSummarySlug('dream-cycle-summaries')).toBe(false);
    expect(isDreamSummarySlug('dream-cycle-summaries/2026-07-01/extra')).toBe(false);
    expect(isDreamSummarySlug('wiki/dream-cycle-summaries/2026-07-01')).toBe(false);
    expect(isDreamSummarySlug('dream-cycle-summaries/notes')).toBe(false);
  });
});

// --- since window ---

describe('resolveSinceWindow', () => {
  const now = new Date('2026-07-23T12:34:56Z');
  test('absent → null (no window)', () => {
    expect(resolveSinceWindow(undefined, now)).toBeNull();
    expect(resolveSinceWindow(null, now)).toBeNull();
    expect(resolveSinceWindow('', now)).toBeNull();
  });
  test('passes through explicit ISO dates', () => {
    expect(resolveSinceWindow('2026-06-01', now)).toBe('2026-06-01');
  });
  test('resolves relative days and weeks against UTC midnight', () => {
    expect(resolveSinceWindow('30d', now)).toBe('2026-06-23');
    expect(resolveSinceWindow('4w', now)).toBe('2026-06-25');
    expect(resolveSinceWindow('0d', now)).toBe('2026-07-23');
  });
  test('rejects garbage and impossible dates', () => {
    expect(() => resolveSinceWindow('yesterday', now)).toThrow();
    expect(() => resolveSinceWindow('2026-02-30', now)).toThrow();
    expect(() => resolveSinceWindow('30x', now)).toThrow();
  });
});

// --- origin kind ---

describe('classifyOriginKind', () => {
  test('summary slug in the SAME source is summary', () => {
    expect(classifyOriginKind(summaryEdge(), TARGET_SOURCE)).toBe('summary');
  });
  test('summary slug in a DIFFERENT source is not the target source summary', () => {
    const e = summaryEdge({ origin_source_id: 'other-source' });
    // Falls through to the generated flag (summaries are dream-stamped).
    expect(classifyOriginKind(e, TARGET_SOURCE)).toBe('generated');
  });
  test('dream_generated flag alone marks generated provenance (looser than the durable marker)', () => {
    // No cycle date: a receipt-style / unstamped-date origin must still not
    // count as external adoption.
    const e = externalEdge({ origin_dream_generated: 'true', origin_cycle_date: null });
    expect(classifyOriginKind(e, TARGET_SOURCE)).toBe('generated');
  });
  test('everything else is external', () => {
    expect(classifyOriginKind(externalEdge(), TARGET_SOURCE)).toBe('external');
  });
});

// --- the four buckets ---

describe('classifyInbound buckets', () => {
  test('none: zero inbound edges', () => {
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, []);
    expect(r.bucket).toBe('none');
    expect(r.inbound).toEqual({
      raw_edges: 0,
      self_link_edges: 0,
      eligible_edges: 0,
      eligible_origins: 0,
      mentions_only_origins: 0,
      origin_kinds: { external: 0, generated: 0, summary: 0 },
    });
  });

  test('summary_only: only inbound origin is the source summary page', () => {
    expect(bucketOf([summaryEdge()])).toBe('summary_only');
  });

  test('summary_only: multiple summaries from different cycles stay summary_only', () => {
    expect(
      bucketOf([
        summaryEdge({ origin_slug: 'dream-cycle-summaries/2026-07-01' }),
        summaryEdge({ origin_slug: 'dream-cycle-summaries/2026-07-02' }),
      ]),
    ).toBe('summary_only');
  });

  test('generated_cluster: sibling generated origins only', () => {
    expect(bucketOf([generatedEdge()])).toBe('generated_cluster');
  });

  test('generated_cluster: summary + generated sibling (non-summary generated origin wins over summary)', () => {
    expect(bucketOf([summaryEdge(), generatedEdge()])).toBe('generated_cluster');
  });

  test('external: one non-generated origin wins over everything (most-adopted precedence)', () => {
    expect(bucketOf([summaryEdge(), generatedEdge(), externalEdge()])).toBe('external');
  });

  test('external: single external origin', () => {
    expect(bucketOf([externalEdge()])).toBe('external');
  });
});

// --- mentions exclusion ---

describe('classifyInbound mentions handling', () => {
  test("link_source='mentions' never promotes to external", () => {
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      externalEdge({ link_source: 'mentions' }),
    ]);
    expect(r.bucket).toBe('none');
    expect(r.inbound.raw_edges).toBe(1);
    expect(r.inbound.eligible_edges).toBe(0);
    expect(r.inbound.mentions_only_origins).toBe(1);
  });

  test('mentions-external + explicit summary → summary_only (mentions hidden from classification, visible in raw)', () => {
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      externalEdge({ link_source: 'mentions' }),
      summaryEdge(),
    ]);
    expect(r.bucket).toBe('summary_only');
    expect(r.inbound.raw_edges).toBe(2);
    expect(r.inbound.eligible_edges).toBe(1);
  });

  test('same origin with BOTH a mentions edge and a markdown edge is eligible via the markdown edge', () => {
    const originId = 501;
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      externalEdge({ origin_id: originId, link_source: 'mentions' }),
      externalEdge({ origin_id: originId, link_source: 'markdown' }),
    ]);
    expect(r.bucket).toBe('external');
    expect(r.inbound.eligible_origins).toBe(1);
    expect(r.inbound.mentions_only_origins).toBe(0);
    expect(r.inbound.raw_edges).toBe(2);
    expect(r.inbound.eligible_edges).toBe(1);
  });

  test('NULL link_source (legacy/unknown) stays classification-eligible', () => {
    expect(bucketOf([externalEdge({ link_source: null })])).toBe('external');
  });

  test("'manual' / 'frontmatter' / 'wikilink-resolved' are eligible", () => {
    for (const src of ['manual', 'frontmatter', 'wikilink-resolved']) {
      expect(bucketOf([externalEdge({ link_source: src })])).toBe('external');
    }
  });
});

// --- self-links + distinct origins ---

describe('classifyInbound self-links and dedup', () => {
  test('a self-link is never adoption signal', () => {
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      externalEdge({ origin_id: TARGET_ID }),
    ]);
    expect(r.bucket).toBe('none');
    expect(r.inbound.self_link_edges).toBe(1);
    expect(r.inbound.raw_edges).toBe(0);
  });

  test('multiple edges from one origin count once for classification', () => {
    const originId = 777;
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      generatedEdge({ origin_id: originId, link_source: 'markdown' }),
      generatedEdge({ origin_id: originId, link_source: 'frontmatter' }),
    ]);
    expect(r.bucket).toBe('generated_cluster');
    expect(r.inbound.eligible_origins).toBe(1);
    expect(r.inbound.eligible_edges).toBe(2);
    expect(r.inbound.origin_kinds).toEqual({ external: 0, generated: 1, summary: 0 });
  });

  test('mixed everything: self + mentions + summary + generated + external → external', () => {
    const r = classifyInbound(TARGET_ID, TARGET_SOURCE, [
      externalEdge({ origin_id: TARGET_ID }), // self
      externalEdge({ link_source: 'mentions' }),
      summaryEdge(),
      generatedEdge(),
      externalEdge(),
    ]);
    expect(r.bucket).toBe('external');
    expect(r.inbound.self_link_edges).toBe(1);
    expect(r.inbound.raw_edges).toBe(4);
    expect(r.inbound.eligible_edges).toBe(3);
    expect(r.inbound.eligible_origins).toBe(3);
    expect(r.inbound.mentions_only_origins).toBe(1);
    expect(r.inbound.origin_kinds).toEqual({ external: 1, generated: 1, summary: 1 });
  });
});
