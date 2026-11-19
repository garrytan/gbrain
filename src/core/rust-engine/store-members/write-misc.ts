/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState, the scope-source read readScopeSourceConfigs (SQL in engine-sql/access-credentials.ts) through
 * purgeMemoryProposals, readMemoryProposal, readPendingProposalSummary, listMemoryProposalRows, listOwnerProposalRows, attachSourcePath and
 * getWorktreeBinding; SQL in engine-sql/write-misc.ts; isSourceClaimed, SQL in engine-sql/sources.ts), and the folder access read beside the
 * access members (isFolderRestricted, listAppliedPolicyRevisions, readFolderAccess, readMayActFor, readJobPrincipal, readAccessCredentials, hasLabelledOnlyMember and listPagesNamingReader;
 * SQL in engine-sql/access-control.ts and engine-sql/write-misc.ts; the member and group reads are in access-members.ts). The credential revokes and the token list are
 * served by the jobs credential members (store-members/jobs-access-tokens.ts and jobs-oauth-clients.ts). The source read, the path attach and the pages naming a reader are served by
 * gbrain-store `write_misc`, the folder reads by gbrain-store `access_rules`; the rest answer for state the store does not keep. What each member answers and why:
 * rust/docs/store/write_misc.md.
 */
import type {
  AdmissionSourceRow, AttachSourcePathOptions, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from '../../engine-sql/write-misc.ts';
import { readAccessMembers } from './access-members.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AppliedPolicyRevision, FolderAccessRows, JobPrincipalKind, MayActForVia, PageNamingReaderRow } from '../../engine-sql/access-control.ts';
import { PAGES_NAMING_READER_LIMIT } from '../../engine-sql/access-control.ts';
import type { ScopeSourceLock } from '../../engine-sql/access-credentials.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { storeCall, type StoreMember } from './common.ts';

/**
 * The source's incarnation, archived flag, local path and config, or null. `lock: 'share'` asks the SQL engines to hold
 * the row FOR SHARE; the store runs one write transaction at a time, so the option changes nothing here.
 */
export const readSourceState: StoreMember<[sourceId: string, opts?: SourceStateOptions], SourceStateRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceState', sourceId }, () => brain.readSourceState(sourceId));

/**
 * The scope-source check's read (engine-sql/access-credentials.ts readScopeSourceConfigs): the id and config of each
 * known source among `ids`, in id order, from the same source read. The store runs one write transaction at a time, so
 * the lock changes nothing here.
 */
export const readScopeSourceConfigs: StoreMember<[ids: readonly string[], lock?: ScopeSourceLock], { id: string; config: unknown }[]> = async (brain, ids) => {
  const rows: { id: string; config: unknown }[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const row: SourceStateRow | null = await storeCall({ member: 'readScopeSourceConfigs', sourceId: id }, () => brain.readSourceState(id));
    if (row) rows.push({ id, config: row.config });
  }
  return rows;
};

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
 * Whether any access member the store keeps, live or not, carries the labelled-only grant: the SQL engines read
 * `SELECT 1 FROM access_members WHERE labelled_only LIMIT 1`, so a disabled or removed member counts too.
 */
export const hasLabelledOnlyMember: StoreMember<[], boolean> = async (brain) =>
  (await readAccessMembers(brain, { includeRemoved: true })).some(row => row.labelled_only === true);

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
 * A stdio server's may_act_for is a config value, which the store keeps. The store keeps access tokens and OAuth clients
 * without the may_act_for list, so a token or a client permits nothing, as one with an empty list does.
 */
export const readMayActFor: StoreMember<[via: MayActForVia, key: string], string[] | string | null> = async (brain, via, key) =>
  via === 'stdio_config' ? storeCall({ member: 'readMayActFor' }, () => brain.getConfig(key)) : null;

/**
 * A queued remote job's principal: an OAuth client's row comes from the store's client read (readOauthClient, as
 * minions/submission-authority.ts reads it); the store's token reads return no whole legacy token row, so a legacy
 * token has none and the job is denied as revoked.
 */
export const readJobPrincipal: StoreMember<[principal: { kind: JobPrincipalKind; id: string }], Record<string, unknown> | null> = async (brain, principal) =>
  principal.kind === 'oauth_client' ? (await readOauthClient(brain, principal.id) as unknown as Record<string, unknown> | null) : null;

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

/**
 * The store keeps tokens and clients without member bindings and without the may_act_for list (see readMayActFor), and
 * this lookup is not served from them yet: no name or member binding names a live credential.
 */
export const readAccessCredentials: StoreMember<[by: AccessCredentialLookup], AccessCredentialRow[]> = async () => [];


/**
 * The store keeps pages, so this is a real answer: gbrain-store `write_misc` reads every page (soft-deleted ones too, as
 * the SQL does), keeps those whose normalized readers (`gbrain_access_readers`) name exactly the principal, and returns
 * them by (source, slug), at most PAGES_NAMING_READER_LIMIT (the SQL's LIMIT 51).
 */
export const listPagesNamingReader: StoreMember<[principal: string], PageNamingReaderRow[]> = async (brain, principal) => {
  const rows = await storeCall({ member: 'listPagesNamingReader' }, () => brain.listPagesNamingReader(principal, PAGES_NAMING_READER_LIMIT)) as PageNamingReaderRow[];
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id }));
};
