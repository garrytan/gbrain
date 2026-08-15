/**
 * v0.36 (D15 / CDX-9) — MCP op `embedding_column` param surface.
 *
 * Pins:
 *   - `query` op declares `embedding_column` in its params allowlist
 *     (caller can pass it).
 *   - `search` op does NOT declare it (CDX-9: search is keyword-only;
 *     adding the field would silently change semantics).
 *   - Param description names the registry + the override semantics so
 *     agents discover it via tool definitions.
 */

import { describe, test, expect } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

describe('query op — embedding_column param (D15)', () => {
  const queryOp = operationsByName.query;

  test('exists', () => {
    expect(queryOp).toBeDefined();
  });

  test('declares embedding_column in params allowlist', () => {
    expect(queryOp.params.embedding_column).toBeDefined();
    expect(queryOp.params.embedding_column.type).toBe('string');
  });

  test('description names registry + override semantics', () => {
    const desc = queryOp.params.embedding_column.description ?? '';
    expect(desc.toLowerCase()).toMatch(/embedding/);
    // Description should give the agent enough context to understand
    // when to use the param and where the registry lives.
    expect(desc.toLowerCase()).toMatch(/registry|embedding_columns|column/);
  });

  test('embedding_column is NOT required (per-call override is optional)', () => {
    expect(queryOp.params.embedding_column.required).not.toBe(true);
  });
});

describe('search op — does NOT declare embedding_column (CDX-9)', () => {
  const searchOp = operationsByName.search;

  test('exists', () => {
    expect(searchOp).toBeDefined();
  });

  test('does NOT include embedding_column in params (search is keyword-only)', () => {
    // Adding embedding_column to the keyword-only `search` op would
    // either be silently ignored (footgun for agents) or change the op's
    // semantics from keyword to hybrid. Both bad. Keep it on `query` only.
    expect(searchOp.params.embedding_column).toBeUndefined();
  });
});
