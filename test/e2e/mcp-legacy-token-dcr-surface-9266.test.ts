/**
 * #9266: `mcp.default_surface_dcr` is the default for OAuth clients whose
 * oauth_clients row carries no surface. A legacy bearer token has no such row
 * (and no way to pre-seed one), so it keeps the server ceiling and stays
 * bounded by its own scope, source and operation grants.
 *
 * Real `gbrain serve --http` processes against a hermetic PGLite brain:
 *   - legacy token (read+write, operations whoami+add_link) under the starter
 *     default: add_link is listed and callable, put_page stays refused;
 *   - an OAuth client with no surface row still resolves to starter;
 *   - GBRAIN_MCP_FORCE_SURFACE=starter still clamps the legacy token.
 *
 * Run: bash scripts/run-e2e.sh test/e2e/mcp-legacy-token-dcr-surface-9266.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { startServeHttp, type ServeHttp } from '../helpers/serve-http.ts';
import { mintClientCredentialsToken } from '../../src/core/remote-mcp-probe.ts';

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

describe('#9266 mcp.default_surface_dcr applies to OAuth clients only (PGLite + real serve --http)', () => {
  let home: string;
  let env: Record<string, string>;
  let legacyToken = '';
  let clientId = '';
  let clientSecret = '';

  const gbrain = (args: string[], input?: string) =>
    execFileSync(process.execPath, ['--no-env-file', CLI, ...args], { cwd: process.cwd(), env, encoding: 'utf8', input });

  async function withServer<T>(extraEnv: Record<string, string>, fn: (server: ServeHttp) => Promise<T>): Promise<T> {
    const server = await startServeHttp({ cwd: process.cwd(), env: { ...env, ...extraEnv } });
    try { return await fn(server); } finally { await server.stop(); }
  }

  async function withClient<T>(server: ServeHttp, bearer: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const client = new Client({ name: 'gbrain-9266-e2e', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    try { return await fn(client); } finally { try { await client.close(); } catch { /* best-effort */ } }
  }

  const toolNames = async (client: Client) => (await client.listTools()).tools.map(t => t.name);

  async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    try {
      const res = await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: Array<{ text?: string }> };
      return { isError: res.isError === true, text: (res.content ?? []).map(c => c.text ?? '').join('\n') };
    } catch (e) {
      return { isError: true, text: e instanceof Error ? e.message : String(e) };
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-9266-'));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined });
    gbrain(['init', '--pglite', '--no-embedding', '--non-interactive']);
    gbrain(['put', 'people/alice-example', '--content-origin', 'user_said'], '---\ntitle: Alice Example\ntype: person\n---\nAlice works at Acme.\n');
    gbrain(['put', 'companies/acme-example', '--content-origin', 'user_said'], '---\ntitle: Acme Example\ntype: company\n---\nAcme makes widgets.\n');

    const created = gbrain(['auth', 'create', 'legacy-a', '--scopes', 'read,write']);
    legacyToken = (created.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    if (!legacyToken) throw new Error(`auth create did not yield a token:\n${created}`);
    gbrain(['auth', 'rescope', '--token', 'legacy-a', '--operations', 'whoami,add_link', '--sources', 'default']);

    const reg = gbrain(['auth', 'register-client', 'oauth-a', '--grant-types', 'client_credentials', '--scopes', 'read write',
      '--token-endpoint-auth-method', 'client_secret_post']);
    clientId = /Client ID:\s+(\S+)/.exec(reg)?.[1] ?? '';
    clientSecret = /Client Secret:\s+(\S+)/.exec(reg)?.[1] ?? '';
    if (!clientId || !clientSecret) throw new Error(`register-client did not yield credentials:\n${reg}`);

    gbrain(['config', 'set', 'mcp.default_surface_dcr', 'starter']);
  }, 120_000);

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('legacy token keeps the server ceiling: add_link listed and callable, put_page still refused', async () => {
    await withServer({}, server => withClient(server, legacyToken, async client => {
      const names = await toolNames(client);
      expect(names).toContain('add_link');
      expect(names).toContain('whoami');
      expect(names).not.toContain('put_page');

      const linked = await callText(client, 'add_link', { from: 'people/alice-example', to: 'companies/acme-example' });
      expect(linked).toMatchObject({ isError: false });

      const put = await callText(client, 'put_page', { slug: 'notes/denied-example', content: 'x' });
      expect(put.isError).toBe(true);
    }));
  }, 120_000);

  test('an OAuth client with no surface row still resolves to the starter default', async () => {
    await withServer({}, async server => {
      const minted = await mintClientCredentialsToken(`${server.base}/token`, clientId, clientSecret, { scope: 'read write' });
      if (!minted.ok) throw new Error(`client_credentials mint failed: ${JSON.stringify(minted)}`);
      await withClient(server, minted.token.access_token, async client => {
        const names = await toolNames(client);
        expect(names).toContain('whoami');
        expect(names).not.toContain('add_link');
        const linked = await callText(client, 'add_link', { from: 'people/alice-example', to: 'companies/acme-example' });
        expect(linked.isError).toBe(true);
      });
    });
  }, 120_000);

  test('GBRAIN_MCP_FORCE_SURFACE=starter still clamps the legacy token', async () => {
    await withServer({ GBRAIN_MCP_FORCE_SURFACE: 'starter' }, server => withClient(server, legacyToken, async client => {
      const names = await toolNames(client);
      expect(names).toContain('whoami');
      expect(names).not.toContain('add_link');
      const linked = await callText(client, 'add_link', { from: 'people/alice-example', to: 'companies/acme-example' });
      expect(linked.isError).toBe(true);
    }));
  }, 120_000);
});
