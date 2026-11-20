/**
 * The holds a source carries by design (sync-holds.ts readers mark a read-only mirror's records `read_only_checkout`):
 * a mirror's database-only pages (`mirror_database_only`) and the deletions the user kept on a mirror (`mirror_keep_deleted`),
 * with the keep-the-deletion decision a rewrite of the same file carries.
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from './digest.ts';
import type { FileDriftDeletedState, FileDriftSide, GitHoldRecord } from './sync-holds.ts';
import { SYNC_ORIGIN_DELETED_OP } from './sync-pass-row.ts';

/** The user's keep-the-deletion decision on a mirror's deleted-side `file_drift` hold: the apply's request, when, and what it was bound to. */
export interface KeepDeletedDecision { request_id: string; decided_at: string; page_id: number | null; revision: string | null; marker_digest?: string }

/**
 * GBRA-542: a deleted-side `file_drift` hold on a read-only mirror whose file Git committed and the upstream removed while the
 * page changed in the database (or has no import record). gbrain never writes the mirror's files, so the page stays live and
 * database-only: the hold is carried by design (class `mirror_database_only`), never re-screened by a plain sync and never a
 * person's to clear. Deleting the page as the upstream did stays the owner's explicit `--prefer file` repair.
 */
export function mirrorDatabaseOnlyHold(record: Pick<GitHoldRecord, 'code' | 'meta' | 'read_only_checkout'>): boolean {
  return record.read_only_checkout === true && record.code === 'file_drift' && record.meta.side === 'deleted' && record.meta.state === 'file_gone' && !record.meta.reason;
}

/**
 * A deleted-side `file_drift` hold on a read-only mirror whose page the user decided to keep deleted (`meta.keep_deleted`): the
 * hold stays, decided and carried (class `mirror_keep_deleted`), and needs nobody until the upstream edits the file again.
 */
export function mirrorKeepDeletedHold(record: Pick<GitHoldRecord, 'code' | 'meta' | 'read_only_checkout'>): boolean {
  return record.read_only_checkout === true && record.code === 'file_drift' && record.meta.side === 'deleted' && !!record.meta.keep_deleted
    && (record.meta.state === 'tombstone_edited' || record.meta.state === 'purged_differs');
}

/**
 * The keep-the-deletion decision a rewrite of the same bytes carries, as repair verdicts are carried: the same state when the
 * pass did not re-check the hold because its tombstone moved, or, when the tombstone was purged, rebound to its deletion marker.
 */
export async function carriedKeepDeleted(tx: Pick<BrainEngine, 'readOpCheckpointRecord'>, existing: GitHoldRecord, input: Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'>): Promise<KeepDeletedDecision | undefined> {
  const decision = existing.meta.keep_deleted;
  const bytes = existing.meta.blob_oid ?? existing.meta.working_hash;
  if (!decision || input.code !== existing.code || input.meta.side !== 'deleted' || !bytes || (input.meta.blob_oid ?? input.meta.working_hash) !== bytes) return undefined;
  if (input.meta.state === existing.meta.state && !input.meta.basis_moved) return decision;
  if (existing.meta.state !== 'tombstone_edited' || input.meta.state !== 'purged_differs') return undefined;
  const row = await tx.readOpCheckpointRecord(SYNC_ORIGIN_DELETED_OP, `${input.source_id}:${input.incarnation}:${input.source_path}`);
  const marker = (Array.isArray(row?.completed_keys) ? row.completed_keys[0] ?? null : null) as { kind?: string } | null;
  return marker?.kind === 'deleted' ? { ...decision, marker_digest: digest(marker) } : undefined;
}

/** GBRA-542: one class of holds carried by design, with a sample of its paths and the read-only command that lists them. */
export interface CarriedHolds { class: 'mirror_database_only' | 'mirror_keep_deleted'; count: number; sample: string[]; list: string[] }
export const CARRIED_SAMPLE = 5;

/** GBRA-542: the carried classes among one source's holds (empty when there are none). */
export function carriedHolds(records: ReadonlyArray<Pick<GitHoldRecord, 'source_id' | 'path' | 'code' | 'meta' | 'read_only_checkout'>>): CarriedHolds[] {
  const mirror = records.filter(mirrorDatabaseOnlyHold);
  const keptDeleted = records.filter(mirrorKeepDeletedHold);
  return [...mirror.length ? [{ class: 'mirror_database_only' as const, count: mirror.length, sample: mirror.slice(0, CARRIED_SAMPLE).map(record => record.path),
    list: heldDriftPreviewArgv(mirror[0]!.source_id, 'deleted', 'file_gone', 'file') }] : [],
  ...keptDeleted.length ? [{ class: 'mirror_keep_deleted' as const, count: keptDeleted.length, sample: keptDeleted.slice(0, CARRIED_SAMPLE).map(record => record.path),
    list: ['gbrain', 'sources', 'status', keptDeleted[0]!.source_id, '--json'] }] : []];
}

/** #6712 PR 4b: the bulk preview of the held `file_drift` pages of one side (and deleted state), narrowed to `path` when given. */
export function heldDriftPreviewArgv(sourceId: string, side: FileDriftSide, state: FileDriftDeletedState | undefined, prefer: 'file' | 'database', path?: string): string[] {
  return ['gbrain', 'repair', 'file-drift', '--source', sourceId, '--held', '--side', side, ...(side === 'deleted' && state ? ['--state', state] : []),
    ...(path ? ['--only', path] : []), '--prefer', prefer];
}
