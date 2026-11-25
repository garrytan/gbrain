/**
 * The TypeScript lock skips of the Rust store members refuse without `serialized_transactions`
 * (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1).
 *
 * Each row of CASES calls one real exported member with minimal arguments (the lock option on, where the lock is an
 * option) on a store whose `serializedTransactions` is false. Every other property of that store throws
 * `store call <name> reached`, so a refusal can only come before any store call. The same call on a store that answers
 * true must not refuse. test/serialized-transactions-guard.test.ts counts the sites and requires a row for each.
 */
import { describe, expect, test } from 'bun:test';
import type { OperationError } from '../src/core/ops/contract.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';
import type { RustEngine } from '../src/core/rust-engine.ts';
import { readManagedMode, readPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import * as accessGrants from '../src/core/rust-engine/store-members/access-grants.ts';
import * as accessMembers from '../src/core/rust-engine/store-members/access-members.ts';
import * as cliSources from '../src/core/rust-engine/store-members/cli-sources.ts';
import * as decideProposals from '../src/core/rust-engine/store-members/decide-proposals.ts';
import * as effectWorker from '../src/core/rust-engine/store-members/effect-worker.ts';
import * as embedStaleWork from '../src/core/rust-engine/store-members/embed-stale-work.ts';
import * as embeddingInstall from '../src/core/rust-engine/store-members/embedding-install.ts';
import * as factTextRepair from '../src/core/rust-engine/store-members/fact-text-repair.ts';
import * as factsConversation from '../src/core/rust-engine/store-members/facts-conversation.ts';
import * as factsPurge from '../src/core/rust-engine/store-members/facts-purge.ts';
import * as factsRest from '../src/core/rust-engine/store-members/facts-rest.ts';
import * as factsWritePath from '../src/core/rust-engine/store-members/facts-write-path.ts';
import * as fenceHolds from '../src/core/rust-engine/store-members/fence-holds.ts';
import * as jobsClientGrants from '../src/core/rust-engine/store-members/jobs-client-grants.ts';
import * as jobsQueue from '../src/core/rust-engine/store-members/jobs-queue.ts';
import * as managedSyncOrphans from '../src/core/rust-engine/store-members/managed-sync-orphans.ts';
import * as memoryMutationReads from '../src/core/rust-engine/store-members/memory-mutation-reads.ts';
import * as secretStore from '../src/core/rust-engine/store-members/secret-store.ts';
import * as transactionsMembers from '../src/core/rust-engine/store-members/transactions.ts';
import * as noopSettle from '../src/core/rust-engine/store-members/noop-settle.ts';
import * as jobs from '../src/core/rust-engine/store-members/jobs.ts';
import * as linkQueries from '../src/core/rust-engine/store-members/link-queries.ts';
import * as mentionPass from '../src/core/rust-engine/store-members/mention-pass.ts';
import * as persistenceAdmission from '../src/core/rust-engine/store-members/persistence-admission.ts';
import * as persistence from '../src/core/rust-engine/store-members/persistence.ts';
import * as publicationJournal from '../src/core/rust-engine/store-members/publication-journal.ts';
import * as repairApplies from '../src/core/rust-engine/store-members/repair-applies.ts';
import * as repairBookkeeping from '../src/core/rust-engine/store-members/repair-bookkeeping.ts';
import * as sharedSkillMembers from '../src/core/rust-engine/store-members/shared-skill-members.ts';
import * as trustFence from '../src/core/rust-engine/store-members/trust-fence.ts';
import * as trustProposals from '../src/core/rust-engine/store-members/trust-proposals.ts';
import * as worktreeClaim from '../src/core/rust-engine/store-members/worktree-claim.ts';
import * as writeGuards from '../src/core/rust-engine/store-members/write-guards.ts';
import * as writeMisc from '../src/core/rust-engine/store-members/write-misc.ts';
import * as writerAdmin from '../src/core/rust-engine/store-members/writer-admin.ts';
import * as writerRelease from '../src/core/rust-engine/store-members/writer-release.ts';

/** A store whose `serializedTransactions` is `serialized` and whose every other property throws. */
function fakeBrain(serialized: boolean): StoreBrain {
  return new Proxy({}, {
    get(_target, name) {
      if (name === 'serializedTransactions') return serialized;
      if (name === 'multiuser') return false;
      throw new Error(`store call ${String(name)} reached`);
    },
  }) as unknown as StoreBrain;
}

/** The engine the managed-mode readers take: a Rust engine whose capability set follows the fake store. */
const rustEngine = (brain: StoreBrain) => ({
  kind: 'rust',
  capabilities: new Set(brain.serializedTransactions ? ['serialized_transactions'] : []),
}) as never;

/**
 * A Rust engine that reports the capability until its read runs, then loses it when `brain` does not serialize: the
 * read elected a new owner whose store promises none (a takeover between the check and the read).
 */
const takenOverEngine = (brain: StoreBrain) => {
  const capabilities = new Set(['serialized_transactions']);
  const lose = () => { if (!brain.serializedTransactions) capabilities.delete('serialized_transactions'); };
  const state = JSON.stringify({ brain: { id: 'b', enabled: false, mode_epoch: 1, skill_bundles_enabled: false, writer_protocol_floor: 1 },
    sources: null, worktrees: null, embedding_leases: null });
  return {
    kind: 'rust', capabilities,
    readManagedModeRows: async () => { lose(); return [{ enabled: false }]; },
    readWriterAdminState: async () => { lose(); return state; },
  } as never;
};

const WANTED = { wanted: { producers: ['p'], rows: [], readAt: null } } as never;
const ORIGIN = { sourceId: 's', slug: 'a', expectedRevision: null } as never;

/** The engine the store-factory members run on (`this`); none of them reads it before the call. */
const thisEngine = {} as RustEngine;

const KEY = { worktreeId: '00000000-0000-4000-8000-000000000001', sourceId: 's', sourceIncarnation: '00000000-0000-4000-8000-000000000002', topologyGeneration: null };
const TARGET = { cursorKey: 'k', sourceId: 's', incarnation: null, runId: null, requestId: null };
const UUID = '00000000-0000-4000-8000-000000000003';

/**
 * The store a factory member returns, built while `brain` answers true, so a case can reach one method of it: the
 * factory's own assertion (worktreeClaimStore) passes, and the method then reads `brain`'s answer.
 */
async function storeOf<T>(factory: (this: RustEngine, brain: StoreBrain) => Promise<T>, brain: StoreBrain): Promise<T> {
  let armed = false;
  const view = new Proxy({}, {
    get(_target, name) { return name === 'serializedTransactions' && !armed ? true : (brain as never)[name]; },
  }) as unknown as StoreBrain;
  const store = await factory.call(thisEngine, view);
  armed = true;
  return store;
}

const CASES: Array<[site: string, run: (brain: StoreBrain) => Promise<unknown>]> = [
  ['readManagedMode', async brain => readManagedMode(rustEngine(brain), { lock: 'update' })],
  ['readPersistenceBrain', async brain => readPersistenceBrain(rustEngine(brain), { lock: 'update' })],
  ['readManagedMode.afterRead', async brain => readManagedMode(takenOverEngine(brain), { lock: 'update' })],
  ['readPersistenceBrain.afterRead', async brain => readPersistenceBrain(takenOverEngine(brain), { lock: 'update' })],
  ['replaceDerivedLinks.wanted', brain => linkQueries.replaceDerivedLinks(brain, ORIGIN, [], WANTED)],
  ['replaceDerivedLinksBatch.wanted', brain => linkQueries.replaceDerivedLinksBatch(brain, [{ origin: ORIGIN, links: [], opts: WANTED }] as never)],
  ['readOAuthClientReceiptGrant', brain => accessGrants.readOAuthClientReceiptGrant(brain, 'c', { lock: true })],
  ['readAccessTokenReceiptGrant', brain => accessGrants.readAccessTokenReceiptGrant(brain, UUID, { lock: true })],
  ['readOAuthClientMemberGrant', brain => accessGrants.readOAuthClientMemberGrant(brain, 'c', { lock: true })],
  ['readAccessTokenMemberGrant', brain => accessGrants.readAccessTokenMemberGrant(brain, UUID, { lock: true })],
  ['readCredentialBindingForUpdate', brain => accessMembers.readCredentialBindingForUpdate(brain, { kind: 'token', id: UUID }, { readsUnscoped: false })],
  ['readOauthClientAttest', brain => accessMembers.readOauthClientAttest(brain, 'c', { lock: true })],
  ['lockAllSourceRows', brain => cliSources.lockAllSourceRows(brain, 'update')],
  ['lockSourceRow', brain => cliSources.lockSourceRow(brain, 's')],
  ['lockSourceForUpdate', brain => cliSources.lockSourceForUpdate(brain, 's')],
  ['getDecideProposal', brain => decideProposals.getDecideProposal(brain, 1, true)],
  ['getDecideReviewProposal', brain => decideProposals.getDecideReviewProposal(brain, 1, true)],
  ['lockEffectGuard', brain => effectWorker.lockEffectGuard(brain, null)],
  ['lockContentDriftState', brain => embedStaleWork.lockContentDriftState(brain, 'k', 'v')],
  ['lockEmbeddingSwitch', brain => embeddingInstall.lockEmbeddingSwitch(brain)],
  ['lockFactRows', brain => factTextRepair.lockFactRows(brain, 's', [1])],
  ['lockPageById', brain => factsConversation.lockPageById(brain, 1)],
  ['lockPurgeSource', brain => factsPurge.lockPurgeSource(brain, 's')],
  ['lockAgentWritebackSetting', brain => factsRest.lockAgentWritebackSetting(brain, 'k')],
  ['lockSourceShared', brain => factsWritePath.lockSourceShared(brain, 's')],
  ['lockGenerationKey', brain => fenceHolds.lockGenerationKey(brain, 'k')],
  ['readOauthClientForUpdate', brain => jobsClientGrants.readOauthClientForUpdate(brain, 'c')],
  ['lockOauthClientName', brain => jobsClientGrants.lockOauthClientName(brain, 'k')],
  ['readSourceArchivedForShare', brain => jobsClientGrants.readSourceArchivedForShare(brain, 's')],
  ['lockOAuthClient', brain => jobsQueue.lockOAuthClient(brain, 'c')],
  ['retireManagedSyncPassSlugMode', brain => managedSyncOrphans.retireManagedSyncPassSlugMode(brain, TARGET, 'l')],
  ['readConfigForUpdate', brain => managedSyncOrphans.readConfigForUpdate(brain, 'k')],
  ['readForgetTarget', brain => memoryMutationReads.readForgetTarget(brain, { id: 1, sourceId: 's', worldOnly: false, remoteFloor: false, lock: true, ownPage: null })],
  ['readFactWithdrawalClaim', brain => memoryMutationReads.readFactWithdrawalClaim(brain, { id: 1, sourceId: 's', worldOnly: false, memberPage: null, remoteFloor: false, lock: true })],
  ['lockMentionSources', brain => mentionPass.lockMentionSources(brain, ['s'], false)],
  ['readMentionPageRevisions', brain => mentionPass.readMentionPageRevisions(brain, [1], { forShare: true })],
  ['lockMentionEntries', brain => mentionPass.lockMentionEntries(brain, 's')],
  ['readMentionGenerations', brain => mentionPass.readMentionGenerations(brain, ['s'], true)],
  ['readLocalWriterRow', brain => persistence.readLocalWriterRow(brain, 'w', { lock: true })],
  ['readWorktreeAdmission', brain => persistenceAdmission.readWorktreeAdmission(brain, KEY)],
  ['readLocalWriterMemberGrant', brain => accessGrants.readLocalWriterMemberGrant(brain, UUID)],
  ['readNoopEmbeddingCandidates', brain => noopSettle.readNoopEmbeddingCandidates(brain, { hostId: UUID, signature: 's', expectedModel: 'm', window: [], pageIds: [], column: 'embedding' } as never)],
  ['listSecretHoldingPages', brain => secretStore.listSecretHoldingPages(brain, 's', ['a'], UUID)],
  ['declarePersistence', brain => transactionsMembers.declarePersistence.call(thisEngine, brain)],
  ['admitJob', brain => jobs.admitJob.call(thisEngine, brain, {} as never, { checkCapacity: async () => undefined } as never)],
  ['readOAuthClientWriteGrant', brain => persistence.readOAuthClientWriteGrant(brain, 'c', { lock: true })],
  ['readAccessTokenWriteGrant', brain => persistence.readAccessTokenWriteGrant(brain, UUID, { lock: true })],
  ['shareLockWriteCredential', brain => persistence.shareLockWriteCredential(brain, 'oauth_client', 'c')],
  ['lockWriteRequest', brain => persistence.lockWriteRequest(brain, UUID)],
  ['lockWriteRequestsById', brain => persistence.lockWriteRequestsById(brain, [UUID])],
  ['readSourceMembership', brain => persistence.readSourceMembership(brain, 's', { lock: true })],
  ['publicationJournal.lockSource', async brain => (await publicationJournal.publicationJournalStore.call(thisEngine, brain)).lockSource('s')],
  ['publicationJournal.shareWorktreeOwner', async brain => (await publicationJournal.publicationJournalStore.call(thisEngine, brain)).shareWorktreeOwner(UUID)],
  ['publicationJournal.shareWorktree', async brain => (await publicationJournal.publicationJournalStore.call(thisEngine, brain)).shareWorktree(UUID)],
  ['publicationJournal.recoveryStaging', async brain => (await publicationJournal.publicationJournalStore.call(thisEngine, brain)).recoveryStaging('persistence_requests', '1')],
  ['lockApprovedFacts', brain => repairApplies.lockApprovedFacts(brain, 's', [1])],
  ['readLoopFactState', brain => repairBookkeeping.readLoopFactState(brain, 1, { lock: true })],
  ['listConnectorSources', brain => repairBookkeeping.listConnectorSources(brain, { lock: true })],
  ['readSharedSkillPolicyRow', brain => sharedSkillMembers.readSharedSkillPolicyRow(brain, 's', UUID, true)],
  ['lockSharedSkillBrainId', brain => sharedSkillMembers.lockSharedSkillBrainId(brain)],
  ['readSharedSkillMember', brain => sharedSkillMembers.readSharedSkillMember(brain, { installationId: 'i', principalKind: 'token', principalId: 'p' } as never)],
  ['readSharedSkillDeliveryBatch', brain => sharedSkillMembers.readSharedSkillDeliveryBatch(brain, 't', 'i', 1)],
  ['listFenceFactRows', brain => trustFence.listFenceFactRows(brain, { sourceId: 's', slug: 'x', incoming: '' })],
  ['getTrustProposal', brain => trustProposals.getTrustProposal(brain, 1, true)],
  ['worktreeClaimStore', brain => worktreeClaim.worktreeClaimStore.call(thisEngine, brain)],
  ['worktreeClaim.lockSource', async brain => (await storeOf(worktreeClaim.worktreeClaimStore, brain)).lockSource('s')],
  ['worktreeClaim.assertAdminUnlocked', async brain => (await storeOf(worktreeClaim.worktreeClaimStore, brain)).assertAdminUnlocked()],
  ['readLiveStoredBody', brain => writeGuards.readLiveStoredBody(brain, 's', 'x', true)],
  ['readSourceState', brain => writeMisc.readSourceState(brain, 's', { lock: 'share' })],
  ['readScopeSourceConfigs', brain => writeMisc.readScopeSourceConfigs(brain, ['s'], 'share')],
  ['readWriterAdminState', brain => writerAdmin.readWriterAdminState(brain, { lock: true })],
  ['writerAdmin.lockBrain', async brain => (await writerAdmin.writerAdminStore.call(thisEngine, brain)).lockBrain()],
  ['writerAdmin.lockWorktree', async brain => (await writerAdmin.writerAdminStore.call(thisEngine, brain)).lockWorktree(UUID)],
  ['writerAdmin.assertAdminUnlocked', async brain => (await writerAdmin.writerAdminStore.call(thisEngine, brain)).assertAdminUnlocked()],
  ['writerRelease.configuredSources', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).configuredSources(true)],
  ['writerRelease.shareBrain', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).shareBrain()],
  ['writerRelease.lockWorktreesAndSources', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).lockWorktreesAndSources()],
  ['writerRelease.lockCycleLocks', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).lockCycleLocks()],
  ['writerRelease.shareWorktree', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).shareWorktree(UUID)],
];

/** The conditional sites called with the lock off: the member is unchanged, so it never refuses. */
const NO_LOCK: Array<[site: string, run: (brain: StoreBrain) => Promise<unknown>]> = [
  ['readManagedMode', async brain => readManagedMode(rustEngine(brain))],
  ['readPersistenceBrain', async brain => readPersistenceBrain(rustEngine(brain))],
  ['replaceDerivedLinks.wanted', brain => linkQueries.replaceDerivedLinks(brain, ORIGIN, [])],
  ['writerRelease.configuredSources', async brain => (await writerRelease.writerReleaseStore.call(thisEngine, brain)).configuredSources(false)],
  ['readOAuthClientReceiptGrant', brain => accessGrants.readOAuthClientReceiptGrant(brain, 'c')],
  ['readAccessTokenReceiptGrant', brain => accessGrants.readAccessTokenReceiptGrant(brain, UUID, { lock: false })],
  ['readOAuthClientMemberGrant', brain => accessGrants.readOAuthClientMemberGrant(brain, 'c')],
  ['readAccessTokenMemberGrant', brain => accessGrants.readAccessTokenMemberGrant(brain, UUID, { lock: false })],
  ['readOauthClientAttest', brain => accessMembers.readOauthClientAttest(brain, 'c')],
  ['getDecideProposal', brain => decideProposals.getDecideProposal(brain, 1)],
  ['getDecideReviewProposal', brain => decideProposals.getDecideReviewProposal(brain, 1, false)],
  ['readForgetTarget', brain => memoryMutationReads.readForgetTarget(brain, { id: 1, sourceId: 's', worldOnly: false, remoteFloor: false, lock: false, ownPage: null })],
  ['readFactWithdrawalClaim', brain => memoryMutationReads.readFactWithdrawalClaim(brain, { id: 1, sourceId: 's', worldOnly: false, memberPage: null, remoteFloor: false })],
  ['readMentionPageRevisions', brain => mentionPass.readMentionPageRevisions(brain, [1], { forShare: false })],
  ['readMentionGenerations', brain => mentionPass.readMentionGenerations(brain, ['s'], false)],
  ['readLocalWriterRow', brain => persistence.readLocalWriterRow(brain, 'w')],
  ['readOAuthClientWriteGrant', brain => persistence.readOAuthClientWriteGrant(brain, 'c')],
  ['readAccessTokenWriteGrant', brain => persistence.readAccessTokenWriteGrant(brain, UUID)],
  ['readSourceMembership', brain => persistence.readSourceMembership(brain, 's')],
  ['readLoopFactState', brain => repairBookkeeping.readLoopFactState(brain, 1)],
  ['listConnectorSources', brain => repairBookkeeping.listConnectorSources(brain)],
  ['readSharedSkillPolicyRow', brain => sharedSkillMembers.readSharedSkillPolicyRow(brain, 's', UUID, false)],
  ['getTrustProposal', brain => trustProposals.getTrustProposal(brain, 1)],
  ['readLiveStoredBody', brain => writeGuards.readLiveStoredBody(brain, 's', 'x')],
  ['readSourceState', brain => writeMisc.readSourceState(brain, 's')],
  ['readScopeSourceConfigs', brain => writeMisc.readScopeSourceConfigs(brain, ['s'])],
  ['readWriterAdminState', brain => writerAdmin.readWriterAdminState(brain)],
];

/** What `run` threw (a rejection or a synchronous throw), or undefined when it returned. */
async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const isRefusal = (error: unknown) => (error as OperationError | undefined)?.code === 'engine_capability_missing'
  && (error as OperationError).reason === 'serialized_transactions';

describe('TypeScript lock skips refuse without serialized_transactions', () => {
  test('every site is listed once', () => {
    const sites = CASES.map(([site]) => site);
    expect(sites.filter((site, i) => sites.indexOf(site) !== i)).toEqual([]);
    expect(sites.length).toBeGreaterThan(0);
  });

  test.each(CASES)('%s refuses before any store call', async (site, run) => {
    const error = await thrown(() => run(fakeBrain(false))) as OperationError | undefined;
    expect(error, `${site} ran without refusing`).toBeDefined();
    expect(error!.message).not.toMatch(/^store call /);
    expect(error!.code).toBe('engine_capability_missing');
    expect(error!.reason).toBe('serialized_transactions');
    expect(error!.message).toContain(site);
    expect(error!.detail).toContain(`member=${site} `);
  });

  test.each(CASES)('%s runs when the store serializes transactions', async (_site, run) => {
    // It may fail later on the fake store ("store call <name> reached"); it must not refuse the capability.
    expect(isRefusal(await thrown(() => run(fakeBrain(true))))).toBe(false);
  });

  test.each(NO_LOCK)('%s without the lock option does not refuse', async (_site, run) => {
    expect(isRefusal(await thrown(() => run(fakeBrain(false))))).toBe(false);
  });

  test('a closed store handle (serializedTransactions null) refuses engine_closed, so a lock is never acknowledged on an ended transaction', async () => {
    const closed = new Proxy({}, { get: (_t, name) => { if (name === 'serializedTransactions') return null; throw new Error(`store call ${String(name)} reached`); } }) as unknown as StoreBrain;
    const error = await thrown(() => cliSources.lockSourceForUpdate(closed, 's')) as OperationError | undefined;
    expect(error?.code).toBe('engine_closed');
  });
});
