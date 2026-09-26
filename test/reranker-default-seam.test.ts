import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MODE_BUNDLES } from '../src/core/search/mode.ts';
import {
  DEFAULT_RERANKER_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
} from '../src/core/ai/defaults.ts';

describe('DEFAULT_RERANKER_MODEL seam (#3657, flipped v0.48.2)', () => {
  test('all three mode bundles resolve their reranker_model through the one constant', () => {
    expect(MODE_BUNDLES.conservative.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    expect(MODE_BUNDLES.balanced.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    expect(MODE_BUNDLES.tokenmax.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
  });

  test('the default IS the recommended new-install reranker (voyage)', () => {
    expect(DEFAULT_RERANKER_MODEL).toBe(NEW_INSTALL_DEFAULT_RERANKER_MODEL);
    expect(DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
  });

  test('gateway imports DEFAULT_RERANKER_MODEL from defaults.ts — no local alias, no literal', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/core/ai/gateway.ts'),
      'utf8',
    );
    expect(src).not.toContain('const DEFAULT_RERANKER_MODEL =');
    expect(src).toMatch(/import \{[^}]*\bDEFAULT_RERANKER_MODEL\b[^}]*\} from '\.\/defaults\.ts'/s);
  });

});
