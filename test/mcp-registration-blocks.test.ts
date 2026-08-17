/**
 * mcp-registration-blocks.test.ts — cathedral-6 lane B pins:
 * - openclawThinClientBlock is the HONEST v1 OpenClaw path: the scoped
 *   `gbrain init` thin-client command with all four connection args, plus the
 *   FULL-local-DB-access honesty sentence — and NOT an mcpServers/stdio JSON
 *   config.
 * - OAUTH_SECRET_NOTE moved to core with its text unchanged; connect.ts
 *   re-exports the identical value (surface unchanged).
 */

import { describe, expect, test } from 'bun:test';
import { OAUTH_SECRET_NOTE, openclawThinClientBlock } from '../src/core/mcp-registration.ts';
import { OAUTH_SECRET_NOTE as CONNECT_REEXPORTED_NOTE } from '../src/commands/connect.ts';

const OPTS = {
  issuerUrl: 'https://brain.example.com',
  mcpUrl: 'https://brain.example.com/mcp',
  clientId: 'client_abc123',
  clientSecret: 'sekret_xyz789',
};

describe('openclawThinClientBlock', () => {
  test('carries the gbrain init thin-client command with all four connection args', () => {
    const block = openclawThinClientBlock(OPTS);
    expect(block).toContain('gbrain init --mcp-only');
    expect(block).toContain('--issuer-url https://brain.example.com');
    expect(block).toContain('--mcp-url https://brain.example.com/mcp');
    expect(block).toContain('--oauth-client-id client_abc123');
    expect(block).toContain('--oauth-client-secret sekret_xyz789');
  });

  test('states the honesty note: scoped-CLI path, no native remote MCP, stdio grants FULL local DB access', () => {
    const block = openclawThinClientBlock(OPTS);
    expect(block).toContain(
      'Your OpenClaw reaches the brain through the scoped gbrain CLI (search/query/recall/put);',
    );
    expect(block).toContain("native remote MCP isn't supported yet");
    expect(block).toContain('the stdio config in docs/mcp/OPENCLAW.md grants');
    expect(block).toContain('FULL local DB access and does not use this client.');
  });

  test('is NOT an mcpServers/stdio JSON config', () => {
    const block = openclawThinClientBlock(OPTS);
    expect(block).not.toMatch(/mcpServers|"command"\s*:/);
  });

  test('shell-quotes unsafe values so a pasted block cannot command-substitute', () => {
    const block = openclawThinClientBlock({ ...OPTS, clientSecret: 'se$(boom)cret' });
    expect(block).toContain("--oauth-client-secret 'se$(boom)cret'");
    expect(block).not.toContain('--oauth-client-secret se$(boom)cret');
  });
});

describe('OAUTH_SECRET_NOTE (moved to core)', () => {
  test('text is unchanged by the move', () => {
    expect(OAUTH_SECRET_NOTE).toBe(
      'Note: the client secret is sensitive — store it like a password. It mints ' +
        'short-lived, scoped access tokens; revoke with `gbrain auth revoke-client`.',
    );
  });

  test('connect.ts re-exports the identical value (surface unchanged)', () => {
    expect(CONNECT_REEXPORTED_NOTE).toBe(OAUTH_SECRET_NOTE);
  });
});
