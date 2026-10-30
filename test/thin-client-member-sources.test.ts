/**
 * Per-member OAuth clients through the thin client: two clients, each
 * granted a different source, call `search` through `callRemoteTool`
 * against one MCP URL from one process, interleaved and concurrent. Every
 * call's rows stay inside that client's own source.
 *
 * 1. Protects: the multi-member bot pattern on the client side (one process,
 *    one server URL, one client per member, each narrowed to that member's
 *    sources). The access token a call presents is the one minted for that
 *    call's client, so one member's call never runs under another's grant.
 * 2. Fails when: the thin client presents one client's token for another
 *    client's call at the same URL, in memory or through the on-disk cache.
 * 3. Existing coverage (thin-client-token-cache-7360) pins write scope across
 *    two clients; this pins read sources under concurrency.
 * 4. No production seam: production serve-http app, real OAuth clients.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { callRemoteTool, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { ownerCookie, registerOAuthClient, startServeHttp, thinClientConfig, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const MEMBERS = { a: 'tc-source-a', b: 'tc-source-b' } as const;
const CANARY = { a: 'canaryalpha', b: 'canarybravo' } as const;

let engine: PGLiteEngine;
let serve: LiveServeHttp;
const configs = {} as Record<'a' | 'b', GBrainConfig>;
const home = mkdtempSync(join(tmpdir(), 'gbrain-thin-client-members-'));
const inHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home }, fn);

beforeAll(inHome(async () => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  serve = await startServeHttp(engine);
  const cookie = await ownerCookie(serve);
  for (const member of ['a', 'b'] as const) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [MEMBERS[member]]);
    await importFromContent(engine, `notes/ledger-${member}`, `# Quarry ledger\nQuarry ledger notes for member ${member}, ${CANARY[member]}.`, { sourceId: MEMBERS[member], noEmbed: true });
    const client = await registerOAuthClient(serve, cookie, 'read');
    await engine.executeRaw(`UPDATE oauth_clients SET source_id = $2, federated_read = ARRAY[$2] WHERE client_id = $1`, [client.clientId, MEMBERS[member]]);
    configs[member] = thinClientConfig(serve, client);
  }
}), 120_000);

afterAll(async () => {
  _clearMcpClientTokenCache();
  await serve?.close();
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('per-member OAuth clients through callRemoteTool', () => {
  async function searchAs(member: 'a' | 'b'): Promise<void> {
    const other = member === 'a' ? 'b' : 'a';
    const text = JSON.stringify(await callRemoteTool(configs[member], 'search', { query: 'quarry ledger notes' }));
    expect(text).toContain(CANARY[member]);
    expect(text).not.toContain(CANARY[other]);
    expect(text).not.toContain(MEMBERS[other]);
  }

  test('one client after the other at one URL: each call runs under its own client', inHome(async () => {
    await searchAs('a');
    await searchAs('b');
    _clearMcpClientTokenCache({ keepDisk: true });
    await searchAs('b');
    await searchAs('a');
  }), 60_000);

  test('interleaved concurrent searches at one URL never cross between the two clients', inHome(async () => {
    await searchAs('a');
    const calls: Array<Promise<void>> = [];
    for (let round = 0; round < 6; round++) {
      for (const member of ['b', 'a'] as const) calls.push(searchAs(member));
    }
    await Promise.all(calls);
  }), 60_000);
});
