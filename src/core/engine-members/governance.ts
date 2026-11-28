/**
 * The shared-skill membership, trust ledger, entity identity and write-gate statements of BrainEngine.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as EntityIdentitiesSql from '../engine-sql/entity-identities.ts';
import type * as SharedSkillMembersSql from '../engine-sql/shared-skill-members.ts';
import type { StoredSkillRevision } from '../shared-skills/model.ts';
import type * as TrustWithdrawalsSql from '../engine-sql/trust-withdrawals.ts';
import type * as TrustWriteGateSql from '../engine-sql/trust-write-gate.ts';
import type * as LoopMutesSql from '../engine-sql/loop-mutes.ts';
import type * as SourceArchiveSql from '../engine-sql/source-archive.ts';

export interface GovernanceMembers {
  // Shared-skill membership (engine-sql/shared-skill-members.ts): the rows join_brain, sync_brain_skills, leave_brain and the catalog read.
  /** The brain id, the catalog token secret and the serving epoch, or undefined without the brain or shared-skill state row. */
  readSharedSkillCatalogIdentity(): Promise<SharedSkillMembersSql.SharedSkillCatalogIdentity | undefined>;
  /** The live shared-skill heads of live sources that match the query, in key order, at most `limit` rows. */
  listSharedSkillCatalogHeads(query: SharedSkillMembersSql.SharedSkillHeadQuery): Promise<SharedSkillMembersSql.SharedSkillHeadRow[]>;
  /** A source incarnation's sealed skill pack (id, revision, manifest, manifest hash), or undefined. */
  readSharedSkillPackRow(sourceId: string, incarnation: string): Promise<SharedSkillMembersSql.SharedSkillPackRow | undefined>;
  /** A source incarnation's stored publication policy and epoch, or undefined; `lock` reads it `FOR SHARE`. */
  readSharedSkillPolicyRow(sourceId: string, incarnation: string, lock: boolean): Promise<{ epoch: string; policy: unknown } | undefined>;
  /** Upserts a source incarnation's publication policy under a new epoch and appends its audit row. */
  writeSharedSkillPolicy(write: SharedSkillMembersSql.SharedSkillPolicyWrite): Promise<void>;
  /** Inserts a published revision and moves its head; the SQL engines' publication guard refuses it outside a coordinated write. */
  writeSharedSkillRevision(write: SharedSkillMembersSql.SharedSkillRevisionWrite): Promise<void>;
  /** One stored shared-skill revision that is not deleted, or undefined. */
  readSharedSkillRevision(key: SharedSkillMembersSql.SharedSkillRevisionKey): Promise<StoredSkillRevision | undefined>;
  /** The live sources in both id lists (null matches all), by id, at most 65 rows. */
  listSharedSkillFollowSources(allowed: string[] | null, sourceIds: string[] | null): Promise<Array<{ id: string; incarnation: string }>>;
  /** The persistent brain id locked `FOR UPDATE`, or undefined without the row. */
  lockSharedSkillBrainId(): Promise<string | undefined>;
  /** One shared-skill member locked `FOR UPDATE`, or undefined; by installation id it matches only under its own principal. */
  readSharedSkillMember(by: SharedSkillMembersSql.SharedSkillMemberLookup): Promise<SharedSkillMembersSql.SharedSkillMemberRow | undefined>;
  /** The number of shared-skill members, active or not. */
  countSharedSkillMembers(): Promise<number>;
  /** The members following source `sourceId`, by byte order of adapter, with their approved incarnation and acknowledged stage (shared-skills/migration-members.ts). */
  listSharedMemberMigrationRows(sourceId: string): Promise<SharedSkillMembersSql.SharedMemberMigrationRow[]>;
  /** Inserts a shared-skill member or re-activates the one with its installation id at the next epoch. */
  enrollSharedSkillMember(spec: SharedSkillMembersSql.SharedSkillMemberEnroll): Promise<void>;
  /** Sets an active member's narrowed follow policy and epoch, and resets its sequences and views. */
  rebindSharedSkillMember(installationId: string, followPolicy: unknown, epoch: number): Promise<void>;
  /** Marks a shared-skill member inactive. */
  leaveSharedSkillMember(installationId: string): Promise<void>;
  /** Issues a delivery batch for a member: prune, reuse or insert, retention trim and the seen mark, in order. */
  issueSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchIssue): Promise<SharedSkillMembersSql.SharedSkillBatchIssued>;
  /** A member's batch under this epoch issued within 24 hours, locked `FOR UPDATE`, or undefined. */
  readSharedSkillDeliveryBatch(token: string, installationId: string, epoch: number): Promise<SharedSkillMembersSql.SharedSkillBatchRow | undefined>;
  /** Records a batch's acknowledgment evidence and, with `advance`, the member's acknowledged sequence and view. */
  acknowledgeSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchAcknowledge): Promise<void>;

  // Trust: the fact withdrawal ledger (engine-sql/trust-withdrawals.ts). Each runs the statement its caller ran through executeRaw.
  /** Whether a withdrawal in the source at `visibility` covers a claim for `subject`: its fingerprint is `factHash` or the v1 fingerprint of `claim`, and its subject is '*' or `subject`. */
  hasCoveringFactWithdrawal(sourceId: string, visibility: string, factHash: string, claim: string, subject: string): Promise<boolean>;
  /** Records a withdrawal of `claim` (by its fingerprint) for `subject`, at `withdrawnAt` (an ISO time) or now; false when that withdrawal was already recorded. */
  insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null): Promise<boolean>;
  /** Whether a withdrawal (subject '*', `entitySlug` or `memberPage`) or a purge tombstone (subject '*' or `entitySlug`) of the source covers `claim`; a null `visibility` matches any. */
  isFactWithdrawn(sourceId: string, visibility: string | null, claim: string, entitySlug: string | null, memberPage: string | null): Promise<boolean>;
  /** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
  isFactPurged(sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean>;
  /** Per claim row with a matching withdrawal (same visibility, its fingerprint or v1 fingerprint, subject '*' or `subject`; any subject when null): the earliest withdrawal time. No set order. */
  listFactWithdrawalDates(sourceId: string, claims: readonly TrustWithdrawalsSql.WithdrawalClaimRow[], subject: string | null): Promise<TrustWithdrawalsSql.WithdrawalDateRow[]>;
  /** Rename or merge: moves the source's withdrawals of subject `oldSlug` to `newSlug`, keeping a withdrawal `newSlug` already has. */
  moveFactWithdrawalSubject(sourceId: string, oldSlug: string, newSlug: string): Promise<void>;
  /** Whether any withdrawal of the source has subject `subject`. */
  hasFactWithdrawalForSubject(sourceId: string, subject: string): Promise<boolean>;
  /** The source's withdrawal keys by visibility, fingerprint and subject, at most `limit`. */
  listFactWithdrawalKeys(sourceId: string, limit: number): Promise<TrustWithdrawalsSql.WithdrawalKeyRow[]>;
  /** The hot-memory cache watermark of the source: withdrawal count, newest withdrawal (UTC ISO) and the folder access rules digest. It changes on any forget or rulebook install. */
  readFactCacheWatermark(sourceId: string): Promise<TrustWithdrawalsSql.FactCacheWatermarkRow>;
  /** The trust policy generation as decimal text; it moves whenever cached proactive content could turn wrong. Throws when it cannot be read. */
  readTrustGeneration(): Promise<string>;
  /** Whether the source has any fact purge tombstone (`facts`) and any take purge tombstone (`takes`). */
  readSourcePurgeFlags(sourceId: string): Promise<{ facts: boolean; takes: boolean }>;
  /** The row numbers of `takes` whose claim fingerprint a take purge tombstone of the source names, under subject '*' or `subject` (any subject when null), each once. No set order. Reads take_purges. */
  listPurgedTakeRows(sourceId: string, takes: readonly TrustWithdrawalsSql.TakeClaimRow[], subject: string | null): Promise<number[]>;
  /** The fact a withdrawal admits (id and source; world facts only when worldOnly unless it is on memberPage; the remote provenance floor when remoteFloor), locked for the withdrawal; null when none. */
  lockFactForWithdrawal(spec: TrustWithdrawalsSql.WithdrawalLockSpec): Promise<TrustWithdrawalsSql.WithdrawalLockRow | null>;
  /** Queues the overnight review of withdrawn fact `factRef`; a queued review stays. */
  queueWithdrawalReview(sourceId: string, factRef: string): Promise<void>;
  /** The segmented pages among `slugs` in the source (id, slug). */
  listSegmentedPagesBySlug(sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string }>>;
  /** Gives the inline pages among `slugs` a new knowledge revision and clears their text projection revision and embedding signature. Returns them with the new revision. */
  bumpWithdrawnPageRevisions(sourceId: string, slugs: readonly string[]): Promise<TrustWithdrawalsSql.WithdrawnPageRevision[]>;
  /** The pages with these ids and their knowledge revisions. */
  readPageRevisions(ids: readonly number[]): Promise<TrustWithdrawalsSql.WithdrawnPageRevision[]>;
  /** Appends `note` to fact `id`'s context, after ' | ' when the context has text. */
  appendFactForgetReason(id: number, sourceId: string, note: string): Promise<void>;
  /** The withdrawal a save of this claim meets (the refusal's `fact_withdrawn`); entity, owned-page and source-wide withdrawals, the entity's first; null when none. Remote callers see only withdrawals they can see a backing row of, or that none backs. */
  readFactWithdrawnRow(spec: TrustWithdrawalsSql.FactWithdrawnSpec): Promise<TrustWithdrawalsSql.FactWithdrawnRow | null>;
  /** For a remote caller: whether the withdrawn rows backing this claim include one it can see (`visible`) and one it cannot (`hidden`). */
  readFactWithdrawnBacking(spec: TrustWithdrawalsSql.FactWithdrawnSpec): Promise<{ visible: boolean; hidden: boolean }>;

  // Loop mutes (engine-sql/loop-mutes.ts): the loop_suppressions statements and the open-loop statements a mute, an
  // unmute and the Gmail thread verdict run. loops-store.ts lower-cases `value` and shapes the results.
  /** Records the mute of `kind` (`sender` or `thread`) and `value` in `sourceId`; an existing row stays as it is. */
  addLoopSuppression(sourceId: string, kind: LoopMutesSql.SuppressionKind, value: string): Promise<void>;
  /** Deletes that mute; the number of rows deleted (0 or 1). */
  removeLoopSuppression(sourceId: string, kind: LoopMutesSql.SuppressionKind, value: string): Promise<number>;
  /** Every mute in `sourceId`, by kind then value. */
  listLoopSuppressions(sourceId: string): Promise<Array<{ kind: string; value: string }>>;
  /** The threads an unmute queued for a re-check in `sourceId` (`closed_by = 'mute_recheck'`), with the greatest page slug of each. */
  listMuteRecheckThreads(sourceId: string): Promise<Array<{ thread_id: string; page_slug: string | null }>>;
  /** The open loops the mute covers, by id; with `apply`, closes them as dropped by `'muted'`. */
  closeMutedLoops(sourceId: string, kind: LoopMutesSql.SuppressionKind, value: string, apply: boolean): Promise<number[]>;
  /** The muted loops this (removed) mute covered that no other mute covers, by id; with `apply`, queues those with a thread id for a re-check and drops the others as `'unmuted'`. */
  requeueMutedLoops(sourceId: string, kind: LoopMutesSql.SuppressionKind, value: string, apply: boolean): Promise<Array<{ id: number; thread_id: string | null }>>;
  /** Closes the thread's open and re-check loops (only the `only` loop types when not null) as done by `closedBy`; the number closed. */
  closeThreadLoops(sourceId: string, threadId: string, closedBy: string, only: readonly string[] | null): Promise<number>;
  /** Drops the thread's re-check loops as `'unmuted'`; the number settled. */
  settleMuteRecheck(sourceId: string, threadId: string): Promise<number>;

  // Source archive (engine-sql/source-archive.ts): the soft delete, restore, archive list, purge candidates, impact
  // counts and source-holding OAuth clients of destructive-guard.ts, which still picks the managed path and shapes results,
  // and the unmanaged source delete of source-delete.ts.
  /** Archives the active source now, expiring `ttlHours` later, with `config.federated` false; null when missing or already archived. */
  archiveSource(sourceId: string, ttlHours: number): Promise<SourceArchiveSql.ArchivedSourceRow | null>;
  /** Un-archives the archived source, clears both archive times and sets `config.federated`; whether one was restored. */
  restoreArchivedSource(sourceId: string, federated: boolean): Promise<boolean>;
  /** Every archived source with its page count (soft-deleted pages included), newest archive first. */
  listArchivedSourceRows(): Promise<SourceArchiveSql.ArchivedSourceListRow[]>;
  /** The archives past their recovery window (both times real, expiry passed), by id. */
  listExpiredArchivedSources(): Promise<SourceArchiveSql.ExpiredArchivedSourceRow[]>;
  /** The archives whose times are missing or at or before 1970-01-02, by id. */
  listUnverifiedArchivedSourceIds(): Promise<string[]>;
  /** The OAuth clients that name the source, revoked ones included, by client id. */
  listSourceOAuthClients(sourceId: string): Promise<SourceArchiveSql.SourceOAuthClientRow[]>;

  // Entity identities: cross-source identity groups (engine-sql/entity-identities.ts; entity-identity.ts validates first).
  /** Links the live page (sourceId, slug) into the group: re-linking moves it; canonical true demotes the old canonical in the same write. Throws the identity page-not-found error with no live page. */
  linkEntityIdentityRow(input: EntityIdentitiesSql.EntityIdentityLinkInput): Promise<void>;
  /** Removes the page (sourceId, slug), live or soft-deleted, from the group entityId; true when a row was removed. */
  unlinkEntityIdentityRow(input: EntityIdentitiesSql.EntityIdentityUnlinkInput): Promise<boolean>;
  /** The members (live pages) the filter keeps, by entity id, canonical first, source, then slug. */
  listEntityIdentityRows(filter: EntityIdentitiesSql.EntityIdentityFilter): Promise<EntityIdentitiesSql.EntityIdentityRow[]>;
  /** The group of each live member page in the cross product of the pages' sources and slugs. */
  readEntityIdentityIdsForPages(pages: ReadonlyArray<{ sourceId: string; slug: string }>): Promise<EntityIdentitiesSql.EntityIdentityPageRow[]>;
  /** At most two canonical members in another source of the live page's group (Gmail counterparty resolution). */
  readCanonicalTwin(sourceId: string, slug: string): Promise<EntityIdentitiesSql.CanonicalTwinRow[]>;

  // Trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts). Writers call these inside their
  // publication transaction, so a rolled-back write leaves no receipt or hold.
  /** Record a flag or quarantine receipt; the same target, content hash and detector version refreshes it. Returns its id. */
  upsertWriteGateReceipt(input: TrustWriteGateSql.WriteGateReceiptInput): Promise<number>;
  /** Record a receipt on the live page (sourceId, slug); null when no live page has that slug. */
  upsertPageWriteGateReceipt(sourceId: string, slug: string, receipt: TrustWriteGateSql.WriteGateReceiptFields): Promise<number | null>;
  /** Remove the live or deleted page's receipts whose content hash is not `contentHash` (null keeps none). */
  deleteStalePageWriteGateReceipts(sourceId: string, slug: string, contentHash: string | null): Promise<void>;
  /** One row's receipts, newest `last_seen_at` first (ties: higher id first), at most `limit`. */
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number): Promise<TrustWriteGateSql.WriteGateReceiptRow[]>;
  /** Delete receipts not seen for `olderThanDays` days, except those of a hold still held. Returns how many. */
  deleteStaleWriteGateReceipts(olderThanDays: number): Promise<number>;
  /** Hold a quarantined fact or take; the same source, slug, fingerprint and detector version re-opens the hold. Returns its id. */
  upsertWriteGateHold(input: TrustWriteGateSql.WriteGateHoldRowInput): Promise<number>;
  /** Holds, highest id first. */
  listWriteGateHoldRows(opts: TrustWriteGateSql.WriteGateHoldListOpts): Promise<TrustWriteGateSql.WriteGateHoldRow[]>;
  /** The owner's write-gate allow rules as stored, by id: active ones only unless `includeRemoved`, in the given sources (all when none). */
  listTrustAllowRuleRows(opts?: TrustWriteGateSql.TrustAllowRuleListOpts): Promise<Array<Record<string, unknown>>>;
  /** `trust allow add`: nothing when the source is not active; else inserts the rule or returns the active one with the same key. */
  addTrustAllowRule(rule: TrustWriteGateSql.TrustAllowRuleInsert): Promise<TrustWriteGateSql.TrustAllowRuleAdd>;
  /** `trust allow remove`: marks the active rule removed and returns it (the receipt), or null when none is active. */
  removeTrustAllowRule(id: number, removedBy: string): Promise<Record<string, unknown> | null>;
  /** One allow rule by id, active or removed, or null. */
  readTrustAllowRule(id: number): Promise<Record<string, unknown> | null>;
  /** One hold by id, any status. */
  getWriteGateHoldRow(id: number): Promise<TrustWriteGateSql.WriteGateHoldRow | null>;
  /** Mark a held row released or dropped; false when it does not exist or was already decided. */
  decideWriteGateHold(id: number, status: 'released' | 'dropped', decidedBy: string): Promise<boolean>;
}
