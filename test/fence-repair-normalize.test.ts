/**
 * Tier 1 fence normalizer (#6188): one fixture per failure class in the
 * issue's table, every rule and residual class, prior-aware renumbering,
 * Invariant 0, idempotence and the location-only privacy rule. All content
 * is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, parseTakesFence } from '../src/core/takes-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import {
  FENCE_RULES_VERSION, nextFreeRowNum, normalizeFences, safeNormalizeFences,
} from '../src/core/fence-repair/normalize.ts';
import { strictPageClean } from '../src/core/fence-repair/page-checks.ts';
import { validateFenceRepair } from '../src/core/fence-repair/validate.ts';
import { FENCE_REASONS, fenceMessage, issueLocation } from '../src/core/fence-repair/reasons.ts';
import type { FenceCtx, FencePage, FenceReason, StoredRowMap } from '../src/core/fence-repair/types.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const FS = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const TH = '| # | claim | kind | who | weight | since | source |';
const TS = '|---|-------|------|-----|--------|-------|--------|';
const PRIVATE: FenceCtx = { pageVisibility: 'private' };
const WORLD: FenceCtx = { pageVisibility: 'world' };

const factsRow = (n: string | number, claim: string, o: Partial<Record<'kind' | 'conf' | 'vis' | 'not' | 'from' | 'src' | 'ctx', string>> = {}) =>
  `| ${n} | ${claim} | ${o.kind ?? 'fact'} | ${o.conf ?? '1.0'} | ${o.vis ?? 'private'} | ${o.not ?? 'medium'} | ${o.from ?? '2026-01-01'} |  | ${o.src ?? 'call'} | ${o.ctx ?? ''} |`;
const takesRow = (n: string | number, claim: string, o: Partial<Record<'kind' | 'who' | 'w' | 'since' | 'src', string>> = {}) =>
  `| ${n} | ${claim} | ${o.kind ?? 'take'} | ${o.who ?? 'brain'} | ${o.w ?? '0.5'} | ${o.since ?? '2026-01'} | ${o.src ?? 'notes'} |`;
const facts = (...rows: string[]) => ['## Facts', '', FB, '', FH, FS, ...rows, FE, ''].join('\n');
const takes = (...rows: string[]) => ['## Takes', '', TB, TH, TS, ...rows, TE, ''].join('\n');
const page = (compiled_truth: string, timeline = ''): FencePage => ({ compiled_truth, timeline });

function run(body: string, ctx: FenceCtx = PRIVATE, timeline = '') {
  const before = page(body, timeline);
  return { before, ...normalizeFences(before, ctx) };
}

/** A clean repair: compiles, passes every gate, and is a fixed point. */
function expectRepaired(r: ReturnType<typeof run>, ctx: FenceCtx = PRIVATE) {
  expect(r.residual).toEqual([]);
  expect(strictPageClean(r.page)).toBe(true);
  expect(validateFenceRepair(r.before, r.page, { ...ctx, tier: 'deterministic', issues: [...r.fixes, ...r.residual] })).toEqual({ ok: true });
  expect(normalizeFences(r.page, ctx).fixes).toEqual([]);
}

const classes = (r: { fixes: Array<{ class: string }> }) => [...new Set(r.fixes.map(f => f.class))].sort();
const reasons = (r: { residual: Array<{ reason: FenceReason }> }) => [...new Set(r.residual.map(i => i.reason))].sort();

describe('issue #6188 failure classes', () => {
  test('FACTS_FENCE_UNBALANCED: a missing end marker with only blank lines after the table is closed', () => {
    const body = ['## Facts', '', FB, '', FH, FS, factsRow(1, 'Alpha claim'), factsRow(2, 'Beta claim'), '', ''].join('\n');
    const r = run(body);
    expect(classes(r)).toEqual(['close_fence']);
    expect(r.page.compiled_truth).toBe(['## Facts', '', FB, '', FH, FS, factsRow(1, 'Alpha claim'), factsRow(2, 'Beta claim'), FE, '', ''].join('\n'));
    expectRepaired(r);
  });

  test('TAKES_FENCE_UNBALANCED: a takes fence at the end of the section is closed', () => {
    const r = run(['## Takes', '', TB, TH, TS, takesRow(1, 'Gamma take')].join('\n'));
    expect(r.page.compiled_truth.endsWith(`${takesRow(1, 'Gamma take')}\n${TE}`)).toBe(true);
    expectRepaired(r);
  });

  test('TABLE_MALFORMED short rows from a non-canonical takes table are realigned under the canonical header', () => {
    const body = ['## Takes', '', TB, '| Holder | Claim | Kind | Confidence | Source |', '|---|---|---|---|---|',
      '| brain | Delta take | take | 0.7 | standup |', '| world | Epsilon take | fact | 1.0 | report |', TE].join('\n');
    const r = run(body);
    expect(classes(r)).toEqual(['header_alias', 'renumber']);
    const parsed = parseTakesFence(r.page.compiled_truth);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.takes.map(t => [t.rowNum, t.claim, t.holder, t.weight, t.source])).toEqual([
      [1, 'Delta take', 'brain', 0.7, 'standup'], [2, 'Epsilon take', 'world', 1, 'report']]);
    expectRepaired(r);
  });

  test('TABLE_MALFORMED short row with a middle gap stays residual and the row is untouched', () => {
    const gap = '| 2 | Zeta claim | fact | 0.9 | private | medium | 2026-02-02 | call |';
    const r = run(facts(factsRow(1, 'Eta claim'), gap));
    expect(reasons(r)).toEqual(['short_row']);
    expect(r.page.compiled_truth).toContain(gap);
    expect(FENCE_REASONS.short_row.tier).toBe('llm');
  });

  test.each([
    ['partnership', 'fact'], ['signal', 'fact'], ['funding', 'fact'], ['investment', 'fact'], ['role', 'fact'],
    ['claim', 'fact'], ['observation', 'fact'], ['[kind]', 'fact'], ['insight', 'belief'], ['frame', 'belief'],
    ['proposal', 'idea'], ['promise', 'commitment'], ['milestone', 'event'],
  ])('FACTS unknown kind %s maps to %s and keeps the word in context', (word, kind) => {
    const r = run(facts(factsRow(1, 'Theta claim', { kind: word, ctx: 'from a call' })));
    expect(classes(r)).toEqual(['kind_map']);
    const [fact] = parseFactsFence(r.page.compiled_truth).facts;
    expect(fact!.kind).toBe(kind as never);
    expect(fact!.context).toBe(`from a call; original kind: ${word}`);
    expectRepaired(r);
  });

  test.each([['assessment', 'take'], ['strategic position', 'take'], ['recommendation', 'take'], ['forecast', 'bet'], ['intuition', 'hunch']])(
    'TAKES unknown kind %s maps to %s through the explicit synonym table', (word, kind) => {
      const r = run(takes(takesRow(1, 'Iota take', { kind: word })));
      expect(parseTakesFence(r.page.compiled_truth).takes[0]!.kind).toBe(kind);
      expectRepaired(r);
    });

  test('unknown notability critical / very_high maps to high', () => {
    const r = run(facts(factsRow(1, 'Kappa claim', { not: 'critical' }), factsRow(2, 'Lambda claim', { not: 'very_high' })));
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => f.notability)).toEqual(['high', 'high']);
    expect(classes(r)).toEqual(['enum_synonym']);
    expectRepaired(r);
  });

  test('unknown visibility: public and internal tighten to private on a private page; public is world only on a world page', () => {
    const body = facts(factsRow(1, 'Mu claim', { vis: 'public' }), factsRow(2, 'Nu claim', { vis: 'internal' }), factsRow(3, 'Xi claim', { vis: 'shared' }));
    expect(parseFactsFence(run(body, PRIVATE).page.compiled_truth).facts.map(f => f.visibility)).toEqual(['private', 'private', 'private']);
    const world = run(body, WORLD);
    expect(parseFactsFence(world.page.compiled_truth).facts.map(f => f.visibility)).toEqual(['world', 'private', 'private']);
    expectRepaired(world, WORLD);
  });

  test('invalid row_num 0 and TAKES_ROW_NUM_COLLISION are renumbered above every used number', () => {
    const r = run(takes(takesRow(0, 'Omicron take'), takesRow(2, 'Pi take'), takesRow(2, 'Rho take')));
    expect(parseTakesFence(r.page.compiled_truth).takes.map(t => [t.rowNum, t.claim])).toEqual([[3, 'Omicron take'], [2, 'Pi take'], [4, 'Rho take']]);
    expect(r.fixes.filter(f => f.class === 'renumber').map(f => [f.from, f.row])).toEqual([[0, 3], [2, 4]]);
    expectRepaired(r);
  });

  test('TAKES_HOLDER_INVALID: an assistant-style holder maps to brain; a display name waits for Tier 2', () => {
    const r = run(takes(takesRow(1, 'Sigma take', { who: 'System' }), takesRow(2, 'Tau take', { who: 'Alice Example' })));
    expect(r.fixes.map(f => f.class)).toEqual(['holder_alias']);
    expect(r.residual.map(i => [i.reason, i.row, i.column])).toEqual([['holder_unresolved', 2, 'who']]);
    expect(parseTakesFence(r.page.compiled_truth).takes[0]!.holder).toBe('brain');
  });
});

describe('Tier 2 verified holders', () => {
  test('a holder the resolver verified is written; anything else stays residual', () => {
    const ctx: FenceCtx = { ...PRIVATE, verifiedHolders: new Map([['Alice Example', 'people/alice-example']]) };
    const r = run(takes(takesRow(1, 'Upsilon take', { who: 'Alice Example' })), ctx);
    expect(classes(r)).toEqual(['holder_verified']);
    expect(parseTakesFence(r.page.compiled_truth).takes[0]!.holder).toBe('people/alice-example');
    expectRepaired(r, ctx);
  });
});

describe('close_fence and the protection boundary', () => {
  test('two row blocks separated by a blank line are residual split_rows and nothing changes', () => {
    const body = [FB, FH, FS, factsRow(1, 'Phi claim'), '', factsRow(2, 'Chi claim'), ''].join('\n');
    const r = run(body);
    expect(reasons(r)).toEqual(['split_rows']);
    expect(r.page.compiled_truth).toBe(body);
  });

  test('prose after the table on a world page keeps the fence open (tail_exposure_approval) so the boundary never shows it unasked (#6377)', () => {
    const body = [FB, FH, FS, factsRow(1, 'Psi claim'), '', 'TRAILING-PROSE-CANARY stays hidden'].join('\n');
    const r = run(body, WORLD);
    expect(reasons(r)).toEqual(['tail_exposure_approval']);
    expect(r.page.compiled_truth).toBe(body);
    expect(sanitizeRemoteBody(r.page.compiled_truth)).not.toContain('TRAILING-PROSE-CANARY');
    expect(FENCE_REASONS.tail_exposure_approval.autoRetry).toBe(false);
    expect(FENCE_REASONS.tail_exposure_approval.actor).toBe('user');
  });

  test('prose after the table closes the fence on a private page, or on a world page under the user\'s approval (close_fence_trailing, #6377)', () => {
    const body = [FB, FH, FS, factsRow(1, 'Psi claim'), '', 'TRAILING-PROSE-CANARY becomes visible'].join('\n');
    for (const ctx of [PRIVATE, { ...WORLD, approveTailExposure: true }]) {
      const r = run(body, ctx);
      expect(r.fixes.map(f => f.class)).toEqual(['close_fence_trailing']);
      expect(r.residual).toEqual([]);
      expect(r.page.compiled_truth).toBe([FB, FH, FS, factsRow(1, 'Psi claim'), FE, '', 'TRAILING-PROSE-CANARY becomes visible'].join('\n'));
      expect(sanitizeRemoteBody(r.page.compiled_truth)).toContain('TRAILING-PROSE-CANARY');
      expectRepaired(r, ctx);
    }
  });

  test('a trailing line with a pipe waits for the tail classifier; a marker mention is manual (#6377)', () => {
    const piped = [FB, FH, FS, factsRow(1, 'Psi claim'), '', 'a note with a | in it'].join('\n');
    expect(reasons(run(piped))).toEqual(['unclosed_trailing_content']);
    expect(FENCE_REASONS.unclosed_trailing_content.tier).toBe('llm');
    const judged = run(piped, { ...PRIVATE, tailProse: new Set(['body:facts']) });
    expect(judged.fixes.map(f => f.class)).toEqual(['close_fence_trailing']);
    expect(judged.page.compiled_truth).toContain(`${FE}\n\na note with a | in it`);
    expect(reasons(run(piped, { ...WORLD, tailProse: new Set(['*']) }))).toEqual(['tail_exposure_approval']);
    const mention = [FB, FH, FS, factsRow(1, 'Psi claim'), '', 'the marker gbrain:facts:end is only mentioned here'].join('\n');
    expect(reasons(run(mention))).toEqual(['unclosed_ambiguous_tail']);
  });

  test('an end marker with no begin is never guessed', () => {
    const body = ['## Facts', '', FH, factsRow(1, 'Omega claim'), FE].join('\n');
    const r = run(body);
    expect(reasons(r)).toEqual(['missing_begin']);
    expect(r.page.compiled_truth).toBe(body);
  });

  test('a repeated marker that merge_fences cannot merge (text inside the repeat) is manual and nothing changes', () => {
    const body = [facts(factsRow(1, 'Alpha two', { kind: 'signal' })), facts(factsRow(2, 'Beta two'), 'A note inside the fence.')].join('\n');
    const r = run(body);
    expect(reasons(r)).toContain('repeated_marker');
    expect(r.page.compiled_truth).toBe(body);
  });
});

describe('marker_form', () => {
  test('two-dash takes markers above a table become the canonical form', () => {
    const body = ['## Takes', '', '<!-- gbrain:takes:begin -->', '', TH, TS, takesRow(1, 'Gamma two'), '<!-- gbrain:takes:end -->', ''].join('\n');
    const r = run(body);
    expect(classes(r)).toEqual(['marker_form']);
    expect(r.page.compiled_truth).toBe(['## Takes', '', TB, '', TH, TS, takesRow(1, 'Gamma two'), TE, ''].join('\n'));
    expectRepaired(r);
  });

  test('a page that mentions the two-dash form in prose is not rewritten', () => {
    const body = 'Authors sometimes write\n<!-- gbrain:takes:begin -->\nfrom memory; that is not a fence.\n';
    const r = run(body);
    expect(reasons(r)).toEqual(['marker_near_miss']);
    expect(r.page).toBe(r.before);
  });

  test('a two-dash facts fence with a table parses clean today and stays byte-identical', () => {
    const body = ['## Facts', '', '<!-- gbrain:facts:begin -->', FH, FS, factsRow(1, 'Delta two', { kind: 'partnership' }), '<!-- gbrain:facts:end -->'].join('\n');
    const r = run(body);
    expect(r.page).toBe(r.before);
    expect(r.fixes).toEqual([]);
  });
});

describe('renumber (prior-aware)', () => {
  const stored = (factsRows: Array<[number, string]>, takesRows: Array<[number, string]> = []): StoredRowMap =>
    ({ facts: new Map(factsRows), takes: new Map(takesRows) });

  test('the stored second occurrence keeps its number; the first is renumbered', () => {
    const ctx = { ...PRIVATE, storedRows: stored([[1, 'Stored claim']]) };
    const r = run(facts(factsRow(1, 'New claim'), factsRow(1, 'Stored claim')), ctx);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => [f.rowNum, f.claim])).toEqual([[2, 'New claim'], [1, 'Stored claim']]);
    expectRepaired(r, ctx);
  });

  test('a freed highest number (stored, gone from the fence) is never reused', () => {
    const ctx = { ...PRIVATE, storedRows: stored([[1, 'Kept claim'], [9, 'Deleted claim']]) };
    const r = run(facts(factsRow(1, 'Kept claim'), factsRow(1, 'Another claim')), ctx);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => f.rowNum)).toEqual([1, 10]);
  });

  test('struck rows in the other section count as used numbers', () => {
    const timeline = facts(factsRow(7, '~~Struck claim~~', { ctx: 'forgotten: asked' }));
    const r = run(facts(factsRow(0, 'Fresh claim')), PRIVATE, timeline);
    expect(parseFactsFence(r.page.compiled_truth).facts[0]!.rowNum).toBe(8);
    expect(r.page.timeline).toBe(timeline);
  });

  test('a duplicate across body and timeline is renumbered once, in the fence that was already malformed', () => {
    const body = facts(factsRow(1, 'Body claim', { kind: 'signal' }));
    const timeline = facts(factsRow(1, 'Timeline claim'));
    const r = run(body, PRIVATE, timeline);
    expect(r.page.timeline).toBe(timeline);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => f.rowNum)).toEqual([2]);
    expectRepaired(r);
  });

  test('a duplicate across two clean sections renumbers the later occurrence', () => {
    const r = run(facts(factsRow(1, 'Body only')), PRIVATE, facts(factsRow(1, 'Timeline only')));
    expect(r.page.compiled_truth).toBe(r.before.compiled_truth);
    expect(parseFactsFence(r.page.timeline).facts.map(f => f.rowNum)).toEqual([2]);
    expectRepaired(r);
  });

  test('superseded by #N naming a duplicated N is residual (facts context)', () => {
    const r = run(facts(factsRow(2, 'One'), factsRow(2, 'Two'), factsRow(3, '~~Three~~', { ctx: 'superseded by #2' })));
    expect(reasons(r)).toEqual(['superseded_ambiguous']);
    expect(r.residual.map(i => [i.row, i.line])).toEqual([[2, 7], [2, 8]]);
    expect(FENCE_REASONS.superseded_ambiguous.manualOnly).toBe(true);
  });

  test('superseded by #N naming a duplicated N is residual (takes source)', () => {
    const r = run(takes(takesRow(4, 'Old take'), takesRow(4, 'Other take'), takesRow(5, '~~Older take~~', { src: 'call; superseded by #4' })));
    expect(reasons(r)).toEqual(['superseded_ambiguous']);
  });

  test('hidden rows are never renumbered and their numbers are never handed out', () => {
    const ctx = { ...PRIVATE, hiddenRows: new Set([5, 12]) };
    const r = run(facts(factsRow(5, 'Caller row'), factsRow(0, 'Needs a number')), ctx);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => f.rowNum)).toEqual([5, 13]);
  });

  test('a header without a # column mints numbers the same way', () => {
    const body = [FB, '| claim | kind | confidence | visibility | notability |', factsRow(0, 'x').replace(/.*/, '| Minted one | fact | 0.9 | private | low |'), FE].join('\n');
    const ctx = { ...PRIVATE, storedRows: stored([[3, 'Old stored']]) };
    const r = run(body, ctx);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => [f.rowNum, f.claim, f.confidence])).toEqual([[4, 'Minted one', 0.9]]);
    expectRepaired(r, ctx);
  });
});

describe('header rules', () => {
  test('header_alias moves raw cells into canonical order and keeps their exact text', () => {
    const body = [FB, '| # | claim | type | visibility | confidence | notability | date | valid_until | source | context |',
      '| 1 | Kappa two | fact | private | 0.9 | high | 2026-04-29T18:30:00Z |  | call |  |', FE].join('\n');
    const r = run(body);
    expect(classes(r)).toEqual(['header_alias']);
    expect(r.page.compiled_truth).toContain('| 1 | Kappa two | fact | 0.9 | private | high | 2026-04-29T18:30:00Z |  | call |  |');
    expectRepaired(r);
  });

  test('column_default fills required facts columns absent from the whole header', () => {
    const body = [FB, '| # | claim | kind | source |', '|---|---|---|---|', '| 1 | Lambda two | fact | call |', FE].join('\n');
    const r = run(body);
    expect(classes(r)).toEqual(['column_default', 'header_alias']);
    expect(r.fixes.filter(f => f.class === 'column_default').map(f => f.column).sort()).toEqual(['confidence', 'notability', 'visibility']);
    const [fact] = parseFactsFence(r.page.compiled_truth).facts;
    expect([fact!.confidence, fact!.notability, fact!.visibility, fact!.source]).toEqual([1, 'medium', 'private', 'call']);
    expectRepaired(r);
  });

  test('an unmappable column is residual header_unmapped (Tier 3)', () => {
    const r = run([FB, '| # | claim | kind | mood |', '| 1 | Mu two | fact | calm |', FE].join('\n'));
    expect(reasons(r)).toEqual(['header_unmapped']);
    expect(FENCE_REASONS.header_unmapped.tier).toBe('llm');
  });

  test('a takes table inside a facts fence is manual', () => {
    const r = run([FB, TH, TS, takesRow(1, 'Nu two'), FE].join('\n'));
    expect(reasons(r)).toEqual(['takes_in_facts']);
  });

  test('takes with no weight column, or no holder column, are manual', () => {
    expect(reasons(run([TB, '| # | claim | kind | who |', '| 1 | Xi two | take | brain |', TE].join('\n')))).toEqual(['weight_missing']);
    expect(reasons(run([TB, '| # | claim | kind | weight |', '| 1 | Pi two | take | 0.5 |', TE].join('\n')))).toEqual(['holder_missing']);
  });

  test('a fence with rows and no header is Tier 3', () => {
    expect(reasons(run([FB, factsRow(1, 'Rho two'), FE].join('\n')))).toEqual(['no_header']);
  });
});

describe('cell rules', () => {
  test('confidence_format: percent and stray inner whitespace; out of range is manual', () => {
    const r = run(facts(factsRow(1, 'Sigma two', { conf: '85%' }), factsRow(2, 'Tau two', { conf: '0. 9' }), factsRow(3, 'Upsilon two', { conf: '1.5' })));
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => f.confidence)).toEqual([0.85, 0.9]);
    expect(r.residual.map(i => [i.reason, i.row, i.column])).toEqual([['confidence_out_of_range', 3, 'confidence']]);
  });

  test('unmapped enum words and invalid claim values are manual and name the allowed vocabulary', () => {
    const r = run(facts(factsRow(1, 'Phi two', { vis: 'everyone' })));
    expect(r.residual).toEqual([{ fence: 'facts', section: 'body', row: 1, column: 'visibility', line: 7, reason: 'enum_unmapped', allowed: ['private', 'world'] }]);
    const wide = [FB, `${FH} claim_metric | claim_value | claim_unit | claim_period |`,
      '| 1 | Chi two | fact | 1.0 | private | medium |  |  |  |  | arr | lots | USD | annual |', FE].join('\n');
    expect(reasons(run(wide))).toEqual(['claim_value_invalid']);
  });

  test('takes kinds outside the synonym table and pack-declared kinds are never coerced', () => {
    const ctx: FenceCtx = { ...PRIVATE, takesPackKinds: ['thesis', 'view'] };
    const r = run(takes(takesRow(1, 'Psi two', { kind: 'wibble' }), takesRow(2, 'Omega three', { kind: 'thesis' }), takesRow(3, 'Alpha three', { kind: 'view' })), ctx);
    expect(r.residual.map(i => [i.reason, i.row])).toEqual([['takes_kind_unsupported', 1], ['takes_kind_unsupported', 2], ['takes_kind_unsupported', 3]]);
    expect(r.fixes).toEqual([]);
    expect(FENCE_REASONS.takes_kind_unsupported.manualOnly).toBe(true);
  });

  test('an empty takes weight is weight_missing; a word is out of range', () => {
    const r = run(takes(takesRow(1, 'Beta three', { w: '' }), takesRow(2, 'Gamma three', { w: 'high' })));
    expect(r.residual.map(i => i.reason)).toEqual(['weight_missing', 'confidence_out_of_range']);
  });

  test('a 9-cell facts row gains a context cell only when kind_map needs one', () => {
    const body = [FB, FH, '| 1 | Delta three | opinion | 1.0 | private | medium |  |  | call |', FE].join('\n');
    const r = run(body);
    expect(r.page.compiled_truth).toContain('| 1 | Delta three | belief | 1.0 | private | medium |  |  | call | original kind: opinion |');
    expectRepaired(r);
  });
});

describe('Invariant 0', () => {
  test('a page that compiles is returned unchanged (same object), including 9-cell facts and 6-cell takes rows', () => {
    const body = [FB, FH, '| 1 | Epsilon three | fact | 1.0 | private | medium |  |  | call |', FE, '', TB, TH, '| 1 | Zeta three | take | brain | 0.5 | 2026-01 |', TE].join('\n');
    const r = run(body);
    expect(r.page).toBe(r.before);
    expect([r.fixes, r.residual]).toEqual([[], []]);
  });

  test('a marker-free page does no work', () => {
    const before = page('Just prose | with a pipe |\n');
    expect(normalizeFences(before, PRIVATE).page).toBe(before);
  });

  test('a clean section stays byte-identical when the other section is repaired', () => {
    const body = takes(takesRow(1, 'Eta three'));
    const r = run(body, PRIVATE, facts(factsRow(1, 'Theta three', { kind: 'funding' })));
    expect(r.page.compiled_truth).toBe(body);
    expectRepaired(r);
  });

  test('markers quoted in code are examples: never closed, renumbered or rewritten', () => {
    const example = ['```markdown', FB, FH, factsRow(0, 'Example row', { kind: 'partnership' }), '```'].join('\n');
    const body = `${example}\n\n${facts(factsRow(1, 'Iota three', { kind: 'pledge' }))}`;
    const r = run(body);
    expect(r.page.compiled_truth.startsWith(example)).toBe(true);
    expect(r.fixes.map(f => [f.class, f.line])).toEqual([['kind_map', 13]]);
    expectRepaired(r);
  });

  test('normalize is idempotent and its output is a fixed point', () => {
    const r = run(facts(factsRow(0, 'Kappa three', { kind: 'signal', vis: 'team', not: 'minor', conf: '70%' })));
    const again = normalizeFences(r.page, PRIVATE);
    expect(again.page).toBe(r.page);
    expect(again.fixes).toEqual([]);
  });
});

describe('location-only privacy', () => {
  test('unique claim, holder, kind and context strings never appear in fixes, residual or messages', () => {
    const sentinels = ['CLAIMSENTINEL7781', 'HOLDERSENTINEL7781', 'KINDSENTINEL7781', 'CONTEXTSENTINEL7781'];
    const body = [
      facts(factsRow(0, `${sentinels[0]} one`, { kind: sentinels[2]!, ctx: sentinels[3]!, vis: 'nowhere' })),
      takes(takesRow(1, `${sentinels[0]} two`, { who: `Mr ${sentinels[1]}`, kind: sentinels[2]! }), takesRow(1, 'other', { kind: 'wibble' })),
    ].join('\n');
    const r = run(body);
    const messages = r.residual.map(i => fenceMessage(issueLocation(i)));
    const surface = JSON.stringify([r.fixes, r.residual, messages]);
    for (const s of sentinels) expect(surface).not.toContain(s);
    expect(r.residual.length).toBeGreaterThan(0);
  });

  test('every manual-only residual names the exact place to edit', () => {
    const r = run(facts(factsRow(1, 'Lambda three', { vis: 'everyone' })));
    const message = fenceMessage(issueLocation(r.residual[0]!));
    expect(message).toBe('Fence enum_unmapped: in the facts fence (body), row 1, column visibility, at line 7. '
      + 'Column(s) `visibility` of row(s) 1 in the facts fence (body, line 7) hold a value gbrain cannot map. Use one of `private`, `world`.');
  });
});

describe('containment and the allocator', () => {
  test('safeNormalizeFences turns a throw into residual normalizer_failed and returns the page unchanged', () => {
    const body = facts(factsRow(1, 'Mu three', { kind: 'signal' }));
    let reads = 0;
    const exploding = { timeline: '', get compiled_truth() { if (++reads > 1) throw new Error('boom'); return body; } } as FencePage;
    expect(() => normalizeFences(exploding, PRIVATE)).toThrow('boom');
    reads = 0;
    const r = safeNormalizeFences(exploding, PRIVATE);
    expect(r.page).toBe(exploding);
    expect(r.fixes).toEqual([]);
    expect(r.residual.map(i => i.reason)).toEqual(['normalizer_failed']);
    expect(FENCE_REASONS.normalizer_failed.autoRetry).toBe(false);
  });

  test('safeNormalizeFences returns what normalizeFences returns when nothing throws', () => {
    const before = page(facts(factsRow(1, 'Nu three', { kind: 'signal' })));
    expect(safeNormalizeFences(before, PRIVATE)).toEqual(normalizeFences(before, PRIVATE));
  });

  test('nextFreeRowNum never returns a number used on the page or in stored rows', () => {
    const body = [facts(factsRow(3, 'Xi three'), factsRow(11, '~~Struck~~', { kind: 'bogus' })), takes(takesRow(20, 'Omicron three'))].join('\n');
    const timeline = facts(factsRow(15, 'Pi three'));
    expect(nextFreeRowNum(page(body, timeline))).toBe(21);
    expect(nextFreeRowNum(page(body, timeline), { facts: new Map([[40, 'gone']]), takes: new Map() })).toBe(41);
    expect(nextFreeRowNum(page(''))).toBe(1);
  });

  test('FENCE_RULES_VERSION is a positive integer', () => {
    expect(Number.isInteger(FENCE_RULES_VERSION) && FENCE_RULES_VERSION > 0).toBe(true);
  });
});

describe('stray empty cells and split claims (#6188 T4)', () => {
  const wide = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |';
  const wideSep = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|';

  test('one empty cell inserted after the claim is removed; every other byte of the row stays', () => {
    const r = run(facts(factsRow(1, 'Omicron four'), '| 2 | Rho four opened a lab |  | event | 0.7 | private | low | 2026-05-01 |  | site visit |  |'));
    expect(classes(r)).toEqual(['stray_empty_cell']);
    expect(r.page.compiled_truth).toContain('| 2 | Rho four opened a lab | event | 0.7 | private | low | 2026-05-01 |  | site visit |  |');
    expectRepaired(r);
    expect(parseFactsFence(r.page.compiled_truth).facts[1]).toMatchObject({ kind: 'event', source: 'site visit' });
  });

  test('two empty cells, a typed wide row and a takes row with an empty cell after the holder line up the same way', () => {
    const two = run(facts('| 3 | Sigma four cut prices 15% |  | event |  | 0.8 | private | medium | 2026-06-01 |  | price list |  |'));
    expect(two.page.compiled_truth).toContain('| 3 | Sigma four cut prices 15% | event | 0.8 | private | medium | 2026-06-01 |  | price list |  |');
    expectRepaired(two);
    const typed = run(['## Facts', '', FB, wide, wideSep, '| 4 | Tau four margin |  | fact | 0.9 | private | high | 2026-06-30 |  | report |  | margin | 0.4 | ratio | quarterly |', FE, ''].join('\n'));
    expect(typed.page.compiled_truth).toContain('| 4 | Tau four margin | fact | 0.9 | private | high | 2026-06-30 |  | report |  | margin | 0.4 | ratio | quarterly |');
    expectRepaired(typed);
    const take = run(takes(takesRow(1, 'Upsilon four'), '| 2 | Phi four ships late | bet | people/sample-person |  | 0.3 | 2026-02-02 | standup |'));
    expect(take.page.compiled_truth).toContain('| 2 | Phi four ships late | bet | people/sample-person | 0.3 | 2026-02-02 | standup |');
    expectRepaired(take);
  });

  test('extra cells no empty-cell deletion can line up are manual extra_cells and the row is untouched', () => {
    const duplicate = '| 5 | Chi four expands | fact | 0.6 | 0.9 | private | medium | 2026-01-01 |  | memo |  |';
    const text = '| 6 | Psi four moved | (relocated) | event | 0.8 | private | medium | 2026-01-10 |  | email |  |';
    for (const row of [duplicate, text]) {
      const r = run(facts(row));
      expect(reasons(r)).toEqual(['extra_cells']);
      expect(r.fixes).toEqual([]);
      expect(r.page.compiled_truth).toContain(row);
    }
    expect(FENCE_REASONS.extra_cells).toMatchObject({ tier: 'manual', manualOnly: true });
  });

  test('kind_map reads only a kind word: a claim tail in the kind column is manual claim_split, never a kind note', () => {
    const tails = ['after a long search, per the board', 'and then the whole team left the office', 'see [the memo](https://example.com/m)', '~~struck~~ words'];
    for (const tail of tails) {
      const row = `| 7 | Omega four hired a CFO | ${tail} | 0.8 | private | high | 2026-03-01 |  | memo |  |`;
      const r = run(facts(row));
      expect(reasons(r)).toEqual(['claim_split']);
      expect(r.fixes).toEqual([]);
      expect(r.page.compiled_truth).toContain(row);
    }
    expect(FENCE_REASONS.claim_split).toMatchObject({ tier: 'manual', manualOnly: true });
    const phrase = run(facts(factsRow(8, 'Alpha five', { kind: 'strategic partnership update' })));
    expect(classes(phrase)).toEqual(['kind_map']);
    expectRepaired(phrase);
  });
});

describe('fences with no header: rows read by their row number (#6188 T4)', () => {
  const headerless = (...rows: string[]) => ['## Facts', '', FB, ...rows, FE, ''].join('\n');

  test('a claim an unescaped pipe cut in two is held manual, never sent to the model; the row is untouched', () => {
    const sentence = '| 4 | Synthco revenue grew 40% | mostly from enterprise renewals | fact | 0.9 | private | high | 2026-06-30 |  | Q2 memo |  |';
    const short = '| 5 | Synthco churn fell | in Q3 | fact | 0.8 | private | medium | 2026-07-01 |  | dashboard |  |';
    for (const [row, reason] of [[sentence, 'claim_split'], [short, 'extra_cells']] as const) {
      const r = run(headerless(factsRow(1, 'Synthco anchor row'), row));
      expect(reasons(r)).toEqual([reason, 'no_header'].sort() as FenceReason[]);
      expect(r.fixes).toEqual([]);
      expect(r.page.compiled_truth).toContain(row);
      expect(FENCE_REASONS[reason].manualOnly).toBe(true);
    }
  });

  test('a stray empty cell is still removed; aligned rows, and rows with no row number to anchor them, stay plain no_header', () => {
    const r = run(headerless('| 6 | Synthco opened a lab |  | event | 0.7 | private | low | 2026-05-01 |  | site visit |  |'));
    expect(classes(r)).toEqual(['stray_empty_cell']);
    expect(reasons(r)).toEqual(['no_header']);
    expect(r.page.compiled_truth).toContain('| 6 | Synthco opened a lab | event | 0.7 | private | low | 2026-05-01 |  | site visit |  |');
    expect(reasons(run(headerless(factsRow(1, 'Synthco aligned row'), '| 2 | Synthco short row | idea | 0.4 | private | low |')))).toEqual(['no_header']);
    expect(reasons(run(headerless('| Synthco unnumbered row | event | 0.8 | private | low | 2026-02-01 |  | press note |  |')))).toEqual(['no_header']);
  });
});
