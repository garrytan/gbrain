/**
 * #8664: a hosted caller can share one credential across several AIs, so the brain recorded which principal wrote a
 * page but not which AI. An HTTP MCP request may now carry the X-Gbrain-Agent-Label header; the write records it on
 * its request's authority and attribution reads show it as agent_label. No column, no migration, no new auth path.
 *
 * Protects: both HTTP transports (the OAuth serve --http mount and the legacy bearer transport) read the header and
 * admission records it, on a managed-worktree brain and on a repo-less brain; an unlabelled write is unchanged; a
 * label is unverified text that never changes what the request may do (the stored authority is otherwise identical,
 * and a read-only token is still refused); a label that is not 1-120 printable ASCII characters is dropped, never
 * stored or refused; an allowlisted browser origin's CORS preflight on either transport allows the header.
 * Fails when: the header is dropped before admission, invented at read time, read by authorization, or a value that is
 * unsafe to render (controls, bidi or zero-width characters, non-ASCII bytes) reaches the record.
 * Seams: the mounted SDK transport and the legacy Bun transport over real sockets with real bearer tokens, and the
 * attribution op a read already has. PGLite only: this is a header-to-row path, not a database behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { mountMcp } from '../src/commands/serve-http-mcp.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { AGENT_LABEL_HEADER, parseAgentLabel } from '../src/core/persistence/attribution.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { withEnv } from './helpers/with-env.ts';

const CONFIG = { engine: 'pglite', embedding_disabled: true } as const;
const content = (title: string) => '---\ntype: note\ntitle: ' + title + '\n---\n\n# ' + title + '\n\nA synthetic page.\n';

async function addToken(engine: BrainEngine, name: string, token: string, scopes: string): Promise<void> {
  await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes) VALUES($1,$2,$3::text[])', [name, hashToken(token), scopes]);
}
/** One real tools/call put_page; returns the raw response text. */
async function putPage(engine: BrainEngine, url: string, token: string, slug: string, title: string, label?: string): Promise<string> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  const response = await fetch(url, { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(label === undefined ? {} : { [AGENT_LABEL_HEADER]: label }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'put_page',
      arguments: { slug, content: content(title), ...(snapshot ? { expected_revision: snapshot.revision } : {}) } } }) });
  expect(response.status).toBe(200);
  return await response.text();
}
async function put(engine: BrainEngine, url: string, token: string, slug: string, title: string, label?: string): Promise<void> {
  expect((await putPage(engine, url, token, slug, title, label)).includes('"isError":true')).toBe(false);
}
const attributed = async (engine: BrainEngine, slug: string) => await operationsByName.get_write_attribution.handler({
  engine, sourceId: 'default', remote: false, config: CONFIG, logger: { info() {}, warn() {}, error() {} },
} as unknown as OperationContext, { slug }) as Record<string, any>;

test('a label is 1-120 printable ASCII characters after trimming; anything else is dropped', () => {
  expect(parseAgentLabel('  Claude Code  ')).toBe('Claude Code');
  expect(parseAgentLabel('codex/gpt-6.1-sol')).toBe('codex/gpt-6.1-sol');
  expect(parseAgentLabel('x'.repeat(120))).toBe('x'.repeat(120));
  for (const bad of [undefined, null, '', '  ', 'x'.repeat(121), 'bad' + String.fromCharCode(7) + 'label', 'line\nbreak', 'tab\there',
    'caf' + String.fromCharCode(0xe9), 'Codex' + String.fromCharCode(0x202e) + 'edoC', 'zero' + String.fromCharCode(0x200b) + 'width',
    'sep' + String.fromCharCode(0x2028) + 'arator', 'c1' + String.fromCharCode(0x85) + 'control']) {
    expect(parseAgentLabel(bad)).toBeUndefined();
  }
});

describe('OAuth serve --http mount, managed worktree brain', () => {
  const SLUG = 'notes/labelled-write';
  const TOKEN = 'synthetic-agent-label-' + process.pid;
  const READER = 'synthetic-agent-label-reader-' + process.pid;
  let engine: BrainEngine;
  let root: string;
  let http: Server;
  let url: string;

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    root = mkdtempSync(join(tmpdir(), 'gbrain-agent-label-'));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=\'default\'', [root]);
    await claimWorktree(engine, 'default', root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await registerLocalWriter(engine, 'cli');
    await addToken(engine, 'Synthetic writer token', TOKEN, '{read,write}');
    await addToken(engine, 'Synthetic reader token', READER, '{read}');
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const app = express();
    mountMcp(app, { engine, config: CONFIG, resourceVerifier: provider,
      resourceMetadataUrl: 'http://127.0.0.1/resource', mcpResourceUrl: new URL('http://127.0.0.1/mcp'),
      mcpOperationsBase: Object.values(operationsByName).filter(op => !op.localOnly && !op.cliOnly), broadcastEvent() {} } as unknown as ServeHttpContext);
    http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    url = 'http://127.0.0.1:' + (http.address() as AddressInfo).port + '/mcp';
  }, 120_000);

  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (http) await new Promise<void>(resolve => http.close(() => resolve()));
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  test('a labelled write records the label the caller declared, and attribution reads show it', async () => {
    await put(engine, url, TOKEN, SLUG, 'First by Claude', 'Claude Code');
    expect((await attributed(engine, SLUG)).live_revision.written_by.agent_label).toBe('Claude Code');

    await put(engine, url, TOKEN, SLUG, 'Then by Codex', '  Codex  ');
    const second = await attributed(engine, SLUG);
    expect(second.created.agent_label).toBe('Claude Code');
    expect(second.last.agent_label).toBe('Codex');
    expect(second.live_revision.written_by.agent_label).toBe('Codex');

    await put(engine, url, TOKEN, SLUG, 'Unlabelled edit');
    const third = await attributed(engine, SLUG);
    expect(third.live_revision.written_by.agent_label).toBeUndefined();
    expect('agent_label' in third.live_revision.written_by).toBe(false);

    await put(engine, url, TOKEN, SLUG, 'Too long', 'x'.repeat(121));
    expect((await attributed(engine, SLUG)).live_revision.written_by.agent_label).toBeUndefined();
  }, 240_000);

  test('a label is never authority: the stored authority is otherwise identical and a read-only token is still refused', async () => {
    const slug = 'notes/authority-check';
    await put(engine, url, TOKEN, slug, 'Authority by Claude', 'Claude Code');
    await put(engine, url, TOKEN, slug, 'Authority by Codex', 'Codex');
    await put(engine, url, TOKEN, slug, 'Authority unlabelled');
    const rows = await engine.executeRaw<{ label: string | null; rest: Record<string, unknown> }>(
      "SELECT authority->>'agentLabel' AS label, authority - 'agentLabel' AS rest FROM persistence_requests WHERE slug=$1 ORDER BY created_at", [slug]);
    expect(rows.map(r => r.label)).toEqual(['Claude Code', 'Codex', null]);
    const rest = rows.map(r => typeof r.rest === 'string' ? JSON.parse(r.rest) : r.rest);
    for (const other of rest.slice(1)) expect(other).toEqual(rest[0]);

    const refused = await putPage(engine, url, READER, 'notes/reader-attempt', 'Reader attempt', 'admin');
    expect(refused).toContain('"isError":true');
    expect(await engine.readPageSnapshot('notes/reader-attempt', { sourceId: 'default' })).toBeNull();
  }, 240_000);
});

describe('legacy bearer transport, repo-less brain', () => {
  const SLUG = 'notes/repoless-labelled';
  const TOKEN = 'synthetic-agent-label-legacy-' + process.pid;
  let engine: BrainEngine;
  let server: { port: number; stop: (force?: boolean) => unknown };
  let url: string;

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    const [source] = await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'");
    expect(source?.local_path ?? null).toBeNull();
    await addToken(engine, 'Synthetic legacy token', TOKEN, '{read,write}');
    server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
    } }) as unknown as { port: number; stop: (force?: boolean) => unknown };
    url = 'http://127.0.0.1:' + server.port + '/mcp';
  }, 120_000);

  afterAll(async () => {
    await server?.stop(true);
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  test('the legacy transport records the label on a repo-less brain and drops a non-ASCII one', async () => {
    await put(engine, url, TOKEN, SLUG, 'Repo-less by Claude', 'Claude Code');
    expect((await attributed(engine, SLUG)).live_revision.written_by.agent_label).toBe('Claude Code');

    await put(engine, url, TOKEN, SLUG, 'Repo-less latin1 label', 'caf' + String.fromCharCode(0xe9));
    const after = await attributed(engine, SLUG);
    expect(after.live_revision.written_by.agent_label).toBeUndefined();
    expect(after.created.agent_label).toBe('Claude Code');
  }, 240_000);
});

describe('a browser caller on an allowlisted origin may send the header', () => {
  const ORIGIN = 'https://allowed.example';
  let engine: BrainEngine;
  let http: Server;
  let legacy: { port: number; stop: (force?: boolean) => unknown };

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: ORIGIN }, async () => {
      const app = express();
      http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const port = (http.address() as AddressInfo).port;
      await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: 'http://127.0.0.1:' + port });
      legacy = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } }) as unknown as { port: number; stop: (force?: boolean) => unknown };
    });
  }, 120_000);

  afterAll(async () => {
    await legacy?.stop(true);
    if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
    await engine.disconnect();
  });

  const preflight = async (port: number) => await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-gbrain-agent-label' } });
  const allowsLabel = (response: Response) => (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/).includes(AGENT_LABEL_HEADER.toLowerCase());

  test('the OAuth serve --http mount allows the header in its preflight', async () => {
    const response = await preflight((http.address() as AddressInfo).port);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowsLabel(response)).toBe(true);
  });

  test('the legacy bearer transport allows the header in its preflight', async () => {
    const response = await preflight(legacy.port);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowsLabel(response)).toBe(true);
  });
});

