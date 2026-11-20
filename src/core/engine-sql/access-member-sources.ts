/**
 * Personal sources: the `access_member_sources` rows (v299) for both engines (rust/docs/store/access-members.md).
 *
 * A row binds a source to the member it belongs to; a source with at least one binding is personal
 * (access/member-sources.ts). The statements are the text access/member-sources.ts sent through `executeRaw`, except
 * that the list sort keys carry COLLATE "C": the lists sort ids by byte on every Postgres locale, as PGLite and the
 * Rust store sort. The callers keep every input check and every refusal.
 */
import type { SqlExecutor } from './executor.ts';

type RawExec = Pick<SqlExecutor, 'executeRaw'>;

/** One `access_member_sources` row. */
export interface AccessMemberSourceRow { member_id: string; source_id: string; created_at: Date | string }

/** One binding as the personal-source check reads it. */
export interface MemberSourceBinding { source_id: string; member_id: string }

/** The binding of (memberId, sourceId), or null. */
export async function readAccessMemberSource(exec: RawExec, memberId: string, sourceId: string): Promise<AccessMemberSourceRow | null> {
  const [row] = await exec.executeRaw<AccessMemberSourceRow>('SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 AND source_id = $2', [memberId, sourceId]);
  return row ?? null;
}

/** Binds the source to the member; nothing when the binding exists. The member reference refuses an unknown member. */
export async function insertAccessMemberSource(exec: RawExec, memberId: string, sourceId: string): Promise<void> {
  await exec.executeRaw('INSERT INTO access_member_sources (member_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [memberId, sourceId]);
}

/** Removes the binding of (memberId, sourceId); nothing for no such binding. */
export async function deleteAccessMemberSource(exec: RawExec, memberId: string, sourceId: string): Promise<void> {
  await exec.executeRaw('DELETE FROM access_member_sources WHERE member_id = $1 AND source_id = $2', [memberId, sourceId]);
}

/** Every binding, or one member's bindings, by member id and source id in byte order. */
export async function listAccessMemberSources(exec: RawExec, memberId: string | null): Promise<AccessMemberSourceRow[]> {
  return memberId === null
    ? exec.executeRaw<AccessMemberSourceRow>('SELECT member_id, source_id, created_at FROM access_member_sources ORDER BY member_id COLLATE "C", source_id COLLATE "C"')
    : exec.executeRaw<AccessMemberSourceRow>('SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 ORDER BY member_id COLLATE "C", source_id COLLATE "C"', [memberId]);
}

/** The members bound to one source, by member id in byte order; empty for a source that is not personal. */
export async function listAccessMemberSourceOwners(exec: RawExec, sourceId: string): Promise<string[]> {
  const rows = await exec.executeRaw<{ member_id: string }>('SELECT member_id FROM access_member_sources WHERE source_id = $1 ORDER BY member_id COLLATE "C"', [sourceId]);
  return rows.map(r => r.member_id);
}

/** Every binding of the named sources, in no set order (the personal-source check builds sets from them). */
export async function readMemberSourceBindings(exec: RawExec, sourceIds: readonly string[]): Promise<MemberSourceBinding[]> {
  return exec.executeRaw<MemberSourceBinding>('SELECT source_id, member_id FROM access_member_sources WHERE source_id = ANY($1::text[])', [[...sourceIds]]);
}
