/**
 * The BrainEngine members the Rust engine serves from its store, keyed by member name. `RustEngine` installs each on its
 * prototype (rust-engine.ts); a member in `RUST_ENGINE_MEMBERS` that is not here refuses with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
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
import * as extraction from './extraction.ts';
import * as aliases from './aliases.ts';
import * as pageBody from './page-body.ts';
import * as facts from './facts.ts';
import * as ontology from './ontology.ts';
import * as takes from './takes.ts';
import * as contradictions from './contradictions.ts';
import * as dream from './dream.ts';
import * as evalCapture from './eval-capture.ts';
import * as codeEdges from './code-edges.ts';
import * as salience from './salience.ts';
import * as stats from './stats.ts';
import * as rawFiles from './raw-files.ts';
import * as linkQueries from './link-queries.ts';
import * as timelineQueries from './timeline-queries.ts';
import * as keyword from './keyword.ts';
import * as chunkQueries from './chunk-queries.ts';
import * as vectors from './vectors.ts';
import * as embeddings from './embeddings.ts';
import * as transactions from './transactions.ts';
import * as relations from './relations.ts';
import * as trustWithdrawals from './trust-withdrawals.ts';
import * as openLoops from './open-loops.ts';
import * as trustWriteGate from './trust-write-gate.ts';
import * as cliSources from './cli-sources.ts';
import * as filesSources from './files-sources.ts';
import * as dreamConfig from './dream-config.ts';
import * as factsHoldingPurges from './facts-holding-purges.ts';
import * as cliReadsImport from './cli-reads-import.ts';
import * as cliReadsOps from './cli-reads-ops.ts';
import * as cliReadsSearchPages from './cli-reads-search-pages.ts';
import * as wantedLinks from './wanted-links.ts';
import * as persistence from './persistence.ts';
import * as cliEntities from './cli-entities.ts';
import * as factsDoctor from './facts-doctor.ts';
import * as embeddingCatalog from './embedding-catalog.ts';
import * as fenceHolds from './fence-holds.ts';
import * as factsCycle from './facts-cycle.ts';
import * as factsPurge from './facts-purge.ts';
import * as factsRepair from './facts-repair.ts';
import * as factsTrust from './facts-trust.ts';
import * as factsTrustReads from './facts-trust-reads.ts';
import * as factsTrustOwner from './facts-trust-owner.ts';
import * as trustTierReads from './trust-tier-reads.ts';
import * as memoryMutationReads from './memory-mutation-reads.ts';
import * as withdrawalCommit from './withdrawal-commit.ts';
import * as withdrawalDiscovery from './withdrawal-discovery.ts';
import * as withdrawalPages from './withdrawal-pages.ts';
import * as withdrawalFence from './withdrawal-fence.ts';
import * as jobs from './jobs.ts';
import * as housekeeping from './housekeeping.ts';
import * as effectScans from './effect-scans.ts';
import * as ownerScans from './owner-scans.ts';
import * as effectWorker from './effect-worker.ts';
import * as noopSettle from './noop-settle.ts';
import * as pageEmbeddingBudget from './page-embedding-budget.ts';
import * as embeddingInstall from './embedding-install.ts';
import * as persistenceIdentity from './persistence-identity.ts';
import * as writeMisc from './write-misc.ts';
import * as writeAttribution from './write-attribution.ts';
import * as opCheckpoint from './op-checkpoint.ts';
import * as linkTemporal from './link-temporal.ts';
import * as aliasFanoutReads from './alias-fanout-reads.ts';
import * as entityIdentities from './entity-identities.ts';
import * as writeGuards from './write-guards.ts';
import * as pageVisibility from './page-visibility.ts';
import * as accessReports from './access-reports.ts';
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
import * as writeContext from './write-context.ts';
// The store creates its tables when it opens; initSchema seeds the embedding config rows PGLite's schema text seeds.
import { initSchema } from './init-schema.ts';
import * as cliReadsExport from './cli-reads-export.ts';

export const STORE_MEMBERS = {
  initSchema,
  ...config, ...sources, ...tags, ...versions, ...chunks, ...search, ...links, ...graph, ...timeline,
  getPage: pages.getPage, readPageSnapshot: pages.readPageSnapshot, putPage: pages.putPage, deletePage: pages.deletePage,
  softDeletePage: pages.softDeletePage, restorePage: pages.restorePage, listPages: pages.listPages, resolveSlugs: pages.resolveSlugs,
  // Planned families: a member is served once its family file exports it.
  ...pageOps, ...extraction, ...aliases, ...pageBody, ...facts, ...ontology, ...takes, ...contradictions, ...dream,
  ...evalCapture, ...codeEdges, ...salience, ...stats, ...rawFiles, ...linkQueries, ...timelineQueries, ...keyword,
  ...chunkQueries, ...vectors, ...embeddings, ...transactions, ...writeContext, ...relations, ...wantedLinks, ...trustWithdrawals, ...trustWriteGate, ...openLoops,
  // The minion queue and its cycle locks (rust/crates/gbrain-store/src/jobs.rs).
  ...jobs,
  // Typed reads that replace raw SQL in CLI paths (rust/crates/gbrain-store/src/cli_reads/).
  ...cliSources, ...filesSources, ...dreamConfig, ...factsHoldingPurges,
  // Typed reads that CLI paths ran through executeRaw (docs/research/rust-cli-executeraw-map.md).
  ...cliReadsImport, ...cliReadsOps, ...cliReadsSearchPages,
  // The reads gbrain export makes (rust/docs/store/cli-reads-export.md).
  ...cliReadsExport,
  ...cliEntities,
  // Group 5 facts statements (docs/research/rust-cli-contract-map.md).
  ...factsDoctor, ...embeddingCatalog, ...fenceHolds, ...factsCycle, ...factsPurge, ...factsRepair, ...factsTrust, ...factsTrustReads, ...factsTrustOwner, ...factRelinkAttempts,
  ...factRelinkWrites,
  // Typed reads of stamped trust tiers (rust/docs/store/trust.md, "Tier reads").
  ...trustTierReads,
  // The reads remember and forget make before admission (rust/docs/store/memory_mutation_reads.md).
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
  // The page embedding ledger on the paid path (rust/docs/store/embeddings.md).
  ...pageEmbeddingBudget,
  ...embeddingInstall,
  ...writeMisc,
  // get_write_attribution's receipt and name reads (rust/docs/store/write_attribution.md).
  ...writeAttribution,
  ...opCheckpoint,
  // The page write guards a page write runs around the page row (rust/docs/store/write-guards.md).
  ...writeGuards, ...trustFence, ...trustProposals,
  // The page visibility guards a remote page write runs (rust/docs/store/page-visibility.md).
  ...pageVisibility,
  // The access report reads of gbrain access serves and who-can-read (rust/docs/store/write_misc.md).
  ...accessReports,
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
  // Group A: the decide store (rust/docs/store/decide-store.md).
  ...decideStore,
} as const satisfies { [K in keyof BrainEngine]?: (brain: never, ...args: never[]) => Promise<unknown> };

export type ServedMember = keyof typeof STORE_MEMBERS;
