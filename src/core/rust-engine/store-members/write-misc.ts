/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState through
 * purgeMemoryProposals, attachSourcePath and getWorktreeBinding; SQL in engine-sql/write-misc.ts; isSourceClaimed, SQL in engine-sql/sources.ts), and the folder access read beside the
 * access members (isFolderRestricted, listAppliedPolicyRevisions, readMayActFor, readAudiencePrincipals, readAccessMembers, readAccessCredentials and listAudienceAccessMembers; SQL in engine-sql/access-control.ts). The source read and the path attach are served by
 * gbrain-store `write_misc`; the rest answer for state the store does not keep. What each member answers and why:
 * rust/docs/store/write_misc.md.
 */
import type {
  AdmissionSourceRow, AttachSourcePathOptions, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from '../../engine-sql/write-misc.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessMemberLookup, AccessMemberRow, AppliedPolicyRevision, AudiencePrincipalRows, MayActForVia } from '../../engine-sql/access-control.ts';
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

/** The store keeps no access members, so none is active. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async () => [];

/**
 * The store keeps no access state: no folder rules, no pending coverage and no row-level security (every write of that
 * state is raw SQL, which this engine refuses). A slug is restricted under none of them, so the answer is false, as
 * PGLite answers for a brain with no folder rules and no pending covers (engine-sql/access-control.ts).
 */
export const isFolderRestricted: StoreMember<[sourceId: string, slug: string], boolean> = async () => false;

/** No source holds folder access state on this engine (see isFolderRestricted), so no revision is applied anywhere. */
export const listAppliedPolicyRevisions: StoreMember<[], AppliedPolicyRevision[]> = async () => [];

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
