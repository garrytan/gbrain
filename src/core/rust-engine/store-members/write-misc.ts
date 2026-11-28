/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState, the scope-source read readScopeSourceConfigs (SQL in engine-sql/access-credentials.ts) through
 * purgeMemoryProposals, readMemoryProposal, readPendingProposalSummary, listMemoryProposalRows, listOwnerProposalRows, attachSourcePath and
 * getWorktreeBinding; SQL in engine-sql/write-misc.ts; isSourceClaimed, SQL in engine-sql/sources.ts; readDrainHolderProgress, SQL in
 * engine-sql/persistence-journal.ts), and the folder access read beside the
 * access members (isFolderRestricted, listAppliedPolicyRevisions, readFolderAccess, readMayActFor, readJobPrincipal, readAccessCredentials, hasLabelledOnlyMember and listPagesNamingReader;
 * SQL in engine-sql/access-control.ts and engine-sql/write-misc.ts; the member and group reads are in access-members.ts). The credential revokes and the token list are
 * served by the jobs credential members (store-members/jobs-access-tokens.ts and jobs-oauth-clients.ts). The source read, the path attach and the pages naming a reader are served by
 * gbrain-store `write_misc`, the folder reads by gbrain-store `access_rules`, the may_act_for and credential reads by the
 * token and client records (gbrain-store `jobs::credential_binding`); the rest answer for state the store does not
 * keep. What each member answers and why: rust/docs/store/write_misc.md.
 */
import type {
  AdmissionSourceRow, AttachSourcePathOptions, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding, HostTopologyRow,
} from '../../engine-sql/write-misc.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessMemberLookup, AccessMemberRow, LiveMemberRow, LiveMemberVia, AppliedPolicyRevision, FolderAccessRows, AudiencePrincipalRows, MayActForVia, JobPrincipalKind, OwnerCredentialRow, PageNamingReaderRow } from '../../engine-sql/access-control.ts';
import { readAccessMembers } from './access-members.ts';
import { LIVE_PAGES_NAMING_READER_LIMIT, PAGES_NAMING_READER_LIMIT } from '../../engine-sql/access-control.ts';
import type { ScopeSourceLock } from '../../engine-sql/access-credentials.ts';
import type { DrainHolderProgressRow } from '../../engine-sql/persistence-journal.ts';
import { readOauthClient } from './jobs-oauth-clients.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { StoreBrain } from '../store.ts';
import { uuidText } from '../store-codec.ts';
import { OWNER_MEMBER_KEY } from '../../search/private-visibility.ts';
import type { GuestSourceLookupRow } from '../../engine.ts';

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
 * Page admission's source row, with the source's guest row joined (guest_sources.rs) as the SQL engines join it. The
 * store has no row-level security, so nothing is hidden.
 */
export const readAdmissionSource: StoreMember<[sourceId: string], AdmissionSourceRow | null> = async (brain, sourceId) => {
  const row: SourceStateRow | null = await storeCall({ member: 'readAdmissionSource', sourceId }, () => brain.readSourceState(sourceId));
  if (!row) return null;
  const guest: GuestSourceLookupRow = await storeCall({ member: 'readAdmissionSource', sourceId }, () => brain.readGuestSourceRow(sourceId));
  return {
    incarnation: row.incarnation, archived: row.archived, local_path: row.local_path,
    kind: jsonText(row.config.kind), role: jsonText(row.config.role),
    guest_writers: guest.writers ?? null, guest_trust_ceiling: guest.trust_ceiling ?? null, guest_sources_hidden: false,
  };
};

/** Attach a working tree to an existing path-less source: path, a passed name and federated flag; else unchanged. */
export const attachSourcePath: StoreMember<[sourceId: string, localPath: string, opts?: AttachSourcePathOptions], void> = async (brain, sourceId, localPath, opts) => {
  await storeCall({ member: 'attachSourcePath', sourceId }, () => brain.attachSourcePath(sourceId, localPath, opts?.name ?? null, opts?.federated ?? null));
};

/** The store is never on a schema from before shared skills, so the shared_skill_packs table is always present. */
export const sharedSkillPackTablePresent: StoreMember<[], boolean> = async () => true;

/** Every head of a pack: the store takes the limit as an i64, and a JS number past 2^31 reaches it as a float. */
const HEAD_SCAN_LIMIT = 2_147_483_647;

/** The store's pack row of one source incarnation (gbrain-store `shared_skill_publication`, one pack per incarnation), or null. */
const packOf = (brain: StoreBrain, member: string, sourceId: string, incarnation: string) =>
  storeCall({ member, sourceId }, () => brain.readSharedSkillPack({ sourceId, incarnation })) as Promise<{ pack_id: string } | null>;

/**
 * Each source's pack at the source's current incarnation (the statement joins sources on it), archived sources included
 * as the statement reads them, in source id order (the statement sets none). The roots come from the source's binding
 * as host `hostId` sees it: `relative_path` when the binding is of the pack's incarnation, and the host's `local_path`
 * when the host also has a row; null otherwise, as the statement's LEFT JOINs leave them.
 */
export const listSharedSkillPackRoots: StoreMember<[hostId: string], SharedSkillPackRoot[]> = async (brain, hostId) => {
  const sources = await storeCall({ member: 'listSharedSkillPackRoots' }, () => brain.listDoctorSources()) as Array<{ id: string; local_path: string | null; incarnation: string }>;
  const roots: SharedSkillPackRoot[] = [];
  for (const s of [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!await packOf(brain, 'listSharedSkillPackRoots', s.id, s.incarnation)) continue;
    const binding: WorktreeBinding | null = await storeCall({ member: 'listSharedSkillPackRoots', sourceId: s.id }, () => brain.getWorktreeBinding(s.id, hostId));
    const bound = binding !== null && binding.source_incarnation === s.incarnation;
    roots.push({ source_id: s.id, source_incarnation: s.incarnation, source_root: s.local_path,
      worktree_root: bound ? binding.local_path : null, relative_path: bound ? binding.relative_path : null });
  }
  return roots;
};

/** Whether the store keeps a pack row for the source incarnation. */
export const hasSharedSkillPack: StoreMember<[sourceId: string, incarnation: string], boolean> = async (brain, sourceId, incarnation) =>
  (await packOf(brain, 'hasSharedSkillPack', sourceId, incarnation)) !== null;

/**
 * The statement reads the live heads of the source incarnation and their current revisions' files. The store keeps
 * heads under the incarnation's one pack (publication refuses a second pack id), so it reads that pack's heads; with
 * no pack row there is no head to read.
 */
export const isSharedSkillPackMember: StoreMember<[sourceId: string, incarnation: string, paths: string[]], boolean> = async (brain, sourceId, incarnation, paths) => {
  const member = { member: 'isSharedSkillPackMember', sourceId };
  const pack = await packOf(brain, 'isSharedSkillPackMember', sourceId, incarnation);
  if (!pack) return false;
  const heads = await storeCall(member, () => brain.listSharedSkillHeadKeys({ sourceId, incarnation, packId: pack.pack_id, limit: HEAD_SCAN_LIMIT, names: [] })) as Array<{ name: string; deleted: boolean }>;
  const names = heads.filter(h => !h.deleted).map(h => h.name);
  if (!names.length) return false;
  if (paths.some(p => names.some(name => p.startsWith(`skills/${name}/`)))) return true;
  const revisions = await storeCall(member, () => brain.readSharedSkillHeadRevisions({ sourceId, incarnation, packId: pack.pack_id, limit: HEAD_SCAN_LIMIT, names })) as Array<{ files: unknown }>;
  return revisions.some(r => Array.isArray(r.files) && r.files.some(f => typeof f === 'object' && f !== null && paths.includes((f as { path?: unknown }).path as string)));
};

/** The page's recorded file origin, soft-deleted or live (gbrain-store `readPageFileOrigin`): one row, as (source_id, slug) is unique. */
export const readPageFileAliases: StoreMember<[sourceId: string, slug: string], Array<{ source_path: string | null; source_uri: string | null }>> = async (brain, sourceId, slug) => {
  const origin = await storeCall({ member: 'readPageFileAliases', sourceId }, () => brain.readPageFileOrigin({ sourceId, slug, includeDeleted: true })) as { source_path: string | null; source_uri: string | null } | null;
  return origin ? [{ source_path: origin.source_path, source_uri: origin.source_uri }] : [];
};

/** A tombstone is a page with no live row: the any-row read answers it, the live read rules out a live page. */
export const readPageTombstoneSourcePath: StoreMember<[sourceId: string, slug: string], { source_path: string | null } | null> = async (brain, sourceId, slug) => {
  const member = { member: 'readPageTombstoneSourcePath', sourceId };
  if (await storeCall(member, () => brain.readPageFileOrigin({ sourceId, slug, includeDeleted: false }))) return null;
  const any = await storeCall(member, () => brain.readPageFileOrigin({ sourceId, slug, includeDeleted: true })) as { source_path: string | null } | null;
  return any ? { source_path: any.source_path } : null;
};

/**
 * The source's binding as host `hostId` sees it, from the binding records an unmanaged claim keeps
 * (claimWorktreeBinding, gbrain-store `persistence::worktrees`), with the columns and text forms WORKTREE_BINDING_SQL reads.
 */
export const getWorktreeBinding: StoreMember<[sourceId: string, hostId: string | null], WorktreeBinding | null> = (brain, sourceId, hostId) =>
  storeCall({ member: 'getWorktreeBinding', sourceId }, () => brain.getWorktreeBinding(sourceId, hostId));

/** Each host binding of `hostId` with its worktree's owner, epoch, state and topology generation (gbrain-store `persistence::worktrees`). */
export const listHostTopologyRows: StoreMember<[hostId: string], HostTopologyRow[]> = (brain, hostId) =>
  storeCall({ member: 'listHostTopologyRows' }, () => brain.listHostTopologyRows(hostId));
/** Served from the store's host and source binding records (worktrees.rs host_repository_roots_in). */
export const listHostRepositoryRoots: StoreMember<[hostId: string], Array<{ local_path: string; source_id: string | null }>> = (brain, hostId) =>
  storeCall({ member: 'listHostRepositoryRoots' }, () => brain.listHostRepositoryRoots(hostId)) as Promise<Array<{ local_path: string; source_id: string | null }>>;

/** The source bindings of one worktree, by byte source id. */
export const listWorktreeMembers: StoreMember<[worktreeId: string], Array<{ source_id: string; relative_path: string }>> = (brain, worktreeId) =>
  storeCall({ member: 'listWorktreeMembers' }, () => brain.listWorktreeMembers(worktreeId));

/** A binding names the source at its current incarnation (SOURCE_CLAIMED_SQL). */
export const isSourceClaimed: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'isSourceClaimed', sourceId }, () => brain.isSourceClaimed(sourceId));

/**
 * A drain lease's holder has no progress row here: the store's worktree bindings do not record the managed-sync commits and saves
 * the progress row sums, so the lease reading counts the holder as no commits and no save.
 */
export const readDrainHolderProgress: StoreMember<[sourceId: string, since: string], DrainHolderProgressRow | null> = async () => null;

/** An extracted chronicle row of the page carries event hashes (rust/docs/store/chronicle-ledger.md). */
export const hasExtractedEvents: StoreMember<[sourceId: string, pageId: number], boolean> = (brain, sourceId, pageId) =>
  storeCall({ member: 'hasExtractedEvents', sourceId }, () => brain.hasExtractedEvents(sourceId, pageId));


/**
 * Whether any access member the store keeps, live or not, carries the labelled-only grant: the SQL engines read
 * `SELECT 1 FROM access_members WHERE labelled_only LIMIT 1`, so a disabled or removed member counts too.
 */
export const hasLabelledOnlyMember: StoreMember<[], boolean> = async (brain) =>
  (await readAccessMembers(brain, { includeRemoved: true })).some(row => row.labelled_only === true);

/**
 * Whether one of `memberIds` carries the labelled-only grant and is not the configured owner: the store's member records
 * (live or not, as the SQL reads every row) and the config `access.owner_member` with its spaces trimmed (`btrim`); no
 * owner row leaves every listed member eligible, as `id IS DISTINCT FROM NULL` is true.
 */
export const hasLabelledOnlyMemberAmong: StoreMember<[memberIds: readonly string[]], boolean> = async (brain, memberIds) => {
  const raw = await storeCall({ member: 'hasLabelledOnlyMemberAmong' }, () => brain.getConfig(OWNER_MEMBER_KEY)) as string | null;
  const owner = raw === null ? null : raw.replace(/^ +| +$/g, '');
  const wanted = new Set(memberIds);
  return (await readAccessMembers(brain, { includeRemoved: true })).some(row => row.labelled_only === true && wanted.has(row.id) && row.id !== owner);
};

/**
 * The store's brain id and commit sequence (`readProjectionReadinessGeneration`). Every commit advances it, a page write
 * among them, so a memoized health answer is reused only while nothing was written since it was read.
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
 * Whether a live markdown page of the `default` source, not archived, names the synopsis tier in its frontmatter. The
 * store keeps no `trust_frontmatter_overrides`, so no other source trusts its pages' overrides.
 */
export const hasSynopsisFrontmatterOverride: StoreMember<[], boolean> = async (brain) =>
  (await storeCall({ member: 'hasSynopsisFrontmatterOverride' }, () => brain.hasSynopsisFrontmatterOverride())) === true;

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
 * A stdio server's may_act_for is the config text as stored; a live token's (by id text) or client's is its list, null
 * when the credential is revoked, deleted, absent or holds no list.
 */
export const readMayActFor: StoreMember<[via: MayActForVia, key: string], string[] | string | null> = async (brain, via, key) => {
  if (via === 'stdio_config') return storeCall({ member: 'readMayActFor' }, () => brain.getConfig(key));
  const live = await storeCall({ member: 'readMayActFor' }, () => brain.readLiveCredential(via, key)) as { may_act_for: unknown } | null;
  return Array.isArray(live?.may_act_for) ? live!.may_act_for as string[] : null;
};

/**
 * A queued remote job's principal, revoked and deleted rows included: an OAuth client's row is the store's client read
 * (readOauthClient) cut to the columns JOB_PRINCIPAL_SQL names, a legacy token's the token the store keeps
 * (`brain.readAccessToken`), with its times as Dates as PGLite and Postgres return them. The row leaves out `token_hash`.
 * A token id that is not a uuid refuses as the SQL engines' `id = $1` does (uuidText).
 */
export const readJobPrincipal: StoreMember<[principal: { kind: JobPrincipalKind; id: string }], Record<string, unknown> | null> = async (brain, principal) => {
  if (principal.kind === 'oauth_client') {
    const row = await readOauthClient(brain, principal.id);
    if (!row) return null;
    const { client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations } = row;
    return { client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations };
  }
  const id = uuidText(principal.id);
  const raw = await storeCall({ member: 'readJobPrincipal' }, () => brain.readAccessToken(id)) as Record<string, unknown> | null;
  if (!raw) return null;
  const date = (v: unknown) => v == null ? null : new Date(String(v));
  return { ...raw, created_at: date(raw.created_at), last_used_at: date(raw.last_used_at), revoked_at: date(raw.revoked_at) };
};

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
 * The live credentials `by` names: the active tokens with exactly this name, oldest first, or the active tokens (by
 * name, in byte order) and then the clients not deleted (by client id) bound to exactly this member.
 */
export const readAccessCredentials: StoreMember<[by: AccessCredentialLookup], AccessCredentialRow[]> = async (brain, by) =>
  await storeCall({ member: 'readAccessCredentials' }, () => brain.readAccessCredentials(by)) as AccessCredentialRow[];

/** The member's live tokens (grant columns) and clients (the row less its secret hash), by byte order of kind, name and id. */
export const listOwnerCredentialRows: StoreMember<[memberId: string], OwnerCredentialRow[]> = async (brain, memberId) =>
  await storeCall({ member: 'listOwnerCredentialRows' }, () => brain.listOwnerCredentialRows(memberId)) as OwnerCredentialRow[];


/**
 * The store keeps pages, so this is a real answer: gbrain-store `write_misc` reads every page (soft-deleted ones too, as
 * the SQL does), keeps those whose normalized readers (`gbrain_access_readers`) name exactly the principal, and returns
 * them by (source, slug), at most PAGES_NAMING_READER_LIMIT (the SQL's LIMIT 51). `live` leaves soft-deleted pages out
 * and reads at most LIVE_PAGES_NAMING_READER_LIMIT (LIMIT 201).
 */
export const listPagesNamingReader: StoreMember<[principal: string, opts?: { live?: boolean }], PageNamingReaderRow[]> = async (brain, principal, opts = {}) => {
  const limit = opts.live ? LIVE_PAGES_NAMING_READER_LIMIT : PAGES_NAMING_READER_LIMIT;
  const rows = await storeCall({ member: 'listPagesNamingReader' }, () => brain.listPagesNamingReader(principal, limit, opts.live === true)) as PageNamingReaderRow[];
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id }));
};
/** Served from the store's effect, source and host binding records (worktrees.rs pending_git_effect_paths_in). */
export const listPendingGitEffectPaths: StoreMember<[hostId: string | null], Array<{ rel: string; source_path: string | null; worktree_path: string | null }>> = (brain, hostId) =>
  storeCall({ member: 'listPendingGitEffectPaths' }, () => brain.listPendingGitEffectPaths(hostId)) as Promise<Array<{ rel: string; source_path: string | null; worktree_path: string | null }>>;
