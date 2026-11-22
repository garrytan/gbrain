/**
 * The facts statements of BrainEngine: doctor, cycle, purge, withdrawal, relink, repair, trust and conversation members.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as AccessGrantsSql from '../engine-sql/access-grants.ts';
import type { ConversationFactLink, ConversationRelinkPagesQuery, RelinkPlacement } from '../engine-sql/fact-relink-writes.ts';
import type * as DerivationTrustSql from '../engine-sql/derivation-trust.ts';
import type { DurablePersistenceSettings } from '../engine-sql/persistence-declaration.ts';
import type { FactRelinkAttempt, FactRelinkOutcome, FactRelinkUpsertOpts } from '../engine-sql/fact-relink-attempts.ts';
import type * as FactsConversationSql from '../engine-sql/facts-conversation.ts';
import type * as FactsCycleSql from '../engine-sql/facts-cycle.ts';
import type * as FactsDoctorSql from '../engine-sql/facts-doctor.ts';
import type * as FactsPurgePlanSql from '../engine-sql/facts-purge-plan.ts';
import type * as FactsPurgeSql from '../engine-sql/facts-purge.ts';
import type * as FactsRecallSql from '../engine-sql/facts-recall.ts';
import type * as FactsRepairSql from '../engine-sql/facts-repair.ts';
import type * as FactsTrustSql from '../engine-sql/facts-trust.ts';
import type { LocalWriterInsert, LocalWriterRow } from '../engine-sql/persistence-state.ts';
import type { PageReadScope } from '../types.ts';
import type * as ProjectionRebuildSql from '../engine-sql/projection-rebuild.ts';

export interface FactsStatementMembers {
  // Facts statements, doctor checks (engine-sql/facts-doctor.ts). Each runs the statement its caller ran through executeRaw.
  /** conversation_outcomes_stale: the newest unexpired extraction-outcome rows of `sourceIds`, newest id first, at most `limit`. */
  listConversationFactRows(sourceIds: string[], limit: number): Promise<FactsDoctorSql.ConversationFactRow[]>;
  /** facts_redaction_marker: active facts holding a redaction marker in live sources (only `sourceIds` when given). */
  countRedactedFacts(sourceIds?: string[]): Promise<number>;
  /** outside_content_fences: per imported page a third party wrote, its fence-indexed fact, take and link counts, by source id and slug. */
  listOutsideContentFenceCounts(): Promise<FactsDoctorSql.OutsideContentFenceRow[]>;
  /** facts_health: unexpired facts naming an `atoms/` page, in every source. */
  countAtomFacts(): Promise<number>;
  /** trust_release_unpreviewed_fields: current user_confirmed facts a trust release raised without previewing their fence fields, by id, at most `limit`, each with the total. */
  listUnpreviewedTrustFacts(limit: number): Promise<FactsDoctorSql.UnpreviewedTrustFactRow[]>;
  /** unlinked_facts: per source and origin, counts over each source's newest `windowPerSource` active facts; `hasAttempts` says the brain has `fact_relink_attempts`. */
  countUnlinkedFactsByOrigin(opts: { sourceIds: string[]; auditSources: string[]; windowPerSource: number; hasAttempts: boolean }): Promise<FactsDoctorSql.UnlinkedOriginRow[]>;
  /** unlinked_facts: the 7-day counts of active facts (unlinked share, relink judgments, inference tiers); null when no row comes back. */
  countUnlinkedFactStats(opts: { sourceIds: string[]; auditSources: string[]; hasAttempts: boolean }): Promise<FactsDoctorSql.UnlinkedFactStatsRow | null>;
  /** unlinked_facts: relink attempt outcomes (every no_subject, the linked ones of the last 7 days) by outcome and tier. */
  countFactRelinkOutcomes(sourceIds: string[]): Promise<FactsDoctorSql.FactRelinkOutcomeRow[]>;
  /** unlinked_facts: the pages holding the targeted unlinked conversation rows of one source, most rows first. */
  listUnlinkedConversationSlugs(opts: { sourceId: string; auditSources: string[]; windowPerSource: number; fix: FactsDoctorSql.ConversationFixKind; hasAttempts: boolean }): Promise<Array<{ slug: string }>>;
  /** fact_take_vectors: per source, the embeddable facts with no vector, with a vector not current for `model` and `dims` or the text, and the partially embedded ones. */
  countFactEmbeddingCoverage(opts: { sourceId?: string | null; model: string; dims: number }): Promise<FactsDoctorSql.FactEmbeddingCoverageRow[]>;
  /** The embeddable facts whose vector is not current for `model` and `dims` or the text, over every source or `sourceId`, with the sum of their lengths in characters. */
  countStaleFactEmbeddings(opts: { model: string; dims: number; sourceId?: string | null }): Promise<{ count: number; chars: number }>;
  /** fence_integrity: live markdown pages of these sources stored in segments with no checkout file walked; null when no row answers. */
  countSegmentedCensusPages(sourceIds: string[], checkedOutSourceIds: string[]): Promise<{ n: number } | null>;
  /** unlinked_facts: the `facts` and `fact_relink_attempts` table names the brain has (null for one it lacks). */
  readFactTableCatalog(): Promise<{ facts: string | null; attempts: string | null } | null>;

  // Facts relink attempts (engine-sql/fact-relink-attempts.ts): the `fact_relink_attempts` writes and reads relink ran through executeRaw.
  /** Records a fact's latest relink attempt (`attempted_at` now), replacing its stored one; `keepModelAndRun` keeps the stored `model` and `run_id` on a conflict. */
  upsertFactRelinkAttempt(sourceId: string, attempt: FactRelinkAttempt, opts?: FactRelinkUpsertOpts): Promise<void>;
  /** The stored relink outcome of each of `factIds` in the source whose outcome is one of `outcomes`, by fact id. */
  listFactRelinkOutcomes(sourceId: string, factIds: number[], outcomes: string[]): Promise<FactRelinkOutcome[]>;
  /** Deletes the source's relink attempts of `tier` that name `targetSlug`. */
  deleteFactRelinkMemos(sourceId: string, tier: string, targetSlug: string): Promise<void>;

  // Facts relink writes (engine-sql/fact-relink-writes.ts): the guarded facts update statements relink ran through executeRaw.
  /** Places a pinned fact that still has no entity, page, row number or expiry (link onto `slug`'s fence, or retire as a duplicate); true when it moved. */
  placeRelinkedFact(sourceId: string, placement: RelinkPlacement): Promise<boolean>;
  /** Links a conversation page's derived row still exactly as planned onto a live page; true when it was linked. */
  linkConversationFact(sourceId: string, link: ConversationFactLink): Promise<boolean>;
  /** The conversation relink's page pick: the pages with the most derived rows it would link, most rows first, then by slug in byte order. */
  listConversationRelinkPages(sourceId: string, q: ConversationRelinkPagesQuery): Promise<string[]>;

  // Facts statements, command, cycle and fence reads (engine-sql/facts-cycle.ts). Each runs the statement its caller ran through executeRaw.
  /** enrich's grounding read: an entity's unexpired, unlapsed facts, highest confidence first (newest id breaks a tie), at most `limit`. */
  listActiveFactsForEntity(sourceId: string, entitySlug: string, limit: number): Promise<FactsCycleSql.EvidenceFactRow[]>;
  /** The unexpired audit rows of `slugs` written by one of `sources`, by slug, the rows of `preferredSource` first within a page. */
  listFreshExtractionOutcomes(sourceId: string, slugs: string[], sources: string[], preferredSource: string): Promise<FactsCycleSql.ExtractionOutcomeRow[]>;
  /** Every page coordinate with fenced rows (no `cli:` rows): its row numbers in order and whether every row is expired. No set order. */
  listFenceRowGroups(): Promise<FactsCycleSql.FenceRowGroupRow[]>;
  /** The source and page slug (the row's page, else its entity) of fact `id`, or null for no such row. */
  readFactSubject(id: number): Promise<FactsCycleSql.FactSubjectRow | null>;
  /** The fence-owned rows of a page coordinate, by row number then id; `valid_from`, `valid_until` and `expired_at` are dates. */
  listFactsForPage(sourceId: string, slug: string): Promise<FactsCycleSql.PageFactRow[]>;
  /** Per entity page of the source, its unexpired unfenced rows (a live page in a source with a checkout). No set order. */
  countLegacyFactsPending(sourceId: string): Promise<FactsCycleSql.LegacyPendingRow[]>;
  /** The consolidate phase's (source, entity) buckets of at least `minPerBucket` active unconsolidated facts. No set order. */
  countUnconsolidatedFactsBySource(opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }): Promise<FactsCycleSql.UnconsolidatedBucketRow[]>;
  /** Every bulk day of the unarchived sources (`sourceIds` narrows them) under `rule`, as the statement returns them. */
  findBulkFactDays(sourceIds: string[] | undefined, rule: FactsCycleSql.BulkDayRule): Promise<FactsCycleSql.BulkDayRow[]>;
  /** The largest `row_num` of a page coordinate's facts, 0 for none. */
  maxFenceRowNum(sourceId: string, slug: string): Promise<number>;
  /** The id of the facts row that holds `rowNum` at a page coordinate (the oldest when several do), or null. */
  readFenceRowOccupant(sourceId: string, slug: string, rowNum: number): Promise<number | null>;
  /** The page coordinate's facts that hold a row number, oldest id first. */
  listStoredFenceFactRows(sourceId: string, slug: string): Promise<FactsCycleSql.StoredFenceFactRow[]>;
  /** The entity card's exact active-fact count under its visibility, privacy and read eligibility. */
  countWorldFacts(opts: FactsCycleSql.EntityFactCountOpts): Promise<number>;
  // Facts cycle, phantom redirect, fence and file-guard statements (engine-sql/facts-cycle.ts). Each runs the statement its caller ran through executeRaw.
  /** Every facts row of a page coordinate (the phantom's rows to move), with its row number, no set order. */
  listPhantomFactRows(sourceId: string, slug: string): Promise<FactsCycleSql.PhantomFactRow[]>;
  /** The fence row numbers a page coordinate's facts already hold (no set order). */
  listCanonicalFenceRowNums(sourceId: string, slug: string): Promise<Array<{ row_num: number }>>;
  /** Points fact `id` at page `slug` under `rowNum`; a null `rowNum` leaves no fence row and expires the fact if it was not already expired. */
  moveFactToPage(sourceId: string, id: number, slug: string, rowNum: number | null): Promise<void>;
  /** Moves the links that point at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
  repointInboundLinks(phantomId: number, canonicalId: number): Promise<void>;
  /** Moves the links that start at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
  repointOutboundLinks(phantomId: number, canonicalId: number): Promise<void>;
  /** Whether page `pageId` (null: no page) has at least one timeline entry. */
  pageHasTimelineEntries(pageId: number | string | null): Promise<boolean>;
  /** The largest fence `row_num` of a page coordinate's facts, 0 for none (the phantom redirect's canonical-page read). */
  maxFenceRowNumOfPage(sourceId: string, slug: string): Promise<number>;
  /** The source's live root-level slugs past `after`, in slug order, leaving out `held`: at most `take` rows (page size plus one). */
  listRootPageSlugsAfter(sourceId: string, take: number, held: string[], after: string): Promise<Array<{ slug: string }>>;
  /** The ids of the links `pageId` itself owns (not derived from another page). */
  listOwnLinkIds(pageId: number | string): Promise<Array<{ id: number }>>;
  /** The ids of a page coordinate's unexpired facts. */
  listActiveFactIdsOfPage(sourceId: string, slug: string): Promise<Array<{ id: number }>>;
  /** Which of facts `ids` are unexpired and now sit on page `slug`. */
  listFactIdsStillOnPage(ids: number[], slug: string): Promise<Array<{ id: number }>>;
  /** Which of links `ids` now start at page `pageId`. */
  listLinkIdsOnPage(ids: number[], pageId: number | string): Promise<Array<{ id: number }>>;
  /** The recorded file origin (`source_path`, `source_uri`) of a live page, or null for no live page; with `includeDeleted`, a soft-deleted page counts too. */
  readPageFileOrigin(sourceId: string, slug: string, opts?: { includeDeleted?: boolean }): Promise<FactsCycleSql.PageFileOrigin | null>;
  /** The facts of a page coordinate that hold a fence row number, with their claim text and source (no set order). */
  listFenceRowClaims(sourceId: string, slug: string): Promise<FactsCycleSql.FenceRowClaim[]>;
  /** Gives unfenced fact `id` fence row `rowNum` on page `slug` with claim text `fact`; only a row that still has no fence row changes. */
  adoptFactIntoFence(sourceId: string, id: string, rowNum: number, slug: string, fact: string): Promise<void>;
  /** The facts of a page coordinate that hold a fence row number, with their expiry and supersession (no set order). */
  listFenceRowSupersession(sourceId: string, slug: string): Promise<FactsCycleSql.FenceRowSupersession[]>;
  /** Sets (or, with null, clears) fact `id`'s `superseded_by`. */
  setFactSupersededBy(sourceId: string, id: number | string, supersededBy: number | null): Promise<void>;
  /** Which of facts `ids` have a pending, rejected or undone trust proposal that holds back a visibility change. */
  listHeldWideningFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number }>>;
  /** Expires fact `id` where it stands (the fence row keeps its number). An already expired fact keeps its expiry time. */
  expireFactInPlace(sourceId: string, id: number | string): Promise<void>;
  /** Expires fact `id` and drops its fence row number. An already expired fact keeps its expiry time. */
  expireAndDetachFact(sourceId: string, id: number | string): Promise<void>;
  /** Writes a fence row's cells onto fact `id`. */
  updateFenceFactCells(sourceId: string, id: number | string, cells: FactsCycleSql.FenceFactCells): Promise<void>;
  /** The unexpired fence rows of a page coordinate whose page is soft-deleted (and, when `pageId` is given, is that page id). */
  listExpirableFactIdsOfDeletedPage(sourceId: string, slug: string, pageId: number | null): Promise<Array<{ id: number }>>;
  /** The newest soft-deleted page of a coordinate's stored body, or null for none. */
  readDeletedPageBody(sourceId: string, slug: string): Promise<FactsCycleSql.DeletedPageBodyRow | null>;
  /** Expires the still-unexpired facts among `ids`; the ids it expired. */
  expireFactsByIds(sourceId: string, ids: number[]): Promise<Array<{ id: number }>>;
  /** The page slugs (no `/`) that still hold an unexpired ontology observation. */
  listOntologyObservationSlugs(sourceId: string): Promise<Array<{ slug: string }>>;
  /** The soft-deleted pages of the source that still have unexpired fence rows, in slug order. */
  listDeletedPageSlugsWithActiveFacts(sourceId: string): Promise<Array<{ slug: string }>>;
  /** The source's unexpired facts with no fence row, by entity slug (null first) then id, with page-existence flags. */
  scanUnfencedFactRows(sourceId: string): Promise<FactsCycleSql.UnfencedScanRow[]>;
  /** The source's unexpired fence rows on a holding page (any folder depth) that name another entity, by entity slug then id; `days` is the age cutoff as text. */
  listHeldFactRows(sourceId: string, days: string): Promise<FactsCycleSql.HeldFactRow[]>;
  /** The source's fenced, unexpired facts whose page is missing or soft-deleted, by id, with the page slug they sit on. */
  listFencedFactsOfMissingPages(sourceId: string): Promise<Array<{ id: number; slug: string }>>;
  /** The largest fence `row_num` of a page coordinate's facts, 0 for none (the fence writer's numbering hint; the caller handles a failed read). */
  readFenceRowNumHint(sourceId: string, slug: string): Promise<number>;
  /** The source's checkout path, or null when the source is unknown or has none. */
  readSourceCheckoutPath(sourceId: string): Promise<string | null>;
  /** The live page's stored body, or null for no live page. `lock` takes the row lock (inside a transaction). */
  readLiveStoredBody(sourceId: string, slug: string, lock?: boolean): Promise<FactsCycleSql.StoredBodyRow | null>;
  /** The live page's state, then its 20 newest page_versions rows that hold a body, newest first. */
  listPageStates(sourceId: string, slug: string): Promise<FactsCycleSql.PageStateRow[]>;
  /** How many of a page's versions keep their body in segments. */
  countSegmentedVersionsOfPage(sourceId: string, slug: string): Promise<number>;

  // Facts statements, purge, withdrawal, relink and fence repair (engine-sql/facts-purge.ts). Each runs the statement its caller ran through executeRaw.

  countFactFingerprintLeftovers(sourceId: string, factHash: string, visibility: string, subject: string): Promise<number>;
  loadPurgeTarget(id: number, sourceId: string): Promise<FactsPurgeSql.PurgeTargetRow | null>;
  planFactPurgeIds(sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ id: number }>>;
  listFactsReconcileBacklog(): Promise<FactsPurgeSql.FactsReconcileBacklogRows>;
  /** extract_facts: record one live page's reconcile outcome at `revision` (`undefined`: the current revision); a page that moved on records nothing. */
  settleFactsReconcile(sourceId: string, slug: string, outcome: FactsPurgeSql.FactsReconcileOutcome, revision?: string | null): Promise<void>;
  /** extract_facts' commit step: lock the live page for the rest of the transaction and report whether it is still at `revision`. */
  lockReconcileRevision(sourceId: string, slug: string, revision: string | null): Promise<boolean>;
  /** extract_facts: settle the source's due fenceless pages as complete, then return up to `pageLimit` due retryable slugs, never-attempted first. */
  selectFactsReconcileDrain(sourceId: string, pageLimit: number): Promise<string[]>;
  listRelinkCandidateRows(opts: { sourceId: string; afterId: number; since: Date | null; limit: number }): Promise<FactsPurgeSql.RelinkCandidateRow[]>;
  countRelinkCandidates(sourceId: string): Promise<number>;
  listSimilarActiveFacts(opts: { sourceId: string; factId: number; remote: boolean; excludePrivate: boolean; minCosine: number; limit: number }): Promise<FactsPurgeSql.SimilarActiveFacts>;
  findActiveSingleFact(opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean; newest?: boolean }): Promise<FactsPurgeSql.ExactFactRow | null>;
  listSingleFactMetadata(opts: { sourceId: string; ids: number[]; remoteFloor: boolean }): Promise<FactsPurgeSql.SingleFactMetadataRow[]>;
  listUnfencedFactRows(opts: { sourceId?: string }): Promise<FactsPurgeSql.UnfencedFactRow[]>;
  listHeldFenceFactRows(sourceId: string, slug: string): Promise<FactsPurgeSql.HeldFenceFactRow[]>;
  listWithdrawalSlugs(sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ slug: string }>>;
  expireFactsByWithdrawal(sourceId: string, visibility: string, fact: string, subject: string): Promise<Array<{ id: number }>>;
  /** Stores a fact purge tombstone; false when the same (source, visibility, subject, fingerprint) one exists. */
  insertFactPurge(row: FactsPurgeSql.FactPurgeInsert): Promise<boolean>;
  /** Stores a take purge tombstone; false when the same (source, subject, fingerprint) one exists. */
  insertTakePurge(row: FactsPurgeSql.TakePurgeInsert): Promise<boolean>;
  /** One hop of the derivation walk: the rows a `derivation_inputs` edge derives from a frontier row, distinct, by (table, id), at most `limit`. */
  listDerivedRows(frontier: ReadonlyArray<{ table: string; id: string }>, limit: number): Promise<Array<{ derived_table: string; derived_id: string }>>;
  /** Records a page purge's content-hash tombstones under the slug; a hash already tombstoned takes the new slug, request and time. Write; run it in the purge transaction. */
  upsertPagePurges(row: FactsPurgeSql.PagePurgeUpsert): Promise<void>;
  // The facts purge statements of gone-page-facts.ts, purge-reasons.ts, held-fact-move.ts and purge-verify.ts (engine-sql/facts-purge.ts). Each runs the statement its caller ran through executeRaw.
  /** Expires the facts a retention purge takes with its deleted pages (filed on them, their conversation slots, extracted from them, about them and held by no page): four updates in order over the paired source ids and slugs. Writes facts; run it in the purge transaction. */
  expireFactsOfGonePages(sourceIds: string[], slugs: string[]): Promise<void>;
  /** The source's checkout path, null for none or no such source. Reads sources. */
  readPurgeSourceLocalPath(sourceId: string): Promise<string | null>;
  /** Tombstones each (commit, path) pair, none twice; the number added. Writes reason_purge_tombstones. */
  insertReasonPurgeTombstones(sourceId: string, commits: string[], paths: string[]): Promise<number>;
  /** The source's Git effects whose data carries the claim in one of its three forms, in id order, locked for the redaction. Reads persistence_effects. */
  listGitEffectsCarryingReason(sourceId: string, needle: string, escaped: string, foldedJson: string): Promise<FactsPurgeSql.PurgeGitEffectRow[]>;
  /** The slug's Git effects that carry a commit line or trailers, in id order, locked for the strip. Reads persistence_effects. */
  listPageGitEffectsForStrip(sourceId: string, slug: string): Promise<FactsPurgeSql.PurgeGitEffectRow[]>;
  /** Replaces one effect's data (`effectId` is the bigint id as text). Writes persistence_effects. */
  setPurgeEffectData(effectId: string, data: Record<string, unknown>): Promise<void>;
  /** The change reasons the page's versions and its requests (intent and outcome) recorded, each once, null included. Reads page_versions and persistence_requests. */
  listPageChangeReasons(sourceId: string, slug: string, pageId: number): Promise<Array<{ reason: string | null }>>;
  /** The slug's requests whose intent or outcome records a reason, oldest first (10000 at most). Reads persistence_requests. */
  listRequestsRecordingReasons(sourceId: string, slug: string): Promise<FactsPurgeSql.IntentRedactionTarget[]>;
  /** Whether a soft-deleted page holds the slug. Reads pages. */
  heldEntityPageDeleted(sourceId: string, slug: string): Promise<boolean>;
  /** Whether the access state is readable, an exact page rule covers the entity and a folder rule restricts it. Reads access_rules, access_pending_coverage and the access functions; the caller decides what a failed read means. */
  readHeldAccessState(sourceId: string, entity: string): Promise<FactsPurgeSql.HeldAccessState[]>;
  /** Whether a live page holds the slug. Reads pages. */
  heldTargetPageLive(sourceId: string, slug: string): Promise<boolean>;
  /** Every live held row on every holding page of the source, by holding page, entity and id. Reads facts and pages. */
  listHeldMoveRows(sourceId: string): Promise<FactsPurgeSql.HeldFactRow[]>;
  /** The struck held rows, one per holding page and row number, none an active fact reuses. Reads facts and pages. */
  listStruckHeldRows(sourceId: string): Promise<FactsPurgeSql.StruckHeldRow[]>;
  /** Whether every reader of the source can read the live page; null for no live page. Reads pages and the access rules. */
  readHeldRowVisibility(sourceId: string, slug: string): Promise<{ visible: boolean } | null>;
  /** Whether a rule now narrows a held row's entity below its holding page's readers. Reads facts, pages and the access functions. */
  heldMoveDue(sourceId: string): Promise<boolean>;
  /** One config row's value, null when unset. Reads config. */
  readHeldConfigValue(name: string): Promise<string | null>;
  /** A live page's file path and URI, null for none; `timeoutMs` ends the read on the server. Reads pages. */
  readHeldPageLocation(sourceId: string, slug: string, opts?: { timeoutMs?: number }): Promise<{ source_path: string | null; source_uri: string | null } | null>;
  /** The segmented saved versions a held-fact request recorded as not edited; 0 for none. Reads persistence_requests. */
  readHeldVersionsEdited(requestId: string): Promise<number>;
  /** The source's live pages stored in segments, in id order, `limit` of them. Reads pages. */
  listSegmentedPageBodies(sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: null; version_id: null }>>;
  /** The source's retained versions stored in segments, in id order, `limit` of them. Reads page_versions and pages. */
  listSegmentedVersionBodies(sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: number; version_id: number }>>;
  /** Bounds the statements of the transaction it runs in to `ms` milliseconds (set_config, local). */
  setPurgeProbeTimeout(ms: number): Promise<void>;
  /** One batch of stored derivation results after the cursor (page, pipeline, occurrence): the rows scanned, the claim candidates, those a sweep covers and holds the claim, and those it does not, and the last key. Reads page_segment_derivations and pages. */
  probePurgeDerivations(sourceId: string, needles: string[], pageIds: number[], patterns: string[], cursor: FactsPurgeSql.DerivationKey | null, rows: number): Promise<FactsPurgeSql.PurgeDerivationProbeRow>;
  /** The next 1000 belief events of the source after id `after` with a recorded value, in id order. Reads belief_events. */
  listBeliefEventsForPurgeProbe(sourceId: string, after: number): Promise<Array<{ id: number; subject_kind: string; subject_key: string; value: unknown }>>;
  /** The next 1000 live facts of the source after id `after` that have a context, in id order. Reads facts. */
  listFactContextsForPurgeProbe(sourceId: string, after: number): Promise<Array<{ id: number; context: string }>>;
  /** The distinct relative file paths (64 at most) of the pages and their versions, none absolute or climbing out. Reads pages and page_versions. */
  listPageSourcePathsForPurge(pageIds: number[]): Promise<Array<{ source_path: string }>>;
  /** The five same-model facts of the source nearest to the embedding, each with whether it contains the claim. Reads facts. */
  listNearestFactsForPurge(embedding: string, sourceId: string, model: string, fact: string): Promise<Array<{ id: number; similarity: number; contains_claim: boolean }>>;
  /** The source's live atom and dream pages that no derivation edge explains. Reads pages and derivation_inputs. */
  countLegacyDerivedPages(sourceId: string): Promise<number>;
  /** Compacts the tables a purge touches (query_cache too when asked); rejects when the VACUUM fails. PGLite only: Postgres leaves it to the operator. */
  vacuumPurgedTables(withQueryCache: boolean): Promise<void>;
  /** The first 20 slugs, in order, of the source's live pages whose text in the store states one of the lowered needles. Reads the store and pages. */
  listPageProseHits(store: FactsPurgeSql.PageProseStore, sourceId: string, loweredNeedles: string[]): Promise<Array<{ slug: string }>>;
  /** The source's checkout path as the page purge receipt reads it, null for none. Reads sources. */
  readPurgeReceiptSourcePath(sourceId: string): Promise<string | null>;
  /** How many tombstones the page purge left for the slug. Reads page_purges. */
  countPagePurgeTombstones(sourceId: string, slug: string): Promise<number>;
  /** The newest delete_page request of the source with this request id, null for none. Reads persistence_requests. */
  readDeletePageRequest(sourceId: string, requestId: string): Promise<FactsPurgeSql.DeletePageRequestRow | null>;
  /** The request's effects in kind order, each with whether any target is parked. Reads persistence_effects. */
  listPurgeEffects(requestId: string): Promise<Array<{ kind: string; state: string; error_code: string | null; parked: boolean }>>;
  /** The facts and takes that still carry the purged claim's fingerprint under the subject (`*` for any), outcome markers apart. Reads facts and takes. */
  countPurgeFingerprintResidue(sourceId: string, factHash: string, subject: string): Promise<{ facts: number; takes: number }>;
  /** The next 1000 upload parts of the source's live stagings after the (staging, part) cursor, in order, each with its first and last `keep` bytes. Reads page_body_staging_parts and page_body_stagings. */
  listStagingPartEdges(sourceId: string, keep: number, after: { id: string; part: number }): Promise<FactsPurgeSql.StagingPartEdge[]>;
  /** The ids of the source's live stagings whose staged segment texts or upload parts hold the claim, plain or as a fence cell stores it, in id order. Reads page_body_stagings, page_body_manifest, page_segment_texts, page_body_staging_parts, page_body_staging_texts and persistence_requests. */
  listStagingsHoldingClaim(sourceId: string, claim: string): Promise<string[]>;
  /** Whether a live page of the source holds the slug (the one-row read that tells a purge the subject is an unbacked name key). Reads pages. */
  purgeSubjectPageLive(sourceId: string, slug: string): Promise<boolean>;
  /** The slug, id and knowledge revision of the source's pages with these ids. Reads pages. */
  listPurgePagesById(sourceId: string, pageIds: number[]): Promise<FactsPurgeSql.PurgePageRef[]>;
  /** How many saved versions of the source's pages carry the claim in their text, title, metadata or segments, or quote it in their change reason (`needle` lowered, `escaped` its JSON form, `reason` the folded reason form). Reads page_versions, pages, page_body_manifest and page_segment_texts. */
  countPurgeVersionsCarryingClaim(sourceId: string, needle: string, escaped: string, reason: string): Promise<number>;
  /** How many review queue, review proposal and decide proposal rows of the source name the facts (`refs` are the ids as text). Reads decide_review_queue, decide_review_proposals and decide_proposals. */
  countPurgeReviewRows(sourceId: string, refs: string[], factIds: number[]): Promise<FactsPurgeSql.PurgeReviewCounts>;
  /** The distinct belief stream slugs (holding page, else entity) of the facts. Reads facts; run it in the purge transaction. */
  listPurgeStreamSlugs(factIds: number[]): Promise<string[]>;
  /** One unfinished write or withdrawal mirror (not the request `ownRequest`) on one of the pages, null for none. Reads persistence_requests and persistence_effects. */
  findPurgeBlockedPublication(sourceId: string, slugs: string[], ownRequest: string): Promise<FactsPurgeSql.PurgeBlockedPublication | null>;
  /** The source's pages with these ids, whole rows, each with its tags as `purge_tags`, in slug order. Reads pages and tags. */
  listPagesForPurgeRewrite(sourceId: string, pageIds: number[]): Promise<Array<Record<string, unknown>>>;
  /** Stores a page's body with the purged fence rows dropped, its content hash, and voids its text projection and embedding signature. Writes pages; run it in the purge transaction. */
  updatePageBodyForPurge(sourceId: string, pageId: number, compiled: string, timeline: string, hash: string): Promise<void>;
  /** Stores a saved version's two body parts after the purge edit (a null timeline stays null). Writes page_versions; run it in the purge transaction. */
  setPurgeVersionBody(versionId: number, compiled: string, timeline: string | null): Promise<void>;
  /** Overwrites the change reason of every saved version of the source's pages that quotes the claim (lowered plain form or folded reason form) with `[purged]`; the ids redacted. Writes page_versions. */
  redactVersionChangeReasons(sourceId: string, needle: string, reasonNeedle: string): Promise<number[]>;
  /** The next 5000 segmented saved versions of the source after id `after` that belong to one of the pages or whose generation holds the lowered claim, in id order. Reads page_versions, pages, page_body_manifest and page_segment_texts. */
  listSegmentedVersionsForPurge(sourceId: string, needle: string, pageIds: number[], after: number): Promise<FactsPurgeSql.SegmentedVersionRow[]>;
  /** Aborts the uncommitted stagings with these ids; the page ids they belonged to (none for a staging with no page). Writes page_body_stagings; run it in the purge transaction. */
  abortPurgedStagings(stagingIds: string[]): Promise<number[]>;
  /** Deletes the upload parts of these stagings; how many. Writes page_body_staging_parts; run it in the purge transaction. */
  deletePurgedStagingParts(stagingIds: string[]): Promise<number>;
  /** Deletes the cached read-view digests of these pages. Writes page_view_digests; run it in the purge transaction. */
  deletePageViewDigests(pageIds: number[]): Promise<void>;
  /** Deletes the source's segment texts that no manifest row references and that were replaced by the purge (`replaced` are their sha256 digests) or hold the claim, plain or as a fence cell stores it; how many. Writes page_segment_texts; run it in the purge transaction. */
  deleteUnreferencedPurgedTexts(sourceId: string, replaced: Uint8Array[], claim: string): Promise<number>;
  /** The first 25 facts of the source whose text contains `text` (case folded), in id order, each cut to 160 characters. Reads facts. */
  listPurgeMatchCandidates(sourceId: string, text: string): Promise<FactsPurgeSql.PurgeMatchRow[]>;
  /** Locks the source row for the purge transaction and returns its incarnation and archived flag, null for no such source. Reads sources; run it in the purge transaction. */
  lockPurgeSource(sourceId: string): Promise<FactsPurgeSql.PurgeSourceLock | null>;
  /** Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. */
  insertHoldingPagePurges(sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]): Promise<void>;
  /** Deletes the takes with these ids; how many. Writes takes; run it in the purge transaction. */
  deletePurgedTakes(takeIds: number[]): Promise<number>;
  /** Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. */
  deletePurgeReviewQueue(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. */
  deletePurgeReviewProposals(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. */
  deletePurgeDecideProposals(sourceId: string, factIds: number[]): Promise<number>;
  /** Deletes the source's trust proposals whose target or related row is one of the facts or takes; how many. Writes trust_proposals; run it in the purge transaction. */
  deletePurgeTrustProposals(sourceId: string, factIds: number[], takeIds: number[]): Promise<number>;
  /** Deletes the source's open loops on one of the facts; how many. Writes open_loops; run it in the purge transaction. */
  deletePurgeOpenLoops(sourceId: string, factIds: number[]): Promise<number>;
  /** Deletes the source's held writes whose fact or claim text has the fingerprint; the ids deleted. Writes write_gate_holds; run it in the purge transaction. */
  deletePurgeWriteGateHolds(sourceId: string, factHash: string): Promise<string[]>;
  /** Deletes the gate receipts that name one of the facts, takes or held writes (ids as text); how many. Writes write_gate_receipts; run it in the purge transaction. */
  deletePurgeWriteGateReceipts(factIds: string[], takeIds: string[], holdIds: string[]): Promise<number>;
  /** Deletes the source's take proposals whose claim text has the fingerprint; how many. Writes take_proposals; run it in the purge transaction. */
  deletePurgeTakeProposals(sourceId: string, factHash: string): Promise<number>;
  /** Blanks the base text of the source's core edit notices that quote the lowered fact; how many. Writes core_edit_notices; run it in the purge transaction. */
  blankPurgeCoreEditNotices(sourceId: string, loweredFact: string): Promise<number>;
  /** Deletes the facts with these ids from the source; how many. Writes facts; run it in the purge transaction. */
  deletePurgedFacts(factIds: number[], sourceId: string): Promise<number>;
  /** Deletes the chunks of these pages and voids the text projection that certified them; how many pages had chunks deleted. Writes content_chunks and pages; run it in the purge transaction. */
  deletePurgedChunks(pageIds: number[]): Promise<number>;
  /** The id, slug and knowledge revision of the source's pages with these ids, in slug order. Reads pages. */
  listPurgedPageRevisions(sourceId: string, pageIds: number[]): Promise<FactsPurgeSql.PurgedPageRevision[]>;
  /** Queues the withdrawal-mirror, git and embedding effects of the purge request under the source's current incarnation and worktree binding, none twice; `data` is the effect payload. Writes persistence_effects; run it in the purge transaction. */
  insertPurgeEffects(requestId: string, sourceId: string, data: unknown): Promise<void>;

  // A fact purge's plan, dry run and --match (engine-sql/facts-purge-plan.ts; statements in facts/purge-plan-statements.ts). Each runs the statement its caller ran through executeRaw.
  /** The source's write requests whose intent, outcome or error text carries the claim, by sequence, up to `limit`. Never returns the text. */
  listRequestsCarryingClaim(q: FactsPurgePlanSql.PurgeClaimNeedles & { limit: number }): Promise<FactsPurgePlanSql.PurgeRequestTarget[]>;
  /** The source's unfinished write requests that publish one of `stagingIds`, by sequence. */
  listRequestsHoldingStagings(sourceId: string, stagingIds: readonly string[]): Promise<FactsPurgePlanSql.PurgeRequestTarget[]>;
  /** The rows a purge verification probe finds, at most `rows + 1`. */
  countPurgeProbe(probe: FactsPurgePlanSql.PurgeProbe, rows: number): Promise<number>;
  /** The first 20 rows a named purge probe lists (link, timeline and raw data rows still carrying the claim). */
  listPurgeProbeItems(probe: FactsPurgePlanSql.PurgeProbe & { kind: 'named' }): Promise<string[]>;

  // A projection rebuild's queue, keep-plan and seal statements (engine-sql/projection-rebuild.ts). Each runs the statement its caller ran through executeRaw.
  /** The queue rows of live inline pages of active sources, filtered, in walk order (updated_at, incarnation, slug in the C collation), at most `limit`. */
  listQueuedPageProjections(filter: ProjectionRebuildSql.QueuedProjectionFilter): Promise<ProjectionRebuildSql.QueuedPageProjection[]>;
  /** The reason of the queue row `key`, or null when it is no longer queued. */
  readProjectionJobReason(key: ProjectionRebuildSql.ProjectionJobKey): Promise<string | null>;
  /** Each chunk of the page with its recorded embedding input and whether its vector in `column` is current under `provenanceModel`. */
  readChunkKeepState(pageId: number, provenanceModel: string | null, column: ProjectionRebuildSql.KeepColumn): Promise<ProjectionRebuildSql.ChunkKeepState[]>;
  /** Clears and marks pending the vector in `column` of each chunk of the page that is of another model, embedded from other text, or not in `currentIds`. */
  clearUnkeptChunkVectors(pageId: number, provenanceModel: string | null, column: ProjectionRebuildSql.KeepColumn, currentIds: readonly number[]): Promise<void>;
  /** Stamps the chunker version a sealed projection was built with on the page. */
  setProjectionChunkerVersion(sourceId: string, slug: string, version: number): Promise<void>;
  /** Whether a queue row of a live inline page (with `media`, or a sealable image) is queued and not marked failed. */
  hasDrainableProjectionJob(opts?: { media?: boolean }): Promise<boolean>;

  // Facts statements, repair classifiers and loop retirement (engine-sql/facts-repair.ts). Each runs the statement its caller ran through executeRaw.
  /** Closed loops whose commitment fact is still active and retirable (same source, no other open loop references it), in id order; `loopId` null is every loop. Reads open_loops. */
  loopFactDrift(sourceIds: string[], loopId: number | null): Promise<FactsRepairSql.LoopFactDriftRow[]>;
  /** A loop already closed whose commitment fact is still active (the retry path of `loops_close`); `sourceId` null is unscoped. Reads open_loops. */
  closedLoopWithActiveFact(sourceId: string | null, loopId: number): Promise<FactsRepairSql.ClosedLoopRow | null>;
  /** Active, unsuperseded facts of the capture `lanes` in these sources whose attribution is the user or unset, optionally only `ids`, in (source, id) order. */
  listSessionFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null): Promise<FactsRepairSql.SessionFactRow[]>;
  /** For each fact in `ids`: whether an owner twin exists outside the capture `lanes`, and the sessions of its capture-lane twins. */
  listSessionFactTwins(ids: number[], lanes: string[]): Promise<FactsRepairSql.SessionFactTwinRow[]>;
  /** Active, unsuperseded capture-lane facts of these sources with their fingerprint and whether a legitimate (other-lane) twin exists, in (source, id) order. */
  listCapturedFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null): Promise<FactsRepairSql.CapturedFactRow[]>;
  /** The bounded count of the default (evidenced) set of label facts, capped at `cap`. Reads open_loops and fact_withdrawals. */
  countLabelFacts(sourceIds: string[], cap: number, args: FactsRepairSql.LabelFactCountArgs): Promise<{ count: number; capped: boolean }>;
  /** Expired fenceless extractor facts of these sources (or of one page `slug`) with the page, withdrawal, duplicate, fence and receipt evidence, in (source, page, id) order. Reads persistence_requests and fact_withdrawals. */
  listExtractorFactsForClassification(sourceIds: string[], slug: string | null): Promise<FactsRepairSql.ExtractorFactRow[]>;
  /** The bounded count of facts of a purged page, by class, capped at `cap`. Reads page_purges, fact_withdrawals and open_loops. */
  countPurgedPageFacts(sourceIds: string[], cap: number): Promise<{ evidenced: number; ambiguous: number; capped: boolean }>;
  /** Facts a facts-fence generation (`fenceKind`) retired that no withdrawal covers, in (source, page, id) order; `slug` null is every page. Reads derived_generations, derived_generation_items and fact_withdrawals. */
  listUnwithdrawnFacts(sourceIds: string[], slug: string | null, fenceKind: string): Promise<FactsRepairSql.UnwithdrawnFactRow[]>;
  /** Active `world` facts held in, or extracted from, a page that is private by its visibility, declared lineage or a privacy alias, optionally only `ids`, in id order; `readable` is whether the holding page hides the row from a remote caller. */
  listWorldFactsFromPrivateSources(sourceIds: string[], ids: number[] | null): Promise<FactsRepairSql.WorldFactFromPrivateSourceRow[]>;
  /** The ids of the sources that are not archived, in id order (the repair previews that name `--source` when more than one). */
  listActiveSourceIds(): Promise<Array<{ id: string }>>;
  /** The brain id a repair preview hashes (`persistence_brain.brain_id`), or null when the brain has no such row. */
  readRepairBrainId(): Promise<string | null>;
  /** Active, unresolved `fact`/`self` takes of these sources with the facts consolidated into each, one grouped pass, in (source, slug, id) order; `ids` null is every take. */
  listAgentSessionTakeCandidates(sourceIds: string[], ids: number[] | null, noteMark: string): Promise<FactsRepairSql.AgentSessionTakeCandidateRow[]>;
  /** The named facts of the source already attributed to `other` and neither expired nor superseded, with their context. */
  listSettledSessionFacts(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; context: string | null }>>;
  /** Re-attributes the named database-only user facts of the source to `other`, appending each note once after `separator`; returns the changed ids. Run it on the transaction. */
  reattributeSessionFacts(sourceId: string, facts: Array<{ id: number; note: string }>, separator: string): Promise<Array<{ id: number | string }>>;
  /** Retires the named active `fact`/`self` takes of the source whose contributing facts are all non-user; returns the retired ids. Run it on the transaction. */
  retireSessionTakes(sourceId: string, takeIds: number[]): Promise<Array<{ id: number | string }>>;
  /** The named unexpired facts of the source with their claim and fence row number. */
  listFenceRewriteRows(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; fact: string; row_num: number }>>;
  /** The named facts of the source attributed to `other`. */
  listOtherAttributedFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>>;
  /** The named takes that are inactive. */
  listInactiveTakeIds(ids: number[]): Promise<Array<{ id: number | string }>>;
  /** Expires the named active database-only facts of the source, putting `context` before their own; returns the expired ids. Run it on the transaction. */
  expireCapturedFacts(sourceId: string, ids: number[], context: string): Promise<Array<{ id: number | string }>>;
  /** The named facts of the source that are expired. */
  listExpiredFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>>;
  /** Per page-less `entity_slug` of these sources: the database-only fact ids and the count of fence-held facts, in (source, slug) order. */
  listPagelessEntityFacts(sourceIds: string[]): Promise<FactsRepairSql.PagelessEntityFactRow[]>;
  /** Whether the `from` and `to` pages are live in the source and the database-only fact ids keyed under `from`. Run it on the transaction. */
  readEntityRehomeState(sourceId: string, fromSlug: string, toSlug: string): Promise<FactsRepairSql.EntityRehomeState | null>;
  /** Re-keys the database-only facts of the source from `fromSlug` to `toSlug`. Run it on the transaction. */
  rehomeEntityFacts(sourceId: string, fromSlug: string, toSlug: string): Promise<void>;

  // Facts statements, search relevance and trust reads (engine-sql/facts-trust.ts). Each runs the statement its caller ran through executeRaw.
  /** One arm of the search fact pool: the keyword arm, or a named entity's active (`entity`) or ended (`entity_ended`) facts, under the caller's read policy; `similarity` is the cosine to `vector` where comparable. */
  listFactsForRelevance(q: FactsTrustSql.FactRelevanceQuery): Promise<FactsTrustSql.FactRelevanceRow[]>;
  /** Facts in the pool the cosine arm cannot compare (no vector, another model, stale text hash or other dimensions), per source, the most first. */
  countUncomparableFacts(q: FactsTrustSql.UncomparableFactsQuery): Promise<Array<{ source_id: string; n: number }>>;
  /** The keyword scan behind a search's saved-facts block: active facts sharing the query's words, with match counts and trust ranks. */
  matchSavedFacts(q: FactsTrustSql.SavedFactsMatchQuery): Promise<FactsTrustSql.SavedFactMatchRow[]>;
  /** A named entity's newest active facts under the caller's read policy, with the collapse columns (search/entity-facts.ts). */
  readEntityNewestFacts(q: FactsTrustSql.EntityNewestFactsQuery): Promise<FactsTrustSql.EntityNewestFactRow[]>;
  /** The query terms each name head matches after stemming with the brain's full-text language, one row per head. */
  matchHeadStems(heads: readonly string[], terms: readonly string[]): Promise<FactsTrustSql.HeadStemRow[]>;
  /** The fact an owner action targets, with its stored trust tier, or null when no fact has the id. */
  readFactForOwnerAction(id: number): Promise<FactsTrustSql.OwnerActionFactRow | null>;
  /** Unconfirmed standing preferences and commitments the write gate flagged (needs write_gate_receipts; the caller probes it). */
  listStandingPreferences(opts: { sourceId?: string; since?: Date }): Promise<FactsTrustSql.StandingPreferenceRow[]>;
  /** Active facts about the entity, kind and visibility that are more trusted than the writer: the keyless conflict slot's candidates. */
  listLexicalContestCandidates(opts: { sourceId: string; entitySlug: string; kind: string; visibility: string; pageSlug?: string; writer: import('../trust/tier.ts').TrustTier }): Promise<Array<{ id: number; fact: string; trust_tier: string }>>;
  /** Of `ids`, the facts held on, derived from, or saved by a backstop naming a page of one of `pageTypes` (search/transcript-quote.ts). */
  listFactsFromQuotedPages(opts: Parameters<typeof FactsTrustSql.listFactsFromQuotedPages>[1]): Promise<number[]>;
  /** Of `ids`, the facts whose stored tier ranks at or above `floor`. */
  listOwnerTierFacts(opts: { ids: readonly number[]; floor: import('../trust/tier.ts').TrustTier }): Promise<number[]>;
  /** The active non-world copy of a claim that a world write would restate, more trusted than the writer, when no active world copy exists. */
  listRestatedPrivateCopies(opts: { sourceId: string; claim: string; entity: string | null; writer: import('../trust/tier.ts').TrustTier }): Promise<Array<{ id: number; visibility: string; trust_tier: string }>>;
  /** How many facts carry taint inputs in their write origin, and how many of those are external_untrusted. */
  countDerivedFactTaint(): Promise<{ derived: number; external: number }>;
  /** Lowers the rows of `ids` whose stored tier ranks above `tier` to `tier` and `origin`, never raising; resolves the ids lowered (trust/taint.ts). */
  lowerTrustTier(table: import('../trust/tier.ts').TaintTable, ids: readonly number[], tier: import('../trust/tier.ts').TrustTier,
    origin: import('../trust/tier.ts').WriteOrigin | null): Promise<number[]>;
  /** How many take, timeline or page rows carry taint inputs in their write origin, and how many of those are external_untrusted. */
  countDerivedRowTaint(table: DerivationTrustSql.DerivedTaintTable): Promise<{ derived: number; external: number }>;
  /** One fixed frontmatter stamp: the retirement stamp on soft-deleted pages, or an atom generation's `source_hash` on its live atoms. */
  stampPageFrontmatter(stamp: DerivationTrustSql.PageFrontmatterStamp): Promise<void>;
  /** The `entity_slug` a stored fact has; null when it has none or no fact has the id. */
  readFactEntitySlugById(id: number): Promise<string | null>;
  /** The replacement fact's fence row, whether both facts sit on one page, both validity starts and the old end; null when either id is gone. */
  readSupersessionReplacement(newId: number, oldId: number): Promise<FactsTrustSql.SupersessionReplacementRow | null>;
  /** Links the old fact to the one that replaced it (`superseded_by`). Run it on the maintenance transaction. */
  linkSupersededFact(oldId: number, newId: number): Promise<void>;
  /** The slug and title of each named live page of the source. */
  listLivePageTitles(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>>;
  /** The normalized aliases of the named pages; throws on a brain older than v110 (no `page_aliases`). */
  listPageAliasNames(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; alias_norm: string }>>;
  /** The newest `scanLimit` live facts of the source whose fingerprint equals the candidate's, in these visibilities, spoken by nobody else, leaving out member-owned pages. */
  listCaptureDuplicateCandidates(opts: { sourceId: string; visibilities: string[]; fact: string; attributedTo: string | null; replacingPage: string | null; scanLimit: number }): Promise<FactsTrustSql.CaptureDuplicateCandidateRow[]>;
  /** The fingerprint of each text, in order (`gbrain_fact_fingerprint`). */
  computeFactFingerprints(texts: string[]): Promise<string[]>;
  /** Unproposed same-bucket claim conflicts in the source, by (new id, old id), at most `cap` rows. */
  listClaimConflictPairs(sourceId: string, auditSources: string[], cap: number): Promise<Array<Record<string, unknown>>>;
  /** How many unproposed claim conflicts the source holds, or null when no row answers. */
  countClaimConflictPairs(sourceId: string, auditSources: string[]): Promise<{ n: number | string } | null>;
  /** The ids of every source that is not archived, in id order (the claim-conflict sweep's default scope). */
  listAllUnarchivedSourceIds(): Promise<Array<{ id: string }>>;

  // Facts statements, conversation fact publication and relink (engine-sql/facts-conversation.ts). Each runs the statement its caller ran through executeRaw.
  /** The newest extractor fact id of a page (null when it has none): the next generation's seed. */
  readNewestConversationFactId(sourceId: string, slug: string): Promise<number | string | null>;
  /** The writer's request `requestId` when its digest is not `digest`, or it was compacted without committing: a spent id. */
  findSpentConversationRequest(principalKind: string, principalId: string, requestId: string, digest: string): Promise<{ request_id: string } | null>;
  /** The writer's unsettled and failed (not yet compacted) conversation-facts batch requests of a source, in journal order. */
  listConversationBatchRequests(principalKind: string, principalId: string, sourceId: string, anchorSlug: string): Promise<FactsConversationSql.ConversationBatchRequestRow[]>;
  /** The stored entry of `generation` in the batch request row `id` (null when the row or the entry is gone). */
  readStoredConversationEntry(id: string, generation: string): Promise<FactsConversationSql.ConversationPageEntry | null>;
  /** A principal's journal counters (outstanding requests, reserved receipt bytes, lifetime ids), null when it has no row. */
  readPrincipalCounters(key: string): Promise<FactsConversationSql.PersistenceCounterRow | null>;
  /** Live pages of the given types in a source that a run would extract: all of them with `force`, else those with no active outcome row. */
  countConversationPagesToExtract(sourceId: string, pageTypes: string[], force: boolean): Promise<number>;
  /** Entity slugs that became aliases of a live page (and no longer name a live page of their own): alias to canonical. */
  listMergedEntityAliases(sourceId: string, slugs: string[]): Promise<FactsConversationSql.MergedAliasRow[]>;
  /** Re-anchors a page's extractor facts from each `from` window key to its `to` window (ids unchanged) in one statement, so a chain of moves among windows of the same text applies at once. */
  moveConversationSourceWindows(sourceId: string, slug: string, moves: ReadonlyArray<{ from: string; to: FactsConversationSql.SourceWindow }>): Promise<void>;
  /** Anchors one batch of freshly inserted facts to their windows; one JSON bind, so JSONB stays an object. */
  stampConversationSourceWindows(pairs: ReadonlyArray<{ id: number; w: FactsConversationSql.SourceWindow | null }>): Promise<void>;
  /** A page's active conversation facts, audit rows aside. */
  countActiveConversationFacts(sourceId: string, slug: string): Promise<number>;
  /** The value hash of the slot's latest conversation-source value at or before `validFrom`, null when there is none. */
  readConversationSlotValueHash(sourceId: string, entitySlug: string, dimension: string, validFrom: Date | string): Promise<{ value_hash: string } | null>;
  /** Deletes a page's audit (outcome) rows; returns the ids removed. */
  deleteConversationOutcomeRows(sourceId: string, slug: string): Promise<Array<{ id: number }>>;
  /** The positions (1-based) of the claims that match a purge tombstone (under their own entity, or any subject for an unbacked name key). */
  listPurgeTombstoneMatches(sourceId: string, claims: { facts: string[]; visibilities: string[]; entitySlugs: Array<string | null>; sources: Array<string | null> }): Promise<Array<{ ord: number | string }>>;
  /** The largest row number any fact of the page holds (null for none). */
  maxConversationRowNum(sourceId: string, slug: string): Promise<number | string | null>;
  /** The slot keys the page's facts already hold. */
  listHeldFactSlots(sourceId: string, slug: string): Promise<FactsConversationSql.HeldFactSlotRow[]>;
  /** The page's conversation facts, audit rows aside: what a clear would lose that a window extraction may not see again. */
  countPageConversationFacts(sourceId: string, slug: string): Promise<number>;
  /** The page's active conversation facts anchored to window `key`. */
  countConversationWindowFacts(sourceId: string, slug: string, key: string): Promise<number>;
  /** The page's active conversation facts a settled collection keeping window `keys` removes: anchored to another window, or unanchored. */
  countConversationFactsOutsideWindows(sourceId: string, slug: string, keys: readonly string[]): Promise<number>;
  /** Clears a page's prior extractor batch before a replacement, keeping the history other records depend on: a row an open loop or another fact's `superseded_by` references is expired, never deleted, and rows `gbrain repair conversation-labels` retired stay expired. */
  clearConversationPageFacts(sourceId: string, slug: string, windows?: { keys: readonly string[]; keep: boolean; unanchored: boolean }): Promise<number>;
  /** The oldest active fence row of the page holding the same claim and source, whatever its visibility. */
  findSameClaimFenceRow(sourceId: string, slug: string, fact: string, source: string | null): Promise<{ id: number | string; visibility: string } | null>;
  /** An ontology observation the page already holds at the same key as fact `factId` (preferring an active one). */
  findOntologyTwin(sourceId: string, slug: string, factId: number): Promise<{ id: number | string } | null>;
  /** The source row a relink publication checks before it writes (null when the source is not registered). */
  readRelinkSource(sourceId: string): Promise<FactsConversationSql.RelinkSourceRow | null>;
  /** Whether the brain has the `fact_relink_attempts` table. */
  factRelinkAttemptsTableExists(): Promise<boolean>;
  /** The page's newest active terminal outcome row and the content hash of its live page (null when it has none). */
  readReextractOutcomeRow(sourceId: string, slug: string): Promise<{ id: number | string; hash: string } | null>;
  /** Derived rows of these pages that sit on an unbacked name key, in (page, id) order. */
  listUnbackedConversationRows(sourceId: string, slugs: string[]): Promise<FactsConversationSql.UnbackedConversationRow[]>;
  /** Derived rows of these pages that are live and have no entity, in (page, id) order. */
  listUnlinkedConversationRows(sourceId: string, slugs: string[]): Promise<FactsConversationSql.UnlinkedConversationRow[]>;
  /** The live pages among `slugs` with their retirement and folder-restriction flags. */
  listEntityHintPages(sourceId: string, slugs: string[]): Promise<FactsConversationSql.EntityHintPageRow[]>;
  /** Locks one page row until the transaction ends. */
  lockPageById(pageId: number): Promise<void>;
  /** The page's expired conversation facts that a relink had linked to a still-live entity page, newest first. */
  listClearedRelinkedFacts(sourceId: string, slug: string): Promise<FactsConversationSql.ClearedRelinkedFactRow[]>;
  /** How many of the facts `ids` carry an embedding. */
  countEmbeddedFactsAmong(sourceId: string, ids: number[]): Promise<number>;
  // Facts statements, write path and recall pool reads (engine-sql/facts-trust.ts, facts-recall.ts)
  /** The durable receipt of a write still queued, running or recovering, or null. */
  readPendingWriteReceipt(principalKind: string, principalId: string, requestId: string): Promise<{ request_id: string; state: string } | null>;
  /** Takes a shared row lock on the source for the rest of the transaction. */
  lockSourceShared(sourceId: string): Promise<void>;
  /** The stale, embeddable facts for `model` and `dims` longer than `maxTokens` bytes, in id order. */
  listOversizedStaleFacts(opts: { sourceId?: string; model: string; dims: number; maxTokens: number }): Promise<FactsTrustSql.OversizedStaleFactRow[]>;
  /** The slug and title of each named live, non-retired person page of the source. */
  listLivePersonTitles(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>>;
  /** The live page `slug` of the source, with the remote read floor when `excludePrivate`, or null. */
  readLiveFactEntityPage(sourceId: string, slug: string, excludePrivate?: boolean): Promise<{ slug: string; type: string | null } | null>;
  /** Takes the advisory lock that serializes changes to one memory setting for the rest of the transaction. */
  lockAgentWritebackSetting(key: string): Promise<void>;
  /** The active facts of the source extracted under `session` or whose context names the page, in id order. */
  listFactsToRetireFromPage(sourceId: string, session: string, slug: string, pattern: string): Promise<FactsTrustSql.RetireFactRow[]>;
  /** The pending decide proposals naming any of `ids`, both facts readable under `policy`, in proposal order. */
  listContestedProposalPairs(ids: number[], policy: FactsTrustSql.ContestedReadPolicy): Promise<FactsTrustSql.ContestedProposalPairRow[]>;
  /** The stored provenance (`facts.source`) of these facts of the source. */
  listFactProvenance(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>>;
  /** Records every input of one derived row (idempotent), in the transaction that writes the row. */
  recordDerivationEdges(derived: FactsTrustSql.DerivationEdgeRef, sourceId: string | null, edges: readonly FactsTrustSql.DerivationEdgeRef[]): Promise<void>;
  /** Expires these facts of the source; returns how many rows it touched. */
  expireDerivedFacts(ids: number[], sourceId: string): Promise<number>;
  /** Deactivates these takes on pages of the source; returns how many rows it touched. */
  deactivateDerivedTakes(ids: number[], sourceId: string): Promise<number>;
  /** Soft-deletes these pages of the source; returns one row per page now hidden, `now` true when this call hid it (#9653). */
  softDeleteDerivedPages(ids: number[], sourceId: string): Promise<Array<{ id: number; now: boolean }>>;
  /** Marks each derived row of `table` as needing re-derivation; `hiddenNow` names the pages this call just hid (#9653). */
  markNeedsRederive(table: string, ids: string[], sourceId: string, requestId: string | null, reason: string, hiddenNow: string[]): Promise<void>;
  /** The withdrawal a remote save onto a member page meets, or null (GST-2346). */
  readMemberPageWithdrawal(q: FactsTrustSql.MemberPageWithdrawalQuery): Promise<FactsTrustSql.WithdrawalRow | null>;
  /** The visibility of one fact of the source, or null. */
  readFactVisibility(id: number, sourceId: string): Promise<{ visibility: string } | null>;
  /** The fact a `remember.replaces` names, with whether the withdrawal ledger covers it, or null. */
  readReplacementTarget(q: FactsTrustSql.ReplacementTargetQuery): Promise<FactsTrustSql.ReplacementTargetRow | null>;
  /** One fact of a supersede pair by id, `lock` taking the row lock; the raw row, or null. */
  readPairFactRow(id: number, lock?: boolean): Promise<Record<string, unknown> | null>;
  /** Expires the old fact of an accepted supersede pair and links it to the new one; returns how many rows it touched. */
  expireSupersededFact(q: { oldId: number; sourceId: string; newId: number; until: string | null }): Promise<number>;
  /** Puts the old fact of an undone supersede pair back as it was; returns how many rows it touched. */
  restoreSupersededFact(q: { oldId: number; sourceId: string; expiredAt: string | null; validUntil: string | null; supersededBy: number | null; expectedSupersededBy: number | null }): Promise<number>;
  /** The columns a forget decides on, for one fact by id, or null. */
  readFactForForget(id: number): Promise<FactsTrustSql.ForgetFactRow | null>;
  /** Expires an active fact for a supersession or retirement (`validUntil` or now ends it). */
  expireFactSuperseded(factId: number, validUntil: string | null): Promise<void>;
  /** Ends an active fact on `today` and expires it. */
  expireFactAtDate(factId: number, today: string): Promise<void>;
  /** Whether the withdrawal ledger covers this fact of the source, or null when the fact is not there. */
  readWithdrawalAnchor(factId: number, sourceId: string): Promise<{ withdrawn: boolean } | null>;
  /** Whether this fact of the source is active, and the md5 of its text, or null. */
  readFactActivity(id: number, sourceId: string): Promise<{ active: boolean; text_hash: string } | null>;
  /** The fact, when it is expired and its context carries `mark`, or null. */
  readReviewAcceptedMark(id: number, sourceId: string, mark: string): Promise<{ id: number } | null>;
  /** Whether index `name` is valid, and its definition; null when there is no such index. */
  readFactsFtsIndexState(name: string): Promise<{ valid: boolean; def: string } | null>;
  /** Swaps the built `idx_facts_fts_next` into place (two renames), in the caller's transaction. */
  swapFactsFtsIndex(): Promise<void>;
  /** The type and declared dimensions of the facts embedding column, or null. */
  readFactsEmbeddingColumn(): Promise<{ type: string; dims: number } | null>;
  /** The pool facts nearest a query embedding by cosine distance under the pool read policy. */
  listNearestFacts(q: FactsRecallSql.NearestFactsQuery): Promise<FactsRecallSql.PoolFactRow[]>;
  /** Every active conversation slot row of the given slots under the pool read policy, by valid_from, id. */
  listSlotRows(scope: FactsTrustSql.FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<FactsRecallSql.SlotFactRow[]>;
  /** The (source, entity) pairs among `keys` that hold an active pool fact and have no live page. */
  listPoolUnbackedKeys(scope: FactsTrustSql.FactPoolScope, keys: readonly string[], limit: number): Promise<Array<{ source_id: string; entity_slug: string }>>;
  /** The newest cue facts that retract or call off a fact, per (source, entity) pair, under the pool read policy. */
  listCallOffCueFacts(scope: FactsTrustSql.FactPoolScope, pairs: ReadonlyArray<{ source_id: string; entity_slug: string }>): Promise<FactsRecallSql.CueFactRow[]>;
  /** The distinct (source, entity) pairs with a fact in the authorized, filtered pool. */
  listPoolEntityPairs(scope: FactsTrustSql.FactPoolScope, filters: FactsTrustSql.FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>>;
  /** The whole fact rows of these ids within these sources. */
  listFactRowsByIds(sourceIds: readonly string[], ids: readonly number[]): Promise<FactsRecallSql.FactRowSqlShape[]>;
  /** The provenance slug of each open non-conversation stint of an entity's (normalised) dimension, each once, sorted. */
  listOntologyStreamSlugs(sourceId: string, entitySlug: string, dimension: string): Promise<string[]>;
  /** The newest open, active, non-conversation stint of the dimension other than `excludeId`, with its stored tier; null: none. */
  readOntologyRival(sourceId: string, entitySlug: string, dimension: string, excludeId: number): Promise<{ id: number; trust_tier: string } | null>;
  /** The ledger stream slug of each listed fact, take or page row found (null where it has none), in no promised order. */
  listBeliefStreamSlugs(table: 'facts' | 'takes' | 'pages', ids: readonly number[]): Promise<Array<string | null>>;
  /** Of `slugs` in `sourceId`, the live pages the read policy of `scope` admits (its sources ignored), at most `limit`. */
  listReadablePageSlugs(sourceId: string, slugs: readonly string[], scope: PageReadScope, limit: number): Promise<string[]>;


  /** True when the source's `config.canonical` is `git` (a git-canonical source); false for anything else, including an unknown id. */
  getSourceStrictness(sourceId: string): Promise<boolean>;

  /** The brain's persistence identity (`persistence_brain.brain_id`), or null when the schema holds no such row. */
  readPersistenceBrainId(): Promise<string | null>;

  /**
   * Declares persistence protocol 2 for the current transaction (`gbrain.persistence_protocol`), with the durable-write
   * settings when given, and returns the brain's persistence id read under the brain row's share lock (null when the
   * row is missing). Outside a transaction the declaration ends with its statement. engine-sql/persistence-declaration.ts.
   */
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }): Promise<string | null>;
  /** Synchronous commit for the rest of the current transaction (engine-sql/persistence-declaration.ts); nothing outside one. */
  requireSynchronousCommit(): Promise<void>;

  /** One local writer registration row (lane, credential hash, grant ceiling, revoked_at), or undefined; `lock` reads it `FOR SHARE`. */
  readLocalWriterRow(id: string, opts?: { lock?: boolean }): Promise<LocalWriterRow | undefined>;

  /** Registers a local writer unless its id or credential hash is already registered; true when this call inserted the row. */
  insertLocalWriterRow(row: LocalWriterInsert): Promise<boolean>;
  /** Revokes a local writer registration, keeping an earlier revocation time; true when the registration exists. */
  revokeLocalWriterRow(id: string): Promise<boolean>;
  /** An OAuth client's receipt grant row, deleted or not, or undefined; `lock` reads it `FOR SHARE` (engine-sql/access-grants.ts). */
  readOAuthClientReceiptGrant(clientId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.ReceiptClientGrant | undefined>;
  /** An access token's receipt grant row, revoked or not, or undefined; `lock` reads it `FOR SHARE`. */
  readAccessTokenReceiptGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.ReceiptTokenGrant | undefined>;
  /** A live (not deleted) OAuth client's membership grant row read `FOR SHARE` (unless `lock` is false), or undefined. */
  readOAuthClientMemberGrant(clientId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.MemberClientGrant | undefined>;
  /** A live (not revoked) access token's grant columns read `FOR SHARE` (unless `lock` is false), or undefined. */
  readAccessTokenMemberGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.MemberTokenGrant | undefined>;
  /** A local writer's grant ceiling and revoked_at read `FOR SHARE`, revoked or not, or undefined. */
  readLocalWriterMemberGrant(id: string): Promise<AccessGrantsSql.MemberLocalWriterGrant | undefined>;
  /** The shared-skill serving epoch, or null when the brain has no shared-skill state row. */
  readSharedSkillServingEpoch(): Promise<string | null>;
}
