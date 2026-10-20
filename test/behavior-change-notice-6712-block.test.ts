/**
 * #6712 PR 4b (design v3.2 §13; dx-native-3): the PR's BEHAVIOR_CHANGES rows are one tagged block. The registry export
 * carries no tags, so the block is located by a narrow parse of the array literal (each row opens with `{ since: '`, at
 * most a few to a line; the block runs from its marker comment to the next comment or the end of the array) and its rows are then
 * read from the export by index. Pinned: the row count, one `since` for the whole block (the merge-slot stamp replaces the
 * placeholder on every row at once), the block after master's rows (last in the array, no earlier row newer), and every
 * row's text inside the notice's rendered 2,000-character cap.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEHAVIOR_CHANGES, compareReleases } from '../src/core/behavior-change-notice.ts';

const MARKER = '// #6712 PR 4b (the level-triggered sync pass';
const ROWS = 33;
const NOTICE_CAP = 2_000;

/** The array literal's row lines in order, and where the block's rows start and how many there are. */
function locateBlock(source: string): { rowLines: number; first: number; count: number } {
  const lines = source.split('\n');
  const open = lines.findIndex(line => line.startsWith('export const BEHAVIOR_CHANGES'));
  const close = lines.findIndex((line, i) => i > open && line === '];');
  let rowLines = 0, first = -1, count = 0, inBlock = false;
  for (const line of lines.slice(open + 1, close)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(MARKER)) { inBlock = true; first = rowLines; continue; }
    if (trimmed.startsWith('//')) inBlock = false;
    const rows = line.match(/\{ since: '/g)?.length ?? 0;
    rowLines += rows;
    if (inBlock) count += rows;
  }
  return { rowLines, first, count };
}

// test-reads-source-ok[structural]: the block's position, contiguity and since stamp are properties of the array's source order, which the runtime list does not keep apart from master's rows.
const source = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'behavior-change-notice.ts'), 'utf8');

describe('#6712 PR 4b BEHAVIOR_CHANGES block', () => {
  const { rowLines, first, count } = locateBlock(source);
  const block = BEHAVIOR_CHANGES.slice(first, first + count);

  test('the narrow parse sees every exported row and finds the block', () => {
    expect(rowLines).toBe(BEHAVIOR_CHANGES.length);
    expect(first).toBeGreaterThan(0);
  });

  test(`the block has ${ROWS} rows, all with the block's first since`, () => {
    expect(count).toBe(ROWS);
    expect(block.filter(row => row.since !== block[0]!.since).map(row => row.since)).toEqual([]);
  });

  test("the block sits after master's rows: only later releases follow it, and no earlier row is newer", () => {
    expect(BEHAVIOR_CHANGES.slice(first + count).filter(row => row.since !== 'TBD' && compareReleases(row.since, block[0]!.since) <= 0).map(row => row.since)).toEqual([]);
    expect(BEHAVIOR_CHANGES.slice(0, first).filter(row => compareReleases(row.since, block[0]!.since) > 0).map(row => row.since)).toEqual([]);
  });

  test(`every row of the block is plain text inside the rendered ${NOTICE_CAP}-character cap`, () => {
    expect(block.filter(row => typeof row.text !== 'string' || row.text.length > NOTICE_CAP).length).toBe(0);
  });
});
