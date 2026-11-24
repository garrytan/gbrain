/**
 * Engine parity for the credential grant reads a remote write runs: the OAuth client grant authorizeWrite re-checks, and
 * the scope-source check a legacy token minted with a source grant runs before it is inserted.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an MCP put_page over http owned by a live OAuth client commits (on Rust it stops on raw_sql at admission
 *    until the mention-links worker is typed); a deleted client's write refuses permission_denied. A legacy token
 *    minted with a grant to a named source is inserted and reads that source's page over http; a grant that names a
 *    marked scope source (`config.qm_scope`) refuses invalid_grant and inserts no token. A legacy token's write grant
 *    reads its live scopes and grant axes, and a revoked token reads revoked. An OAuth
 *    client's slug fence reads its stored bound prefixes, null for a client that is gone.
 *  - Regression: on the Rust engine readOAuthClientWriteGrant answered null for every client, so a live client's write
 *    refused "The owning OAuth client is revoked"; assertScopeSourceGrant read the sources through raw SQL
 *    (`... FOR SHARE`), so a source-granted mint refused raw_sql. readWriterSlugFence refused every OAuth client on Rust,
 *    so the links effect of an http write never settled. readAccessTokenWriteGrant answered null for every token on Rust,
 *    so a live legacy token's write refused "The owning token is revoked".
 *  - Why existing coverage misses it: persistence-declaration.test.ts pins only a client and token with no live grant
 *    row; access-tokens.test.ts mints only default-grant tokens. Over MCP a refusal comes back inside the tool result,
 *    so the remote cases go through dispatchToolCall.
 *  - Seam: none. Real engines, the MCP dispatcher, the token mint.
 */
import { describe } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { grantFromTokenRow } from '../../src/core/grants/model.ts';
import { normalizeTokenScopes } from '../../src/core/legacy-token-scope.ts';
import type { AccessTokenWriteGrant } from '../../src/core/engine-sql/persistence-journal.ts';

const { parityTest } = parityArms(testBackends());

const SOURCE = 'notes';
const SLUG = 'notes/credential-grant';
const CONTENT = '---\ntitle: Credential grant\n---\n\nA page written over http.\n';

// readsUnscoped and createdAt as the http verifier sets them, so requester-scope.ts credentialScopeFor reads nothing.
type Auth = { token: string; clientId: string; principal: { kind: 'oauth_client' | 'legacy_token'; id: string }; sourceId: string; allowedSources: string[]; scopes: string[];
  readsUnscoped: false; createdAt: null };

/** One MCP call over http. A refusal is in the tool result: its code, or the tool's answer on success. */
async function http(engine: BrainEngine, tool: string, params: Record<string, unknown>, auth: Auth): Promise<Record<string, unknown>> {
  const result = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', sourceId: auth.sourceId,
    admissionOrigin: 'interactive', takesHoldersAllowList: ['world'], auth } as never);
  const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  if (result.isError === true) {
    const code = String(body.code ?? body.error);
    if (code === 'engine_capability_missing') throw body;
    return { ok: false, code };
  }
  return { ok: true, body };
}

async function oauthClient(engine: BrainEngine, id: string, deleted: boolean): Promise<Auth> {
  await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read write', source_id: SOURCE,
    ...(deleted ? { deleted_at: new Date('2026-01-01T00:00:00Z') } : {}) } as never);
  return { token: '', clientId: id, principal: { kind: 'oauth_client', id }, sourceId: SOURCE, allowedSources: [SOURCE], scopes: ['read', 'write'], readsUnscoped: false, createdAt: null };
}

async function pageWritten(engine: BrainEngine): Promise<boolean> {
  return (await engine.getPage(SLUG, { sourceId: SOURCE })) !== null;
}

describe('credential grant reads of a remote write', () => {
  parityTest('an MCP put_page over http owned by a live OAuth client commits', {
    methods: ['readOAuthClientWriteGrant'],
    // Held: a remote put_page queues a mention-links effect, and the links worker still reads through raw SQL, so its
    // admission refuses raw_sql by name on Rust (persistence/journal.ts admitWrite). Remove this line when the links
    // worker is typed; the case then compares on Rust.
    requires: 'raw_sql',
  }, async (engine, backend) => {
    await createSource(engine, backend, SOURCE);
    const put = await http(engine, 'put_page', { slug: SLUG, content: CONTENT }, await oauthClient(engine, 'client-writer', false));
    return { put: { ok: put.ok, status: (put.body as Record<string, unknown> | undefined)?.status ?? null }, page: await pageWritten(engine) };
  });

  parityTest('an MCP put_page over http owned by a deleted OAuth client refuses permission_denied', { methods: ['readOAuthClientWriteGrant'] }, async (engine, backend) => {
    await createSource(engine, backend, SOURCE);
    const put = await http(engine, 'put_page', { slug: SLUG, content: CONTENT }, await oauthClient(engine, 'client-gone', true));
    return { put, page: await pageWritten(engine) };
  });

  parityTest('an OAuth client slug fence reads its bound prefixes, and null when the client is gone', { methods: ['readWriterSlugFence', 'insertOauthClient'] }, async (engine, backend) => {
    await createSource(engine, backend, SOURCE);
    await engine.insertOauthClient({ client_id: 'client-fenced', client_name: 'client-fenced', scope: 'read write', source_id: SOURCE,
      bound_slug_prefixes: ['notes/'], delegated_slug_prefixes: ['notes/shared/'] } as never);
    const principal = (id: string) => ({ kind: 'oauth_client', id });
    return { bound: await engine.readWriterSlugFence(principal('client-fenced')),
      gone: await engine.readWriterSlugFence(principal('client-missing')) };
  });

  parityTest('a legacy token minted with a grant to a named source reads that source over http', { methods: ['insertAccessToken'] }, async (engine, backend) => {
    await createSource(engine, backend, SOURCE);
    await engine.putPage(SLUG, { type: 'note', title: 'Credential grant', compiled_truth: 'A page in the granted source.' }, { sourceId: SOURCE });
    const minted = await mintLegacyToken(engine, { name: 'source-granted', scopes: ['read'], sourceGrant: [SOURCE], takesHolders: ['world'] });
    const auth: Auth = { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: SOURCE, allowedSources: [SOURCE], scopes: ['read'], readsUnscoped: false, createdAt: null };
    const read = await http(engine, 'get_page', { slug: SLUG }, auth);
    return { read: { ok: read.ok, title: (read.body as Record<string, unknown> | undefined)?.title ?? null },
      live: (await engine.findActiveAccessTokens('source-granted')).length };
  });

  parityTest('a legacy token write grant reads the live grant, and a revoked token reads revoked', { methods: ['readAccessTokenWriteGrant', 'insertAccessToken'] }, async (engine, backend) => {
    await createSource(engine, backend, SOURCE);
    const live = await mintLegacyToken(engine, { name: 'token-writer', scopes: ['read', 'write'], sourceGrant: [SOURCE], takesHolders: ['world'] });
    const revoked = await engine.insertAccessToken({ name: 'token-revoked', token_hash: 'hash-revoked', scopes: ['read', 'write'], permissions: {},
      source_grant: 'scalar', source_id: SOURCE, federated_read: null, allowed_operations: null, takes_holders: ['world'], revoked_at: new Date('2026-01-01T00:00:00Z') });
    // What authorizeWrite reads from the row (persistence/authority.ts): the revocation, the scopes and the grant axes.
    const grant = (row: AccessTokenWriteGrant | null) => {
      if (!row) return null;
      const g = grantFromTokenRow(row);
      return { revoked: row.revoked_at != null, scopes: normalizeTokenScopes(row.scopes) ?? null, operations: g.allowedOperations ?? null,
        sources: g.sources, malformed: g.permissionsMalformed, revision: Number(row.grant_revision ?? 0) };
    };
    return { live: grant(await engine.readAccessTokenWriteGrant(live.id)), locked: grant(await engine.readAccessTokenWriteGrant(live.id, { lock: true })),
      revoked: grant(await engine.readAccessTokenWriteGrant(revoked.id)), missing: await engine.readAccessTokenWriteGrant('00000000-0000-4000-8000-000000000000') };
  });

  parityTest('a token grant that names a marked scope source refuses invalid_grant and inserts no token', { methods: ['readScopeSourceConfigs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'scope-a', { qm_scope: true });
    const refusal = await mintLegacyToken(engine, { name: 'scope-reader', scopes: ['read'], sourceGrant: ['scope-a'], takesHolders: ['world'] })
      .then(() => null, (e: unknown) => e as { code?: unknown; name?: unknown });
    if (refusal && (refusal as { code?: unknown }).code === 'engine_capability_missing') throw refusal;
    return { refused: refusal !== null, code: refusal?.code ?? null, live: (await engine.findActiveAccessTokens('scope-reader')).length };
  });
});
