/**
 * Remote writes a served client sends for a principal that is not the brain owner (multi-user lane L3, ruling A1 follow-up,
 * docs/designs/rust-engine/multi-user-server.md "Follow-up (A1)"): an owner-floor client (an HTTP MCP server of the owner)
 * claims, for each remote whole operation, the grant and the access record of the member credential it serves. The brain
 * server checks that claim against the store before anything runs (served/remote-claim.ts), and its write path re-reads
 * the stored grant again.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served`.
 *
 * 1. Protects (hostile client, raw frames through the client):
 *    - the honest claim a member's credential makes (through dispatch) writes inside its grant;
 *    - a frame with no access record runs under the narrowest view and writes a page every member may read;
 *    - a claim that pairs a member's credential with the owner's access record, a wider identity, or relaxed privacy is
 *      refused (access_mismatch) and writes nothing;
 *    - a claim of a member binding other than the stored one is refused (member_mismatch);
 *    - a claim of a scope the stored grant does not hold is refused (scope_widened);
 *    - a claim of an OAuth client id other than its own credential is refused (client_mismatch), and request_tools never
 *      sets another client's surface;
 *    - a claim for a deleted OAuth client or a revoked token is refused (credential_revoked), nothing written.
 *    The served parity file test/engine-parity/nonowner-remote-writes.test.ts holds the honest answers on both routes.
 * 2. Fails on: a server that runs a member credential's claim without reading its stored grant, binding and record, or
 *    persists request_tools for a client id the credential is not.
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
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import { withCallerAccess, type CallerAccess } from '../src/core/search/private-visibility.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const TOKEN = 'nonowner-claims-owner-token';
const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const NOTE = (body: string, frontmatter: Record<string, unknown>) => ({ type: 'note', title: 'Note', compiled_truth: body, timeline: '', frontmatter }) as never;
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;
let tokenId = '';

type Conn = { request(kind: 'fn', member: string, args: unknown[]): Promise<unknown> };
/** `ok`, or the refusal's code and reason (`permission_denied:access_mismatch`). */
const outcomeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; reason?: string; message?: string }) =>
  `${e.code ?? e.message}${e.reason ? `:${e.reason}` : ''}`);
const bobClient = (over: Partial<AuthInfo> = {}) => ({ clientId: 'bob-client', principal: { kind: 'oauth_client', id: 'bob-client' }, scopes: ['read', 'write'], sourceId: 'default', ...over });
/** The record the store gives bob's client, as an honest client's dispatch builds it. */
const bobRecord = async () => await remoteCallerAccess(owner as unknown as BrainEngine, { token: '', clientId: 'bob-client', scopes: ['read', 'write'], principal: { kind: 'oauth_client', id: 'bob-client' } } as never,
  undefined, 'http', null, undefined, false) as CallerAccess;
const send = (name: string, params: Record<string, unknown>, auth: unknown, record: Partial<CallerAccess> | null) => {
  const conn = servedConnectionOf(client) as unknown as Conn;
  const frame = () => conn.request('fn', OWNER_RUN_OPERATION, [name, params, { transport: 'http', sourceId: 'default', surfaceCeiling: 'full' }, { auth }]);
  return outcomeOf(withRemoteCaller(true, () => record ? withCallerAccess(record, frame) : frame()));
};
const bodyOf = async (slug: string) => (await owner.getPage(slug))?.compiled_truth ?? null;
/** put_page parameters for `slug` (with its current revision when it exists); `readers` [] leaves readable_by out. */
const put = async (slug: string, body: string, readers: string[] = [MEMBER]) => {
  const page = await owner.getPage(slug);
  return { slug, content: `---\ntitle: Note\n${readers.length ? `readable_by: [${readers.join(', ')}]\n` : ''}---\n${body}`, ...(page ? { expected_revision: page.knowledge_revision } : {}) };
};
const pin = async (id: string) => { const row = await owner.readOauthClient(id); return row ? { surface: row.surface ?? null, by: row.surface_set_by ?? null } : null; };

describeAddon('remote writes a served client claims for a member credential', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-nonowner-claims-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, t) => { if (t !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    const e = owner as unknown as BrainEngine;
    await addMember(e, OWNER);
    await setOwner(e, OWNER);
    await addMember(e, MEMBER);
    for (const [id, member] of [['bob-client', MEMBER], ['bob-reader', MEMBER], ['alice-client', OWNER], ['bob-gone', MEMBER]] as const) {
      await owner.insertOauthClient({ client_id: id, client_name: id, scope: id === 'bob-reader' ? 'read' : 'read write', source_id: 'default' } as never);
      await bindCredential(e, { kind: 'client', id }, { member });
    }
    const minted = await mintLegacyToken(e, { name: 'bob-key', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
    await bindCredential(e, { kind: 'token', id: minted.id }, { member: MEMBER });
    tokenId = minted.id;
    await owner.putPage('notes/bob-shared', NOTE('First.', { readable_by: [MEMBER] }));
    await owner.putPage('notes/diary', NOTE('First.', { visibility: 'private' }));
    await owner.putPage('notes/alice-only', NOTE('First.', { readable_by: [OWNER] }));
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

  test('the owner runs multi-user and the client is a served client', () => {
    expect({ multiuser: owner.openStore('nonowner-claims').multiuser, served: client.capabilities.has('served') }).toEqual({ multiuser: true, served: true });
  });

  test('the honest claim of a member credential writes inside its grant; a frame with no record writes a page every member may read', async () => {
    const out = await dispatchToolCall(client, 'put_page', await put('notes/bob-shared', 'Second.'),
      { remote: true, transport: 'http', sourceId: 'default', takesHoldersAllowList: ['world'], auth: { token: '', ...bobClient() } } as never);
    expect({ isError: out.isError === true, body: await bodyOf('notes/bob-shared') }).toEqual({ isError: false, body: 'Second.' });
    expect(await send('put_page', await put('notes/bob-new', 'Fresh.', []), bobClient(), null)).toBe('ok');
    expect(await send('put_page', await put('notes/bob-honest', 'Honest.'), bobClient(), await bobRecord())).toBe('ok');
    expect({ fresh: await bodyOf('notes/bob-new'), honest: await bodyOf('notes/bob-honest') }).toEqual({ fresh: 'Fresh.', honest: 'Honest.' });
  });

  test('a member credential claimed with the owner\'s record, a wider identity or relaxed privacy is refused and writes nothing', async () => {
    const honest = await bobRecord();
    const asOwner = { ...honest, identity: [`member:${OWNER}`], owner: true, ownerReads: true, hidePrivate: false };
    const wider = { ...honest, identity: [...honest.identity, `member:${OWNER}`] };
    const relaxed = { ...honest, hidePrivate: false };
    expect({
      asOwner: await send('put_page', await put('notes/diary', 'Taken.', [OWNER]), bobClient(), asOwner),
      wider: await send('put_page', await put('notes/alice-only', 'Taken.', [OWNER]), bobClient(), wider),
      relaxed: await send('put_page', await put('notes/diary', 'Taken.'), bobClient(), relaxed),
      // A new page every member may read: the write path alone takes it, so only the claim check refuses it.
      planted: await send('put_page', await put('notes/planted', 'Planted.', []), bobClient(), asOwner),
    }).toEqual({ asOwner: 'permission_denied:access_mismatch', wider: 'permission_denied:access_mismatch', relaxed: 'permission_denied:access_mismatch', planted: 'permission_denied:access_mismatch' });
    expect({ diary: await bodyOf('notes/diary'), alice: await bodyOf('notes/alice-only'), planted: await bodyOf('notes/planted') })
      .toEqual({ diary: 'First.', alice: 'First.', planted: null });
  });

  test('a claimed member binding other than the stored one, or a scope the stored grant lacks, is refused and writes nothing', async () => {
    expect({
      member: await send('put_page', await put('notes/claimed-member', 'Taken.', []), bobClient({ member: { id: OWNER, groups: [] } }), null),
      scope: await send('put_page', await put('notes/claimed-scope', 'Taken.', []), { ...bobClient(), clientId: 'bob-reader', principal: { kind: 'oauth_client', id: 'bob-reader' } }, null),
      admin: await send('put_page', await put('notes/claimed-admin', 'Taken.', []), bobClient({ scopes: ['read', 'write', 'admin'] }), null),
    }).toEqual({ member: 'permission_denied:member_mismatch', scope: 'permission_denied:scope_widened', admin: 'permission_denied:scope_widened' });
    expect({ member: await bodyOf('notes/claimed-member'), scope: await bodyOf('notes/claimed-scope'), admin: await bodyOf('notes/claimed-admin') })
      .toEqual({ member: null, scope: null, admin: null });
  });

  test('a claim of another OAuth client id is refused, and request_tools never sets another client\'s surface', async () => {
    expect({
      put: await send('put_page', await put('notes/other-client', 'Taken.', []), bobClient({ clientId: 'alice-client' }), null),
      persist: await send('request_tools', { surface: 'verbs' }, bobClient({ clientId: 'alice-client' }), null),
      own: await send('request_tools', { surface: 'starter' }, bobClient(), null),
    }).toEqual({ put: 'permission_denied:client_mismatch', persist: 'permission_denied:client_mismatch', own: 'ok' });
    expect({ alice: await pin('alice-client'), bob: await pin('bob-client'), page: await bodyOf('notes/other-client') })
      .toEqual({ alice: { surface: null, by: null }, bob: { surface: 'starter', by: 'self' }, page: null });
  });

  test('a claim for a deleted OAuth client or a revoked token is refused, nothing written', async () => {
    await owner.deleteOAuthClient('bob-gone');
    await owner.revokeAccessToken(tokenId);
    const token = { clientId: 'bob-key', principal: { kind: 'legacy_token', id: tokenId }, scopes: ['read', 'write'], sourceId: 'default' };
    const gone = bobClient({ clientId: 'bob-gone', principal: { kind: 'oauth_client', id: 'bob-gone' } });
    expect({
      deleted: await send('put_page', await put('notes/by-deleted', 'Taken.', []), gone, null),
      persist: await send('request_tools', { surface: 'verbs' }, gone, null),
      revoked: await send('put_page', await put('notes/by-revoked', 'Taken.', []), token, null),
    }).toEqual({ deleted: 'permission_denied:credential_revoked', persist: 'permission_denied:credential_revoked', revoked: 'permission_denied:credential_revoked' });
    expect({ deleted: await bodyOf('notes/by-deleted'), revoked: await bodyOf('notes/by-revoked') }).toEqual({ deleted: null, revoked: null });
    expect((await owner.readOauthClient('bob-gone'))?.surface_set_by ?? null).toBeNull();
  });
});
