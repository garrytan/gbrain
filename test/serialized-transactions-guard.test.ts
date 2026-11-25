/**
 * Lock skips fail closed (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1).
 *
 * The Rust engine skips locks PGLite and Postgres take (row locks, advisory locks, `SKIP LOCKED`, page-key locks), which
 * is safe only while explicit transactions hold the store's writer (`serialized_transactions`). Every such skip asserts
 * the capability first: `assertSerializedTransactions(engine, site)` (rust-engine/errors.ts),
 * `assertStoreSerializedTransactions(brain, site)` (rust-engine/store-members/common.ts) or
 * `Store::assert_serialized_transactions(site)` (gbrain-store lib.rs). This guard:
 *
 * 1. counts the marked sites per file against SITES, so a removed assertion fails here;
 * 2. requires a refusal case for every site (TypeScript: test/serialized-transactions-ts-sites.test.ts, Rust:
 *    rust/crates/gbrain-store/tests/serialized_transactions.rs), each naming the site;
 * 3. finds unmarked skips: a file that states the single-writer model (the phrases below) or, in Rust engine code, names
 *    a SQL lock must either hold a marked site or be listed in NOT_A_SKIP with the reason. A skip with neither a comment
 *    nor a lock word is not found this way, so this is a floor, as the design note's appendix is.
 *
 * To add a skip: assert at it, add its refusal case, and add it to SITES. To add a file whose comment only mentions the
 * single writer (or a SQL lock it does not skip): add it to NOT_A_SKIP with the reason.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** Comments that state the single-writer model as a fact (the appendix search, widened). */
const SINGLE_WRITER = /one write( transaction)? at a time|one writer|single writer|single-writer|writer gate|holds the writer|no other writer|nothing to wait for|takes no (row )?lock|no lock is needed|has nothing to (add|skip|wait)|nothing to skip|lock has nothing|locks? (is|are) (a )?no-?op|one process owns the brain|serializes? (its )?writes?\b|serialised|admits one write|store write is exclusive|write transaction is the (advisory )?lock|is the row lock|holds the whole store/i;
/** SQL lock words, checked in Rust engine code only (rust/crates, src/core/rust-engine). */
const SQL_LOCK = /FOR UPDATE|FOR SHARE|FOR KEY SHARE|FOR NO KEY UPDATE|SKIP LOCKED|advisory|row lock|share lock|LOCK TABLE/i;

const TS_MARK = /assert(?:Store)?SerializedTransactions\(\s*[\w.]+\s*,\s*'([^']+)'/g;
const RUST_MARK = /assert_serialized_transactions\(\s*"([^"]+)"/g;

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
  'rust/crates/gbrain-store/src/persistence.rs': ['lockPersistenceCounters'],
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
  'src/core/persistence/managed-mode.ts': ['readManagedMode', 'readPersistenceBrain'],
  'src/core/rust-engine/store-members/access-grants.ts': ['readOAuthClientReceiptGrant', 'readAccessTokenReceiptGrant', 'readOAuthClientMemberGrant', 'readAccessTokenMemberGrant'],
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
  'src/core/rust-engine/store-members/managed-sync-orphans.ts': ['retireManagedSyncPassSlugMode', 'readConfigForUpdate'],
  'src/core/rust-engine/store-members/memory-mutation-reads.ts': ['readForgetTarget', 'readFactWithdrawalClaim'],
  'src/core/rust-engine/store-members/mention-pass.ts': ['lockMentionSources', 'readMentionPageRevisions', 'lockMentionEntries', 'readMentionGenerations'],
  'src/core/rust-engine/store-members/persistence-admission.ts': ['readWorktreeAdmission'],
  'src/core/rust-engine/store-members/persistence.ts': ['readLocalWriterRow', 'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential', 'lockWriteRequest', 'lockWriteRequestsById', 'readSourceMembership'],
  'src/core/rust-engine/store-members/publication-journal.ts': ['publicationJournal.shareWorktreeOwner', 'publicationJournal.shareWorktree', 'publicationJournal.lockSource', 'publicationJournal.recoveryStaging'],
  'src/core/rust-engine/store-members/repair-applies.ts': ['lockApprovedFacts'],
  'src/core/rust-engine/store-members/repair-bookkeeping.ts': ['readLoopFactState', 'listConnectorSources'],
  'src/core/rust-engine/store-members/shared-skill-members.ts': ['readSharedSkillPolicyRow', 'lockSharedSkillBrainId', 'readSharedSkillMember', 'readSharedSkillDeliveryBatch'],
  'src/core/rust-engine/store-members/trust-fence.ts': ['listFenceFactRows'],
  'src/core/rust-engine/store-members/trust-proposals.ts': ['getTrustProposal'],
  'src/core/rust-engine/store-members/worktree-claim.ts': ['worktreeClaim.lockSource'],
  'src/core/rust-engine/store-members/write-guards.ts': ['readLiveStoredBody'],
  'src/core/rust-engine/store-members/write-misc.ts': ['readSourceState', 'readScopeSourceConfigs'],
  'src/core/rust-engine/store-members/writer-admin.ts': ['readWriterAdminState', 'writerAdmin.lockBrain', 'writerAdmin.lockWorktree'],
  'src/core/rust-engine/store-members/writer-release.ts': ['writerRelease.shareBrain', 'writerRelease.lockWorktreesAndSources', 'writerRelease.lockCycleLocks', 'writerRelease.shareWorktree'],
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
  'src/core/rust-engine/store-members/jobs.ts': 'job admission and claims are single store writes: atomic in both store modes',
  'src/core/rust-engine/store-members/page-body.ts': 'forwards to lockBodyStagingState, which asserts; flipBodyGeneration and sweepSegments are single store writes',
  'src/core/rust-engine/store-members/page-embedding-budget.ts': 'reservePageEmbedding is one store write: atomic in both store modes',
  'src/core/rust-engine/store-members/page-purge-journal.ts': 'the request lock is lockWriteRequestsById, which asserts (persistence.ts)',
  'src/core/rust-engine/store-members/page-purge-sweep.ts': 'the deletes are single store writes; the caller holds lockSourceRow, which asserts',
  'src/core/rust-engine/store-members/page-purge.ts': 'the delete is one store write; the caller holds lockSourceRow, which asserts',
  'src/core/rust-engine/store-members/segmented-writes.ts': 'forwards to lockSegmentedGenerationPage, which asserts in the store',
  'src/core/rust-engine/store-members/sync-hold-store.ts': 'each member is one store write: atomic in both store modes',
  'src/core/rust-engine/store-members/transactions.ts': 'the transaction members themselves (holdPageKeys asserts in the store)',
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

const RUST_FILES = [
  ...walk(join(ROOT, 'rust/crates/gbrain-store/src'), '.rs'),
  ...walk(join(ROOT, 'rust/crates/gbrain-napi/src'), '.rs'),
].sort();
const TS_FILES = walk(join(ROOT, 'src'), '.ts').sort();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

function marks(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of [...RUST_FILES, ...TS_FILES]) {
    const text = read(file);
    const found = [...text.matchAll(file.endsWith('.rs') ? RUST_MARK : TS_MARK)].map(m => m[1]!);
    if (found.length) out[file] = found;
  }
  return out;
}

/** The files the scan flags: a single-writer phrase, or (Rust engine code) a SQL lock word. */
function flagged(): string[] {
  const out: string[] = [];
  for (const file of [...RUST_FILES, ...TS_FILES]) {
    const rustEngine = file.endsWith('.rs') || file.startsWith('src/core/rust-engine');
    const lines = read(file).split('\n');
    const hit = lines.some(line => rustEngine
      ? SINGLE_WRITER.test(line) || SQL_LOCK.test(line)
      // Elsewhere in src only a line about the Rust store counts: PGLite's own single-writer lock is another thing.
      : SINGLE_WRITER.test(line) && /rust|store/i.test(line));
    if (hit) out.push(file);
  }
  return out;
}

describe('lock skips that rely on one writer fail closed (serialized_transactions)', () => {
  const current = marks();

  test('the scan finds the marks it counts (a positive control)', () => {
    expect(Object.keys(current).length).toBeGreaterThan(0);
    expect(flagged().length).toBeGreaterThan(0);
    expect(SINGLE_WRITER.test('the store runs one write transaction at a time')).toBe(true);
  });

  test('every marked site is pinned, and every pinned site is still marked', () => {
    expect(current).toEqual(SITES as Record<string, string[]>);
  });

  test('every site name is unique and has a refusal case naming it', () => {
    const names = Object.values(current).flat();
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const tsCases = read(TS_CASES);
    const rustCases = read(RUST_CASES);
    const missing = Object.entries(current).flatMap(([file, sites]) => sites.filter(site =>
      file.endsWith('.rs') ? !rustCases.includes(`"${site}"`) : !tsCases.includes(`'${site}'`)).map(site => `${file}: ${site}`));
    expect(missing).toEqual([]);
  });

  test('a file that states the single-writer model or names a SQL lock holds a marked skip or says why not', () => {
    const unexplained = flagged().filter(file => !(file in SITES) && !(file in NOT_A_SKIP));
    expect(unexplained).toEqual([]);
  });

  test('NOT_A_SKIP lists only files the scan still flags and that hold no marked skip', () => {
    const now = new Set(flagged());
    expect(Object.keys(NOT_A_SKIP).filter(file => !now.has(file) || file in current)).toEqual([]);
  });
});
