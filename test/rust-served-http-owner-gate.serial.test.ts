/**
 * The owner-only gate (ruling A1) of `gbrain serve --http` and the legacy HTTP transport when the serving process is a
 * served client of a multi-user brain server (protocol v3): the client has no store to open a principal session in, so
 * the gate reads the brain's owner member from the server and admits only a credential bound to it.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served` and `multi_writer`.
 *
 * 1. Protects: over a served client, the owner's own key gets in; another member's key and an unbound key
 *    are refused `permission_denied` with the owner-only message and read nothing, on both HTTP surfaces.
 * 2. Fails on: a gate that only looks for a local store (a served client then serves every key, A1 bypassed).
 * 3. Existing coverage: rust-serve-http*.serial.test.ts run the gate on the process that owns the store.
 * 4. Seam: none below HTTP: a real owner, a real v3 listener, a real served client, the real apps.
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
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { hashToken } from '../src/core/utils.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const SERVER_TOKEN = 'served-gate-owner-server-token';
const BODY = 'Hello from the owner.';
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;
let http: Server;
let servePort = 0;
let transport: { port?: number; stop(force?: boolean): unknown } | undefined;

async function token(name: string, secret: string, member: string | null): Promise<void> {
  const row = { name, token_hash: hashToken(secret), scopes: ['read', 'write'], permissions: {}, member_id: member };
  await (owner as unknown as { insertAccessToken(r: unknown): Promise<unknown> }).insertAccessToken(row);
}

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

describeAddon('the owner-only gate on a served client of a multi-user brain server', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    const addon = await loadRustArmAddon();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-served-gate-'));
    owner = openRustEngine({ addon, databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, t) => { if (t !== SERVER_TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    for (const id of ['owner-example', 'alice-example']) {
      await owner.insertAccessMember({ id, displayName: null, email: null, kind: 'person' as never, groups: [], bindTokenId: null });
    }
    await owner.setConfig('access.owner_member', 'owner-example');
    await token('owner-key', 'secret-owner', 'owner-example');
    await token('alice-key', 'secret-alice', 'alice-example');
    await token('unbound-key', 'secret-unbound', null);
    await owner.putPage('notes/hello', { type: 'note', title: 'Hello', compiled_truth: BODY, timeline: '' } as never);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    client = openRustEngine({ addon, databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: SERVER_TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);
    const app = express();
    http = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    servePort = (http.address() as { port: number }).port;
    await buildServeHttpApp(app, client as never, { port: servePort, tokenTtl: 3600, enableDcr: false, publicUrl: `http://127.0.0.1:${servePort}` } as never);
    transport = await startHttpTransport({ port: 0, engine: client as never }) as never;
  }, 120_000);

  afterAll(async () => {
    transport?.stop(true);
    http?.closeAllConnections();
    await new Promise<void>(r => (http ? http.close(() => r()) : r()));
    await client?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the owner runs multi-user and the HTTP surfaces serve a served multi-writer client', () => {
    expect({ multiuser: owner.openStore('served-gate').multiuser, served: client.capabilities.has('served'), multiWriter: client.capabilities.has('multi_writer') })
      .toEqual({ multiuser: true, served: true, multiWriter: true });
  });

  for (const surface of ['serve --http', 'legacy transport'] as const) {
    const port = () => (surface === 'serve --http' ? servePort : transport!.port!);

    test(`${surface}: the owner's own key gets in (whoami answers for its token)`, async () => {
      // whoami, not get_page: a remote get_page also needs pageAwaitsRederive on the remote read list (batch 3).
      const r = await call(port(), 'secret-owner', 'whoami', {});
      expect({ status: r.status, isError: r.isError }).toEqual({ status: 200, isError: false });
      expect(r.text).toContain('owner-key');
    });

    test(`${surface}: another member's key and an unbound key are refused with the owner-only message and read nothing`, async () => {
      for (const bearer of ['secret-alice', 'secret-unbound']) {
        const r = await call(port(), bearer, 'get_page', { slug: 'notes/hello' });
        expect({ bearer, isError: r.isError, code: r.code }).toEqual({ bearer, isError: true, code: 'permission_denied' });
        expect(r.text).toContain("only the brain owner's own key is admitted");
        expect(r.text).not.toContain(BODY);
      }
    });
  }
});
