/**
 * BrainEngine parity: remote writes of a principal other than the brain owner (a plain member's credential), through the
 * MCP dispatch a bound credential drives. On the served arm (GBRAIN_TEST_RUST_SERVED=1, both multi-user routes) each write
 * crosses as one whole operation that the brain server runs (rust-engine/served/remote-whole-ops.ts), under the grant the
 * client claims for that principal.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a plain member's put_page writes a new page that names it as a reader and rewrites a page whose readers name
 *    it; its put_page over a page whose readers leave it out, over the owner's private page, or into a source its grant
 *    does not name is refused and changes nothing. request_tools persists the surface of the caller's own OAuth client only:
 *    a persist that names another client is refused (permission_denied) for an OAuth client, answers "no client surface"
 *    for a legacy token, and leaves the other client's row as it was. The same answers on every arm.
 *  - Regression: request_tools persisted the surface of whatever client id the grant carried, so a grant whose principal
 *    is one OAuth client (or a legacy token whose name is an OAuth client id) set another client's surface and pin.
 *  - Why existing coverage misses it: owner-write-privacy covers the owner's own key (and one plain-member rewrite);
 *    request-tools-persist calls the handler with a grant whose client id is its own.
 *  - Seam: none. Real members and owner, the token mint, the real bearer check for the legacy token, dispatchToolCall.
 *    The OAuth client grant is the one the http verifier builds for a client with no member join (caller.ts then looks
 *    the binding up from the principal). Not parityTest: on Rust a non-owner member's call reaches a labelled-only read
 *    the dispatch swallows (row 32e-b), and the harness fails a case that caught a refusal; the answers must still be
 *    equal on every arm.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { servedOwnerOf } from './rust-arm.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetRequestToolsPersistLimiterForTests } from '../../src/core/operations.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { arms } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const NOTE = (frontmatter: Record<string, unknown>) => ({ type: 'note' as const, title: 'Note', compiled_truth: 'First.', timeline: '', frontmatter });

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await createSource(engine, backend, 'elsewhere');
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  await addMember(engine, MEMBER);
  await engine.putPage('notes/bob-shared', NOTE({ readable_by: [MEMBER] }), { sourceId: SRC });
  await engine.putPage('notes/alice-only', NOTE({ visibility: 'private', readable_by: [OWNER] }), { sourceId: SRC });
  await engine.putPage('notes/diary', NOTE({ visibility: 'private' }), { sourceId: SRC });
  await engine.putPage('notes/other-source', NOTE({}), { sourceId: 'elsewhere' });
}

/** The member's legacy token, bound to it and verified through the real bearer check. */
async function memberToken(engine: BrainEngine, name: string): Promise<AuthInfo> {
  const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: MEMBER });
  return await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
}

/** An OAuth client bound to `member`, and the grant the http verifier builds for it. */
async function memberClient(engine: BrainEngine, id: string, member: string): Promise<AuthInfo> {
  await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read write', source_id: SRC } as never);
  await bindCredential(engine, { kind: 'client', id }, { member });
  return { token: '', clientId: id, principal: { kind: 'oauth_client', id }, sourceId: SRC, allowedSources: [SRC], scopes: ['read', 'write'], readsUnscoped: false, createdAt: null } as AuthInfo;
}

/** One MCP call over http: the tool's answer, or the code it was refused with. */
async function call(engine: BrainEngine, tool: string, params: Record<string, unknown>, auth: AuthInfo): Promise<{ ok: boolean; code?: string; body?: Record<string, unknown> }> {
  const out = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], surfaceCeiling: 'full' } as never)
    .catch((e: { code?: string }) => ({ isError: true, content: [{ text: JSON.stringify({ code: e.code ?? 'thrown' }) }] }));
  const body = JSON.parse(out.content.map(c => c.text).join('')) as Record<string, unknown>;
  return out.isError === true ? { ok: false, code: String(body.code ?? body.error) } : { ok: true, body };
}

async function put(engine: BrainEngine, auth: AuthInfo, slug: string, content: string): Promise<string> {
  const page = await engine.getPage(slug, { sourceId: SRC });
  const out = await call(engine, 'put_page', { slug, content, ...(page ? { expected_revision: page.knowledge_revision } : {}) }, auth);
  return out.ok ? 'written' : out.code!;
}

const bodyOf = async (engine: BrainEngine, slug: string, sourceId = SRC) => (await engine.getPage(slug, { sourceId }))?.compiled_truth ?? null;

test('on the served arm the Rust engine is a served client of an owner whose store runs multi-user', async () => {
  const served = process.env.GBRAIN_TEST_RUST_SERVED === '1';
  for (const arm of arms()) {
    if (arm.backend !== 'rust') continue;
    await resetArm(arm);
    const owner = servedOwnerOf(arm.engine) as { openStore(member: string): { multiuser?: unknown } } | undefined;
    expect({ served: (arm.engine as unknown as { capabilities: Set<string> }).capabilities.has('served'), owner: owner !== undefined })
      .toEqual({ served, owner: served });
    if (owner) expect(owner.openStore('nonowner-remote-writes').multiuser).toBe(true);
  }
  expect(arms().length).toBeGreaterThan(0);
});

test('a plain member\'s remote put_page writes where its readers reach and is refused elsewhere, alike on every arm', async () => {
  const seen: unknown[] = [];
  const want: unknown[] = [];
  for (const arm of arms()) {
    await resetArm(arm);
    const { engine, backend } = arm;
    await seed(engine, backend);
    const auth = await memberToken(engine, 'bob-key');
    const result = {
      backend,
      fresh: await put(engine, auth, 'notes/bob-new', `---\ntitle: New\nreadable_by: [${MEMBER}]\n---\nSecond.`),
      shared: await put(engine, auth, 'notes/bob-shared', `---\ntitle: Note\nreadable_by: [${MEMBER}]\n---\nSecond.`),
      ownerOnly: (await put(engine, auth, 'notes/alice-only', '---\ntitle: Note\n---\nTaken.')) === 'written' ? 'written' : 'refused',
      diary: (await put(engine, auth, 'notes/diary', '---\ntitle: Note\n---\nTaken.')) === 'written' ? 'written' : 'refused',
    };
    seen.push(result);
    want.push({ backend, fresh: 'written', shared: 'written', ownerOnly: 'refused', diary: 'refused' });
    seen.push({
      backend,
      fresh: await bodyOf(engine, 'notes/bob-new'),
      freshReaders: (await engine.getPage('notes/bob-new', { sourceId: SRC }))?.frontmatter.readable_by ?? null,
      shared: await bodyOf(engine, 'notes/bob-shared'),
      ownerOnly: await bodyOf(engine, 'notes/alice-only'),
      diary: await bodyOf(engine, 'notes/diary'),
    });
    want.push({ backend, fresh: 'Second.', freshReaders: [MEMBER], shared: 'Second.', ownerOnly: 'First.', diary: 'First.' });
  }
  expect(seen).toEqual(want);
  expect(arms().length).toBeGreaterThan(0);
}, 240_000);

test('a plain member\'s remote put_page into a source its grant does not name is refused and writes nothing, alike on every arm', async () => {
  const seen: unknown[] = [];
  const want: unknown[] = [];
  for (const arm of arms()) {
    await resetArm(arm);
    const { engine, backend } = arm;
    await seed(engine, backend);
    const auth = await memberToken(engine, 'bob-key');
    const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/other-source', content: '---\ntitle: Note\n---\nTaken.' },
      { remote: true, transport: 'http', auth, sourceId: 'elsewhere', takesHoldersAllowList: ['world'] } as never);
    seen.push({ backend, refused: out.isError === true, body: await bodyOf(engine, 'notes/other-source', 'elsewhere') });
    want.push({ backend, refused: true, body: 'First.' });
  }
  expect(seen).toEqual(want);
  expect(arms().length).toBeGreaterThan(0);
}, 240_000);

test('request_tools persists only the caller\'s own OAuth client: a persist naming another client is refused and leaves it as it was, alike on every arm', async () => {
  const seen: unknown[] = [];
  const want: unknown[] = [];
  for (const arm of arms()) {
    await resetArm(arm);
    __resetRequestToolsPersistLimiterForTests();
    const { engine, backend } = arm;
    await seed(engine, backend);
    const own = await memberClient(engine, 'bob-client', MEMBER);
    await memberClient(engine, 'alice-client', OWNER);
    const token = await memberToken(engine, 'alice-client-name');
    const pin = async (id: string) => { const row = await engine.readOauthClient(id); return { surface: row?.surface ?? null, by: row?.surface_set_by ?? null }; };
    const mine = await call(engine, 'request_tools', { surface: 'starter' }, own);
    const other = await call(engine, 'request_tools', { surface: 'verbs' }, { ...own, clientId: 'alice-client' } as AuthInfo);
    // A legacy token whose name is an OAuth client id: its grant's client id is that name.
    const legacy = await call(engine, 'request_tools', { surface: 'verbs' }, { ...token, clientId: 'alice-client' } as AuthInfo);
    seen.push({
      backend,
      mine: mine.ok ? mine.body?.persisted : mine.code,
      other: other.ok ? other.body?.persisted : other.code,
      legacy: legacy.ok ? legacy.body?.persisted : legacy.code,
      bob: await pin('bob-client'),
      alice: await pin('alice-client'),
    });
    want.push({ backend, mine: true, other: 'permission_denied', legacy: false, bob: { surface: 'starter', by: 'self' }, alice: { surface: null, by: null } });
  }
  expect(seen).toEqual(want);
  expect(arms().length).toBeGreaterThan(0);
}, 240_000);
