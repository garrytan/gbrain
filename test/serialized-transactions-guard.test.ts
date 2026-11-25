/**
 * Lock skips fail closed (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1).
 *
 * The Rust engine skips locks PGLite and Postgres take (row locks, advisory locks, `SKIP LOCKED`, page-key locks), which
 * is safe only while explicit transactions hold the store's writer (`serialized_transactions`). Every such skip asserts
 * the capability first: `assertSerializedTransactions(engine, site)` (rust-engine/errors.ts),
 * `assertStoreSerializedTransactions(brain, site)` (rust-engine/store-members/common.ts) or
 * `Store::assert_serialized_transactions(site)` (gbrain-store lib.rs). The checks live in test/helpers/lock-skip-guard.ts.
 *
 * Enforcement (the baseline):
 * 1. The inventory: every BrainEngine member whose PGLite implementation reaches a lock clause (test/helpers/lock-inventory.ts,
 *    read from the code) and that the Rust engine serves has a marked site of its own name, or a DISPOSITIONS entry naming
 *    the marked sites that cover it, or the reason it needs none.
 * 2. The marks: real assertion calls only (never a comment or a string), pinned per file in SITES, each site id unique and
 *    covered by a refusal case (TypeScript: test/serialized-transactions-ts-sites.test.ts, Rust:
 *    rust/crates/gbrain-store/tests/serialized_transactions.rs).
 *
 * Discovery (asks for a reason, never counts as a site): a file that states the single-writer model or, in Rust engine
 * code, names a SQL lock holds a marked site or is in NOT_A_SKIP with the reason.
 *
 * To add a skip: assert at it, add its refusal case, and add it to SITES (and to DISPOSITIONS if its id is not the member's).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lockingMembers } from './helpers/lock-inventory.ts';
import {
  type Disposition, SINGLE_WRITER, baselineDrift, discovered, duplicateSites, rustMarks, sitesWithoutCases, tsMarks,
  uncoveredLockingMembers,
} from './helpers/lock-skip-guard.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';

const ROOT = join(import.meta.dir, '..');
const TS_CASES = 'test/serialized-transactions-ts-sites.test.ts';
const RUST_CASES = 'rust/crates/gbrain-store/tests/serialized_transactions.rs';

/** Marked lock skips per file, in source order. */
const SITES: Readonly<Record<string, readonly string[]>> = {
  'rust/crates/gbrain-store/src/access_policy.rs': ['lockAccessPolicy'],
  'rust/crates/gbrain-store/src/cli_reads/mention_reads.rs': ['readPageRevisionForShare'],
  'rust/crates/gbrain-store/src/dream_config.rs': ['lockDreamMapConfigRow'],
  'rust/crates/gbrain-store/src/facts/reconcile.rs': ['lockReconcileRevision'],
  'rust/crates/gbrain-store/src/facts/remember_reads.rs': ['readPairFactRow', 'readReplacementTarget'],
  'rust/crates/gbrain-store/src/jobs.rs': ['assertCycleLease'],
  'rust/crates/gbrain-store/src/jobs/access_tokens.rs': ['lockActiveAccessTokens', 'lockLegacyAccessTokens'],
  'rust/crates/gbrain-store/src/jobs/oauth_codes.rs': ['readOauthCodeForUpdate'],
  'rust/crates/gbrain-store/src/jobs/oauth_tokens.rs': ['readOauthRefreshTokenForUpdate'],
  'rust/crates/gbrain-store/src/page_body.rs': ['lockBodyStagingState'],
  'rust/crates/gbrain-store/src/page_body/segment_rewrite.rs': ['lockSegmentedGenerationPage'],
  'rust/crates/gbrain-store/src/pages.rs': ['lockPageKeys'],
  'rust/crates/gbrain-store/src/persistence.rs': ['lockPersistenceCounters', 'selectClaimableWrite'],
  'rust/crates/gbrain-store/src/persistence/effect_retry_reads.rs': ['lockEffectRow'],
  'rust/crates/gbrain-store/src/persistence/effect_worker.rs': ['selectClaimableEffect', 'lockEffectClaimRow'],
  'rust/crates/gbrain-store/src/persistence/noop_settle.rs': ['lockNoopEmbeddingWindow'],
  'rust/crates/gbrain-store/src/persistence/owner_scans.rs': ['lockOverdueHold'],
  'rust/crates/gbrain-store/src/persistence/purge_effects.rs': ['listGitEffectsCarryingReason', 'listPageGitEffectsForStrip'],
  'rust/crates/gbrain-store/src/takes/held.rs': ['listHeldTakeRows'],
  'rust/crates/gbrain-store/src/timeline/held.rs': ['listHeldTimelineRows'],
  'rust/crates/gbrain-store/src/transactions.rs': ['holdPageKeys'],
  'rust/crates/gbrain-store/src/trust/held_rows.rs': ['listGuardedTakeRows', 'listHeldRows'],
  'rust/crates/gbrain-store/src/trust/tier_reads.rs': ['lockLivePagesByKey'],
  'rust/crates/gbrain-store/src/trust/withdrawal_commit.rs': ['lockFactForWithdrawal'],
  'rust/crates/gbrain-store/src/wanted_links.rs': ['lockRegisteredSourceIds'],
  'rust/crates/gbrain-store/src/write_guards.rs': ['listOriginClaims'],
  'src/core/persistence/managed-mode.ts': ['readManagedMode', 'readManagedMode.afterRead', 'readPersistenceBrain', 'readPersistenceBrain.afterRead'],
  'src/core/rust-engine/store-members/access-grants.ts': ['readOAuthClientReceiptGrant', 'readAccessTokenReceiptGrant', 'readOAuthClientMemberGrant', 'readAccessTokenMemberGrant', 'readLocalWriterMemberGrant'],
  'src/core/rust-engine/store-members/access-members.ts': ['readCredentialBindingForUpdate', 'readOauthClientAttest'],
  'src/core/rust-engine/store-members/cli-sources.ts': ['lockAllSourceRows', 'lockSourceRow', 'lockSourceForUpdate'],
  'src/core/rust-engine/store-members/decide-proposals.ts': ['getDecideProposal', 'getDecideReviewProposal'],
  'src/core/rust-engine/store-members/effect-worker.ts': ['lockEffectGuard'],
  'src/core/rust-engine/store-members/embed-stale-work.ts': ['lockContentDriftState'],
  'src/core/rust-engine/store-members/embedding-install.ts': ['lockEmbeddingSwitch'],
  'src/core/rust-engine/store-members/fact-text-repair.ts': ['lockFactRows'],
  'src/core/rust-engine/store-members/facts-conversation.ts': ['lockPageById'],
  'src/core/rust-engine/store-members/facts-purge.ts': ['lockPurgeSource'],
  'src/core/rust-engine/store-members/facts-rest.ts': ['lockAgentWritebackSetting'],
  'src/core/rust-engine/store-members/facts-write-path.ts': ['lockSourceShared'],
  'src/core/rust-engine/store-members/fence-holds.ts': ['lockGenerationKey'],
  'src/core/rust-engine/store-members/jobs-client-grants.ts': ['readOauthClientForUpdate', 'lockOauthClientName', 'readSourceArchivedForShare'],
  'src/core/rust-engine/store-members/jobs-queue.ts': ['lockOAuthClient'],
  'src/core/rust-engine/store-members/jobs.ts': ['admitJob'],
  'src/core/rust-engine/store-members/link-queries.ts': ['replaceDerivedLinks.wanted', 'replaceDerivedLinksBatch.wanted'],
  'src/core/rust-engine/store-members/managed-sync-orphans.ts': ['retireManagedSyncPassSlugMode', 'readConfigForUpdate'],
  'src/core/rust-engine/store-members/memory-mutation-reads.ts': ['readForgetTarget', 'readFactWithdrawalClaim'],
  'src/core/rust-engine/store-members/mention-pass.ts': ['lockMentionSources', 'readMentionPageRevisions', 'lockMentionEntries', 'readMentionGenerations'],
  'src/core/rust-engine/store-members/noop-settle.ts': ['readNoopEmbeddingCandidates'],
  'src/core/rust-engine/store-members/persistence-admission.ts': ['readWorktreeAdmission'],
  'src/core/rust-engine/store-members/persistence.ts': ['readLocalWriterRow', 'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential', 'lockWriteRequest', 'lockWriteRequestsById', 'readSourceMembership'],
  'src/core/rust-engine/store-members/publication-journal.ts': ['publicationJournal.shareWorktreeOwner', 'publicationJournal.shareWorktree', 'publicationJournal.lockSource', 'publicationJournal.recoveryStaging'],
  'src/core/rust-engine/store-members/repair-applies.ts': ['lockApprovedFacts'],
  'src/core/rust-engine/store-members/repair-bookkeeping.ts': ['readLoopFactState', 'listConnectorSources'],
  'src/core/rust-engine/store-members/secret-store.ts': ['listSecretHoldingPages'],
  'src/core/rust-engine/store-members/shared-skill-members.ts': ['readSharedSkillPolicyRow', 'lockSharedSkillBrainId', 'readSharedSkillMember', 'readSharedSkillDeliveryBatch'],
  'src/core/rust-engine/store-members/transactions.ts': ['declarePersistence'],
  'src/core/rust-engine/store-members/trust-fence.ts': ['listFenceFactRows'],
  'src/core/rust-engine/store-members/trust-proposals.ts': ['getTrustProposal'],
  'src/core/rust-engine/store-members/worktree-claim.ts': ['worktreeClaim.assertAdminUnlocked', 'worktreeClaim.lockSource', 'worktreeClaimStore'],
  'src/core/rust-engine/store-members/write-guards.ts': ['readLiveStoredBody'],
  'src/core/rust-engine/store-members/write-misc.ts': ['readSourceState', 'readScopeSourceConfigs'],
  'src/core/rust-engine/store-members/writer-admin.ts': ['readWriterAdminState', 'writerAdmin.lockBrain', 'writerAdmin.assertAdminUnlocked', 'writerAdmin.lockWorktree'],
  'src/core/rust-engine/store-members/writer-release.ts': ['writerRelease.shareBrain', 'writerRelease.lockWorktreesAndSources', 'writerRelease.lockCycleLocks', 'writerRelease.shareWorktree', 'writerRelease.configuredSources'],
};

/** Rust-served members whose SQL takes a lock but that hold no site of their own name: the sites that cover them, or why none is needed. */
const DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  addLink: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  addTimelineEntry: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  applyIdentityDecisions: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  applyRetrievalRatings: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  cancelWriteRow: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  claimNextJob: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  completeJob: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  continueDerivationSweep: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  convertLegacyAccessTokenGrant: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  deleteChunks: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  ensureFactsKeywordIndex: { notALock: 'LOCK TABLE for ANALYZE runs only on Postgres; the Rust member answers present without SQL' },
  expireStaleWriteClaims: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  failJob: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  flipBodyGeneration: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  initSchema: { notALock: 'schema DDL text (trigger and function bodies), not a lock this member takes' },
  insertFact: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  insertRetrievalEvents: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  insertVolunteerEvents: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  invalidateContentDriftChunks: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  invalidateStaleSignatureEmbeddings: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  killTimedOutJobs: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  killWallClockJobs: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  logEvalCandidate: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  patchOauthClient: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  pruneMcpRequestLogBatch: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  publicationJournalStore: { sites: ['publicationJournal.lockSource', 'publicationJournal.shareWorktree', 'publicationJournal.shareWorktreeOwner', 'publicationJournal.recoveryStaging'] },
  putPage: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  readFactSnapshots: { refuses: 'a lock request refuses outright (facts-repair.ts refuseMember)' },
  reclaimStalledJobs: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  replaceDerivedAliases: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  replaceDerivedLinks: { sites: ['replaceDerivedLinks.wanted'] },
  replaceDerivedLinksBatch: { sites: ['replaceDerivedLinksBatch.wanted'] },
  reserveChronicleJudgeSlot: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  reserveClientSpend: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  reserveGroupSpend: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  reservePageEmbedding: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  restorePage: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  sealChunks: { atomic: 'the write is a compare-and-set on the page revision the read returned (expectedRevision)' },
  setPageAliases: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  settleBudgetReservation: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  stageSegmentChunks: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  stampWorktreeHeartbeats: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  storeSegmentDerivationsIfLive: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  sweepSegments: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  touchAccessTokenLastUsed: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  transaction: { notALock: 'the transaction itself: it takes the store writer (RustEngine.transaction)' },
  updatePageContextualRetrievalState: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  updateSlug: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  upsertChunks: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  upsertOpFileRow: { atomic: 'one store write: atomic in both store modes, the SQL lock covers only rows the same statement writes' },
  writerAdminStore: { sites: ['writerAdmin.lockBrain', 'writerAdmin.lockWorktree', 'writerAdmin.assertAdminUnlocked'] },
  writerReleaseStore: { sites: ['writerRelease.shareBrain', 'writerRelease.lockWorktreesAndSources', 'writerRelease.lockCycleLocks', 'writerRelease.shareWorktree', 'writerRelease.configuredSources'] },
};

/** Files that state the single-writer model or name a SQL lock, and hold no skip of their own: why. */
const NOT_A_SKIP: Readonly<Record<string, string>> = {
  'rust/crates/gbrain-napi/src/families/access_rules.rs': 'napi doc of lockAccessPolicy; the store fn asserts (access_policy.rs)',
  'rust/crates/gbrain-store/src/chronicle_ledger.rs': 'reserveChronicleJudgeSlot is one store write: atomic in both store modes, no lock outlives it',
  'rust/crates/gbrain-store/src/chronicle_state.rs': 'the upsert is one store write; the SQL takes no lock that outlives it',
  'rust/crates/gbrain-store/src/cli_reads/doctor_fence.rs': 'readFencePassHorizon is a clock read, not a lock skip',
  'rust/crates/gbrain-store/src/config.rs': 'ensure_config serves lockContentDriftState, which asserts in its TypeScript member',
  'rust/crates/gbrain-store/src/eval_capture/decide_proposals.rs': 'the `lock` option is dropped by getDecideProposal / getDecideReviewProposal, which assert',
  'rust/crates/gbrain-store/src/facts/cycle.rs': 'read_live_stored_body takes no lock flag; the served readLiveStoredBody member asserts when locked',
  'rust/crates/gbrain-store/src/facts/loops.rs': 'the `lock` option is dropped by readLoopFactState, which asserts',
  'rust/crates/gbrain-store/src/facts/purge_journal.rs': 'its reads take no lock; the FOR UPDATE OF e reads are persistence/purge_effects.rs, which assert',
  'rust/crates/gbrain-store/src/facts/write_path.rs': 'lockSourceShared is served in TypeScript (facts-write-path.ts), which asserts',
  'rust/crates/gbrain-store/src/fjall_kv.rs': 'record store infrastructure (the single-writer turn itself)',
  'rust/crates/gbrain-store/src/generations/activations.rs': 'lockGenerationKey is served in TypeScript (fence-holds.ts), which asserts',
  'rust/crates/gbrain-store/src/identity_reviews.rs': 'applyIdentityDecisions is one store write: atomic in both store modes',
  'rust/crates/gbrain-store/src/import_members.rs': 'its writes are single store writes; the SQL FOR UPDATE covers only rows the same statement writes',
  'rust/crates/gbrain-store/src/jobs/credential_binding.rs': 'the lock reads are asserted by their TypeScript members (readCredentialBindingForUpdate, the write-grant reads)',
  'rust/crates/gbrain-store/src/journal.rs': 'admission is one store write; the comment describes the mode, not a skip',
  'rust/crates/gbrain-store/src/kv.rs': 'record store infrastructure (defines serializes_explicit_transactions)',
  'rust/crates/gbrain-store/src/lib.rs': 'Store core (defines assert_serialized_transactions)',
  'rust/crates/gbrain-store/src/memory_mutation_reads.rs': 'the `lock` option is dropped by readForgetTarget / readFactWithdrawalClaim, which assert',
  'rust/crates/gbrain-store/src/mention_state.rs': 'the advisory locks are served in TypeScript (mention-pass.ts), which asserts',
  'rust/crates/gbrain-store/src/occ_kv.rs': 'record store infrastructure (the concurrent store)',
  'rust/crates/gbrain-store/src/page_body/derivation_sweep.rs': 'the comment is about batch timeouts, not a lock',
  'rust/crates/gbrain-store/src/page_body/segmented_embedding.rs': 'a loop variable named update, not a lock',
  'rust/crates/gbrain-store/src/page_embedding_budget.rs': 'reservePageEmbedding is one store write: atomic in both store modes',
  'rust/crates/gbrain-store/src/persistence/publication.rs': 'publicationJournalWrite is one store write; the lock members are asserted in publication-journal.ts',
  'rust/crates/gbrain-store/src/persistence/worktree_admission.rs': 'the lock option is dropped by readWorktreeAdmission, which asserts',
  'rust/crates/gbrain-store/src/persistence/worktrees/release.rs': 'the release locks are asserted by writer-release.ts',
  'rust/crates/gbrain-store/src/raw_files/ops.rs': 'the upload reads the page slug inside its own store write; the SQL FOR SHARE covers only that statement',
  'rust/crates/gbrain-store/src/redb_kv.rs': 'record store infrastructure (the snapshot copy writes a new file it alone owns)',
  'rust/crates/gbrain-store/src/snapshot.rs': 'store snapshot copy: names the single-writer record store, not a lock skip',
  'rust/crates/gbrain-store/src/trust/proposals.rs': 'the `lock` option is dropped by getTrustProposal, which asserts',
  'rust/crates/gbrain-store/src/write_misc.rs': 'the `lock` option is dropped by readSourceState, which asserts',
  'rust/crates/gbrain-store/src/write_trust.rs': 'a test comment about one transaction per store handle (design note, tests that bake in a single writer)',
  'src/core/access/policy.ts': 'lockSource calls lockAccessPolicy, which asserts in the store',
  'src/core/belief/coverage.ts': 'lockSourceRow asserts (cli-sources.ts)',
  'src/core/bootstrap/harness.ts': '"one writer" of a config file, not the store',
  'src/core/engine-members/facts-statements.ts': '"one writer" of a table, not a lock',
  'src/core/engine-members/ledgers.ts': 'interface docs; the Rust members assert',
  'src/core/engine-sql/access-credentials.ts': 'SQL engine docs; the Rust members assert (readOauthCodeForUpdate, readOauthRefreshTokenForUpdate)',
  'src/core/engine-sql/facts-purge.ts': '"one writer" of a table, not a lock',
  'src/core/engine-sql/oauth-clients.ts': 'patchOauthClient is one statement and one store write: atomic in both store modes',
  'src/core/engine-sql/page-purge.ts': 'its caller holds lockSourceRow, which asserts',
  'src/core/engine-sql/writer-admin.ts': 'SQL engine docs; readWriterAdminState asserts when locked',
  'src/core/engine.ts': 'interface docs; the Rust members assert',
  'src/core/error-registry.ts': 'an error reason name (multiple_writer_hosts), not a lock',
  'src/core/output/writer.ts': 'createEntity calls lockPageKeys, which asserts in the store',
  'src/core/persistence/pool-capacity.ts': 'publisher pool sizing, not a lock',
  'src/core/persistence/unbound-source.ts': 'single-process ownership (one owner process), not a transaction lock',
  'src/core/rust-engine.ts': 'the writer gate itself (RustEngine.transaction)',
  'src/core/rust-engine/errors.ts': 'defines assertSerializedTransactions',
  'src/core/rust-engine/members/ledgers.ts': 'member table comment; getDecideProposal / getDecideReviewProposal assert',
  'src/core/rust-engine/owner-ipc/typed-member-classes.ts': 'owner IPC read/write classes, not a lock skip',
  'src/core/rust-engine/store-members/access-policy.ts': 'forwards to lockAccessPolicy, which asserts in the store',
  'src/core/rust-engine/store-members/chronicle-ledger.ts': 'reserveChronicleJudgeSlot is one store write: atomic in both store modes',
  'src/core/rust-engine/store-members/dream-config.ts': 'forwards to lockDreamMapConfigRow, which asserts in the store',
  'src/core/rust-engine/store-members/effect-scans.ts': 'forwards to lockEffectRow, which asserts in the store',
  'src/core/rust-engine/store-members/facts-purge-journal.ts': 'forwards to listGitEffectsCarryingReason / listPageGitEffectsForStrip, which assert in the store',
  'src/core/rust-engine/store-members/facts-repair.ts': 'readFactSnapshots refuses `lock` outright (already fail closed)',
  'src/core/rust-engine/store-members/git-gap-census.ts': 'a transaction setting, not a lock',
  'src/core/rust-engine/store-members/import-members.ts': 'its writes are single store writes; the SQL FOR UPDATE covers only rows the same statement writes',
  'src/core/rust-engine/store-members/jobs-access-tokens.ts': 'forwards to lockActiveAccessTokens / lockLegacyAccessTokens / readOauthCodeForUpdate, which assert in the store',
  'src/core/rust-engine/store-members/page-body.ts': 'forwards to lockBodyStagingState, which asserts; flipBodyGeneration and sweepSegments are single store writes',
  'src/core/rust-engine/store-members/page-embedding-budget.ts': 'reservePageEmbedding is one store write: atomic in both store modes',
  'src/core/rust-engine/store-members/page-purge-journal.ts': 'the request lock is lockWriteRequestsById, which asserts (persistence.ts)',
  'src/core/rust-engine/store-members/page-purge-sweep.ts': 'the deletes are single store writes; the caller holds lockSourceRow, which asserts',
  'src/core/rust-engine/store-members/page-purge.ts': 'the delete is one store write; the caller holds lockSourceRow, which asserts',
  'src/core/rust-engine/store-members/segmented-writes.ts': 'forwards to lockSegmentedGenerationPage, which asserts in the store',
  'src/core/rust-engine/store-members/sync-hold-store.ts': 'each member is one store write: atomic in both store modes',
  'src/core/rust-engine/store-members/trust-tier-reads.ts': 'forwards to lockLivePagesByKey, which asserts in the store',
  'src/core/rust-engine/store-members/withdrawal-commit.ts': 'forwards to lockFactForWithdrawal, which asserts in the store',
  'src/core/rust-engine/store-members/withdrawal-pages.ts': 'the invalidation is one store write: atomic in both store modes',
};

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (name.endsWith(ext)) out.push(relative(ROOT, path));
  }
  return out;
}

const FILES = [
  ...walk(join(ROOT, 'rust/crates/gbrain-store/src'), '.rs'),
  ...walk(join(ROOT, 'rust/crates/gbrain-napi/src'), '.rs'),
].sort().concat(walk(join(ROOT, 'src'), '.ts').sort());
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const found: Record<string, string[]> = {};
const stray: Record<string, number> = {};
const flagged: string[] = [];
for (const file of FILES) {
  const text = read(file);
  const marks = file.endsWith('.rs') ? rustMarks(text) : tsMarks(file, text);
  if (marks.sites.length) found[file] = marks.sites;
  if (marks.stray) stray[file] = marks.stray;
  if (!marks.sites.length && discovered(file, text)) flagged.push(file);
}
const allSites = new Set(Object.values(found).flat());

describe('lock skips that rely on one writer fail closed (serialized_transactions)', () => {
  test('the inventory reads locking members from the code (positive controls)', () => {
    const locking = lockingMembers();
    // TypeScript-only skips (no store call on Rust) and Rust-side skips are both in it.
    for (const member of ['lockMentionSources', 'lockMentionEntries', 'lockSourceForUpdate', 'lockPageKeys', 'readOauthCodeForUpdate']) {
      expect(locking.has(member)).toBe(true);
    }
    expect(locking.has('getPage')).toBe(false);
  });

  test('every Rust-served locking member has an executed assertion or a stated reason', () => {
    const served = new Set(Object.keys(STORE_MEMBERS));
    const locking = [...lockingMembers().keys()];
    expect(uncoveredLockingMembers(locking, served, allSites, DISPOSITIONS)).toEqual([]);
    // No stale disposition: each still names a served locking member that holds no site of its own name.
    expect(Object.keys(DISPOSITIONS).filter(m => !locking.includes(m) || !served.has(m) || allSites.has(m))).toEqual([]);
  });

  test('marks sit on real assertion calls only', () => {
    expect(stray).toEqual({});
  });

  test('the marked sites match the pinned baseline', () => {
    expect(baselineDrift(found, SITES)).toEqual([]);
  });

  test('every site id is unique and has a refusal case naming it', () => {
    expect(duplicateSites(found)).toEqual([]);
    expect(sitesWithoutCases(found, read(TS_CASES), read(RUST_CASES))).toEqual([]);
  });

  test('a file that states the single-writer model or names a SQL lock holds a marked skip or says why not', () => {
    expect(flagged.filter(file => !(file in NOT_A_SKIP))).toEqual([]);
  });

  test('NOT_A_SKIP lists only files discovery still flags', () => {
    const now = new Set(flagged);
    expect(Object.keys(NOT_A_SKIP).filter(file => !now.has(file))).toEqual([]);
  });
});

describe('the guard checks on fixtures', () => {
  test('unrelated "writer gate" prose outside Rust engine code is not discovery; the same words about the Rust store are', () => {
    expect(discovered('src/core/persistence/x.ts', '// waits on the segmented-storage writer gate of an old binary')).toBe(false);
    expect(discovered('src/core/persistence/x.ts', '// on Rust the store runs one write transaction at a time')).toBe(true);
    expect(discovered('src/core/rust-engine/store-members/x.ts', '// the writer gate already serializes this')).toBe(true);
    expect(discovered('rust/crates/gbrain-store/src/x.rs', '/// reads the row FOR UPDATE on Postgres')).toBe(true);
    expect(SINGLE_WRITER.test('PGLite holds the single-writer lock')).toBe(true);
  });

  test('a missing check: a mark in a comment or string, or with a computed id, is stray and counts no site', () => {
    const ts = `// assertStoreSerializedTransactions(brain, 'inComment');\nconst s = "assertSerializedTransactions(e, 'inString')";\nassertStoreSerializedTransactions(brain, name);\nassertStoreSerializedTransactions(brain, 'real');`;
    expect(tsMarks('x.ts', ts)).toEqual({ sites: ['real'], stray: 3 });
    const rs = `// self.assert_serialized_transactions("inComment")?;\n/* store.assert_serialized_transactions("inBlock") */\nself.assert_serialized_transactions("real")?;\npub fn assert_serialized_transactions(&self, site: &str) {}`;
    expect(rustMarks(rs)).toEqual({ sites: ['real'], stray: 2 });
    expect(sitesWithoutCases({ 'a.ts': ['covered', 'uncovered'], 'b.rs': ['rustSite'] }, "['covered', run]", '')).toEqual(['a.ts: uncovered', 'b.rs: rustSite']);
  });

  test('duplicate ids and baseline drift are reported', () => {
    expect(duplicateSites({ 'a.ts': ['x', 'y'], 'b.rs': ['x'] })).toEqual(['x']);
    expect(baselineDrift({ 'a.ts': ['x', 'y'] }, { 'a.ts': ['x'], 'c.ts': ['z'] })).toEqual(['a.ts: found [x,y], pinned [x]', 'c.ts: found [], pinned [z]']);
  });

  test('an uncovered locking member, or a disposition naming an unmarked site, is reported', () => {
    const served = new Set(['lockA', 'lockB', 'lockC', 'store']);
    const sites = new Set(['lockA', 'store.lock']);
    expect(uncoveredLockingMembers(['lockA', 'lockB', 'lockC', 'store', 'unserved'], served, sites,
      { lockC: { atomic: 'one write' }, store: { sites: ['store.lock', 'store.share'] } }))
      .toEqual(['lockB: no marked site and no disposition', 'store: names site store.share, which is not marked']);
  });
});
