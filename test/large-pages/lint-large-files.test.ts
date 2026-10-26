/**
 * Wave C 1E (spec §5 "lint"): lint reads page heads only.
 *
 * 1. Protects: a canonical file over PAGE_MAX_BYTES (24 MiB) is reported `oversize_canonical_file` from its size alone,
 *    never read into memory; files under a dot directory (a split page's part files) are never listed, so never read.
 * 2. Fails when: lint reads an oversize file whole before checking its size (master: readFileSync with no size check,
 *    so an unreadable oversize file fails the run and a readable one is linted as a 25 MiB string), or the walk starts
 *    descending into dot directories.
 * Proof of "not read": the probe files are mode 000, so any read throws EACCES and fails the run; stat still works.
 * Engine-free (lint of a directory).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLintCore, type LintIssue } from '../../src/commands/lint.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';

const SANITY_OFF = { disabled: true } as never;
const PAGE = (title: string) => `---\ntitle: ${title}\ntype: note\ncreated: 2026-01-05\n---\n\n# ${title}\n\nBody.\n`;
const unprivileged = process.platform !== 'win32' && process.getuid?.() !== 0;
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-lint-large-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function lint(): Promise<{ byFile: Map<string, LintIssue[]>; scanned: number }> {
  const byFile = new Map<string, LintIssue[]>();
  const result = await runLintCore({ target: dir, contentSanity: SANITY_OFF, typePack: null, onPageIssues: (rel, issues) => byFile.set(rel, issues) });
  return { byFile, scanned: result.pages_scanned };
}

function oversize(name: string, bytes: number): string {
  const file = join(dir, name);
  writeFileSync(file, PAGE('Huge'));
  truncateSync(file, bytes);
  return file;
}

test('a file over 24 MiB is reported oversize_canonical_file with its size, and the files beside it are linted', async () => {
  oversize('huge.md', PAGE_MAX_BYTES + 1);
  writeFileSync(join(dir, 'small.md'), PAGE('Small'));
  const { byFile, scanned } = await lint();
  expect(byFile.get('huge.md')).toEqual([{ file: 'huge.md', line: 1, rule: 'oversize-canonical-file', fixable: false, code: 'oversize_canonical_file',
    message: `huge.md is ${PAGE_MAX_BYTES + 1} bytes, over the ${PAGE_MAX_BYTES}-byte single-file page limit, so lint did not read it. A page this large is stored in segments when it is synced; split it, or check it with gbrain doctor after sync.` }]);
  expect(scanned).toBe(2);
});

test.skipIf(!unprivileged)('an oversize file is never read: lint reports it although the file is unreadable', async () => {
  chmodSync(oversize('huge.md', PAGE_MAX_BYTES + 1), 0o000);
  const { byFile } = await lint();
  expect(byFile.get('huge.md')!.map(i => i.code)).toEqual(['oversize_canonical_file']);
});

test.skipIf(!unprivileged)('a file at exactly 24 MiB is still read and linted', async () => {
  chmodSync(oversize('edge.md', PAGE_MAX_BYTES), 0o000);
  await expect(lint()).rejects.toThrow(/EACCES|permission denied/i);
});

test.skipIf(!unprivileged)('part files under a dot directory are never read', async () => {
  writeFileSync(join(dir, 'chat.md'), PAGE('Chat'));
  mkdirSync(join(dir, '.chat.gbparts'));
  for (const part of ['0001.md', '0002.md']) {
    writeFileSync(join(dir, '.chat.gbparts', part), PAGE('Part'));
    chmodSync(join(dir, '.chat.gbparts', part), 0o000);
  }
  const { byFile, scanned } = await lint();
  expect(scanned).toBe(1);
  expect([...byFile.keys()].filter(k => k.includes('gbparts'))).toEqual([]);
});
