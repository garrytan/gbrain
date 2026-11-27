/**
 * The BrainEngine members the Rust engine serves from its store, keyed by member name. `RustEngine` installs each on its
 * prototype (rust-engine.ts); a member in `RUST_ENGINE_MEMBERS` that is not here refuses with `engine_capability_missing`.
 */
import * as opCheckpoint from './op-checkpoint.ts';
import type { BrainEngine } from '../../engine.ts';
import type { StoreMember } from './common.ts';
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
import * as cliReadsSearchPages from './cli-reads-search-pages.ts';
import * as fieldUsage from './field-usage.ts';
import * as decideProposals from './decide-proposals.ts';
import * as decideStore from './decide-store.ts';
import * as jobsHealth from './jobs-health.ts';
import * as openLoops from './open-loops.ts';
import * as cliSources from './cli-sources.ts';
import * as cliReadsImport from './cli-reads-import.ts';
import * as cliEntities from './cli-entities.ts';
import * as importMembers from './import-members.ts';
import * as jobs from './jobs.ts';
import * as persistenceIdentity from './persistence-identity.ts';
import * as persistence from './persistence.ts';
import * as writerAdmin from './writer-admin.ts';
// The members `gbrain put` and `gbrain get` reach on a brain with no managed persistence (docs/research/rust-put-get-member-trace.md).
import * as writeMisc from './write-misc.ts';
import * as connectGate from './connect-gate.ts';
import * as withdrawalFence from './withdrawal-fence.ts';
import * as accessMembers from './access-members.ts';
import * as trustTierReads from './trust-tier-reads.ts';
import * as publicationJournal from './publication-journal.ts';
import * as writeGuards from './write-guards.ts';
import * as writeContext from './write-context.ts';
import * as housekeeping from './housekeeping.ts';
import * as effectScans from './effect-scans.ts';
import * as trustFence from './trust-fence.ts';
import * as fenceHolds from './fence-holds.ts';
import * as ownerScans from './owner-scans.ts';
import * as syncHoldStore from './sync-hold-store.ts';
import * as effectWorker from './effect-worker.ts';
import * as wantedLinks from './wanted-links.ts';
import * as trustWriteGate from './trust-write-gate.ts';
import * as linkTemporal from './link-temporal.ts';

/** Schema is created when the store opens (rust/README.md, `brain.open`), so there is nothing left for initSchema to run. */
const initSchema: StoreMember<[], void> = async () => undefined;

export const STORE_MEMBERS = {
  initSchema,
  ...config, ...sources, ...tags, ...versions, ...chunks, ...search, ...links, ...graph, ...timeline,
  getPage: pages.getPage, readPageSnapshot: pages.readPageSnapshot, putPage: pages.putPage, deletePage: pages.deletePage,
  softDeletePage: pages.softDeletePage, restorePage: pages.restorePage, listPages: pages.listPages, resolveSlugs: pages.resolveSlugs,
  // Planned families: a member is served once its family file exports it.
  ...pageOps, ...extraction, ...aliases, ...pageBody, ...facts, ...ontology, ...takes, ...contradictions, ...dream,
  ...evalCapture, ...codeEdges, ...salience, ...stats, ...rawFiles, ...linkQueries, ...timelineQueries, ...keyword,
  ...chunkQueries, ...vectors, ...embeddings, ...transactions, ...relations,
  // The field usage sample read of schema detect --fields (rust/docs/store/field-usage.md).
  ...fieldUsage,
  // The decide proposal lanes and decide store (rust/docs/store/decide-proposals.md), and the open loops (rust/docs/store/facts.md).
  ...decideProposals, ...decideStore, ...openLoops, ...opCheckpoint,
  // Typed reads that CLI paths ran through executeRaw (docs/research/rust-cli-executeraw-map.md).
  ...cliReadsSearchPages,
  // Queue health reads (rust/crates/gbrain-store/src/jobs/health.rs).
  ...jobsHealth,
  // Import-path members: source and resolver reads, persistence identity and mode, cycle locks, the seal read.
  ...cliSources, ...cliReadsImport, ...cliEntities, ...importMembers, ...jobs, ...persistenceIdentity, ...persistence, ...writerAdmin,
  // The put and get path on a brain with no managed persistence.
  ...writeMisc, ...connectGate, ...withdrawalFence, ...accessMembers, ...trustTierReads, ...publicationJournal, ...writeGuards,
  ...writeContext, ...housekeeping, ...effectScans, ...trustFence, ...fenceHolds, ...ownerScans, ...syncHoldStore, ...effectWorker, ...wantedLinks, ...linkTemporal, ...trustWriteGate,
} as const satisfies { [K in keyof BrainEngine]?: (brain: never, ...args: never[]) => Promise<unknown> };

export type ServedMember = keyof typeof STORE_MEMBERS;
