/**
 * Agent operator contract v1 (A6 "MCP error", A1 thin client): every MCP
 * `isError` result is exactly ONE content block on every server path, the
 * notices an erroring call collected ride the envelope's `notices` key (never
 * an extra block), and the FROZEN pre-wave thin client
 * (test/fixtures/agent-contract/frozen-thin-client-v0.60.37.ts, which joins
 * every block before parsing an error) reads real new-server responses.
 *
 * Servers (all production code, real HTTP on an ephemeral loopback port, an
 * in-memory keyless PGLite brain):
 *   - shared dispatch (`dispatchToolCall`, the stdio and `gbrain call` path);
 *   - `gbrain serve --http` (`buildServeHttpApp`): unknown-op, insufficient
 *     scope, the dispatch-throw catch, and handler errors;
 *   - the legacy bearer transport (`startHttpTransport`): scope, unknown tool
 *     and handler errors.
 *
 * Protects: a server path that appends a notice/hint block to an error (the
 * old client would then concatenate it into unparseable JSON and lose `error`,
 * `suggestion` and receipts), a path that bypasses the envelope (nested
 * `{error:{…}}` or plain text), notices dropped from errors, and receipts
 * (`write_request`/`write_error`) lost on any transport.
 * Why new: test/thin-client-contract-skew.test.ts runs the frozen client
 * against the checked-in goldens; this runs it against live server output on
 * every path, including the ones goldens cannot reach (serve-http's unknown-op,
 * scope and dispatch-throw branches, the legacy transport).
 * Constructed instances: no real op on a keyless brain throws mid-flight with
 * collected notices, carries a write receipt, or makes `dispatchToolCall`
 * itself throw, so those rows swap one op's handler (or make its param read
 * throw) through `withOpHandler`; everything on the wire stays real.
 *
 * Brain age is pinned, not inherited. The one-time `behavior_changes` safety
 * notice rides the first result per brain (stdio) and per authenticated client
 * (HTTP), errors included, when the brain predates the running release: its
 * oldest `sources.created_at` is more than an hour old, or the GBRAIN_HOME
 * baseline / upgrade log says so. A snapshot-restored brain keeps the
 * snapshot's build time (hours old on a branch whose cached snapshot is
 * stale), and the shard's shared GBRAIN_HOME keeps whatever baseline an earlier
 * file recorded. So every row runs in this file's own GBRAIN_HOME against a
 * brain created now (no disclosure due), and the last block ages the brain two
 * hours in a second fresh home to pin the upgraded-brain shape.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { __resetBehaviorNoticeForTests } from '../src/core/behavior-change-notice.ts';
import { OperationError, opError, type Operation } from '../src/core/ops/contract.ts';
import { callRemoteTool, RemoteMcpError, extractNotices, unpackToolResult } from '../src/core/mcp-client.ts';
import { oldReadError, oldUnpack } from './fixtures/agent-contract/frozen-thin-client-v0.60.37.ts';
import {
  callTool, clientCredentialsToken, envelopeOf, legacyToken, opNamed, ownerCookie, registerOAuthClient,
  startLegacyHttp, startServeHttp, thinClientConfig, withOpHandler,
  type LiveLegacyHttp, type LiveServeHttp, type ToolResultWire,
} from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let serve: LiveServeHttp;
let legacy: LiveLegacyHttp;
let readToken: string;
let writeToken: string;
let oauth: { clientId: string; clientSecret: string };
const home = mkdtempSync(join(tmpdir(), 'gbrain-error-single-block-'));
const agedHome = mkdtempSync(join(tmpdir(), 'gbrain-error-single-block-aged-'));
/** Run a test body in this file's own GBRAIN_HOME (behavior_changes baseline and markers live there). */
const inHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home }, fn);

/** Set the brain's creation time to `agoMs` before now (sources is topology-guarded; the test owns this brain). */
async function setBrainCreated(agoMs: number): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE sources SET created_at = $1::timestamptz', [new Date(Date.now() - agoMs).toISOString()]);
  });
}

beforeAll(inHome(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await setBrainCreated(0);
  __resetBehaviorNoticeForTests();
  serve = await startServeHttp(engine);
  legacy = await startLegacyHttp(engine);
  readToken = await legacyToken(engine, ['read']);
  writeToken = await legacyToken(engine, ['read', 'write', 'admin']);
  oauth = await registerOAuthClient(serve, await ownerCookie(serve), 'read write admin');
}), 120_000);

afterAll(async () => {
  await serve?.close();
  legacy?.close();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  rmSync(agedHome, { recursive: true, force: true });
});

const RECEIPT = { request_id: '11111111-2222-4333-8444-555555555555', state: 'queued', retry_after_ms: 2000 };
const NOTICE = { code: 'degraded_recall', kind: 'degraded' as const, why: 'Recall was degraded (keyword_zero) before the failure.' };

const stdioOpts: DispatchOpts = { remote: true, transport: 'stdio', sourceId: 'default' };
const dispatch = (name: string, args: Record<string, unknown> = {}) => dispatchToolCall(engine, name, args, stdioOpts) as Promise<ToolResultWire>;

/** A handler that collects a notice and then fails: the notice must ride the envelope. */
const noticeThenThrow = (err: () => unknown): Operation['handler'] => async ctx => {
  ctx.emitNotice?.(NOTICE);
  throw err();
};

const receiptError = () => {
  const e = opError('write_pending', 'The write was accepted and is still pending.', 'Inspect the receipt before resubmitting.');
  e.writeRequest = { ...RECEIPT } as OperationError['writeRequest'];
  e.writeError = 'write_pending';
  return e;
};

/** Exactly one block, the v1 envelope, and no notice block hidden in content. */
function assertSingleBlock(result: ToolResultWire): Record<string, any> {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.text).not.toContain('[gbrain notice ');
  const env = envelopeOf(result);
  expect(typeof env.error).toBe('string');
  expect(typeof env.code).toBe('string');
  expect(env.contract_version).toBe(1);
  return env;
}

/** The frozen v0.60.37 client reads the same `error`, message, suggestion and receipt. */
function assertOldClientReads(result: ToolResultWire, env: Record<string, any>): void {
  const old = oldReadError(result);
  expect(old.code).toBe(env.error);
  expect(old.message).toBe(env.message);
  expect(old.suggestion).toBe(env.suggestion);
  if (env.write_request) expect(old.write_request).toEqual(env.write_request);
  if (env.write_error) expect(old.write_error).toBe(env.write_error);
}

describe('shared dispatch (stdio path)', () => {
  test('unknown tool, caller error and invalid params: one block each', inHome(async () => {
    for (const [name, args, code] of [
      ['no_such_tool_x', {}, 'unknown_tool'],
      ['get_page', { slug: 'notes/missing-example' }, 'page_not_found'],
      ['get_page', {}, 'invalid_params'],
    ] as const) {
      const r = await dispatch(name, args);
      const env = assertSingleBlock(r);
      expect(env.code).toBe(code);
      assertOldClientReads(r, env);
    }
  }));

  test('a failing call that collected notices: notices in the envelope, still one block', inHome(async () => {
    for (const err of [() => new Error('mid-flight failure'), () => new OperationError('storage_error', 'disk full', 'Free space on the brain host.')]) {
      __resetProcessNoticeLedgerForTests(); // stdio dedupes per process; each family starts a fresh process
      const r = await withOpHandler('get_brain_identity', noticeThenThrow(err), () => dispatch('get_brain_identity'));
      const env = assertSingleBlock(r);
      expect(env.notices?.map((n: { code: string }) => n.code)).toEqual(['degraded_recall']);
      expect(env.notices[0]).toMatchObject({ kind: 'degraded', contract_version: 1 });
      expect(r._meta?.gbrain_notices).toBeUndefined();
      assertOldClientReads(r, env);
    }
  }));

  test('receipt-bearing error keeps write_request/write_error for the old client', inHome(async () => {
    const r = await withOpHandler('put_page', async () => { throw receiptError(); },
      () => dispatch('put_page', { slug: 'notes/receipt-example', content: 'x' }));
    const env = assertSingleBlock(r);
    expect(env.write_request).toMatchObject(RECEIPT);
    expect(env.write_error).toBe('write_pending');
    expect(env.fix?.mcp).toEqual({ tool: 'get_write_request', arguments: { request_id: RECEIPT.request_id } });
    assertOldClientReads(r, env);
  }));
});

describe('gbrain serve --http (serve-http-mcp)', () => {
  test('unknown op keeps the frozen pair (error unknown_operation, code unknown_tool): one block', inHome(async () => {
    const r = await callTool(serve.base, readToken, 'no_such_tool_x');
    const env = assertSingleBlock(r);
    expect([env.error, env.code]).toEqual(['unknown_operation', 'unknown_tool']);
    assertOldClientReads(r, env);
  }));

  test('insufficient scope: one block, frozen error value, code insufficient_scope', inHome(async () => {
    const r = await callTool(serve.base, readToken, 'put_page', { slug: 'notes/scope-example', content: 'x' });
    const env = assertSingleBlock(r);
    expect(env.code).toBe('insufficient_scope');
    expect(env.your_scopes).toEqual(['read']);
    assertOldClientReads(r, env);
  }));

  test('dispatch itself throwing lands in the serve-http catch as one internal_error block', inHome(async () => {
    // dispatchToolCall reads op.cliOnly before its own try; a fault there is the only way into serve-http's catch.
    const op = opNamed('get_brain_identity');
    const own = Object.getOwnPropertyDescriptor(op, 'cliOnly');
    Object.defineProperty(op, 'cliOnly', {
      configurable: true,
      get() { if (new Error().stack?.includes('dispatchToolCall')) throw new Error('op definition unreadable'); return own?.value; },
    });
    let r: ToolResultWire;
    try {
      r = await callTool(serve.base, readToken, 'get_brain_identity');
    } finally {
      if (own) Object.defineProperty(op, 'cliOnly', own);
      else delete (op as { cliOnly?: unknown }).cliOnly;
    }
    const env = assertSingleBlock(r);
    expect(env.code).toBe('internal_error');
    expect(env.suggestion).toContain('Server-side failure in get_brain_identity');
    assertOldClientReads(r, env);
  }));

  test('handler errors (caller, notices, receipt): one block each, notices in the envelope', inHome(async () => {
    const miss = await callTool(serve.base, readToken, 'get_page', { slug: 'notes/missing-example' });
    assertOldClientReads(miss, assertSingleBlock(miss));

    const withNotice = await withOpHandler('get_brain_identity', noticeThenThrow(() => new Error('mid-flight failure')),
      () => callTool(serve.base, readToken, 'get_brain_identity'));
    const env = assertSingleBlock(withNotice);
    expect(env.notices?.map((n: { code: string }) => n.code)).toEqual(['degraded_recall']);
    assertOldClientReads(withNotice, env);

    const receipt = await withOpHandler('put_page', async () => { throw receiptError(); },
      () => callTool(serve.base, writeToken, 'put_page', { slug: 'notes/receipt-example', content: 'x' }));
    const renv = assertSingleBlock(receipt);
    expect(renv.write_request).toMatchObject(RECEIPT);
    assertOldClientReads(receipt, renv);
  }));
});

describe('legacy bearer transport (http-transport.ts)', () => {
  test('scope denial, unknown tool, caller error, notices and receipts: one block each', inHome(async () => {
    const scope = await callTool(legacy.base, readToken, 'put_page', { slug: 'notes/scope-example', content: 'x' });
    const senv = assertSingleBlock(scope);
    expect([senv.error, senv.code]).toEqual(['permission_denied', 'insufficient_scope']);
    assertOldClientReads(scope, senv);

    const unknown = await callTool(legacy.base, readToken, 'no_such_tool_x');
    expect(assertSingleBlock(unknown).code).toBe('unknown_tool');
    assertOldClientReads(unknown, envelopeOf(unknown));

    const miss = await callTool(legacy.base, readToken, 'get_page', { slug: 'notes/missing-example' });
    assertOldClientReads(miss, assertSingleBlock(miss));

    const withNotice = await withOpHandler('get_brain_identity', noticeThenThrow(() => new Error('mid-flight failure')),
      () => callTool(legacy.base, readToken, 'get_brain_identity'));
    expect(assertSingleBlock(withNotice).notices?.[0]?.code).toBe('degraded_recall');

    const receipt = await withOpHandler('put_page', async () => { throw receiptError(); },
      () => callTool(legacy.base, writeToken, 'put_page', { slug: 'notes/receipt-example', content: 'x' }));
    const renv = assertSingleBlock(receipt);
    expect(renv.write_request).toMatchObject(RECEIPT);
    assertOldClientReads(receipt, renv);
  }));
});

describe('success results with notice blocks', () => {
  test('a real degraded empty query: the old client reads content[0] only; the new client reads the notices', inHome(async () => {
    for (const r of [
      await dispatch('query', { query: 'nothing matches this phrase' }),
      await callTool(serve.base, readToken, 'query', { query: 'nothing matches this phrase' }),
      await callTool(legacy.base, readToken, 'query', { query: 'nothing matches this phrase' }),
    ]) {
      expect(r.isError).toBeFalsy();
      expect(r.content.length).toBeGreaterThan(1);
      expect(r.content.slice(1).some(b => b.text.startsWith('[gbrain notice '))).toBe(true);
      expect(oldUnpack(r)).toEqual([]);
      expect(unpackToolResult<unknown[]>(r)).toEqual([]);
      expect(extractNotices(r).map(n => n.code)).toContain('empty_retrieval');
    }
  }));
});

describe('the current thin client (callRemoteTool) against the live serve-http', () => {
  const remote = async (name: string, args: Record<string, unknown>): Promise<RemoteMcpError> => {
    const e = await callRemoteTool(thinClientConfig(serve, oauth), name, args, { timeoutMs: 30_000 }).catch(err => err);
    expect(e).toBeInstanceOf(RemoteMcpError);
    expect((e as RemoteMcpError).reason).toBe('tool_error');
    return e as RemoteMcpError;
  };

  test('error with notices: code, fix and notices survive; the body is content[0] alone', inHome(async () => {
    const e = await withOpHandler('get_brain_identity', noticeThenThrow(() => new OperationError('storage_error', 'disk full', 'Free space on the brain host.')),
      () => remote('get_brain_identity', {}));
    expect(e.detail).toMatchObject({ code: 'storage_error', message: 'disk full', contract_version: 1 });
    expect(e.detail?.notices?.map(n => n.code)).toEqual(['degraded_recall']);
    expect(e.toJSON()).toMatchObject({ error: 'storage_error', code: 'storage_error', notices: [expect.objectContaining({ code: 'degraded_recall' })] });
  }));

  test('receipt-bearing error: write_request and write_error survive', inHome(async () => {
    const e = await withOpHandler('put_page', async () => { throw receiptError(); },
      () => remote('put_page', { slug: 'notes/receipt-example', content: 'x' }));
    expect(e.detail?.write_request).toMatchObject(RECEIPT);
    expect(e.detail?.write_error).toBe('write_pending');
    expect(e.toJSON()).toMatchObject({ error: 'write_pending', write_request: expect.objectContaining({ request_id: RECEIPT.request_id }) });
  }));
});

describe('an upgraded brain (created two hours ago): the one-time behavior_changes disclosure', () => {
  const codes = (env: Record<string, any>) => env.notices?.map((n: { code: string }) => n.code);
  const isBehaviorBlock = (b: { text: string }) => b.text.startsWith('[gbrain notice behavior_changes kind=safety]');

  test('rides the first result per brain (stdio) and per client (HTTP) in the envelope; errors stay one block', () => withEnv({ GBRAIN_HOME: agedHome }, async () => {
    await setBrainCreated(2 * 60 * 60 * 1000);
    __resetBehaviorNoticeForTests();
    const storageError = () => new OperationError('storage_error', 'disk full', 'Free space on the brain host.');

    for (const expected of [['behavior_changes', 'degraded_recall'], ['degraded_recall']]) {
      __resetProcessNoticeLedgerForTests();
      const r = await withOpHandler('get_brain_identity', noticeThenThrow(storageError), () => dispatch('get_brain_identity'));
      const env = assertSingleBlock(r);
      expect(codes(env)).toEqual(expected);
      assertOldClientReads(r, env);
    }

    for (const base of [serve.base, legacy.base]) {
      const token = await legacyToken(engine, ['read']);
      const first = await withOpHandler('get_brain_identity', noticeThenThrow(() => new Error('mid-flight failure')),
        () => callTool(base, token, 'get_brain_identity'));
      const env = assertSingleBlock(first);
      expect(codes(env)).toEqual(['behavior_changes', 'degraded_recall']);
      expect(env.notices[0]).toMatchObject({ kind: 'safety', contract_version: 1 });
      assertOldClientReads(first, env);
      const again = await withOpHandler('get_brain_identity', noticeThenThrow(() => new Error('mid-flight failure')),
        () => callTool(base, token, 'get_brain_identity'));
      expect(codes(assertSingleBlock(again))).toEqual(['degraded_recall']);
    }

    const e = await withOpHandler('get_brain_identity', noticeThenThrow(storageError),
      () => callRemoteTool(thinClientConfig(serve, oauth), 'get_brain_identity', {}, { timeoutMs: 30_000 }).then(() => null, (err: unknown) => err as RemoteMcpError));
    expect(e).toBeInstanceOf(RemoteMcpError);
    expect(e?.detail).toMatchObject({ code: 'storage_error', message: 'disk full', contract_version: 1 });
    expect(e?.detail?.notices?.map(n => n.code)).toEqual(['behavior_changes', 'degraded_recall']);
  }));

  test('on a success result it is an extra block after content[0], which both clients still parse alone', () => withEnv({ GBRAIN_HOME: agedHome }, async () => {
    const token = await legacyToken(engine, ['read']);
    const r = await callTool(serve.base, token, 'query', { query: 'nothing matches this phrase' });
    expect(r.isError).toBeFalsy();
    expect(r.content.slice(1).some(isBehaviorBlock)).toBe(true);
    expect(isBehaviorBlock(r.content[0]!)).toBe(false);
    expect(oldUnpack(r)).toEqual([]);
    expect(unpackToolResult<unknown[]>(r)).toEqual([]);
    expect(extractNotices(r).map(n => n.code)).toEqual(expect.arrayContaining(['behavior_changes', 'empty_retrieval']));
  }));
});
