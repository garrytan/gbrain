/** Real MCP transport journeys over isolated, persistent PGLite brains.
 * Data seeding uses the engine before serve starts (PGLite is single-writer).
 * No provider keys, model calls, ambient brain, or external database is used.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { unpackToolResult } from '../../src/core/mcp-client.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { cliDiagnostic, fixtureDiagnostic, toolDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

const PUBLIC = 'privacyjourneypublic';
const PRIVATE = 'PRIVATE_PAGE_JOURNEY_CANARY';
const PRIVATE_FACT = 'PRIVATE_FACT_JOURNEY_CANARY';
const PRIVATE_TAKE = 'PRIVATE_TAKE_JOURNEY_CANARY';
const PRIVATE_REPORT = 'PRIVATE_QUERY_REPORT_JOURNEY_CANARY';
const SHARED = 'notes/shared-privacy';
const REPORT_NOTE = 'Stored contradiction reports are temporarily available only to trusted local callers without a source filter.';

function cli(env: Record<string, string>, args: string[]): string {
  const result = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(cliDiagnostic(args[0], {
    exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  }));
  return result.stdout;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const historyBody = `Ordinary public history prose.\n${renderFactsTable([
  { rowNum: 1, claim: PUBLIC, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: PRIVATE_FACT, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
])}\n${TAKES_FENCE_BEGIN}\n${PRIVATE_TAKE}\n${TAKES_FENCE_END}\n${renderFactsTable([
  { rowNum: 3, claim: `${PUBLIC} repeated`, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 4, claim: `${PRIVATE_FACT} repeated`, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
])}`;

async function seed(home: string): Promise<void> {
  const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
  const engine = new PGLiteEngine();
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  await engine.connect({ database_path: config.database_path });
  try {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('private-source', 'private-source', '{\"federated\":true}'::jsonb)");
    await engine.setConfig('search.cache.enabled', 'true');
    for (const [slug, source, hidden] of [
      [SHARED, 'default', false],
      [SHARED, 'private-source', true],
      ['notes/private-only', 'default', true],
    ] as const) {
      const body = hidden ? PRIVATE : historyBody;
      const imported = await importFromContent(engine, slug, serializeMarkdown(
        { visibility: hidden ? 'private' : 'world' }, body, '',
        { type: 'note', title: hidden ? PRIVATE : PUBLIC, tags: [] },
      ), { sourceId: source, noEmbed: true, forceRechunk: true });
      expect(imported.status).toBe('imported');
      const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]);
      const id = Number(rows[0].id);
      // The real import path must build safe chunks from repeated protected
      // fences before the MCP transport starts reading this persistent brain.
      const chunks = JSON.stringify(await engine.getChunks(slug, { sourceId: source }));
      expect(chunks).toContain(hidden ? PRIVATE : PUBLIC);
      expect(chunks).not.toContain(PRIVATE_FACT);
      expect(chunks).not.toContain(PRIVATE_TAKE);
      await engine.executeRaw("INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'fixture', $2::text::jsonb)", [id, JSON.stringify({ body: hidden ? PRIVATE : PUBLIC })]);
      await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-08-01', $2)", [id, hidden ? PRIVATE : PUBLIC]);
      await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter) VALUES ($1, $2, '{\"visibility\":\"world\"}'::jsonb)", [id, body]);
      // A public current page must not make its formerly-private snapshot public.
      if (!hidden) await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter) VALUES ($1, $2, '{\"visibility\":\"private\"}'::jsonb)", [id, PRIVATE]);
    }
    const finding = { severity: 'high', axis: PRIVATE_REPORT, a: { slug: SHARED }, b: { slug: SHARED } };
    await engine.writeContradictionsRun({
      run_id: 'privacy-journey-run', judge_model: 'fixture', prompt_version: '1',
      queries_evaluated: 1, queries_with_contradiction: 1, total_contradictions_flagged: 1,
      wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0, cost_usd_total: 0,
      duration_ms: 1, source_tier_breakdown: {}, report_json: { per_query: [{ contradictions: [finding] }] },
    });
    // Positive controls: persisted private evidence and trusted local reports
    // exist, so empty remote responses cannot pass on an empty fixture.
    expect(JSON.stringify(await engine.getChunks(SHARED, { sourceId: 'private-source' }))).toContain(PRIVATE);
    expect(JSON.stringify(await engine.getVersions(SHARED))).toContain(PRIVATE_FACT);
    const local: OperationContext = {
      engine,
      config: { engine: 'pglite' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: '__all__',
    };
    expect(JSON.stringify(await operationsByName.find_contradictions.handler(local, {}))).toContain(PRIVATE_REPORT);
  } finally {
    await engine.disconnect();
    resetGateway();
  }
}

for (const kind of ['stdio', 'http'] as const) {
  describe(`${kind}: remote privacy through a real MCP session`, () => {
    let home: string;
    let env: Record<string, string>;
    let client: Client | undefined;
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    let server: ChildProcess | undefined;
    let credentials: { clientId: string; clientSecret: string } | undefined;

    async function closeSession(): Promise<void> {
      try { await client?.close(); } finally {
        client = undefined;
        try { await transport?.close(); } finally {
          transport = undefined;
          if (server && server.exitCode === null && server.signalCode === null) {
            const child = server;
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
              child.once('exit', () => { clearTimeout(timer); resolve(); });
              child.kill('SIGTERM');
            });
          }
          server = undefined;
        }
      }
    }

    async function openSession(exposePrivatePages = false): Promise<void> {
      const sessionEnv = { ...env, ...(exposePrivatePages ? { GBRAIN_REMOTE_PRIVATE_PAGES: '1' } : {}) };
      client = new Client({ name: `privacy-journey-${kind}`, version: '1.0.0' }, { capabilities: {} });
      if (kind === 'stdio') {
        transport = new StdioClientTransport({
          command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--surface', 'full'],
          cwd: process.cwd(), env: sessionEnv, stderr: 'pipe',
        });
      } else {
        const port = await unusedPort();
        const base = `http://127.0.0.1:${port}`;
        let stderr = '';
        server = spawn('bun', [
          '--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--surface', 'full',
          '--bind', '127.0.0.1', '--port', String(port), '--public-url', base,
        ], { cwd: process.cwd(), env: sessionEnv, stdio: ['ignore', 'ignore', 'pipe'] });
        server.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
          if (ready || server.exitCode !== null) break;
          await Bun.sleep(250);
        }
        if (!ready) throw new Error(fixtureDiagnostic('privacy journey HTTP startup', stderr));
        const response = await fetch(`${base}/token`, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials!.clientId, client_secret: credentials!.clientSecret }),
        });
        expect(response.status).toBe(200);
        const token = await response.json() as { access_token: string };
        expect(typeof token.access_token).toBe('string');
        transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
        });
      }
      await client.connect(transport, { signal: AbortSignal.timeout(30_000) });
    }

    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
      expect(result.isError, toolDiagnostic(name, result)).not.toBe(true);
      // The structured body is block zero; MCP may append advisory text.
      return { result, body: unpackToolResult<any>(result) };
    }

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), `gbrain-privacy-${kind}-`));
      env = keylessBrainEnv(process.env, home, {
        DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined,
        GBRAIN_REMOTE_PRIVATE_PAGES: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined,
        GBRAIN_SOURCE: undefined, GBRAIN_SWEEP: '0',
      });
      cli(env, ['init', '--pglite', '--no-embedding', '--non-interactive']);
      await seed(home);
      if (kind === 'http') {
        const registered = cli(env, ['auth', 'register-client', 'privacy-journey',
          '--grant-types', 'client_credentials', '--scopes', 'read admin',
          '--source', 'private-source', '--federated-read', 'private-source,default',
          '--token-endpoint-auth-method', 'client_secret_post']);
        const clientId = registered.match(/Client ID:\s+(\S+)/)?.[1];
        const clientSecret = registered.match(/Client Secret:\s+(\S+)/)?.[1];
        if (!clientId || !clientSecret) throw new Error('Privacy fixture client registration omitted credentials');
        credentials = { clientId, clientSecret };
        cli(env, ['auth', 'rescope-client', clientId, '--surface', 'full']);
      }
      await openSession();
    }, 120_000);

    afterAll(async () => {
      try { await closeSession(); } finally {
        if (home) rmSync(home, { recursive: true, force: true });
      }
    }, 30_000);

    test('same-slug content readers and history retain public data and exclude private rows', async () => {
      for (const name of ['get_page', 'get_chunks', 'get_raw_data', 'get_timeline', 'get_versions']) {
        const { result, body } = await call(name, { slug: SHARED });
        expect(JSON.stringify(body)).toContain(PUBLIC);
        for (const hidden of [PRIVATE, PRIVATE_FACT, PRIVATE_TAKE]) expect(JSON.stringify(result)).not.toContain(hidden);
        if (name === 'get_versions') {
          expect(body).toHaveLength(1);
          expect(body[0].compiled_truth).toContain(`${PUBLIC} repeated`);
        }
      }
      for (const name of ['get_chunks', 'get_raw_data', 'get_timeline', 'get_versions']) {
        const { body } = await call(name, { slug: 'notes/private-only' });
        expect(body).toEqual([]);
      }
    }, 45_000);

    test('fresh query metadata and stored-report containment survive the transport', async () => {
      for (let i = 0; i < 2; i++) {
        const { result, body } = await call('query', { query: PUBLIC, expand: false, use_cache: true, limit: 5 });
        expect(JSON.stringify(body)).toContain(PUBLIC);
        expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect((result._meta?.retrieval as { cache?: string })?.cache).toBe('disabled');
      }
      expect((await call('cache_stats')).body.enabled).toBe(false);
      const { body } = await call('find_contradictions');
      expect(body).toEqual({ contradictions: [], note: REPORT_NOTE });
      expect(JSON.stringify(body)).not.toContain(PRIVATE_REPORT);
    }, 45_000);

    test('page-visibility opt-out leaves historical Facts/Takes and report boundaries active', async () => {
      await closeSession();
      await openSession(true);
      const { body: privateChunks } = await call('get_chunks', { slug: 'notes/private-only' });
      expect(JSON.stringify(privateChunks)).toContain(PRIVATE);
      const { result, body } = await call('get_versions', { slug: SHARED });
      expect(JSON.stringify(body)).toContain(PUBLIC);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_FACT);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_TAKE);
      expect((await call('find_contradictions')).body).toEqual({ contradictions: [], note: REPORT_NOTE });
    }, 60_000);
  });
}
