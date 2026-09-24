/**
 * Real legacy-bearer HTTP MCP regression for projection-readiness response
 * metadata. The fixture is disk-backed because the CLI HTTP server owns the
 * PGLite lock; all pages are seeded before it starts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { cliDiagnostic, fixtureDiagnostic, toolDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { createManagedFixtureSource, withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';

const MATCH = 'http-readiness-public-match';
const PRIVATE_PENDING = 'http-readiness-private-pending-canary';
const FOREIGN_PENDING = 'http-readiness-foreign-pending-canary';

function brainEnv(home: string): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined,
    GBRAIN_ENGINE: undefined,
    GBRAIN_SOURCE: undefined,
    GBRAIN_REMOTE_CLIENT_SECRET: undefined,
    GBRAIN_MCP_FORCE_SURFACE: undefined,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
  });
}

function cli(env: Record<string, string>, args: string[]): string {
  const result = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(cliDiagnostic(args[0], {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }));
  }
  return result.stdout;
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('search projection readiness over legacy bearer HTTP MCP', () => {
  let home = '';
  let token = '';
  let base = '';
  let server: ChildProcess | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-search-readiness-http-'));
    const env = brainEnv(home);
    cli(env, ['init', '--pglite', '--no-embedding', '--non-interactive']);
    const auth = cli(env, ['auth', 'create', 'e2e-search-readiness']);
    token = auth.match(/gbrain_[a-f0-9]{64}/)?.[0] ?? '';
    if (!token) throw new Error('auth create did not yield a legacy bearer token');

    const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')) as { database_path: string };
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: config.database_path });
    try {
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await createManagedFixtureSource(engine, 'foreign-readiness-source');

      await importFromContent(engine, 'notes/current', [
        '---', 'title: Current public fixture', 'type: note', '---', MATCH,
      ].join('\n'), { sourceId: 'default', noEmbed: true,
        prepare: async prepared => {
          await withManagedFixtureWrite(engine, ['default'], tx => prepared.apply(tx));
          return prepared.result;
        },
      });
      await withManagedFixtureWrite(engine, ['default', 'foreign-readiness-source'], async tx => {
        await tx.putPage('notes/pending-visible', {
          type: 'code', page_kind: 'code', title: 'Pending visible fixture', compiled_truth: 'unprojected visible fixture',
        }, { sourceId: 'default' });
        await tx.putPage('notes/pending-private', {
          type: 'code', page_kind: 'code', title: PRIVATE_PENDING, compiled_truth: PRIVATE_PENDING,
          frontmatter: { visibility: 'private' },
        }, { sourceId: 'default' });
        await tx.putPage('notes/pending-foreign', {
          type: 'code', page_kind: 'code', title: FOREIGN_PENDING, compiled_truth: FOREIGN_PENDING,
        }, { sourceId: 'foreign-readiness-source' });
        await tx.executeRaw(
          'UPDATE pages SET text_projection_revision = NULL WHERE slug = ANY($1::text[])',
          [['notes/pending-visible', 'notes/pending-private', 'notes/pending-foreign']],
        );
        const pending = await tx.executeRaw<{ slug: string; pending: boolean }>(
          `SELECT slug, text_projection_revision IS DISTINCT FROM knowledge_revision AS pending
           FROM pages WHERE slug LIKE 'notes/pending-%' ORDER BY slug`,
        );
        expect(pending).toEqual([
          { slug: 'notes/pending-foreign', pending: true },
          { slug: 'notes/pending-private', pending: true },
          { slug: 'notes/pending-visible', pending: true },
        ]);
      });
    } finally {
      await engine.disconnect();
    }

    const port = await unusedPort();
    base = `http://127.0.0.1:${port}`;
    let stderr = '';
    server = spawn('bun', [
      '--no-env-file', 'run', 'src/cli.ts', 'serve', '--http', '--surface', 'full',
      '--bind', '127.0.0.1', '--port', String(port), '--public-url', base,
      '--suppress-bootstrap-token',
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });

    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
      } catch {}
      if (ready) break;
      if (server.exitCode !== null) break;
      await Bun.sleep(250);
    }
    if (!ready) throw new Error(fixtureDiagnostic('HTTP server readiness', stderr, [token]));

    client = new Client({ name: 'search-readiness-http-e2e', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }), { signal: AbortSignal.timeout(30_000) });
  }, 120_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {}
    if (server && server.exitCode === null && server.signalCode === null) {
      const child = server;
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => { clearTimeout(deadline); resolve(); });
        child.kill('SIGTERM');
      });
    }
    if (home) rmSync(home, { recursive: true, force: true });
  }, 30_000);

  async function search(query: string) {
    const result = await client!.callTool({ name: 'search', arguments: { query, source_id: 'default' } }, undefined, { timeout: 30_000 });
    expect(result.isError, toolDiagnostic('search', result, [token])).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const retrieval = (result as typeof result & { _meta?: { retrieval?: Record<string, unknown> } })._meta?.retrieval;
    expect(retrieval).toBeDefined();
    return { result, content, body: JSON.parse(content[0]!.text), retrieval: retrieval! };
  }

  function expectPendingMetadata(retrieval: Record<string, unknown>) {
    expect(retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    expect(retrieval.projection_readiness).toMatchObject({ status: 'projection_pending', ready: false });
    const publicMetadata = JSON.stringify(retrieval);
    expect(publicMetadata).not.toContain(PRIVATE_PENDING);
    expect(publicMetadata).not.toContain(FOREIGN_PENDING);
  }

  test('empty search keeps its bare-array body and exposes visible pending projection work only through retrieval metadata', async () => {
    const response = await search('http-readiness-no-match');
    expect(response.content).toHaveLength(2);
    expect(response.body).toEqual([]);
    expectPendingMetadata(response.retrieval);
    expect(JSON.stringify(response.result)).not.toContain(PRIVATE_PENDING);
    expect(JSON.stringify(response.result)).not.toContain(FOREIGN_PENDING);
  }, 30_000);

  test('partial nonempty search exposes the same readiness metadata without changing the public result body', async () => {
    const response = await search(MATCH);
    expect(response.content).toHaveLength(1);
    expect(response.body).toHaveLength(1);
    expect(JSON.stringify(response.body)).toContain(MATCH);
    expectPendingMetadata(response.retrieval);
    expect(JSON.stringify(response.result)).not.toContain(PRIVATE_PENDING);
    expect(JSON.stringify(response.result)).not.toContain(FOREIGN_PENDING);
  }, 30_000);
});
