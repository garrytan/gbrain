/**
 * #9711: the comparison form of `repair file-drift` (no `--prefer`) lists pages without an `exceptions` array;
 * rendering its details must not throw.
 */
import { expect, test } from 'bun:test';
import { fileDriftRepair } from '../src/core/repair/file-drift.ts';

test('render of compare details with pages that carry no exceptions returns lines', () => {
  let lines: string[] | null = null;
  let threw = false;
  try {
    lines = fileDriftRepair.render!({ compare: true, writes: 'none',
      pages: [{ slug: 'brain/product/x', would: 'prefer_file', why: 'the file is newer', evidence: null }],
      next_actions: ['review the newer file'] } as never, { diff: false });
  } catch { threw = true; }
  expect(threw).toBe(false);
  expect(lines).toContain('  review the newer file');
});
