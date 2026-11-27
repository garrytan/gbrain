/**
 * The page-write reads and upkeep that belong to no other domain (engine-sql/write-misc.ts): page admission's source
 * row, a write's source state, the worktree binding, the extracted-event check, the shared skillpack reads and the
 * memory proposal upkeep. The source read and the binding are served by gbrain-store (`write_misc`,
 * `persistence::worktrees`); the rest answer for state the store does not keep.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { AdmissionSourceRow, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding } from '../../engine-sql/write-misc.ts';
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
 * Page admission's source row. The store has no guest_sources table and no row-level security, so no guest_sources
 * row joins and nothing is hidden.
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

/**
 * The store answers as a current schema with no shared skillpacks does: the table exists (the store is never on a
 * schema from before shared skills) and holds no pack, so listSharedSkillPackRoots returns nothing.
 */
export const sharedSkillPackTablePresent: StoreMember<[], boolean> = async () => true;

/** The store keeps no shared skillpacks (see sharedSkillPackTablePresent), so no pack has roots, bound worktree or not. */
export const listSharedSkillPackRoots: StoreMember<[hostId: string], SharedSkillPackRoot[]> = async () => [];

/**
 * The source's binding as host `hostId` sees it, from the binding records an unmanaged claim keeps
 * (gbrain-store `persistence::worktrees`), with the columns and text forms WORKTREE_BINDING_SQL reads.
 */
export const getWorktreeBinding: StoreMember<[sourceId: string, hostId: string | null], WorktreeBinding | null> = (brain, sourceId, hostId) =>
  storeCall({ member: 'getWorktreeBinding', sourceId }, () => brain.getWorktreeBinding(sourceId, hostId));

/**
 * Whether an extracted chronicle row of the page carries event hashes. The store keeps no chronicle ledger
 * (gbrain-store `cli_reads::put_reads`), so the answer is false, as on a SQL brain with no extracted chronicle row.
 */
export const hasExtractedEvents: StoreMember<[sourceId: string, pageId: number], boolean> = (brain, sourceId, pageId) =>
  storeCall({ member: 'hasExtractedEvents', sourceId }, () => brain.hasExtractedEvents(sourceId, pageId));

/** The store keeps no memory proposals, so upkeep expires nothing. */
export const expireMemoryProposals: StoreMember<[reason: string], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so upkeep purges nothing. */
export const purgeMemoryProposals: StoreMember<[retentionDays: number], number> = async () => 0;

/** No memory proposals exist on this engine (see expireMemoryProposals), so none awaits its owner. */
export const listAwaitingMemoryProposals: StoreMember<[limit: number], Array<Record<string, unknown>>> = async () => [];
