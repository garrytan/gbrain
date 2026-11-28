/**
 * The page-write reads and upkeep that belong to no other domain (engine-sql/write-misc.ts): page admission's source
 * row, a write's source state, the worktree binding, the extracted-event check, the shared skillpack reads and the
 * memory proposal upkeep. The source read, the binding and the pack roots are served by gbrain-store (`write_misc`,
 * `persistence::worktrees`, `shared_skill_publication`); the rest answer for state the store does not keep.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { AdmissionSourceRow, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding } from '../../engine-sql/write-misc.ts';
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
 * Page admission's source row. The store has no guest_sources table and no row-level security, so no guest_sources
 * row joins and nothing is hidden. A guest source (config guest: true) refuses, as readGuestSourceRow does: without its
 * guest_sources row, admission would read it as an ordinary source and skip the guest writer and attribution checks.
 */
export const readAdmissionSource: StoreMember<[sourceId: string], AdmissionSourceRow | null> = async (brain, sourceId) => {
  const row: SourceStateRow | null = await storeCall({ member: 'readAdmissionSource', sourceId }, () => brain.readSourceState(sourceId));
  if (!row) return null;
  const guests: string[] = await storeCall({ member: 'readAdmissionSource', sourceId }, () => brain.listGuestSourceIds([sourceId]));
  if (guests.includes(sourceId)) refuseMember('readAdmissionSource', `source ${sourceId} is a guest source (config guest: true) and the store keeps no guest_sources row for its writers`);
  return {
    incarnation: row.incarnation, archived: row.archived, local_path: row.local_path,
    kind: jsonText(row.config.kind), role: jsonText(row.config.role),
    guest_writers: null, guest_trust_ceiling: null, guest_sources_hidden: false,
  };
};

/** The store is never on a schema from before shared skills, so the pack table is always there (listSharedSkillPackRoots). */
export const sharedSkillPackTablePresent: StoreMember<[], boolean> = async () => true;

/**
 * The shared skillpack roots as engine-sql/write-misc.ts joins them: each source's pack at the source's current
 * incarnation (gbrain-store `shared_skill_publication` pack records), the source's local path, and, when the source's
 * binding is of that incarnation, host `hostId`'s worktree path (null without a host row) and the binding's relative
 * path. A brain that never activated shared publication holds no pack: the store writes a pack only once it is active.
 */
export const listSharedSkillPackRoots: StoreMember<[hostId: string], SharedSkillPackRoot[]> = async (brain, hostId) => {
  const member = 'listSharedSkillPackRoots';
  const flag: { skill_bundles_enabled: boolean } = await storeCall({ member }, () => brain.readSharedSkillPublication());
  if (!flag.skill_bundles_enabled) return [];
  const sources: Array<{ id: string; incarnation: string; local_path: string | null }> =
    await storeCall({ member }, () => brain.listAllSources({ includeArchived: true }));
  const roots: SharedSkillPackRoot[] = [];
  for (const source of sources) {
    const pack: { source_incarnation: string } | null = await storeCall({ member, sourceId: source.id },
      () => brain.readSharedSkillPack({ sourceId: source.id, incarnation: source.incarnation }));
    if (!pack) continue;
    const binding: WorktreeBinding | null = await storeCall({ member, sourceId: source.id }, () => brain.getWorktreeBinding(source.id, hostId));
    const bound = binding !== null && binding.source_incarnation === pack.source_incarnation;
    roots.push({ source_id: source.id, source_incarnation: pack.source_incarnation, source_root: source.local_path,
      worktree_root: bound ? binding.local_path : null, relative_path: bound ? binding.relative_path : null });
  }
  return roots;
};

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
