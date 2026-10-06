// A file lint listed can be deleted or renamed before lint reads it (a concurrent sync, an editor's
// atomic save). Lint reports `file_removed_during_scan` for that file and lints the rest; any other
// read error still fails the run. Managed `--fix` runs report the coordinator's
// `canonical_file_missing` instead (test/managed-lint.test.ts).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLint, runLintCore, type LintIssue } from '../src/commands/lint.ts';

const SANITY_OFF = { disabled: true } as never;
const PREAMBLE_PAGE = (title: string) => `---\ntitle: ${title}\ntype: note\ncreated: 2026-01-05\n---\nOf course. Here is a detailed brain page for ${title}.\n\n# ${title}\n\nBody.\n`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-lint-vanish-'));
  writeFileSync(join(dir, 'a-first.md'), PREAMBLE_PAGE('First'));
  writeFileSync(join(dir, 'b-vanishing.md'), PREAMBLE_PAGE('Vanishing'));
  writeFileSync(join(dir, 'c-last.md'), PREAMBLE_PAGE('Last'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

for (const fix of [false, true]) {
  test(`unmanaged lint${fix ? ' --fix' : ''}: a listed file removed before its scan read is reported and the run continues`, async () => {
    const byFile = new Map<string, LintIssue[]>();
    let scanned = 0;
    const result = await runLintCore({ target: dir, fix, contentSanity: SANITY_OFF, typePack: null,
      onPageScanned: () => { if (scanned++ === 0) unlinkSync(join(dir, 'b-vanishing.md')); },
      onPageIssues: (rel, issues) => byFile.set(rel, issues) });
    expect(byFile.get('b-vanishing.md')).toEqual([{
      file: 'b-vanishing.md', line: 1, rule: 'file-removed-during-scan', fixable: false, code: 'file_removed_during_scan',
      message: 'b-vanishing.md was removed after lint listed it and before lint read it, so it was not linted. Re-run lint to check the files that exist now.',
      fix: expect.objectContaining({ argv: ['gbrain', 'lint', dir], command: `gbrain lint ${dir}`, next: 'run' }),
      docs: expect.stringContaining('docs/guides/repair.md#file-removed-during-scan'),
    }]);
    expect(byFile.has('c-last.md')).toBe(true);
    expect(result.pages_scanned).toBe(3);
    expect(result.fix_pending).toBe(0);
    if (fix) expect(result.total_fixed).toBeGreaterThan(0);
  });
}

test('the lint CLI prints the vanished file with its fix command and guide', async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    const line = a.join(' ');
    if (line.includes('a-first.md:')) unlinkSync(join(dir, 'b-vanishing.md'));
    logged.push(line);
  };
  try { await runLint([dir]); } finally { console.log = orig; }
  const out = logged.join('\n');
  expect(out).toContain('\nb-vanishing.md:\n  L1 file-removed-during-scan: b-vanishing.md was removed after lint listed it and before lint read it, so it was not linted. Re-run lint to check the files that exist now.\n'
    + `    Fix: gbrain lint ${dir}\n    Docs: `);
  expect(out).toContain('docs/guides/repair.md#file-removed-during-scan');
  expect(out).toContain('3 pages scanned.');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable file still fails the run (only ENOENT is a vanished file)', async () => {
  chmodSync(join(dir, 'b-vanishing.md'), 0o000);
  try {
    await expect(runLintCore({ target: dir, contentSanity: SANITY_OFF, typePack: null })).rejects.toMatchObject({ code: 'EACCES' });
  } finally { chmodSync(join(dir, 'b-vanishing.md'), 0o644); }
});
