/**
 * v0.32.2 — extract-from-fence pure-mapper tests.
 *
 * Covers the ParsedFact → FenceExtractedFact mapping including:
 *   - All-fields happy path
 *   - The strikethrough date-derivation contract (forgotten / superseded
 *     / inactive-unrecognized branches)
 *   - v0.42 (#3014) supersession transport: struck rows carry expired_at
 *     + the `superseded by #N` row reference; resolveSupersededByRow's
 *     self / dangling / chain edge cases
 *   - source default when fence row has no `source` cell
 *   - row_num and source_markdown_slug threading
 *   - ISO date parsing tolerance + UTC determinism
 */

import { describe, test, expect } from 'bun:test';

import {
  extractFactsFromFenceText,
  FENCE_SOURCE_DEFAULT,
  resolveSupersededByRow,
  isInt4RowRef,
  PG_INT4_MAX,
  type SupersedeTarget,
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

  test('forgotten row → valid_until = today (UTC midnight) + expired_at set, no supersession', () => {
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
    // v0.42 (#3014) — a struck row stamps expired_at so it exits active
    // views; a forgotten row is not a supersession, so no row reference.
    expect(out[0].expired_at).toEqual(FROZEN_TODAY);
    expect(out[0].superseded_by_row).toBeUndefined();
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

  test('supersededBy row without explicit validUntil → valid_until null, expired_at today, superseded_by_row carried', () => {
    // v0.42 (#3014): pre-fix the mapper dropped supersededBy and left
    // valid_until null "for the consolidator". The mapper now owns the
    // transport: it carries the row reference and stamps expired_at so the
    // struck row exits active views. valid_until stays null (no explicit
    // date, and the superseding row's valid_from isn't visible here).
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
    expect(out[0].expired_at).toEqual(FROZEN_TODAY);
    expect(out[0].superseded_by_row).toBe(4);
  });

  test('supersededBy row with explicit validUntil → explicit value wins for both valid_until and expired_at', () => {
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
    // expired_at derives from valid_until when present (valid_until ?? today).
    expect(out[0].expired_at!.getUTCFullYear()).toBe(2026);
    expect(out[0].expired_at!.getUTCMonth()).toBe(5); // June
    expect(out[0].superseded_by_row).toBe(4);
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
    // v0.42 (#3014) — unrecognized-inactive still exits active views via
    // expired_at, but is not a supersession.
    expect(out[0].expired_at).toEqual(FROZEN_TODAY);
    expect(out[0].superseded_by_row).toBeUndefined();
  });

  test('active row → expired_at null, no supersession reference', () => {
    const out = extractFactsFromFenceText(
      [baseFact()],
      'people/alice',
      'default',
      { nowOverride: FROZEN_TODAY },
    );
    expect(out[0].expired_at).toBeNull();
    expect(out[0].superseded_by_row).toBeUndefined();
  });
});

describe('resolveSupersededByRow — reference resolution', () => {
  const live: SupersedeTarget = { id: 42, struck: false };

  test('valid reference → resolves to the target fact id, no warning', () => {
    const r = resolveSupersededByRow(1, 2, live, 'deals/acme');
    expect(r.superseded_by).toBe(42);
    expect(r.warning).toBeNull();
  });

  test('self-reference → NULL + warning', () => {
    const r = resolveSupersededByRow(3, 3, { id: 99, struck: false }, 'deals/acme');
    expect(r.superseded_by).toBeNull();
    expect(r.warning).toContain('references itself');
  });

  test('dangling reference (target absent from fence) → NULL + warning', () => {
    const r = resolveSupersededByRow(1, 9, undefined, 'deals/acme');
    expect(r.superseded_by).toBeNull();
    expect(r.warning).toContain('absent from the fence');
  });

  test('chain (target is itself struck) → NULL + warning', () => {
    const r = resolveSupersededByRow(1, 2, { id: 7, struck: true }, 'deals/acme');
    expect(r.superseded_by).toBeNull();
    expect(r.warning).toContain('chain');
  });
});

describe('isInt4RowRef — supersession-target overflow guard (#3014)', () => {
  test('accepts a normal positive row reference', () => {
    expect(isInt4RowRef(1)).toBe(true);
    expect(isInt4RowRef(42)).toBe(true);
  });

  test('accepts the int4 maximum, rejects one past it', () => {
    expect(isInt4RowRef(PG_INT4_MAX)).toBe(true);
    expect(isInt4RowRef(PG_INT4_MAX + 1)).toBe(false);
  });

  test('rejects an 11-digit reference (the reported overflow shape)', () => {
    // The parser accepts any finite #N; this one would overflow int4 in the
    // resolution SELECT and abort the cycle if it reached the DB.
    expect(isInt4RowRef(99999999999)).toBe(false);
  });

  test('rejects zero, negatives, and non-integers', () => {
    expect(isInt4RowRef(0)).toBe(false);
    expect(isInt4RowRef(-5)).toBe(false);
    expect(isInt4RowRef(1.5)).toBe(false);
    expect(isInt4RowRef(Number.NaN)).toBe(false);
    expect(isInt4RowRef(Number.POSITIVE_INFINITY)).toBe(false);
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
