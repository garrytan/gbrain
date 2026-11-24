/**
 * BrainEngine parity — the stored attest right of a token or OAuth client principal (access/actor.ts attestRightOf).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with no live attest right on the call, attestRightOf reads the principal's attest columns through
 *    readAccessTokenAttest and readOauthClientAttest: a token not revoked keeps its right; a revoked token and a deleted
 *    client have none; an
 *    OAuth client has a right only when it is confidential and holds the client_credentials grant; a credential bound
 *    to a member, or with no attest system, has none. Every engine arm answers the same (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the read ran as two raw statements, which a Rust brain refuses, so a stored write from a token or an
 *    OAuth client principal could not re-check its attest right after the swap.
 *  - Why existing coverage misses it: test/qm-memory-tools.test.ts and test/qm-scope-read.test.ts run the attested path
 *    on PGLite and Postgres only.
 *  - Seam: tokens and clients are written through insertAccessToken, insertOauthClient (a deleted client with its
 *    deleted_at), writeCredentialBinding and revokeAccessToken. Token ids differ between arms, so tokens are named by
 *    label; the compared rows carry no id.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CredentialBinding } from '../../src/core/engine-sql/access-members.ts';
import { attestRightOf } from '../../src/core/access/actor.ts';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const GRANT = { source_grant: 'default', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null };
const ATTEST: CredentialBinding = { member: null, mayActFor: null, attestActor: 'qm', attestOps: ['memory_write', 'memory_recall'], attestSources: null, attestRead: null };

async function token(engine: BrainEngine, name: string, binding: Partial<CredentialBinding> = {}): Promise<string> {
  const { id } = await engine.insertAccessToken({ name, token_hash: hashToken(`tok-${name}`), scopes: ['read', 'write'], permissions: {}, ...GRANT });
  await engine.writeCredentialBinding({ kind: 'token', id }, { ...ATTEST, ...binding });
  return id;
}

async function client(engine: BrainEngine, id: string, opts: { secret?: boolean; grants: string[]; deleted?: boolean }, binding: Partial<CredentialBinding> = {}) {
  await engine.insertOauthClient({
    client_id: id, client_name: id, scope: 'read write', grant_types: opts.grants, client_id_issued_at: 1_700_000_000,
    client_secret_hash: opts.secret ? hashToken(`secret-${id}`) : null, ...(opts.deleted ? { deleted_at: new Date('2026-01-02T00:00:00Z') } : {}),
  });
  await engine.writeCredentialBinding({ kind: 'client', id }, { ...ATTEST, ...binding });
}

describe('engine parity: the stored attest right of a token or OAuth client', () => {
  parityTest('attestRightOf with no live right: a live token keeps its right, a revoked token and a deleted client have none, a client has one only as a confidential client_credentials client',
    { methods: ['insertAccessToken', 'insertOauthClient', 'writeCredentialBinding', 'revokeAccessToken', 'readAccessTokenAttest', 'readOauthClientAttest', 'transaction'] }, async (engine) => {
      const live = await token(engine, 'attest-live');
      const revoked = await token(engine, 'attest-revoked');
      await engine.revokeAccessToken(revoked);
      const bound = await token(engine, 'attest-bound', { member: 'alice-example' });
      const scoped = await token(engine, 'attest-scoped', { attestSources: ['scope-a'] });
      await client(engine, 'cc-confidential', { secret: true, grants: ['client_credentials'] });
      await client(engine, 'cc-public', { grants: ['client_credentials'] });
      await client(engine, 'code-confidential', { secret: true, grants: ['authorization_code', 'refresh_token'] });
      await client(engine, 'cc-deleted', { secret: true, grants: ['client_credentials'], deleted: true });
      const right = (kind: string, id: string) => attestRightOf(engine, { principal: { kind, id } });
      const shown = <T extends object>(row: T | null, time: keyof T) => row && { ...row, [time]: row[time] == null ? null : row[time] instanceof Date ? 'set' : `not a Date: ${String(row[time])}` };
      const out = {
        tokens: {
          live: await right('legacy_token', live), revoked: await right('legacy_token', revoked),
          bound: await right('legacy_token', bound), scoped: await right('legacy_token', scoped),
          absent: await right('legacy_token', '00000000-0000-4000-8000-00000000dead'),
        },
        clients: {
          confidential: await right('oauth_client', 'cc-confidential'), public: await right('oauth_client', 'cc-public'),
          authorizationCode: await right('oauth_client', 'code-confidential'), deleted: await right('oauth_client', 'cc-deleted'),
          absent: await right('oauth_client', 'nobody'),
        },
        // The rows themselves, revoked and deleted ones included (times by presence: each arm has its own clock).
        rows: {
          token: shown(await engine.readAccessTokenAttest(live), 'revoked_at'),
          revokedToken: shown(await engine.readAccessTokenAttest(revoked), 'revoked_at'),
          absentToken: await engine.readAccessTokenAttest('00000000-0000-4000-8000-00000000dead'),
          client: shown(await engine.readOauthClientAttest('cc-confidential'), 'deleted_at'),
          publicClient: shown(await engine.readOauthClientAttest('cc-public'), 'deleted_at'),
          deletedClient: shown(await engine.readOauthClientAttest('cc-deleted'), 'deleted_at'),
          lockedClient: shown(await engine.transaction(tx => tx.readOauthClientAttest('cc-confidential', { lock: true })), 'deleted_at'),
          absentClient: await engine.readOauthClientAttest('nobody'),
        },
        other: await right('local_writer', 'anything'),
      };
      // Not vacuous: the live token and the confidential client_credentials client carry a right; the others do not.
      expect(out.tokens.live).toEqual({ system: 'qm', ops: ['memory_write', 'memory_recall'], sources: null });
      expect(out.clients.confidential).toEqual({ system: 'qm', ops: ['memory_write', 'memory_recall'], sources: null });
      expect([out.tokens.revoked, out.tokens.bound, out.tokens.absent, out.clients.public, out.clients.authorizationCode, out.clients.deleted, out.clients.absent])
        .toEqual([null, null, null, null, null, null, null]);
      expect(out.tokens.scoped?.sources).toEqual(['scope-a']);
      return out;
    });
});
