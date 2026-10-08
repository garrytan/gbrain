/**
 * #6278 (2.1): the fence codec as the fact adoption's oracle.
 *
 * Protects: for 1,000 random fence rows, `adoptableClaim` either (a) accepts
 * the row and hands back a claim that equals the stored claim up to the
 * accepted whitespace normalization (trim at both ends, CRLF/CR → LF) and
 * that `renderFactsTable` → `parseFactsFence` reproduces exactly, together
 * with the row's kind, visibility, validity, source, notability, confidence
 * (as the fence writes it), context, typed-claim cells and active flag, or
 * (b) rejects it with the class that names what the codec changes; a row
 * whose stored claim already equals its parsed claim is always accepted, and
 * the known shapes (surrounding whitespace, whitespace-only, CRLF, lone CR,
 * NBSP, `~~x~~`, a literal `<br>`) land in their documented class.
 * Fails when: the oracle accepts a claim the fence would read back
 * differently (the projection would then expire the adopted row), rejects a
 * whitespace-only difference, mislabels a shape, or a column other than the
 * claim stops round-tripping.
 * Why existing coverage misses it: the fence tests round-trip hand-written
 * rows through the codec; nothing checks the adoption's acceptance rule
 * against the codec over random text.
 * Seams: none; pure functions.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { normalizeClaimWhitespace, parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { adoptableClaim, type UnfencedFactRow, type UnrenderableClass } from '../src/core/facts/unfenced-facts.ts';

const NUM_RUNS = 1000;
const KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
const VISIBILITIES = ['private', 'world'] as const;
const NOTABILITIES = ['high', 'medium', 'low'] as const;

/** Claim text drawn from the characters the codec treats specially plus ordinary prose, unicode and emoji. */
const claimText = fc.array(fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?()[]{}"\'-_/#$%&*+=@') },
  { weight: 2, arbitrary: fc.constantFrom(' ', '\t', '\n', '\r\n', '\r', '\u00a0') },
  { weight: 1, arbitrary: fc.constantFrom('|', '\\', '`', '~~', '<br>', '<br/>', '<BR />', '~', '<', '>') },
  { weight: 1, arbitrary: fc.constantFrom('café', 'Zürich', '東京', 'мир', '🙂', '👩‍💻', '€1,200', '\u2028') },
), { minLength: 0, maxLength: 20 }).map(parts => parts.join(''));

const dateCell = fc.constantFrom('2024-01-01', '2026-02-05T13:45:12Z', '1999-12-31', '2026-10-07');
const sourceCell = fc.constantFrom('mcp:remember', 'linkedin', 'OH 2026-04-29', 'call notes', '', 'cli:think');
const contextCell = fc.option(fc.constantFrom('from a call', 'superseded later', 'note', 'a | pipe'), { nil: null });

const row = fc.record({
  fact: claimText,
  kind: fc.constantFrom(...KINDS),
  visibility: fc.constantFrom(...VISIBILITIES),
  notability: fc.constantFrom(...NOTABILITIES),
  confidence: fc.constantFrom(1, 0.9, 0.85, 0.5, 0.123, 0, 0.75),
  context: contextCell,
  valid_from: dateCell.map(d => new Date(d)),
  valid_until: fc.option(dateCell.map(d => new Date(d)), { nil: null }),
  source: sourceCell,
  claim_metric: fc.option(fc.constantFrom('mrr', 'team_size'), { nil: null }),
  claim_value: fc.option(fc.constantFrom(50000, 12, 2.5), { nil: null }),
  claim_unit: fc.option(fc.constantFrom('USD', 'people'), { nil: null }),
  claim_period: fc.option(fc.constantFrom('monthly', 'annual'), { nil: null }),
}) as fc.Arbitrary<Pick<UnfencedFactRow, 'fact' | 'kind' | 'visibility' | 'notability' | 'confidence' | 'context' | 'valid_from' | 'valid_until'
  | 'source' | 'claim_metric' | 'claim_value' | 'claim_unit' | 'claim_period'>>;

/** The fence row the adoption renders for a stored row, with the claim it decided on. */
function fenceRow(r: Parameters<typeof adoptableClaim>[0], claim: string): ParsedFact {
  const date = (d: Date) => d.toISOString().endsWith('T00:00:00.000Z') ? d.toISOString().slice(0, 10) : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { rowNum: 7, active: true, claim, kind: r.kind, confidence: r.confidence, visibility: r.visibility, notability: r.notability,
    validFrom: date(r.valid_from), validUntil: r.valid_until ? date(r.valid_until) : undefined, source: r.source, context: r.context ?? undefined,
    ...(r.claim_metric ? { claimMetric: r.claim_metric } : {}), ...(r.claim_value != null ? { claimValue: r.claim_value } : {}),
    ...(r.claim_unit ? { claimUnit: r.claim_unit } : {}), ...(r.claim_period ? { claimPeriod: r.claim_period } : {}) };
}

describe('fact adoption oracle over the fence codec (#6278)', () => {
  test(`${NUM_RUNS} random rows: an accepted claim round-trips every column exactly; a rejected one names what the codec changes`, () => {
    let accepted = 0, rejected = 0;
    fc.assert(fc.property(row, (r) => {
      const verdict = adoptableClaim(r);
      if ('rejected' in verdict) {
        rejected += 1;
        // Rejection is only ever about what the codec changes: the codec must indeed not hand the stored text back.
        const back = parseFactsFence(renderFactsTable([fenceRow(r, r.fact)])).facts[0];
        const unchanged = back !== undefined && back.active && back.claim !== '' && normalizeClaimWhitespace(back.claim) === normalizeClaimWhitespace(r.fact)
          && (back.source ?? '') === r.source;
        expect(unchanged).toBe(false);
        return;
      }
      accepted += 1;
      expect(normalizeClaimWhitespace(verdict.claim)).toBe(normalizeClaimWhitespace(r.fact));
      const desired = fenceRow(r, verdict.claim);
      const parsed = parseFactsFence(renderFactsTable([desired]));
      expect(parsed.warnings).toEqual([]);
      const back = parsed.facts[0]!;
      expect(back.claim).toBe(verdict.claim);
      expect(back.active).toBe(true);
      expect(back.kind).toBe(r.kind);
      expect(back.visibility).toBe(r.visibility);
      expect(back.notability).toBe(r.notability);
      expect(back.validFrom).toBe(desired.validFrom);
      expect(back.validUntil).toBe(desired.validUntil);
      expect(back.source ?? '').toBe(r.source);
      expect(back.context).toBe(desired.context);
      expect(back.confidence).toBe(Number(parseFloat(r.confidence.toFixed(2))));
      expect(back.claimMetric).toBe(desired.claimMetric);
      expect(back.claimValue).toBe(desired.claimValue);
      expect(back.claimUnit).toBe(desired.claimUnit);
      expect(back.claimPeriod).toBe(desired.claimPeriod);
      expect(back.rowNum).toBe(7);
    }), { numRuns: NUM_RUNS });
    // Both branches were exercised.
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(20);
  });

  test('a stored claim the codec already hands back unchanged is always accepted as itself', () => {
    fc.assert(fc.property(row, (r) => {
      const back = parseFactsFence(renderFactsTable([fenceRow(r, r.fact)])).facts[0];
      fc.pre(back !== undefined && back.active && back.claim === r.fact && r.fact !== '');
      expect(adoptableClaim(r)).toEqual({ claim: r.fact });
    }), { numRuns: 300 });
  });

  test('the known shapes land in their documented class', () => {
    const base = { kind: 'fact' as const, visibility: 'world' as const, notability: 'high' as const, confidence: 0.9, context: null,
      valid_from: new Date('2024-01-01'), valid_until: null, source: 'linkedin', claim_metric: null, claim_value: null, claim_unit: null, claim_period: null };
    const cases: Array<[string, { claim: string } | { rejected: UnrenderableClass }]> = [
      ['x ', { claim: 'x' }], [' x', { claim: 'x' }], ['\tx', { claim: 'x' }], ['x\u00a0', { claim: 'x' }],
      ['a\r\nb', { claim: 'a\nb' }], ['a\rb', { claim: 'a\nb' }], ['a\nb', { claim: 'a\nb' }],
      ['a|b', { claim: 'a|b' }], ['a\\b', { claim: 'a\\b' }], ['`code`', { claim: '`code`' }], ['🙂 café', { claim: '🙂 café' }],
      ['   ', { rejected: 'empty' }], ['', { rejected: 'empty' }],
      ['~~x~~', { rejected: 'struck' }], [' ~~x~~ ', { rejected: 'struck' }],
      ['a<br>b', { rejected: 'line_break_markup' }], ['a<BR />b', { rejected: 'line_break_markup' }],
    ];
    for (const [claim, expected] of cases) expect([claim, adoptableClaim({ ...base, fact: claim })]).toEqual([claim, expected]);
    // The one accepted difference between stored and parsed text is whitespace; a 1,200-character claim is fine.
    expect(adoptableClaim({ ...base, fact: 'y'.repeat(1200) })).toEqual({ claim: 'y'.repeat(1200) });
  });
});
