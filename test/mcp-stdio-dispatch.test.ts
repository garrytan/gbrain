/**
 * stdio MCP dispatch-defaults contract test.
 *
 * Regression guard for the stdio transport running as a trusted local pipe:
 * `remote: false` so whoami + write ops don't fail-closed with
 * `unknown_transport`, while private takes stay gated by the independent
 * takes-holder allow-list. Pure test — reads the exported defaults, spins up
 * no server and touches no DB (mirrors test/whoami.test.ts's op-contract style).
 */

import { test, expect, describe } from 'bun:test';
import { stdioDispatchDefaults } from '../src/mcp/server.ts';

describe('stdio MCP dispatch defaults', () => {
  test('runs as a trusted local pipe (remote=false) so whoami/writes work', () => {
    expect(stdioDispatchDefaults().remote).toBe(false);
  });

  test('still gates private takes to world-visible holders only', () => {
    expect(stdioDispatchDefaults().takesHoldersAllowList).toEqual(['world']);
  });

  test('defaults the source scope to "default"', () => {
    // Asserts the fallback branch only when the ambient env leaves it unset,
    // so the test never mutates process.env (test-isolation R1).
    if (!process.env.GBRAIN_SOURCE) {
      expect(stdioDispatchDefaults().sourceId).toBe('default');
    }
  });
});
