
import type { DurablePersistenceSettings } from '../engine-sql/persistence-declaration.ts';
import type * as FactsCycleSql from '../engine-sql/facts-cycle.ts';
import type * as FactsPurgePlanSql from '../engine-sql/facts-purge-plan.ts';
import type * as FactsPurgeSql from '../engine-sql/facts-purge.ts';
import type * as FactsRecallSql from '../engine-sql/facts-recall.ts';
import type * as FactsTrustSql from '../engine-sql/facts-trust.ts';
import type * as ProjectionRebuildSql from '../engine-sql/projection-rebuild.ts';

export interface FactsStatementMembers {
  /** The live page's stored body, or null for no live page. `lock` takes the row lock (inside a transaction). */
  readLiveStoredBody(sourceId: string, slug: string, lock?: boolean): Promise<FactsCycleSql.StoredBodyRow | null>;

  // Facts statements, purge, withdrawal, relink and fence repair (engine-sql/facts-purge.ts). Each runs the statement its caller ran through executeRaw.

  countFactFingerprintLeftovers(sourceId: string, factHash: string, visibility: string, subject: string): Promise<number>;
  loadPurgeTarget(id: number, sourceId: string): Promise<FactsPurgeSql.PurgeTargetRow | null>;
  /** Stores a fact purge tombstone; false when the same (source, visibility, subject, fingerprint) one exists. */
  insertFactPurge(row: FactsPurgeSql.FactPurgeInsert): Promise<boolean>;
  /** The one writer of take purge tombstones: stores one for `claimHash`, or one per distinct take claim of the page for `pageId`, under the subject; false when none was new (each exists, or the page has no takes). Write; run it in the purge transaction. */
  /** Stores a take purge tombstone; false when the same (source, subject, fingerprint) one exists. */
  insertTakePurge(row: FactsPurgeSql.TakePurgeInsert): Promise<boolean>;
  /** One hop of the derivation walk: the rows a `derivation_inputs` edge derives from a frontier row, distinct, by (table, id), at most `limit`. */
  listDerivedRows(frontier: ReadonlyArray<{ table: string; id: string }>, limit: number): Promise<Array<{ derived_table: string; derived_id: string }>>;
  /** Records a page purge's content-hash tombstones under the slug; a hash already tombstoned takes the new slug, request and time. Write; run it in the purge transaction. */
  upsertPagePurges(row: FactsPurgeSql.PagePurgeUpsert): Promise<void>;
  /** The slug's Git effects that carry a commit line or trailers, in id order, locked for the strip. Reads persistence_effects. */
  listPageGitEffectsForStrip(sourceId: string, slug: string): Promise<FactsPurgeSql.PurgeGitEffectRow[]>;
  /** The change reasons the page's versions and its requests (intent and outcome) recorded, each once, null included. Reads page_versions and persistence_requests. */
  listPageChangeReasons(sourceId: string, slug: string, pageId: number): Promise<Array<{ reason: string | null }>>;
  /** The slug's requests whose intent or outcome records a reason, oldest first (10000 at most). Reads persistence_requests. */
  listRequestsRecordingReasons(sourceId: string, slug: string): Promise<FactsPurgeSql.IntentRedactionTarget[]>;
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
  /** How many saved versions of the source's pages carry the claim in their text, title, metadata or segments, or quote it in their change reason (`needle` lowered, `escaped` its JSON form, `reason` the folded reason form). Reads page_versions, pages, page_body_manifest and page_segment_texts. */
  countPurgeVersionsCarryingClaim(sourceId: string, needle: string, escaped: string, reason: string): Promise<number>;
  /** How many review queue, review proposal and decide proposal rows of the source name the facts (`refs` are the ids as text). Reads decide_review_queue, decide_review_proposals and decide_proposals. */
  countPurgeReviewRows(sourceId: string, refs: string[], factIds: number[]): Promise<FactsPurgeSql.PurgeReviewCounts>;
  /** The distinct belief stream slugs (holding page, else entity) of the facts. Reads facts; run it in the purge transaction. */
  listPurgeStreamSlugs(factIds: number[]): Promise<string[]>;
  /** One unfinished write or withdrawal mirror (not the request `ownRequest`) on one of the pages, null for none. Reads persistence_requests and persistence_effects. */
  findPurgeBlockedPublication(sourceId: string, slugs: string[], ownRequest: string): Promise<FactsPurgeSql.PurgeBlockedPublication | null>;
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
  /** Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. */
  insertHoldingPagePurges(sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]): Promise<void>;
  /** Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. */
  deletePurgeReviewQueue(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. */
  deletePurgeReviewProposals(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. */
  deletePurgeDecideProposals(sourceId: string, factIds: number[]): Promise<number>;
  /** Deletes the source's take proposals whose claim text has the fingerprint; how many. Writes take_proposals; run it in the purge transaction. */
  deletePurgeTakeProposals(sourceId: string, factHash: string): Promise<number>;
  /** The id, slug and knowledge revision of the source's pages with these ids, in slug order. Reads pages. */
  listPurgedPageRevisions(sourceId: string, pageIds: number[]): Promise<FactsPurgeSql.PurgedPageRevision[]>;
  /** Queues the withdrawal-mirror, git and embedding effects of the purge request under the source's current incarnation and worktree binding, none twice; `data` is the effect payload. Writes persistence_effects; run it in the purge transaction. */
  insertPurgeEffects(requestId: string, sourceId: string, data: unknown): Promise<void>;
  /** The source's unfinished write requests that publish one of `stagingIds`, by sequence. */
  listRequestsHoldingStagings(sourceId: string, stagingIds: readonly string[]): Promise<FactsPurgePlanSql.PurgeRequestTarget[]>;
  /** The rows a purge verification probe finds, at most `rows + 1`. */
  countPurgeProbe(probe: FactsPurgePlanSql.PurgeProbe, rows: number): Promise<number>;
  /** The first 20 rows a named purge probe lists (link, timeline and raw data rows still carrying the claim). */
  listPurgeProbeItems(probe: FactsPurgePlanSql.PurgeProbe & { kind: 'named' }): Promise<string[]>;
  /** Each chunk of the page with its recorded embedding input and whether its vector in `column` is current under `provenanceModel`. */
  readChunkKeepState(pageId: number, provenanceModel: string | null, column: ProjectionRebuildSql.KeepColumn): Promise<ProjectionRebuildSql.ChunkKeepState[]>;
  /** Clears and marks pending the vector in `column` of each chunk of the page that is of another model, embedded from other text, or not in `currentIds`. */
  clearUnkeptChunkVectors(pageId: number, provenanceModel: string | null, column: ProjectionRebuildSql.KeepColumn, currentIds: readonly number[]): Promise<void>;
  /** Stamps the chunker version a sealed projection was built with on the page. */
  setProjectionChunkerVersion(sourceId: string, slug: string, version: number): Promise<void>;
  /** Whether a queue row of a live inline page (with `media`, or a sealable image) is queued and not marked failed. */
  hasDrainableProjectionJob(opts?: { media?: boolean }): Promise<boolean>;
  /** The page's chunk rows as (id, index) pairs, hashed: an opaque value two reads of one engine compare. */
  readChunkRowsFingerprint(pageId: number): Promise<string>;
  /** Deletes each chunk row of the page whose id is not in `keptIds`. */
  deleteUnkeptChunks(pageId: number, keptIds: readonly number[]): Promise<void>;
  /** The ids, in chunk order, of the page's chunks holding a vector in `column` of another model, embedded from other text, or not in `currentIds`. */
  listStaleChunkVectors(pageId: number, provenanceModel: string | null, column: ProjectionRebuildSql.KeepColumn, currentIds: readonly number[]): Promise<number[]>;
  /** Clears and marks pending the vector in `column` of the page's chunks `ids`. */
  clearChunkVectors(pageId: number, column: ProjectionRebuildSql.KeepColumn, ids: readonly number[]): Promise<void>;
  /** How many of the page's text chunks have no vector in `column`, and their characters (a re-seal's embedding work). */
  countPendingTextChunks(pageId: number, column: ProjectionRebuildSql.KeepColumn): Promise<{ chunks: number; chars: number }>;
  /** The live page's id, knowledge revision and whether its text projection is sealed at it; null when the page is gone. */
  readProjectionHead(sourceId: string, slug: string): Promise<ProjectionRebuildSql.ProjectionHead | null>;
  /** Whether another continuation's live claim (not `claim`) holds the page's deferred chunk replacement at `revision`. */
  isDeferredReplacementHeld(sourceId: string, slug: string, revision: string, claim: string): Promise<boolean>;
  /** Gives the job still queued at `job.revision` the reason `claim` at now. */
  renewDeferredReplacementClaim(job: ProjectionRebuildSql.ProjectionJobKey, claim: string): Promise<void>;
  /** Hands a continuation's claim back: every job of `slug` whose reason is still `claim` gets the deferred replacement reason, its time unchanged. */
  releaseDeferredReplacementClaim(slug: string, claim: string): Promise<void>;
  /** Queues the live page at its knowledge revision with `reason` at now, or moves its queued row there. */
  queuePageProjectionJob(sourceId: string, slug: string, reason: string): Promise<void>;
  /** The stored provenance (`facts.source`) of these facts of the source. */
  listFactProvenance(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>>;
  /** Expires these facts of the source; returns how many rows it touched. */
  expireDerivedFacts(ids: number[], sourceId: string): Promise<number>;
  /** Deactivates these takes on pages of the source; returns how many rows it touched. */
  deactivateDerivedTakes(ids: number[], sourceId: string): Promise<number>;
  /** Soft-deletes these pages of the source; returns one row per page now hidden, `now` true when this call hid it (#9653). */
  softDeleteDerivedPages(ids: number[], sourceId: string): Promise<Array<{ id: number; now: boolean }>>;
  /** Marks each derived row of `table` as needing re-derivation; `hiddenNow` names the pages this call just hid (#9653). */
  markNeedsRederive(table: string, ids: string[], sourceId: string, requestId: string | null, reason: string, hiddenNow: string[]): Promise<void>;
  /** Every active conversation slot row of the given slots under the pool read policy, by valid_from, id. */
  listSlotRows(scope: FactsTrustSql.FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<FactsRecallSql.SlotFactRow[]>;

  /**
   * Declares persistence protocol 2 for the current transaction (`gbrain.persistence_protocol`), with the durable-write
   * settings when given, and returns the brain's persistence id read under the brain row's share lock (null when the
   * row is missing). Outside a transaction the declaration ends with its statement. engine-sql/persistence-declaration.ts.
   */
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }): Promise<string | null>;
  /** Synchronous commit for the rest of the current transaction (engine-sql/persistence-declaration.ts); nothing outside one. */
  requireSynchronousCommit(): Promise<void>;
  /** The resident's window probe: each candidate's source and live page, at its index `i`, looked up by key. */
  probeProjectionWindowCandidates(candidates: readonly ProjectionRebuildSql.ProjectionWindowCandidate[]): Promise<ProjectionRebuildSql.ProjectionWindowProbe[]>;
  /** The planner's estimate of the pages table's rows (0 before statistics, and on an engine without planner statistics). */
  readPagesRowEstimate(): Promise<number>;
  /** The reason of the queue row `key`, or null when it is no longer queued. */
  readProjectionJobReason(key: ProjectionRebuildSql.ProjectionJobKey): Promise<string | null>;
  /** Whether the page is a live segmented page. */
  hasSegmentedPage(sourceId: string, slug: string): Promise<boolean>;
  /** Moves the job still queued at `job.revision` to `revision` at now. */
  rekeyProjectionJob(job: ProjectionRebuildSql.ProjectionJobKey, revision: string): Promise<void>;
  /** Moves the time of the job still queued at `job.revision` to now; with `requeue`, its reason becomes canonical_change. */
  stampDeferredProjectionJob(job: ProjectionRebuildSql.ProjectionJobKey, requeue: boolean): Promise<void>;
  /** Moves the time of the job still queued at `job.revision` to now unless a live segmented claim holds it. */
  touchUnclaimedProjectionJob(job: ProjectionRebuildSql.ProjectionJobKey): Promise<void>;
  /** Moves the time of the job still queued at `job.revision` to now; false when no such job is queued. */
  deferProjectionJob(job: ProjectionRebuildSql.ProjectionJobKey): Promise<boolean>;
}
