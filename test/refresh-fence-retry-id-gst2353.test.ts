/**
 * GST-2353: a write refused by a refresh fence told the caller to "retry the same request_id" when the call carried none
 * and the refusal returned none, so an agent's safe retry went out under a new id (scored as a reissue by the nightly
 * refused-write evals).
 *
 * Protects: a retryable fence refusal of a write without request_id returns the id it was refused under in fix.mcp
 * (the call to repeat, next: wait), and its message names that id instead of an id
 * the caller never had; nothing is journaled for the refused call; the retry with fix.mcp's arguments commits under that
 * id; a later call with that id and a changed payload is refused idempotency_conflict like any reused id; a caller's own
 * request_id is the one echoed; a database-only (repo-less) source is never fenced.
 * Regression it catches: master answered "Retry the same request_id in about 2 s." with no id anywhere in the refusal.
 * Seams: the real refresh state machine paused at its drained boundary (worktree-refresh-fixture), MCP dispatch as a remote
 * stdio caller, PGLite and Postgres.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
afterEach(() => _setRefreshFenceWaitForTests(null));

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };

async function withEntity(f: RefreshFixture): Promise<void> {
  f.push('alpha/people/alice-example.md', '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n');
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
}

async function duringRefresh(f: RefreshFixture, fn: () => Promise<void>) {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
  const refresh = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } } } });
  await drained;
  try { await fn(); } finally { release(); }
  expect((await refresh).status).toBe('completed');
}

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>, sourceId = f.alpha) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

test('remember without request_id: the fence refusal returns the id to retry with, the retry commits under it, and a changed payload under it is refused', () => each(async f => {
  await withEntity(f);
  _setRefreshFenceWaitForTests(0);
  const args = { fact: 'alice-example likes jazz', entity: 'people/alice-example', provenance: 'test' };
  let retry: { tool: string; arguments: Record<string, unknown> } | undefined;
  await duringRefresh(f, async () => {
    const before = await f.requestCount();
    const out = await call(f, 'remember', args);
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ code: 'worktree_refreshing', retryable: true });
    const id = out.body.fix?.mcp?.arguments?.request_id;
    expect(id).toMatch(UUID);
    expect(out.body.message).toContain(`request_id ${id}`);
    expect(out.body.message).not.toContain('Retry the same request_id');
    expect(out.body.fix.next).toBe('wait');
    expect(out.body.fix.mcp).toEqual({ tool: 'remember', arguments: { ...args, request_id: id } });
    expect(await f.requestCount()).toBe(before);
    retry = out.body.fix.mcp;
  });
  const done = await call(f, retry!.tool, retry!.arguments);
  expect(done.isError ? done.body : 'ok').toBe('ok');
  expect(done.body.request_id).toBe(retry!.arguments.request_id);
  const changed = await call(f, 'remember', { ...retry!.arguments, fact: 'alice-example likes tea' });
  expect(changed.isError).toBe(true);
  expect(changed.body.write_error).toBe('idempotency_conflict');
}), 180_000);

test('put_page without request_id gets the same retry id and fix; a caller\'s own request_id is the one echoed', () => each(async f => {
  _setRefreshFenceWaitForTests(0);
  await duringRefresh(f, async () => {
    const before = await f.requestCount();
    const args = { slug: 'notes/fenced', content: page('Fenced', 'refused during the refresh') };
    const out = await call(f, 'put_page', args);
    expect(out.body).toMatchObject({ code: 'worktree_refreshing', retryable: true });
    const id = out.body.fix?.mcp?.arguments?.request_id;
    expect(id).toMatch(UUID);
    expect(out.body.fix.mcp).toEqual({ tool: 'put_page', arguments: { ...args, request_id: id } });
    const mine = crypto.randomUUID();
    const own = await call(f, 'put_page', { ...args, request_id: mine });
    expect(own.body.fix.mcp.arguments.request_id).toBe(mine);
    expect(own.body.message).toContain(`request_id ${mine}`);
    expect(await f.requestCount()).toBe(before);
  });
}), 180_000);

test('a database-only (repo-less) source is never fenced: remember without request_id commits during the refresh', () => each(async f => {
  _setRefreshFenceWaitForTests(0);
  await duringRefresh(f, async () => {
    const out = await call(f, 'remember', { fact: 'acme-example ships widgets', entity: 'companies/acme-example', provenance: 'test' }, 'default');
    expect(out.isError ? out.body : 'ok').toBe('ok');
    expect(out.body.request_id).toMatch(UUID);
  });
}), 180_000);
