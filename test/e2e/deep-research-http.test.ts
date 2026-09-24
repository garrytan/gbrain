import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { encodeDeepResearchId } from '../../src/core/deep-research-id.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const databaseUrl = process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('real HTTP MCP deep research authorization', () => {
  let engine: PostgresEngine;
  let close: (() => Promise<void>) | undefined;
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let home: string;
  let base: string;
  let provider: GBrainOAuthProvider;
  let clientId: string;
  let token: string;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('beta', 'beta')`);
    await engine.setConfig('search.mcp_keyword_only', 'true');
    for (const [sourceId, body] of [['default', 'Unrelated default material.'], ['beta', 'Zirconiumneedle beta evidence.']]) {
      await engine.putPage('notes/shared-example', { type: 'note', title: sourceId, compiled_truth: body }, { sourceId });
      await installFixtureChunks(engine, 'notes/shared-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }], { sourceId });
    }
    provider = new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine),
      transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
    });
    const client = await provider.registerClientManual('deep-research-fixture', ['client_credentials'], 'read', [], 'default', ['default', 'beta']);
    clientId = client.clientId;
    token = (await provider.exchangeClientCredentials(clientId, client.clientSecret!, 'read')).access_token;
    const [{ name }] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    const fixtureUrl = new URL(databaseUrl!);
    fixtureUrl.pathname = '/' + name;
    home = mkdtempSync(join(tmpdir(), 'gbrain-deep-http-'));
    const probe = Bun.serve({ port: 0, fetch: () => new Response('fixture') });
    const port = probe.port!;
    probe.stop(true);
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn({
      cmd: [process.execPath, '--no-env-file', join(import.meta.dir, '../../src/cli.ts'), 'serve', '--http', '--port', String(port), '--public-url', base],
      cwd: home,
      env: keylessBrainEnv(process.env, home, {
        DATABASE_URL: fixtureUrl.toString(), GBRAIN_DATABASE_URL: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1',
      }),
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await Bun.sleep(250);
    }
    expect(ready).toBe(true);
  }, 90_000);

  afterAll(async () => {
    if (server) {
      server.kill('SIGTERM');
      const force = setTimeout(() => server?.kill('SIGKILL'), 5_000);
      try { await server.exited; } finally { clearTimeout(force); }
    }
    await close?.();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 30_000);

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await response.text();
    const payload = text.trim().startsWith('{') ? text : text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5);
    return { status: response.status, result: JSON.parse(payload).result };
  };

  test('search hit fetches beta; same token loses beta after live rescope, then revocation', async () => {
    const searched = await call('search', { query: 'Zirconiumneedle' });
    expect(searched.status).toBe(200);
    expect(searched.result.isError).not.toBe(true);
    const hits = JSON.parse(searched.result.content[0].text);
    expect(hits).toHaveLength(1);
    expect(hits[0].source_id).toBe('beta');
    const fetched = await call('fetch', { id: hits[0].id });
    expect(fetched.result.isError).not.toBe(true);
    const page = JSON.parse(fetched.result.content[0].text);
    expect(page.id).toBe(hits[0].id);
    expect(page.metadata.source_id).toBe('beta');
    expect(page.text).toContain('Zirconiumneedle beta evidence.');
    expect(page.url).toBe('gbrain://page/beta/notes/shared-example');
    await provider.rescopeClient(clientId, { federatedRead: ['default'] });
    const denied = await call('fetch', { id: hits[0].id });
    const missing = await call('fetch', { id: encodeDeepResearchId('default', 'notes/missing') });
    expect(denied.status).toBe(200);
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content).toEqual(missing.result.content);
    expect(JSON.stringify(denied.result)).not.toContain('beta');
    expect(JSON.stringify(denied.result)).not.toContain('Zirconiumneedle');
    await provider.revokeClient(clientId);
    const revoked = await call('fetch', { id: hits[0].id });
    expect(revoked.status).toBe(401);
    expect(revoked.result).toBeUndefined();
  });
});
