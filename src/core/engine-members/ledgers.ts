/**
 * The belief ledger, session state and open loop statements of BrainEngine.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AccessCoverageRow, AccessPolicyMarks, AccessRestampWindow, AccessRevisionInsert, AccessRevisionQuery, AccessRevisionRow, AccessRuleChanges, AccessRuleRow } from '../engine-sql/access-policy.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessGroupRow, AccessMemberLookup, AccessMemberRow, AppliedPolicyRevision, AudiencePrincipalRows, FolderAccessRows, JobPrincipalKind, LiveMemberRow, MayActForVia, MemberBindingVia, OwnerCredentialRow, PageNamingReaderRow } from '../engine-sql/access-control.ts';
import type { AccessMigrationRow, LiveAccessTokenRow, MemberKeyReadingRow, OpenPageCount, OpenPageExclusion, PeopleFolderCount } from '../engine-sql/access-setup.ts';
import type { AccessTokenGrantWrite, AccessTokenListRow, AccessTokenPrivateAxis, ActiveTokenGrantField, ActiveTokenTarget, DeletedOAuthClient, LegacyTokenGrantColumns, OauthClientGrantInsert, OauthClientProbe, OauthCodeInsert, OauthCodeRow, OauthTokenInsert, OauthTokenRow, OauthTokenRung, ScopeSourceLock, TokenByHashCaller } from '../engine-sql/access-credentials.ts';
import type * as BeliefLedgerSql from '../engine-sql/belief-ledger.ts';
import type { DeltaSessionRow, SessionCursorRow, SessionStateWrite } from '../engine-sql/session-state.ts';
import type { FactsFencePagesQuery, SweepDeferredPageRow, SweepDeferredPagesQuery, SweepPageRefRow, SweepStalePageRow, SweepStalePagesQuery } from '../engine-sql/sweep-reads.ts';
import type { OauthClientGrantPersist, OauthGrantAuditRow } from '../engine-sql/client-grants.ts';
import type { OauthClientRow } from '../engine-sql/oauth-clients.ts';
import type { OauthGrantAuditInsert } from '../engine-sql/oauth-revocation.ts';
import type { ListLoopsOpts as OpenLoopListOpts, LoopStatus as OpenLoopStatus, OpenLoopUpsert as OpenLoopUpsertInput } from '../loops/loops-store.ts';
import type * as OpenLoopsSql from '../engine-sql/open-loops.ts';
import type * as BeliefPurgeSql from '../engine-sql/belief-purge.ts';
import type * as BeliefPurgeLedgerSql from '../engine-sql/belief-purge-ledger.ts';
import type * as BeliefStateSql from '../engine-sql/belief-state.ts';
import type * as ReadSharedSourcesSql from '../engine-sql/read-shared-sources.ts';
import type * as PinnedQuestionsSql from '../engine-sql/pinned-questions.ts';
import type * as VolunteerEventsSql from '../engine-sql/volunteer-events.ts';
import type * as ChronicleLedgerSql from '../engine-sql/chronicle-ledger.ts';
import type * as RetrievalFeedbackSql from '../engine-sql/retrieval-feedback.ts';
import type * as GitGapCensusSql from '../engine-sql/git-gap-census.ts';

export interface LedgerMembers {
  // Belief ledger writes (engine-sql/belief-ledger.ts). Each runs the statement its caller in src/core/belief/ ran through executeRaw.
  /** The fingerprints among `factFps` and `takeFps` that a fact or take purge of the source tombstoned (subject '*' included). No set order. */
  readBeliefTombstones(sourceId: string, factFps: readonly string[], takeFps: readonly string[]): Promise<string[]>;
  /** Of `claims`, each one the ledger recorded under its pre-v341 Postgres fingerprint, with that fingerprint (belief/legacy-fingerprint.ts). A claim with none is absent; the Rust store never held one, so it answers none. */
  readLegacyClaimFingerprints(sourceId: string, claims: readonly string[]): Promise<BeliefLedgerSql.LegacyClaimFingerprintRow[]>;
  /** The `claimFp` of each probe whose claim a purge of the source tombstoned under its current or its pre-v341 fingerprint. No set order; the Rust store answers none. */
  readLegacyBeliefTombstones(sourceId: string, probes: readonly BeliefLedgerSql.LegacyTombstoneProbe[]): Promise<string[]>;
  /** The coverage state of the source's current incarnation: its newest coverage event other than `coverage.restored`, or null. */
  readLatestBeliefCoverage(sourceId: string): Promise<BeliefLedgerSql.BeliefCoverageRow | null>;
  /** Whether `slug` of the source has a baseline event of run `runId`. */
  hasBeliefBaseline(sourceId: string, slug: string, runId: string): Promise<boolean>;
  /** The source's slugs (pages, then page-less database-only fact subjects) lacking a baseline of run `runId`, after `after` and not in `skip`; the first `limit` in byte order. */
  listBeliefBaselinePending(sourceId: string, runId: string, after: string, skip: readonly string[], limit: number): Promise<string[]>;
  /** The slugs the drift scan may check in the source's incarnation (pages, page-less fact subjects, open lifetimes), most recently touched first and in byte order within a tie. */
  listBeliefDriftCandidates(sourceId: string, incarnation: string): Promise<string[]>;
  /** The newest event of `slug` in the source's incarnation other than a coverage event or a backfill, or null. */
  readNewestBeliefEvent(sourceId: string, incarnation: string, slug: string): Promise<BeliefLedgerSql.BeliefNewestEventRow | null>;
  /** How many distinct slugs of the source have a baseline event of run `runId`. */
  countBeliefBaselineSlugs(sourceId: string, runId: string): Promise<number>;
  /** The source's suppressions on any of `subjectKeys` or on a field whose text hashes to one of `fieldHashes`. No set order. */
  readBeliefRedactions(sourceId: string, subjectKeys: readonly string[], fieldHashes: readonly string[]): Promise<BeliefLedgerSql.BeliefSuppression[]>;
  /** Copies one suppression onto a successor subject; returns the new suppression's id. */
  insertBeliefRedaction(row: BeliefLedgerSql.BeliefRedactionInsert): Promise<number>;
  /** An owner release: binds the suppressions `ids` to `publicationId` and the hash of the value that replaced the redacted text. */
  releaseBeliefRedactions(ids: readonly number[], publicationId: string, releasedHash: string): Promise<void>;
  /** Inserts the event rows in `ord` order, skipping an event key already recorded; returns how many were inserted. */
  insertBeliefEvents(rows: readonly BeliefLedgerSql.BeliefEventInsertRow[]): Promise<number>;
  /** The post-commit mark of each publication with a committed event: one observation time, never below its newest event, never replaced. */
  markBeliefCommits(publicationIds: readonly string[]): Promise<void>;
  /** The open page lifetime at each (incarnation, slug) pair that has one. No set order. */
  readOpenBeliefLifetimes(pairs: readonly { incarnation: string; slug: string }[]): Promise<BeliefLedgerSql.BeliefLifetimeRow[]>;
  /** Ends the page lifetime if it is still open. */
  endBeliefLifetime(lifetime: string): Promise<void>;
  /** Opens the page lifetime `mint.lifetime` at its pair; when one is already open there, returns that one instead. */
  mintBeliefLifetime(mint: BeliefLedgerSql.BeliefLifetimeMint): Promise<string>;
  /** A rename keeps the page lifetime: it moves to `slug`, with `pageId` as its new hint. */
  renameBeliefLifetime(lifetime: string, slug: string, pageId: number): Promise<void>;
  /** The open lifetime of each of `pageIds` whose page still has the lifetime's slug. No set order. */
  readMovedBeliefLifetimes(pageIds: readonly number[]): Promise<BeliefLedgerSql.BeliefMovedLifetimeRow[]>;
  /** The raw state of belief streams in one read (belief/state.ts shapes it): pages, write counters, facts, takes, owned links and transitions, their endpoints and the writer tier. Restores `plan_cache_mode` to `input.planModePrev` (null: no net change). */
  readBeliefStateRows(input: BeliefStateSql.BeliefStateRowsInput): Promise<BeliefStateSql.BeliefStateRows>;
  /** Fact rows by id in the state read's columns, for a guard event whose row is outside the batch's streams. No set order. */
  readBeliefFactsById(ids: readonly number[]): Promise<Array<Record<string, unknown>>>;
  // The belief side of a purge (engine-sql/belief-purge.ts). Each runs the statement belief/purge.ts or purge-mirror.ts ran through executeRaw.
  /** Raises the source's purge epoch by one; the new epoch, or null for an unknown source. Write; run it in the purge transaction. */
  bumpSourcePurgeEpoch(sourceId: string): Promise<number | null>;
  /** Whether the source has any belief event, of any incarnation. */
  hasBeliefEvents(sourceId: string): Promise<boolean>;
  /** Records a purge suppression unless the same (source, subject, field, request, hash) is recorded. Write. */
  registerPurgeRedaction(row: BeliefPurgeSql.PurgeRedactionInsert): Promise<void>;
  /** Releases one field's suppressions on a subject to the hash of its current text; the purge request of each released row, no set order. Write. */
  releasePurgeRedactionsForField(row: BeliefPurgeSql.PurgeRedactionRelease): Promise<string[]>;
  /** The restore replay's page purge tombstones under the slug; a hash already tombstoned takes the new slug and request and keeps its time. Write. */
  replayPagePurges(row: BeliefPurgeSql.ReplayPagePurges): Promise<void>;
  /** What the restored archive has that the purge replay probes: which of `stores` exist, page_versions.change_reason, persistence_brain, derivation_inputs, belief_events. */
  readPurgeReplaySchema(stores: readonly string[]): Promise<BeliefPurgeSql.PurgeReplaySchema>;
  // The belief-ledger half of a purge (engine-sql/belief-purge-ledger.ts). Each runs the statement belief/purge.ts or belief/preimages.ts ran through executeRaw.
  /** The stream slug of each derived row of the source, as `facts:<id>`, `takes:<id>` and `pages:<id>` refs. No set order. */
  listDerivedStreamSlugs(sourceId: string, factIds: readonly number[], takeIds: readonly number[], pageIds: readonly number[]): Promise<Array<{ ref: string; slug: string }>>;
  /** The 1-based positions of the (page, revision) pairs no version of the page holds. No set order. */
  listMissingPreimages(pageIds: readonly number[], revisions: readonly string[]): Promise<number[]>;
  /** Clears the recorded values of the source's fact and take events with the fingerprints (and, on a SQL engine, the legacy ones) and of the lifetimes' events; how many it marked. Write. */
  redactPurgedBeliefKeys(input: BeliefPurgeLedgerSql.RedactPurgedKeysInput): Promise<number>;
  /** The next 1000 fact, take and link events of the source after `after` with a context or resolution source, in id order. */
  listBeliefCarrierEvents(sourceId: string, after: number): Promise<BeliefPurgeLedgerSql.BeliefCarrierEvent[]>;
  /** One event's value, value hash and redacted fields, or null. */
  readBeliefEventValue(sourceId: string, id: number): Promise<BeliefPurgeLedgerSql.BeliefEventValue | null>;
  /** Rewrites one event's value, value hash and redacted fields; its prior hash stays only while an earlier event of the subject has it. Write. */
  rewriteBeliefEventFields(input: BeliefPurgeLedgerSql.BeliefEventRewrite): Promise<void>;
  /** The subject's events after `afterId` chained to `oldHash` take `newHash`. Write. */
  rechainBeliefPriorHash(input: BeliefPurgeLedgerSql.BeliefPriorRechain): Promise<void>;
  /** The next 1000 live facts, takes or links of the source after `after` whose carrying field is not empty, in id order. */
  listBeliefQuotingRows(kind: BeliefPurgeLedgerSql.BeliefQuotingKind, sourceId: string, after: number): Promise<BeliefPurgeLedgerSql.BeliefQuotingRow[]>;
  /** The page's lifetimes: the open one at the slug with no page hint and every one hinted at the page. No set order. */
  listPageBeliefLifetimes(sourceId: string, slug: string, pageId: number): Promise<string[]>;
  /** Each distinct claim of the page's facts and takes, with its fingerprint. No set order. */
  listPagePurgeLiveClaims(sourceId: string, slug: string, pageId: number): Promise<Array<{ claim: string; fp: string }>>;
  /** The next 1000 versions of the page after `after`, in id order: id, compiled_truth and timeline. */
  listPageVersionFenceBodies(pageId: number, after: number): Promise<Array<{ id: number; compiled_truth: string; timeline: string | null }>>;
  /** The next 1000 fact and take events of the source's lifetimes after `after`, in id order: id, recorded claim and fingerprint. */
  listLifetimeClaimEvents(sourceId: string, lifetimes: readonly string[], after: number): Promise<Array<{ id: number; claim: string | null; claim_fp: string | null }>>;
  /** The source's versions among `versionIds`, in id order, with their page, slug and whether the page passes the no-caller page policy. */
  listPurgeCarrierVersions(sourceId: string, versionIds: readonly number[]): Promise<BeliefPurgeLedgerSql.PurgeCarrierVersion[]>;
  /** The subject keys among `keys` that have an event in the source. No set order. */
  listKnownBeliefSubjectKeys(sourceId: string, keys: readonly string[]): Promise<string[]>;

  /**
   * Whether a page known by its slug sits under an applied folder rule, a pending or invalid folder prefix, or the
   * database role cannot read the folder access tables. A failed read throws; callers that count it as restricted catch.
   */
  isFolderRestricted(sourceId: string, slug: string): Promise<boolean>;

  /** Each source with folder access state and its newest applied folder-rule revision (null when none is applied), by source id. */
  listAppliedPolicyRevisions(): Promise<AppliedPolicyRevision[]>;

  /**
   * The live (enabled, not tombstoned) access member `key` names through `via` (the member id, the config key's value,
   * a live legacy token or a live OAuth client), with its groups; null when there is none. A failed read throws
   * unchanged (access/caller.ts tells a schema older than the member tables from a transient failure).
   */
  readLiveMember(via: MemberBindingVia, key: string): Promise<LiveMemberRow | null>;

  /**
   * The applied folder rules any of `readers` meets (none read when `readers` is empty) and every folder prefix that
   * reads as nobody, `!unreadable` included when this database role cannot read the folder access tables. Runs through
   * this engine's executeRaw; a failure throws (access/caller.ts folderAccessForAll counts it as fail closed).
   */
  readFolderAccess(readers: readonly string[]): Promise<FolderAccessRows>;

  // Session state (engine-sql/session-state.ts): the session_context_state statements context/session-state.ts ran
  // through executeRaw. Keys arrive resolved (client id and session id capped); a failure throws unchanged.
  /** Inserts or updates one session cursor row in one statement; resolves the row's incomplete-wake counter. */
  upsertSessionState(sourceId: string, clientId: string, sessionId: string, write: SessionStateWrite): Promise<number>;
  /** The session cursor row context_pack reads (wake time as microsecond ISO UTC text), or null when there is none. */
  readSessionCursor(sourceId: string, clientId: string, sessionId: string): Promise<SessionCursorRow | null>;
  /** delta's session row (both cursors as microsecond ISO UTC text, the counter as a number), or null when there is none. */
  readDeltaSessionRow(sourceId: string, clientId: string, sessionId: string): Promise<DeltaSessionRow | null>;
  /** The session's stored checkpoint manifest, or null when the session has no row. */
  readCheckpointManifestRow(sourceId: string, clientId: string, sessionId: string): Promise<{ checkpoint_manifest: unknown } | null>;
  /** Replaces the session's checkpoint manifest, creating the row when there is none. */
  writeCheckpointManifest(sourceId: string, clientId: string, sessionId: string, manifest: readonly unknown[]): Promise<void>;
  /** Deletes every session row last written more than `olderThanDays` (a whole number >= 1) days ago. */
  ageOutSessionState(olderThanDays: number): Promise<void>;
  /** Keeps the newest `maxRowsPerClient` (a whole number >= 1) session rows of each (source_id, client_id). */
  capSessionStatePerClient(maxRowsPerClient: number): Promise<void>;

  /**
   * The stored may_act_for of one caller (`via` names where it is stored; `key` is the token id, the client id or the
   * config key): a live token's or client's list, null when the row is revoked, deleted or absent; the stdio config text as stored.
   */
  readMayActFor(via: MayActForVia, key: string): Promise<string[] | string | null>;

  /**
   * The stored row of a queued remote job's principal (an OAuth client's grant columns, or the whole legacy token row),
   * revoked and deleted rows included; null when there is none. minions/submission-authority.ts decides what it permits.
   */
  readJobPrincipal(principal: { kind: JobPrincipalKind; id: string }): Promise<Record<string, unknown> | null>;

  /** Which of `memberIds` are enabled members (with their groups) and which of `groupIds` exist; an empty list reads nothing. */
  readAudiencePrincipals(memberIds: readonly string[], groupIds: readonly string[]): Promise<AudiencePrincipalRows>;

  /**
   * The folder-rule policy members access/policy.ts runs (engine-sql/access-policy.ts says what each reads or writes).
   * lockAccessPolicy, applyAccessRuleChanges, finishAccessRestamp and the revision writes belong inside one transaction.
   */
  readAccessStoreConfig(sourceId: string): Promise<{ store: string | null } | null>;
  writeAccessStoreConfig(sourceId: string, store: string): Promise<void>;
  ensureAccessPolicyState(sourceId: string): Promise<void>;
  lockAccessPolicy(sourceId: string): Promise<void>;
  listAccessRules(sourceId: string): Promise<AccessRuleRow[]>;
  readAccessPolicyRevisions(query: AccessRevisionQuery): Promise<AccessRevisionRow[]>;
  listAccessCoverage(sourceId: string): Promise<AccessCoverageRow[]>;
  readAccessStateUnreadable(): Promise<boolean>;
  applyAccessRuleChanges(sourceId: string, changes: AccessRuleChanges): Promise<void>;
  restampAccessWindow(sourceId: string, after: number, batch: number): Promise<AccessRestampWindow>;
  finishAccessRestamp(sourceId: string): Promise<number>;
  /** The pages of the source whose kept folder rule ids differ from the rules that cover them now (what a restamp would change). */
  countAccessFolderDrift(sourceId: string): Promise<number>;
  insertAccessPolicyRevision(row: AccessRevisionInsert): Promise<void>;
  markAccessRevisionsApplied(sourceId: string, upTo?: number): Promise<void>;
  approveAccessPolicyRevision(sourceId: string, revision: number, actor: string): Promise<void>;
  hasAccessPolicyState(sourceId: string): Promise<boolean>;
  listAccessPrefixSlugs(sourceId: string, prefixes: string | readonly string[]): Promise<string[]>;
  readAccessPolicyMarks(sourceId: string, operationId?: string): Promise<AccessPolicyMarks>;
  replaceAccessInvalidCoverage(sourceId: string, prefixes: readonly string[], detail: unknown): Promise<void>;
  /**
   * The access setup and policy-store members outside access/policy.ts (engine-sql/access-setup.ts says what each reads
   * or writes): the member-key setup of commands/access-serves.ts, the policy-store migration journal of
   * access/policy-migrate.ts, the policy sources of access/policy-transfer.ts and the people folders of access/serves.ts.
   */
  listUnboundTokenNames(): Promise<string[]>;
  listUnboundClientIds(): Promise<string[]>;
  readLiveAccessToken(name: string): Promise<LiveAccessTokenRow | null>;
  filterUnarchivedSourceIds(ids: readonly string[]): Promise<string[]>;
  recordTokenSetupReads(name: string, reads: readonly string[]): Promise<void>;
  listKeysReadingSource(sourceId: string): Promise<MemberKeyReadingRow[]>;
  countCompanyPages(sourceId: string): Promise<{ pages: number; calls: number }>;
  revokeAccessTokenById(id: string): Promise<void>;
  readUnfinishedAccessMigration(sourceId: string): Promise<AccessMigrationRow | null>;
  insertAccessMigration(id: string, sourceId: string, direction: string): Promise<void>;
  recordAccessMigrationPhase(id: string, phase: string, receipts: Record<string, unknown>): Promise<void>;
  switchAccessMigration(id: string, receipts: Record<string, unknown>): Promise<void>;
  listAccessPolicySources(): Promise<string[]>;
  countPeopleFolderPages(): Promise<PeopleFolderCount[]>;
  /** The maintenance sweep's facts-fence pages (engine-sql/sweep-reads.ts): newest `scanCap` recent pages, those holding a fence. */
  listFactsFencePages(q: FactsFencePagesQuery): Promise<string[]>;
  /** The sweep's links and timeline pages: recent pages whose links watermark is stale, less `exclude`, newest first. */
  listSweepStalePages(q: SweepStalePagesQuery): Promise<SweepStalePageRow[]>;
  /** Of the sweep's deferred segmented `slugs`, those still recent and stale. */
  listSweepDeferredPages(q: SweepDeferredPagesQuery): Promise<SweepDeferredPageRow[]>;
  /** The live pages of any source whose slug is in `slugs` (the links pass's refs), in no set order. */
  listPageRefsForSlugs(slugs: readonly string[]): Promise<SweepPageRefRow[]>;
  /**
   * The open pages of `sources` less each excluded prefix (access/open-pages.ts): live pages the empty-identity
   * member-access floor admits, grouped by source, top-level folder, type and whether the privacy part admits them.
   * The policy is rendered in the current access context; the caller reads it outside any caller record.
   */
  countOpenPages(sources: readonly string[], exclude: readonly OpenPageExclusion[]): Promise<OpenPageCount[]>;

  /** Access member rows with their groups: one by exact id or by declared email (any status), or all by id, removed ones only when asked. */
  readAccessMembers(by: AccessMemberLookup): Promise<AccessMemberRow[]>;

  /** Live credentials (active legacy tokens, clients not deleted): the tokens with one exact name, or those bound to one member. */
  readAccessCredentials(by: AccessCredentialLookup): Promise<AccessCredentialRow[]>;
  /** The live credentials bound to `memberId` with their grant rows, by byte order of kind, name and id (guests/owner-credentials.ts). */
  listOwnerCredentialRows(memberId: string): Promise<OwnerCredentialRow[]>;
  /** Inserts one pinned question (`ON CONFLICT (source_id, slug) DO NOTHING`); its row, or null when the slug has one (questions/store.ts). */
  insertPinnedQuestion(row: PinnedQuestionsSql.PinnedQuestionInsert): Promise<PinnedQuestionsSql.PinnedQuestionRow | null>;
  /** The row of the pinned question `(sourceId, slug)`, or null. */
  readPinnedQuestion(sourceId: string, slug: string): Promise<PinnedQuestionsSql.PinnedQuestionRow | null>;
  /** The pinned questions that pass the filter, by source id in byte order, then creation time, then id. */
  listPinnedQuestions(filter: PinnedQuestionsSql.PinnedQuestionFilter): Promise<PinnedQuestionsSql.PinnedQuestionRow[]>;
  /** Logs the volunteered pages whose page still exists, in one statement (context/volunteer-events.ts). */
  insertVolunteerEvents(rows: readonly VolunteerEventsSql.VolunteerEventInsert[]): Promise<void>;
  /** The volunteered and later-retrieved counts per match arm and channel over the last `days` days, by byte of arm then channel. */
  readVolunteerUsage(sourceIds: readonly string[], days: number): Promise<VolunteerEventsSql.VolunteerUsageRow[]>;
  /** The retention delete: removes the volunteered-page log rows older than `ttlDays` days; how many went (context/volunteer-events.ts purgeStaleVolunteerEvents). */
  deleteVolunteerEventsOlderThan(ttlDays: number): Promise<number>;
  /** Records a chronicle decision for a page revision; false when the ledger guards keep the existing row (chronicle/ledger.ts). */
  upsertChronicleRow(w: ChronicleLedgerSql.ChronicleRowUpsert): Promise<boolean>;
  /** Takes one automatic chronicle judge slot when fewer than `limit` were taken in the last 24 hours; false otherwise. */
  reserveChronicleJudgeSlot(limit: number, key: ChronicleLedgerSql.ChronicleJudgeKey): Promise<boolean>;
  /** Records retrieval events with the pages and links each returned whose page rows exist; a repeat is ignored (feedback/store.ts). */
  insertRetrievalEvents(events: RetrievalFeedbackSql.RetrievalEventInsert[]): Promise<void>;
  /** One retrieval event with its pages by rank and its links by byte of source, edge key and target, or null. */
  readRetrievalEvent(id: string): Promise<RetrievalFeedbackSql.RetrievalEventRead | null>;
  /** Each page row's content hash and learned page weight (halved toward neutral after an edit), null without one (search/feedback-boost.ts); in no set order. */
  readPageFeedbackWeights(pageIds: readonly number[]): Promise<RetrievalFeedbackSql.PageFeedbackWeightRow[]>;
  /** Applies one batch of ratings (targets already distinct): each newly stored rating moves its element's weight. */
  applyRetrievalRatings(args: RetrievalFeedbackSql.RetrievalRatingBatch): Promise<RetrievalFeedbackSql.AppliedRatingRow[]>;
  /** The Git-gap census reads (commands/sources-git-gap.ts; engine-sql/git-gap-census.ts). The source's checkout root and incarnation. */
  readGitGapSourceRow(sourceId: string): Promise<GitGapCensusSql.GitGapSourceRow | null>;
  /** The source's live pages. */
  countGitGapLivePages(sourceId: string): Promise<number>;
  /** Makes the open transaction read-only (`SET TRANSACTION READ ONLY`); the census reads run in one. */
  markTransactionReadOnly(): Promise<void>;
  /** The `limit` most recently updated live pages of the source, newest first. */
  listGitGapNewestPages(sourceId: string, limit: number): Promise<Array<{ id: string; updated_at: string }>>;
  /** The source's fenced facts on a live page that is not one of `pageIds`. */
  countGitGapUnreadFacts(sourceId: string, pageIds: readonly string[]): Promise<number>;
  /** One batch of the source's live pages by id, with the census key fields and the privacy part's verdict. */
  readGitGapPageBatch(sourceId: string, batch: GitGapCensusSql.GitGapBatch): Promise<GitGapCensusSql.GitGapPageRow[]>;
  /** The source's fenced facts on the pages at `slugs`. */
  countGitGapFactsOnPages(sourceId: string, slugs: readonly string[]): Promise<number>;
  /** The timeline rows of the pages `pageIds`. */
  countGitGapTimelineOnPages(pageIds: readonly number[]): Promise<number>;
  /** The census's source-wide rows with no Git home, hold codes and parked effect targets, each list by byte order. */
  readGitGapSourceRows(sourceId: string, derivedLinkSources: readonly string[], holdOp: string): Promise<GitGapCensusSql.GitGapSourceRows>;

  /** Revoke every active access token with this exact name; the revoked ids (none on a store that keeps no credentials). */
  revokeAccessTokensNamed(name: string): Promise<string[]>;
  /** Revoke the active access token with this id (a UUID); its name, or null when no active token has it. */
  revokeAccessToken(id: string): Promise<string | null>;
  /** Delete an OAuth client, its tokens and codes cascading; the deleted client, or null when none has this id. */
  deleteOAuthClient(clientId: string): Promise<DeletedOAuthClient | null>;
  /** One grant column (`private_pages` or `permissions`) of the active token with this id (a UUID): `{ value }`, or null. */
  readActiveAccessTokenGrant(id: string, field: ActiveTokenGrantField): Promise<{ value: unknown } | null>;
  /** Whether an active access token has this id (compared as text). */
  accessTokenLive(id: string): Promise<boolean>;
  /** Whether an OAuth client not deleted has this id. */
  oauthClientLive(clientId: string): Promise<boolean>;
  /** Which of the probe's optional `oauth_clients` columns this brain has (a store that keeps them all names them all). */
  readOauthClientColumns(probe: OauthClientProbe): Promise<string[]>;
  /** Set one OAuth client's access-token lifetime in seconds; false when no client has this id. */
  setOauthClientTokenTtl(clientId: string, ttlSeconds: number): Promise<boolean>;
  /** Insert a scoped OAuth client with its register audit row (a store that keeps no grant audit writes the client only). */
  insertOauthClientGrant(row: OauthClientGrantInsert): Promise<void>;
  /** The clients an upgrade migration clamped the token lifetime of; a brain with no grant audit table raises its error. */
  readTokenLifetimeClampedClients(): Promise<string[]>;
  /** The id and config of each source among `ids`; `lock` takes the rows in id order FOR SHARE or FOR UPDATE (a single-writer store takes none). */
  readScopeSourceConfigs(ids: readonly string[], lock?: ScopeSourceLock): Promise<{ id: string; config: unknown }[]>;
  /** The client's whole row read FOR UPDATE inside the caller's transaction (a single-writer store takes no lock), or null. */
  readOauthClientForUpdate(clientId: string): Promise<OauthClientRow | null>;
  /** Every OAuth client not deleted, whole rows (the grant checks read every credential's grant). */
  readLiveOauthClients(): Promise<OauthClientRow[]>;
  /** Every access token not revoked, whole rows (a store that keeps no attest or private columns reads their defaults). */
  readLiveAccessTokenRows(): Promise<Record<string, unknown>[]>;
  /** Every access token, revoked ones too, whole rows newest first, a tie by id (the admin key list). */
  listAccessTokenRows(): Promise<Record<string, unknown>[]>;
  /** The transaction-scoped lock on a client name key, so same-name registrations serialize (a single-writer store takes none). */
  lockOauthClientName(lockKey: string): Promise<void>;
  /** Whether the client holds an OAuth token or an authorization code (a store that keeps neither answers false). */
  oauthClientHoldsAuthorization(clientId: string): Promise<boolean>;
  /** Whether the source is archived, read FOR SHARE inside the caller's transaction; null for no such source. */
  readSourceArchivedForShare(id: string): Promise<boolean | null>;
  /** The source's archived flag and config, or null for no such source (the `--attest-sources` check). */
  readSourceAttestState(id: string): Promise<{ archived: boolean; config: unknown } | null>;
  /** Set the source's whole config (the `--attest-sources` mark). */
  replaceSourceConfig(id: string, config: Record<string, unknown>): Promise<void>;
  /** Write a client's grant while it still holds the expected revision, rewrite its legacy open jobs and append the audit row; false (nothing written) when the revision moved. */
  persistOauthClientGrant(grant: OauthClientGrantPersist): Promise<boolean>;
  /** The `after_grant` document of the client's newest audit row that records a catalog provenance, or null; a brain with no audit table raises its error. */
  readLatestCatalogProvenanceAudit(clientId: string): Promise<unknown | null>;
  /** The client's grant audit rows, oldest first. */
  listOauthGrantAudit(clientId: string): Promise<OauthGrantAuditRow[]>;
  /** Delete the OAuth token with this hash when this client owns it (a revoke naming another client deletes nothing). */
  deleteOauthTokenByHash(hash: string, clientId: string): Promise<void>;
  /** Stamp an OAuth client `deleted_at` now (a revoke); its tokens and codes are separate deletes. */
  softDeleteOauthClient(clientId: string): Promise<void>;
  /** Delete every OAuth token, access and refresh, of the client. */
  deleteOauthClientTokens(clientId: string): Promise<void>;
  /** Delete every authorization code of the client (a store that keeps none deletes none). */
  deleteOauthClientCodes(clientId: string): Promise<void>;
  /** Delete the OAuth client row (the lifecycle `delete`); its tokens and codes are separate deletes. */
  deleteOauthClientRow(clientId: string): Promise<void>;
  /** Set the client's grant revision; `revoke` also stamps `deleted_at` when the client is not already revoked. */
  setOauthClientRevision(clientId: string, revision: number, revoke: boolean): Promise<void>;
  /** GST-2898: stamps the client's read_shared_revision at `revision`, or clears it with null (engine-sql/oauth-revocation.ts). */
  setOauthClientReadSharedRevision(clientId: string, revision: number | null): Promise<void>;
  /** GST-2898: every live source with its config, guest flag, bound members and the owner member (engine-sql/read-shared-sources.ts). */
  readSharedSourceRows(): Promise<ReadSharedSourcesSql.ReadSharedSourceRow[]>;
  /** Append one row to the OAuth grant audit (the grant documents are JSON text). */
  insertOauthGrantAudit(row: OauthGrantAuditInsert): Promise<void>;
  /** The bearer check's OAuth token read at one rung of its degrade ladder. */
  readOauthAccessTokenRows(hash: string, rung: OauthTokenRung): Promise<Record<string, unknown>[]>;
  /** `auth rescope`'s whole rows (`SELECT *`) of the active tokens one id or an exact name names, locked FOR UPDATE. */
  lockActiveAccessTokens(target: ActiveTokenTarget): Promise<Record<string, unknown>[]>;
  /** `auth rescope`'s grant writes: the grant columns and mirror (one more revision; null for no token), a private grant column, and the legacy-shape tokens locked FOR UPDATE, oldest first. */
  writeAccessTokenGrant(id: string, write: AccessTokenGrantWrite): Promise<number | null>;
  writeAccessTokenPrivateGrant(id: string, axis: AccessTokenPrivateAxis, value: string): Promise<void>;
  /** GST-2898: stamps token `id`'s read_shared_revision at `revision`, or clears it with null (engine-sql/access-credentials.ts). */
  setAccessTokenReadSharedRevision(id: string, revision: number | null): Promise<void>;
  lockLegacyAccessTokens(): Promise<Record<string, unknown>[]>;
  /** The bearer check's whole row (`SELECT *`) of the token not revoked with this hash, or null. */
  readActiveAccessTokenByHash(hash: string, caller: TokenByHashCaller): Promise<Record<string, unknown> | null>;
  /** Stamp a token's `last_used_at`, debounced to once a minute. */
  touchAccessTokenLastUsed(id: string, unified: boolean): Promise<void>;
  /** Delete the OAuth tokens and codes that expired before `nowEpochSeconds`; the count of both (a store that keeps none deletes none). */
  deleteExpiredOauthCredentials(nowEpochSeconds: number): Promise<number>;
  /** Set `expires_at = 0` on every OAuth token and code (the shared-skill restore quarantine): no archived grant is honored. */
  expireAllOauthCredentials(): Promise<void>;
  /** OAuth access tokens expiring from `from` to `to` (epoch seconds, inclusive), or after `from` when `to` is null. */
  countOauthAccessTokens(from: number, to: number | null): Promise<number>;
  /** Convert an access token still on the legacy shape to its grant columns on first read; the converted row, or null when none converted. */
  convertLegacyAccessTokenGrant(id: string, columns: LegacyTokenGrantColumns): Promise<Record<string, unknown> | null>;
  /** Insert one OAuth token (the INSERTs of `OAuthGrants.issue`); a repeated hash is 23505, a client with no row 23503. */
  insertOauthToken(row: OauthTokenInsert): Promise<void>;
  /** Insert one authorization code (OAuthGrants.decide); a repeated hash is 23505, a client with no row 23503. */
  insertOauthCode(row: OauthCodeInsert): Promise<void>;
  /** The code of this hash and client taken FOR UPDATE, or null (the caller checks expiry). */
  readOauthCodeForUpdate(codeHash: string, clientId: string): Promise<OauthCodeRow | null>;
  /** Delete the code of this hash and client. */
  deleteOauthCode(codeHash: string, clientId: string): Promise<void>;
  /** The refresh token of this hash and client taken FOR UPDATE, or null (the caller checks expiry). */
  readOauthRefreshTokenForUpdate(tokenHash: string, clientId: string): Promise<OauthTokenRow | null>;
  /** Delete the refresh token of this hash and client. */
  deleteOauthRefreshToken(tokenHash: string, clientId: string): Promise<void>;
  /** The PKCE challenge of an unexpired code of this client (its client not soft-deleted), or null. */
  readOauthCodeChallenge(codeHash: string, clientId: string, nowEpochSeconds: number): Promise<string | null>;
  /** Insert the tokens of one grant on the grant transaction, all or none, after the client lock (OAuthGrants.issue); run it on the transaction handle, never the pool. */
  issueOauthTokens(rows: readonly OauthTokenInsert[]): Promise<void>;

  /** The ids of the enabled, untombstoned audience-kind members, by id. */
  listAudienceAccessMembers(): Promise<string[]>;

  /** Every access group with its member ids, by id; or the one group with exactly that id (null lists every group). */
  readAccessGroups(id: string | null): Promise<AccessGroupRow[]>;

  /** The pages, in every source and by (source, slug), whose readers name exactly `principal`; at most 51 of them. */
  listPagesNamingReader(principal: string, opts?: { live?: boolean }): Promise<PageNamingReaderRow[]>;

  // Open loops (engine-sql/open-loops.ts). Each runs the statement loops-store.ts ran through executeRaw and returns
  // the raw rows; loops-store.ts normalizes them.
  /** Inserts a loop, or updates the row with its source and dedup key when that row is open, the new activity is newer, or an unmute queued it, and a mute does not hold it for the same counterparty email. `applied` is false when the guard kept the existing row. */
  upsertOpenLoop(loop: OpenLoopUpsertInput): Promise<OpenLoopsSql.OpenLoopUpsertResult>;
  /** Closes the open loop `id` (in `sourceId` when not null) as `status`, by `closedBy`, now; the closed row, or null when no open loop matches. */
  closeOpenLoop(sourceId: string | null, id: number, status: Exclude<OpenLoopStatus, 'open'>, closedBy: string): Promise<OpenLoopsSql.OpenLoopDbRow | null>;
  /** The loops that pass every filter, newest activity first, then id descending, at most `limit` (1 to 1000, 200 by default). */
  listOpenLoops(opts?: OpenLoopListOpts): Promise<OpenLoopsSql.OpenLoopDbRow[]>;
  /** The open loops whose counterparty page is (sourceId, slug), newest activity first, at most `limit` (entity-card.ts). */
  readEntityOpenLoops(slug: string, sourceId: string, limit: number): Promise<OpenLoopsSql.EntityOpenLoopRow[]>;
  /** The open loops of `loopType` in `sourceId` per counterparty email among `emails`, one row per email with any, in no set order, with no limit (ops/loops.ts withheld noise). */
  countOpenLoopsByCounterpartyEmail(sourceId: string, emails: readonly string[], loopType: string): Promise<OpenLoopsSql.CounterpartyEmailLoopCount[]>;
  /** The applied-capture records older than `ttlDays` days deleted; how many (ingestion/applied-captures.ts, the dream cycle's bookkeeping purge). */
  purgeStaleAppliedCaptures(ttlDays: number): Promise<number>;
}
