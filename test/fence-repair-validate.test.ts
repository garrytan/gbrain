/**
 * Fence repair validator (#6188): one adversarial repair per gate (a)-(g),
 * rejected with its letter; Tier 3-style stubs against gate (f) (TE2);
 * verified holders; the Tier 1 fixed point. All content is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE } from '../src/core/takes-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { normalizeFences } from '../src/core/fence-repair/normalize.ts';
import { isFenceFixedPoint, validateFenceRepair, type ValidateCtx } from '../src/core/fence-repair/validate.ts';
import type { FenceCtx, FenceLocation, FencePage } from '../src/core/fence-repair/types.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const TH = '| # | claim | kind | who | weight | since | source |';
const PRIVATE: FenceCtx = { pageVisibility: 'private' };
const page = (compiled_truth: string, timeline = ''): FencePage => ({ compiled_truth, timeline });
const facts = (...rows: string[]) => [FB, FH, ...rows, FE, ''].join('\n');
const takes = (...rows: string[]) => [TB, TH, ...rows, TE, ''].join('\n');

const ROW1 = '| 1 | Alpha claim | partnership | 0.9 | private | medium | 2026-01-01 |  | call | note |';
const ROW1_FIXED = '| 1 | Alpha claim | fact | 0.9 | private | medium | 2026-01-01 |  | call | note; original kind: partnership |';
const ROW2 = '| 2 | Beta claim | fact | 0.8 | private | high | 2026-02-02 |  | call |  |';
const BEFORE = page(facts(ROW1, ROW2));

/** Validate `after` against `before` with the issues Tier 1 found on `before`. */
function check(before: FencePage, after: FencePage, ctx: FenceCtx = PRIVATE, tier: ValidateCtx['tier'] = 'llm') {
  const found = normalizeFences(before, ctx);
  const issues: FenceLocation[] = [...found.fixes, ...found.residual];
  return validateFenceRepair(before, after, { ...ctx, tier, issues });
}
const gateOf = (r: ReturnType<typeof check>) => (r.ok ? 'ok' : r.gate);

describe('a correct repair passes', () => {
  test('the Tier 1 kind_map output passes every gate', () => {
    expect(check(BEFORE, page(facts(ROW1_FIXED, ROW2)), PRIVATE, 'deterministic')).toEqual({ ok: true });
  });

  test('a page that compiles validates against itself, even under a header with an unmapped column name', () => {
    const odd = page(facts(ROW2).replace('| notability |', '| salience |'));
    expect(check(odd, odd)).toEqual({ ok: true });
  });

  test('a close_fence repair passes', () => {
    const before = page([FB, FH, ROW2, '', ''].join('\n'));
    const r = normalizeFences(before, PRIVATE);
    expect(r.fixes.map(f => f.class)).toEqual(['close_fence']);
    expect(check(before, r.page, PRIVATE, 'deterministic')).toEqual({ ok: true });
  });
});

describe('one adversarial repair per gate', () => {
  test('(a) still_invalid: a residual warning remains', () => {
    const r = check(BEFORE, BEFORE);
    expect(r).toMatchObject({ ok: false, gate: 'a', reason: 'still_invalid', fence: 'facts', section: 'body' });
  });

  test('(e) row_count_changed: a dropped row', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED)));
    expect(r).toMatchObject({ ok: false, gate: 'e', reason: 'row_count_changed', rows: [2] });
  });

  test('(e) row_count_changed: closing after the first of two row blocks strands the second', () => {
    const body = [FB, FH, ROW2, '', '| 3 | Gamma claim | fact | 0.8 | private | high |  |  | call |  |', ''].join('\n');
    const stranded = [FB, FH, ROW2, FE, '', '| 3 | Gamma claim | fact | 0.8 | private | high |  |  | call |  |', ''].join('\n');
    expect(normalizeFences(page(body), PRIVATE).residual.map(i => i.reason)).toEqual(['split_rows']);
    expect(gateOf(check(page(body), page(stranded)))).toBe('e');
    expect(sanitizeRemoteBody(body)).not.toContain('Gamma claim');
    expect(sanitizeRemoteBody(body)).not.toContain('Beta claim');
  });

  test('(b) claim_changed: claim text edited', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED, ROW2.replace('Beta claim', 'Beta claim, edited'))));
    expect(r).toMatchObject({ ok: false, gate: 'b', reason: 'claim_changed', rows: [2] });
  });

  test('(b) claim_changed: rows reordered', () => {
    expect(gateOf(check(BEFORE, page(facts(ROW2, ROW1_FIXED))))).toBe('b');
  });

  test('(c) row_number_changed: a valid, unique row number moved', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED, ROW2.replace('| 2 |', '| 3 |'))));
    expect(r).toMatchObject({ ok: false, gate: 'c', reason: 'row_number_changed', rows: [2] });
  });

  test('(d) visibility_loosened: private became world', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED, ROW2.replace('private', 'world'))));
    expect(r).toMatchObject({ ok: false, gate: 'd', reason: 'visibility_loosened', rows: [2] });
  });

  test('(d) an invalid visibility becomes world only through public on a world page', () => {
    const before = page(facts('| 1 | Delta claim | fact | 0.9 | public | medium |  |  |  |  |'));
    const world = page(facts('| 1 | Delta claim | fact | 0.9 | world | medium |  |  |  |  |'));
    expect(gateOf(check(before, world, PRIVATE))).toBe('d');
    expect(gateOf(check(before, world, { pageVisibility: 'world' }))).toBe('ok');
    const team = page(facts('| 1 | Delta claim | fact | 0.9 | team | medium |  |  |  |  |'));
    expect(gateOf(check(team, world, { pageVisibility: 'world' }))).toBe('d');
  });

  test('(f) cell_changed: a valid confidence edited', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED, ROW2.replace('0.8', '0.7'))));
    expect(r).toMatchObject({ ok: false, gate: 'f', reason: 'cell_changed', rows: [2] });
  });

  test('(g) protection_loosened: closing a fence before trailing prose would publish the prose', () => {
    const before = page([FB, FH, ROW2, '', 'TRAILING-NOTE stays private'].join('\n'));
    const after = page([FB, FH, ROW2, FE, '', 'TRAILING-NOTE stays private'].join('\n'));
    expect(check(before, after, { pageVisibility: 'world' })).toMatchObject({ ok: false, gate: 'g', reason: 'protection_loosened' });
    expect(validateFenceRepair(before, after, { pageVisibility: 'private', tier: 'llm', issues: [] })).toMatchObject({ ok: false, gate: 'g' });
  });

  test('(g) admits exactly the tail a close_fence_trailing fix shows, and nothing else (#6377)', () => {
    const before = page([FB, FH, ROW2, '', 'TRAILING-NOTE becomes visible'].join('\n'));
    const after = page([FB, FH, ROW2, FE, '', 'TRAILING-NOTE becomes visible'].join('\n'));
    expect(check(before, after)).toEqual({ ok: true });
    const more = page([FB, FH, ROW2, FE, '', 'TRAILING-NOTE becomes visible', 'ANOTHER line nobody approved'].join('\n'));
    expect(check(before, more)).toMatchObject({ ok: false, gate: 'g', reason: 'protection_loosened' });
  });

  test('failures are location-only', () => {
    const r = check(BEFORE, page(facts(ROW1_FIXED, ROW2.replace('Beta claim', 'Beta claim, edited'))));
    expect(JSON.stringify(r)).not.toContain('Beta');
  });
});

describe('gate (f): Tier 3 stubs (TE2)', () => {
  const gapRow = '| 2 | Zeta claim | fact | 0.9 | private | medium | 2026-02-02 | call |';
  const gapBefore = page(facts(ROW2.replace('| 2 |', '| 1 |'), gapRow));

  test('realigning a middle-gap row (cells move, text unchanged) passes', () => {
    const realigned = page(facts(ROW2.replace('| 2 |', '| 1 |'), '| 2 | Zeta claim | fact | 0.9 | private | medium | 2026-02-02 |  | call |  |'));
    expect(check(gapBefore, realigned)).toEqual({ ok: true });
  });

  test('editing a moved cell\'s text fails', () => {
    const edited = page(facts(ROW2.replace('| 2 |', '| 1 |'), '| 2 | Zeta claim | fact | 0.9 | private | medium | 2026-02-02 |  | a call |  |'));
    expect(gateOf(check(gapBefore, edited))).toBe('f');
  });

  const takesBefore = page(takes(
    '| 1 | Eta take | take | brain | 0.6 | 2026-01 | standup |',
    '| 2 | Theta take | take | brain | 0.5 |',
  ));
  const fixedShort = '| 2 | Theta take | take | brain | 0.5 |  |  |';
  test.each([
    ['weight', '| 1 | Eta take | take | brain | 0.7 | 2026-01 | standup |'],
    ['holder', '| 1 | Eta take | take | world | 0.6 | 2026-01 | standup |'],
    ['since', '| 1 | Eta take | take | brain | 0.6 | 2026-02 | standup |'],
    ['source', '| 1 | Eta take | take | brain | 0.6 | 2026-01 | review |'],
  ])('a stub that copies claims but edits a valid %s fails', (_, row1) => {
    expect(check(takesBefore, page(takes('| 1 | Eta take | take | brain | 0.6 | 2026-01 | standup |', fixedShort)))).toEqual({ ok: true });
    expect(gateOf(check(takesBefore, page(takes(row1, fixedShort))))).toBe('f');
  });

  test.each([
    ['confidence', ROW2.replace('0.8', '0.85')],
    ['context', ROW2.replace('| call |  |', '| call | added note |')],
    ['since date', ROW2.replace('2026-02-02', '2026-02-03')],
  ])('a stub that edits a valid facts %s fails', (_, row2) => {
    expect(gateOf(check(BEFORE, page(facts(ROW1_FIXED, row2))))).toBe('f');
  });

  test('kind_map must keep the original word in context', () => {
    const dropped = '| 1 | Alpha claim | fact | 0.9 | private | medium | 2026-01-01 |  | call | note |';
    expect(gateOf(check(BEFORE, page(facts(dropped, ROW2))))).toBe('f');
  });
});

describe('verified holders', () => {
  const before = page(takes('| 1 | Iota take | take | Alice Example | 0.6 | 2026-01 | call |'));
  const resolved = page(takes('| 1 | Iota take | take | people/alice-example | 0.6 | 2026-01 | call |'));

  test('a holder change passes only when Tier 2 verified that exact slug', () => {
    const verified: FenceCtx = { ...PRIVATE, verifiedHolders: new Map([['Alice Example', 'people/alice-example']]) };
    expect(check(before, resolved, verified, 'resolver')).toEqual({ ok: true });
    expect(gateOf(check(before, resolved, PRIVATE))).toBe('f');
    const other = page(takes('| 1 | Iota take | take | people/alice-other | 0.6 | 2026-01 | call |'));
    expect(gateOf(check(before, other, verified))).toBe('f');
  });

  test('assistant-style holders may only become brain', () => {
    const system = page(takes('| 1 | Kappa take | take | System | 0.6 | 2026-01 | call |'));
    expect(gateOf(check(system, page(takes('| 1 | Kappa take | take | brain | 0.6 | 2026-01 | call |'))))).toBe('ok');
    expect(gateOf(check(system, page(takes('| 1 | Kappa take | take | world | 0.6 | 2026-01 | call |'))))).toBe('f');
  });
});

describe('fixed point', () => {
  test('Tier 1 output is a fixed point; a malformed page or a model output with an enum variant is not', () => {
    expect(isFenceFixedPoint(normalizeFences(BEFORE, PRIVATE).page, PRIVATE)).toBe(true);
    expect(isFenceFixedPoint(BEFORE, PRIVATE)).toBe(false);
    expect(isFenceFixedPoint(page(facts(ROW2.replace('high', 'very_high'))), PRIVATE)).toBe(false);
  });
});
