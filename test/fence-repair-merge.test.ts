/**
 * Tier 1 `merge_fences` (#6377): a section with several balanced fences of
 * a kind becomes one fence; the validator checks the result row by row
 * through the merge mapping; the receipt carries the mapping location-only.
 * All content is synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, parseTakesFence } from '../src/core/takes-fence.ts';
import { normalizeFences } from '../src/core/fence-repair/normalize.ts';
import { mergedReceipt } from '../src/core/fence-repair/merge.ts';
import { strictPageClean } from '../src/core/fence-repair/page-checks.ts';
import { FENCE_REPAIR_ACTOR, parseFenceRepairReceipt, type FenceRepairReceipt } from '../src/core/fence-repair/receipt.ts';
import { FENCE_REASONS, renderFenceFix } from '../src/core/fence-repair/reasons.ts';
import { fenceStep } from '../src/core/fence-repair/tier1.ts';
import { validateFenceRepair } from '../src/core/fence-repair/validate.ts';
import type { FenceCtx, FencePage, FenceReason } from '../src/core/fence-repair/types.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const FS = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const TH = '| # | claim | kind | who | weight | since | source |';
const TS = '|---|-------|------|-----|--------|-------|--------|';
const PRIVATE: FenceCtx = { pageVisibility: 'private' };

const factsRow = (n: string | number, claim: string, o: Partial<Record<'kind' | 'conf' | 'vis' | 'ctx', string>> = {}) =>
  `| ${n} | ${claim} | ${o.kind ?? 'fact'} | ${o.conf ?? '1.0'} | ${o.vis ?? 'private'} | medium | 2026-01-01 |  | call | ${o.ctx ?? ''} |`;
const takesRow = (n: string | number, claim: string, o: Partial<Record<'who' | 'w' | 'src', string>> = {}) =>
  `| ${n} | ${claim} | take | ${o.who ?? 'brain'} | ${o.w ?? '0.5'} | 2026-01 | ${o.src ?? 'notes'} |`;
const facts = (rows: string[], heading = '## Facts', header = FH) => [heading, '', FB, '', header, FS, ...rows, FE, ''].join('\n');
const takes = (rows: string[]) => ['## Takes', '', TB, TH, TS, ...rows, TE, ''].join('\n');
const page = (compiled_truth: string, timeline = ''): FencePage => ({ compiled_truth, timeline });

function run(before: FencePage, ctx: FenceCtx = PRIVATE) {
  return { before, ...normalizeFences(before, ctx) };
}
const classes = (r: { fixes: Array<{ class: string }> }) => [...new Set(r.fixes.map(f => f.class))].sort();
const reasons = (r: { residual: Array<{ reason: FenceReason }> }) => [...new Set(r.residual.map(i => i.reason))].sort();
const validate = (r: ReturnType<typeof run>, after: FencePage = r.page, ctx: FenceCtx = PRIVATE) =>
  validateFenceRepair(r.before, after, { ...ctx, tier: 'deterministic', issues: [...r.fixes, ...r.residual] });

/** A clean Tier 1 repair: no residual, compiles, passes every gate, fixed point. */
function expectRepaired(r: ReturnType<typeof run>, ctx: FenceCtx = PRIVATE) {
  expect(r.residual).toEqual([]);
  expect(strictPageClean(r.page)).toBe(true);
  expect(validate(r, r.page, ctx)).toEqual({ ok: true });
  expect(normalizeFences(r.page, ctx).fixes).toEqual([]);
}

/** The issue's shape: a 3-row fence, then an 85-row fence under a second `## Facts` heading. */
const FIRST = [factsRow(1, 'Alpha claim'), factsRow(2, 'Beta claim'), factsRow(3, 'Gamma claim')];
const SECOND: string[] = [];
for (let i = 1; i <= 85; i++) {
  if (i === 1) SECOND.push(factsRow(1, 'Omega claim')); // collides with #1
  else if (i === 2) SECOND.push(factsRow(2, 'Beta claim')); // exact duplicate, same number
  else if (i === 3) SECOND.push(factsRow(3, 'Delta claim')); // collides with #3
  else if (i === 40) SECOND.push(factsRow(40, 'Alpha claim')); // exact duplicate, other number
  else if (i === 41) SECOND.push(factsRow(41, 'Gamma claim')); // exact duplicate, other number
  else if (i === 50) SECOND.push(factsRow(50, '~~Old fifty~~', { ctx: 'superseded by #3' })); // names this fence's #3
  else SECOND.push(factsRow(i, `Claim ${i}`));
}
const ISSUE_BODY = [facts(FIRST), facts(SECOND)].join('\n');

describe('merge_fences', () => {
  test('two balanced facts fences merge into one: duplicates dropped, collisions renumbered, the reference follows, the second heading goes', () => {
    const r = run(page(ISSUE_BODY));
    expect(classes(r)).toEqual(['merge_fences', 'renumber']);
    expectRepaired(r);
    const expected = [...FIRST, factsRow(86, 'Omega claim'), factsRow(87, 'Delta claim'),
      ...SECOND.slice(3).filter((_, k) => ![40 - 4, 41 - 4].includes(k)).map(line => line.replace('superseded by #3', 'superseded by #87'))];
    expect(r.page.compiled_truth).toBe(facts(expected));
    const parsed = parseFactsFence(r.page.compiled_truth);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.length).toBe(85);
    expect(parsed.facts.find(f => f.rowNum === 50)).toMatchObject({ active: false, supersededBy: 87 });
    expect(parsed.facts.find(f => f.rowNum === 87)!.claim).toBe('Delta claim');
    // Fixes name the before page's lines: the merge at the primary begin marker, each renumber at the row in the second fence.
    expect(r.fixes).toEqual([
      { fence: 'facts', section: 'body', row: null, column: null, line: 3, class: 'merge_fences' },
      { fence: 'facts', section: 'body', row: 86, column: '#', line: 18, class: 'renumber', from: 1 },
      { fence: 'facts', section: 'body', row: 87, column: '#', line: 20, class: 'renumber', from: 3 },
      { fence: 'facts', section: 'body', row: 50, column: 'context', line: 67, class: 'renumber' },
    ]);
    expect(JSON.stringify([r.fixes, r.residual])).not.toMatch(/claim|Alpha|Omega/i);
  });

  test('the receipt mapping names every before row by fence and occurrence, kept or duplicate, and parses back', () => {
    const r = run(page(ISSUE_BODY));
    const merged = mergedReceipt(r.before, r.fixes)!;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ fence: 'facts', section: 'body', fences: 2 });
    expect(merged[0]!.rows).toHaveLength(88);
    expect(merged[0]!.rows.slice(0, 5)).toEqual([
      { occurrence: 0, from_fence: 0, kept_as: 0 }, { occurrence: 1, from_fence: 0, kept_as: 1 }, { occurrence: 2, from_fence: 0, kept_as: 2 },
      { occurrence: 0, from_fence: 1, kept_as: 3 }, { occurrence: 1, from_fence: 1, duplicate_of: 1 },
    ]);
    expect(merged[0]!.rows.filter(row => row.duplicate_of !== undefined)).toEqual([
      { occurrence: 1, from_fence: 1, duplicate_of: 1 }, { occurrence: 39, from_fence: 1, duplicate_of: 0 }, { occurrence: 40, from_fence: 1, duplicate_of: 2 },
    ]);
    expect(merged[0]!.rows.filter(row => row.kept_as !== undefined)).toHaveLength(85);
    expect(JSON.stringify(merged)).not.toMatch(/claim/i);
    const receipt: FenceRepairReceipt = { actor: FENCE_REPAIR_ACTOR, tier: 'deterministic', classes: ['merge_fences', 'renumber'], rows: [50, 86, 87], columns: ['#', 'context'],
      model: null, before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64), cost_usd: 0, merged };
    expect(parseFenceRepairReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    const { merged: _omitted, ...plain } = receipt;
    expect(parseFenceRepairReceipt(plain)).toEqual(plain);
    for (const bad of [
      [{ ...merged[0], rows: [{ occurrence: 0, from_fence: 0, kept_as: 0, duplicate_of: 1 }] }],
      [{ ...merged[0], rows: [{ occurrence: 0, from_fence: 0 }] }],
      [{ ...merged[0], rows: [{ occurrence: 0, from_fence: 2, kept_as: 0 }] }],
      [{ ...merged[0], fences: 1 }],
      [merged[0], merged[0]],
      'merged',
    ]) expect(parseFenceRepairReceipt({ ...receipt, merged: bad })).toBeNull();
    expect(mergedReceipt(page(facts(FIRST)), [])).toBeUndefined();
  });

  test('the coordinated write step admits the merged page as a Tier 1 normalization', () => {
    const step = fenceStep(page(ISSUE_BODY), PRIVATE, { normalize: true });
    expect(step.status).toBe('normalized');
    if (step.status === 'normalized') expect(step.fixes.map(f => f.class)).toContain('merge_fences');
    const off = fenceStep(page(ISSUE_BODY), PRIVATE, { normalize: false });
    expect(off.status).toBe('residual');
    if (off.status === 'residual') expect(off.fixable.map(f => f.class)).toContain('merge_fences');
  });

  test('(b) a claim mutated in the second fence is rejected through the mapping', () => {
    const r = run(page(ISSUE_BODY));
    const after = page(r.page.compiled_truth.replace(factsRow(70, 'Claim 70'), factsRow(70, 'Claim 70, edited')));
    expect(validate(r, after)).toMatchObject({ ok: false, gate: 'b', reason: 'claim_changed', fence: 'facts', section: 'body', rows: [70] });
  });

  test('(e) a dropped row that is not an exact duplicate is rejected', () => {
    const r = run(page(ISSUE_BODY));
    const after = page(r.page.compiled_truth.replace(`${factsRow(70, 'Claim 70')}\n`, ''));
    expect(validate(r, after)).toMatchObject({ ok: false, gate: 'e', reason: 'row_count_changed', fence: 'facts', section: 'body' });
  });

  test('(e) a duplicate the mapping does not name cannot be dropped, and the mapping is re-derived from the before page', () => {
    const body = [facts([factsRow(1, 'Alpha claim')]), facts([factsRow(2, 'Alpha claim', { conf: '0.9' }), factsRow(3, 'Beta claim')])].join('\n');
    const r = run(page(body));
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => [f.rowNum, f.confidence])).toEqual([[1, 1], [2, 0.9], [3, 1]]);
    expectRepaired(r);
    const dropped = page(facts([factsRow(1, 'Alpha claim'), factsRow(3, 'Beta claim')]));
    expect(validate(r, dropped)).toMatchObject({ ok: false, gate: 'e', rows: [3] });
    // A merge fix claimed for a page with one fence has no mapping to vouch for it.
    const single = page(facts([factsRow(1, 'Alpha claim')]));
    expect(validateFenceRepair(single, single, { ...PRIVATE, tier: 'deterministic', issues: r.fixes })).toMatchObject({ ok: false, gate: 'e' });
  });

  test('(f) a reference may follow only its own fence\'s renumbered row; any other reference change is a changed cell', () => {
    const r = run(page(ISSUE_BODY));
    const stray = page(r.page.compiled_truth.replace('superseded by #87', 'superseded by #86'));
    expect(validate(r, stray)).toMatchObject({ ok: false, gate: 'f', reason: 'cell_changed', rows: [50] });
    const unchanged = page(r.page.compiled_truth.replace('superseded by #87', 'superseded by #3'));
    expect(validate(r, unchanged)).toMatchObject({ ok: false, gate: 'f', rows: [50] });
  });

  test('a reference to a dropped duplicate follows the kept row; a kind_map rewrite and the reference share one context cell', () => {
    const body = [facts(FIRST), facts([factsRow(40, 'Alpha claim'), factsRow(41, '~~Old~~', { kind: 'signal', ctx: 'superseded by #40' })])].join('\n');
    const r = run(page(body));
    expect(classes(r)).toEqual(['kind_map', 'merge_fences', 'renumber']);
    expectRepaired(r);
    const old = parseFactsFence(r.page.compiled_truth).facts.find(f => f.rowNum === 41)!;
    expect(old).toMatchObject({ active: false, supersededBy: 1, kind: 'fact', context: 'superseded by #1; original kind: signal' });
  });

  test('near-duplicates (same claim, different confidence) are both kept', () => {
    const body = [facts([factsRow(1, 'Alpha claim')]), facts([factsRow(1, 'Alpha claim', { conf: '0.7' })])].join('\n');
    const r = run(page(body));
    expect(classes(r)).toEqual(['merge_fences', 'renumber']);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => [f.rowNum, f.claim, f.confidence])).toEqual([[1, 'Alpha claim', 1], [2, 'Alpha claim', 0.7]]);
    expectRepaired(r);
  });

  test('a stored row keeps its number, as the renumber rule decides', () => {
    const body = [facts([factsRow(1, 'Alpha claim')]), facts([factsRow(1, 'Stored claim')])].join('\n');
    const stored: FenceCtx = { pageVisibility: 'private', storedRows: { facts: new Map([[1, 'Stored claim']]), takes: new Map() } };
    const r = run(page(body), stored);
    expect(parseFactsFence(r.page.compiled_truth).facts.map(f => [f.rowNum, f.claim])).toEqual([[2, 'Alpha claim'], [1, 'Stored claim']]);
    expectRepaired(r, stored);
  });

  test('takes fences merge the same way', () => {
    const body = [takes([takesRow(1, 'Alpha take'), takesRow(2, 'Beta take')]), takes([takesRow(2, 'Beta take'), takesRow(3, 'Gamma take'), takesRow(1, 'Delta take', { src: 'superseded by #2' })])].join('\n');
    const r = run(page(body));
    expect(classes(r)).toEqual(['merge_fences', 'renumber']);
    expect(r.page.compiled_truth).toBe(takes([takesRow(1, 'Alpha take'), takesRow(2, 'Beta take'), takesRow(3, 'Gamma take'), takesRow(4, 'Delta take', { src: 'superseded by #2' })]));
    expect(parseTakesFence(r.page.compiled_truth).takes.map(t => [t.rowNum, t.claim])).toEqual([[1, 'Alpha take'], [2, 'Beta take'], [3, 'Gamma take'], [4, 'Delta take']]);
    expectRepaired(r);
  });

  test('three fences, a heading that differs, prose between fences and CRLF endings', () => {
    const body = [facts([factsRow(1, 'Alpha claim')]), 'Prose between the fences.', '', facts([factsRow(2, 'Beta claim')], '## More facts'), facts([factsRow(3, 'Gamma claim')]), 'Trailing prose.', '']
      .join('\n').replace(/\n/g, '\r\n');
    const r = run(page(body));
    expect(classes(r)).toEqual(['merge_fences']);
    expect(r.page.compiled_truth).toBe(['## Facts', '', FB, '', FH, FS, factsRow(1, 'Alpha claim'), factsRow(2, 'Beta claim'), factsRow(3, 'Gamma claim'), FE, '', 'Prose between the fences.', '',
      '## More facts', '', 'Trailing prose.', ''].join('\r\n'));
    expectRepaired(r);
    expect(mergedReceipt(r.before, r.fixes)![0]).toMatchObject({ fences: 3 });
  });

  test('the merged page is held `repeated_marker` no longer; the reason table says gbrain merges and names the edit otherwise', () => {
    expect(FENCE_REASONS.repeated_marker.tier).toBe('manual');
    const fix = renderFenceFix({ reason: 'repeated_marker', fence: 'facts', section: 'body', rows: [], columns: [], line: 12 });
    expect(fix).toContain('merge_fences');
    expect(fix).toContain('line 12');
    expect(FENCE_REASONS.repeated_marker.fix).not.toMatch(/\{(?!fence|section|line|rows|columns|allowed)\w+\}/);
  });
});

describe('what stays repeated_marker (manual, nothing changes)', () => {
  const cases: Array<[string, string]> = [
    ['an unbalanced repeat', [facts(FIRST), ['## Facts', '', FB, '', FH, FS, factsRow(9, 'Theta claim'), ''].join('\n')].join('\n')],
    ['a header that does not map', [facts(FIRST), facts([factsRow(9, 'Theta claim')], '## Facts', FH.replace('| notability |', '| salience |'))].join('\n')],
    ['a header in another column order', [facts(FIRST), facts([factsRow(9, 'Theta claim')], '## Facts', FH.replace('| # | claim |', '| claim | # |'))].join('\n')],
    ['stray text inside the repeated fence', [facts(FIRST), facts([factsRow(9, 'Theta claim'), 'A note inside the fence.'])].join('\n')],
    ['stray text inside the primary fence', [facts([...FIRST, 'A note inside the fence.']), facts([factsRow(9, 'Theta claim')])].join('\n')],
    ['a marker sharing its line with text', [facts(FIRST), facts([factsRow(9, 'Theta claim')]).replace(FE, `${FE} trailing words`)].join('\n')],
    ['a repeat whose rows sit above its header', [facts(FIRST), ['## Facts', '', FB, factsRow(9, 'Theta claim'), FH, FS, FE, ''].join('\n')].join('\n')],
    ['a stray end marker besides the two fences', [facts(FIRST), facts([factsRow(9, 'Theta claim')]), FE, ''].join('\n')],
  ];
  for (const [name, body] of cases) {
    test(name, () => {
      const r = run(page(body));
      expect(reasons(r)).toContain('repeated_marker');
      expect(r.fixes.map(f => f.class)).not.toContain('merge_fences');
      expect(r.page.compiled_truth).toBe(body);
      expect(FENCE_REASONS.repeated_marker.manualOnly).toBe(true);
    });
  }

  test('a facts fence in the body and one in the timeline are two sections, not a repeat: nothing merges', () => {
    const before = page(facts(FIRST), facts([factsRow(9, 'Theta claim')]));
    const r = run(before);
    expect(r.page).toBe(before);
    expect(r.fixes).toEqual([]);
    expect(strictPageClean(before)).toBe(true);
  });

  test('a page with a single fence is untouched', () => {
    const before = page(facts(FIRST));
    expect(normalizeFences(before, PRIVATE).page).toBe(before);
    const dirty = page(facts([factsRow(1, 'Alpha claim', { kind: 'signal' })]));
    expect(classes(run(dirty))).toEqual(['kind_map']);
  });
});
