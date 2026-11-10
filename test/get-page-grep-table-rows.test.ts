/**
 * #9104: a grep match in one Markdown table row returns that row, not the
 * whole table (a table has no blank lines, so it was one paragraph).
 * Fails when: grep on a fence row returns the rows around it at context 0.
 */
import { expect, test } from 'bun:test';
import { readGrep } from '../src/core/ops/get-page-slice.ts';

async function* chunks(s: string): AsyncGenerator<Buffer> {
  yield Buffer.from(s);
}

test('grep context 0 on a table row returns only that row', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => `| ${i + 1} | fact number ${i + 1} |`);
  const doc = ['# Page', '', '| # | fact |', '|---|---|', ...rows, '', 'tail'].join('\n') + '\n';
  const out = await readGrep(chunks(doc), 'fact number 7 ', 0, 100000, t => t) as any;
  const blocks = out.grep.blocks;
  expect(blocks.length).toBe(1);
  expect(blocks[0].line_start).toBe(11);
  expect(blocks[0].line_end).toBe(11);
  expect(blocks[0].text).toBe('| 7 | fact number 7 |');
});
