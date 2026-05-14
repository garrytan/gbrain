import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCodeIndexConfig } from '../src/core/code-index-config.ts';

describe('loadCodeIndexConfig', () => {
  test('returns null when gbrain.yml is missing or has no code_index section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-code-index-'));
    try {
      expect(loadCodeIndexConfig(tmp)).toBeNull();
      writeFileSync(join(tmp, 'gbrain.yml'), 'storage:\n  db_tracked:\n    - people/\n');
      expect(loadCodeIndexConfig(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('loads include/exclude globs from code_index', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-code-index-'));
    try {
      writeFileSync(join(tmp, 'gbrain.yml'), `code_index:
  include:
    - "**/*.kt"
    - '**/*.kts'
  exclude:
    - "**/build/**"
    - "keyboard/**/dictionary/**"
`);
      expect(loadCodeIndexConfig(tmp)).toEqual({
        include: ['**/*.kt', '**/*.kts'],
        exclude: ['**/build/**', 'keyboard/**/dictionary/**'],
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('loads empty inline lists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-code-index-'));
    try {
      writeFileSync(join(tmp, 'gbrain.yml'), `code_index:
  include: []
  exclude: []
`);
      expect(loadCodeIndexConfig(tmp)).toEqual({ include: [], exclude: [] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
