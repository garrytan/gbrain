/**
 * #6503: the overlapping-window planner both long-text extractors share
 * (extract_atoms windows, page fact windows) and the atom window merge.
 *
 * Protects: a text within the budget is one untouched window; a longer text is
 * covered end to end by windows within the budget that overlap, break on
 * blank lines / lines / sentences before cutting mid-word, never split a
 * surrogate pair, and plan deterministically; atom quotes verified in a
 * window carry offsets into the FULL text, and atoms repeated across windows
 * merge. A regression to slicing (or to unmapped offsets) fails here without
 * a database.
 */
import { describe, expect, test } from 'bun:test';
import { planTextWindows } from '../src/core/text-windows.ts';
import { mergeWindowAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { ExtractedAtom } from '../src/core/cycle/extract-atoms-parse.ts';

function assertCovers(text: string, max: number) {
  const windows = planTextWindows(text, max, 100);
  expect(windows[0].start).toBe(0);
  expect(windows.at(-1)!.end).toBe(text.length);
  for (const [i, w] of windows.entries()) {
    expect(w.index).toBe(i);
    expect(w.count).toBe(windows.length);
    expect(w.text).toBe(text.slice(w.start, w.end));
    expect(w.end - w.start).toBeLessThanOrEqual(max);
    expect(w.text.isWellFormed()).toBe(true);
    if (i > 0) {
      const prev = windows[i - 1];
      expect(w.start).toBeGreaterThan(prev.start); // progress
      expect(w.start).toBeLessThanOrEqual(prev.end); // no gap: every character is read
    }
  }
  return windows;
}

describe('planTextWindows (#6503)', () => {
  test('a text within the budget is one window holding the text unchanged', () => {
    const text = 'short text';
    expect(planTextWindows(text, 10, 3)).toEqual([{ index: 0, count: 1, start: 0, end: 10, text }]);
    expect(planTextWindows('', 10, 3)).toEqual([{ index: 0, count: 1, start: 0, end: 0, text: '' }]);
  });

  test('windows cover the whole text, stay within the budget and overlap', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Line ${i} carries a sentence about item ${i}.`).join('\n');
    const windows = assertCovers(text, 1_000);
    expect(windows.length).toBeGreaterThan(5);
    for (let i = 1; i < windows.length; i++) {
      const shared = windows[i - 1].end - windows[i].start;
      expect(shared).toBeGreaterThanOrEqual(50); // at least half the requested overlap
      expect(shared).toBeLessThanOrEqual(100);
    }
    // The tail is in the last window.
    expect(windows.at(-1)!.text).toContain('Line 199 carries');
  });

  test('a boundary prefers a blank line, then a line, then a sentence end, then a space', () => {
    const para = `${'p'.repeat(600)}\n\n${'q'.repeat(600)}`;
    expect(planTextWindows(para, 1_000, 0)[0].end).toBe(602);
    const lines = `${'a'.repeat(600)}\n${'b'.repeat(600)}`;
    expect(planTextWindows(lines, 1_000, 0)[0].end).toBe(601);
    const sentences = `${'c'.repeat(600)}. ${'d'.repeat(600)}`;
    expect(planTextWindows(sentences, 1_000, 0)[0].end).toBe(602);
    const words = `${'e'.repeat(600)} ${'f'.repeat(600)}`;
    expect(planTextWindows(words, 1_000, 0)[0].end).toBe(601);
    // No boundary in the back half: a hard cut at the budget.
    expect(planTextWindows('g'.repeat(1_500), 1_000, 0)[0].end).toBe(1_000);
  });

  test('a hard cut and an overlap start never split a surrogate pair', () => {
    const text = `${'a'.repeat(999)}💡${'b'.repeat(998)}💡tail`;
    const windows = assertCovers(text, 1_000);
    expect(windows[0].end).toBe(999);
    expect(windows.at(-1)!.text.endsWith('💡tail')).toBe(true);
    // Emoji-dense text: every window and every overlap start lands between pairs.
    assertCovers('😀'.repeat(3_000), 101);
  });

  test('the overlap is clamped so tiny budgets still advance, and planning is deterministic', () => {
    const text = 'x'.repeat(5_000);
    const windows = assertCovers(text, 40);
    expect(planTextWindows(text, 40, 100)).toEqual(planTextWindows(text, 40, 100));
    for (let i = 1; i < windows.length; i++) expect(windows[i - 1].end - windows[i].start).toBeLessThanOrEqual(10);
    expect(() => planTextWindows(text, 3, 0)).toThrow();
  });
});

describe('mergeWindowAtoms (#6503)', () => {
  const atom = (title: string, source_quote?: string): ExtractedAtom => ({ title, atom_type: 'insight', body: 'b', ...(source_quote ? { source_quote } : {}) });

  test('a single window passes through in order with offsets into the text (the historical behavior)', () => {
    const text = 'Alpha said the plan works. Beta said the plan works.';
    const window = { index: 0, count: 1, start: 0, end: text.length, text };
    const merged = mergeWindowAtoms(text, [{ window, atoms: [atom('Same', 'Beta said'), atom('Same', 'nowhere in the text')] }]);
    expect(merged.map(a => a.title)).toEqual(['Same', 'Same']);
    expect(merged[0].quoteFields).toEqual({ source_quote: 'Beta said', source_quote_offset: [27, 36], source_quote_verified: true });
    expect(merged[1].quoteFields).toEqual({ quote_unverified: 'model paraphrased; not present in source' });
  });

  test('a quote verified in its window maps onto full-text offsets; a quote only outside its window does not verify', () => {
    const text = `${'head line.\n'.repeat(50)}TAIL: ship the beta to ten partners.\n`;
    const [w0, w1] = planTextWindows(text, 400, 50).slice(-2);
    const merged = mergeWindowAtoms(text, [
      { window: w0, atoms: [atom('Wrong window', 'TAIL: ship the beta')] },
      { window: w1, atoms: [atom('Ship to partners', 'ship the beta to ten partners.')] },
    ]);
    const inWindow = merged.find(a => a.title === 'Ship to partners')!;
    const [start, end] = inWindow.quoteFields.source_quote_offset as [number, number];
    expect(start).toBe(text.indexOf('ship the beta'));
    expect(text.slice(start, end)).toBe('ship the beta to ten partners.');
    if (!w0.text.includes('TAIL')) expect(merged.find(a => a.title === 'Wrong window')!.quoteFields.quote_unverified).toBeDefined();
  });

  test('repeats across windows merge: same slug stem, or the same verified passage read twice in the overlap', () => {
    const text = 'One. Shared passage in the overlap. Two.';
    const w0 = { index: 0, count: 2, start: 0, end: 36, text: text.slice(0, 36) };
    const w1 = { index: 1, count: 2, start: 5, end: text.length, text: text.slice(5) };
    const merged = mergeWindowAtoms(text, [
      { window: w0, atoms: [atom('Status lines are noise'), atom('Overlap idea', 'Shared passage in the overlap.')] },
      { window: w1, atoms: [atom('status LINES are noise!', 'Two.'), atom('Same passage, new title', 'Shared passage in the overlap.')] },
    ]);
    expect(merged.map(a => a.title)).toEqual(['Status lines are noise', 'Overlap idea']);
    // The kept atom had no verified quote; it adopts the repeat's.
    expect(merged[0].quoteFields).toMatchObject({ source_quote: 'Two.', source_quote_verified: true });
    expect(merged[1].quoteFields.source_quote_offset).toEqual([5, 35]);
  });
});
