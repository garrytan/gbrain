/**
 * GST-3791: on the OAuth HTTP transport, `request_tools {surface}` persists the
 * client's wider surface and sends `notifications/tools/list_changed` on its
 * own response stream (the server is stateless, so GET /mcp has no stream to
 * push on), and initialize declares `tools.listChanged`. A client that
 * honours the notification re-lists, sees the widened tools, and calls one.
 *
 * Real `gbrain serve --http` against a hermetic PGLite brain, with an OAuth
 * client_credentials client whose surface defaults to starter.
 *
 * Run: bash scripts/run-e2e.sh test/e2e/mcp-request-tools-http-list-changed.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { startServeHttp } from '../helpers/serve-http.ts';
import { mintClientCredentialsToken } from '../../src/core/remote-mcp-probe.ts';

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

describe('GST-3791 request_tools on HTTP: persist -> tools/list_changed -> tools/list -> call (PGLite + real serve --http)', () => {
  let home: string;
  let env: Record<string, string>;
  let clientId = '';
  let clientSecret = '';

  const gbrain = (args: string[], input?: string) =>
    execFileSync(process.execPath, ['--no-env-file', CLI, ...args], { cwd: process.cwd(), env, encoding: 'utf8', input });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-gst3791-'));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined });
    gbrain(['init', '--pglite', '--no-embedding', '--non-interactive']);
    gbrain(['put', 'people/alice-example', '--content-origin', 'user_said'], '---\ntitle: Alice Example\ntype: person\ntags: [example]\n---\nAlice works at Acme.\n');
    const reg = gbrain(['auth', 'register-client', 'oauth-gst3791', '--grant-types', 'client_credentials', '--scopes', 'read write',
      '--token-endpoint-auth-method', 'client_secret_post']);
    clientId = /Client ID:\s+(\S+)/.exec(reg)?.[1] ?? '';
    clientSecret = /Client Secret:\s+(\S+)/.exec(reg)?.[1] ?? '';
    if (!clientId || !clientSecret) throw new Error(`register-client did not yield credentials:\n${reg}`);
    gbrain(['config', 'set', 'mcp.default_surface_dcr', 'starter']);
  }, 120_000);

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('a starter client widens to full and the notification arrives before the request_tools result', async () => {
    const server = await startServeHttp({ cwd: process.cwd(), env });
    try {
      const minted = await mintClientCredentialsToken(`${server.base}/token`, clientId, clientSecret, { scope: 'read write' });
      if (!minted.ok) throw new Error(`client_credentials mint failed: ${JSON.stringify(minted)}`);
      const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${minted.token.access_token}` } },
      });
      const client = new Client({ name: 'gbrain-gst3791-e2e', version: '1' }, { capabilities: {} });
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
      await client.connect(transport);
      try {
        expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
        const before = (await client.listTools()).tools.map(t => t.name);
        expect(before).toContain('request_tools');
        expect(before).not.toContain('get_tags');

        const res = await client.callTool({ name: 'request_tools', arguments: { surface: 'full' } }) as { isError?: boolean; content: Array<{ text: string }> };
        expect(res.isError ?? false).toBe(false);
        const body = JSON.parse(res.content[0]!.text) as { persisted: boolean; surface: string; note: string };
        expect(body).toMatchObject({ persisted: true, surface: 'full' });
        expect(body.note).toContain('tools/list_changed was sent');
        expect(changed).toBe(1);

        const after = (await client.listTools()).tools.map(t => t.name);
        expect(after).toContain('get_tags');
        const tags = await client.callTool({ name: 'get_tags', arguments: { slug: 'people/alice-example' } }) as { isError?: boolean; content: Array<{ text: string }> };
        expect(tags.isError ?? false).toBe(false);
        expect(tags.content[0]!.text).toContain('example');
      } finally {
        try { await client.close(); } catch { /* best-effort */ }
      }
    } finally {
      await server.stop();
    }
  }, 120_000);

  test('a request_tools call that changes nothing sends no notification', async () => {
    const server = await startServeHttp({ cwd: process.cwd(), env });
    try {
      const minted = await mintClientCredentialsToken(`${server.base}/token`, clientId, clientSecret, { scope: 'read write' });
      if (!minted.ok) throw new Error(`client_credentials mint failed: ${JSON.stringify(minted)}`);
      const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${minted.token.access_token}` } },
      });
      const client = new Client({ name: 'gbrain-gst3791-e2e', version: '1' }, { capabilities: {} });
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
      await client.connect(transport);
      try {
        const res = await client.callTool({ name: 'request_tools', arguments: { tools: ['get_tags'] } }) as { isError?: boolean };
        expect(res.isError ?? false).toBe(false);
        expect(changed).toBe(0);
      } finally {
        try { await client.close(); } catch { /* best-effort */ }
      }
    } finally {
      await server.stop();
    }
  }, 120_000);
});
