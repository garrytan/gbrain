/**
 * GBRA-498: the thin client's `--room` travels as request-level `_meta.room` and the host marks the answer.
 *
 * 1. Protects: callRemoteTool sends `_meta.room` (never a `room` argument) and the production serve-http app marks
 *    the read for that room under the caller's own scope; the CLI's routed path reads the host's `_meta.room`.
 * 2. Fails when: the room is dropped on the wire, sent as an argument, or the host's marks are not read back.
 * 3. Existing coverage: test/access-room.test.ts marks through dispatch in-process; nothing sent a room over HTTP.
 * 4. No production seam: production serve-http app, a real OAuth client bound to the owner member.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { callRemoteTool, unpackToolResult, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { extractResponseMeta } from '../src/core/remote-mcp-error.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { routedRoom } from '../src/cli/room.ts';
import { ownerCookie, registerOAuthClient, startServeHttp, thinClientConfig, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
let serve: LiveServeHttp;
let config: GBrainConfig;
const home = mkdtempSync(join(tmpdir(), 'gbrain-thin-client-room-'));
const inHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home }, fn);

beforeAll(inHome(async () => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  serve = await startServeHttp(engine);
  for (const id of ['owner-example', 'alice-example']) await addMember(engine, id);
  await setOwner(engine, 'owner-example');
  await importFromContent(engine, 'notes/open-plan', '# Open plan\nQuarry ledger open notes.', { noEmbed: true });
  await importFromContent(engine, 'notes/owner-plan', '---\nreadable_by: [owner-example]\n---\n# Owner plan\nQuarry ledger owner notes.', { noEmbed: true });
  const client = await registerOAuthClient(serve, await ownerCookie(serve), 'read');
  await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: 'owner-example' });
  config = thinClientConfig(serve, client);
}), 120_000);

afterAll(async () => {
  _clearMcpClientTokenCache();
  await serve?.close();
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('--room through the thin client', () => {
  test('_meta.room reaches the host, which marks the answer; the routed path reads its marks', inHome(async () => {
    const raw = await callRemoteTool(config, 'list_pages', { limit: 50 }, { meta: { room: 'alice-example' } });
    const items = unpackToolResult(raw) as Array<{ slug: string; room_access?: unknown }>;
    expect(Object.fromEntries(items.map(i => [i.slug, i.room_access]))).toEqual({
      'notes/open-plan': { readable: true }, 'notes/owner-plan': { readable: false, reason: 'readers' },
    });
    const meta = extractResponseMeta(raw);
    expect(meta?.room).toMatchObject({ principals: ['member:alice-example'], declared_by: 'harness', complete: true });
    const routed = await routedRoom('list_pages', items, meta?.room, 'alice-example');
    expect(routed.local).toBe(false);
    const plain = unpackToolResult(await callRemoteTool(config, 'list_pages', { limit: 50 })) as Array<Record<string, unknown>>;
    expect(plain.some(i => 'room_access' in i)).toBe(false);
  }), 60_000);
});
