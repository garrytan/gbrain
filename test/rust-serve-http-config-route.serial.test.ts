/**
 * The owner-only session gate of both HTTP MCP surfaces (`gbrain serve --http` and the legacy bearer transport) on a Rust
 * brain that runs multi-user ONLY through its own config row `engine.rust.multiuser` (I-0.v2), with the environment
 * switch unset (multi-user lane L6, finding "L3 config-route owner-only gate").
 *
 * Mode: the brain is seeded with the switch off, its config row is set to `true`, and it is reopened with
 * GBRAIN_RUST_MULTIUSER unset. The test asserts the environment switch is unset and the store reports `multiuser: true`.
 *
 * 1. Protects: on the config route, exactly as on the environment route, only the brain owner's own key gets in, each
 *    call in a principal session the store opened; another member's key and an unbound key are refused
 *    `permission_denied` before any tool runs and read nothing.
 * 2. Fails on: a gate that reads only the environment switch (a non-owner key reads the owner's page).
 * 3. Existing coverage: rust-serve-http.serial.test.ts and rust-mcp-http-transport.serial.test.ts cover the
 *    environment route only.
 * 4. Seam: none below HTTP: the real apps, the real bearer check, the real store session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { RUST_MULTIUSER_CONFIG_KEY, rustMultiuserFromEnv } from '../src/core/rust-engine/multiuser-switch.ts';
import { hashToken } from '../src/core/utils.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
let dir = '';
let engine: RustEngine;
let http: Server;
let servePort = 0;
let transport: { port?: number; stop(force?: boolean): unknown } | undefined;
let opens = 0;
let releases = 0;
const BODY = 'Hello from the owner.';

async function token(name: string, secret: string, member: string | null): Promise<void> {
  const row = { name, token_hash: hashToken(secret), scopes: ['read', 'write'], permissions: {}, member_id: member };
  await (engine as unknown as { insertAccessToken(r: unknown): Promise<unknown> }).insertAccessToken(row);
}

/** One tools/call on `port`; `sse` accepts the streamable-HTTP reply of serve --http. */
async function call(port: number, bearer: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  let body: { result?: { isError?: boolean; content?: Array<{ text: string }> } } = {};
  try { body = JSON.parse(text.startsWith('event:') ? text.split('\ndata: ')[1]!.split('\n')[0]! : text); } catch { /* not JSON */ }
  const resultText = body.result?.content?.map(c => c.text).join('') ?? '';
  let code: string | undefined;
  try { const j = JSON.parse(resultText) as { code?: string; error?: string }; code = j.code ?? j.error; } catch { /* plain */ }
  return { status: response.status, isError: body.result?.isError === true, code, text: resultText };
}

describeAddon('the owner-only gate on a Rust brain multi-user through its config row only', () => {
  beforeAll(async () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    const addon = await loadRustArmAddon();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-http-config-'));
    engine = openRustEngine({ addon, databasePath: join(dir, 'db') });
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    for (const id of ['owner-example', 'alice-example']) {
      await engine.insertAccessMember({ id, displayName: null, email: null, kind: 'person' as never, groups: [], bindTokenId: null });
    }
    await engine.setConfig('access.owner_member', 'owner-example');
    await token('owner-key', 'secret-owner', 'owner-example');
    await token('alice-key', 'secret-alice', 'alice-example');
    await token('unbound-key', 'secret-unbound', null);
    await engine.putPage('notes/hello', { type: 'note', title: 'Hello', compiled_truth: BODY, timeline: '' } as never);
    await engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
    await engine.disconnect();
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    const brain = engine.openStore('config-route-test').brain as Record<string, (...a: unknown[]) => unknown>;
    const mint = brain.mintScope!.bind(brain); const release = brain.releaseScope!.bind(brain);
    brain.mintScope = async (...a: unknown[]) => { const out = await mint(...a); opens++; return out; };
    brain.releaseScope = (...a: unknown[]) => { releases++; return release(...a); };
    const app = express();
    http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    servePort = (http.address() as { port: number }).port;
    await buildServeHttpApp(app, engine as never, { port: servePort, tokenTtl: 3600, enableDcr: false, publicUrl: `http://127.0.0.1:${servePort}` } as never);
    transport = await startHttpTransport({ port: 0, engine: engine as never }) as never;
  }, 120_000);

  afterAll(async () => {
    transport?.stop(true);
    http?.closeAllConnections();
    await new Promise<void>(r => (http ? http.close(() => r()) : r()));
    await engine?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the brain is multi-user through its config row alone: the environment switch is unset', () => {
    expect({ env: rustMultiuserFromEnv(), store: engine.openStore('config-route-test').multiuser }).toEqual({ env: false, store: true });
  });

  for (const surface of ['serve --http', 'legacy transport'] as const) {
    const port = () => (surface === 'serve --http' ? servePort : transport!.port!);

    test(`${surface}: the owner's own key gets in, in a session the store opened and released`, async () => {
      const before = { opens, releases };
      const r = await call(port(), 'secret-owner', 'get_page', { slug: 'notes/hello' });
      expect({ status: r.status, isError: r.isError }).toEqual({ status: 200, isError: false });
      expect(r.text).toContain(BODY);
      expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 1, released: 1 });
    });

    test(`${surface}: another member's key and an unbound key are refused before any tool runs and read nothing`, async () => {
      const before = { opens, releases };
      for (const bearer of ['secret-alice', 'secret-unbound']) {
        const r = await call(port(), bearer, 'get_page', { slug: 'notes/hello' });
        expect({ bearer, isError: r.isError, code: r.code }).toEqual({ bearer, isError: true, code: 'permission_denied' });
        expect(r.text).toContain("only the brain owner's own key is admitted");
        expect(r.text).not.toContain(BODY);
      }
      expect({ opened: opens - before.opens, released: releases - before.releases }).toEqual({ opened: 0, released: 0 });
    });
  }
});
