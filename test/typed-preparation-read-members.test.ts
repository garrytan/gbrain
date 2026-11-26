/**
 * The access, page-visibility, grant and source reads a preparation makes were raw statements that ran through the
 * preparer's bounded view (`persistence/bounded-reads.ts boundedReads`), so a stalled one ended at the claim clock's
 * deadline. They are typed engine members now. The view wraps a typed member in the clock's read deadline only when
 * `TYPED_PREPARATION_READS` names it; any other member is bound straight to the engine and runs with no deadline.
 *
 * Protects:
 * - every one of these members is listed in TYPED_PREPARATION_READS;
 * - each, stalled on a connection that never answers, ends when the clock's signal aborts, with the signal's reason, and
 *   its reserved connection is discarded, not released (as master's raw statement did, #8155).
 * Fails when a member leaves the list, or the Postgres engine stops reading it under the view's deadline.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads, TYPED_PREPARATION_READS } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});

/** Each typed member a preparation reaches that master issued through `executeRaw`. */
const CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  readLiveMember: (e) => e.readLiveMember('member', 'alice-example'),
  readFolderAccess: (e) => e.readFolderAccess(['member:alice-example']),
  readLinkedMember: (e) => e.readLinkedMember('slack', 'U1'),
  hasLabelledOnlyMember: (e) => e.hasLabelledOnlyMember(),
  readWriteVisibilityProbe: (e) => e.readWriteVisibilityProbe('default', 'people/a'),
  readWriterSlugFence: (e) => e.readWriterSlugFence({ kind: 'oauth_client', id: 'client-a' }),
  readSourceMembership: (e) => e.readSourceMembership('default'),
  readOAuthClientWriteGrant: (e) => e.readOAuthClientWriteGrant('client-a'),
  readAccessTokenWriteGrant: (e) => e.readAccessTokenWriteGrant('00000000-0000-0000-0000-000000000001'),
  shareLockWriteCredential: (e) => e.shareLockWriteCredential('oauth_client', 'client-a'),
  readOauthClient: (e) => e.readOauthClient('client-a'),
  listGuestSourceIds: (e) => e.listGuestSourceIds(['default']),
  readSourceRow: (e) => e.readSourceRow('default'),
  getWorktreeBinding: (e) => e.getWorktreeBinding('default', null),
  readMayActFor: (e) => e.readMayActFor('oauth_client', 'client-a'),
  readAudiencePrincipals: (e) => e.readAudiencePrincipals(['alice-example'], []),
  readScopeSourceConfigs: (e) => e.readScopeSourceConfigs(['default']),
  readOwnerOnlySourcesPresent: (e) => e.readOwnerOnlySourcesPresent(),
  readOwnerOnlySourceConfig: (e) => e.readOwnerOnlySourceConfig('default'),
};

test('every typed preparation read this part adds is in TYPED_PREPARATION_READS and is a member of the Postgres engine', () => {
  for (const member of Object.keys(CALLS)) {
    expect(TYPED_PREPARATION_READS.has(member), `${member} is missing from TYPED_PREPARATION_READS`).toBe(true);
    expect(typeof (PostgresEngine.prototype as unknown as Record<string, unknown>)[member], member).toBe('function');
  }
});

/**
 * `shareLockWriteCredential` takes a row lock for the caller's transaction, so it runs through `preparationRead` with no deadline
 * (a lock is only meaningful inside the transaction that holds it, and a page transaction never takes a read deadline). It is named
 * above so the preparer view still hands it out as a typed read, and it has no stall case here.
 */
const HOLDS_A_LOCK = new Set(['shareLockWriteCredential']);

for (const [member, call] of Object.entries(CALLS).filter(([member]) => !HOLDS_A_LOCK.has(member))) {
  test(`${member} stalled on its connection ends at the preparation clock's abort and discards the connection`, async () => {
    const counts = { discards: 0, releases: 0 };
    const fake = makeFakeSql(() => never());
    const reserve = fake.sql.reserve;
    fake.sql.reserve = async () => {
      const r = await reserve();
      r.discard = () => { counts.discards++; };
      const release = r.release;
      r.release = () => { counts.releases++; release(); };
      return r;
    };
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    const controller = new AbortController();
    const reason = { code: 'preparation_deadline' };
    const reads = boundedReads(engine, startClaimPhase(Date.now(), controller.signal, 60_000));
    const pending = call(reads);
    setTimeout(() => controller.abort(reason), 20);
    const outcome = await Promise.race([pending.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
    expect(outcome).toBe(reason);
    expect(counts).toEqual({ discards: 1, releases: 0 });
  });
}
