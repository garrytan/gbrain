/**
 * edit_page's retained diff must stay bounded on large pages: past a cell
 * budget only the changed window is line-diffed, and a window that is
 * itself too large becomes one coarse hunk marked `diff_coarse`.
 *
 * 1. Protects: edit_page on large pages (a one-line edit on a 50k-line page
 *    filled a 2.5-billion-cell LCS table before the fix) and the receipt
 *    diff of every ordinary edit, which stays byte-identical.
 * 2. Fails when: editDiff output changes for pages under the budget
 *    (differential vs the old editDiff), a bounded diff stops applying to
 *    the old text to give the new text (strict applier over a seeded
 *    corpus with small budgets), a no-newline marker appears away from
 *    end-of-file, or the LCS table grows past the budget (fill probe).
 * 3. Existing coverage: test/edit-page.test.ts pins the 8 KB cut and the
 *    50k-line case end to end; test/skillpack-apply-hunks.test.ts pins
 *    unifiedDiff itself against its applier.
 * 4. Seam: boundedUnifiedDiff is exported (@internal) so small budgets
 *    reach the windowed and coarse arms without large inputs.
 */
import { describe, expect, test } from 'bun:test';
import {
  EDIT_PAGE_DIFF_CELL_BUDGET,
  EDIT_PAGE_DIFF_MAX_BYTES,
  boundedUnifiedDiff,
  editDiff,
} from '../../src/core/persistence/page-edit.ts';
import { splitLines, unifiedDiff } from '../../src/core/skillpack/diff-text.ts';
import { redactRetrievalOutput } from '../../src/core/search/output-redaction.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';

const MARKER = '\\ No newline at end of file';

/** editDiff before the cell budget. */
function oracleEditDiff(slug: string, before: string, after: string): { diff: string; diff_truncated?: true } {
  const [{ diff: full }] = redactRetrievalOutput([{ diff: unifiedDiff(before, after, { oldPath: `a/${slug}.md`, newPath: `b/${slug}.md` }) }], {}).results;
  const encoded = (text: string) => Buffer.byteLength(JSON.stringify(text));
  if (encoded(full) <= EDIT_PAGE_DIFF_MAX_BYTES) return { diff: full };
  let kept = '';
  for (const line of full.split('\n')) {
    if (encoded(`${kept}${line}\n`) > EDIT_PAGE_DIFF_MAX_BYTES) break;
    kept += `${line}\n`;
  }
  return { diff: kept, diff_truncated: true };
}

/**
 * Apply a unified diff produced by this repo's writer to `before`, checking
 * every context and removed line, hunk counts, hunk order, and that each
 * no-newline marker sits at end-of-file. A hunk starting at `-s` consumes
 * old lines from index s - 1 (the writer's convention, also for empty
 * old ranges). Returns the new text.
 */
function applyStrict(before: string, diff: string): string {
  const a = splitLines(before);
  if (diff === '') return before;
  const lines = diff.split('\n');
  expect(lines.pop()).toBe('');
  expect(lines[0]!.startsWith('--- ')).toBe(true);
  expect(lines[1]!.startsWith('+++ ')).toBe(true);
  const out: string[] = [];
  let cursor = 0;
  let newLacksNewline = false;
  let k = 2;
  while (k < lines.length) {
    const h = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[k]!);
    expect(h).not.toBeNull();
    const [aStart, aCount, bStart, bCount] = h!.slice(1).map(Number) as [number, number, number, number];
    const at = aStart - 1;
    expect(at).toBeGreaterThanOrEqual(cursor);
    out.push(...a.lines.slice(cursor, at));
    expect(bStart - 1).toBe(out.length);
    let pos = at;
    let added = 0;
    k++;
    while (k < lines.length && !lines[k]!.startsWith('@@ ')) {
      const line = lines[k]!;
      const kind = line[0];
      if (kind === '\\') {
        expect(line).toBe(MARKER);
        const prev = lines[k - 1]![0];
        const twice = lines[k + 1] === MARKER;
        // The marker closes the old side, the new side, or both (twice). A
        // single marker after a context line closes the old side only when
        // that line ended the old text.
        const oldSide = prev === '-' || (prev === ' ' && (twice || (pos === a.lines.length && !a.trailingNewline)));
        const newSide = prev === '+' || (prev === ' ' && (twice || !oldSide));
        if (oldSide) expect({ pos, n: a.lines.length, trailing: a.trailingNewline }).toEqual({ pos: a.lines.length, n: a.lines.length, trailing: false });
        if (newSide) newLacksNewline = true;
        k += twice ? 2 : 1;
        continue;
      }
      const text = line.slice(1);
      if (kind === ' ' || kind === '-') {
        expect(a.lines[pos]).toBe(text);
        pos++;
      }
      if (kind === ' ' || kind === '+') {
        out.push(text);
        added++;
      }
      expect(' -+'.includes(kind!)).toBe(true);
      k++;
    }
    expect(pos - at).toBe(aCount);
    expect(added).toBe(bCount);
    cursor = pos;
  }
  const atEnd = cursor === a.lines.length;
  out.push(...a.lines.slice(cursor));
  if (out.length === 0) return '';
  const trailing = atEnd ? !newLacksNewline : a.trailingNewline;
  return out.join('\n') + (trailing ? '\n' : '');
}

function randomPage(rand: () => number, alphabet: string[]): string[] {
  return Array.from({ length: Math.floor(rand() * 30) }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
}

function mutate(rand: () => number, lines: string[], alphabet: string[]): string[] {
  const out = [...lines];
  const edits = 1 + Math.floor(rand() * 4);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1));
    const del = Math.floor(rand() * 3);
    const ins = Array.from({ length: Math.floor(rand() * 3) }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
    out.splice(at, del, ...ins);
  }
  return out;
}

describe('editDiff stays identical under the budget', () => {
  test('ordinary edits produce the old editDiff byte for byte', () => {
    const rand = mulberry32(0x0b16_d1ff);
    const alphabet = ['alpha', 'beta', 'gamma', '', 'alice-example met acme-example', 'x'.repeat(400)];
    for (let k = 0; k < 2_000; k++) {
      const before = randomPage(rand, alphabet);
      const after = mutate(rand, before, alphabet);
      const a = before.join('\n') + (rand() < 0.8 ? '\n' : '');
      const b = after.join('\n') + (rand() < 0.8 ? '\n' : '');
      expect(editDiff('notes/x', a, b)).toEqual(oracleEditDiff('notes/x', a, b));
    }
  });
});

describe('boundedUnifiedDiff over budget (seeded corpus, small budgets)', () => {
  test('every windowed or coarse diff applies strictly and reproduces the new text', () => {
    const rand = mulberry32(0x0b16_d1ff ^ 0x5eed);
    const alphabet = ['a', 'b', 'c', '', ' a', '-a', '+a'];
    let windowed = 0;
    let coarse = 0;
    for (let k = 0; k < 20_000; k++) {
      const beforeLines = randomPage(rand, alphabet);
      const afterLines = mutate(rand, beforeLines, alphabet);
      const aTrailing = rand() < 0.7;
      const bTrailing = rand() < 0.5 ? aTrailing : rand() < 0.7;
      const before = beforeLines.length ? beforeLines.join('\n') + (aTrailing ? '\n' : '') : '';
      const after = afterLines.length ? afterLines.join('\n') + (bTrailing ? '\n' : '') : '';
      const budget = [1, 4, 12, 30, 80, 200][k % 6]!;
      const { diff, coarse: isCoarse } = boundedUnifiedDiff(before, after, 'a/p.md', 'b/p.md', budget);
      const aSplit = splitLines(before);
      const bSplit = splitLines(after);
      const n = aSplit.lines.length;
      const m = bSplit.lines.length;
      if ((n + 1) * (m + 1) <= budget) {
        expect({ diff, isCoarse }).toEqual({ diff: unifiedDiff(before, after, { oldPath: 'a/p.md', newPath: 'b/p.md' }), isCoarse: false });
        continue;
      }
      if (isCoarse) coarse++;
      else windowed++;
      if (aSplit.trailingNewline === bSplit.trailingNewline || before === '' || after === '') {
        expect(applyStrict(before, diff)).toBe(after);
      } else {
        // A change of the final newline alone is no line change to
        // unifiedDiff, so only the lines are compared here.
        expect(splitLines(applyStrict(before.endsWith('\n') ? before : before + '\n', diff.split('\n').filter(l => l !== MARKER).join('\n'))).lines)
          .toEqual(splitLines(after).lines);
      }
    }
    // The corpus reaches both arms.
    expect(windowed).toBeGreaterThan(1_000);
    expect(coarse).toBeGreaterThan(1_000);
  });

  test('a far-from-end edit in files without a final newline carries no marker', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const before = lines.join('\n');
    const after = lines.map((l, i) => (i === 5 ? 'edited' : l)).join('\n');
    const { diff, coarse } = boundedUnifiedDiff(before, after, 'a', 'b', 100);
    expect(coarse).toBe(false);
    expect(diff).toBe(['--- a', '+++ b', '@@ -3,7 +3,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+edited', ' line 6', ' line 7', ' line 8', ''].join('\n'));
    expect(applyStrict(before, diff)).toBe(after);
  });

  test('a near-end edit keeps both markers at end-of-file', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const before = lines.join('\n');
    const after = lines.map((l, i) => (i === 38 ? 'edited' : l)).join('\n');
    const { diff } = boundedUnifiedDiff(before, after, 'a', 'b', 100);
    expect(diff.endsWith(` line 39\n${MARKER}\n${MARKER}\n`)).toBe(true);
    expect(applyStrict(before, diff)).toBe(after);
  });

  test('identical lines return an empty diff, like unifiedDiff', () => {
    const page = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
    expect(boundedUnifiedDiff(page, page, 'a', 'b', 10)).toEqual({ diff: '', coarse: false });
    expect(boundedUnifiedDiff(`${page}\n`, page, 'a', 'b', 10)).toEqual({ diff: unifiedDiff(`${page}\n`, page), coarse: false });
  });
});

/** Cells written by Array.prototype.fill (the LCS table rows) while `fn` runs. */
function countFilledCells(fn: () => void): number {
  const fill = Array.prototype.fill;
  let cells = 0;
  Array.prototype.fill = function (this: unknown[], ...args: unknown[]) {
    cells += this.length;
    return (fill as (...a: unknown[]) => unknown[]).apply(this, args);
  } as typeof Array.prototype.fill;
  try {
    fn();
  } finally {
    Array.prototype.fill = fill;
  }
  return cells;
}

describe('editDiff cell-budget probe', () => {
  const page = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `Row ${i}${tag} of the page.`);

  test('a one-line edit just past the budget fills a window-sized table; the old diff filled the full one', () => {
    const before = page(2_000);
    const after = before.map((l, i) => (i === 1_000 ? 'Row 1000 was edited.' : l));
    const a = before.join('\n') + '\n';
    const b = after.join('\n') + '\n';
    let result: ReturnType<typeof editDiff> = { diff: '' };
    const cells = countFilledCells(() => { result = editDiff('notes/p', a, b); });
    expect(cells).toBeLessThanOrEqual(100);
    expect(result.diff_coarse).toBeUndefined();
    expect(applyStrict(a, result.diff)).toBe(b);
    const oldCells = countFilledCells(() => { oracleEditDiff('notes/p', a, b); });
    expect(oldCells).toBeGreaterThan(EDIT_PAGE_DIFF_CELL_BUDGET);
  });

  test('a rewrite of every line past the budget is one coarse hunk with no table at all', () => {
    const a = Array.from({ length: 2_100 }, (_, i) => `r${i}`).join('\n') + '\n';
    const b = Array.from({ length: 2_100 }, (_, i) => `s${i}`).join('\n') + '\n';
    let result: ReturnType<typeof editDiff> = { diff: '' };
    const cells = countFilledCells(() => { result = editDiff('notes/p', a, b); });
    expect(cells).toBe(0);
    expect(result.diff_coarse).toBe(true);
    expect(result.diff_truncated).toBe(true);
    expect(result.diff.split('\n').slice(0, 4)).toEqual(['--- a/notes/p.md', '+++ b/notes/p.md', '@@ -1,2100 +1,2100 @@', '-r0']);
    const full = boundedUnifiedDiff(a, b, 'a/notes/p.md', 'b/notes/p.md');
    expect(full.coarse).toBe(true);
    expect(applyStrict(a, full.diff)).toBe(b);
  });
});
