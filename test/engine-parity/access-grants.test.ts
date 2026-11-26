/**
 * BrainEngine parity — the access-grant reads (engine-sql/access-grants.ts) the receipt operations
 * (ops/persistence.ts), shared-skill membership (shared-skills/membership-authority.ts) and proactive caches
 * (eligibility/generation.ts) run, and the request-id lookup of the host operator's receipt read
 * (readWriteRequestsByRequestId).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a receipt grant read returns the OAuth client or access token row whether deleted/revoked or not (the
 *    caller refuses one that is); a membership grant read returns no row for a deleted client or a revoked token, and
 *    the local writer's row with its revoked_at; the serving epoch is a stable UUID, null without its row; the trust
 *    generation is decimal text that moves with a trust change, null without its row; the request-id lookup returns
 *    at most two rows across principals, so the trusted local CLI reads a receipt another principal owns only when one
 *    row has the id. Every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) gives the same answers; the four OAuth client and access token reads run on the
 *    Rust store's client and token rows, seeded through the typed inserts, and the cases that set state up through
 *    raw SQL (a revoked writer, a missing singleton row) stop on raw SQL's refusal there.
 *  - Regression: these reads ran through executeRaw, so on a Rust brain get_write_request from the local CLI ended in
 *    engine_capability_missing at the request-id lookup, and leave_brain and sync_brain_skills ended at the local
 *    writer read, where PGLite answers not_found and membership_not_found. Each filter is an access cut: a case puts
 *    the row a dropped clause would let through (a deleted client, a revoked token, a revoked writer, a third row
 *    under a shared request id) where the result shows it.
 *  - Why existing coverage misses it: writer-registration.test.ts and write-request-reads.test.ts run the receipt
 *    operations for a remote caller, which never reaches the host operator's lookup; no parity case ran membership.
 *  - Seam: GBRAIN_HOME through withEnv (the registration files live under it). Generated values (ids, timestamps,
 *    generations) are reduced to their shape in the returned values.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { LocalGrant } from '../../src/core/engine-sql/persistence-state.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { persistenceOperations } from '../../src/core/ops/persistence.ts';
import { brainMembershipOperations } from '../../src/core/ops/brain-membership.ts';
import { readTrustGeneration } from '../../src/core/eligibility/generation.ts';
import { rethrowByDesignStop } from '../helpers/rust-by-design-stop.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITER = 'a0000000-0000-4000-8000-0000000000a7';
const GRANT: LocalGrant = { scopes: ['read', 'write'], sourceIds: ['default'], operations: ['put_page'], slugPrefixes: null };
const SHARED = 'b0000000-0000-4000-8000-0000000000e1';
const SINGLE = 'b0000000-0000-4000-8000-0000000000e2';
const UNKNOWN = 'b0000000-0000-4000-8000-0000000000e3';
const MISSING_TOKEN = 'c0000000-0000-4000-8000-0000000000e9';

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-access-grants-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function local(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

/** The handler's answer, or the code it refused with. */
async function answer(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<unknown> {
  const op = [...persistenceOperations, ...brainMembershipOperations].find(o => o.name === name)!;
  try { return { ok: await op.handler(local(engine), params) }; }
  catch (error) { return { code: (error as { code?: string }).code ?? String(error) }; }
}

/**
 * Fixture: the arm reset empties the trust_policy_state and shared_skill_state singletons a brain gets at schema
 * install; put them back as install does (harness-only SQL behind the backend switch, as createSource). The Rust
 * store has no such tables.
 */
async function installSingletons(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  if (backend === 'rust') return;
  await engine.executeRaw('INSERT INTO trust_policy_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await engine.executeRaw('INSERT INTO shared_skill_state(singleton) VALUES(1) ON CONFLICT DO NOTHING');
}

/** Admits one queued request under an OAuth client principal (a principal the host operator may read across). */
async function admit(engine: BrainEngine, principalId: string, requestId: string, slug: string): Promise<void> {
  const source = await engine.readSourceMembership('default');
  const keys = [`principal:oauth_client:${principalId}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  await engine.insertWriteRequest({
    principalKind: 'oauth_client', principalId, requestId, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
    pageId: null, slug, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'put_page', slug },
    authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1,
    admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
}

/**
 * Inserts a live and a deleted OAuth client, and a live and a revoked access token, through the typed inserts
 * `gbrain auth register-client` and `gbrain auth create` use; returns the token ids.
 */
async function seedGrants(engine: BrainEngine): Promise<{ liveToken: string; revokedToken: string }> {
  for (const [id, deleted] of [['client-live', false], ['client-deleted', true]] as const) {
    await engine.insertOauthClient({
      client_id: id, client_secret_hash: 'x', client_name: id, redirect_uris: [], grant_types: ['client_credentials'],
      scope: 'read write skills_member_self', token_endpoint_auth_method: 'client_secret_post', client_id_issued_at: 0,
      source_id: 'default', allowed_operations: ['leave_brain', 'get_write_request'], deleted_at: deleted ? new Date() : null,
    });
  }
  const token = async (name: string, revoked: boolean) => (await engine.insertAccessToken({
    name, token_hash: `hash-${name}`, scopes: ['read', 'write'], permissions: {}, source_grant: null, source_id: null,
    federated_read: null, allowed_operations: null, takes_holders: null, revoked_at: revoked ? new Date() : null,
  })).id;
  return { liveToken: await token('token-live', false), revokedToken: await token('token-revoked', true) };
}

describe('engine parity: access-grant reads', () => {
  parityTest('a receipt grant read returns a deleted client and a revoked token with their marks; a membership read returns neither', {
    methods: ['readOAuthClientReceiptGrant', 'readAccessTokenReceiptGrant', 'readOAuthClientMemberGrant', 'readAccessTokenMemberGrant', 'insertOauthClient', 'insertAccessToken', 'transaction'],
  }, async (engine) => {
    // Nothing seeded: every read is empty.
    const empty = {
      client: await engine.readOAuthClientReceiptGrant('client-live'),
      token: await engine.readAccessTokenReceiptGrant(MISSING_TOKEN),
      memberClient: await engine.readOAuthClientMemberGrant('client-live'),
      memberToken: await engine.readAccessTokenMemberGrant(MISSING_TOKEN),
    };
    expect(empty).toEqual({ client: undefined, token: undefined, memberClient: undefined, memberToken: undefined });
    const { liveToken, revokedToken } = await seedGrants(engine);
    const marked = (v: unknown) => v !== null && v !== undefined;
    const receipt = await engine.transaction(async (tx) => {
      const live = await tx.readOAuthClientReceiptGrant('client-live', { lock: true });
      const deleted = await tx.readOAuthClientReceiptGrant('client-deleted', { lock: true });
      const tokenLive = await tx.readAccessTokenReceiptGrant(liveToken, { lock: true });
      const tokenRevoked = await tx.readAccessTokenReceiptGrant(revokedToken);
      return {
        live: live && { scope: live.scope, deleted: marked(live.deleted_at), ops: live.allowed_operations, source: live.source_id, prefixes: live.bound_slug_prefixes },
        deleted: deleted && { deleted: marked(deleted.deleted_at) },
        tokenLive: tokenLive && { scopes: tokenLive.scopes, revoked: marked(tokenLive.revoked_at) },
        tokenRevoked: tokenRevoked && { revoked: marked(tokenRevoked.revoked_at) },
      };
    });
    expect(receipt).toEqual({
      live: { scope: 'read write skills_member_self', deleted: false, ops: ['leave_brain', 'get_write_request'], source: 'default', prefixes: null },
      deleted: { deleted: true }, tokenLive: { scopes: ['read', 'write'], revoked: false }, tokenRevoked: { revoked: true },
    });
    const member = await engine.transaction(async (tx) => {
      const live = await tx.readOAuthClientMemberGrant('client-live');
      const tokenLive = await tx.readAccessTokenMemberGrant(liveToken);
      return {
        live: live && { scope: live.scope, source: live.source_id, ops: live.allowed_operations, revision: Number(live.grant_revision) },
        // A dropped `deleted_at IS NULL` or `revoked_at IS NULL` puts a row here.
        deleted: await tx.readOAuthClientMemberGrant('client-deleted'),
        tokenLive: tokenLive && { id: tokenLive.id === liveToken, scopes: tokenLive.scopes },
        tokenRevoked: await tx.readAccessTokenMemberGrant(revokedToken),
      };
    });
    expect(member).toEqual({ live: { scope: 'read write skills_member_self', source: 'default', ops: ['leave_brain', 'get_write_request'], revision: member.live!.revision },
      deleted: undefined, tokenLive: { id: true, scopes: ['read', 'write'] }, tokenRevoked: undefined });
    return { empty, receipt, member };
  });

  parityTest('a local writer member grant carries the grant ceiling and no revocation', {
    methods: ['insertLocalWriterRow', 'readLocalWriterMemberGrant', 'transaction'],
  }, async (engine) => {
    const absent = await engine.readLocalWriterMemberGrant(WRITER);
    await engine.insertLocalWriterRow({ id: WRITER, lane: 'cli', credentialHash: 'e'.repeat(64), grant: GRANT });
    const row = await engine.transaction(tx => tx.readLocalWriterMemberGrant(WRITER));
    expect({ absent, row }).toEqual({ absent: undefined, row: { grant_ceiling: GRANT, revoked_at: null } });
    return { absent, row };
  });

  parityTest('a revoked local writer member grant carries its revoked_at, so membership denies it', {
    methods: ['insertLocalWriterRow', 'revokeLocalWriterRow', 'readLocalWriterMemberGrant'],
  }, async (engine) => {
    await engine.insertLocalWriterRow({ id: WRITER, lane: 'cli', credentialHash: 'e'.repeat(64), grant: GRANT });
    // True when the registration exists, false for an id no writer holds.
    expect({ revoked: await engine.revokeLocalWriterRow(WRITER), unknown: await engine.revokeLocalWriterRow(UNKNOWN) })
      .toEqual({ revoked: true, unknown: false });
    const row = await engine.readLocalWriterMemberGrant(WRITER);
    // The read keeps the revoked row (the caller refuses it); a reader that dropped revoked_at would hide the mark.
    expect({ revoked: row?.revoked_at != null, ceiling: row?.grant_ceiling }).toEqual({ revoked: true, ceiling: GRANT });
    return { revoked: row?.revoked_at != null };
  });

  parityTest('the request-id lookup spans principals and stops at two rows; the local CLI refuses a shared id', {
    methods: ['readPersistenceBrainId', 'insertLocalWriterRow', 'readLocalWriterRow', 'readWriteRequest', 'readWriteRequestsByRequestId', 'insertWriteRequest'],
  }, (engine) => inFreshHome(async () => {
    await registerServeLocalWriters(engine);
    await admit(engine, 'client-a', SINGLE, 'notes/single');
    for (const [client, slug] of [['client-a', 'notes/shared-a'], ['client-b', 'notes/shared-b'], ['client-c', 'notes/shared-c']]) await admit(engine, client, SHARED, slug);
    const single = await engine.readWriteRequestsByRequestId(SINGLE.toUpperCase());
    const shared = await engine.readWriteRequestsByRequestId(SHARED);
    const none = await engine.readWriteRequestsByRequestId(UNKNOWN);
    expect({ single: single.map(r => [r.principal_id, r.slug]), shared: shared.length, sharedIds: [...new Set(shared.map(r => r.request_id))], none })
      .toEqual({ single: [['client-a', 'notes/single']], shared: 2, sharedIds: [SHARED], none: [] });
    // The op on a single owner's id goes on to the best-effort health read (raw SQL), so it is pinned in the census,
    // not here; the refusals below return before that read.
    const result = {
      // Two principals share the id: the host operator gets not_found, never one of them.
      shared: await answer(engine, 'get_write_request', { request_id: SHARED }),
      unknown: await answer(engine, 'get_write_request', { request_id: UNKNOWN }),
    };
    expect(result).toEqual({ shared: { code: 'not_found' }, unknown: { code: 'not_found' } });
    return result;
  }));

  // The member is trust-withdrawals.ts's readTrustGeneration (it throws on a missing row; the move on a trust config
  // write is pinned in trust-withdrawals.test.ts). This case pins that the cache identity read fails closed with it.
  // The Rust arm's stop, by design (RUST_ENGINE.md row 56): Rust keeps no singleton row (this case deletes one with raw SQL).
  parityTest('a brain with no trust_policy_state row fails the generation read, and the cache identity read fails closed', {
    methods: ['readTrustGeneration'],
  }, async (engine) => {
    await engine.executeRaw('DELETE FROM trust_policy_state').catch((e: unknown) => rethrowByDesignStop(e, 'executeRaw', '56'));
    const member = await engine.readTrustGeneration().then(() => null, (e: Error) => e.message);
    const refused = await readTrustGeneration(engine).then(() => null, (e: Error) => e.message);
    const unreadable = 'trust generation unreadable: trust_policy_state has no row';
    expect({ member, refused }).toEqual({ member: unreadable, refused: unreadable });
    return { member, refused };
  });

  parityTest('the shared-skill serving epoch is a stable UUID; membership of an unknown installation is membership_not_found', {
    methods: ['readSharedSkillServingEpoch', 'readPersistenceBrainId', 'insertLocalWriterRow', 'readLocalWriterRow', 'readLocalWriterMemberGrant', 'transaction'],
  }, (engine, backend) => inFreshHome(async () => {
    await installSingletons(engine, backend);
    const first = await engine.readSharedSkillServingEpoch();
    const second = await engine.readSharedSkillServingEpoch();
    expect({ uuid: UUID.test(first ?? ''), stable: first === second }).toEqual({ uuid: true, stable: true });
    await registerServeLocalWriters(engine);
    const result = {
      uuid: true, stable: true,
      leave: await answer(engine, 'leave_brain', { installation_id: 'not-a-uuid', enrollment_epoch: 1 }),
      sync: await answer(engine, 'sync_brain_skills', { installation_id: 'not-a-uuid', enrollment_epoch: 1 }),
    };
    expect(result).toEqual({ uuid: true, stable: true, leave: { code: 'membership_not_found' }, sync: { code: 'membership_not_found' } });
    return result;
  }));

  // The Rust arm's stop, by design (RUST_ENGINE.md row 56): Rust keeps no singleton row (this case deletes one with raw SQL).
  parityTest('a brain with no shared_skill_state row reads a null serving epoch, and membership denies', {
    methods: ['readSharedSkillServingEpoch', 'readLocalWriterMemberGrant'],
  }, (engine) => inFreshHome(async () => {
    await registerServeLocalWriters(engine);
    await engine.executeRaw('DELETE FROM shared_skill_state').catch((e: unknown) => rethrowByDesignStop(e, 'executeRaw', '56'));
    const epoch = await engine.readSharedSkillServingEpoch();
    const leave = await answer(engine, 'leave_brain', { installation_id: UNKNOWN, enrollment_epoch: 1 });
    expect({ epoch, leave }).toEqual({ epoch: null, leave: { code: 'permission_denied' } });
    return { epoch, leave };
  }));
});
