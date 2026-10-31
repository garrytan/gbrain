/**
 * GBRA-156: a per-request opt-out for `_meta.brain_hot_memory`.
 *
 * 1. Protects: under a member token, every successful tool call carries
 *    `_meta.brain_hot_memory` with recent facts from the token's write source
 *    (a member's private source). A channel or shared session asks for none
 *    with `_meta.hot_memory: "off"`, set on the MCP request (beside
 *    `arguments`) or inside the tool arguments, and gets no block. Without
 *    the opt-out the block is unchanged.
 * 2. Fails when: an opted-out call still carries the block, or a call
 *    without the opt-out (or with another value) loses it.
 * 3. Existing coverage (facts-context-injection, serve-http-meta) pins that
 *    the block appears and its visibility filter; nothing could turn it off
 *    per request.
 * 4. No production seam: the production serve-http app, a real legacy token
 *    granted two sources, and dispatch with the options stdio passes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall, hotMemoryOffIn } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { callTool, rpc, startServeHttp, type LiveServeHttp, type ToolResultWire } from './helpers/live-mcp-servers.ts';

const MEMBER_SOURCE = 'hm-private-alice-example';
const CHANNEL_SOURCE = 'hm-channel-a';
const FACT = 'alice-example prefers async standups';

let engine: PGLiteEngine;
let app: LiveServeHttp;
let token: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  for (const id of [MEMBER_SOURCE, CHANNEL_SOURCE]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
  await engine.insertFact({ fact: FACT, kind: 'preference', entity_slug: 'people/alice-example', visibility: 'world', source: 'test' }, { source_id: MEMBER_SOURCE });
  token = (await mintLegacyToken(engine, { name: 'hm-member-alice', scopes: ['read'], takesHolders: ['world'], sourceGrant: [MEMBER_SOURCE, CHANNEL_SOURCE] })).token;
  app = await startServeHttp(engine);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await engine?.disconnect();
});

function hotFacts(r: ToolResultWire): string[] | null {
  const block = r._meta?.brain_hot_memory as { source_id: string; facts: Array<{ fact: string }> } | undefined;
  if (!block) return null;
  expect(block.source_id).toBe(MEMBER_SOURCE);
  return block.facts.map(f => f.fact);
}

async function callWithRequestMeta(meta: Record<string, unknown>): Promise<ToolResultWire> {
  const r = await rpc(app.base, token, 'tools/call', { name: 'search', arguments: { query: 'standups' }, _meta: meta });
  expect(r.status).toBe(200);
  return r.body.result as ToolResultWire;
}

describe('_meta.brain_hot_memory per-request opt-out (serve-http, member token)', () => {
  test('by default the block carries the member source\'s recent facts', async () => {
    __resetHotMemoryCacheForTests();
    expect(hotFacts(await callTool(app.base, token, 'search', { query: 'standups' }))).toContain(FACT);
    expect(hotFacts(await callTool(app.base, token, 'list_pages', {}))).toContain(FACT);
  });

  test('request-level _meta.hot_memory "off" drops the block', async () => {
    const r = await callWithRequestMeta({ hot_memory: 'off', session_id: 'channel-session' });
    expect(r.isError).toBeFalsy();
    expect(hotFacts(r)).toBeNull();
  });

  test('_meta.hot_memory "off" inside the tool arguments drops the block', async () => {
    const r = await callTool(app.base, token, 'search', { query: 'standups', _meta: { hot_memory: 'off' } });
    expect(r.isError).toBeFalsy();
    expect(hotFacts(r)).toBeNull();
  });

  test('any other value keeps the default', async () => {
    expect(hotFacts(await callWithRequestMeta({ hot_memory: 'on' }))).toContain(FACT);
    expect(hotFacts(await callWithRequestMeta({ hot_memory: false }))).toContain(FACT);
  });
});

describe('dispatch honours hotMemoryOff from the transport (stdio options)', () => {
  const opts = { remote: true, transport: 'stdio' as const, sourceId: MEMBER_SOURCE, takesHoldersAllowList: ['world'], metaHook: getBrainHotMemoryMeta };

  test('without the opt-out the block is present; with it, absent', async () => {
    __resetHotMemoryCacheForTests();
    expect(((await dispatchToolCall(engine, 'get_stats', {}, opts))._meta as any)?.brain_hot_memory).toBeDefined();
    const off = await dispatchToolCall(engine, 'get_stats', {}, { ...opts, hotMemoryOff: true });
    expect(off.isError).toBeFalsy();
    expect((off._meta as any)?.brain_hot_memory).toBeUndefined();
  });

  test('hotMemoryOffIn reads only the exact "off" value', () => {
    expect(hotMemoryOffIn({ _meta: { hot_memory: 'off' } })).toBe(true);
    for (const v of [undefined, {}, { _meta: null }, { _meta: { hot_memory: 'OFF' } }, { _meta: { hot_memory: false } }]) expect(hotMemoryOffIn(v)).toBe(false);
  });
});
