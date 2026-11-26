/**
 * `gbrain serve --http` on a Rust brain in multi-user mode (docs/designs/rust-engine/multi-user-server.md, I-6 "Session
 * contract for the server"; the evals' sample 5 and their remote phase c7).
 *
 * Mode: the brain is created and seeded with the switch off (members, the owner member, tokens), then reopened with
 * GBRAIN_RUST_MULTIUSER=1 set in-run, and the test asserts its store reports `multiuser: true`.
 *
 * 1. Protects: `gbrain serve --http` starts (no raw SQL at startup); the brain owner's own key gets in over /mcp, each
 *    call in a principal session the store opened from the request's bearer token, released after it; every other key
 *    (another member's, an unbound one, an unknown one, none) is refused before any tool runs; the owner's page reads
 *    refuse typed (fail closed) until lane L4 models member lineage on a Rust brain.
 * 2. Fails on: a startup that needs raw SQL; an owner call refused for the missing access_control capability; a
 *    non-owner key that reads; a session left open; an owner read that comes back wider than the store models.
 * 3. Existing coverage: rust-principal-session.serial.test.ts covers the store session alone; nothing served it.
 * 4. Seam: none below HTTP: the real app (buildServeHttpApp), the real bearer check, the real store session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
let dir = '';
let engine: RustEngine;
let http: Server;
let port = 0;
let releases = 0;
let opens = 0;

async function token(name: string, secret: string, member: string | null, scopes: string[]): Promise<void> {
  const row = { name, token_hash: hashToken(secret), scopes, permissions: {}, member_id: member };
  await (engine as unknown as { insertAccessToken(r: unknown): Promise<unknown> }).insertAccessToken(row);
}

async function callMcp(bearer: string | null, name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  let body: { result?: { isError?: boolean; content: Array<{ text: string }> } } = {};
  try { body = JSON.parse(text.startsWith('event:') ? text.split('\ndata: ')[1]!.split('\n')[0]! : text); } catch { /* not JSON */ }
  const resultText = body.result?.content?.map(c => c.text).join('') ?? '';
  let code: string | undefined;
  try { const j = JSON.parse(resultText) as { code?: string; error?: string }; code = j.code ?? j.error; } catch { /* plain */ }
  return { status: response.status, isError: body.result?.isError === true, code, text: resultText };
}

describeAddon('gbrain serve --http on a multi-user Rust brain', () => {
  beforeAll(async () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    const addon = await loadRustArmAddon();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-http-'));
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
    const brain = engine.openStore('serve-http-test').brain as Record<string, (...a: unknown[]) => unknown>;
    const mint = brain.mintScope!.bind(brain); const release = brain.releaseScope!.bind(brain);
    brain.mintScope = async (...a: unknown[]) => { const out = await mint(...a); opens++; return out; };
    brain.releaseScope = (...a: unknown[]) => { releases++; return release(...a); };
    const app = express();
    http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    port = (http.address() as { port: number }).port;
    await buildServeHttpApp(app, engine as never, { port, tokenTtl: 3600, enableDcr: false, publicUrl: `http://127.0.0.1:${port}` } as never);
  }, 120_000);

  afterAll(async () => {
    http?.closeAllConnections();
    await new Promise<void>(r => (http ? http.close(() => r()) : r()));
    await engine?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the brain runs in multi-user mode', () => {
    expect(engine.openStore('serve-http-test').multiuser).toBe(true);
  });

  test('the owner\'s own key gets in: its call runs in a session the store opened, released after the call', async () => {
    const before = { opens, releases };
    const r = await callMcp('secret-owner', 'whoami', {});
    expect({ status: r.status, isError: r.isError }).toEqual({ status: 200, isError: false });
    expect(r.text).toContain('"token_name":"owner-key"');
    expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 1, released: 1 });
  });

  test('the owner\'s page reads serve in a principal session, member lineage included (lane L4 bd19577dde)', async () => {
    const r = await callMcp('secret-owner', 'get_page', { slug: 'notes/hello' });
    expect({ status: r.status, isError: r.isError, code: r.code }).toEqual({ status: 200, isError: false, code: undefined });
    expect(r.text).toContain('Hello from the owner.');
  });

  test('the owner\'s own key writes over /mcp', async () => {
    const r = await callMcp('secret-owner', 'put_page', { slug: 'notes/remote', content: '---\ntitle: Remote\n---\nWritten over HTTP.', request_id: randomUUID() });
    // Written, or accepted and pending (a brain without lane L5's fence fix).
    expect({ ok: !r.isError || r.code === 'write_pending', code: r.isError ? r.code : undefined })
      .toEqual({ ok: true, code: r.isError ? 'write_pending' : undefined });
  });

  test('another member\'s key and an unbound key are refused before any tool runs; a session never lingers', async () => {
    const before = { opens, releases };
    for (const bearer of ['secret-alice', 'secret-unbound']) {
      const r = await callMcp(bearer, 'get_page', { slug: 'notes/hello' });
      expect({ bearer, isError: r.isError, code: r.code }).toEqual({ bearer, isError: true, code: 'permission_denied' });
      expect(r.text).not.toContain('Hello from the owner.');
    }
    // Refused at the store's gate: no session was opened, so none is left open.
    expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 0, released: 0 });
  });

  test('no token and an unknown token get 401', async () => {
    expect((await callMcp(null, 'get_page', { slug: 'notes/hello' })).status).toBe(401);
    expect((await callMcp('secret-nobody', 'get_page', { slug: 'notes/hello' })).status).toBe(401);
  });

  test('the CLI serve --http starts on a multi-user Rust brain (no raw SQL at startup)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-http-cli-'));
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: join(home, 'brain') }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE)$/.test(k)) env[k] = v;
      Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0',
        GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() });
      const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'src', 'cli.ts'), 'serve', '--http', '--port', '0'], { env, stdout: 'pipe', stderr: 'pipe' });
      let stderr = '';
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !/GBrain MCP Server/.test(stderr) && proc.exitCode === null) {
        const next = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
        if (next && !next.done) stderr += decoder.decode(next.value);
        if (next?.done) break;
      }
      proc.kill();
      await proc.exited;
      expect({ started: /GBrain MCP Server/.test(stderr), rawSql: /executeRaw/.test(stderr) }).toEqual({ started: true, rawSql: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 90_000);
});
