/**
 * Tests for parseRegisterClientArgs() in src/commands/auth.ts.
 *
 * v0.41.3 (T3): the pre-fix CLI parser used `args.indexOf('--flag')` which
 * silently took only the FIRST occurrence of a flag. That broke
 * `--redirect-uri A --redirect-uri B` (only A made it through). The rewrite
 * loops over argv and accumulates repeatable flags into arrays.
 *
 * Pure function — no DB, no fetch. The full register-client flow against
 * a live PGLite OAuth provider is covered in test/oauth.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { parseRegisterClientArgs } from '../src/commands/auth.ts';

describe('parseRegisterClientArgs', () => {
  test('empty args → all defaults', () => {
    const out = parseRegisterClientArgs([]);
    expect(out.grantTypes).toEqual(['client_credentials']);
    expect(out.scopes).toBe('read');
    expect(out.sourceId).toBe('default');
    expect(out.federatedRead).toBeUndefined();
    expect(out.redirectUris).toEqual([]);
    expect(out.tokenEndpointAuthMethod).toBeUndefined();
  });

  test('--grant-types comma-separated → array', () => {
    const out = parseRegisterClientArgs(['--grant-types', 'authorization_code,refresh_token']);
    expect(out.grantTypes).toEqual(['authorization_code', 'refresh_token']);
  });

  test('--scopes preserves the whitespace-joined string', () => {
    const out = parseRegisterClientArgs(['--scopes', 'read write']);
    expect(out.scopes).toBe('read write');
  });

  test('--source scopes the OAuth client', () => {
    const out = parseRegisterClientArgs(['--source', 'dept-x']);
    expect(out.sourceId).toBe('dept-x');
  });

  test('--federated-read comma-separated → array', () => {
    const out = parseRegisterClientArgs(['--federated-read', 'dept-x,wecare,shared']);
    expect(out.federatedRead).toEqual(['dept-x', 'wecare', 'shared']);
  });

  // T3 REGRESSION: pre-fix indexOf parser only took the first --redirect-uri
  describe('--redirect-uri (REPEATABLE — T3 regression)', () => {
    test('single --redirect-uri → single-element array', () => {
      const out = parseRegisterClientArgs(['--redirect-uri', 'https://claude.ai/api/mcp/auth_callback']);
      expect(out.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
    });

    test('two --redirect-uri → both preserved', () => {
      // THE REGRESSION: pre-fix this returned only the first URI.
      const out = parseRegisterClientArgs([
        '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback',
        '--redirect-uri', 'https://claude.com/api/mcp/auth_callback',
      ]);
      expect(out.redirectUris).toEqual([
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ]);
    });

    test('three --redirect-uri → all three preserved', () => {
      const out = parseRegisterClientArgs([
        '--redirect-uri', 'https://a.example/cb',
        '--redirect-uri', 'https://b.example/cb',
        '--redirect-uri', 'https://c.example/cb',
      ]);
      expect(out.redirectUris).toHaveLength(3);
    });
  });

  describe('--token-endpoint-auth-method', () => {
    test('omitted → undefined (provider applies RFC 7591 default)', () => {
      const out = parseRegisterClientArgs([]);
      expect(out.tokenEndpointAuthMethod).toBeUndefined();
    });

    test('"none" → "none" (public PKCE client)', () => {
      const out = parseRegisterClientArgs(['--token-endpoint-auth-method', 'none']);
      expect(out.tokenEndpointAuthMethod).toBe('none');
    });

    test('"client_secret_post" → "client_secret_post"', () => {
      const out = parseRegisterClientArgs(['--token-endpoint-auth-method', 'client_secret_post']);
      expect(out.tokenEndpointAuthMethod).toBe('client_secret_post');
    });

    test('"client_secret_basic" → "client_secret_basic"', () => {
      const out = parseRegisterClientArgs(['--token-endpoint-auth-method', 'client_secret_basic']);
      expect(out.tokenEndpointAuthMethod).toBe('client_secret_basic');
    });

    test('CLI parser does NOT validate the value — validator is on registerClientManual', () => {
      // Parser is shape-only. The validator runs at the registration boundary
      // so the same gate applies to CLI / admin / DCR. Putting validation in
      // the parser would mean DCR'd ApiClient strings bypass the same gate.
      const out = parseRegisterClientArgs(['--token-endpoint-auth-method', 'frobnicate']);
      expect(out.tokenEndpointAuthMethod).toBe('frobnicate');
    });
  });

  describe('combination flows (worked examples from SECURITY.md)', () => {
    test('claude.ai pre-registration (confidential, two redirect URIs)', () => {
      const out = parseRegisterClientArgs([
        '--grant-types', 'authorization_code,refresh_token',
        '--scopes', 'read write',
        '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback',
        '--redirect-uri', 'https://claude.com/api/mcp/auth_callback',
      ]);
      expect(out.grantTypes).toEqual(['authorization_code', 'refresh_token']);
      expect(out.scopes).toBe('read write');
      expect(out.redirectUris).toHaveLength(2);
      expect(out.tokenEndpointAuthMethod).toBeUndefined();
    });

    test('ChatGPT pre-registration (PKCE public client)', () => {
      const out = parseRegisterClientArgs([
        '--grant-types', 'authorization_code,refresh_token',
        '--scopes', 'read write',
        '--redirect-uri', 'https://chatgpt.com/connector/oauth/HASH',
        '--token-endpoint-auth-method', 'none',
      ]);
      expect(out.grantTypes).toEqual(['authorization_code', 'refresh_token']);
      expect(out.redirectUris).toEqual(['https://chatgpt.com/connector/oauth/HASH']);
      expect(out.tokenEndpointAuthMethod).toBe('none');
    });

    test('--redirect-uri without --grant-types → auto-infers authorization_code,refresh_token', () => {
      // Operator ergonomics: --redirect-uri without grant_types implies the
      // browser-OAuth flow; redundantly passing --grant-types is footgun.
      const out = parseRegisterClientArgs([
        '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback',
      ]);
      expect(out.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    });

    test('--redirect-uri + explicit --grant-types keeps the explicit set', () => {
      const out = parseRegisterClientArgs([
        '--grant-types', 'authorization_code',  // no refresh
        '--redirect-uri', 'https://example.test/cb',
      ]);
      expect(out.grantTypes).toEqual(['authorization_code']);
    });
  });

  describe('error cases', () => {
    test('--redirect-uri without value → throws', () => {
      expect(() => parseRegisterClientArgs(['--redirect-uri'])).toThrow(/requires a value/);
    });

    test('--redirect-uri followed by another flag → throws (no greedy consume)', () => {
      expect(() => parseRegisterClientArgs(['--redirect-uri', '--scopes', 'read'])).toThrow(/requires a value/);
    });

    test('unknown --flag throws', () => {
      expect(() => parseRegisterClientArgs(['--frobnicate', 'value'])).toThrow(/Unknown flag/);
    });
  });
});
