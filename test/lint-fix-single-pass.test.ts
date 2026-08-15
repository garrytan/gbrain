/**
 * W0 fix-wave (Tier-1 #14) — `gbrain lint --fix` scans once and reports the
 * TRUE fixed count.
 *
 * Pre-fix, runLint ran its own read+lint+fix loop for human detail, then
 * called runLintCore a second time for the summary — every page linted
 * twice, and because the first pass had already written the fixes, the
 * summary's total_fixed counted fixes against already-fixed content: the
 * CLI printed "0 auto-fixed" after fixing N issues.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runLintCore } from '../src/commands/lint.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-lint-w0-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('single pass: total_fixed reports the fixes THIS run applied', async () => {
  // A whole-file ```markdown wrapper is a fixable rule (code-fence-wrap).
  writeFileSync(join(dir, 'wrapped.md'), '```markdown\n# Hello\n\nBody text.\n```\n');
  writeFileSync(join(dir, 'clean.md'), '# Clean\n\nNothing to fix here.\n');

  const scanned: string[] = [];
  const reported: Array<{ relPath: string; fixedCount: number }> = [];
  const result = await runLintCore({
    target: dir,
    fix: true,
    contentSanity: { disabled: true } as never,
    onPageScanned: () => scanned.push('tick'),
    onPageIssues: (relPath, _issues, fixedCount) => reported.push({ relPath, fixedCount }),
  });

  // The bug: this was 0 after fixing. It must equal the fixes applied NOW.
  expect(result.total_fixed).toBeGreaterThan(0);
  // Each page scanned exactly once (2 pages, 2 ticks — not 4).
  expect(scanned.length).toBe(2);
  // The per-page hook carried the real fixed count for the fixed page
  // (clean.md may still surface non-fixable advisory issues — irrelevant here).
  const wrapped = reported.find(r => r.relPath === 'wrapped.md');
  expect(wrapped).toBeDefined();
  expect(wrapped!.fixedCount).toBeGreaterThan(0);
  expect(result.total_fixed).toBe(wrapped!.fixedCount);
  // And the fix actually landed on disk.
  expect(readFileSync(join(dir, 'wrapped.md'), 'utf-8').startsWith('```')).toBe(false);

  // Second run: nothing left to fix — counts stay honest.
  const again = await runLintCore({ target: dir, fix: true, contentSanity: { disabled: true } as never });
  expect(again.total_fixed).toBe(0);
});
