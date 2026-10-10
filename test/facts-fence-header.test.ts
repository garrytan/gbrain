/**
 * #6385: the facts fence reads each cell by the column its header names.
 * An unknown, repeated or missing required column reads no rows (so every
 * rewrite refuses and the repair lane maps the header), a reordered
 * canonical header reads correctly, and the row width is column-aware: only
 * trailing optional columns may be left off, and a cell past the layout must
 * be empty. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import {
  FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, parseFactsFence, renderFactsTable, upsertFactRow, type ParsedFact,
} from '../src/core/facts-fence.ts';

const CANONICAL = ['#', 'claim', 'kind', 'confidence', 'visibility', 'notability', 'valid_from', 'valid_until', 'source', 'context',
  'claim_metric', 'claim_value', 'claim_unit', 'claim_period'];
const ROW = ['1', 'Synthetic product launch', 'event', '1.0', 'private', 'high', '2026-01-01', '', 'synthetic-fixture', '', '', '', '', ''];
const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
const fence = (header: readonly string[], ...rows: Array<readonly string[]>) =>
  [FB, line(header), line(header.map(() => '---')), ...rows.map(line), FE].join('\n');

describe('the three cases from the issue', () => {
  test('an `event_type` 15th column reads no rows, whatever its value, and says which column', () => {
    for (const value of ['launch', 'user', '']) {
      const parsed = parseFactsFence(fence([...CANONICAL, 'event_type'], [...ROW, value]));
      expect(parsed.facts).toEqual([]);
      expect(parsed.warnings).toEqual(['FACTS_TABLE_MALFORMED: unsupported header column "event_type"']);
    }
  });

  test('an `attributed_to` 15th column is read as the speaker', () => {
    const parsed = parseFactsFence(fence([...CANONICAL, 'attributed_to'], [...ROW, 'user']));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => [f.claim, f.attributedTo])).toEqual([['Synthetic product launch', 'user']]);
  });
});

describe('header mapping', () => {
  test('a reordered canonical header reads every cell by its column', () => {
    const header = ['kind', 'claim', '#', 'source', 'visibility', 'confidence', 'notability', 'valid_from', 'valid_until', 'context'];
    const parsed = parseFactsFence(fence(header, ['preference', 'Prefers async updates', '7', 'chat', 'world', '0.8', 'low', '2026-02-01', '', 'standup']));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => [f.rowNum, f.claim, f.kind, f.confidence, f.visibility, f.notability, f.validFrom, f.source, f.context]))
      .toEqual([[7, 'Prefers async updates', 'preference', 0.8, 'world', 'low', '2026-02-01', 'chat', 'standup']]);
  });

  test('a takes-shaped header inside a facts fence is refused', () => {
    const parsed = parseFactsFence(fence(['#', 'claim', 'kind', 'who', 'weight', 'since', 'source'], ['1', 'Synthetic take', 'take', 'brain', '0.5', '2026-01', 'notes']));
    expect(parsed.facts).toEqual([]);
    expect(parsed.warnings).toEqual(['FACTS_TABLE_MALFORMED: unsupported header column "who"']);
  });

  test('a repeated column and a missing required column are refused', () => {
    const repeated = parseFactsFence(fence([...CANONICAL.slice(0, 10), 'source'], [...ROW.slice(0, 10), 'other']));
    expect([repeated.facts, repeated.warnings]).toEqual([[], ['FACTS_TABLE_MALFORMED: duplicate header column "source"']]);
    const header = CANONICAL.slice(0, 10).filter(c => c !== 'notability');
    const missing = parseFactsFence(fence(header, ROW.slice(0, 10).filter((_, i) => i !== 5)));
    expect([missing.facts, missing.warnings]).toEqual([[], ['FACTS_TABLE_MALFORMED: header has no "notability" column']]);
  });

  test('an alias the repair lane knows (`conf`) is not read by the strict parser', () => {
    const parsed = parseFactsFence(fence(CANONICAL.slice(0, 10).map(c => c === 'confidence' ? 'conf' : c), ROW.slice(0, 10)));
    expect([parsed.facts, parsed.warnings]).toEqual([[], ['FACTS_TABLE_MALFORMED: unsupported header column "conf"']]);
  });
});

describe('column-aware row width', () => {
  const reordered = ['claim', 'kind', 'confidence', 'visibility', 'notability', 'valid_from', 'valid_until', '#', 'context', 'source'];
  const cells = ['Reordered claim', 'fact', '1.0', 'private', 'medium', '2026-03-01', '', '4', 'ctx', 'call'];

  test('a row may leave off a trailing optional column, never a required one', () => {
    const optionalLast = ['claim', 'kind', 'confidence', 'visibility', 'notability', 'valid_from', 'valid_until', '#', 'source', 'context'];
    const ok = parseFactsFence(fence(optionalLast, ['Short context', 'fact', '1.0', 'private', 'medium', '2026-03-01', '', '4', 'call']));
    expect([ok.warnings, ok.facts.map(f => [f.rowNum, f.source, f.context])]).toEqual([[], [[4, 'call', undefined]]]);
    const short = parseFactsFence(fence(reordered, cells.slice(0, 9)));
    expect(short.facts).toEqual([]);
    expect(short.warnings).toHaveLength(1);
    expect(short.warnings[0]).toStartWith('FACTS_TABLE_MALFORMED: only 9 cells in row');
  });

  test('a non-empty cell past the layout refuses the row; an empty one is ignored', () => {
    const extra = parseFactsFence(fence(reordered, [...cells, 'stray']));
    expect(extra.facts).toEqual([]);
    expect(extra.warnings[0]).toMatch(/^FACTS_TABLE_MALFORMED: 11 cells in row .*, more than its 10 columns$/);
    const empty = parseFactsFence(fence(reordered, [...cells, '']));
    expect([empty.warnings, empty.facts.map(f => f.rowNum)]).toEqual([[], [4]]);
    const past = parseFactsFence(fence([...CANONICAL, 'attributed_to'], [...ROW, 'user', 'stray']));
    expect([past.facts, past.warnings.length]).toEqual([[], 1]);
  });

  test('under a canonical-order header the typed cells after it keep their canonical position (the 14-cell typed row)', () => {
    const parsed = parseFactsFence(fence(CANONICAL.slice(0, 10), ['1', 'ARR claim', 'fact', '1.0', 'private', 'high', '', '', 'board', '', 'arr', '2.5M', 'USD', 'annual']));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => [f.claimMetric, f.claimValue, f.claimUnit, f.claimPeriod])).toEqual([['arr', 2_500_000, 'USD', 'annual']]);
  });
});

describe('rewrites', () => {
  const base: ParsedFact = { rowNum: 1, claim: 'First claim', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true };

  test('render -> parse -> render is a fixed point for every layout', () => {
    for (const rows of [[base], [base, { ...base, rowNum: 2, claim: 'Typed', claimMetric: 'mrr', claimValue: 50000 }],
      [base, { ...base, rowNum: 2, claim: 'Said', attributedTo: 'assistant' as const }]]) {
      const once = renderFactsTable(rows);
      const parsed = parseFactsFence(once);
      expect(parsed.warnings).toEqual([]);
      expect(renderFactsTable(parsed.facts)).toBe(once);
    }
  });

  test('an append to a reordered fence keeps every cell of the existing row, written in canonical order', () => {
    const body = `# Page\n\n${fence(['kind', 'claim', '#', 'source', 'visibility', 'confidence', 'notability', 'valid_from', 'valid_until', 'context'],
      ['preference', 'Prefers async updates', '7', 'chat', 'world', '0.8', 'low', '2026-02-01', '', 'standup'])}\n`;
    const out = upsertFactRow(body, { claim: 'New claim', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium' });
    const parsed = parseFactsFence(out.body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => [f.rowNum, f.claim, f.kind, f.confidence, f.visibility, f.notability, f.source, f.context]))
      .toEqual([[7, 'Prefers async updates', 'preference', 0.8, 'world', 'low', 'chat', 'standup'], [8, 'New claim', 'fact', 1, 'private', 'medium', undefined, undefined]]);
  });

  test('an append to a fence with an unsupported header column refuses instead of rewriting the header', () => {
    const body = fence([...CANONICAL, 'event_type'], [...ROW, 'user']);
    expect(() => upsertFactRow(body, { claim: 'New claim', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium' }))
      .toThrow(/facts fence does not parse cleanly/);
  });
});
