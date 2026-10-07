/**
 * Raw-row extraction for fence repair (#6188): layouts, the positional
 * fallback, escapes and source spans, rows before the header, before-regions
 * of unclosed fences, code-quoted markers, near-miss takes markers and row
 * identity. The strict-parser differential over every suite fixture lives in
 * fence-repair-fixtures.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE } from '../src/core/takes-fence.ts';
import { extractRawRows, primaryFence, rowNumOf, type RawFence } from '../src/core/fence-repair/raw-rows.ts';
import { CANONICAL_HEADER } from '../src/core/fence-repair/schema.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const TH = '| # | claim | kind | who | weight | since | source |';

function only(text: string, kind: 'facts' | 'takes'): RawFence {
  const fence = primaryFence(extractRawRows(text), kind);
  if (!fence) throw new Error(`no ${kind} fence`);
  return fence;
}
const columnsOf = (fence: RawFence, k = 0) => Object.fromEntries([...fence.rows[k]!.byColumn].map(([c, cell]) => [c, cell.text]));

describe('layouts', () => {
  test('facts rows of 9, 10 and 14 cells map to canonical columns and are accepted', () => {
    const text = [FB, FH,
      '| 1 | Nine cells | fact | 1.0 | private | medium |  |  | call |',
      '| 2 | Ten cells | fact | 0.9 | world | low | 2026-01-01 |  | call | ctx |',
      '| 3 | Fourteen cells | fact | 0.8 | private | high |  |  |  |  | arr | 2.5M | USD | annual |', FE].join('\n');
    const fence = only(text, 'facts');
    expect(fence.rows.map(r => [r.cells.length, r.accepted, r.shape])).toEqual([[9, true, 'ok'], [10, true, 'ok'], [14, true, 'ok']]);
    expect(columnsOf(fence, 2)).toMatchObject({ claim: 'Fourteen cells', claim_value: '2.5M', claim_period: 'annual' });
    expect(fence.needsRewrite).toBe(false);
  });

  test('takes rows of 6, 7 and 13 cells; resolution columns are read by header name', () => {
    const wide = `${TH} resolved | quality | evidence | value | unit | by |`;
    const text = [TB, wide,
      '| 1 | Six cells | take | brain | 0.5 | 2026-01 |',
      '| 2 | Seven cells | bet | world | 0.7 | 2026-02 | notes |',
      '| 3 | Thirteen cells | bet | brain | 0.6 | 2026-03 | notes | 2026-06 | correct | memo | 12 | usd | brain |', TE].join('\n');
    const fence = only(text, 'takes');
    expect(fence.rows.map(r => r.accepted)).toEqual([true, true, true]);
    expect(columnsOf(fence, 2)).toMatchObject({ who: 'brain', quality: 'correct', by: 'brain' });
  });

  test('the canonical header text matches what the renderers emit', () => {
    const fact = { rowNum: 1, claim: 'c', kind: 'fact' as const, confidence: 1, visibility: 'private' as const, notability: 'low' as const, active: true };
    expect(renderFactsTable([fact])).toContain(`${CANONICAL_HEADER.facts.narrow}\n${CANONICAL_HEADER.facts.narrowSep}`);
    expect(renderFactsTable([{ ...fact, claimMetric: 'arr' }])).toContain(`${CANONICAL_HEADER.facts.wide}\n${CANONICAL_HEADER.facts.wideSep}`);
    const take = { rowNum: 1, claim: 'c', kind: 'take', holder: 'brain', weight: 0.5, active: true };
    expect(renderTakesFence([take])).toContain(`${CANONICAL_HEADER.takes.narrow}\n${CANONICAL_HEADER.takes.narrowSep}`);
    expect(renderTakesFence([{ ...take, resolvedQuality: 'correct' as const }])).toContain(`${CANONICAL_HEADER.takes.wide}\n${CANONICAL_HEADER.takes.wideSep}`);
  });

  test('an alias header (no `kind` token) is recognized and maps through aliases', () => {
    const fence = only([TB, '| Holder | Claim | Type | Confidence | Source |', '| brain | Aliased | take | 0.4 | notes |', TE].join('\n'), 'takes');
    expect(fence.strictHeader).toBe(false);
    expect(fence.columns).toEqual(['who', 'claim', 'kind', 'weight', 'source']);
    expect(fence.needsRewrite).toBe(true);
    expect(columnsOf(fence)).toEqual({ who: 'brain', claim: 'Aliased', kind: 'take', weight: '0.4', source: 'notes' });
    expect(fence.rows[0]!.accepted).toBe(false);
  });

  test('with no recognizable header, rows read positionally and the fence reports no_header', () => {
    const fence = only([FB, '| 7 | Headless | fact | 1.0 | private | low |  |  | call |', FE].join('\n'), 'facts');
    expect(fence.header).toBeNull();
    expect(fence.rows[0]!.beforeHeader).toBe(true);
    expect(columnsOf(fence)).toMatchObject({ '#': '7', claim: 'Headless', kind: 'fact' });
    expect(fence.issues.map(i => i.reason)).toEqual(['no_header']);
  });
});

describe('cells, spans and identity', () => {
  test('an escaped pipe stays in its cell, <br> decodes, and spans point at the source text', () => {
    const text = [FB, FH, '| 1 | A \\| B<br>C | fact | 1.0 | private | medium |  |  | call |  |', FE].join('\n');
    const fence = only(text, 'facts');
    const claim = fence.rows[0]!.byColumn.get('claim')!;
    expect(claim.text).toBe('A | B\nC');
    expect(claim.raw).toBe('A \\| B<br>C');
    expect(text.slice(claim.start, claim.end)).toBe(claim.raw);
    for (const cell of fence.rows[0]!.cells) expect(text.slice(cell.start, cell.end)).toBe(cell.raw);
  });

  test('row identity is the ordinal among data rows, independent of row number and claim', () => {
    const fence = only([FB, '| 3 | Early | fact |', FH, '|---|---|', '| 3 | Same | fact | 1.0 | private | low |  |  | x |', '| 3 | Same | fact | 1.0 | private | low |  |  | x |', FE].join('\n'), 'facts');
    expect(fence.rows.map(r => [r.occurrence, r.beforeHeader, rowNumOf(fence, r)])).toEqual([[0, true, 3], [1, false, 3], [2, false, 3]]);
    expect(fence.separators).toHaveLength(1);
    expect(fence.issues.map(i => [i.reason, i.line])).toEqual([['row_before_header', 2]]);
  });

  test('rows that miss a middle cell or carry extra cells are flagged', () => {
    const fence = only([FB, FH, '| 1 | Short | fact | 1.0 | private | medium |  | x |', '| 2 | Extra | partner | ship | 1.0 | private | medium |  |  | x |  | y |', FE].join('\n'), 'facts');
    expect(fence.rows.map(r => r.shape)).toEqual(['short_row', 'extra_cells']);
  });
});

describe('markers and regions', () => {
  test('an unclosed fence\'s before-region runs to the end of the section', () => {
    const text = [FB, FH, '| 1 | Open | fact | 1.0 | private | low |  |  | x |  |', '', 'trailing'].join('\n');
    const fence = only(text, 'facts');
    expect(fence.end).toBeNull();
    expect(fence.regionEnd).toBe(text.length);
  });

  test('markers quoted in code are not fences', () => {
    const text = ['```markdown', FB, FH, '| 1 | Example | fact |', FE, '```', 'Inline `' + TB + '` mention.'].join('\n');
    expect(extractRawRows(text).fences).toEqual([]);
  });

  test('a stray end marker before any begin reports missing_begin', () => {
    const raw = extractRawRows([FH, '| 1 | Orphan | fact |', FE].join('\n'));
    expect(raw.issues.map(i => [i.fence, i.reason, i.line])).toEqual([['facts', 'missing_begin', 3]]);
  });

  test('a second fence of the same kind is a repeat on the primary fence', () => {
    const block = [FB, FH, FE].join('\n');
    const raw = extractRawRows(`${block}\n${block}`);
    expect(raw.fences.map(f => f.primary)).toEqual([true, false]);
    expect(primaryFence(raw, 'facts')!.issues.map(i => i.reason)).toEqual(['repeated_marker']);
  });

  test('a two-dash takes marker alone on its line is a near-miss fence; in prose it is reported, not a fence', () => {
    const fence = only(['<!-- gbrain:takes:begin -->', TH, '| 1 | Near | take | brain | 0.5 | 2026 | x |', '<!--gbrain:takes:end-->'].join('\n'), 'takes');
    expect([fence.begin.nearMiss, fence.end?.nearMiss, fence.rows.length, fence.rows[0]!.accepted]).toEqual([true, true, 1, false]);
    const prose = extractRawRows('See the gbrain:takes:begin marker docs.');
    expect([prose.fences.length, prose.issues.map(i => i.reason)]).toEqual([0, ['marker_near_miss']]);
  });

  test('a two-dash facts marker is not a fence (it parses clean today)', () => {
    expect(extractRawRows(['<!-- gbrain:facts:begin -->', FH, '<!-- gbrain:facts:end -->'].join('\n')).fences).toEqual([]);
  });

  test('CRLF line endings: spans exclude the carriage return and lines are numbered', () => {
    const text = [FB, FH, '| 1 | Windows | fact | 1.0 | private | low |  |  | x |  |', FE].join('\r\n');
    const fence = only(text, 'facts');
    expect(fence.rows[0]!.line).toBe(3);
    expect(text.slice(fence.rows[0]!.start, fence.rows[0]!.end).endsWith('|')).toBe(true);
    expect(fence.rows[0]!.accepted).toBe(true);
  });
});
