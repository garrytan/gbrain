/**
 * #1336 — legacy bearer tokens honor their stored federated_read grant.
 *
 * Pre-fix the legacy access_tokens path hardcoded `sourceId: 'default'` and never
 * populated `allowedSources`, so a token whose `permissions.source_id` granted
 * multiple sources could not read across them (and MCP reads silently returned
 * empty in non-default brains). The grant is now parsed and threaded.
 *
 * Bounded by design: never widened to "all" — an empty/garbage value keeps the
 * 'default' floor and no federated grant.
 */
import { describe, test, expect } from 'bun:test';
import { parseLegacyTokenScope } from '../src/mcp/http-transport.ts';
import { parseTakesHoldersAllowList, coerceLegacyPermissions } from '../src/core/legacy-token-scope.ts';

describe('parseLegacyTokenScope', () => {
  test('array grant → allowedSources (federated read) with first as scalar floor', () => {
    expect(parseLegacyTokenScope(['dept-x', 'shared'])).toEqual({ sourceId: 'dept-x', allowedSources: ['dept-x', 'shared'] });
  });

  test('single-element array → that source as both floor and grant', () => {
    expect(parseLegacyTokenScope(['only'])).toEqual({ sourceId: 'only', allowedSources: ['only'] });
  });

  test('string grant → scalar source, no federated array', () => {
    expect(parseLegacyTokenScope('team-a')).toEqual({ sourceId: 'team-a' });
  });

  test('absent grant → default floor, never widened', () => {
    expect(parseLegacyTokenScope(undefined)).toEqual({ sourceId: 'default' });
    expect(parseLegacyTokenScope(null)).toEqual({ sourceId: 'default' });
  });

  test('empty array → default floor, no grant (NOT "all")', () => {
    expect(parseLegacyTokenScope([])).toEqual({ sourceId: 'default' });
  });

  test('garbage (number / empty string) → default floor', () => {
    expect(parseLegacyTokenScope(123)).toEqual({ sourceId: 'default' });
    expect(parseLegacyTokenScope('')).toEqual({ sourceId: 'default' });
  });

  test('array with non-string junk is filtered to valid sources', () => {
    expect(parseLegacyTokenScope(['a', 5, '', 'b'])).toEqual({ sourceId: 'a', allowedSources: ['a', 'b'] });
  });
});

// #2529 — permissions.takes_holders parse contract, shared by the legacy HTTP
// transport and the OAuth provider behind `serve --http` so the two cannot
// drift. Imported from the owner module (src/core/legacy-token-scope.ts), not
// re-exported through a transport.
describe('parseTakesHoldersAllowList', () => {
  test('string array passes through unchanged', () => {
    expect(parseTakesHoldersAllowList(['world', 'brain'])).toEqual(['world', 'brain']);
  });

  test('empty array is PRESERVED as explicit deny-all (not collapsed)', () => {
    const result = parseTakesHoldersAllowList([]);
    expect(result).toBeDefined();
    expect(result).toEqual([]);
  });

  test('non-string entries are filtered; empty strings KEPT (deliberate divergence from parseLegacyTokenScope)', () => {
    expect(parseTakesHoldersAllowList(['world', 42, null, '', 'brain'])).toEqual(['world', '', 'brain']);
  });

  test('non-array values → undefined (consumer applies fail-closed default)', () => {
    expect(parseTakesHoldersAllowList('world')).toBeUndefined();
    expect(parseTakesHoldersAllowList(123)).toBeUndefined();
    expect(parseTakesHoldersAllowList(null)).toBeUndefined();
    expect(parseTakesHoldersAllowList(undefined)).toBeUndefined();
    expect(parseTakesHoldersAllowList({ takes_holders: ['world'] })).toBeUndefined();
  });
});

// #2529 (ship adversarial review): both transports decode a legacy token's
// permissions column through this shared coercer so a double-encoded jsonb
// string scalar (#2339 class) is interpreted identically — the OAuth provider
// can't honor a grant the legacy HTTP transport silently fails open on.
describe('coerceLegacyPermissions', () => {
  test('plain object passes through', () => {
    expect(coerceLegacyPermissions({ takes_holders: ['world', 'brain'] })).toEqual({ takes_holders: ['world', 'brain'] });
  });

  test('JSON string (double-encoded jsonb scalar) is decoded to its object', () => {
    const decoded = coerceLegacyPermissions(JSON.stringify({ takes_holders: [], source_id: 'x' }));
    expect(decoded).toEqual({ takes_holders: [], source_id: 'x' });
    // Downstream parse then honors the [] deny-all grant — not fail-open world.
    expect(parseTakesHoldersAllowList(decoded?.takes_holders)).toEqual([]);
  });

  test('malformed JSON string → undefined (no grant)', () => {
    expect(coerceLegacyPermissions('{not valid json')).toBeUndefined();
  });

  test('JSON string that decodes to a non-object (array/scalar) → undefined', () => {
    expect(coerceLegacyPermissions('"world"')).toBeUndefined();
    expect(coerceLegacyPermissions('[1,2]')).toBeUndefined();
  });

  test('null / undefined / scalar → undefined', () => {
    expect(coerceLegacyPermissions(null)).toBeUndefined();
    expect(coerceLegacyPermissions(undefined)).toBeUndefined();
    expect(coerceLegacyPermissions(42)).toBeUndefined();
  });
});
