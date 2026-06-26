import { test, expect } from 'bun:test';
import { templateSummary, tableChunksFor } from '../src/core/office/table.ts';
import { emptyLocator, type DocBlock, type SourceLocator } from '../src/core/office/types.ts';
import type { OfficeConfig } from '../src/core/office/config.ts';

function tableBlock(loc: SourceLocator, columns: string[], markdown = ''): DocBlock {
  return {
    id: 't',
    type: 'table',
    level: null,
    markdown,
    text: '',
    order: 0,
    locator: loc,
    table: { header_rows: 1, n_rows: 3, n_cols: columns.length, columns, rows: [] },
    asset_ref: null,
  };
}

// Minimal config — tableChunksFor only reads these two fields (template path).
const TEMPLATE_CFG = { tableSummaryEnabled: false, tableSummaryModel: null } as unknown as OfficeConfig;

test('templateSummary names the sheet for an xlsx table', () => {
  const s = templateSummary(tableBlock({ ...emptyLocator(), sheet: 'Q1Sales' }, ['Quarter', 'Revenue']));
  expect(s).toContain('in sheet "Q1Sales"');
  expect(s).toContain('columns: Quarter, Revenue');
});

test('templateSummary prefers page/slide over sheet, and is bare with no locator', () => {
  expect(templateSummary(tableBlock({ ...emptyLocator(), page: 5 }, ['A']))).toContain('on page 5');
  expect(templateSummary(tableBlock({ ...emptyLocator(), slide: 2 }, ['A']))).toContain('on slide 2');
  expect(templateSummary(tableBlock(emptyLocator(), ['A']))).toMatch(/^Table: /);
});

test('tableChunksFor propagates the sheet locator to summary + rows chunks', async () => {
  const block = tableBlock({ ...emptyLocator(), sheet: 'Regions' }, ['Region', 'Count'], '| Region | Count |\n|---|---|\n| West | 5 |');
  const chunks = await tableChunksFor(block, TEMPLATE_CFG);
  expect(chunks.length).toBe(2); // summary + rows
  expect(chunks.map((c) => c.chunk_source)).toEqual(['table_summary', 'table_rows']);
  expect(chunks.every((c) => (c.source_locator as SourceLocator).sheet === 'Regions')).toBe(true);
  expect(chunks[0].chunk_text).toContain('in sheet "Regions"');
});
