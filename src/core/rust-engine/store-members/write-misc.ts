/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState through
 * purgeMemoryProposals, attachSourcePath and getWorktreeBinding; SQL in engine-sql/write-misc.ts; isSourceClaimed, SQL in engine-sql/sources.ts), and the folder access read beside the
 * access members (isFolderRestricted, listAppliedPolicyRevisions and readFolderAccess; SQL in engine-sql/access-control.ts; the member reads are
 * in access-members.ts). The source read and the path attach are served by gbrain-store `write_misc`; the rest answer for state the store does not keep. What each member answers and why:
 * rust/docs/store/write_misc.md.
 */
import type {
  AccessTokenRow, AdmissionSourceRow, AttachSourcePathOptions, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from '../../engine-sql/write-misc.ts';
import type { AppliedPolicyRevision, FolderAccessRows } from '../../engine-sql/access-control.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/**
 * The source's incarnation, archived flag, local path and config, or null. `lock: 'share'` asks the SQL engines to hold
 * the row FOR SHARE; the store runs one write transaction at a time, so the option changes nothing here.
 */
export const readSourceState: StoreMember<[sourceId: string, opts?: SourceStateOptions], SourceStateRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceState', sourceId }, () => brain.readSourceState(sourceId));

/** A config value as `config->>'key'` reads it: text as is, null for a missing key, JSON text otherwise. */
function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Page admission's source row. The store has no guest_sources table and no row-level security: a guest source is one
 * whose config says `guest: true` (as readGuestSourceRow), so no guest_sources row joins and nothing is hidden.
 */
export const readAdmissionSource: StoreMember<[sourceId: string], AdmissionSourceRow | null> = async (brain, sourceId) => {
  const row: SourceStateRow | null = await storeCall({ member: 'readAdmissionSource', sourceId }, () => brain.readSourceState(sourceId));
  if (!row) return null;
  return {
    incarnation: row.incarnation, archived: row.archived, local_path: row.local_path,
    kind: jsonText(row.config.kind), role: jsonText(row.config.role),
    guest_writers: null, guest_trust_ceiling: null, guest_sources_hidden: false,
  };
};

/** Attach a working tree to an existing path-less source: path, a passed name and federated flag; else unchanged. */
export const attachSourcePath: StoreMember<[sourceId: string, localPath: string, opts?: AttachSourcePathOptions], void> = async (brain, sourceId, localPath, opts) => {
  await storeCall({ member: 'attachSourcePath', sourceId }, () => brain.attachSourcePath(sourceId, localPath, opts?.name ?? null, opts?.federated ?? null));
};

/**
 * The store answers as a current schema with no shared skillpacks does: the table exists (the store is never on a
 * schema from before shared skills) and holds no pack, so listSharedSkillPackRoots returns nothing.
 */
export const sharedSkillPackTablePresent: StoreMember<[], boolean> = async () => true;

/** The store keeps no shared skillpacks (see sharedSkillPackTablePresent), so no pack has roots. */
export const listSharedSkillPackRoots: StoreMember<[hostId: string], SharedSkillPackRoot[]> = async () => [];

/**
 * The store keeps no writer bindings: a brain on this engine is never managed (readManagedModeRows), and the binding
 * writers (claimWorktree's raw SQL) refuse on it, so no source is bound on any host.
 */
export const getWorktreeBinding: StoreMember<[sourceId: string, hostId: string | null], WorktreeBinding | null> = async () => null;

/** No binding claims a source on this engine (see getWorktreeBinding), so classic sync never meets a claim. */
export const isSourceClaimed: StoreMember<[sourceId: string], boolean> = async () => false;

/** The store keeps no chronicle extraction state, so no page has events. */
export const hasExtractedEvents: StoreMember<[sourceId: string, pageId: number], boolean> = async () => false;

/**
 * `gbrain auth list` and the open-page count's member keys read every token row (`SELECT *`). The store keeps tokens
 * (insertAccessToken) but only some of those columns, so a brain that holds a token refuses rather than answer an
 * empty list (docs/designs/RUST_ENGINE.md row 32g); with no token the empty list is the answer.
 */
export const listAccessTokens: StoreMember<[], AccessTokenRow[]> = async (brain) => {
  if (await storeCall({ member: 'listAccessTokens' }, () => brain.accessTokensPresent())) refuseMember('listAccessTokens', 'the token rows');
  return [];
};

/**
 * The store keeps no notifier state (a resident notifier refuses to start on this engine, notifier/store.ts), so no
 * source has recorded coverage and search carries the freshness notice only when `sync.on_commit` is on.
 */
export const notifierCoverageRecorded: StoreMember<[], boolean> = async () => false;

/**
 * The store's brain id and commit sequence (`readProjectionReadinessGeneration`). Every commit advances it, a page write
 * among them, so a memoized health answer is reused only while nothing was written since it was read.
 */
export const readHealthMemoClock: StoreMember<[], string> = async (brain) =>
  storeCall({ member: 'readHealthMemoClock' }, () => brain.readProjectionReadinessGeneration());

/**
 * The store keeps no source contextual-retrieval mode (only `sources` admin raw SQL writes it, refused on this engine),
 * so no source selects the synopsis tier.
 */
export const listSynopsisSourceIds: StoreMember<[], string[]> = async () => [];

/**
 * The store keeps no access state: no folder rules, no pending coverage and no row-level security (every write of that
 * state is raw SQL, which this engine refuses). A slug is restricted under none of them, so the answer is false, as
 * PGLite answers for a brain with no folder rules and no pending covers (engine-sql/access-control.ts).
 */
export const isFolderRestricted: StoreMember<[sourceId: string, slug: string], boolean> = async () => false;

/** No source holds folder access state on this engine (see isFolderRestricted), so no revision is applied anywhere. */
export const listAppliedPolicyRevisions: StoreMember<[], AppliedPolicyRevision[]> = async () => [];

/**
 * No folder rule or folder coverage exists on this engine (see isFolderRestricted), so no rule is satisfied and no
 * prefix reads as nobody; a seed of access_rules or access_pending_coverage refuses as raw SQL.
 */
export const readFolderAccess: StoreMember<[readers: readonly string[]], FolderAccessRows> = async () => ({ rules: [], coverage: [] });

/** The store keeps no memory proposals, so upkeep expires nothing. */
export const expireMemoryProposals: StoreMember<[reason: string], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none awaits its owner. */
export const listAwaitingMemoryProposals: StoreMember<[limit: number], Array<Record<string, unknown>>> = async () => [];

/** No memory proposals exist on this engine (see expireMemoryProposals), so a principal holds none under any request id. */
export const readMemoryProposal: StoreMember<[principalKind: string, principalId: string, requestId: string], Record<string, unknown> | null> = async () => null;

/** No memory proposals exist on this engine (see expireMemoryProposals), so upkeep purges nothing. */
export const purgeMemoryProposals: StoreMember<[retentionDays: number], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none is pending: count 0, no oldest age. */
export const readPendingProposalSummary: StoreMember<[], PendingProposalRow | null> = async () => ({ n: 0, oldest: null });

/** No memory proposals exist on this engine (see expireMemoryProposals), so the owner's list is empty on every page. */
export const listMemoryProposalRows: StoreMember<[query: ProposalListQuery], Array<Record<string, unknown>>> = async () => [];

/** No memory proposals exist on this engine, so no request id names one: show, approve and deny answer not_found. */
export const listOwnerProposalRows: StoreMember<[requestId: string], Array<Record<string, unknown>>> = async () => [];
