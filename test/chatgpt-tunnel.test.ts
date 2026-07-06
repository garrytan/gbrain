import { describe, expect, test } from 'bun:test';
import {
  buildChatGptTunnelProfile,
  normalizeTunnelHttpProxy,
  parseTunnelId,
} from '../src/core/chatgpt-tunnel.ts';
import { legacyAccessTokenScopes } from '../src/core/oauth-provider.ts';
import {
  CHATGPT_TUNNEL_READ_ONLY_TOOLS,
  buildMcpProtectedResourceMetadata,
  filterMcpOperationsForAuth,
  filterMcpOperationsByScopes,
  isLoopbackAddress,
} from '../src/commands/serve-http.ts';

describe('ChatGPT Secure MCP Tunnel', () => {
  test('legacy keys keep full access unless scopes are explicit', () => {
    expect(legacyAccessTokenScopes(undefined)).toEqual(['read', 'write', 'admin']);
    expect(legacyAccessTokenScopes({ takes_holders: ['world'] })).toEqual(['read', 'write', 'admin']);
    expect(legacyAccessTokenScopes({ scopes: ['read'] })).toEqual(['read']);
    expect(legacyAccessTokenScopes({ scopes: ['read', 'unknown'] })).toEqual(['read', 'write', 'admin']);
  });

  test('read-only clients only discover read tools', () => {
    const operations = [
      { name: 'search', scope: 'read' },
      { name: 'put_page', scope: 'write' },
      { name: 'schema_apply', scope: 'admin' },
    ];
    expect(filterMcpOperationsByScopes(operations, ['read']).map(op => op.name)).toEqual(['search']);
    expect(filterMcpOperationsByScopes(operations, ['write']).map(op => op.name)).toEqual(['search', 'put_page']);
  });

  test('ChatGPT tunnel only exposes the curated read-only browsing surface', () => {
    const operations = [
      { name: 'get_brain_identity', scope: 'read' },
      { name: 'search', scope: 'read' },
      { name: 'query', scope: 'read' },
      { name: 'list_pages', scope: 'read' },
      { name: 'get_page', scope: 'read' },
      { name: 'get_chunks', scope: 'read' },
      { name: 'recall', scope: 'read' },
      { name: 'get_recent_salience', scope: 'read' },
      { name: 'put_page', scope: 'write' },
      { name: 'delete_page', scope: 'write' },
      { name: 'schema_apply', scope: 'admin' },
    ];
    const visible = filterMcpOperationsForAuth(operations, {
      clientId: 'chatgpt-secure-tunnel',
      clientName: 'chatgpt-secure-tunnel',
      scopes: ['read'],
    }).map(op => op.name);
    expect(visible).toEqual([...CHATGPT_TUNNEL_READ_ONLY_TOOLS]);
  });

  test('tunnel administration is restricted to loopback sessions', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
  });

  test('publishes path-aware protected-resource metadata for the MCP endpoint', () => {
    const metadata = buildMcpProtectedResourceMetadata(new URL('http://localhost:3132'));
    expect(metadata.resource).toBe('http://localhost:3132/mcp');
    expect(metadata.authorization_servers).toEqual(['http://localhost:3132/']);
    expect(metadata.scopes_supported).toContain('read');
  });

  test('generated profile keeps both control-plane and MCP secrets as file references', () => {
    const profile = buildChatGptTunnelProfile({
      tunnelId: 'tunnel_example123',
      mcpUrl: 'http://127.0.0.1:3132/mcp',
      runtimeKeyFile: 'C:\\Users\\alice\\.pmbrain\\runtime.key',
      authorizationHeaderFile: 'C:\\Users\\alice\\.pmbrain\\authorization.header',
      httpProxy: 'http://127.0.0.1:7897',
    });
    expect(profile).toContain('control_plane:\n  base_url: "https://api.openai.com"\n  http_proxy: "http://127.0.0.1:7897"');
    expect(profile).not.toMatch(/^http_proxy:/m);
    expect(profile).toContain('api_key: "file:C:/Users/alice/.pmbrain/runtime.key"');
    expect(profile).toContain('extra_headers:\n    Authorization: "file:C:/Users/alice/.pmbrain/authorization.header"');
    expect(profile).toContain('discovery_extra_headers:\n    Authorization: "file:C:/Users/alice/.pmbrain/authorization.header"');
    expect(profile).not.toContain('- "Authorization:');
    expect(profile).not.toContain('sk-');
    expect(profile).not.toContain('Bearer pmbrain_');
    expect(parseTunnelId(profile)).toBe('tunnel_example123');
  });

  test('normalizes Windows proxy settings for tunnel-client', () => {
    expect(normalizeTunnelHttpProxy('127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(normalizeTunnelHttpProxy('http=127.0.0.1:8080;https=127.0.0.1:7897'))
      .toBe('http://127.0.0.1:7897');
    expect(normalizeTunnelHttpProxy(undefined)).toBeUndefined();
  });
});
