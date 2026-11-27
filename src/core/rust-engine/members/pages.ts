/** The page, source, write-attribution and entity read members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const PAGES_MEMBERS = {
  readSegmentedPageHead: 'pages',
  readPageOrigin: 'pages',
  sealImportedPage: 'pages',
  readPageIndexingState: 'pages',
  readWriteVisibilityProbe: 'pages',
  listSlugAliases: 'pages',
  readPageTrustRows: 'pages',
  readOwnerOnlySourcesPresent: 'pages', // held: no Rust store member yet; served later as 'sources'
  readOwnerOnlySourceConfig: 'pages', // held: no Rust store member yet; served later as 'sources'
  lockSourceRow: 'pages', // held: no Rust store member yet; served later as 'sources'
  listGuestSourceIds: 'pages', // held: no Rust store member yet; served later as 'sources'
  readSourceState: 'pages', // held: no Rust store member yet; served later as 'sources'
  attachSourcePath: 'pages', // held: no Rust store member yet; served later as 'sources'
  // A resumable op's checkpoint (op-checkpoint.ts): the parent and path rows are persistence_journal's.
  readOpCheckpointKeys: 'persistence_journal',
  deleteOpCheckpoint: 'persistence_journal',
  worktreeClaimStore: 'persistence_journal',
  // Writer administration (the reviewed --expected-state digest, the operator lock, transfer prepare and cancel).
  readWriterAdminState: 'persistence_journal',
  writerAdminStore: 'persistence_journal',
  addPersistenceCounters: 'persistence_journal',
  // A bound publication's request-row reads and writes around its files (engine-sql/publication-journal.ts).
  publicationJournalStore: 'persistence_journal',
  readWorktreeManifest: 'persistence_journal',
  readReflexLiveKeys: 'pages',
  readReflexPages: 'pages',
  storeSegmentDerivationsIfLive: 'page_body',
  bumpPageRetrievals: 'pages',
  hasGuestSource: 'sources',
  readDatabaseClock: 'pages',
  readLivePageBody: 'pages',
  lockSourceForUpdate: 'sources',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
