/**
 * The BrainEngine members the Rust engine serves from its store, keyed by member name. `RustEngine` installs each on its
 * prototype (rust-engine.ts); a member in `RUST_ENGINE_MEMBERS` that is not here refuses with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import * as mentionPass from './mention-pass.ts';
import * as chunks from './chunks.ts';
import * as config from './config.ts';
import * as graph from './graph.ts';
import * as links from './links.ts';
import * as pages from './pages.ts';
import * as search from './search.ts';
import * as sources from './sources.ts';
import * as tags from './tags.ts';
import * as timeline from './timeline.ts';
import * as versions from './versions.ts';
// One module per planned family (docs/designs/RUST_ENGINE_INTERFACES.md), each listed once so building one edits
// only its own file.
import * as pageOps from './page-ops.ts';
import * as fenceRepairRecords from './fence-repair-records.ts';
import * as budgetLedger from './budget-ledger.ts';
import * as secretStore from './secret-store.ts';
import * as twinMerge from './twin-merge.ts';
import * as extraction from './extraction.ts';
import * as aliases from './aliases.ts';
import * as pageBody from './page-body.ts';
import * as pageViewDigests from './page-view-digests.ts';
import * as segmentedWrites from './segmented-writes.ts';
import * as pageSpend from './page-spend.ts';
import * as facts from './facts.ts';
import * as ontology from './ontology.ts';
import * as takes from './takes.ts';
import * as contradictions from './contradictions.ts';
import * as dream from './dream.ts';
import * as dreamJournal from './dream-journal.ts';
import * as sessionState from './session-state.ts';
import * as evalCapture from './eval-capture.ts';
import * as codeEdges from './code-edges.ts';
import * as salience from './salience.ts';
import * as stats from './stats.ts';
import * as rawFiles from './raw-files.ts';
import * as filesOps from './files-ops.ts';
import * as linkQueries from './link-queries.ts';
import * as timelineQueries from './timeline-queries.ts';
import * as timelineRepairReads from './timeline-repair-reads.ts';
import * as labelRepairReads from './label-repair-reads.ts';
import * as factTextRepair from './fact-text-repair.ts';
import * as lostFenceReads from './lost-fence-reads.ts';
import * as fenceProjection from './fence-projection.ts';
import * as keyword from './keyword.ts';
import * as chunkQueries from './chunk-queries.ts';
import * as vectors from './vectors.ts';
import * as embeddings from './embeddings.ts';
import * as embedStaleWork from './embed-stale-work.ts';
import * as transactions from './transactions.ts';
import * as relations from './relations.ts';
import * as trustWithdrawals from './trust-withdrawals.ts';
import * as openLoops from './open-loops.ts';
import * as coreEditNotices from './core-edit-notices.ts';
import * as loopMutes from './loop-mutes.ts';
import * as sourceArchive from './source-archive.ts';
import * as trustWriteGate from './trust-write-gate.ts';
import * as cliSources from './cli-sources.ts';
import * as filesSources from './files-sources.ts';
import * as dreamConfig from './dream-config.ts';
import * as dreamCycle from './dream-cycle.ts';
import * as tailReads from './tail-reads.ts';
import * as factsHeld from './facts-held.ts';
import * as factsRest from './facts-rest.ts';
import * as factsHoldingPurges from './facts-holding-purges.ts';
import * as cliReadsImport from './cli-reads-import.ts';
import * as listReads from './list-reads.ts';
import * as cliReadsOps from './cli-reads-ops.ts';
import * as cliReadsSearchPages from './cli-reads-search-pages.ts';
import * as wantedLinks from './wanted-links.ts';
import * as persistence from './persistence.ts';
import * as syncHoldStore from './sync-hold-store.ts';
import * as syncStatusReads from './sync-status-reads.ts';
import * as cliEntities from './cli-entities.ts';
import * as adminReads from './admin-reads.ts';
import * as reflexReads from './reflex-reads.ts';
import * as briefReads from './brief-reads.ts';
import * as factsDoctor from './facts-doctor.ts';
import * as embeddingCatalog from './embedding-catalog.ts';
import * as fenceHolds from './fence-holds.ts';
import * as derivedGenerations from './derived-generations.ts';
import * as factsCycle from './facts-cycle.ts';
import * as factsCycleFence from './facts-cycle-fence.ts';
import * as factsPhantom from './facts-phantom.ts';
import * as factsPurge from './facts-purge.ts';
import * as factsPurgeJournal from './facts-purge-journal.ts';
import * as factsConversation from './facts-conversation.ts';
import * as factsPurgeProbe from './facts-purge-probe.ts';
import * as factsPurgeReceipt from './facts-purge-receipt.ts';
import * as factsPurgeTx from './facts-purge-tx.ts';
import * as purgePlan from './purge-plan.ts';
import * as purgeEffects from './purge-effects.ts';
import * as beliefPurge from './belief-purge.ts';
import * as projectionRebuild from './projection-rebuild.ts';
import * as factsRepair from './facts-repair.ts';
import * as repairApplies from './repair-applies.ts';
import * as visibilityScans from './visibility-scans.ts';
import * as ontologyRepair from './ontology-repair.ts';
import * as factsTrust from './facts-trust.ts';
import * as factsForget from './facts-forget.ts';
import * as factsRecall from './facts-recall.ts';
import * as factsQuoted from './facts-quoted.ts';
import * as schemaDetect from './schema-detect.ts';
import * as accessReadLog from './access-read-log.ts';
import * as handoverReads from './handover-reads.ts';
import * as edgeProposals from './edge-proposals.ts';
import * as factsWritePath from './facts-write-path.ts';
import * as factsRemember from './facts-remember.ts';
import * as derivationTrust from './derivation-trust.ts';
import * as chronicleEvents from './chronicle-events.ts';
import * as chronicleReads from './chronicle-reads.ts';
import * as factsTrustReads from './facts-trust-reads.ts';
import * as factsProvenance from './facts-provenance.ts';
import * as factsTrustOwner from './facts-trust-owner.ts';
import * as trustTierReads from './trust-tier-reads.ts';
import * as headBlocker from './head-blocker.ts';
import * as checkpointValidation from './checkpoint-validation.ts';
import * as labelDoor from './label-door.ts';
import * as pagePurge from './page-purge.ts';
import * as pagePurgeHolds from './page-purge-holds.ts';
import * as pagePurgeJournal from './page-purge-journal.ts';
import * as pagePurgeScrubs from './page-purge-scrubs.ts';
import * as purgeReceipt from './purge-receipt.ts';
import * as pagePurgeSweep from './page-purge-sweep.ts';
import * as memoryMutationReads from './memory-mutation-reads.ts';
import * as withdrawalCommit from './withdrawal-commit.ts';
import * as withdrawalDiscovery from './withdrawal-discovery.ts';
import * as withdrawalPages from './withdrawal-pages.ts';
import * as withdrawalFence from './withdrawal-fence.ts';
import * as jobs from './jobs.ts';
import * as housekeeping from './housekeeping.ts';
import * as notifier from './notifier.ts';
import * as effectScans from './effect-scans.ts';
import * as ownerScans from './owner-scans.ts';
import * as effectWorker from './effect-worker.ts';
import * as noopSettle from './noop-settle.ts';
import * as pageEmbeddingBudget from './page-embedding-budget.ts';
import * as pageExtractionState from './page-extraction-state.ts';
import * as embeddingInstall from './embedding-install.ts';
import * as persistenceIdentity from './persistence-identity.ts';
import * as writeMisc from './write-misc.ts';
import * as chronicleLedger from './chronicle-ledger.ts';
import * as pageMutationReads from './page-mutation-reads.ts';
import * as worktreeClaim from './worktree-claim.ts';
import * as writerAdmin from './writer-admin.ts';
import * as writerRelease from './writer-release.ts';
import * as publicationJournal from './publication-journal.ts';
import * as gitDurability from './git-durability.ts';
import * as gitEffects from './git-effects.ts';
import * as topologyStore from './topology-store.ts';
import * as manualLinks from './manual-links.ts';
import * as writerStatus from './writer-status.ts';
import * as collateStoreReads from './collate-store-reads.ts';
import * as writeAttribution from './write-attribution.ts';
import * as opCheckpoint from './op-checkpoint.ts';
import * as syncRunReads from './sync-run-reads.ts';
import * as accessPolicy from './access-policy.ts';
import * as accessSetup from './access-setup.ts';
import * as trustScan from './trust-scan.ts';
import * as linkTemporal from './link-temporal.ts';
import * as aliasFanoutReads from './alias-fanout-reads.ts';
import * as entityIdentities from './entity-identities.ts';
import * as writeGuards from './write-guards.ts';
import * as ownerOnlyMarks from './owner-only-marks.ts';
import * as pageVisibility from './page-visibility.ts';
import * as conceptRebuild from './concept-rebuild.ts';
import * as largePage from './large-page.ts';
import * as trustFence from './trust-fence.ts';
import * as trustProposals from './trust-proposals.ts';
import * as factRelinkAttempts from './fact-relink-attempts.ts';
import * as factRelinkWrites from './fact-relink-writes.ts';
import * as connectGate from './connect-gate.ts';
import * as telemetry from './telemetry.ts';
import * as importMembers from './import-members.ts';
import * as calibrationProfiles from './calibration-profiles.ts';
// Group C: decide proposals and review proposals (rust/docs/store/decide-proposals.md).
import * as decideProposals from './decide-proposals.ts';
import * as fieldUsage from './field-usage.ts';
import * as decideStore from './decide-store.ts';
import * as engineMigration from './engine-migration.ts';
import * as writeContext from './write-context.ts';
// The store creates its tables when it opens; initSchema seeds the embedding config rows PGLite's schema text seeds.
import { initSchema } from './init-schema.ts';
import * as accessGrants from './access-grants.ts';
import * as accessMembers from './access-members.ts';
import * as sharedSkillMembers from './shared-skill-members.ts';
import * as doctorDerived from './doctor-derived.ts';
import * as doctorPersistence from './doctor-persistence.ts';
import * as sourceMovement from './source-movement.ts';
import * as doctorPages from './doctor-pages.ts';
import * as doctorTallies from './doctor-tallies.ts';
import * as doctorSearch from './doctor-search.ts';
import * as doctorAcc from './doctor-acc.ts';
import * as doctorJoin from './doctor-join.ts';
import * as doctorCheckpoints from './doctor-checkpoints.ts';
import * as doctorTerminal from './doctor-terminal.ts';
import * as doctorBrain from './doctor-brain.ts';
import * as slugSpellingRepair from './slug-spelling-repair.ts';
import * as doctorSync from './doctor-sync.ts';
import * as doctorFactsTrust from './doctor-facts-trust.ts';
import * as fenceCensus from './fence-census.ts';
import * as doctorSources from './doctor-sources.ts';
import * as sweepReads from './sweep-reads.ts';
import * as graduationCatalog from './graduation-catalog.ts';
import * as cliReadsExport from './cli-reads-export.ts';
import * as beliefLedger from './belief-ledger.ts';
import * as cycleReads from './cycle-reads.ts';
import * as repairBookkeeping from './repair-bookkeeping.ts';
import * as managedSyncOrphans from './managed-sync-orphans.ts';
import * as repairPageReads from './repair-page-reads.ts';
import * as aliasOrphans from './alias-orphans.ts';
import * as repairPageScans from './repair-page-scans.ts';
import * as repairFenceScans from './repair-fence-scans.ts';
import * as repairPlanScans from './repair-plan-scans.ts';
import * as gitHolds from './git-holds.ts';
import * as synopsisTier from './synopsis-tier.ts';
import * as sourceCrMode from './source-cr-mode.ts';
import * as remoteLinks from './remote-links.ts';
import * as factsBackstop from './facts-backstop.ts';
import * as pinnedQuestions from './pinned-questions.ts';
import * as volunteerEvents from './volunteer-events.ts';
import * as retrievalFeedback from './retrieval-feedback.ts';
import * as gitGapCensus from './git-gap-census.ts';

const { readBrainMode: _brainModeHelper, ...writerReleaseMembers } = writerRelease;

export const STORE_MEMBERS = {
  // The mention pass and the gazetteer, extract snapshot and explain reads (rust/docs/store/mention-state.md).
  ...mentionPass,
  initSchema,
  ...config, ...sources, ...tags, ...versions, ...chunks, ...search, ...links, ...graph, ...timeline,
  getPage: pages.getPage, readPageSnapshot: pages.readPageSnapshot, putPage: pages.putPage, deletePage: pages.deletePage,
  softDeletePage: pages.softDeletePage, restorePage: pages.restorePage, listPages: pages.listPages, resolveSlugs: pages.resolveSlugs,
  // Planned families: a member is served once its family file exports it.
  ...pageOps, ...fenceRepairRecords, ...budgetLedger, ...secretStore, ...twinMerge, ...extraction, ...aliases, ...pageBody, ...segmentedWrites, ...pageSpend, ...pageViewDigests, ...facts, ...ontology, ...takes, ...contradictions, ...dream, ...dreamJournal,
  ...evalCapture, ...codeEdges, ...salience, ...stats, ...rawFiles, ...linkQueries, ...timelineQueries, ...timelineRepairReads, ...keyword,
  ...chunkQueries, ...vectors, ...embeddings, ...embedStaleWork, ...transactions, ...writeContext, ...relations, ...wantedLinks, ...trustWithdrawals, ...trustWriteGate, ...openLoops, ...coreEditNotices, ...loopMutes,
  ...sourceArchive,
  ...filesOps,
  // The minion queue and its cycle locks (rust/crates/gbrain-store/src/jobs.rs).
  ...jobs,
  // Typed reads that replace raw SQL in CLI paths (rust/crates/gbrain-store/src/cli_reads/).
  ...cliSources, ...filesSources, ...dreamConfig, ...dreamCycle, ...tailReads, ...factsHeld, ...factsRest, ...factsHoldingPurges,
  // Typed reads that CLI paths ran through executeRaw (docs/research/rust-cli-executeraw-map.md).
  ...cliReadsImport, ...cliReadsOps, ...cliReadsSearchPages, ...sweepReads,
  // The reads gbrain export makes (rust/docs/store/cli-reads-export.md).
  ...cliReadsExport,
  ...cliEntities, ...adminReads, ...reflexReads, ...briefReads,
  // Group 5 facts statements (docs/research/rust-cli-contract-map.md).
  ...factsDoctor, ...embeddingCatalog, ...fenceHolds, ...derivedGenerations, ...factsCycle, ...factsPurge, ...purgePlan, ...purgeEffects, ...beliefPurge, ...projectionRebuild, ...factsRepair, ...labelRepairReads, ...factTextRepair, ...lostFenceReads, ...factsTrust, ...derivationTrust, ...factsTrustReads, ...factsTrustOwner, ...factRelinkAttempts,
  ...ontologyRepair, ...factsRecall, ...factsForget, ...factsRemember, ...factsWritePath, ...factsProvenance, ...factsQuoted,
  ...factRelinkWrites,
  ...factsCycleFence, ...factsPhantom, ...factsPurgeReceipt, ...factsPurgeTx, ...factsPurgeJournal, ...factsPurgeProbe, ...factsConversation,
  // The `gbrain schema detect` page-shape reads (rust/docs/store/schema_detect.md).
  ...schemaDetect,
  // The access read log (rust/docs/store/telemetry.md, "Access read log").
  ...accessReadLog,
  // The member handover preview and --status reads (rust/docs/store/handover-reads.md).
  ...handoverReads,
  // The edge-contradictions dream phase and its proposal ledger (rust/docs/store/edge_proposals.md).
  ...edgeProposals,
  // The Life Chronicle event statements (rust/crates/gbrain-store/src/generations/chronicle_events.rs).
  ...chronicleEvents, ...chronicleReads,
  // Typed reads of stamped trust tiers (rust/docs/store/trust.md, "Tier reads").
  ...trustTierReads,
  // Belief ledger writes and the append's reads (rust/docs/store/trust.md, "The belief ledger").
  ...beliefLedger, ...cycleReads,
  // The reads remember and forget make before admission (rust/docs/store/memory_mutation_reads.md).
  ...headBlocker,
  ...checkpointValidation,
  ...labelDoor,
  // The reads and tombstone edits of a page purge (rust/docs/store/facts.md).
  ...pagePurge,
  // The deletes and reads of a page purge's sweep, its segment storage and its slug stores (rust/docs/store/facts.md).
  ...pagePurgeSweep,
  // The journal statements of a page purge's sweep and intent redaction (rust/docs/store/persistence.md).
  ...pagePurgeJournal,
  ...pagePurgeScrubs,
  // The reads a page purge's receipt and verification make on the brain's own tables (rust/docs/store/pages.md).
  ...purgeReceipt,
  // The parks and owed-purge records of a derived-origin purge (rust/docs/store/label_door.md).
  ...pagePurgeHolds,
  ...memoryMutationReads,
  // The statements a forget's withdrawal commits and the fact_withdrawn refusal reads (rust/docs/store/trust.md).
  ...withdrawalCommit,
  // The reads withdrawal discovery makes to find the pages a withdrawn claim reaches (rust/docs/store/facts.md).
  ...withdrawalDiscovery,
  // The page statements a fact withdrawal runs on the pages that carry the claim (rust/docs/store/facts.md).
  ...withdrawalPages,
  // The withdrawal check a prepared import runs on a malformed facts fence (rust/docs/store/facts.md).
  ...withdrawalFence,
  // The persistence brain identity the store already keeps (rust/docs/store/journal.md).
  ...persistenceIdentity,
  // Search telemetry (rust/docs/store/telemetry.md).
  ...telemetry,
  // Link temporal state, reindex-search-vector's steps and the embedding-held coverage count (rust/docs/store/link_temporal.md).
  ...linkTemporal,
  // Alias fan-out reads (rust/docs/store/alias_fanout_reads.md).
  ...aliasFanoutReads,
  ...entityIdentities,
  ...persistence, ...housekeeping, ...effectScans, ...ownerScans, ...effectWorker, ...noopSettle,
  // The git sync hold store and managed sync pass rows, kept as op checkpoint rows (rust/docs/store/persistence.md, "Checkpoint rows").
  ...syncHoldStore,
  ...syncStatusReads,
  // The commit notifier's host lease and host source list (rust/docs/store/persistence.md, "Commit notifier").
  ...notifier,
  // The page embedding ledger on the paid path (rust/docs/store/embeddings.md).
  ...pageEmbeddingBudget, ...pageExtractionState,
  ...embeddingInstall,
  ...writeMisc,
  // The write-time chronicle ledger decision (rust/docs/store/chronicle-ledger.md).
  ...chronicleLedger,
  // The reads a page write makes before admission (rust/docs/store/page-mutation-reads.md).
  ...pageMutationReads,
  // The unmanaged writer claim over the store's worktree bindings (rust/docs/store/persistence.md, "Worktree bindings").
  ...worktreeClaim,
  // Writer administration: the reviewed state digest, the operator lock, transfer prepare and cancel (same section).
  ...writerAdmin,
  // Writer activation, deactivation and the pre-activation release over the stored brain mode (same doc, "Writer release").
  // `readBrainMode` is the module's shared brain-mode read for other members, not a BrainEngine member, so it is not served.
  ...writerReleaseMembers,
  // A bound publication's request-row reads and writes around its files (same doc, "Publication journal").
  ...publicationJournal,
  ...gitDurability,
  ...gitEffects,
  ...topologyStore,
  ...manualLinks,
  ...writerStatus,
  // Reads callers once ran through executeRaw: feedback, pins, credentials (rust/docs/store).
  ...collateStoreReads,
  // get_write_attribution's receipt and name reads (rust/docs/store/write_attribution.md).
  ...writeAttribution,
  ...opCheckpoint,
  ...syncRunReads,
  // Repair bookkeeping: source incarnations, writer bindings, loop facts, connector checkpoints (rust/docs/store/repair-bookkeeping.md).
  ...repairBookkeeping,
  // Managed-sync orphans and owned content (rust/docs/store/repair-bookkeeping.md).
  ...managedSyncOrphans,
  ...repairPageReads,
  ...aliasOrphans,
  ...repairPageScans, ...repairFenceScans,
  ...repairPlanScans,
  ...gitHolds,
  // The folder-rule policy members access/policy.ts runs (rust/docs/store/access_rules.md).
  ...accessPolicy,
  // The access setup and policy-store members outside access/policy.ts (rust/docs/store/access_rules.md).
  ...accessSetup,
  ...trustScan,
  // The page write guards a page write runs around the page row (rust/docs/store/write-guards.md).
  ...writeGuards, ...trustFence, ...trustProposals,
  // The page visibility guards a remote page write runs (rust/docs/store/page-visibility.md).
  ...pageVisibility,
  // The held-concept rebuild's reads and link carry (rust/docs/store/concept_rebuild.md).
  ...conceptRebuild,
  // The owner-only mark state; the store marks in code and has no SQL triggers (rust/docs/store/keyword.md).
  ...ownerOnlyMarks,
  // The large-page write guard's stored body size read (rust/docs/store/large-page.md).
  ...largePage,
  // The connect gate's persistence reads, answered from the unmanaged brain the store keeps (rust/docs/store/journal.md).
  ...connectGate,
  // The page and chunk statements a page import runs around its chunk write (rust/docs/store/import-members.md).
  ...importMembers,
  // Decide family, group B: calibration profiles (rust/docs/store/calibration-profiles.md).
  ...calibrationProfiles,
  // Group C: the decide proposal tables (rust/docs/store/decide-proposals.md).
  ...decideProposals,
  // The field usage sample read of schema detect --fields (rust/docs/store/field-usage.md).
  ...fieldUsage,
  // The access-grant reads and the request-id lookup of the receipt operations (rust/docs/store/persistence.md).
  ...accessGrants,
  // The session cursor and checkpoint manifest of context_pack and delta (rust/docs/store/session_state.md).
  ...sessionState,
  // The access member and group writes and the active-member read (rust/docs/store/access-members.md).
  ...accessMembers,
  // The shared-skill members and delivery batches join_brain, sync_brain_skills and leave_brain use (rust/docs/store/shared-skill-members.md).
  ...sharedSkillMembers,
  // The statements doctor checks ran through executeRaw (rust/docs/store/cli-reads-doctor.md).
  // The second doctor set: served, answered empty where the store keeps no writer, or left out to refuse (rust/docs/store/cli-reads-doctor-derived.md).
  ...doctorDerived,
  // The persistence checks' request journal and counter reads (rust/docs/store/cli-reads-doctor-per.md).
  ...doctorPersistence,
  ...sourceMovement,
  ...doctorPages,
  ...doctorTallies,
  // Search and knowledge doctor reads (rust/docs/store/cli-reads-doctor-search.md).
  ...doctorSearch,
  ...doctorAcc,
  // Doctor reads of the checks from the main join (rust/docs/store/cli-reads-doctor-join.md).
  ...doctorJoin,
  // The op_checkpoints and ingest_log statements doctor ran through executeRaw (rust/docs/store/cli-reads-doctor-checkpoints.md).
  ...doctorCheckpoints,
  // Doctor terminal reads: the grouped terminal write failure aggregate, its drill-down batch and the open-pass blocker statements doctor ran through executeRaw (rust/docs/store/cli-reads-doctor-terminal.md).
  ...doctorTerminal,
  // Doctor brain reads: the page, tag, fact, source and checkpoint statements the storage, archive, backup, git-hold and connector checks ran through executeRaw (rust/docs/store/cli-reads-doctor-brain.md).
  ...doctorBrain,
  // The legacy_slug_spellings doctor check's reads: row security (none in the store) and the candidate page scan (rust/docs/store/slug-spelling-repair.md).
  ...slugSpellingRepair,
  // Doctor sync reads: the managed-sync cursor, failure and orphan statements doctor ran through executeRaw (rust/docs/store/cli-reads-doctor-sync.md).
  ...doctorSync,
  // The doctor reads over sources (rust/docs/store/cli-reads-doctor-src.md).
  ...doctorSources,
  // The doctor facts, fence and trust reads (rust/docs/store/cli-reads-doctor-facts-trust.md).
  ...doctorFactsTrust,
  ...fenceCensus,
  // Group A: the decide store (rust/docs/store/decide-store.md).
  ...decideStore,
  // The engine graduation inventory's catalog reads, answered from the store's keyspace list (rust/docs/store/keyspaces.md).
  ...graduationCatalog,
  // The source-side reads of `gbrain migrate --to <engine>` (rust/docs/store/engine-migration.md).
  ...engineMigration,
  // The synopsis tier's configuration read (rust/docs/store/synopsis-tier.md).
  ...synopsisTier,
  // A source's own contextual-retrieval mode (rust/docs/store/source-cr-mode.md).
  ...sourceCrMode,
  // The remote links effect's edge reads and writes and its batch re-arm (rust/docs/store/remote-links.md).
  ...remoteLinks,
  // The facts backstop effect's two extraction reads (rust/docs/store/jobs.md, "Facts extraction reads").
  ...factsBackstop,
  // The rechecks and writes of the repair applies (rust/docs/store/repair-applies.md).
  ...repairApplies,
  // The preview reads of gbrain repair visibility (rust/docs/store/repair-applies.md).
  ...visibilityScans,
  // The pinned-question insert, read and listing (rust/docs/store/pinned-questions.md).
  ...pinnedQuestions,
  // The volunteered-page log insert and usage read (rust/docs/store/volunteer-events.md).
  ...volunteerEvents,
  // The retrieval event log, its read and a rating batch (rust/docs/store/retrieval-feedback.md).
  ...retrievalFeedback,
  // The Git-gap census reads (rust/docs/store/git-gap-census.md).
  ...gitGapCensus,
  // The page-list, slug-source, access and connector-status reads (rust/docs/store/list-reads.md).
  ...listReads,
  // The dream cycle's persistence journal reads (rust/docs/store/dream.md, "Dream cycle statements").
  // A page publication's fence projection and fence guard statements, tier-only row changes and the unwithdrawn-facts restore (rust/docs/store/facts.md, "The fence projection's statements").
  ...fenceProjection,
} as const satisfies { [K in keyof BrainEngine]?: (brain: never, ...args: never[]) => Promise<unknown> };

export type ServedMember = keyof typeof STORE_MEMBERS;
