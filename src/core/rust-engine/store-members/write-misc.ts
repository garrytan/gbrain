/**
 * The page-write reads and upkeep that belong to no other domain (BrainEngine readSourceState through
 * purgeMemoryProposals, attachSourcePath and getWorktreeBinding; SQL in engine-sql/write-misc.ts), and the folder access read beside the
 * access members (isFolderRestricted; SQL in engine-sql/access-control.ts). The source read and the path attach are served by
 * gbrain-store `write_misc`; the rest answer for state the store does not keep. What each member answers and why:
 * rust/docs/store/write_misc.md.
 */
import type {
  AdmissionSourceRow, AttachSourcePathOptions, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from '../../engine-sql/write-misc.ts';
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

/** The store keeps no chronicle extraction state, so no page has events. */
export const hasExtractedEvents: StoreMember<[sourceId: string, pageId: number], boolean> = async () => false;

/** The store keeps no access members, so none is active. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async () => [];

/**
 * The store keeps no notifier state (a resident notifier refuses to start on this engine, notifier/store.ts), so no
 * source has recorded coverage and search carries the freshness notice only when `sync.on_commit` is on.
 */
export const notifierCoverageRecorded: StoreMember<[], boolean> = async () => false;

/**
 * The store keeps no resumable-op checkpoint: every checkpoint write (op-checkpoint.ts) is raw SQL, which this engine
 * refuses, and the store's only `op_checkpoints` rows are housekeeping turns, whose ops no resumable op uses. So no
 * key has completed and the op walks from the start, as after `clearOpCheckpoint`.
 */
export const readOpCheckpointKeys: StoreMember<[op: string, fingerprint: string], { keys: string[]; corruptParent: boolean }> =
  async () => ({ keys: [], corruptParent: false });

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

/** The store keeps no memory proposals, so upkeep expires nothing. */
export const expireMemoryProposals: StoreMember<[reason: string], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none awaits its owner. */
export const listAwaitingMemoryProposals: StoreMember<[limit: number], Array<Record<string, unknown>>> = async () => [];

/** No memory proposals exist on this engine (see expireMemoryProposals), so upkeep purges nothing. */
export const purgeMemoryProposals: StoreMember<[retentionDays: number], number> = async () => 0;
