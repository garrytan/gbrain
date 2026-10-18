/**
 * #6898 follow-up: factsFenceEditor is upsertFactRow + strikeFactRowInPage for
 * a whole batch, parsed and rendered once.
 *
 * Protects: for every page shape the managed fact preparer meets (an existing
 * fence, typed claims, attribution, pipes and odd spacing in cells, no fence
 * yet, a fence below the timeline sentinel, strikes in the edited section and
 * in the other one, an unparsable fence) the editor leaves exactly the page
 * the one-row-at-a-time calls leave, and refuses where they refuse.
 */
import { describe, expect, test } from 'bun:test';
import { factsFenceEditor, factsFenceSection, strikeFactRowInPage, upsertFactRow, type NewFactRow } from '../src/core/facts-fence.ts';

type Page = { compiled_truth: string; timeline: string };
type Edit = { row: NewFactRow & { rowNum: number }; strike?: number };

const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const fence = (rows: string[]) => `## Facts\n\n<!--- gbrain:facts:begin -->\n${HEADER}\n${rows.join('\n')}\n<!--- gbrain:facts:end -->\n`;
const row = (rowNum: number, claim: string, extra: Partial<NewFactRow> = {}): NewFactRow & { rowNum: number } => ({
  rowNum, claim, kind: 'fact', confidence: 0.9, visibility: 'private', notability: 'medium', validFrom: '2026-01-02', source: 'fixture', ...extra });

function sequential(page: Page, edits: Edit[]): Page {
  const section = factsFenceSection(page);
  let next = { ...page };
  for (const edit of edits) {
    next = { ...next, [section]: upsertFactRow(next[section], edit.row).body };
    if (edit.strike !== undefined) next = strikeFactRowInPage(next, edit.strike, edit.row.rowNum);
  }
  return next;
}
function batched(page: Page, edits: Edit[]): Page {
  const editor = factsFenceEditor(page, factsFenceSection(page));
  for (const edit of edits) {
    editor.append(edit.row);
    if (edit.strike !== undefined) editor.strike(edit.strike, edit.row.rowNum);
  }
  return editor.page();
}

const EXISTING = [
  '| 1 | Founded acme-example | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |',
  '|2|  Lives in Paris  |fact|0.8|private|medium|2018-01-01|2020-01-01|chat|moved later|',
  '| 3 | ~~Old title~~ | fact | 1.0 | private | low | 2016-01-01 |  | chat | superseded by #1 |',
];
const EDITS: Edit[] = [
  { row: row(4, 'Prefers weekly reports') },
  { row: row(5, 'Moved to Berlin', { context: 'relocation' }), strike: 2 },
  { row: row(6, 'Revenue a | b split', { claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly' }) },
  { row: row(7, 'Said the plan works', { attributedTo: 'assistant' }) },
  { row: row(8, 'Replaces the replacement'), strike: 5 },
  { row: row(9, 'Strike of a missing row'), strike: 42 },
];

describe('factsFenceEditor matches one-row-at-a-time upserts', () => {
  const cases: Array<[string, Page]> = [
    ['an existing fence in the body', { compiled_truth: `# Alice\n\nIntro.\n\n${fence(EXISTING)}\nAfter.\n`, timeline: '' }],
    ['no fence yet', { compiled_truth: '# Alice\n\nIntro only.\n', timeline: '' }],
    ['no fence yet, with a timeline', { compiled_truth: '# Alice\n\nIntro.\n', timeline: '- 2026-01-01 met' }],
    ['a lone fence in the timeline', { compiled_truth: '# Alice\n', timeline: `- 2026-01-01 met\n\n${fence(EXISTING)}` }],
  ];
  for (const [name, page] of cases) {
    test(name, () => {
      for (let n = 1; n <= EDITS.length; n++) expect(batched(page, EDITS.slice(0, n))).toEqual(sequential(page, EDITS.slice(0, n)));
    });
  }

  test('a strike in the other section is applied where strikeFactRowInPage applies it', () => {
    const page = { compiled_truth: `# Alice\n\n${fence(['| 1 | Body row | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |'])}`,
      timeline: `${fence(['| 2 | Timeline row | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |'])}` };
    const edits: Edit[] = [{ row: row(3, 'New'), strike: 2 }, { row: row(4, 'Newer'), strike: 1 }];
    expect(batched(page, edits)).toEqual(sequential(page, edits));
  });

  test('no appended row leaves the page untouched', () => {
    const page = { compiled_truth: `# Alice\n\n${fence(EXISTING)}`, timeline: '' };
    expect(factsFenceEditor(page, 'compiled_truth').page()).toBe(page);
  });

  test('an unparsable fence refuses at the first append, as upsertFactRow does', () => {
    const page = { compiled_truth: `# Alice\n\n${fence([...EXISTING, '| 4 | short row |'])}`, timeline: '' };
    expect(() => upsertFactRow(page.compiled_truth, row(5, 'x'))).toThrow();
    const editor = factsFenceEditor(page, 'compiled_truth');
    expect(() => editor.append(row(5, 'x'))).toThrow(
      (() => { try { upsertFactRow(page.compiled_truth, row(5, 'x')); } catch (e) { return (e as Error).message; } return 'no refusal'; })());
  });
});
