/**
 * v0.36.0.1 — `GBRAIN_SOURCES` env-var parser for stdio MCP federated reads.
 *
 * HTTP MCP sources `allowedSources` from `oauth_clients.federated_read` at
 * token-verification time. Stdio MCP has no per-token auth and historically
 * could only scope to ONE source via `GBRAIN_SOURCE`. Now `GBRAIN_SOURCES`
 * (plural, comma-separated) populates a synthetic `AuthInfo.allowedSources`
 * so the same federated-read pattern works on stdio.
 *
 * These tests pin the parsing rules (trim, drop empties, drop dupes, empty
 * input → undefined). Drift here silently re-introduces the docc-bug class
 * where MCP clients couldn't see federated sources.
 */

import { describe, test, expect } from 'bun:test';
import { parseStdioAllowedSources } from '../src/mcp/server.ts';

describe('parseStdioAllowedSources', () => {
  test('undefined env → undefined (preserve scalar fallback path)', () => {
    expect(parseStdioAllowedSources(undefined)).toBeUndefined();
  });

  test('empty string → undefined (no synthetic auth, no widening)', () => {
    expect(parseStdioAllowedSources('')).toBeUndefined();
  });

  test('whitespace-only → undefined', () => {
    expect(parseStdioAllowedSources('   ')).toBeUndefined();
    expect(parseStdioAllowedSources(',,,')).toBeUndefined();
    expect(parseStdioAllowedSources(' , , ')).toBeUndefined();
  });

  test('single source returns single-element array', () => {
    expect(parseStdioAllowedSources('docc')).toEqual(['docc']);
  });

  test('comma-separated list parses cleanly', () => {
    expect(parseStdioAllowedSources('default,docc,popify')).toEqual([
      'default',
      'docc',
      'popify',
    ]);
  });

  test('trims whitespace around each entry (typical shell quoting)', () => {
    expect(parseStdioAllowedSources('default, docc, popify')).toEqual([
      'default',
      'docc',
      'popify',
    ]);
    expect(parseStdioAllowedSources(' default , docc , popify ')).toEqual([
      'default',
      'docc',
      'popify',
    ]);
  });

  test('drops empty entries from leading/trailing/double commas', () => {
    expect(parseStdioAllowedSources(',default,,docc,')).toEqual(['default', 'docc']);
  });

  test('drops duplicates, preserves first-seen order', () => {
    expect(parseStdioAllowedSources('default,docc,default,popify,docc')).toEqual([
      'default',
      'docc',
      'popify',
    ]);
  });

  test('order is preserved (regression guard: do NOT sort)', () => {
    // The first element doubles as the scalar `sourceId` fallback in
    // server.ts (write authority for single-source setups). Sorting would
    // silently change which source receives writes when GBRAIN_SOURCE
    // (singular) is unset.
    expect(parseStdioAllowedSources('popify,docc,autotrader')).toEqual([
      'popify',
      'docc',
      'autotrader',
    ]);
  });

  test('non-canonical source ids pass through unchanged (validation lives elsewhere)', () => {
    // The parser does NOT validate source ids against the sources table.
    // That's the engine's job at query time — and an unknown source id
    // simply matches zero rows, which is fail-safe (no widening).
    expect(parseStdioAllowedSources('nonexistent-source')).toEqual(['nonexistent-source']);
  });
});
