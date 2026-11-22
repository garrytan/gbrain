/**
 * #9104: a Markdown table has no blank lines, so readGrep read a whole table
 * as one paragraph and a match in one row returned every row. Each row is
 * now its own record; prose paragraphs are unchanged.
 */
import { expect, test } from 'bun:test';
import { readGrep } from '../src/core/ops/get-page-slice.ts';

async function* stream(s: string): AsyncGenerator<Buffer> { yield Buffer.from(s); }

const rows = Array.from({ length: 40 }, (_, i) => `| ${i + 1} | fact number ${i + 1} |`);
const doc = ['# Page', '', '| # | fact |', '|---|---|', ...rows, 'trailing prose line', '', 'tail'].join('\n') + '\n';

test('grep at context 0 on one table row returns only that row', async () => {
  const out = await readGrep(stream(doc), 'fact number 7 ', 0, 100_000, (t) => t) as { grep: { blocks: Array<{ line_start: number; line_end: number; text: string }> } };
  expect(out.grep.blocks).toEqual([expect.objectContaining({ line_start: 11, line_end: 11, text: '| 7 | fact number 7 |' })]);
});

test('pipe lines inside a code fence stay one paragraph', async () => {
  const code = ['# Page', '', '```', '| a', '| needle here', '| c', '```', ''].join('\n');
  const out = await readGrep(stream(code), 'needle', 0, 100_000, (t) => t) as { grep: { blocks: Array<{ line_start: number; line_end: number }> } };
  expect(out.grep.blocks).toEqual([expect.objectContaining({ line_start: 3, line_end: 7 })]);
});

test('context counts neighbouring rows, and prose after a table stays its own paragraph', async () => {
  const near = await readGrep(stream(doc), 'fact number 7 ', 1, 100_000, (t) => t) as { grep: { blocks: Array<{ line_start: number; line_end: number }> } };
  expect(near.grep.blocks).toEqual([expect.objectContaining({ line_start: 10, line_end: 12 })]);
  const prose = await readGrep(stream(doc), 'trailing prose', 0, 100_000, (t) => t) as { grep: { blocks: Array<{ line_start: number; line_end: number; text: string }> } };
  expect(prose.grep.blocks).toEqual([expect.objectContaining({ line_start: 45, line_end: 45, text: 'trailing prose line' })]);
});
