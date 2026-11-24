/** The page, source, write-attribution and entity read members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const PAGES_MEMBERS = {
  readPageIndexingState: 'pages',
  readWriteVisibilityProbe: 'pages',
  listSlugAliases: 'pages',
  readPageTrustRows: 'pages',
  readOwnerOnlySourcesPresent: 'pages', // held: no Rust store member yet; served later as 'sources'
  readOwnerOnlySourceConfig: 'pages', // held: no Rust store member yet; served later as 'sources'
  readSourceRow: 'pages', // held: no Rust store member yet; served later as 'sources'
  lockSourceRow: 'pages', // held: no Rust store member yet; served later as 'sources'
  listGuestSourceIds: 'pages', // held: no Rust store member yet; served later as 'sources'
  deleteOpCheckpoint: 'persistence_journal',
  worktreeClaimStore: 'persistence_journal',
  // Writer administration (the reviewed --expected-state digest, the operator lock, transfer prepare and cancel).
  readWriterAdminState: 'persistence_journal',
  writerAdminStore: 'persistence_journal',
  readReflexLiveKeys: 'pages',
  readReflexPages: 'pages',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
