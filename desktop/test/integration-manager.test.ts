import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createSharedIntegration,
  configureQwenPawDesktopIntegration,
  configureIntegration,
  formatSharedIntegrationSnippet,
  getSharedAccessContext,
  integrationConfigPath,
  probeQwenPawConnectionState,
  qwenPawDriverIsConfigured,
  qwenPawIntegrationPath,
  revokeSharedIntegration,
  smokeTestSharedIntegration,
  writeCodexIntegration,
  writeJsonIntegration,
  writeQwenPawIntegration,
} from '../src/main/integration-manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-mcp-'));
  roots.push(root);
  return join(root, name);
}

describe('desktop integration config merging', () => {
  test('formats remote JSON and Codex snippets with the LAN URL and bearer token', () => {
    const url = 'http://192.168.1.20:3131/mcp';
    const json = JSON.parse(formatSharedIntegrationSnippet('cursor', url, 'secret'));
    expect(json.mcpServers.pmbrain.url).toBe(url);
    expect(json.mcpServers.pmbrain.headers.Authorization).toBe('Bearer secret');

    const codex = formatSharedIntegrationSnippet('codex', url, 'secret');
    expect(codex).toContain('[mcp_servers.pmbrain]');
    expect(codex).toContain(url);
    expect(codex).toContain('Bearer secret');
  });

  test('creates shared member credentials as read-only unless write is explicitly enabled', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    const sidecar = {
      adminRequest: async (path: string, init?: RequestInit) => {
        calls.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
        return {
          id: 'key-1', token: 'pmbrain_secret', name: 'shared:Alice', scopes: ['read'],
          sourceId: 'default', federatedRead: ['default', 'shared'],
        };
      },
    };
    const result = await createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Alice', client: 'workbuddy', sourceId: 'default', federatedRead: ['default', 'shared'], canWrite: false },
    );

    expect(result.scopes).toEqual(['read']);
    expect(result.snippet).toContain('http://192.168.1.20:3131/mcp');
    const body = JSON.parse(calls[0].body!);
    expect(body.name).toStartWith('shared:Alice:');
    expect(body.scopes).toBe('read');
    expect(body.scopes).not.toContain('admin');
    expect(body.federatedRead).toEqual(['default', 'shared']);
  });

  test('adds write only after explicit opt-in and rejects loopback sharing URLs', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const sidecar = {
      adminRequest: async (_path: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return { id: 'key-2', token: 'token', scopes: ['read', 'write'], sourceId: 'team', federatedRead: ['team'] };
      },
    };
    await createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Bob', client: 'codex', sourceId: 'team', federatedRead: ['team'], canWrite: true },
    );
    expect(requestBody?.scopes).toBe('read write');
    expect(requestBody?.scopes).not.toContain('admin');

    await expect(createSharedIntegration(
      sidecar as never,
      'http://127.0.0.1:3131/mcp',
      { memberName: 'Bob', client: 'cursor', sourceId: 'team', federatedRead: ['team'], canWrite: false },
    )).rejects.toThrow('局域网');
  });

  test('requires an explicit write source and makes write imply read on that source', async () => {
    const requests: Record<string, unknown>[] = [];
    const sidecar = {
      adminRequest: async (_path: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return {
          id: 'key-3', token: 'token', name: body.name, scopes: ['read', 'write'],
          sourceId: 'team', federatedRead: ['public', 'team'],
        };
      },
    };

    await expect(createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Carol', client: 'cursor', federatedRead: ['public'], canWrite: true },
    )).rejects.toThrow('必须明确选择');

    await createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Carol', client: 'cursor', sourceId: 'team', federatedRead: ['public'], canWrite: true },
    );
    expect(requests[0].federatedRead).toEqual(['public', 'team']);
  });

  test('revokes a newly created credential when returned scopes do not match exactly', async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const sidecar = {
      adminRequest: async (path: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ path, body });
        if (path.endsWith('/revoke')) return { revoked: true };
        return {
          id: 'bad-key', token: 'token', name: body.name, scopes: ['admin', 'read', 'write'],
          sourceId: 'team', federatedRead: ['team'],
        };
      },
    };

    await expect(createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Mallory', client: 'cursor', sourceId: 'team', federatedRead: ['team'], canWrite: true },
    )).rejects.toThrow('已立即撤销');
    expect(calls.at(-1)?.path).toBe('/admin/api/api-keys/revoke');
    expect(String(calls.at(-1)?.body?.name)).toStartWith('shared:Mallory:');
  });


  test('revokes a credential when the create response omits its token or id', async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const sidecar = {
      adminRequest: async (path: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ path, body });
        if (path.endsWith('/revoke')) return { revoked: true };
        return { id: '', token: '', name: body.name, scopes: ['read'], federatedRead: ['team'] };
      },
    };

    await expect(createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Incomplete', client: 'cursor', federatedRead: ['team'], canWrite: false },
    )).rejects.toThrow('已立即撤销');
    expect(calls.at(-1)?.path).toBe('/admin/api/api-keys/revoke');
    expect(String(calls.at(-1)?.body?.name)).toStartWith('shared:Incomplete:');
  });
  test('reports when an invalid credential cannot be rolled back automatically', async () => {
    const sidecar = {
      adminRequest: async (path: string, init?: RequestInit) => {
        if (path.endsWith('/revoke')) throw new Error('database unavailable');
        const body = JSON.parse(String(init?.body));
        return {
          id: 'bad-key', token: 'token', name: body.name, scopes: ['admin'],
          sourceId: 'team', federatedRead: ['team'],
        };
      },
    };
    await expect(createSharedIntegration(
      sidecar as never,
      'http://192.168.1.20:3131/mcp',
      { memberName: 'Rollback', client: 'cursor', sourceId: 'team', federatedRead: ['team'], canWrite: true },
    )).rejects.toThrow('自动撤销失败');
  });

  test('lists unique shared credentials and revokes only the selected generated name', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    const sidecar = {
      adminRequest: async (path: string, init?: RequestInit) => {
        calls.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
        if (path === '/admin/api/brain/overview') {
          return { main_source_id: 'default', sources: [{ id: 'default', name: '公司知识', federated: true }] };
        }
        if (path === '/admin/api/agents') {
          return [{
            id: 'key-1', name: 'shared:Alice:1a2b3c4d-1111-4111-8111-123456789abc', auth_type: 'api_key', status: 'active',
            scope: 'read', source_id: 'default', federated_read: ['default'], total_requests: 3,
          }];
        }
        return { revoked: true };
      },
    };

    const context = await getSharedAccessContext(sidecar as never, 'http://192.168.1.20:3131/mcp');
    expect(context.credentials[0].name).toBe('Alice');
    expect(context.credentials[0].credentialName).toBe('shared:Alice:1a2b3c4d-1111-4111-8111-123456789abc');

    await revokeSharedIntegration(sidecar as never, context.credentials[0].credentialName);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: 'shared:Alice:1a2b3c4d-1111-4111-8111-123456789abc' });
  });

  test('smokes the actual LAN endpoint and rejects tool-level errors', async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      if (request.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'whoami' }, { name: 'search' }] } }));
      }
      if (request.method === 'tools/call') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ transport: 'legacy', token_name: 'shared:Alice:test', scopes: ['read'] }) }] },
        }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
    }) as typeof fetch;
    try {
      const result = await smokeTestSharedIntegration(
        'http://192.168.1.20:3131/mcp', 'secret', ['read'], 'shared:Alice:test',
      );
      expect(result).toEqual({ toolCount: 2, transport: 'legacy', scopes: ['read'] });
      expect(methods).toEqual(['initialize', 'tools/list', 'tools/call']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a LAN smoke response that exposes an unreviewed tool', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'whoami' }, { name: 'takes_list' }] }
        : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }) as typeof fetch;
    try {
      await expect(smokeTestSharedIntegration(
        'http://192.168.1.20:3131/mcp', 'secret', ['read'], 'shared:Alice:test',
      )).rejects.toThrow('未审计工具');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses the Trae user-level MCP config and preserves other servers', () => {
    const path = integrationConfigPath('trae');
    expect(path).toEndWith(join('Trae', 'User', 'mcp.json'));

    const configPath = tempFile('mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }));
    writeJsonIntegration(configPath, 'http://127.0.0.1:3131/mcp', 'secret', dirname(configPath));
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(parsed.mcpServers.existing.command).toBe('keep-me');
    expect(parsed.mcpServers.pmbrain.headers.Authorization).toBe('Bearer secret');
  });

  test('uses Workbuddy mcp.json path', () => {
    const path = integrationConfigPath('workbuddy');
    expect(path).toEndWith(join('.workbuddy', 'mcp.json'));
    expect(path).not.toEndWith(join('.workbuddy', '.mcp.json'));
  });

  test('uses legacy QwenPaw config before 2.x and the DriverCard path for 2.x', () => {
    const home = tempFile('home');
    expect(qwenPawIntegrationPath(home)).toEndWith(join('.qwenpaw', 'config.json'));
    mkdirSync(join(home, '.qwenpaw'), { recursive: true });
    writeFileSync(join(home, '.qwenpaw', 'desktop_port'), '60913');
    expect(qwenPawIntegrationPath(home)).toEndWith(
      join('.qwenpaw', 'workspaces', 'default', 'drivers', 'mcp', 'pmbrain.yaml'),
    );
  });

  test('never routes QwenPaw one-click setup through OAuth', async () => {
    await expect(configureIntegration({} as never, 'qwenpaw', 'oauth')).rejects.toThrow(
      '固定使用 API Key + Bearer',
    );
  });

  test('reports a saved QwenPaw DriverCard without assuming credentials remain plaintext', () => {
    const home = tempFile('home');
    const root = join(home, '.qwenpaw', 'workspaces', 'default');
    const driver = join(root, 'drivers', 'mcp', 'pmbrain.yaml');
    const credentials = join(root, 'credentials.yaml');
    mkdirSync(dirname(driver), { recursive: true });
    writeFileSync(driver, [
      'name: pmbrain',
      'protocol: mcp',
      'endpoint:',
      '  transport: streamable_http',
      '  url: http://127.0.0.1:3131/mcp',
      '  headers:',
      '    Authorization:',
    ].join('\n'));
    writeFileSync(credentials, [
      'version: 1',
      'credentials:',
      '  mcp/pmbrain:',
      '    kind: static',
      '    secrets:',
      '      authorization:',
    ].join('\n'));
    expect(qwenPawDriverIsConfigured(driver)).toBe(false);
    writeFileSync(credentials, readFileSync(credentials, 'utf8').replace(
      '      authorization:',
      '      authorization: encrypted-qwenpaw-secret',
    ));
    expect(qwenPawDriverIsConfigured(driver)).toBe(true);
  });

  test('uses the QwenPaw tools API as the source of truth for connected versus saved', async () => {
    const home = tempFile('home');
    const root = join(home, '.qwenpaw', 'workspaces', 'default');
    const driver = join(root, 'drivers', 'mcp', 'pmbrain.yaml');
    const credentials = join(root, 'credentials.yaml');
    mkdirSync(dirname(driver), { recursive: true });
    mkdirSync(join(home, '.qwenpaw'), { recursive: true });
    writeFileSync(join(home, '.qwenpaw', 'desktop_port'), '60913');
    writeFileSync(driver, [
      'name: pmbrain',
      'endpoint:',
      '  url: http://127.0.0.1:3131/mcp',
      '  headers:',
      '    Authorization:',
    ].join('\n'));
    writeFileSync(credentials, [
      'credentials:',
      '  mcp/pmbrain:',
      '    secrets:',
      '      authorization: encrypted-qwenpaw-secret',
    ].join('\n'));
    const connected = (async () => new Response(JSON.stringify([{ name: 'search' }]))) as typeof fetch;
    const inactive = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await probeQwenPawConnectionState(home, connected)).toBe('connected');
    expect(await probeQwenPawConnectionState(home, inactive)).toBe('saved');
  });

  test('preserves unrelated JSON MCP servers', () => {
    const path = tempFile('mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } }, theme: 'dark' }));
    writeJsonIntegration(path, 'http://127.0.0.1:3131/mcp', 'secret', dirname(path));
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.theme).toBe('dark');
    expect(result.mcpServers.existing.command).toBe('keep-me');
    expect(result.mcpServers.pmbrain.headers.Authorization).toBe('Bearer secret');
  });

  test('preserves Workbuddy connector proxy config', () => {
    const path = tempFile('.mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        'connector-proxy': {
          command: 'workbuddy-connector-proxy',
          args: ['--profile', 'default'],
        },
      },
    }));
    writeJsonIntegration(path, 'http://127.0.0.1:3131/mcp', 'secret', dirname(path));
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.mcpServers['connector-proxy'].command).toBe('workbuddy-connector-proxy');
    expect(result.mcpServers['connector-proxy'].args).toEqual(['--profile', 'default']);
    expect(result.mcpServers.pmbrain.url).toBe('http://127.0.0.1:3131/mcp');
  });

  test('merges QwenPaw mcp.clients without changing existing clients or settings', () => {
    const path = tempFile('config.json');
    writeFileSync(path, JSON.stringify({
      user_timezone: 'Asia/Shanghai',
      mcp: {
        migration_version: 2,
        clients: {
          tavily_search: {
            name: 'Tavily Search',
            enabled: true,
            transport: 'streamable_http',
            url: 'https://example.test/mcp',
          },
        },
      },
    }));

    const backup = writeQwenPawIntegration(
      path,
      'http://127.0.0.1:3131/mcp',
      'secret',
      dirname(path),
    );
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.user_timezone).toBe('Asia/Shanghai');
    expect(result.mcp.migration_version).toBe(2);
    expect(result.mcp.clients.tavily_search.url).toBe('https://example.test/mcp');
    expect(result.mcp.clients.pmbrain).toEqual({
      name: 'PMBrain',
      description: 'PMBrain 本地知识库',
      enabled: true,
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3131/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(backup).not.toBeNull();
    expect(readFileSync(backup!, 'utf8')).not.toContain('pmbrain');
  });

  test('does not overwrite malformed QwenPaw config', () => {
    const path = tempFile('config.json');
    writeFileSync(path, '{ invalid');
    expect(() => writeQwenPawIntegration(
      path,
      'http://127.0.0.1:3131/mcp',
      'secret',
      dirname(path),
    )).toThrow('不是有效 JSON');
    expect(readFileSync(path, 'utf8')).toBe('{ invalid');
  });

  test('updates QwenPaw 2.x through its local API with a complete Bearer header and verifies tools', async () => {
    const home = tempFile('home');
    const root = join(home, '.qwenpaw');
    const driver = join(root, 'workspaces', 'default', 'drivers', 'mcp', 'pmbrain.yaml');
    const credentials = join(root, 'workspaces', 'default', 'credentials.yaml');
    mkdirSync(dirname(driver), { recursive: true });
    writeFileSync(join(root, 'desktop_port'), '60913');
    writeFileSync(driver, 'name: pmbrain\n');
    writeFileSync(credentials, 'version: 1\ncredentials: {}\n');
    const calls: Array<{ url: string; method: string; body?: Record<string, any> }> = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/mcp/tools/pmbrain')) {
        return new Response(JSON.stringify([{ name: 'search' }, { name: 'get_page' }]));
      }
      return new Response(JSON.stringify({ key: 'pmbrain' }), { status: 200 });
    }) as typeof fetch;

    const result = await configureQwenPawDesktopIntegration(
      'http://127.0.0.1:3131/mcp',
      'pmbrain-secret',
      home,
      home,
      request,
    );

    expect(calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(calls[1].body?.headers.Authorization).toBe('Bearer pmbrain-secret');
    expect(calls[1].body?.transport).toBe('streamable_http');
    expect(result.path).toBe(driver);
    expect(result.toolCount).toBe(2);
    expect(result.connected).toBe(true);
    expect(result.backup).not.toBeNull();
    expect(readFileSync(result.backup!, 'utf8')).toBe('name: pmbrain\n');
  });

  test('creates QwenPaw 2.x through its local API when PMBrain is absent', async () => {
    const home = tempFile('home');
    const root = join(home, '.qwenpaw');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'desktop_port'), '60913');
    const calls: Array<{ url: string; method: string; body?: Record<string, any> }> = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/mcp/pmbrain') && method === 'GET') return new Response('', { status: 404 });
      if (url.endsWith('/api/mcp/tools/pmbrain')) return new Response('[]');
      return new Response(JSON.stringify({ key: 'pmbrain' }), { status: 201 });
    }) as typeof fetch;

    await configureQwenPawDesktopIntegration(
      'http://127.0.0.1:3131/mcp',
      'secret',
      home,
      home,
      request,
    );
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[1].body?.client_key).toBe('pmbrain');
    expect(calls[1].body?.client.headers.Authorization).toBe('Bearer secret');
  });

  test('returns a saved state instead of pretending an inactive QwenPaw client was not written', async () => {
    const home = tempFile('home');
    const root = join(home, '.qwenpaw');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'desktop_port'), '60913');
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/pmbrain') && (init?.method ?? 'GET') === 'GET') {
        return new Response('', { status: 404 });
      }
      if (url.endsWith('/api/mcp/tools/pmbrain')) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ key: 'pmbrain' }), { status: 201 });
    }) as typeof fetch;

    const result = await configureQwenPawDesktopIntegration(
      'http://127.0.0.1:3131/mcp',
      'secret',
      home,
      home,
      request,
      async () => undefined,
    );
    expect(result.connected).toBe(false);
    expect(result.toolCount).toBe(0);
    expect(result.path).toEndWith(join('drivers', 'mcp', 'pmbrain.yaml'));
  });

  test('replaces only the managed Codex block', () => {
    const path = tempFile('config.toml');
    writeFileSync(path, 'model = "gpt-test"\n');
    writeCodexIntegration(path, 'http://127.0.0.1:3131/mcp', 'first', dirname(path));
    writeCodexIntegration(path, 'http://127.0.0.1:3132/mcp', 'second', dirname(path));
    const result = readFileSync(path, 'utf8');
    expect(result).toContain('model = "gpt-test"');
    expect(result).toContain('http://127.0.0.1:3132/mcp');
    expect(result).not.toContain('Bearer first');
    expect(result.match(/\[mcp_servers\.pmbrain\]/g)?.length).toBe(1);
  });
});
