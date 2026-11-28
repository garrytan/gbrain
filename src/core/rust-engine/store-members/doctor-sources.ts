/**
 * Doctor reads over `sources` (src/core/engine-sql/doctor-sources.ts), served from the store's source records
 * (rust/crates/gbrain-store/src/cli_reads/doctor_sources.rs, rust/docs/store/cli-reads-doctor-src.md).
 *
 * The store answers every source once; each variant filters and projects those rows as its statement did. What the
 * store keeps no column for reads as the column's default: `last_commit`, `newest_content_at` and the `upstream_*`
 * columns are null, `managed` is false and the checkout root is the source's own path, no worktree binding or
 * guest_sources row exists, and no writer sets a source's contextual retrieval mode, so the synopsis list is empty.
 * Unordered statements answer by id.
 */
import type { BrainEngine } from '../../engine.ts';
import type { DoctorSourceRows, DoctorSourceScope, DoctorSourceVariant } from '../../engine-sql/doctor-sources.ts';
import { isConnectorSourceKind } from '../../persistence/connector-kinds.ts';
import { sourceConfigText } from '../../source-rows.ts';
import { OWNER_TIER_FLOOR } from '../../trust/tier.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** One source as `listDoctorSources` answers it. */
interface StoreSource {
  id: string; name: string | null; local_path: string | null; archived: boolean; config: Record<string, unknown>; incarnation: string;
  last_sync_at: string | null; chunker_version: string | null;
}

const live = (s: StoreSource): boolean => !s.archived;
const hasPath = (s: StoreSource): boolean => s.local_path !== null;
const kindOf = (s: StoreSource): string => sourceConfigText(s.config, 'kind') ?? '';
const inScope = (s: StoreSource, scope: DoctorSourceScope): boolean => !scope.sourceIds || scope.sourceIds.includes(s.id);
const onlyId = (s: StoreSource): { id: string } => ({ id: s.id });
const roots = (s: StoreSource): DoctorSourceRows['roots_live_ordered'] => ({ id: s.id, local_path: s.local_path, config: s.config });
const connector = (s: StoreSource): DoctorSourceRows['live_incarnations'] => ({ id: s.id, incarnation: s.incarnation, local_path: s.local_path, config: s.config });
const kinds = (s: StoreSource): DoctorSourceRows['brain_writer_by_id'] => ({ id: s.id, local_path: s.local_path, kind: sourceConfigText(s.config, 'kind') });
const claimed = (s: StoreSource): boolean => 'trust_claimed_at' in s.config && sourceConfigText(s.config, 'trust_tier') === OWNER_TIER_FLOOR && !isConnectorSourceKind(kindOf(s));

function freshness(s: StoreSource): DoctorSourceRows['freshness'] {
  return { id: s.id, name: s.name ?? '', local_path: s.local_path, last_sync_at: s.last_sync_at ? new Date(s.last_sync_at) : null, last_commit: null,
    chunker_version: s.chunker_version, newest_content_at: null, config: s.config, upstream_checked_at: null, upstream_commit: null, upstream_behind: null };
}

type Projection<V extends DoctorSourceVariant> = (rows: StoreSource[], scope: DoctorSourceScope) => DoctorSourceRows[V][];

/** What each variant keeps of the store's sources; `ids_with_live_pages` reads the store separately. */
const PROJECTIONS: { readonly [V in Exclude<DoctorSourceVariant, 'ids_with_live_pages' | 'config_shape' | 'synopsis_ids'>]: Projection<V> } = {
  roots_live_ordered: (rows) => rows.filter((s) => live(s) && hasPath(s)).map(roots),
  roots_live_fallback: (rows) => rows.filter((s) => live(s) && hasPath(s)).map(roots),
  live_path_ids: (rows, scope) => rows.filter((s) => live(s) && hasPath(s) && inScope(s, scope)).map(onlyId),
  relative_paths: (rows) => rows.filter((s) => s.id !== 'default' && !!s.local_path && live(s)).map((s) => ({ id: s.id, local_path: s.local_path as string })),
  pathless_live: (rows) => rows.filter((s) => !s.local_path && live(s)).map(onlyId),
  paths_scoped: (rows, scope) => rows.filter((s) => hasPath(s) && inScope(s, scope)).map((s) => ({ id: s.id, local_path: s.local_path as string })),
  strict_git: (rows) => rows.filter((s) => live(s) && (sourceConfigText(s.config, 'canonical') ?? '') === 'git').map((s) => ({ id: s.id, local_path: s.local_path, last_commit: null })),
  google_connectors: (rows) => rows.filter((s) => live(s) && sourceConfigText(s.config, 'kind') === 'google').map(connector),
  guest_marked_ids: (rows) => rows.filter((s) => sourceConfigText(s.config, 'guest') === 'true').map(onlyId),
  first_two_ids: (rows) => rows.slice(0, 2).map(onlyId),
  all_ids: (rows) => rows.map(onlyId),
  local_path_state: (rows) => rows.map((s) => ({ id: s.id, local_path: s.local_path, archived: s.archived })),
  storage_shelf: (rows, scope) => rows.filter((s) => s.id === scope.sourceId && live(s)).map((s) => ({ local_path: s.local_path, config: s.config })),
  brain_writer_by_id: (rows, scope) => rows.filter((s) => s.id === scope.sourceId).map(kinds),
  brain_writer_live: (rows) => rows.filter((s) => live(s) && hasPath(s)).map(kinds),
  live_incarnations: (rows) => rows.filter(live).map(connector),
  connector_keys: (rows) => rows.filter((s) => isConnectorSourceKind(sourceConfigText(s.config, 'kind'))).map((s) => ({ ...connector(s), archived: s.archived })),
  freshness: (rows, scope) => rows.filter((s) => live(s) && hasPath(s) && inScope(s, scope)).map(freshness),
  shared_skills_view: (rows, scope) => rows.filter((s) => s.id === scope.sourceId && live(s)).map((s) => ({ config: s.config, incarnation: s.incarnation })),
  detached: (rows, scope) => rows.filter((s) => s.id === scope.sourceId && live(s)).map((s) => ({ local_path: s.local_path, strategy: sourceConfigText(s.config, 'strategy'), last_commit: null })),
  claim_candidates: (rows) => rows.filter((s) => live(s) && !isConnectorSourceKind(kindOf(s))).map((s) => ({ id: s.id, claimed: claimed(s), lifted: 'trust_claim_lifted_at' in s.config })),
};

/**
 * A config that is always an object has no non-object row; no writer sets a source's contextual retrieval mode, so no
 * source runs the synopsis tier: both answer empty without reading the store.
 */
export const readDoctorSources: Member<'readDoctorSources'> = async (brain, variant, scope = {}) => {
  if (variant === 'config_shape' || variant === 'synopsis_ids') return [];
  if (variant === 'ids_with_live_pages') {
    const ids = await storeCall({ member: 'readDoctorSources' }, () => brain.listSourceIdsWithLivePages()) as string[];
    return ids.map((id) => ({ id })) as DoctorSourceRows[typeof variant][];
  }
  const project = PROJECTIONS[variant] as Projection<typeof variant>;
  if (!project) throw new Error(`readDoctorSources: '${String(variant)}' is not a doctor source variant`);
  const rows = await storeCall({ member: 'readDoctorSources' }, () => brain.listDoctorSources()) as StoreSource[];
  return project(rows, scope) as never;
};

/** No guest_sources table: only a config marks a guest source, and there is no writer list or ceiling. */
export const listGuestSourceRows: Member<'listGuestSourceRows'> = async (brain) => {
  const rows = await storeCall({ member: 'listGuestSourceRows' }, () => brain.listDoctorSources()) as StoreSource[];
  return rows.filter((s) => sourceConfigText(s.config, 'guest') === 'true').map((s) => ({ id: s.id, local_path: s.local_path, config: s.config, writers: null, ceiling: null }));
};

/** No worktree binding exists, so only live sources' own paths are roots. */
export const listCheckoutRoots: Member<'listCheckoutRoots'> = async (brain) => {
  const rows = await storeCall({ member: 'listCheckoutRoots' }, () => brain.listDoctorSources()) as StoreSource[];
  return rows.filter((s) => live(s) && hasPath(s)).map((s) => ({ root: s.local_path as string, source_id: s.id }));
};

/** A brain on this engine is unmanaged: no source is bound, its root is its own path, and no commit is recorded. */
export const listPendingRoster: Member<'listPendingRoster'> = async (brain, sourceIds) => {
  const rows = await storeCall({ member: 'listPendingRoster' }, () => brain.listDoctorSources()) as StoreSource[];
  return rows.filter((s) => live(s) && hasPath(s) && (!sourceIds || sourceIds.includes(s.id)))
    .map((s) => ({ id: s.id, last_commit: null, config: s.config, managed: false, root: s.local_path }));
};

export const countDefaultSourceFiles: Member<'countDefaultSourceFiles'> = async (brain) => {
  const counts = await storeCall({ member: 'countDefaultSourceFiles' }, () => brain.countDefaultSourceFiles()) as { live: number; file_backed: number };
  return { live: Number(counts.live), file_backed: Number(counts.file_backed) };
};

/** Every head of a pack: the store takes the limit as an i64, and a JS number past 2^31 reaches it as a float. */
const HEAD_SCAN_LIMIT = 2_147_483_647;

/**
 * A non-default source counts when the store keeps a pack for its current incarnation (one pack per incarnation) and
 * that pack has a head that is not deleted. Archived sources count as on the SQL engines: the statement reads them too.
 */
export const listAdoptedSkillPackSourceIds: Member<'listAdoptedSkillPackSourceIds'> = async (brain) => {
  const member = { member: 'listAdoptedSkillPackSourceIds' };
  const rows = await storeCall(member, () => brain.listDoctorSources()) as StoreSource[];
  const ids: string[] = [];
  for (const s of rows) {
    if (s.id === 'default') continue;
    const pack = await storeCall(member, () => brain.readSharedSkillPack({ sourceId: s.id, incarnation: s.incarnation })) as { pack_id: string } | null;
    if (!pack) continue;
    const heads = await storeCall(member, () => brain.listSharedSkillHeadKeys({ sourceId: s.id, incarnation: s.incarnation, packId: pack.pack_id,
      limit: HEAD_SCAN_LIMIT, names: [] })) as Array<{ deleted: boolean }>;
    if (heads.some((h) => !h.deleted)) ids.push(s.id);
  }
  return ids;
};
