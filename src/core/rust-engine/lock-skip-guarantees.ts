/**
 * Lock skips that stay safe when the Rust engine's explicit transactions run optimistically (multi-user mode, interface
 * I-1; docs/designs/rust-engine/multi-user-server.md, "Appendix: skip guarantees under multi-user mode").
 *
 * A TypeScript lock skip asserts `serialized_transactions` first (errors.ts `assertSerializedTransactions`,
 * store-members/common.ts `assertStoreSerializedTransactions`). With multi-user mode off the store's explicit
 * transactions hold the writer and every skip passes. With it on, a skip passes only when its site is listed here with
 * the guarantee that replaces the lock and the test that proves it under `GBRAIN_RUST_MULTIUSER=1`; every other site
 * refuses `engine_capability_missing`. test/serialized-transactions-guard.test.ts checks each row names a marked site
 * and an existing test. The Rust-side sites have their own table (rust/crates/gbrain-store/src/lock_skips.rs).
 */

/** What replaces the skipped lock once explicit transactions run optimistically. */
export type LockSkipGuarantee =
  /** Every key the transaction read through its handle is validated at commit; a changed read reruns the callback. */
  | 'read-set'
  /** A revision compare inside the transaction (a read of the row, so validated at commit). */
  | 'cas'
  /** The keys are held in the brain's single-flight table (lockPageKeys) until commit or rollback. */
  | 'single_flight'
  /** Commutative counter operations whose admission check is re-evaluated at commit. */
  | 'counter';

export interface ProvenLockSkip {
  readonly guarantee: LockSkipGuarantee;
  /** The test that proves the guarantee with multi-user mode on: `<file>::<test name>`. */
  readonly test: string;
}

/** The TypeScript-side sites proven under multi-user mode, by site id. */
export const MULTIUSER_PROVEN: Readonly<Record<string, ProvenLockSkip>> = {
  admitJob: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::admitJob: two overlapping delegated admissions at a cap of one never both insert' },
  lockAllSourceRows: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row, whole table: a source written before the commit reruns lockAllSourceRows' },
  lockSourceRow: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns lockSourceRow and the rerun reads the new row' },
  lockSourceForUpdate: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns lockSourceForUpdate' },
  lockSourceShared: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns lockSourceShared' },
  readSourceArchivedForShare: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the share-locked source readers' },
  readSourceState: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the share-locked source readers' },
  readScopeSourceConfigs: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the share-locked source readers' },
  readSourceMembership: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the share-locked source readers' },
  listConnectorSources: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the share-locked source readers' },
  readManagedMode: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns readManagedMode and readPersistenceBrain' },
  'readManagedMode.afterRead': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns readManagedMode and readPersistenceBrain' },
  readPersistenceBrain: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns readManagedMode and readPersistenceBrain' },
  'readPersistenceBrain.afterRead': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns readManagedMode and readPersistenceBrain' },
  declarePersistence: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns declarePersistence' },
  'writerRelease.shareBrain': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  'writerAdmin.lockBrain': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  worktreeClaimStore: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  lockEffectGuard: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  lockSharedSkillBrainId: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  readWriterAdminState: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard' },
  'writerRelease.shareWorktree': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::worktree row: a worktree registered before the commit reruns the worktree locks' },
  'writerAdmin.lockWorktree': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::worktree row: a worktree registered before the commit reruns the worktree locks' },
  'publicationJournal.shareWorktree': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::worktree row: a worktree registered before the commit reruns the worktree locks' },
  'publicationJournal.shareWorktreeOwner': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::worktree row: a worktree registered before the commit reruns the worktree locks' },
  'worktreeClaim.lockSource': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the claim and publication source locks' },
  'publicationJournal.lockSource': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the claim and publication source locks' },
  'writerRelease.configuredSources': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the claim and publication source locks' },
  'writerRelease.lockCycleLocks': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::cycle-lock rows: a cycle lock taken under a host lease before the commit reruns the cycle-lock guards' },
  retireManagedSyncPassSlugMode: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::cycle-lock rows: a cycle lock taken under a host lease before the commit reruns the cycle-lock guards' },
  'writerRelease.lockWorktreesAndSources': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns the claim and publication source locks' },
  readConfigForUpdate: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a change committed before the commit reruns the config guards' },
  lockAgentWritebackSetting: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a change committed before the commit reruns the config guards' },
  lockEmbeddingSwitch: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a change committed before the commit reruns the config guards' },
  lockContentDriftState: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a change committed before the commit reruns the config guards' },
  readOAuthClientReceiptGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  readOAuthClientMemberGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  readOauthClientAttest: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  readOauthClientForUpdate: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  lockOAuthClient: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  readOAuthClientWriteGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  shareLockWriteCredential: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  readCredentialBindingForUpdate: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client row: a change committed before the commit reruns the client-row readers and locks' },
  lockOauthClientName: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::oauth client rows: a client registered before the commit reruns lockOauthClientName' },
  'worktreeClaim.assertAdminUnlocked': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a writer-admin lock change committed before the commit reruns the admin-unlocked checks' },
  'writerAdmin.assertAdminUnlocked': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::config row: a writer-admin lock change committed before the commit reruns the admin-unlocked checks' },
  readAccessTokenReceiptGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::access token row: a revocation committed before the commit reruns the token-row readers and locks' },
  readAccessTokenMemberGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::access token row: a revocation committed before the commit reruns the token-row readers and locks' },
  readAccessTokenWriteGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::access token row: a revocation committed before the commit reruns the token-row readers and locks' },
  readLocalWriterRow: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::local writer row: a revocation committed before the commit reruns the local-writer readers' },
  readLocalWriterMemberGrant: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::local writer row: a revocation committed before the commit reruns the local-writer readers' },
  getTrustProposal: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::proposal rows: a transition committed before the commit reruns the proposal readers' },
  getDecideProposal: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::proposal rows: a transition committed before the commit reruns the proposal readers' },
  getDecideReviewProposal: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::proposal rows: a transition committed before the commit reruns the proposal readers' },
  lockFactRows: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::fact row: a fact expired before the commit reruns the fact guards and claim reads' },
  lockApprovedFacts: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::fact row: a fact expired before the commit reruns the fact guards and claim reads' },
  readForgetTarget: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::fact row: a fact expired before the commit reruns the fact guards and claim reads' },
  readFactWithdrawalClaim: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::fact row: a fact expired before the commit reruns the fact guards and claim reads' },
  lockPageById: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::page row: a page rewritten before the commit reruns the page guards and reads' },
  readLiveStoredBody: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::page row: a page rewritten before the commit reruns the page guards and reads' },
  readMentionPageRevisions: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::page row: a page rewritten before the commit reruns the page guards and reads' },
  listSecretHoldingPages: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::page row: a page rewritten before the commit reruns the page guards and reads' },
  lockMentionSources: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::mention status row: a generation bump committed before the commit reruns lockMentionSources and readMentionGenerations' },
  readMentionGenerations: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::mention status row: a generation bump committed before the commit reruns lockMentionSources and readMentionGenerations' },
  lockMentionEntries: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::mention gazetteer entries: a save committed before the commit reruns lockMentionEntries' },
  lockGenerationKey: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::generation key: a generation activated before the commit reruns lockGenerationKey followed by the live-generation read' },
  lockPurgeSource: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source row: a source written before the commit reruns lockPurgeSource' },
  readWorktreeAdmission: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::worktree rows: a worktree registered before the commit reruns readWorktreeAdmission' },
  readSharedSkillPolicyRow: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::shared skill rows: a rebind, a policy write and an acknowledgement committed before the commit rerun the shared-skill readers' },
  readSharedSkillMember: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::shared skill rows: a rebind, a policy write and an acknowledgement committed before the commit rerun the shared-skill readers' },
  readSharedSkillDeliveryBatch: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::shared skill rows: a rebind, a policy write and an acknowledgement committed before the commit rerun the shared-skill readers' },
  readLoopFactState: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::loop row: a close committed before the commit reruns readLoopFactState' },
  listFenceFactRows: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::fence facts: a fact written for the page before the commit reruns listFenceFactRows' },
  lockWriteRequest: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::write request row: a cancellation committed before the commit reruns lockWriteRequest, lockWriteRequestsById and recoveryStaging' },
  lockWriteRequestsById: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::write request row: a cancellation committed before the commit reruns lockWriteRequest, lockWriteRequestsById and recoveryStaging' },
  'publicationJournal.recoveryStaging': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::write request row: a cancellation committed before the commit reruns lockWriteRequest, lockWriteRequestsById and recoveryStaging' },
  readNoopEmbeddingCandidates: { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::effect rows: an effect queued before the commit reruns readNoopEmbeddingCandidates' },
  'replaceDerivedLinks.wanted': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source rows: a source registered before the commit reruns the wanted-link replacement that checked it' },
  'replaceDerivedLinksBatch.wanted': { guarantee: 'read-set', test: 'test/multiuser-lock-skips.serial.test.ts::source rows: a source registered before the commit reruns the wanted-link replacement that checked it' },
};

/** Whether `site` may skip its lock while explicit transactions run optimistically. */
export function provenUnderMultiuser(site: string): boolean {
  return Object.prototype.hasOwnProperty.call(MULTIUSER_PROVEN, site);
}
