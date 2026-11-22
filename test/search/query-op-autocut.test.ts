/**
 * v0.42.3.0 — pins the agent-facing autocut surface on the `query` op.
 *
 * Autocut is off by default in every search mode (ranker wave rule R2), so the
 * param is an opt-in: `true` trims at the steepest score drop. The description
 * must say it is off by default and warn what turning it on costs. Guards
 * against a refactor dropping the param or bringing back the old "default on"
 * claim.
 */

import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../../src/core/operations.ts';

describe('query op — autocut agent surface', () => {
  const query = operationsByName['query'];

  test('autocut is a boolean param on query', () => {
    const param = query.params?.autocut as { type?: string; description?: string } | undefined;
    expect(param).toBeDefined();
    expect(param?.type).toBe('boolean');
  });

  test('description says autocut is off by default, how to turn it on, and what it can drop', () => {
    const desc = ((query.params?.autocut as { description?: string })?.description ?? '').toLowerCase();
    expect(desc).toContain('off by default in every mode');
    expect(desc).toContain('true');
    expect(desc).toContain('search.autocut true');
    expect(desc).toContain('steepest score drop');
    expect(desc).toContain('multi-part');
    expect(desc).not.toContain('default on');
    expect(desc).not.toContain('never empty');
  });

  test('search op (keyword-only) does NOT carry autocut (no reranker there)', () => {
    const search = operationsByName['search'];
    expect(search).toBeDefined();
    expect(search.params?.autocut).toBeUndefined();
  });
});
