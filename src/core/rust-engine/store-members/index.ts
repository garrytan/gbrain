/**
 * The BrainEngine members the Rust engine serves from its store, keyed by member name. `RustEngine` installs each on its
 * prototype (rust-engine.ts); a member in `RUST_ENGINE_MEMBERS` that is not here refuses with `engine_capability_missing`.
 */
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
import * as cliSources from './cli-sources.ts';
import * as cliReadsImport from './cli-reads-import.ts';
import * as cliReadsOps from './cli-reads-ops.ts';
import * as cliReadsSearchPages from './cli-reads-search-pages.ts';
import * as wantedLinks from './wanted-links.ts';
import * as persistence from './persistence.ts';
import * as cliEntities from './cli-entities.ts';
import * as factsDoctor from './facts-doctor.ts';
import * as factsCycle from './facts-cycle.ts';
import * as factsPurge from './facts-purge.ts';
import * as factsRepair from './facts-repair.ts';
import * as factsTrust from './facts-trust.ts';
import * as jobs from './jobs.ts';
import * as persistenceIdentity from './persistence-identity.ts';
import * as writeGuards from './write-guards.ts';

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
  ...chunkQueries, ...vectors, ...embeddings, ...transactions, ...relations, ...wantedLinks,
  // The minion queue and its cycle locks (rust/crates/gbrain-store/src/jobs.rs).
  ...jobs,
  // Typed reads that replace raw SQL in CLI paths (rust/crates/gbrain-store/src/cli_reads/).
  ...cliSources,
  // Typed reads that CLI paths ran through executeRaw (docs/research/rust-cli-executeraw-map.md).
  ...cliReadsImport, ...cliReadsOps, ...cliReadsSearchPages,
  ...cliEntities,
  // Group 5 facts statements (docs/research/rust-cli-contract-map.md).
  ...factsDoctor, ...factsCycle, ...factsPurge, ...factsRepair, ...factsTrust,
  // The persistence brain identity the store already keeps (rust/docs/store/journal.md).
  ...persistenceIdentity,
  ...persistence,
  // The page write guards a page write runs around the page row (rust/docs/store/write-guards.md).
  ...writeGuards,
} as const satisfies { [K in keyof BrainEngine]?: (brain: never, ...args: never[]) => Promise<unknown> };

export type ServedMember = keyof typeof STORE_MEMBERS;
