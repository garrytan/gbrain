import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { createManagedFixtureSource, withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { cliDiagnostic, fixtureDiagnostic, toolDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { withEnv } from '../helpers/with-env.ts';

const VISIBLE = 'quartzvisible';
const PRIVATE = 'cobaltprivate';
const FOREIGN = 'amberforeign';
const BOUND = 'matrix-bound';
const FEDERATED = 'matrix-federated';
const PRIVATE_SOURCE = 'matrix-private';
const backends = process.env.DATABASE_URL ? ['postgres', 'pglite'] as const : ['pglite'] as const;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

async function search(client: Client, query: string, source_id?: string) {
  const result = await client.callTool({ name: 'search', arguments: { query, ...(source_id ? { source_id } : {}) } });
  expect(result.isError, toolDiagnostic('search', result)).not.toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  const rows = JSON.parse(content[0]!.text) as Array<{ slug: string; source_id: string; cosine?: number }>;
  const meta = result._meta?.retrieval as { returned_count: number; vector_enabled?: boolean; degraded?: Array<{ stage: string; reason?: string }>; projection_readiness: { status: string } };
  expect(meta).toBeDefined();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  return { result, rows, meta, content };
}

for (const backend of backends) describe(`search transport safety matrix (${backend})`, () => {
  let home: string;
  let env: Record<string, string>;
  let engine: BrainEngine;
  let config: GBrainConfig;
  let cleanupPostgres: (() => Promise<void>) | undefined;
  let provider: ReturnType<typeof Bun.serve>;
  let providerState: 'healthy' | 'timeout' | 'failure' = 'healthy';
  let embeddingCalls = 0;
  const token = `gbrain_${randomBytes(32).toString('hex')}`;

  async function cli(args: string[]) {
    const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', ...args], {
      cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exitCode, cliDiagnostic(args[0]!, { stdout, stderr, exitCode }, [token])).toBe(0);
    return stdout;
  }

  async function withStdio(binding: string | undefined, run: (client: Client, stderr: () => string) => Promise<void>) {
    const childEnv = { ...env };
    if (binding === undefined) delete childEnv.GBRAIN_SOURCE;
    else childEnv.GBRAIN_SOURCE = binding;
    const transport = new StdioClientTransport({
      command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--surface', 'starter'],
      cwd: process.cwd(), env: childEnv, stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', data => { stderr += String(data); });
    const client = new Client({ name: 'search-matrix', version: '1' });
    try {
      await client.connect(transport);
      await run(client, () => stderr);
    } catch (error) {
      console.error(fixtureDiagnostic('stdio fixture', stderr, [token]));
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
  }

  async function withHttp(run: (client: Client) => Promise<void>) {
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--surface', 'starter',
      '--bind', '127.0.0.1', '--port', String(port), '--public-url', base, '--suppress-bootstrap-token'],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    const client = new Client({ name: 'search-matrix-http', version: '1' });
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
        if (ready || child.exitCode !== null) break;
        await Bun.sleep(250);
      }
      expect(ready, fixtureDiagnostic('HTTP startup', stderr, [token])).toBe(true);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      await run(client);
    } catch (error) {
      console.error(fixtureDiagnostic('HTTP fixture', stderr, [token]));
      throw error;
    } finally {
      await client.close();
      await stop(child);
    }
  }

  async function mutate(run: () => Promise<void>) {
    await engine.connect(config);
    try { await run(); } finally { await engine.disconnect(); }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-search-matrix-'));
    provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (request.method === 'GET') return Response.json({ data: [{ id: 'text-embedding-3-small' }] });
      embeddingCalls++;
      const body = await request.json() as { input: string | string[] };
      const state = providerState;
      if (state === 'timeout') await Bun.sleep(9_000);
      if (state === 'failure') return Response.json({ error: { message: 'synthetic refusal' } }, { status: 400 });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'text-embedding-3-small', data: input.map((text, index) => {
        const embedding = Array(1536).fill(0);
        embedding[text.includes(VISIBLE) ? 0 : text.includes(PRIVATE) ? 1 : text.includes(FOREIGN) ? 2 : 3] = 1;
        return { object: 'embedding', index, embedding };
      }), usage: { prompt_tokens: 1, total_tokens: 1 } });
    } });
    env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined,
      GBRAIN_SOURCE: BOUND, GBRAIN_SCHEMA_PACK: 'gbrain-base-v2', GBRAIN_SWEEP: '0',
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_RETRY_CONNECT: '1',
      OPENAI_API_KEY: 'synthetic-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    });
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env });
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      cleanupPostgres = isolated.close;
      config = { engine: 'postgres', database_url: isolated.databaseUrl };
    } else {
      config = { engine: 'pglite', database_path: join(home, 'db') };
      engine = new PGLiteEngine();
      await engine.connect(config);
      await engine.initSchema();
    }
    config = { ...config, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 };
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await createManagedFixtureSource(engine, BOUND, { federated: false });
    await createManagedFixtureSource(engine, FEDERATED, { federated: true });
    await createManagedFixtureSource(engine, PRIVATE_SOURCE, { federated: false });
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const [slug, word, source, visibility] of [
        ['notes/visible', VISIBLE, BOUND, 'world'], ['notes/private', PRIVATE, BOUND, 'private'],
        ['notes/foreign', FOREIGN, FEDERATED, 'world'], ['notes/private', PRIVATE, PRIVATE_SOURCE, 'private'],
      ]) {
        await importFromContent(engine, slug!, `---\ntitle: ${word}\ntype: note\nvisibility: ${visibility}\n---\n\n${word} synthetic transport fixture.`, {
          sourceId: source!, noEmbed: false,
          prepare: async prepared => {
            await withManagedFixtureWrite(engine, [source!], tx => prepared.apply(tx));
            return prepared.result;
          },
        });
      }
    });
    await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash, permissions, scopes) VALUES ($1, $2, $3::text::jsonb, $4::text[])`,
      ['matrix-read', createHash('sha256').update(token).digest('hex'), JSON.stringify({ source_id: BOUND, takes_holders: ['world'] }), ['read']]);
    const rows = await engine.executeRaw<{ ready: boolean; chunker_version: number }>(
      'SELECT knowledge_revision = text_projection_revision AS ready, chunker_version FROM pages');
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.ready && row.chunker_version >= 4)).toBe(true);
    await engine.disconnect();
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
    await cleanupPostgres?.();
    provider?.stop(true);
    resetGateway();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('CLI and both authorized transports retrieve the same visible indexed hit without exposing private pages', async () => {
    const rows = JSON.parse(await cli(['search', VISIBLE, '--json']));
    expect(rows.some((row: { slug: string }) => row.slug === 'notes/visible')).toBe(true);
    expect(await cli(['search', PRIVATE, '--json'])).toContain(PRIVATE);
    const verify = async (client: Client) => {
      const before = embeddingCalls;
      const hit = await search(client, VISIBLE);
      expect(hit.rows.map(row => row.slug)).toContain('notes/visible');
      expect(hit.rows.every(row => row.source_id === BOUND)).toBe(true);
      expect(hit.rows.find(row => row.slug === 'notes/visible')?.cosine).toBe(1);
      expect(hit.meta.vector_enabled).toBe(true);
      expect(hit.meta.projection_readiness.status).toBe('ready');
      expect(embeddingCalls).toBeGreaterThan(before);
      await search(client, PRIVATE);
      expect((await search(client, VISIBLE, BOUND)).rows.map(row => row.slug)).toContain('notes/visible');
      expect((await search(client, VISIBLE, '__all__')).rows.every(row => row.source_id === BOUND)).toBe(true);
      const denied = await client.callTool({ name: 'search', arguments: { query: FOREIGN, source_id: FEDERATED } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('permission_denied');
      expect(JSON.stringify(denied)).not.toContain(FOREIGN);
    };
    await withStdio(BOUND, verify);
    await withHttp(verify);
  }, 90_000);

  test('unbound stdio reads federated sources, while a private-only bound source remains a clean miss', async () => {
    await withStdio(undefined, async client => {
      const hit = await search(client, FOREIGN);
      expect(hit.rows.map(row => row.source_id)).toContain(FEDERATED);
      expect(hit.rows.map(row => row.source_id)).not.toContain(BOUND);
    });
    await withStdio(PRIVATE_SOURCE, async client => {
      const miss = await search(client, PRIVATE);
      expect(miss.rows).toEqual([]);
      expect(miss.meta.degraded).toEqual([]);
      expect(miss.content[1]!.text).toContain('clean miss');
    });
  }, 60_000);

  test('an inherited __all__ binding warns once without widening its fail-closed scope', async () => {
    await withStdio('__all__', async (client, stderr) => {
      expect((await search(client, VISIBLE)).rows).toEqual([]);
      expect((await search(client, FOREIGN, '__all__')).rows).toEqual([]);
      const denied = await client.callTool({ name: 'search', arguments: { query: VISIBLE, source_id: BOUND } });
      expect(denied.isError).toBe(true);
      expect(stderr().match(/GBRAIN_SOURCE=__all__ does not grant all-source access to stdio MCP/g)).toHaveLength(1);
      expect(stderr()).toContain('set GBRAIN_SOURCE to a registered source id');
      expect(stderr()).not.toContain(PRIVATE);
    });
  }, 30_000);

  test('provider timeout and refusal are distinguished and vectors recover in the same stdio and HTTP process', async () => {
    const verify = async (client: Client) => {
      try {
        providerState = 'timeout';
        const degraded = await search(client, `${VISIBLE} timeout`);
        expect(degraded.meta.vector_enabled).toBe(false);
        expect(degraded.meta.degraded).toContainEqual({ stage: 'embed_timeout', reason: 'timeout' });
        providerState = 'healthy';
        const recovered = await search(client, `${VISIBLE} recovered`);
        expect(recovered.meta.vector_enabled).toBe(true);
        expect(recovered.meta.degraded?.some(item => item.stage === 'embed_timeout')).toBe(false);
        expect(recovered.rows.map(row => row.slug)).toContain('notes/visible');
        providerState = 'failure';
        const unavailable = await search(client, `${VISIBLE} unavailable`);
        expect(unavailable.meta.vector_enabled).toBe(false);
        expect(unavailable.meta.degraded).toContainEqual({ stage: 'embed_unavailable', reason: 'provider_error' });
        providerState = 'healthy';
        const retry = await search(client, `${VISIBLE} retry`);
        expect(retry.meta.vector_enabled).toBe(true);
        expect(retry.rows.map(row => row.slug)).toContain('notes/visible');
      } finally { providerState = 'healthy'; }
    };
    await withStdio(BOUND, verify);
    await withHttp(verify);
  }, 60_000);

  if (backend === 'postgres') test('stdio reconnects in place after a DB outage; HTTP fails startup loudly and recovers after restart', async () => {
    const port = await unusedPort();
    const actual = new URL(config.database_url!);
    const unavailable = new URL(actual);
    unavailable.hostname = '127.0.0.1';
    unavailable.port = String(port);
    const sockets = new Set<Socket>();
    const proxy = createServer(socket => {
      const upstream = createConnection({ host: actual.hostname, port: Number(actual.port || 5432) });
      for (const connection of [socket, upstream]) {
        sockets.add(connection);
        connection.on('close', () => sockets.delete(connection));
        connection.on('error', () => { socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream).pipe(socket);
    });
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ ...config, database_url: unavailable.toString() }));
    try {
      await withStdio(BOUND, async (client, stderr) => {
        const failed = await client.callTool({ name: 'search', arguments: { query: VISIBLE } });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed)).toContain('database_error');
        expect(JSON.stringify(failed)).toContain('GBRAIN_DB_ACCESS conn_refused');
        expect(stderr()).toContain('DEGRADED: database unreachable at startup');
        await new Promise<void>(resolve => proxy.listen(port, '127.0.0.1', resolve));
        let recovered = false;
        for (let i = 0; i < 12; i++) {
          await Bun.sleep(1_000);
          const response = await client.callTool({ name: 'search', arguments: { query: VISIBLE } });
          if (response.isError) continue;
          recovered = true;
          break;
        }
        expect(recovered).toBe(true);
        const result = await search(client, VISIBLE);
        expect(result.meta.vector_enabled).toBe(true);
        expect(result.meta.degraded?.some(item => item.stage === 'embed_timeout')).toBe(false);
        expect(result.rows.map(row => row.slug)).toContain('notes/visible');
        expect(result.rows.every(row => row.source_id === BOUND)).toBe(true);
        expect(stderr()).toContain('RECOVERED: database reachable');
      });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      const httpPort = await unusedPort();
      const failedHttp = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--bind', '127.0.0.1',
        '--port', String(httpPort), '--public-url', `http://127.0.0.1:${httpPort}`, '--suppress-bootstrap-token'],
      { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
      const deadline = setTimeout(() => failedHttp.kill(), 15_000);
      try {
        const [exitCode, stderr] = await Promise.all([failedHttp.exited, new Response(failedHttp.stderr).text()]);
        expect(exitCode, fixtureDiagnostic('HTTP unavailable startup', stderr, [token])).toBe(1);
        expect(stderr).toContain('GBRAIN_DB_ACCESS conn_refused');
      } finally {
        clearTimeout(deadline);
        failedHttp.kill();
      }
      await new Promise<void>(resolve => proxy.listen(port, '127.0.0.1', resolve));
      await withHttp(async client => {
        const result = await search(client, VISIBLE);
        expect(result.meta.vector_enabled).toBe(true);
        expect(result.rows.map(row => row.slug)).toContain('notes/visible');
        expect(result.rows.every(row => row.source_id === BOUND)).toBe(true);
      });
    } finally {
      writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 60_000);

  test('keyword-only genuine and private misses remain clean on both transports', async () => {
    await mutate(async () => { await engine.setConfig('search.mcp_keyword_only', 'true'); });
    try {
      const verify = async (client: Client) => {
        for (const query of ['absentunfindable', PRIVATE]) {
          const miss = await search(client, query);
          expect(miss.rows).toEqual([]);
          expect(miss.meta.degraded ?? []).toEqual([]);
          expect(miss.content[1]!.text).toContain('clean miss');
        }
      };
      await withStdio(BOUND, verify);
      await withHttp(verify);
    } finally {
      await mutate(async () => { await engine.setConfig('search.mcp_keyword_only', 'false'); });
    }
  }, 60_000);

  test('existing readiness metadata distinguishes visible pending projections and safe-index work without private leakage', async () => {
    await mutate(async () => {
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await withManagedFixtureWrite(engine, [BOUND, PRIVATE_SOURCE], async tx => {
        await tx.executeRaw('UPDATE pages SET text_projection_revision = NULL WHERE source_id = ANY($1::text[])', [[BOUND, PRIVATE_SOURCE]]);
      });
    });
    const verify = async (client: Client) => {
      const pending = await search(client, VISIBLE);
      expect(pending.rows).toEqual([]);
      expect(pending.meta.degraded).toContainEqual({ stage: 'projection_pending' });
      expect(pending.meta.projection_readiness.status).toBe('projection_pending');
    };
    await withStdio(BOUND, verify);
    await withHttp(verify);
    await withStdio(PRIVATE_SOURCE, async client => {
      const miss = await search(client, PRIVATE);
      expect(miss.rows).toEqual([]);
      expect(miss.meta.degraded ?? []).toEqual([]);
      expect(miss.meta.projection_readiness.status).toBe('ready');
    });
    await mutate(async () => {
      await withManagedFixtureWrite(engine, [FEDERATED], async tx => {
        await tx.executeRaw('UPDATE pages SET chunker_version = 3 WHERE source_id = $1', [FEDERATED]);
      });
    });
    await withStdio(FEDERATED, async client => {
      const withheld = await search(client, FOREIGN);
      expect(withheld.rows).toEqual([]);
      expect(withheld.meta.degraded).toContainEqual({ stage: 'safe_index_pending' });
    });
  }, 60_000);
});
