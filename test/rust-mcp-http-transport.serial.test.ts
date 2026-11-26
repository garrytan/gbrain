/**
 * The legacy bearer HTTP MCP transport (src/mcp/http-transport.ts, `startHttpTransport`) on a Rust brain in multi-user
 * mode (docs/designs/rust-engine/multi-user-server.md, I-6 "Session contract for the server"), the same contract as
 * `gbrain serve --http` (test/rust-serve-http.serial.test.ts).
 *
 * Mode: the brain is created and seeded with the switch off (members, the owner member, tokens), then reopened with
 * GBRAIN_RUST_MULTIUSER=1 set in-run, and the test asserts its store reports `multiuser: true`.
 *
 * 1. Protects: the transport's /health answers ok without raw SQL; the brain owner's own key gets in over /mcp, each
 *    tool call in a principal session the store opened from the request's bearer token, released after it; every
 *    other key (another member's, an unbound one) is refused before any tool runs; unknown keys and no key get 401;
 *    the owner's page reads refuse typed (fail closed) until lane L4 models member lineage on a Rust brain.
 * 2. Fails on: a /health that needs raw SQL; an owner call refused for the missing access_control capability; a
 *    non-owner key that reads; a session left open; an owner read that comes back wider than the store models.
 * 3. Existing coverage: rust-serve-http.serial.test.ts covers the OAuth `serve --http` app; nothing covered this
 *    transport on a Rust brain.
 * 4. Seam: none below HTTP: the real transport over a real socket, the real bearer check, the real store session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
let dir = '';
let engine: RustEngine;
let server: { port?: number; stop(force?: boolean): unknown } | undefined;
let releases = 0;
let opens = 0;

async function token(name: string, secret: string, member: string | null, scopes: string[]): Promise<void> {
  const row = { name, token_hash: hashToken(secret), scopes, permissions: {}, member_id: member };
  await (engine as unknown as { insertAccessToken(r: unknown): Promise<unknown> }).insertAccessToken(row);
}

async function rpc(bearer: string | null, method: string, params: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${server!.port}/mcp`, { method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await response.text();
  let body: { result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: unknown[] } } = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}

async function callTool(bearer: string | null, name: string, args: Record<string, unknown>) {
  const { status, body } = await rpc(bearer, 'tools/call', { name, arguments: args });
  const resultText = body.result?.content?.map(c => c.text).join('') ?? '';
  let code: string | undefined;
  try { const j = JSON.parse(resultText) as { code?: string; error?: string }; code = j.code ?? j.error; } catch { /* plain */ }
  return { status, isError: body.result?.isError === true, code, text: resultText };
}

describeAddon('the legacy HTTP MCP transport on a multi-user Rust brain', () => {
  beforeAll(async () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    const addon = await loadRustArmAddon();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-mcp-http-'));
    engine = openRustEngine({ addon, databasePath: join(dir, 'db') });
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    for (const id of ['owner-example', 'alice-example']) {
      await engine.insertAccessMember({ id, displayName: null, email: null, kind: 'person' as never, groups: [], bindTokenId: null });
    }
    await engine.setConfig('access.owner_member', 'owner-example');
    await token('owner-key', 'secret-owner', 'owner-example', ['read', 'write']);
    await token('alice-key', 'secret-alice', 'alice-example', ['read', 'write']);
    await token('unbound-key', 'secret-unbound', null, ['read', 'write']);
    await engine.putPage('notes/hello', { type: 'note', title: 'Hello', compiled_truth: 'Hello from the owner.', timeline: '' } as never);
    await engine.disconnect();
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    // Count every session opened and released, through the store's own handle methods.
    const brain = engine.openStore('mcp-http-test').brain as Record<string, (...a: unknown[]) => unknown>;
    const mint = brain.mintScope!.bind(brain); const release = brain.releaseScope!.bind(brain);
    brain.mintScope = async (...a: unknown[]) => { const out = await mint(...a); opens++; return out; };
    brain.releaseScope = (...a: unknown[]) => { releases++; return release(...a); };
    server = await startHttpTransport({ port: 0, engine: engine as never }) as never;
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    await engine?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the brain runs in multi-user mode', () => {
    expect(engine.openStore('mcp-http-test').multiuser).toBe(true);
  });

  test('/health answers ok without raw SQL', async () => {
    const response = await fetch(`http://127.0.0.1:${server!.port}/health`);
    const body = await response.json() as { status: string; db: string };
    expect({ http: response.status, status: body.status, db: body.db }).toEqual({ http: 200, status: 'ok', db: 'ok' });
  });

  test('the owner\'s own key gets in: its call runs in a session the store opened, released after the call', async () => {
    const before = { opens, releases };
    const r = await callTool('secret-owner', 'whoami', {});
    expect({ status: r.status, isError: r.isError }).toEqual({ status: 200, isError: false });
    expect(r.text).toContain('"token_name":"owner-key"');
    expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 1, released: 1 });
  });

  test('the owner\'s page reads refuse typed for now: the store does not model member lineage on a Rust brain (lane L4)', async () => {
    // Fail closed, never a wider read. Flip this test to the page body once L4 models lineage.
    const r = await callTool('secret-owner', 'get_page', { slug: 'notes/hello' });
    expect({ status: r.status, isError: r.isError, code: r.code }).toEqual({ status: 200, isError: true, code: 'engine_capability_missing' });
    expect(r.text).toContain('lineage');
    expect(r.text).not.toContain('Hello from the owner.');
  });

  test('the owner\'s own key writes over /mcp', async () => {
    const r = await callTool('secret-owner', 'put_page', { slug: 'notes/remote', content: '---\ntitle: Remote\n---\nWritten over HTTP.', request_id: randomUUID() });
    expect({ ok: !r.isError || r.code === 'write_pending', code: r.isError ? r.code : undefined })
      .toEqual({ ok: true, code: r.isError ? 'write_pending' : undefined });
  });

  test('another member\'s key and an unbound key are refused before any tool runs; a session never lingers', async () => {
    const before = { opens, releases };
    for (const bearer of ['secret-alice', 'secret-unbound']) {
      const r = await callTool(bearer, 'get_page', { slug: 'notes/hello' });
      expect({ bearer, isError: r.isError, code: r.code }).toEqual({ bearer, isError: true, code: 'permission_denied' });
      expect(r.text).not.toContain('Hello from the owner.');
    }
    expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 0, released: 0 });
  });

  test('no token and an unknown token get 401', async () => {
    expect((await callTool(null, 'get_page', { slug: 'notes/hello' })).status).toBe(401);
    expect((await callTool('secret-nobody', 'get_page', { slug: 'notes/hello' })).status).toBe(401);
  });
});
