/**
 * mcp-registration-blocks.test.ts — cathedral-6 lane B pins:
 * - openclawThinClientBlock is run on the OpenClaw machine: the scoped
 *   `gbrain init` thin-client command with all four connection args, then
 *   OpenClaw's own `mcp add` for that thin client's stdio bridge (#8543),
 *   with the launcher resolved there, no host path, no mcpServers key, and
 *   one GBRAIN_HOME on both lines when a narrow home is chosen.
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

  test('registers the thin client\'s stdio bridge with OpenClaw, launcher resolved on the OpenClaw machine', () => {
    const block = openclawThinClientBlock(OPTS);
    expect(block).toContain('# On the OpenClaw machine, install the gbrain CLI, then run:');
    expect(block).toContain('openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve --arg --surface --arg starter --arg --advertise --arg verbs');
    expect(block).toContain("If gbrain's OpenClaw bundle plugin is installed there, it already registers");
    expect(block).toContain("OpenClaw's native remote MCP client (streamable HTTP + `openclaw mcp login`) is the other scoped");
    expect(block).not.toContain('FULL local DB access');
  });

  test('names no path from the machine that printed it and no mcpServers key', () => {
    const block = openclawThinClientBlock(OPTS);
    expect(block).not.toMatch(/mcpServers|"command"\s*:/);
    expect(block).not.toContain(process.execPath);
    expect(block).not.toMatch(/(^|\s)\/(usr|home|Users|opt|root)\//m);
  });

  test('a narrow home rides on both the init line and the entry', () => {
    const block = openclawThinClientBlock({ ...OPTS, gbrainHome: '/home/alice-example/.gbrain-openclaw' });
    const lines = block.split('\n');
    expect(lines.find(l => l.includes('gbrain init'))).toStartWith('GBRAIN_HOME=/home/alice-example/.gbrain-openclaw gbrain init --mcp-only');
    expect(lines.find(l => l.startsWith('openclaw mcp add'))).toEndWith(' --env GBRAIN_HOME=/home/alice-example/.gbrain-openclaw');
    expect(block).not.toContain('GBRAIN_HOME=<dir>');
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
