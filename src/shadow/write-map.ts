/**
 * The write map (shadow follow, plan PR 1): for every BrainEngine member that changes the primary brain, which rows or
 * relations it changed, so the wrapper can tell the follower what to re-read after the commit.
 *
 * A spec has `tables` (what the member can write at all: the relation-level answer when the wrapper cannot or should
 * not be precise, and what a rejected standalone call publishes) and a `plan(args, result)` returning targets, or
 * null for the relation-level answer. A target is a relation plus a selector on its own columns; a `PageRef` value is a
 * (slug, source) pair the wrapper turns into the page id before the call. `del` marks a target whose matching rows the
 * write can delete or re-key, so the wrapper reads their primary keys first. `late` plans run after the call from its
 * result (new row ids), never delete, and never take page refs.
 *
 * Classes: a member listed in WRITE_MAP is mapped. IGNORED_MEMBERS never change data the shadow copies (lifecycle,
 * locks, logs, caches, the segmented-body staging tables). A name starting with a read prefix is a read and not a
 * write (`resolveTake` starts with one, and is in WRITE_MAP, which is checked first). Any other member is unmapped: the wrapper publishes `invalid`. Getters such as
 * `db` and `engineSql` cannot be intercepted, so SQL run on those escapes the wrapper; reconcile covers it.
 */
export class PageRef {
  constructor(readonly slug: string, readonly source_id: string) {}
}
export type SelectorValue = string | PageRef;
/** `sel` undefined means the whole relation. */
export interface Target { relation: string; sel?: Record<string, SelectorValue>; del?: boolean }
export interface WriteSpec {
  tables: readonly string[];
  plan?: (args: any[], result?: any) => Target[] | null;
  late?: boolean;
}

const DEFAULT_SOURCE = 'default';
const ref = (slug: string, source?: string | null): PageRef => new PageRef(slug, source ?? DEFAULT_SOURCE);
const id = (value: unknown): string => String(value);
const pages = (slug: string, source?: string | null, del = false): Target => ({ relation: 'pages', sel: { source_id: source ?? DEFAULT_SOURCE, slug }, del });
const pageById = (pageId: unknown): Target => ({ relation: 'pages', sel: { id: id(pageId) } });
const child = (relation: string, slug: string, source?: string | null, del = false, extra: Record<string, string> = {}): Target =>
  ({ relation, sel: { page_id: ref(slug, source), ...extra }, del });
const childById = (relation: string, pageId: unknown, del = false, column = 'page_id'): Target => ({ relation, sel: { [column]: id(pageId) }, del });
const whole = (...relations: string[]): Target[] => relations.map((relation) => ({ relation }));
const each = <T>(rows: readonly T[] | undefined, f: (row: T) => Target[]): Target[] => (rows ?? []).flatMap(f);

const linkSide = (from: string, to: string, fromSource?: string | null, toSource?: string | null, del = false): Target =>
  ({ relation: 'links', sel: { from_page_id: ref(from, fromSource), to_page_id: ref(to, toSource) }, del });
const originLinks = (slug: string, source: string, del: boolean, extra: Record<string, string> = {}): Target[] => [
  { relation: 'links', sel: { origin_page_id: ref(slug, source), ...extra }, del },
  { relation: 'links', sel: { from_page_id: ref(slug, source), ...extra }, del },
];
// Writes a member makes through triggers or its own cleanup, so its arguments do not name them.
/** BEFORE DELETE triggers on pages, facts, takes and timeline_entries (and sources changes) write the owner-only marks. */
const OWNER_MARKS: Target[] = whole('owner_only_marks');
/** What deleting a page leaves behind by slug (no foreign key): deletePages scrubs these stores. */
const SLUG_STORES: Target[] = whole('slug_aliases', 'page_aliases', 'slug_rename_history', 'open_loops');
/** A page write that carries `readable_by` frontmatter sets this config flag (trigger pages_access_mark_restricted). */
const RESTRICTIONS_FLAG: Target = { relation: 'config', sel: { key: 'access.restrictions_present' } };
const derivedLinks = (origin: { slug: string; sourceId: string }): Target[] => [
  ...originLinks(origin.slug, origin.sourceId, true),
  { relation: 'wanted_links', sel: { origin_page_id: ref(origin.slug, origin.sourceId) }, del: true },
  pages(origin.slug, origin.sourceId),
];

export const WRITE_MAP: Record<string, WriteSpec> = {
  // Pages
  putPage: { tables: ['pages', 'config'], plan: (a) => [pages(a[0], a[2]?.sourceId), RESTRICTIONS_FLAG] },
  deletePage: { tables: ['pages', 'owner_only_marks'], plan: (a) => [pages(a[0], a[1]?.sourceId, true), ...OWNER_MARKS] },
  deletePages: {
    tables: ['pages', 'owner_only_marks', 'slug_aliases', 'page_aliases', 'slug_rename_history', 'open_loops'],
    plan: (a) => [...each<string>(a[0], (slug) => [pages(slug, a[1]?.sourceId, true)]), ...OWNER_MARKS, ...SLUG_STORES],
  },
  softDeletePage: { tables: ['pages'], plan: (a) => [pages(a[0], a[1]?.sourceId)] },
  softDeletePages: { tables: ['pages'], plan: (a) => each<string>(a[0], (slug) => [pages(slug, a[1]?.sourceId)]) },
  restorePage: { tables: ['pages'], plan: (a) => [pages(a[0], a[1]?.sourceId)] },
  purgeDeletedPages: { tables: ['pages', 'owner_only_marks', 'slug_aliases', 'page_aliases', 'slug_rename_history', 'open_loops'], plan: (a) => (a[1]?.dryRun ? [] : null) },
  updateSlug: {
    tables: ['pages', 'slug_aliases', 'slug_rename_history', 'page_versions', 'page_aliases', 'facts', 'fact_withdrawals', 'owner_only_marks'],
    // A rename also snapshots the page, rebinds facts, aliases and withdrawals to the new slug, and can delete a fact on either slug.
    plan: (a) => [
      pages(a[1], a[2]?.sourceId), ...whole('slug_aliases', 'slug_rename_history', 'page_aliases', 'fact_withdrawals'), child('page_versions', a[0], a[2]?.sourceId),
      ...[a[0], a[1]].flatMap((slug) => ['entity_slug', 'source_markdown_slug'].map((column): Target => ({ relation: 'facts', sel: { [column]: slug }, del: true }))), ...OWNER_MARKS,
    ],
  },
  refreshPageBody: { tables: ['pages'], plan: (a) => [pages(a[0], a[1])] },
  refreshPageOrigin: { tables: ['pages'], plan: (a) => [pages(a[0], a[1]?.sourceId)] },
  updatePageContextualRetrievalState: {
    tables: ['pages', 'content_chunks'],
    plan: (a) => [pages(a[0], a[1]), child('content_chunks', a[0], a[1])],
  },
  stripStaleFrontmatterKeys: { tables: ['pages'], plan: (a) => each<number>(a[0]?.ids, (pid) => [pageById(pid)]) },
  markPagesExtractedBatch: { tables: ['pages'], plan: (a) => each<any>(a[0], (r) => [pages(r.slug, r.source_id)]) },
  markPagesAttendanceBlocked: { tables: ['pages'], plan: (a) => each<any>(a[0], (r) => [pages(r.slug, r.source_id)]) },
  setPageEmbeddingSignature: { tables: ['pages'], plan: (a) => [pages(a[0], a[1]?.sourceId)] },
  setChunkerVersion: { tables: ['pages'], plan: (a) => [pages(a[0], a[2]?.sourceId)] },
  writeTextProjectionSeal: { tables: ['pages'], plan: (a) => [pages(a[0], a[1]?.sourceId)] },
  revertToVersion: { tables: ['pages', 'config'], plan: (a) => [pages(a[0], a[2]?.sourceId), RESTRICTIONS_FLAG] },
  setEmotionalWeightBatch: { tables: ['pages'], plan: (a) => each<any>(a[0], (r) => [pages(r.slug, r.source_id)]) },
  invalidateWithdrawnPages: { tables: ['pages'], plan: (a) => each<string>(a[1], (slug) => [pages(slug, a[0])]) },
  createSegmentedPageShell: { tables: ['pages', 'config'], plan: (a) => [pages(a[0], a[2]?.sourceId), RESTRICTIONS_FLAG] },
  sealSegmentedPage: { tables: ['pages'], plan: (a) => [pageById(a[0])] },
  // Tags (a tag write also moves pages.knowledge_revision)
  addTag: { tables: ['tags', 'pages'], plan: (a) => [child('tags', a[0], a[2]?.sourceId, false, { tag: a[1] }), pages(a[0], a[2]?.sourceId)] },
  removeTag: { tables: ['tags', 'pages'], plan: (a) => [child('tags', a[0], a[2]?.sourceId, true, { tag: a[1] }), pages(a[0], a[2]?.sourceId)] },
  pruneFrontmatterTags: { tables: ['tags', 'pages'], plan: (a) => [child('tags', a[0], a[2]?.sourceId, true), pages(a[0], a[2]?.sourceId)] },
  addPageTagsById: { tables: ['tags', 'pages'], plan: (a) => [childById('tags', a[0]), pageById(a[0])] },
  // Chunks
  upsertChunks: { tables: ['content_chunks', 'pages'], plan: (a) => [child('content_chunks', a[0], a[2]?.sourceId, true), pages(a[0], a[2]?.sourceId)] },
  sealChunks: { tables: ['content_chunks', 'pages'], plan: (a) => [child('content_chunks', a[0], a[2]?.sourceId), pages(a[0], a[2]?.sourceId)] },
  deleteChunks: { tables: ['content_chunks', 'pages'], plan: (a) => [child('content_chunks', a[0], a[1]?.sourceId, true), pages(a[0], a[1]?.sourceId)] },
  deleteChunksExcept: { tables: ['content_chunks', 'pages'], plan: (a) => [child('content_chunks', a[0], a[2]?.sourceId, true), pages(a[0], a[2]?.sourceId)] },
  moveChunkIndexes: { tables: ['content_chunks'], plan: (a) => [childById('content_chunks', a[0], true)] },
  // The contextual-mode proof (page-state/contextual-proof.ts): it clears or stamps the embedding record of chunks of one page.
  clearChunkEmbeddingsByIds: { tables: ['content_chunks'], plan: (a) => [childById('content_chunks', a[0])] },
  writeChunkInputHashes: { tables: ['content_chunks'], plan: (a) => [childById('content_chunks', a[0])] },
  invalidateStaleSignatureEmbeddings: { tables: ['content_chunks'] },
  invalidateContentDriftEmbeddings: { tables: ['content_chunks'] },
  flipBodyGeneration: { tables: ['pages', 'content_chunks'], plan: (a) => [pageById(a[0]?.pageId), childById('content_chunks', a[0]?.pageId, true)] },
  stageSegmentChunks: { tables: ['content_chunks'], plan: (a) => [childById('content_chunks', a[0])] },
  sweepSegments: { tables: ['content_chunks'] },
  // Links
  addLink: { tables: ['links'], plan: (a) => [linkSide(a[0], a[1], a[7]?.fromSourceId, a[7]?.toSourceId)] },
  removeLink: { tables: ['links'], plan: (a) => [linkSide(a[0], a[1], a[4]?.fromSourceId, a[4]?.toSourceId, true)] },
  removeLinksByPagesAndSource: {
    tables: ['links'],
    plan: (a) => each<any>(a[0], (p) => originLinks(p.slug, p.source_id, true, { link_source: a[1]?.linkSource })),
  },
  addLinksBatch: {
    tables: ['links'],
    plan: (a) => each<any>(a[0], (l) => [{ relation: 'links', sel: { from_page_id: ref(l.from_slug, l.from_source_id) } }]),
  },
  replaceDerivedLinks: { tables: ['links', 'wanted_links', 'pages'], plan: (a) => derivedLinks(a[0]) },
  replaceDerivedLinksBatch: { tables: ['links', 'wanted_links', 'pages'], plan: (a) => each<any>(a[0], (item) => derivedLinks(item.origin)) },
  replaceWantedLinkRows: { tables: ['wanted_links'], plan: (a) => [{ relation: 'wanted_links', sel: { origin_page_id: id(a[0]?.pageId) }, del: true }] },
  // Timeline
  addTimelineEntry: { tables: ['timeline_entries'], plan: (a) => [child('timeline_entries', a[0], a[2]?.sourceId)] },
  addTimelineEntriesBatch: { tables: ['timeline_entries'], plan: (a) => each<any>(a[0], (e) => [child('timeline_entries', e.slug, e.source_id)]) },
  upsertEventProjection: { tables: ['timeline_entries'], plan: (a) => [child('timeline_entries', a[0]?.depthSlug, a[0]?.sourceId)] },
  removeTimelineRows: { tables: ['timeline_entries', 'owner_only_marks'], plan: (a) => [childById('timeline_entries', a[0], true), ...OWNER_MARKS] },
  deleteTimelineRows: { tables: ['timeline_entries', 'owner_only_marks'], plan: (a) => [childById('timeline_entries', a[0], true), ...OWNER_MARKS] },
  upsertOpenLoop: { tables: ['open_loops'] },
  closeOpenLoop: { tables: ['open_loops'], plan: (a) => [{ relation: 'open_loops', sel: { id: id(a[1]) } }] },
  attachSourcePath: { tables: ['sources', 'owner_only_marks'], plan: (a) => [{ relation: 'sources', sel: { id: a[0] } }, ...OWNER_MARKS] },
  updateTimelineDetails: { tables: ['timeline_entries'], plan: (a) => [childById('timeline_entries', a[0])] },
  // Facts
  insertFact: {
    tables: ['facts'], late: true,
    plan: (a, r) => [{ relation: 'facts', sel: { id: id(r?.id) } }, ...(a[1]?.supersedeId != null ? [{ relation: 'facts', sel: { id: id(a[1].supersedeId) } }] : [])],
  },
  insertFacts: {
    tables: ['facts', 'owner_only_marks'], late: true,
    plan: (a, r) => (a[2]?.deleteForPageFirst || !Array.isArray(r?.ids) ? null : r.ids.map((fid: unknown) => ({ relation: 'facts', sel: { id: id(fid) } }))),
  },
  deleteFactsForPage: { tables: ['facts', 'owner_only_marks'], plan: (a) => [{ relation: 'facts', sel: { source_id: a[1], source_markdown_slug: a[0] }, del: true }, ...OWNER_MARKS] },
  expireFact: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { id: id(a[0]) } }] },
  // repair visibility: a fenced world fact made private in place (repair/visibility.ts applyFactItem).
  tightenFencedFactVisibility: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { id: id(a[1]) } }] },
  consolidateFact: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { id: id(a[0]) } }] },
  // The remember consumer's supersede: one UPDATE of the old fact row (expired_at, superseded_by, valid_until).
  retireSupersededFact: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { id: id(a[0]?.oldId) } }] },
  migrateFactsToCanonical: { tables: ['facts', 'owner_only_marks'] },
  mergeOntologyFact: { tables: ['facts', 'owner_only_marks'] },
  // Takes
  addTakesBatch: { tables: ['takes'], plan: (a) => each<any>(a[0], (t) => [childById('takes', t.page_id)]) },
  updateTakeEmbeddings: { tables: ['takes'], plan: (a) => each<any>(a[0], (t) => [{ relation: 'takes', sel: { id: id(t.take_id) } }]) },
  updateTake: { tables: ['takes'], plan: (a) => [{ relation: 'takes', sel: { page_id: id(a[0]), row_num: id(a[1]) } }] },
  resolveTake: { tables: ['takes'], plan: (a) => [{ relation: 'takes', sel: { page_id: id(a[0]), row_num: id(a[1]) } }] },
  stampTakeResolvedAt: { tables: ['takes'], plan: (a) => [{ relation: 'takes', sel: { page_id: id(a[0]), row_num: id(a[1]) } }] },
  // The chronicle ledger row the decision names (the seed copies chronicle_page_state row for row).
  upsertChronicleRow: { tables: ['chronicle_page_state'], plan: (a) => [{ relation: 'chronicle_page_state', sel: {
    source_id: String(a[0].sourceId), page_id: id(a[0].pageId), content_hash: String(a[0].contentHash), extractor_version: id(a[0].extractorVersion) } }] },
  supersedeTake: { tables: ['takes'], plan: (a) => [childById('takes', a[0])] },
  deleteTakeRows: { tables: ['takes', 'owner_only_marks'], plan: (a) => [childById('takes', a[0], true), ...OWNER_MARKS] },
  // A page publication's fence projection and fence guard (engine-sql/fence-projection.ts, trust-fence.ts): the page's
  // fact rows by (source, markdown slug) or by id, the page's takes by page id; selector columns never change.
  expireFenceFacts: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { source_id: id(a[0]), source_markdown_slug: id(a[1]) } }] },
  refreshFenceFactFields: { tables: ['facts'], plan: (a) => [{ relation: 'facts', sel: { source_id: id(a[0]), source_markdown_slug: id(a[1]) } }] },
  detachFenceFactRows: { tables: ['facts'], plan: (a) => each<unknown>(a[0], (factId) => [{ relation: 'facts', sel: { id: id(factId) } }]) },
  moveGuardedFenceRows: { tables: ['facts'], plan: (a) => each<any>(a[0], (m) => [{ relation: 'facts', sel: { id: id(m.id) } }]) },
  clearChangedTakeResolutions: { tables: ['takes'], plan: (a) => [childById('takes', a[0])] },
  writeFenceTakeResolutions: { tables: ['takes'], plan: (a) => [childById('takes', a[0])] },
  // A tier-only row change (engine-sql/row-tier.ts): one row of facts, takes or pages by id.
  setRowTrustTier: { tables: ['facts', 'takes', 'pages'], plan: (a) => [{ relation: String(a[0]), sel: { id: id(a[1]) } }] },
  addSynthesisEvidence: { tables: ['synthesis_evidence'], plan: (a) => each<any>(a[0], (e) => [childById('synthesis_evidence', e.synthesis_page_id, false, 'synthesis_page_id')]) },
  // Everything else with a precise home
  putRawData: { tables: ['raw_data'], plan: (a) => [child('raw_data', a[0], a[3]?.sourceId, false, { source: a[1] })] },
  upsertFile: { tables: ['files'], plan: (a) => [{ relation: 'files', sel: { source_id: a[0]?.source_id ?? DEFAULT_SOURCE, storage_path: a[0]?.storage_path } }] },
  setConfig: { tables: ['config'], plan: (a) => [{ relation: 'config', sel: { key: a[0] } }] },
  unsetConfig: { tables: ['config'], plan: (a) => [{ relation: 'config', sel: { key: a[0] }, del: true }] },
  setPageAliases: { tables: ['page_aliases'], plan: (a) => [{ relation: 'page_aliases', sel: { source_id: a[1], slug: a[0] }, del: true }] },
  replaceDerivedAliases: { tables: ['page_aliases'], plan: (a) => [{ relation: 'page_aliases', sel: { source_id: a[1], slug: a[0] }, del: true }] },
  updateSourceConfig: { tables: ['sources', 'owner_only_marks'], plan: (a) => [{ relation: 'sources', sel: { id: a[0] } }, ...OWNER_MARKS] },
  upsertGuestSource: { tables: ['guest_sources'], plan: (a) => [{ relation: 'guest_sources', sel: { source_id: a[0] } }] },
  insertGuestMark: { tables: ['guest_marks'], plan: (a) => [child('guest_marks', a[0]?.slug, a[0]?.sourceId)] },
  createVersion: { tables: ['page_versions'], plan: (a) => [child('page_versions', a[0], a[1]?.sourceId, true)] },
  // The owner's allow rules (trust/allow-rules.ts): an add writes one row the reply names (a new one, or the active one
  // already holding its key, which it leaves unchanged); a remove marks the rule `id` removed, keeping the row.
  addTrustAllowRule: {
    tables: ['trust_allow_rules'], late: true,
    plan: (_a, r) => (r?.row?.id != null ? [{ relation: 'trust_allow_rules', sel: { id: id(r.row.id) } }] : []),
  },
  removeTrustAllowRule: { tables: ['trust_allow_rules'], plan: (a) => [{ relation: 'trust_allow_rules', sel: { id: id(a[0]) } }] },
  // Relation-level: no stable selector on the member's arguments
  applyIdentityDecisions: { tables: ['entity_identities', 'entity_identity_reviews'] },
  addCodeEdges: { tables: ['code_edges_chunk', 'code_edges_symbol'] },
  deleteCodeEdgesForChunks: { tables: ['code_edges_chunk', 'code_edges_symbol'] },
  ownerOnlyMarkTriggers: { tables: ['owner_only_marks'], plan: (a) => (a[0]?.ensure ? null : []) },
  // The decide store (engine-sql/decide-store.ts, decide-proposals.ts): each member writes one table and names no stable selector.
  upsertDecideState: { tables: ['decide_state'] },
  deleteDecideState: { tables: ['decide_state'] },
  ensureDecideState: { tables: ['decide_state'] },
  insertDecideSpend: { tables: ['decide_spend'] },
  insertDecideReceipts: { tables: ['decision_receipts'] },
  pruneDecideReceipts: { tables: ['decision_receipts', 'decide_spend'] },
  insertDecideCalibration: { tables: ['decide_calibrations'] },
  storeDecideQualification: { tables: ['decide_calibrations'] },
  setDecideCalibrationRetired: { tables: ['decide_calibrations'] },
  insertDecideProposal: { tables: ['decide_proposals'] },
  transitionDecideProposal: { tables: ['decide_proposals'] },
  insertDecideReviewProposal: { tables: ['decide_review_proposals'] },
  transitionDecideReviewProposal: { tables: ['decide_review_proposals'] },
  applyDecideReviewQueue: { tables: ['decide_review_queue'] },
  applyDecideSweepDeferred: { tables: ['decide_sweep_deferred'] },
};

/** A schema change: the copied tables may no longer match what the follower expects. */
export const SCHEMA_MEMBERS: ReadonlySet<string> = new Set(['runMigration']);

/** Members that never change data the shadow copies. */
export const IGNORED_MEMBERS: ReadonlySet<string> = new Set([
  // Connection lifecycle and plumbing (initSchema runs at startup; a migration it applies is runMigration's concern).
  'connect', 'connectForRestore', 'connectWithHeldLock', 'disconnect', 'reconnect', 'initSchema', 'registerBeforeDisconnect',
  'closeRetainingLock', 'holdsDatastoreLock', 'batchRetry', 'applyTransactionSettings', 'applyForwardReferenceBootstrap',
  'lockPageKeys', 'lockRegisteredSourceIds', 'keywordBoundedRead', 'rewriteLinks', 'matchTakeRows',
  // Reads a guest source's writers and sets gbrain.guest_note for the transaction; it writes no row.
  'claimGuestNotePublication',
  // Writes only persistence_requests (a request's takeHoldersUsed), which the shadow does not copy (seed/not_copied.rs: MachineLocal).
  'recordTakeHoldersUsed',
  // Locks.
  'acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'deleteCycleLock', 'deleteCycleLockIfStale',
  // Logs, caches and machine-local state (not copied).
  'logIngest', 'logEvalCandidate', 'logEvalCaptureFailure', 'deleteEvalCandidatesBefore', 'writeContradictionsRun',
  'putContradictionCacheEntry', 'sweepContradictionCache', 'putDreamVerdict', 'sweepDreamVerdicts', 'putCodeTraversalCache',
  'clearCodeTraversalCache', 'insertLocalWriterRow',
  // The read-view digest cache of a segmented page (page_view_digests is a seed not-copied cache, rust/docs/store/seed.md).
  'writePageViewDigest',
  // Segmented-body staging and derivation tables (not copied).
  'allocateBodyOccurrenceIds', 'stageSegmentTexts', 'stageManifestRows', 'openBodyStaging', 'setBodyStagingState',
  'upsertSegmentDerivations', 'retireSegmentDerivations',
  // The schema-pack query-cache invalidation: query_cache is a cache the seed leaves behind (rust/docs/store/seed.md).
  'invalidateQueryCacheRows',
  // The memory proposal queue: the Rust store does not serve memory_proposals yet (rust/docs/store/seed.md lists it under "Gaps: not served by the Rust store"),
  // so the seed does not copy it, nothing follows it, and a row in it blocks a swap.
  'expireMemoryProposals', 'purgeMemoryProposals',
  // The applied-capture records (ingest_applied_captures): bookkeeping the seed does not copy (rust/docs/store/seed.md), so
  // the stale purge changes nothing the shadow follows.
  'purgeStaleAppliedCaptures',
  // The eval harness pause (engine-sql/eval-harness-reads.ts): it calls pauseManagedPersistence and restoreManagedPersistence
  // on the engine itself, which the unmapped-write list names; it is still a writer (IGNORED_WRITE_MEMBERS).
  'withManagedPersistencePaused',
]);

/**
 * The ignored members that do write the brain database (locks, logs, caches, staging). The follower does not copy them,
 * but a process that only calls them is still a writer, so the writer observer notes it (wrapper.ts mayWrite).
 */
export const IGNORED_WRITE_MEMBERS: ReadonlySet<string> = new Set([
  'acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'deleteCycleLock', 'deleteCycleLockIfStale',
  'logIngest', 'logEvalCandidate', 'logEvalCaptureFailure', 'deleteEvalCandidatesBefore', 'writeContradictionsRun',
  'putContradictionCacheEntry', 'sweepContradictionCache', 'putDreamVerdict', 'sweepDreamVerdicts', 'putCodeTraversalCache',
  'clearCodeTraversalCache', 'insertLocalWriterRow',
  'allocateBodyOccurrenceIds', 'stageSegmentTexts', 'stageManifestRows', 'openBodyStaging', 'setBodyStagingState',
  'upsertSegmentDerivations', 'retireSegmentDerivations',
  'withManagedPersistencePaused',
]);

/** Members that run caller SQL; the wrapper parses it (sql-writes.ts). */
export const RAW_MEMBERS: ReadonlySet<string> = new Set(['executeRaw', 'executeRawDirect']);

const READ_PREFIX = /^(get|list|count|find|search|read|resolve|has|is|sum|cosines|traverse|relational|batchLoad|discover|load)/;
/** Read-only members whose names do not start with a read prefix (search-read helpers). */
export const READ_ONLY_MEMBERS: ReadonlySet<string> = new Set([
  'probePurgeDerivations',
  'activeEmbeddingColId', 'aliasCanonicalRefs', 'generatedPagesIn', 'livePageIdsAt', 'pageCollapseFacts', 'pagesLinkingTo',
  'slugsEndingIn', 'supersedingPageSlugs',
  'dailyDecideSpend', 'decideConflictNoEntityCounts', 'decideSlotUsage',
  'normalizeFenceLines', 'sampleEffectiveDates', 'sampleEffectiveDateSources', 'sharedSkillPackTablePresent',
  'storedTimelineRowsByPageIds',
  // Sets transaction-local settings (the persistence identity and write context) and writes no row: the raw set_config statement it replaced was never a write to follow or compare.
  'setWriteContext',
  // The read-view digest cache read (the name carries a read prefix; listed so the class is explicit).
  'readPageViewDigest',
  // Batch 11 typed reads (page purge port, caller-links, chronicle): row locks and statements that only read.
  // The eval harness text scan (engine-sql/eval-harness-reads.ts): SELECTs only.
  'scanTextColumns',
  'factsOrAliasesMayMatch', 'lockHeldConcept', 'lockLiveConceptMembers', 'lockSourceForUpdate', 'relationExists', 'sweepJournalChunk', 'takeProposalCached',
  // The trunk's typed reads whose names carry no read prefix (the owner socket's read classes, owner-ipc/typed-member-classes.ts).
  'accessTokenLive', 'closedLoopWithActiveFact', 'codeChunksExist', 'computeFactFingerprints', 'currentCodeChunksExist',
  'edgeClosureLanded', 'edgeValidityCounts', 'entityFeatureCoverage', 'entityGraphCoverage', 'factReadableUnder',
  'factRelinkAttemptsTableExists', 'filterPagesAtRevision', 'filterUnarchivedSourceIds', 'heldEntityPageDeleted',
  'heldGenerationRowsForInput', 'heldMoveDue', 'heldTargetPageLive', 'holdsNotifierLease', 'inboundLinkCoverage',
  'linkRelationshipKeysForOrigin', 'linkRelationshipKeysForPages', 'liveGenerationForOperation', 'lockActiveAccessTokens',
  'lockAllSourceRows', 'lockBodyStagingState', 'lockLegacyAccessTokens', 'lockSegmentedGenerationPage', 'lockLivePagesByKey', 'lockSharedSkillBrainId',
  'loopFactDrift', 'matchHeadStems', 'matchSavedFacts', 'maxConversationRowNum', 'maxFenceRowNum', 'maxFenceRowNumOfPage',
  'nextLivePageAfter', 'oauthClientHoldsAuthorization', 'oauthClientLive', 'originIndexPresent', 'ownerReachesFact',
  'ownsSchemaTables', 'pageAwaitsRederive', 'pageHasFrontmatterKey', 'pageHasTimelineEntries', 'pagePrefixSamples',
  'pageSlugExists', 'pageTypeTotals', 'pendingTrustProposalsFor', 'pickValidTimeEdition', 'pingStore', 'planFactPurgeIds',
  'planFactPurgeTakes', 'probeIdleWork', 'probeLiveConsumerRows', 'probeNoopEmbeddingSettle', 'probePageTypes',
  'probeProjectionWindowCandidates', 'probePurgeDerivations', 'probeTornPages', 'projectionRebuildProgress',
  'purgeSubjectPageLive', 'rankEntities', 'recentWriterVersions', 'scanExactBatch', 'scanUnfencedFactRows',
  'selectClaimableEffect', 'selectClaimableWrite', 'selectProjectionWindowJobs', 'sourceIdExists',
  'staleLinkRelationshipKeys', 'wordLexemes',
  // The member handover preview reads (engine-sql/handover-reads.ts) whose names carry no read prefix.
  'countMemberPage', 'countMemberPageFacts', 'countMemberBoundCredentials',
  // Lane 15 reads whose names carry no read prefix: the schema-pack retype probe and the explain-target probe.
  'probeRetypeRows', 'probeTargetRows',
  // Batch 12: row-lock and existence reads (SELECTs only) of the persistence, repair and secret-store lanes.
  'filterPageIdsByFrontmatter', 'lockEffectRow', 'secretEntryExists',
  // Lane 15 reads whose names carry no read prefix: the schema-pack sync probe and the who-read tally.
  'probeUntypedPathPrefix', 'tallyAccessReadsOfPages',
  // Lane 17: the git-gap census marks its transaction read-only and writes nothing (engine-sql/git-gap-census.ts).
  'markTransactionReadOnly',
]);

/**
 * The trunk's typed write members the write map does not cover yet (TODOS.md, loss row 46 in docs/designs/RUST_ENGINE.md).
 * Each one writes through its own statement, so a write through it is unmapped: the wrapper publishes `invalid`
 * (`unmapped_write:<member>`) and reconcile re-reads what changed, as for any member outside the map. The set is exact
 * (test/shadow-follow-producer.test.ts): a member that gains a write plan leaves it, and an engine member that is
 * in none of the classes fails the test, so a new typed write is never added without a decision.
 */
export const UNMAPPED_WRITE_MEMBERS: ReadonlySet<string> = new Set([
  'abortPurgedStagings', 'acknowledgeSharedSkillDeliveryBatch', 'activateGenerationRows', 'addAccessGroupMembers',
  'addJobTokens', 'addLoopSuppression', 'addPersistenceCounters', 'addWakeCron', 'adjustGitHoldSummary', 'admitJob',
  'adoptFactIntoFence', 'advanceEffectRow', 'advanceSourceCommit', 'advanceSourcePurgeEpoch', 'advanceSyncCheckpoint',
  'ageOutSessionState', 'appendFactForgetReason', 'appendOpCheckpointPaths', 'applyAccessRuleChanges',
  'applyGazetteerEntryChanges', 'applyLinkTemporalRows', 'applyManagedSyncRetireLimits', 'approveAccessPolicyRevision',
  'archiveSource', 'assertCycleLease', 'attachWantedMarkerJob', 'backfillSearchVectors', 'beginSnapshotRead',
  'bindPageOrigin', 'blankPurgeCoreEditNotices', 'bumpGenerationValve', 'bumpPageKnowledgeRevision', 'bumpPageRetrievals',
  'bumpSourcePurgeEpoch', 'bumpWithdrawnPageRevisions', 'cancelJobs', 'cancelWriteRow', 'capSessionStatePerClient',
  'claimCoalescedGitEffects', 'claimFilePage', 'claimHousekeepingTurn', 'claimNextJob', 'claimNotifierLease', 'claimSegmentedProjection',
  'claimWakeForgets', 'claimWakeWatch', 'clearChunkVectors', 'clearConversationPageFacts', 'clearFenceCandidateParts',
  'clearFenceHoldRows', 'clearGenerationAttempts', 'clearImageSealVectors', 'clearMentionSourceIndex',
  'clearOntologySlots', 'clearPageChildOrphans', 'clearTieHeldGenerationRows', 'clearUnkeptChunkVectors',
  'clearWantedMarker', 'closeMutedLoops', 'closeThreadLoops', 'coalesceOnIdempotencyKey', 'compactTerminalIntent',
  'completeEffectRow', 'completeHousekeepingTurn', 'completeJob', 'completeSubagentToolExecution', 'completeSyncedRefresh',
  'completeWriteRow', 'convertLegacyAccessTokenGrant', 'deactivateDerivedTakes', 'decideWriteGateHold',
  'declarePersistence', 'declareSyncImportPageCursor', 'deferClaimForQuietHours', 'deferProjectionJob', 'delayActiveJob', 'deleteAccessGroup',
  'deleteAccessMemberLink', 'deleteChunksForPages', 'deleteConsumerRow', 'deleteConversationOutcomeRows',
  'deleteDerivedAliasesForSlugs', 'deleteEventProjections', 'deleteExpiredOauthCredentials', 'deleteFactRelinkMemos',
  'deleteGitHoldRow', 'deleteJobAttachment', 'deleteLinksById', 'deleteManagedSyncFailureObservation', 'deleteManagedSyncFailureRow', 'deleteManagedSyncManifest',
  'deleteOAuthClient', 'deleteOauthClientCodes', 'deleteOauthClientRow', 'deleteOauthClientTokens', 'deleteOauthCode',
  'deleteOauthRefreshToken', 'deleteOauthTokenByHash', 'deleteOpCheckpoint', 'deleteOpCheckpointPaths',
  'deleteOrphanBinding', 'deleteOrphanConnectorCheckpoint', 'deleteOrphanedAliases', 'deleteOwnedLinks',
  'deletePageViewDigests', 'deleteProjectionJob', 'deletePurgeDecideProposals', 'deletePurgeOpenLoops',
  'deletePurgeReviewProposals', 'deletePurgeReviewQueue', 'deletePurgeTakeProposals', 'deletePurgeTrustProposals',
  'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts', 'deletePurgedChunks', 'deletePurgedFacts',
  'deletePurgedStagingParts', 'deletePurgedTakes', 'deleteRekeyLosers', 'deleteRewrittenSegmentDerivations',
  'deleteSourceMentionLinks', 'deleteSourceRecord', 'deleteStalePageWriteGateReceipts', 'deleteStaleWriteGateReceipts',
  'deleteTakesByIds', 'deleteTerminalJob', 'deleteUnkeptChunks', 'deleteUnreferencedPurgedTexts',
  'deleteUnstagedSegmentChunks', 'deriveAccessReaders', 'detachChildJob', 'detachPageOrigin', 'endBeliefLifetime',
  'endWakeWatches', 'enrollSharedSkillMember', 'ensureAccessPolicyState', 'ensureDreamMapConfigRow',
  'ensureFactsKeywordIndex', 'expireAllOauthCredentials', 'expireAndDetachFact', 'expireCapturedFacts',
  'expireDerivedFacts', 'expireFactAtDate', 'expireFactInPlace', 'expireFactRows', 'expireFactSuperseded',
  'expireFactWithNote', 'expireFactsByIds', 'expireFactsByWithdrawal', 'expireFactsOfGonePages', 'expirePageFactsBySource',
  'expireSourceFactNow', 'expireSpendReservations', 'expireStaleWriteClaims', 'expireSupersededFact', 'failEffectRow',
  'failJob', 'failParentJob', 'failSubagentToolExecution', 'fetchSyncImportPageCursor', 'finishAccessRestamp',
  'forgetWakeCredential', 'forgetWakeMember', 'gitDurabilityStore', 'gitEffectStore', 'holdPageEmbedding', 'insertAccessMember', 'insertAccessMemberLink',
  'insertAccessMigration', 'insertAccessPolicyRevision', 'insertAccessReadLogRows', 'insertAccessToken', 'insertBeliefEvents',
  'insertBeliefRedaction', 'insertCalibrationProfile', 'insertCanonicalTimelineRows', 'insertDerivedAliasRows',
  'insertFactPurge', 'insertFactWithdrawal', 'insertHoldingPagePurges', 'insertJobAttachment', 'insertLeasePressure',
  'insertOauthClient', 'insertOauthClientGrant', 'insertOauthCode', 'insertOauthGrantAudit', 'insertOauthToken',
  'insertPublicationEffects', 'insertPurgeEffects', 'insertReasonPurgeTombstones', 'insertSource', 'insertSpendLog',
  'insertSpendReservation', 'insertSubagentMessage', 'insertTakePurge', 'insertTopologyChange', 'insertTrustProposal',
  'insertWithdrawalEffects', 'insertWriteRequest', 'insertWriteRequestGroup', 'installChunkEmbeddings', 'killTimedOutJobs',
  'killWallClockJobs', 'leaveSharedSkillMember', 'linkConversationFact', 'linkEntityIdentityRow', 'linkSupersededFact',
  'lockAccessPolicy', 'lockAgentWritebackSetting', 'lockDreamMapConfigRow', 'lockEffectClaimRow', 'lockEffectGuard',
  'lockEmbeddingSwitch', 'lockFactForWithdrawal', 'lockFactRows', 'lockGenerationKey', 'lockGitHoldSummary',
  'lockMentionEntries', 'lockMentionSources', 'lockNoopEmbeddingWindow', 'lockOAuthClient', 'lockOauthClientName',
  'lockOverdueHold', 'lockPageById', 'lockPersistenceCounters', 'lockPurgeSource', 'lockReconcileRevision',
  'lockSourceRow', 'lockSourceShared', 'lockWriteRequest', 'lockWriteRequestsById', 'logChatUsage', 'logMcpRequest',
  'lowerTrustTier', 'manualLinkStore', 'markAccessRevisionsApplied', 'markBeliefCommits', 'markEdgeProposalStale', 'markEdgeProposalUndone',
  'markGenerationActivated', 'markJobWatchdogSuspect', 'markNeedsRederive', 'markProjectionRebuildFailed',
  'markRevertedEdgeProposals', 'markSourceSynced', 'markSpendUsageUnknown', 'mintBeliefLifetime',
  'moveConversationSourceWindows', 'moveFactToPage', 'moveFactWithdrawalSubject', 'moveKeptFactRows',
  'openPageEmbeddingHold', 'openWakeWatch', 'parkEffectRow', 'patchOauthClient', 'pauseJob', 'persistOauthClientGrant',
  'placeRelinkedFact', 'postInboxMessage', 'promoteDelayedJobs', 'pruneAccessReadLog', 'pruneHoldingPageVersions', 'pruneJobs',
  'persistenceUpkeepStore', 'pruneMcpRequestLogBatch', 'pruneSatisfiedWantedMarkers', 'publicationJournalStore', 'purgeCalibrationProfilesByWave',
  'purgeStaleCheckpoints', 'queuePageProjectionJob', 'queueWakeForget', 'queueWithdrawalReview', 'rearmLinksEffects',
  'reattributeSessionFacts', 'rebindSharedSkillMember', 'reclaimStalledJobs', 'recordAccessMigrationPhase',
  'recordDerivationEdges', 'recordDreamBreakerReset', 'recordEdgeProposal', 'recordGenerationActivation',
  'recordHeldGenerationRow', 'recordNotifierSyncerHost', 'recordPageEmbeddingHold', 'recordSearchTelemetry',
  'recordSubagentToolExecutions', 'recordTokenSetupReads', 'recordWakeCronRun', 'recordWakeTermsAcceptance',
  'recountMentionIndexStatus', 'redactVersionChangeReasons', 'refreshConsolidatedTakeSource', 'refreshDrainLeaseHolder',
  'registerFileRow', 'registerPurgeRedaction', 'rehomeEntityFacts', 'rejectOpenEdgeProposal', 'rekeyProjectionJob',
  'releaseBeliefRedactions', 'releaseDeferredReplacementClaim', 'releaseDrainLeaseHolder', 'releaseNotifierLease',
  'releasePageEmbeddingLease', 'releasePurgeRedactionsForField', 'releaseSegmentedProjectionClaim',
  'releaseClaimForPause', 'releaseUnpublishedClaim', 'releaseWatchdogClaim', 'removeAccessGroupMembers', 'removeLoopSuppression',
  'removeManualLinkTransitions', 'removePageFrontmatterKeys', 'removeWakeCron', 'renameBeliefLifetime', 'renewConsumerRow',
  'renewDeferredReplacementClaim', 'renewEffectClaim', 'renewJobLease', 'renewPageEmbeddingLease',
  'renewPrivateQueueLease', 'renewSegmentedProjectionClaim', 'renewWriteClaim', 'replaceAccessInvalidCoverage',
  'replaceGitHoldRow', 'replaceSearchVectorTriggerFunction', 'replaceSourceConfig', 'replaceVersionChangeReasons',
  'replayPagePurges', 'repointInboundLinks', 'repointOutboundLinks', 'repointSupersededToKept', 'requestGitHoldRetry',
  'requeueEffectRow', 'requeueMutedLoops', 'requireSynchronousCommit', 'reserveClientSpend', 'reserveGroupSpend',
  'reservePageEmbedding', 'resetMentionRevisions', 'resetSourceMentionIndexRevisions', 'restampAccessWindow',
  'restoreArchivedSource', 'restoreEventProjection', 'restoreFactPreimage', 'restoreOntologyFact', 'restorePageTrust',
  'restoreRedactedFactTexts', 'restoreSupersededFact', 'resumeJob', 'retireManagedSyncCursor',
  'retireManagedSyncPassSlugMode', 'retireSessionTakes', 'retryBusyEffectRow', 'retryEffectRow', 'retryJob',
  'revokeAccessToken', 'revokeAccessTokenById', 'revokeAccessTokensNamed', 'revokeLocalWriterRow', 'rewriteTimelineRow',
  'scrubGenerationPageRows', 'scrubGenerationTextRows', 'sealImagePages', 'sealImportedPage', 'selectFactsReconcileDrain',
  'setAccessMemberDisabled', 'setAccessMemberEmail', 'setAccessMemberKind', 'setAccessMemberLabelledOnly',
  'setAccessTokenMinTrust', 'setAccessTokenReadSharedRevision', 'setConsolidatedFactValidUntil', 'setEdgeProposalStatus',
  'setEffectTransactionLimits', 'setFactSupersededBy', 'setLocalStatementTimeout', 'setOauthClientReadSharedRevision',
  'setOauthClientRevision', 'setOauthClientTokenTtl', 'setPageType', 'setProjectionChunkerVersion', 'setPurgeEffectData',
  'setPurgeProbeTimeout', 'setPurgeVersionBody', 'setSourceChunkerVersion', 'setSourceContextualMode',
  'setTakeSupersededBy', 'settleFactsReconcile', 'settleFreshnessMarker', 'settleGenerationMember',
  'settleMuteRecheck', 'settleNoopEmbeddingRows', 'settlePageEmbeddingReservation', 'settleSpendReservation',
  'settleSpendWithLog', 'settleWakeForget', 'settleWakeWatch', 'shareLockWriteCredential', 'softDeleteDerivedPages',
  'softDeleteOauthClient', 'stampConversationSourceWindows', 'stampDeferredProjectionJob', 'stampDreamPageProvenance',
  'stampEffectClaim', 'stampPageFrontmatter', 'stampPageIngest', 'stampVersionChangeReason', 'stampWorktreeHeartbeats',
  'stampWriteClaim', 'startSubagentToolExecution', 'storeSegmentDerivationsIfLive', 'swapFactsFtsIndex',
  'switchAccessMigration', 'takePageEmbeddingLease', 'tombstoneAccessMember', 'topologyStore', 'touchAccessTokenLastUsed',
  'touchUnclaimedProjectionJob', 'transitionTrustProposal', 'trueUpReservations', 'unlinkEntityIdentityRow',
  'updateFenceFactCells', 'updateJobProgress', 'updateOauthClientBudget', 'updatePageBodyForPurge',
  'updatePendingTrustProposalAfter', 'upsertCliFileRow', 'upsertFactRelinkAttempt', 'upsertFenceCandidatePart',
  'upsertOpFileRow', 'upsertPageAliasState', 'upsertPageMentionState', 'upsertPagePurges', 'upsertPageWriteGateReceipt',
  'upsertRawFileRow', 'upsertSessionState', 'upsertSyncFileRow', 'upsertWantedMarker', 'upsertWriteGateHold',
  'upsertWriteGateReceipt', 'vacuumPurgedTables', 'worktreeClaimStore', 'writeAccessStoreConfig', 'writeAccessTokenGrant',
  'writeAccessTokenPrivateGrant', 'writeCheckpointManifest', 'writeCredentialBinding', 'writeCredentialReadsUnscoped',
  'writeDoctorLastKnown', 'writeDrainLeaseHolder', 'writeDreamMapConfigRow', 'writeFenceScanRecord', 'writeGitHoldRow',
  'writeLinkRelationshipState', 'writeManualLinkTransitions', 'writeMentionIndexStatus', 'writeNotifierCoverage',
  'writeNotifierState', 'writeOpCheckpointKeys', 'writeOpCheckpointRecord', 'writeOpCheckpointRecords',
  'writeReasonPurgeTombstones', 'writeSharedSkillPolicy', 'writeSharedSkillRevision', 'writeSourceSyncHeartbeat',
  'writeSourceUpstreamObservation', 'writeSyncAdmissionStamp', 'writeSyncPassRow', 'writeTrustScanCursor',
  'writerAdminStore', 'writerReleaseStore',
  // Lane 16 repair applies (engine-sql/repair-applies.ts, atom-generation.ts).
  'detachFenceRowFacts', 'expireApprovedFacts', 'linkStruckDuplicateFacts', 'lockApprovedFacts', 'moveFactClaimDates',
  'recordAtomGenerationBump',
  'restoreConsolidationTie', 'restoreExtractorFact', 'supersedeDuplicateFacts', 'tightenDatabaseFactVisibility',
  // Batch 11 typed writes (page purge port, take grades, horizons and proposals, chronicle ledger, connector stamps, sync conversions,
  // source rename): not mapped to a write plan yet, so they publish invalid like the rest of the list.
  'carryConceptIncomingLinks', 'chronicleStore', 'claimTakeProposal', 'clearQueryCache', 'continueDerivationSweep', 'deleteFactPurgesByRequests', 'deleteOriginHoldRows', 'deletePagePurgeTombstones', 'deletePageSegmentTexts', 'deletePageStagings', 'deletePurgedFeedbackRows', 'deletePurgedNameStoreRows', 'deletePurgedPageFacts', 'deletePurgedPageFiles', 'deletePurgedPageGateReceipts', 'deletePurgedPageHolds', 'deletePurgedPageTrustProposals', 'deletePurgedSlugHolds', 'deletePurgedSlugStoreRows', 'deleteTakeGrade', 'deleteTakeHorizon', 'deleteTakeProposalTombstones', 'deleteTakePurgesByRequests', 'insertConfigIfAbsent', 'insertPageFactPurges', 'insertTakeGrade', 'insertTakeNudge', 'insertTakeProposal', 'pruneChronicleReservations', 'purgeTakeNudgesByWave', 'recordConnectorSyncAttempt', 'recordDerivationPurgeRow', 'recordOwedPurgeRows', 'recordSyncConversion', 'redactWriteRequestRow', 'rejectTakeProposal', 'releaseTakeProposalClaim', 'releaseTerminalBytes', 'renameSource', 'reserveChronicleJudgeSlot', 'revertWaveTakeResolutions', 'setTakeProposalPromotedRow', 'sweepPageTextsForClaims', 'unapplyWaveTakeGrades', 'upsertDerivedOriginPark', 'upsertExtractRollupDay', 'upsertTakeHorizon', 'writeConnectorDbCursor', 'writeOpCheckpointDoc', 'writePageLabelGuard',
  // embed --stale writes (engine-sql/embed-stale-work.ts): the content-drift sweep's cursor row and one drift batch.
  'invalidateContentDriftChunks', 'lockContentDriftState',
  // The soak counters' write (engine-sql/soak-counters.ts): one op_checkpoints row per day, which no write plan maps yet.
  'addSoakCounterEvent',
  // Batch 12 typed writes (repair-rust b9/b6b, lanes 6, 13 and the segmented and secret-store members): not mapped to a write plan yet, so they publish invalid like the rest of the list.
  'clearCodeEdgesLeavingChunks', 'deleteChunksByIds', 'deleteManagedSyncFailureObservation', 'deleteUnreferencedSecretEntry', 'dispatchBudgetReservation', 'insertBackupSecretEntry', 'insertBackupSecretOccurrence', 'insertOpCheckpointIfAbsent', 'insertRemirrorEffects', 'insertSecretEntry', 'insertSecretOccurrence', 'markSecretEntryAllowed', 'movePageVersions', 'moveTwinFacts', 'moveTwinPageChildren', 'moveTwinRelationships', 'reclaimBudgetReservations', 'recordRenameAlias', 'releaseBudgetReservation', 'replaceOpCheckpointAtVersion', 'reserveBudgetReservation', 'retireStaleSegmentChunks', 'setRawDataValue', 'setRedactedPageFields', 'setRedactedRowText', 'setRetainedVersionBody', 'settleBudgetReservation', 'upsertFenceTrendRunRecord',
  // The segmented write path's typed writes (engine-members/segmented-writes.ts): a re-chunk, a fence rewrite and a segmented embed.
  'installSegmentedVectors', 'publishRebuiltGeneration', 'restorePageDeletedAt', 'restorePageUpdatedAt',
  'setMaterializingRevision', 'setSegmentedVersionHash', 'splitManifestGeneration',
  // Lane 17 typed writes (pinned questions, the volunteer log, retrieval events and ratings): not mapped to a write plan yet.
  'applyRetrievalRatings', 'insertPinnedQuestion', 'insertRetrievalEvents', 'insertVolunteerEvents',
  // Lane 4 (sweep-facts-rust) typed edge-proposal writes: not mapped to a write plan yet.
  'deleteEdgeProposalError', 'deleteHeldEdgeProposalErrors', 'markEdgeProposalDated',
  // Lane 8 (rust-members-tail) typed writes (the extraction watermark and receipt, the volunteer retention delete): not mapped to a write plan yet.
  'clearPageExtractionState', 'commitPageExtraction', 'deleteVolunteerEventsOlderThan', 'writePageExtractionReceipt',
  // Lane 3 (purge-ledger-sites) typed writes (engine-sql/belief-purge-ledger.ts: the belief ledger's purge redaction and prior_hash re-chain): not mapped to a write plan yet.
  'rechainBeliefPriorHash', 'redactPurgedBeliefKeys', 'rewriteBeliefEventFields',
  // Lane 5 eval harness pause (engine-sql/eval-harness-reads.ts): the brain row's enabled flag, not mapped to a write plan yet.
  'pauseManagedPersistence', 'restoreManagedPersistence',
  // The remediation impact log row (engine-sql/remediation-records.ts): not mapped to a write plan yet.
  'insertImpactLogRow',
]);
export type MemberKind = 'read_name' | 'raw' | 'reserved' | 'ignored' | 'schema' | 'mapped' | 'unmapped';

/** How the follow wrapper treats a member name (mirrored reads and transactions are decided before this). */

export function memberKind(name: string): MemberKind {
  if (name.startsWith('_')) return 'ignored';
  if (name === 'withReservedConnection') return 'reserved';
  if (RAW_MEMBERS.has(name)) return 'raw';
  if (IGNORED_MEMBERS.has(name)) return 'ignored';
  if (SCHEMA_MEMBERS.has(name)) return 'schema';
  if (Object.prototype.hasOwnProperty.call(WRITE_MAP, name)) return 'mapped';
  if (READ_ONLY_MEMBERS.has(name) || (READ_PREFIX.test(name))) return 'read_name';
  return 'unmapped';
}
