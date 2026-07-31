/**
 * Tests for resolveProtectedResourceUrls() in src/commands/serve-http.ts —
 * the first coverage of the OAuth protected-resource metadata surface.
 *
 * gbrain's protected resource is `/mcp`, not the server root. Left
 * undeclared, the MCP SDK falls back to treating the authorization server as
 * its own resource: it advertises `resource: <issuer origin>` and mounts the
 * metadata at the bare `/.well-known/oauth-protected-resource`. Clients
 * honoring RFC 8707 resource indicators then request tokens bound to the
 * wrong resource.
 *
 * The coupling that makes this worth a test: declaring resourceServerUrl
 * ALSO moves the document to RFC 9728 §3.1's path-suffixed location. The 401
 * `WWW-Authenticate: resource_metadata=` value must move with it, or the
 * header advertises a URL that 404s — the exact discovery failure the header
 * exists to prevent. Deriving both from one input is what these assertions
 * pin.
 */

import { describe, test, expect } from 'bun:test';
import { resolveProtectedResourceUrls } from '../src/commands/serve-http.ts';

describe('resolveProtectedResourceUrls', () => {
  test('the protected resource is /mcp, not the issuer origin', () => {
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com'));
    expect(r.resourceServerUrl.href).toBe('https://brain.example.com/mcp');
  });

  test('metadata lives at the RFC 9728 path-suffixed location', () => {
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com'));
    expect(r.resourceMetadataPath).toBe('/.well-known/oauth-protected-resource/mcp');
  });

  test('the 401 resource_metadata URL points at the path the SDK actually serves', () => {
    // The regression this exists for: hand-building this string left it on
    // the bare path after the SDK moved the document, so a fresh 401 sent
    // clients to a 404 and the OAuth flow never started.
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com'));
    expect(r.resourceMetadataUrl).toBe(
      'https://brain.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(r.resourceMetadataUrl.endsWith(r.resourceMetadataPath)).toBe(true);
  });

  test('no double slash when the issuer carries a trailing slash', () => {
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com/'));
    expect(r.resourceMetadataUrl).toBe(
      'https://brain.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(r.resourceMetadataUrl).not.toContain('//.well-known');
  });

  test('localhost dev issuer keeps its port', () => {
    const r = resolveProtectedResourceUrls(new URL('http://localhost:8787'));
    expect(r.resourceServerUrl.href).toBe('http://localhost:8787/mcp');
    expect(r.resourceMetadataUrl).toBe(
      'http://localhost:8787/.well-known/oauth-protected-resource/mcp',
    );
  });

  test('the legacy bare path is preserved as an alias', () => {
    // Clients and the runbook curl cached this from earlier releases.
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com'));
    expect(r.legacyResourceMetadataPath).toBe('/.well-known/oauth-protected-resource');
  });

  test('the alias path is a strict prefix of the canonical one', () => {
    // Express matches in registration order, so the alias must not shadow
    // the SDK's suffixed route by being identical to it.
    const r = resolveProtectedResourceUrls(new URL('https://brain.example.com'));
    expect(r.resourceMetadataPath).not.toBe(r.legacyResourceMetadataPath);
    expect(r.resourceMetadataPath.startsWith(r.legacyResourceMetadataPath)).toBe(true);
  });
});
