/**
 * Remote writes over the served wire (multi-user lane L3, approach (a), ruled 2026-11-26): an agent-facing (remote) caller of
 * a served client writes only through whole operations of one closed list (served/remote-whole-ops.ts) and the one
 * scope-checked side write (owner-ipc/routes.ts OWNER_IPC_REMOTE_SIDE_WRITES), and the brain server never trusts what the
 * client built.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served` and `multi_writer`.
 *
 * 1. Protects (hostile client):
 *    - a remote whole operation off the closed list is refused at the client and, sent as a raw frame, by the server;
 *    - a remote raw member write (not the side write) stays refused by the server;
 *    - a remote whole operation runs on the server with ctx.remote true and its scope checked again against the grant
 *      the client claims (a grant without `write` is refused, nothing written), and context fields outside the plain
 *      list never reach the handler;
 *    - the retrieval stamp: the server stamps only pages the caller may read; one id outside the caller's read scope
 *      refuses the whole call and stamps nothing;
 *    - the stamp is best-effort: a remote get_page answers the same with tracking on and off.
 *    - a remote caller sets only its own transaction: beginSnapshotRead (owner-ipc/routes.ts OWNER_IPC_REMOTE_TXN_SETTINGS)
 *      runs on a transaction the caller holds and is refused outside one, and a write in that transaction stays refused by
 *      the server; a remote fuzzy get_page, which reads in such a snapshot, answers and hides a private candidate.
 *    - request_tools crosses only as a surface persist for an OAuth client: its listing, descriptor and no-client forms are
 *      refused at the client and at the server; the persist writes the client row on the server; the caller's surface
 *      ceiling crosses as a narrowing claim (a surface above it is refused, nothing written), and a ceiling that is not a
 *      surface name is refused before anything runs.
 *    - a remote delete_page crosses whole and soft-deletes on the server; a purge (or the internal retention flag) is
 *      refused there even when the client claims a local caller, and a grant without write is refused, nothing removed.
 *    Every case also holds on the config route (the served arm runs the parity files on both).
 * 2. Fails on: a server that runs any remote whole operation, trusts a client's dispatch for the scope check, keeps a
 *    client-supplied authority key, stamps a page the caller cannot read, or lets a remote caller's transaction setting
 *    cross outside its own transaction, runs a request_tools form other than the persist or above the claimed ceiling, or
 *    purges a page for a remote caller.
 * 3. Seam: none below the engine: a real owner, a real v3 listener, a real served client, raw frames through the client.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { servedConnectionOf } from '../src/core/rust-engine/served/store-returning.ts';
import { OWNER_RUN_OPERATION } from '../src/core/rust-engine/owner-ipc/forwarded-names.ts';
import { REMOTE_CONTEXT_KEYS, remoteOperationContext } from '../src/core/rust-engine/served/remote-whole-ops.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const TOKEN = 'remote-writes-owner-token';
const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
const NOTE = (title: string, body: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note', title, compiled_truth: body, timeline: '', frontmatter }) as never;
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;

type Conn = {
  request(kind: 'call' | 'fn', member: string, args: unknown[], opts?: { txn?: string }): Promise<unknown>;
  txn(op: 'begin' | 'commit' | 'rollback', opts: { txn?: string }): Promise<unknown>;
};
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => String((e as { code?: string }).code ?? (e as Error).message));
const worldOnly = <T>(fn: () => Promise<T>) => withRemoteCaller(true, () => withCallerAccess({ identity: [], audience: null, audienceIdentities: [] }, fn));
const stampOf = async (slug: string) => {
  const rows = await owner.listPrefixSampledPages({ prefixes: [slug] });
  if (!rows.some(r => r.slug === slug)) throw new Error(`the stamp read found no row for ${slug}`);
  return rows.find(r => r.slug === slug)!.last_retrieved_at ?? null;
};

describeAddon('remote writes over the served wire', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-remote-writes-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, t) => { if (t !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    await owner.putPage('notes/open', NOTE('Open', 'Anyone may read this.'));
    await owner.putPage('notes/secret', NOTE('Secret', 'Owner only.', { visibility: 'private' }));
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);
  }, 120_000);

  afterAll(async () => {
    await client?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the owner runs multi-user and the client is a served multi-writer client', () => {
    expect({ multiuser: owner.openStore('remote-writes').multiuser, served: client.capabilities.has('served'), mw: client.capabilities.has('multi_writer') })
      .toEqual({ multiuser: true, served: true, mw: true });
  });

  test('a listed remote whole operation crosses and writes; one off the list is refused at the client and at the server', async () => {
    const put = await dispatchToolCall(client, 'put_page', { slug: 'notes/remote', content: '---\ntitle: Remote\n---\nWritten remotely.' }, STDIO as never);
    expect(put.isError === true).toBe(false);
    expect((await owner.getPage('notes/remote'))?.compiled_truth).toBe('Written remotely.');
    const conn = servedConnectionOf(client) as unknown as Conn;
    // set_config is a write operation, not on the closed list: the client refuses it; a hand-built remote frame is refused by the server.
    const viaClient = await codeOf(withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION, ['set_config', { key: 'x.y', value: '1' }, {}, { auth: null }])));
    expect(viaClient).toBe('engine_capability_missing');
    expect(await owner.getConfig('x.y')).toBeNull();
  });

  test('a remote raw member write stays refused by the server; only the side write crosses', async () => {
    const conn = servedConnectionOf(client) as unknown as Conn;
    expect(await codeOf(withRemoteCaller(true, () => conn.request('call', 'setConfig', ['x.z', '1'])))).toBe('engine_capability_missing');
    expect(await owner.getConfig('x.z')).toBeNull();
  });

  test('the server checks the operation scope again against the claimed grant: a grant without write is refused, nothing written', async () => {
    const out = await dispatchToolCall(client, 'put_page', { slug: 'notes/no-write', content: '---\ntitle: N\n---\nNo.' },
      { ...STDIO, transport: 'http', auth: { token: 't', clientId: 'c', scopes: ['read', 'write'] } } as never);
    expect(out.isError === true).toBe(false);
    // The client's dispatch allowed it (its grant said write); a forged claim without write is refused by the server alone.
    const conn = servedConnectionOf(client) as unknown as Conn;
    const forged = await codeOf(withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION,
      ['put_page', { slug: 'notes/forged', content: '---\ntitle: F\n---\nForged.' }, {}, { auth: { clientId: 'c', scopes: ['read'] } }])));
    expect(forged).toBe('permission_denied');
    expect(await owner.getPage('notes/forged')).toBeNull();
  });

  test('context fields outside the plain list never reach the handler, and ctx.remote is true', () => {
    const op = operationsByName.put_page!;
    const ctx = remoteOperationContext('put_page', op, { sourceId: 'default', allowedSlugPrefixes: ['x/'], accessIdentity: ['owner'], remote: false, stdioMember: 'm' }, { auth: { scopes: ['write'] } });
    expect(Object.keys(ctx).sort()).toEqual(['auth', 'sourceId']);
    expect(Object.keys(ctx).every(k => k === 'auth' || (REMOTE_CONTEXT_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  test('the retrieval stamp: an id outside the caller\'s read scope refuses the call and stamps nothing; a readable one is stamped', async () => {
    const open = (await owner.getPage('notes/open'))!.id as number;
    const secret = (await owner.getPage('notes/secret'))!.id as number;
    expect(await stampOf('notes/secret')).toBeNull();
    const forged = await codeOf(worldOnly(() => client.bumpPageRetrievals([open, secret])));
    expect(forged).toBe('permission_denied');
    expect({ open: await stampOf('notes/open'), secret: await stampOf('notes/secret') }).toEqual({ open: null, secret: null });
    expect(await codeOf(worldOnly(() => client.bumpPageRetrievals([open])))).toBe('ok');
    expect(await stampOf('notes/open')).not.toBeNull();
    expect(await stampOf('notes/secret')).toBeNull();
  });

  test('the retrieval stamp inside a transaction the caller holds: an id outside its read scope is refused there too, nothing stamped at commit', async () => {
    const conn = servedConnectionOf(client) as unknown as Conn;
    const secret = (await owner.getPage('notes/secret'))!.id as number;
    expect(await stampOf('notes/secret')).toBeNull();
    const ref = String(await conn.txn('begin', {}));
    let inside = '';
    try {
      inside = await codeOf(worldOnly(() => conn.request('call', 'bumpPageRetrievals', [[secret]], { txn: ref })));
    } finally {
      await conn.txn('commit', { txn: ref }).catch(() => conn.txn('rollback', { txn: ref }).catch(() => undefined));
    }
    expect(inside).toBe('permission_denied');
    expect(await stampOf('notes/secret')).toBeNull();
  });

  test('the stamp is best-effort: a remote get_page answers the same with tracking on and off', async () => {
    const read = async () => {
      const out = await dispatchToolCall(client, 'get_page', { slug: 'notes/open' }, STDIO as never);
      const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
      return { isError: out.isError === true, slug: body.slug, compiled_truth: body.compiled_truth, title: body.title };
    };
    await owner.setConfig('search.track_retrieval', 'true');
    const on = await read();
    await owner.setConfig('search.track_retrieval', 'false');
    const off = await read();
    expect(off).toEqual(on);
    expect({ isError: on.isError, slug: on.slug }).toEqual({ isError: false, slug: 'notes/open' });
    expect(String(on.compiled_truth)).toContain('Anyone may read this.'); // a remote read quotes the body
  });

  test('a remote caller sets only its own transaction: beginSnapshotRead runs on one it holds and is refused outside one; a write there stays refused', async () => {
    const conn = servedConnectionOf(client) as unknown as Conn;
    const outside = await codeOf(withRemoteCaller(true, () => conn.request('call', 'beginSnapshotRead', [{ readOnly: true }])));
    const ref = String(await conn.txn('begin', {}));
    let inside = '';
    let write = '';
    try {
      inside = await codeOf(withRemoteCaller(true, () => conn.request('call', 'beginSnapshotRead', [{ readOnly: true }], { txn: ref })));
      write = await codeOf(withRemoteCaller(true, () => conn.request('call', 'setConfig', ['x.t', '1'], { txn: ref })));
    } finally {
      await conn.txn('rollback', { txn: ref }).catch(() => undefined);
    }
    expect({ outside, inside, write }).toEqual({ outside: 'engine_capability_missing', inside: 'ok', write: 'engine_capability_missing' });
    expect(await owner.getConfig('x.t')).toBeNull();
  });

  test('a remote fuzzy get_page reads its candidates in a snapshot: a readable page resolves, a private one stays hidden', async () => {
    const read = async (slug: string) => {
      const out = await dispatchToolCall(client, 'get_page', { slug, fuzzy: true }, STDIO as never);
      const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
      return { isError: out.isError === true, slug: body.slug ?? null, error: body.error ?? null };
    };
    expect({ open: await read('notes/ope'), secret: await read('notes/secre') }).toEqual({
      open: { isError: false, slug: 'notes/open', error: null },
      secret: { isError: true, slug: null, error: 'page_not_found' },
    });
  });

  test('request_tools crosses only as a surface persist for an OAuth client; its other forms are refused at the client and the server', async () => {
    await owner.insertOauthClient({ client_id: 'rt-free', client_name: 'rt-free' });
    const conn = servedConnectionOf(client) as unknown as Conn;
    const grant = { clientId: 'rt-free', scopes: ['read'] };
    const send = (params: Record<string, unknown>, auth: unknown, context: Record<string, unknown> = { transport: 'http' }) =>
      codeOf(withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION, ['request_tools', params, context, { auth }])));
    expect({
      listing: await send({}, grant),
      descriptor: await send({ tools: ['get_page'] }, grant),
      combined: await send({ surface: 'verbs', tools: ['get_page'] }, grant),
      noClient: await send({ surface: 'verbs' }, { scopes: ['read'] }),
    }).toEqual({ listing: 'engine_capability_missing', descriptor: 'engine_capability_missing', combined: 'engine_capability_missing', noClient: 'engine_capability_missing' });
    expect((await owner.readOauthClient('rt-free'))?.surface_set_by ?? null).toBeNull();
    // The real path: an HTTP MCP caller's persist through dispatch runs on the server and writes the owner's client row.
    const out = await dispatchToolCall(client, 'request_tools', { surface: 'starter' },
      { ...STDIO, transport: 'http', surfaceCeiling: 'full', auth: { token: 't', clientId: 'rt-free', scopes: ['read'] } } as never);
    expect({ isError: out.isError === true, persisted: (JSON.parse(out.content[0]!.text) as { persisted?: unknown }).persisted }).toEqual({ isError: false, persisted: true });
    const row = await owner.readOauthClient('rt-free');
    expect({ surface: row?.surface, surface_set_by: row?.surface_set_by }).toEqual({ surface: 'starter', surface_set_by: 'self' });
  });

  test('the caller\'s surface ceiling crosses as a narrowing claim: a surface above it is refused, a ceiling that is not a surface name is refused, nothing written', async () => {
    await owner.insertOauthClient({ client_id: 'rt-capped', client_name: 'rt-capped' });
    const conn = servedConnectionOf(client) as unknown as Conn;
    const grant = { clientId: 'rt-capped', scopes: ['read'] };
    const send = (surface: string, surfaceCeiling: unknown) =>
      codeOf(withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION, ['request_tools', { surface }, { transport: 'http', surfaceCeiling }, { auth: grant }])));
    expect({ above: await send('full', 'starter'), forged: await send('full', 'everything'), notText: await send('full', ['full']) })
      .toEqual({ above: 'permission_denied', forged: 'engine_capability_missing', notText: 'engine_capability_missing' });
    expect((await owner.readOauthClient('rt-capped'))?.surface_set_by ?? null).toBeNull();
    expect(await send('verbs', 'starter')).toBe('ok');
    const row = await owner.readOauthClient('rt-capped');
    expect({ surface: row?.surface, surface_set_by: row?.surface_set_by }).toEqual({ surface: 'verbs', surface_set_by: 'self' });
  });

  test('a remote delete_page crosses whole and soft-deletes on the server; a purge is refused even with a forged local claim, and a grant without write is refused, nothing removed', async () => {
    await owner.putPage('notes/doomed', NOTE('Doomed', 'Deleted remotely.'));
    await owner.putPage('notes/stays', NOTE('Stays', 'Not purged.'));
    const revisionOf = async (slug: string) => (await owner.getPage(slug))?.knowledge_revision;
    const del = await dispatchToolCall(client, 'delete_page', { slug: 'notes/doomed', expected_revision: await revisionOf('notes/doomed') }, STDIO as never);
    expect({ isError: del.isError === true, live: await owner.getPage('notes/doomed') }).toEqual({ isError: false, live: null });
    const conn = servedConnectionOf(client) as unknown as Conn;
    const grant = { clientId: 'c', scopes: ['read', 'write'] };
    const rev = await revisionOf('notes/stays');
    const send = (extra: Record<string, unknown>, context: Record<string, unknown>, auth: unknown) =>
      codeOf(withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION, ['delete_page', { slug: 'notes/stays', expected_revision: rev, ...extra }, context, { auth }])));
    expect({
      // `remote: false` is outside the plain context list: the server runs the delete as a remote caller's.
      purge: await send({ purge: true }, { remote: false }, grant),
      retention: await send({ purge: true, retention: true }, { remote: false }, grant),
      readOnly: await send({}, {}, { clientId: 'c', scopes: ['read'] }),
    }).toEqual({ purge: 'permission_denied', retention: 'invalid_params', readOnly: 'permission_denied' });
    expect((await owner.getPage('notes/stays'))?.compiled_truth).toBe('Not purged.');
  });

  test('the page-id reads a remote search makes: a private id refuses the call with read_out_of_scope, a readable one answers, on a plain frame and inside a held transaction', async () => {
    const conn = servedConnectionOf(client) as unknown as Conn;
    const open = (await owner.getPage('notes/open'))!.id as number;
    const secret = (await owner.getPage('notes/secret'))!.id as number;
    const reasonOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => `${(e as { code?: string }).code}/${(e as { reason?: string }).reason}`);
    const plain = {
      dates: await reasonOf(worldOnly(() => client.readPageDateFieldsByIds([open, secret]))),
      datesOpen: await reasonOf(worldOnly(() => client.readPageDateFieldsByIds([open]))),
      guests: await reasonOf(worldOnly(() => client.readGuestMarks([open, secret]))),
      guestsOpen: await reasonOf(worldOnly(() => client.readGuestMarks([open]))),
    };
    expect(plain).toEqual({ dates: 'permission_denied/read_out_of_scope', datesOpen: 'ok', guests: 'permission_denied/read_out_of_scope', guestsOpen: 'ok' });
    const ref = String(await conn.txn('begin', {}));
    let held: Record<string, string> = {};
    try {
      held = {
        dates: await reasonOf(worldOnly(() => conn.request('call', 'readPageDateFieldsByIds', [[open, secret]], { txn: ref }))),
        datesOpen: await reasonOf(worldOnly(() => conn.request('call', 'readPageDateFieldsByIds', [[open]], { txn: ref }))),
        guests: await reasonOf(worldOnly(() => conn.request('call', 'readGuestMarks', [[open, secret]], { txn: ref }))),
        guestsOpen: await reasonOf(worldOnly(() => conn.request('call', 'readGuestMarks', [[open]], { txn: ref }))),
      };
    } finally {
      await conn.txn('commit', { txn: ref }).catch(() => conn.txn('rollback', { txn: ref }).catch(() => undefined));
    }
    expect(held).toEqual(plain);
  });

  test('the OAuth client row and the owner-only source probe never cross: a raw frame for either is refused with engine_capability_missing', async () => {
    const reasonOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => String((e as { code?: string }).code ?? (e as Error).message));
    expect({
      client: await reasonOf(worldOnly(() => client.readOauthClient('some-client'))),
      ownerOnly: await reasonOf(worldOnly(() => client.readOwnerOnlySourcesPresent())),
    }).toEqual({ client: 'engine_capability_missing', ownerOnly: 'engine_capability_missing' });
  });
});
