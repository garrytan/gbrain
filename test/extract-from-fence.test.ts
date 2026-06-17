/**
 * v0.32.2 — extract-from-fence pure-mapper tests.
 *
 * Covers the ParsedFact → FenceExtractedFact mapping including:
 *   - All-fields happy path
 *   - The strikethrough date-derivation contract (forgotten / superseded
 *     / inactive-unrecognized branches)
 *   - source default when fence row has no `source` cell
 *   - row_num and source_markdown_slug threading
 *   - ISO date parsing tolerance + UTC determinism
 */

import { describe, test, expect } from 'bun:test';

import {
  extractFactsFromFenceText,
  FENCE_SOURCE_DEFAULT,
} from '../src/core/facts/extract-from-fence.ts';
import type { ParsedFact } from '../src/core/facts-fence.ts';

const baseFact = (overrides: Partial<ParsedFact> = {}): ParsedFact => ({
  rowNum: 1,
  claim: 'Founded Acme in 2017',
  kind: 'fact',
  confidence: 1.0,
  visibility: 'world',
  notability: 'high',
  validFrom: '2017-01-01',
  source: 'linkedin',
  active: true,
  ...overrides,
});

// Deterministic "today" for date-derivation tests.
const FROZEN_TODAY = new Date(Date.UTC(2026, 4, 11));  // 2026-05-11

describe('extractFactsFromFenceText — happy path mapping', () => {
  test('maps all NewFact fields from a canonical row', () => {
    const out = extractFactsFromFenceText(
      [baseFact()],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      fact: 'Founded Acme in 2017',
      kind: 'fact',
      entity_slug: 'people/alice',
      visibility: 'world',
      notability: 'high',
      source: 'linkedin',
      confidence: 1.0,
      row_num: 1,
      source_markdown_slug: 'people/alice',
    });
    expect(out[0].valid_from).toBeInstanceOf(Date);
    expect(out[0].valid_from!.getUTCFullYear()).toBe(2017);
    expect(out[0].valid_until).toBeNull();
  });

  test('source_id is supplied via the sourceId arg, not the fence', () => {
    const out = extractFactsFromFenceText(
      [baseFact()],
      'people/alice',
      'work-source',
      { nowOverride: FROZEN_TODAY },
    );
    // FenceExtractedFact does NOT carry source_id on the row itself; the
    // engine sets it from opts at insert time. The slug binding lives in
    // source_markdown_slug and entity_slug instead.
    expect(out[0].source_markdown_slug).toBe('people/alice');
    expect(out[0].entity_slug).toBe('people/alice');
  });

  test('preserves row_num exactly from the fence', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ rowNum: 7 }), baseFact({ rowNum: 12 })],
      'people/bob',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out.map(r => r.row_num)).toEqual([7, 12]);
  });

  test('context maps through (including undefined → null contract)', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ context: 'Founder bio' }), baseFact({ rowNum: 2, context: undefined })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].context).toBe('Founder bio');
    expect(out[1].context).toBeNull();
  });

  test('all five FactKind values pass through', () => {
    const kinds = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
    const facts = kinds.map((k, i) => baseFact({ rowNum: i + 1, kind: k }));
    const out = extractFactsFromFenceText(facts, 'people/alice', 'default', { nowOverride: FROZEN_TODAY });
    expect(out.map(r => r.kind)).toEqual([...kinds]);
  });

  test('both visibility values pass through', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ visibility: 'private' }), baseFact({ rowNum: 2, visibility: 'world' })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out.map(r => r.visibility)).toEqual(['private', 'world']);
  });
});

describe('extractFactsFromFenceText — date derivation contract', () => {
  test('explicit validUntil is honored as-is', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ validUntil: '2026-12-31' })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until).toBeInstanceOf(Date);
    expect(out[0].valid_until!.getUTCFullYear()).toBe(2026);
    expect(out[0].valid_until!.getUTCMonth()).toBe(11); // December
  });

  test('active row with no validUntil → valid_until = null', () => {
    const out = extractFactsFromFenceText(
      [baseFact()],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until).toBeNull();
  });

  test('forgotten row → valid_until = today (UTC midnight)', () => {
    const out = extractFactsFromFenceText(
      [baseFact({
        active: false,
        forgotten: true,
        context: 'forgotten: user asked to remove',
      })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until).toEqual(FROZEN_TODAY);
  });

  test('forgotten row with explicit validUntil → explicit value wins', () => {
    // Sanity check: if a hand-edit set validUntil AND added "forgotten:"
    // in context, honor the explicit date. The strikethrough-derivation
    // is a fallback, not a forced override.
    const out = extractFactsFromFenceText(
      [baseFact({
        active: false,
        forgotten: true,
        validUntil: '2024-06-01',
        context: 'forgotten: ancient history',
      })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until!.getUTCFullYear()).toBe(2024);
    expect(out[0].valid_until).not.toEqual(FROZEN_TODAY);
  });

  test('supersededBy row without explicit validUntil → null (consolidator owns derivation)', () => {
    const out = extractFactsFromFenceText(
      [baseFact({
        active: false,
        supersededBy: 4,
        context: 'superseded by #4',
      })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until).toBeNull();
  });

  test('supersededBy row with explicit validUntil → explicit value wins', () => {
    const out = extractFactsFromFenceText(
      [baseFact({
        active: false,
        supersededBy: 4,
        validUntil: '2026-06-01',
        context: 'superseded by #4',
      })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until!.getUTCFullYear()).toBe(2026);
  });

  test('inactive-unrecognized row (strikethrough but no forgotten/superseded flag) → today', () => {
    // The parser preserved the row's strikethrough intent without
    // recognizing why. The mapper treats unrecognized-inactive like
    // forgotten for DB-derivation safety. Honors the user's strikethrough.
    const out = extractFactsFromFenceText(
      [baseFact({
        active: false,
        context: 'I just don\'t believe this anymore',
        // No forgotten, no supersededBy
      })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_until).toEqual(FROZEN_TODAY);
  });
});

describe('extractFactsFromFenceText — source defaulting', () => {
  test('uses fence source when present', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ source: 'OH 2026-04-29' })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].source).toBe('OH 2026-04-29');
  });

  test('falls back to FENCE_SOURCE_DEFAULT when fence has no source', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ source: undefined })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].source).toBe(FENCE_SOURCE_DEFAULT);
    expect(FENCE_SOURCE_DEFAULT).toBe('fence:reconcile');
  });
});

describe('extractFactsFromFenceText — date parse tolerance', () => {
  test('YYYY-MM-DD shape parses', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ validFrom: '2017-01-01' })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_from).toBeInstanceOf(Date);
    expect(out[0].valid_from!.getUTCFullYear()).toBe(2017);
  });

  test('empty validFrom → undefined (engine layer defaults to now())', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ validFrom: undefined })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_from).toBeUndefined();
  });

  test('completely invalid validFrom string → undefined (lenient)', () => {
    const out = extractFactsFromFenceText(
      [baseFact({ validFrom: 'not a date at all' })],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].valid_from).toBeUndefined();
  });
});

describe('extractFactsFromFenceText — bulk + edge cases', () => {
  test('empty input array → empty output array', () => {
    const out = extractFactsFromFenceText([], 'people/alice', 'default');
    expect(out).toEqual([]);
  });

  test('30-row fence maps without dropping rows', () => {
    const facts = Array.from({ length: 30 }, (_, i) =>
      baseFact({ rowNum: i + 1, claim: `claim ${i + 1}` }));
    const out = extractFactsFromFenceText(facts, 'people/alice', 'default', { nowOverride: FROZEN_TODAY });
    expect(out).toHaveLength(30);
    expect(out.map(r => r.row_num)).toEqual(facts.map(f => f.rowNum));
  });

  test('every output row carries source_markdown_slug equal to the input slug', () => {
    const facts = [baseFact({ rowNum: 1 }), baseFact({ rowNum: 2 }), baseFact({ rowNum: 3 })];
    const out = extractFactsFromFenceText(facts, 'companies/acme', 'default', { nowOverride: FROZEN_TODAY });
    out.forEach(r => expect(r.source_markdown_slug).toBe('companies/acme'));
  });
});
