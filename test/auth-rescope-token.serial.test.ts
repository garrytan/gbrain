/**
 * #5231 / #5893 (O-DX-4, O-ENG-7): `gbrain auth rescope-token` run as a real
 * CLI subprocess against a sandboxed PGLite brain, then enforced in process.
 *
 * Protects: `none` stores an explicit empty list that both HTTP auth paths
 * (the legacy bearer transport and the OAuth provider behind `serve --http`)
 * enforce as deny-all for reads and writes, never the `default` floor; an
 * omitted flag preserves the stored value; `--refresh-operations` without
 * `--add`/`--all-new` widens nothing; a write accepted before the rescope is
 * refused at publication. Regression it catches: `parseLegacyTokenScope([])`
 * mapping the explicit empty grant back to `default` (the pre-fix contract),
 * or a CLI that whole-replaces `permissions` and drops other grant keys.
 * Serial: each CLI call is a subprocess that takes the PGLite lock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext, OperationError } from '../src/core/ops/contract.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import { submissionAuthority, authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

async function permissions(name: string): Promise<Record<string, unknown>> {
  return withBrain(async engine => {
    const [row] = await engine.executeRaw<{ permissions: Record<string, unknown> }>(
      'SELECT permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
    return row.permissions;
  });
}

async function mint(name: string): Promise<string> {
  const created = await cli('auth', 'create', name, '--scopes', 'read,write');
  expect(created.exitCode).toBe(0);
  return (created.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-rescope-token-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
    await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'rescope-marker prose', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('auth rescope-token CLI', () => {
  test('none stores deny-all, omission preserves, other keys survive', async () => {
    await mint('tok-none');
    const set = await cli('auth', 'rescope-token', 'tok-none', '--sources', 'none', '--takes-holders', 'none', '--operations', 'get_page,search');
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain('Sources: default (no source grant) -> none (deny-all)');
    expect(await permissions('tok-none')).toEqual({ source_id: [], takes_holders: [], allowed_operations: ['get_page', 'search'] });

    const partial = await cli('auth', 'rescope-token', 'tok-none', '--takes-holders', 'world,brain');
    expect(partial.exitCode).toBe(0);
    expect(await permissions('tok-none')).toEqual({ source_id: [], takes_holders: ['world', 'brain'], allowed_operations: ['get_page', 'search'] });

    const inspect = await cli('auth', 'rescope-token', 'tok-none');
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain('Sources: none (deny-all)');
    expect(inspect.stdout).toContain('Operations: get_page, search');

    const alias = await cli('auth', 'permissions', 'tok-none', 'set-takes-holders', 'world');
    expect(alias.exitCode).toBe(0);
    expect(await permissions('tok-none')).toEqual({ source_id: [], takes_holders: ['world'], allowed_operations: ['get_page', 'search'] });
  }, 120_000);

  test('refresh-operations previews without widening; --add widens by exactly the named operation', async () => {
    await mint('tok-refresh');
    expect((await cli('auth', 'rescope-token', 'tok-refresh', '--operations', 'get_page')).exitCode).toBe(0);
    const preview = await cli('auth', 'rescope-token', 'tok-refresh', '--refresh-operations');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Legacy token grants: tok-refresh');
    expect(preview.stdout).toMatch(/New operations available: .*\bsearch\b/);
    expect((await permissions('tok-refresh')).allowed_operations).toEqual(['get_page']);

    const added = await cli('auth', 'rescope-token', 'tok-refresh', '--refresh-operations', '--add', 'search');
    expect(added.exitCode).toBe(0);
    expect((await permissions('tok-refresh')).allowed_operations).toEqual(['get_page', 'search']);

    const refused = await cli('auth', 'rescope-token', 'tok-refresh', '--refresh-operations', '--add', 'get_page');
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('Not a new operation for this token: get_page');
  }, 120_000);

  test('reset-default restores the auth create defaults; unknown sources refuse', async () => {
    await mint('tok-reset');
    expect((await cli('auth', 'rescope-token', 'tok-reset', '--sources', 'other,default', '--takes-holders', 'none')).exitCode).toBe(0);
    expect(await permissions('tok-reset')).toEqual({ source_id: ['other', 'default'], takes_holders: [] });
    expect((await cli('auth', 'rescope-token', 'tok-reset', '--reset-default', 'sources,takes-holders')).exitCode).toBe(0);
    expect(await permissions('tok-reset')).toEqual({ takes_holders: ['world'] });
    const unknown = await cli('auth', 'rescope-token', 'tok-reset', '--sources', 'missing-source');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('Unknown or archived source: missing-source');
  }, 120_000);
});

describe('explicit no-source grant is enforced (O-ENG-7)', () => {
  test('both HTTP auth paths deny reads and writes to default and another source', async () => {
    const token = await mint('tok-deny');
    expect((await cli('auth', 'rescope-token', 'tok-deny', '--sources', 'none')).exitCode).toBe(0);
    await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
      expect(auth.sourceId).toBe(NO_SOURCES);
      expect(auth.allowedSources).toEqual([]);
      for (const [name, args] of [
        ['search', { query: 'rescope-marker' }],
        ['get_page', { slug: 'notes/shared' }],
        ['query', { query: 'rescope-marker', source_id: 'default' }],
        ['put_page', { slug: 'notes/new', content: 'new prose' }],
        ['put_page', { slug: 'notes/new', content: 'new prose', source_id: 'other' }],
      ] as const) {
        const result = await dispatchToolCall(engine, name, { ...args }, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toBe('permission_denied');
      }

      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        for (const [name, args] of [['search', { query: 'rescope-marker' }], ['put_page', { slug: 'notes/legacy', content: 'x', source_id: 'default' }]] as const) {
          const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
          });
          const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
          expect(body.result.isError).toBe(true);
          expect(JSON.parse(body.result.content[0].text).error).toBe('permission_denied');
        }
      } finally { server.stop?.(); }
      expect(await engine.getPage('notes/new', { sourceId: 'default' })).toBeNull();
    });
  }, 120_000);

  test('POST /ingest refuses a no-source token before queueing', async () => {
    const token = await mint('tok-ingest');
    expect((await cli('auth', 'rescope-token', 'tok-ingest', '--sources', 'none')).exitCode).toBe(0);
    await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const app = express();
      const pass: express.RequestHandler = (_req, _res, next) => next();
      mountWebhooks(app, { engine, resourceVerifier: provider, resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
        ingestRateLimiter: pass, githubWebhookLimiter: pass, broadcastEvent: () => {} } as unknown as ServeHttpContext);
      const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown' }, body: '# Capture\n\nno-source prose' });
        expect(response.status).toBe(403);
        const [{ id }] = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM access_tokens WHERE name = 'tok-ingest'");
        const body = await response.json();
        expect(body).toMatchObject({ error: 'permission_denied', detail: 'fence=no_source_grant', docs_url: 'docs/mcp/ADMIN.md#legacy-token-grants',
          fix: { argv: ['gbrain', 'auth', 'rescope-token', '--id', id, '--sources', '<sources>'], actor: 'host_admin', next: 'tell_user_to_run', inputs: [{ name: 'sources' }] } });
        expect(JSON.stringify(body)).not.toContain('<name>');
        const [jobs] = await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'");
        expect(jobs.n).toBe(0);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  }, 120_000);

  test('a write accepted before the rescope is refused at publication', async () => {
    const token = await mint('tok-publish');
    expect((await cli('auth', 'rescope-token', 'tok-publish', '--sources', 'default')).exitCode).toBe(0);
    const row = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
      const ctx = { engine, config: { engine: 'pglite' }, sourceId: 'default', auth, remote: true, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/shared');
      const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source.incarnation, slug: 'notes/shared', requestId: randomUUID(), callerIntent: {}, intent: {} });
      await authorizeStoredRequest(engine, admitted);
      return admitted;
    });
    expect((await cli('auth', 'rescope-token', 'tok-publish', '--sources', 'none')).exitCode).toBe(0);
    await withBrain(async engine => {
      await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'permission_denied' });
    });
  }, 120_000);

  test('a no-source refusal at submission names the token, and its fix restores the grant when run', async () => {
    const token = await mint('tok-submit');
    expect((await cli('auth', 'rescope-token', 'tok-submit', '--sources', 'none')).exitCode).toBe(0);
    const refusal = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
      const ctx = { engine, config: { engine: 'pglite' }, sourceId: 'default', auth, remote: true, transport: 'http', dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      return submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/shared').then(() => null, (e: OperationError) => e);
    });
    const [{ id }] = await withBrain(engine => engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM access_tokens WHERE name = 'tok-submit'"));
    expect(refusal).toMatchObject({ code: 'permission_denied', detail: 'fence=no_source_grant',
      fix: { argv: ['gbrain', 'auth', 'rescope-token', '--id', id, '--sources', '<sources>'], actor: 'host_admin' } });
    expect((await cli(...refusal!.fix!.argv!.slice(1).map(a => a === '<sources>' ? 'default' : a))).exitCode).toBe(0);
    expect((await permissions('tok-submit')).source_id).toEqual(['default']);
  }, 120_000);
});
