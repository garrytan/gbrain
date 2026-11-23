/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState through
 * purgeMemoryProposals, attachSourcePath, getWorktreeBinding and listAccessTokens; SQL in engine-sql/write-misc.ts; isSourceClaimed, SQL in engine-sql/sources.ts), and the folder access read beside the
 * access members (isFolderRestricted, listAppliedPolicyRevisions, readFolderAccess, readMayActFor, readAudiencePrincipals, readJobPrincipal, readAccessMembers, readAccessCredentials, listAudienceAccessMembers and readLiveMember; SQL in engine-sql/access-control.ts). The source read and the path attach are served by
 * gbrain-store `write_misc`, the binding reads by gbrain-store `persistence::worktrees`, the folder reads by gbrain-store `access_rules`; the rest answer for state the store does not keep. What each member answers and why:
 * rust/docs/store/write_misc.md.
 */
import type {
  AccessTokenRow, AdmissionSourceRow, AttachSourcePathOptions, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from '../../engine-sql/write-misc.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessMemberLookup, AccessMemberRow, LiveMemberRow, LiveMemberVia, AppliedPolicyRevision, FolderAccessRows, AudiencePrincipalRows, MayActForVia, JobPrincipalKind } from '../../engine-sql/access-control.ts';
import { storeCall, type StoreMember } from './common.ts';

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

/** The store keeps no shared skillpacks (see sharedSkillPackTablePresent), so no pack has roots, bound worktree or not. */
export const listSharedSkillPackRoots: StoreMember<[hostId: string], SharedSkillPackRoot[]> = async () => [];

/**
 * The source's binding as host `hostId` sees it, from the binding records an unmanaged claim keeps
 * (claimWorktreeBinding, gbrain-store `persistence::worktrees`), with the columns and text forms WORKTREE_BINDING_SQL reads.
 */
export const getWorktreeBinding: StoreMember<[sourceId: string, hostId: string | null], WorktreeBinding | null> = (brain, sourceId, hostId) =>
  storeCall({ member: 'getWorktreeBinding', sourceId }, () => brain.getWorktreeBinding(sourceId, hostId));

/** A binding names the source at its current incarnation (SOURCE_CLAIMED_SQL). */
export const isSourceClaimed: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'isSourceClaimed', sourceId }, () => brain.isSourceClaimed(sourceId));

/** An extracted chronicle row of the page carries event hashes (rust/docs/store/chronicle-ledger.md). */
export const hasExtractedEvents: StoreMember<[sourceId: string, pageId: number], boolean> = (brain, sourceId, pageId) =>
  storeCall({ member: 'hasExtractedEvents', sourceId }, () => brain.hasExtractedEvents(sourceId, pageId));

/**
 * The store keeps no access tokens: minting, revoking and the bearer check are raw SQL on `access_tokens`, which this
 * engine refuses, so no Rust brain holds a token and `auth list` lists none, as PGLite lists none on a brain with no
 * tokens.
 */
export const listAccessTokens: StoreMember<[], AccessTokenRow[]> = async () => [];

/** The store keeps no access members, so none is active. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async () => [];

/** The store keeps no access members, so none carries the labelled-only grant and a write skips the labelled-only checks. */
export const hasLabelledOnlyMember: StoreMember<[], boolean> = async () => false;

/**
 * The store's brain id and commit sequence. Every commit advances it, a page write among them, so a memoized health
 * answer is reused only while nothing was written since it was read.
 */
export const readHealthMemoClock: StoreMember<[], string> = async (brain) =>
  storeCall({ member: 'readHealthMemoClock' }, () => brain.readHealthMemoClock());

/**
 * The sources that are not archived and whose own contextual-retrieval mode (`sources set-cr-mode`, source_cr_mode.rs)
 * is per_chunk_synopsis, by id in byte order: the source half of the synopsis tier read, with its page check skipped.
 */
export const listSynopsisSourceIds: StoreMember<[], string[]> = async (brain) => {
  const tier = await storeCall({ member: 'listSynopsisSourceIds' }, () => brain.readSynopsisTierSources({ skipFrontmatter: true }));
  return (tier as { sourceIds: string[] }).sourceIds;
};

/**
 * Folder rules and pending prefixes are gbrain-store `access_rules` records (rust/docs/store/access_rules.md). A slug
 * under a rule of its source or a pending prefix is restricted; the store has no row-level security, so the unreadable
 * part is always false.
 */
export const isFolderRestricted: StoreMember<[sourceId: string, slug: string], boolean> = (brain, sourceId, slug) =>
  storeCall({ member: 'isFolderRestricted', sourceId }, () => brain.isFolderRestricted(sourceId, slug));

/** Each source with folder access state and its newest applied revision, by source id (gbrain-store `access_rules`). */
export const listAppliedPolicyRevisions: StoreMember<[], AppliedPolicyRevision[]> = (brain) =>
  storeCall({ member: 'listAppliedPolicyRevisions' }, () => brain.listAppliedPolicyRevisions());

/**
 * The rules whose readers name any of `readers` and the distinct pending prefixes, by source (gbrain-store
 * `access_rules`). No row-level security hides them, so no `'!unreadable'` row appears.
 */
export const readFolderAccess: StoreMember<[readers: readonly string[]], FolderAccessRows> = (brain, readers) =>
  storeCall({ member: 'readFolderAccess' }, () => brain.readFolderAccess([...readers]));

/**
 * A stdio server's may_act_for is a config value, which the store keeps. The store keeps no access tokens and no OAuth
 * clients, so a token or a client has no live row and permits nothing, as a revoked token or a deleted client does.
 */
export const readMayActFor: StoreMember<[via: MayActForVia, key: string], string[] | string | null> = async (brain, via, key) =>
  via === 'stdio_config' ? storeCall({ member: 'readMayActFor' }, () => brain.getConfig(key)) : null;

/** The store keeps no memory proposals, so upkeep expires nothing. */
export const expireMemoryProposals: StoreMember<[reason: string], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none awaits its owner. */
export const listAwaitingMemoryProposals: StoreMember<[limit: number], Array<Record<string, unknown>>> = async () => [];

/** No memory proposals exist on this engine (see expireMemoryProposals), so a principal holds none under any request id. */
export const readMemoryProposal: StoreMember<[principalKind: string, principalId: string, requestId: string], Record<string, unknown> | null> = async () => null;

/** No memory proposals exist on this engine (see expireMemoryProposals), so upkeep purges nothing. */
export const purgeMemoryProposals: StoreMember<[retentionDays: number], number> = async () => 0;

/**
 * The store keeps no access members and no groups (see listActiveAccessMembers), so no audience entry names an enabled
 * member or an existing group: each reads as unknown, as on a brain with none.
 */
export const readAudiencePrincipals: StoreMember<[memberIds: readonly string[], groupIds: readonly string[]], AudiencePrincipalRows> = async () => ({ members: [], groups: [] });

/** The store keeps no access members (see listActiveAccessMembers), so no id names a member and the list is empty. */
export const readAccessMembers: StoreMember<[by: AccessMemberLookup], AccessMemberRow[]> = async () => [];

/** The store keeps no access tokens and no OAuth clients (see readMayActFor), so no name or member binding names a live credential. */
export const readAccessCredentials: StoreMember<[by: AccessCredentialLookup], AccessCredentialRow[]> = async () => [];

/** The store keeps no access members (see listActiveAccessMembers), so no member is of kind audience. */
export const listAudienceAccessMembers: StoreMember<[], string[]> = async () => [];

/**
 * The store keeps no access members (see listActiveAccessMembers), so no id, config key, token or client names a live
 * member: the identity is empty, as for an unbound caller on a brain with none.
 */
export const readLiveMember: StoreMember<[via: LiveMemberVia, key: string], LiveMemberRow | null> = async () => null;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none is pending: count 0, no oldest age. */
export const readPendingProposalSummary: StoreMember<[], PendingProposalRow | null> = async () => ({ n: 0, oldest: null });

/** No memory proposals exist on this engine (see expireMemoryProposals), so the owner's list is empty on every page. */
export const listMemoryProposalRows: StoreMember<[query: ProposalListQuery], Array<Record<string, unknown>>> = async () => [];

/** No memory proposals exist on this engine, so no request id names one: show, approve and deny answer not_found. */
export const listOwnerProposalRows: StoreMember<[requestId: string], Array<Record<string, unknown>>> = async () => [];

/** The store keeps no access tokens and no OAuth clients, so a remote job's principal has no row: the job is denied as revoked. */
export const readJobPrincipal: StoreMember<[principal: { kind: JobPrincipalKind; id: string }], Record<string, unknown> | null> = async () => null;
