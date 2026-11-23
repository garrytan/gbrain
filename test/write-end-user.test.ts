/**
 * A multi-user MCP gateway in front of a shared brain calls it with one service credential, so every page write was
 * attributed to the gateway and the person behind it was lost (or pushed into free-text `reason`). A credential granted
 * the `declare_end_user` scope may now name the person on each request (X-Gbrain-End-User); the write records it on its
 * request's authority and attribution reads show it as end_user.
 *
 * Protects: the declared person reaches get_write_attribution and get_versions (written_by / archived_by) and whoami;
 * a credential without the scope that sends the header is refused before any work (insufficient_scope) and nothing is
 * written; a malformed value is refused (invalid_params); the person is attribution only: the stored authority is
 * otherwise identical, reads under the header see what the credential sees, and admin does not imply the scope.
 * Fails when: the header is dropped before admission, honoured without the scope, or the value reaches a record
 * unchecked.
 * Seams: the legacy bearer transport over a real socket with real tokens, on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { END_USER_HEADER, resolveEndUser } from '../src/core/persistence/attribution.ts';
import { hasScope } from '../src/core/scope.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const CONFIG = { engine: 'pglite', embedding_disabled: true } as const;
const content = (title: string) => '---\ntype: note\ntitle: ' + title + '\n---\n\n# ' + title + '\n\nA synthetic page.\n';
const GATEWAY = 'synthetic-end-user-gateway-' + process.pid;
const PLAIN = 'synthetic-end-user-plain-' + process.pid;
const ADMIN = 'synthetic-end-user-admin-' + process.pid;

async function addToken(engine: BrainEngine, name: string, token: string, scopes: string): Promise<void> {
  await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes) VALUES($1,$2,$3::text[])', [name, hashToken(token), scopes]);
}

describe('X-Gbrain-End-User on the legacy bearer transport', () => {
  let engine: BrainEngine;
  let server: { port: number; stop: (force?: boolean) => unknown };
  let url: string;

  async function call(token: string, name: string, args: Record<string, unknown>, endUser?: string): Promise<{ isError: boolean; json: Record<string, any> }> {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(endUser === undefined ? {} : { [END_USER_HEADER]: endUser }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5) : raw);
    const result = body.result ?? body;
    return { isError: result.isError === true, json: JSON.parse(result.content?.[0]?.text ?? '{}') };
  }
  async function put(token: string, slug: string, title: string, endUser?: string) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    return await call(token, 'put_page', { slug, content: content(title), ...(snapshot ? { expected_revision: snapshot.revision } : {}) }, endUser);
  }
  const attributed = async (slug: string) => await operationsByName.get_write_attribution.handler({
    engine, sourceId: 'default', remote: false, config: CONFIG, logger: { info() {}, warn() {}, error() {} },
  } as unknown as OperationContext, { slug, versions: true }) as Record<string, any>;

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await addToken(engine, 'Synthetic gateway token', GATEWAY, '{read,write,declare_end_user}');
    await addToken(engine, 'Synthetic plain token', PLAIN, '{read,write}');
    await addToken(engine, 'Synthetic admin token', ADMIN, '{admin}');
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

  test('a declare_end_user credential names the person; attribution, versions and whoami show it', async () => {
    const slug = 'notes/end-user-write';
    expect((await put(GATEWAY, slug, 'First by alice', 'alice@example.com')).isError).toBe(false);
    expect((await attributed(slug)).live_revision.written_by.end_user).toBe('alice@example.com');

    expect((await put(GATEWAY, slug, 'Then by bob', '  oidc:bob-subject  ')).isError).toBe(false);
    const second = await attributed(slug);
    expect(second.created.end_user).toBe('alice@example.com');
    expect(second.last.end_user).toBe('oidc:bob-subject');
    expect(second.live_revision.written_by.principal.name).toBe('Synthetic gateway token');

    // The service itself reads who wrote each snapshot (it holds the scope), without admin.
    const versions = await call(GATEWAY, 'get_versions', { slug });
    expect(versions.isError).toBe(false);
    const rows = (Array.isArray(versions.json) ? versions.json : versions.json.versions) as Array<Record<string, any>>;
    expect(rows[0]!.written_by.end_user).toBe('alice@example.com');
    expect(rows[0]!.archived_by.end_user).toBe('oidc:bob-subject');

    const who = await call(GATEWAY, 'whoami', {}, 'alice@example.com');
    expect(who.json.end_user).toBe('alice@example.com');
    expect('end_user' in (await call(GATEWAY, 'whoami', {})).json).toBe(false);

    expect((await put(GATEWAY, slug, 'Undeclared')).isError).toBe(false);
    expect('end_user' in (await attributed(slug)).live_revision.written_by).toBe(false);
  }, 240_000);

  test('a credential without the scope is refused before any work, admin included', async () => {
    for (const token of [PLAIN, ADMIN]) {
      const slug = 'notes/refused-' + (token === PLAIN ? 'plain' : 'admin');
      const refused = await put(token, slug, 'Should not land', 'mallory@example.com');
      expect(refused.isError).toBe(true);
      expect(refused.json.code).toBe('insufficient_scope');
      expect(JSON.stringify(refused.json)).toContain('declare_end_user');
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
      // A read is refused too: the header is never silently ignored.
      expect((await call(token, 'list_pages', {}, 'mallory@example.com')).json.code).toBe('insufficient_scope');
      // Without the header the same credential works as before.
      expect((await put(token, slug, 'Lands without the header')).isError).toBe(false);
    }
  }, 240_000);

  test('a malformed value is refused and nothing is written', async () => {
    for (const bad of ['', '   ', 'x'.repeat(257), 'alice example', 'caf' + String.fromCharCode(0xe9)]) {
      const slug = 'notes/malformed-' + bad.length;
      const refused = await put(GATEWAY, slug, 'Malformed', bad);
      expect(refused.isError).toBe(true);
      expect(refused.json.code).toBe('invalid_params');
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    }
  }, 240_000);

  test('the person is attribution only: the stored authority is otherwise identical and reads are unchanged', async () => {
    const slug = 'notes/end-user-authority';
    await put(GATEWAY, slug, 'By alice', 'alice@example.com');
    await put(GATEWAY, slug, 'By bob', 'bob@example.com');
    await put(GATEWAY, slug, 'Nobody');
    const rows = await engine.executeRaw<{ who: string | null; rest: Record<string, unknown> }>(
      "SELECT authority->>'endUser' AS who, authority - 'endUser' AS rest FROM persistence_requests WHERE slug=$1 ORDER BY created_at", [slug]);
    expect(rows.map(r => r.who)).toEqual(['alice@example.com', 'bob@example.com', null]);
    const rest = rows.map(r => typeof r.rest === 'string' ? JSON.parse(r.rest) : r.rest);
    for (const other of rest.slice(1)) expect(other).toEqual(rest[0]);
    const plain = await call(GATEWAY, 'get_page', { slug });
    const declared = await call(GATEWAY, 'get_page', { slug }, 'alice@example.com');
    expect(declared.json.compiled_truth).toBe(plain.json.compiled_truth);
  }, 240_000);
});

test('resolveEndUser: no header is no person; the scope is required and is not implied by admin', () => {
  expect(resolveEndUser(undefined, { clientId: 'x', scopes: ['read'] } as never, 'put_page', 'http')).toBeUndefined();
  expect(resolveEndUser(null, undefined, 'put_page', 'http')).toBeUndefined();
  expect(resolveEndUser(' a@b.c ', { clientId: 'x', scopes: ['declare_end_user'] } as never, 'put_page', 'http')).toBe('a@b.c');
  expect(() => resolveEndUser('a@b.c', { clientId: 'x', scopes: ['admin'] } as never, 'put_page', 'http')).toThrow(OperationError);
  expect(hasScope(['admin'], 'declare_end_user')).toBe(false);
});
