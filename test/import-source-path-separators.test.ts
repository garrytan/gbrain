import { describe, expect, test } from 'bun:test';
import * as prepare from '../src/core/persistence/import-prepare.ts';

const same = (a: string, b: string, windows: boolean): boolean | undefined =>
  (prepare as { sameImportSourcePath?: (a: string, b: string, w: boolean) => boolean }).sameImportSourcePath?.(a, b, windows);

describe('sameImportSourcePath', () => {
  test('Windows treats either separator spelling as the same file', () => {
    expect(same('notes/example.md', 'notes\\example.md', true)).toBe(true);
    expect(same('notes\\example.md', 'notes/example.md', true)).toBe(true);
  });
  test('different files stay different', () => {
    expect(same('notes/example.md', 'notes\\other.md', true)).toBe(false);
  });
  test('POSIX keeps the literal comparison', () => {
    expect(same('notes/example.md', 'notes\\example.md', false)).toBe(false);
  });
});
