/**
 * #9118: on Windows a page's stored source path and an import's path can spell
 * the same file with different separators; the import's identity check must
 * accept either spelling there, and must keep them distinct on POSIX, where a
 * backslash is an ordinary file-name character.
 */
import { expect, test } from 'bun:test';
import { sameSourcePath } from '../src/core/persistence/import-prepare.ts';

test('with the Windows separator, either spelling names the same file', () => {
  expect(sameSourcePath('notes/example.md', 'notes\\example.md', '\\')).toBe(true);
  expect(sameSourcePath('notes\\example.md', 'notes/example.md', '\\')).toBe(true);
  expect(sameSourcePath('notes/example.md', 'notes/other.md', '\\')).toBe(false);
});

test('with the POSIX separator, only the identical path matches', () => {
  expect(sameSourcePath('notes/example.md', 'notes/example.md', '/')).toBe(true);
  expect(sameSourcePath('notes/example.md', 'notes\\example.md', '/')).toBe(false);
});
