/**
 * v0.42.3.0 — pins the agent-facing autocut surface on the `query` op.
 *
 * Autocut is the smart default; the param exists ONLY as a ceiling override
 * (force the full top-K). The description must teach the agent that they
 * almost never set it, and that `false` is the breadth escape hatch. Guards
 * against a refactor silently dropping the param or the instruction.
 */

import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../../src/core/operations.ts';

describe('query op — autocut agent surface', () => {
  const query = operationsByName['query'];

  test('query op exists', () => {
    expect(query).toBeDefined();
  });

  test('autocut is a boolean param on query', () => {
    const param = query.params?.autocut as { type?: string; description?: string } | undefined;
    expect(param).toBeDefined();
    expect(param?.type).toBe('boolean');
  });

  test('description frames autocut as the default and FALSE as the breadth override', () => {
    const desc = ((query.params?.autocut as { description?: string })?.description ?? '').toLowerCase();
    // It's a default, not a feature the agent turns on.
    expect(desc).toContain('default');
    // The actionable direction is FALSE for breadth.
    expect(desc).toContain('false');
    expect(desc).toContain('breadth');
    // Safety contract so the agent trusts it.
    expect(desc).toContain('never returns empty');
    // Distinguish from adaptive_return so the agent picks the right knob.
    expect(desc).toContain('adaptive_return');
  });

  test('search op (keyword-only) does NOT carry autocut (no reranker there)', () => {
    const search = operationsByName['search'];
    expect(search).toBeDefined();
    expect(search.params?.autocut).toBeUndefined();
  });
});
