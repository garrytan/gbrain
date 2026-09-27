import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('symbol-resolver source hygiene', () => {
  test('the module source carries no raw NUL bytes (lookup keys use the \\0 escape)', () => {
    // test-reads-source-ok: raw 0x00 makes file(1) classify the module as data
    // and grep -I skip it; runtime keys unchanged, only on-disk spelling.
    const src = readFileSync(
      join(import.meta.dir, '..', '..', 'src', 'core', 'chunkers', 'symbol-resolver.ts'),
      'utf-8',
    );
    expect(src.includes('\0')).toBe(false);
    expect(src).toContain('`${pageId}\\0${e.to_symbol_qualified}`');
    expect(src).toContain('`${r.page_id}\\0${r.symbol_name_qualified}`');
  });
});
