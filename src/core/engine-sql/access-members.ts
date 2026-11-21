/**
 * Access member and group writes: one SQL implementation for both engines (rust/docs/store/access-members.md).
 *
 * The member commands (access/members.ts) write members and groups through these. The
 * statements are the text the callers sent through `executeRaw` before, in the same order and the same transactions.
 * The callers keep every input check and every refusal; these only write.
 */
import type { SqlExecutor } from './executor.ts';

export type AccessMemberKind = 'person' | 'audience';

/** One new member, the groups it joins and, optionally, the access token to bind to it in the same transaction. */
export interface AccessMemberInsert { id: string; displayName: string | null; email: string | null; kind: AccessMemberKind; groups: readonly string[]; bindTokenId: string | null }

/** Creates each missing group; the groups this call created, in the order named. */
async function ensureGroups(exec: SqlExecutor, groups: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const g of groups) {
    const rows = await exec.executeRaw<{ id: string }>('INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id', [g]);
    if (rows.length) created.push(g);
  }
  return created;
}

/** Inserts the member, creates its missing groups, adds it to each and binds the token, in one transaction. */
export async function insertAccessMember(exec: SqlExecutor, spec: AccessMemberInsert): Promise<{ groupsCreated: string[] }> {
  return exec.transaction(async tx => {
    await tx.executeRaw('INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', [spec.id, spec.displayName, spec.email, spec.kind]);
    const groupsCreated = await ensureGroups(tx, spec.groups);
    for (const g of spec.groups) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g, spec.id]);
    if (spec.bindTokenId !== null) await tx.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id::text = $1', [spec.bindTokenId, spec.id]);
    return { groupsCreated };
  });
}

/** Disables a member (an earlier disable time is kept) or enables it. */
export async function setAccessMemberDisabled(exec: SqlExecutor, id: string, disabled: boolean): Promise<void> {
  await exec.executeRaw(disabled
    ? 'UPDATE access_members SET disabled_at = COALESCE(disabled_at, now()), updated_at = now() WHERE id = $1'
    : 'UPDATE access_members SET disabled_at = NULL, updated_at = now() WHERE id = $1', [id]);
}

/** Sets (or, with null, clears) the email of a member that is not removed; true when a row changed. */
export async function setAccessMemberEmail(exec: SqlExecutor, id: string, email: string | null): Promise<boolean> {
  const updated = await exec.executeRaw<{ id: string }>('UPDATE access_members SET email = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL RETURNING id', [id, email]);
  return updated.length > 0;
}

/** Sets the kind of a member that is not removed. */
export async function setAccessMemberKind(exec: SqlExecutor, id: string, kind: AccessMemberKind): Promise<void> {
  await exec.executeRaw('UPDATE access_members SET kind = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL', [id, kind]);
}

/** Sets or clears the labelled-only grant of a member that is not removed. */
export async function setAccessMemberLabelledOnly(exec: SqlExecutor, id: string, labelledOnly: boolean): Promise<void> {
  await exec.executeRaw('UPDATE access_members SET labelled_only = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL', [id, labelledOnly]);
}

/** Marks the member removed (and disabled), clears its email and drops its group memberships, in one transaction. */
export async function tombstoneAccessMember(exec: SqlExecutor, id: string): Promise<void> {
  await exec.transaction(async tx => {
    await tx.executeRaw('UPDATE access_members SET tombstoned_at = now(), disabled_at = COALESCE(disabled_at, now()), email = NULL, updated_at = now() WHERE id = $1', [id]);
    await tx.executeRaw('DELETE FROM access_group_members WHERE member_id = $1', [id]);
  });
}

/** Creates the group when missing and adds each member (already there is kept), in one transaction; true when created. */
export async function addAccessGroupMembers(exec: SqlExecutor, groupId: string, memberIds: readonly string[]): Promise<boolean> {
  return exec.transaction(async tx => {
    const created = (await ensureGroups(tx, [groupId])).length > 0;
    for (const m of memberIds) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, m]);
    return created;
  });
}

/** Drops each named member from the group, one statement per member. */
export async function removeAccessGroupMembers(exec: SqlExecutor, groupId: string, memberIds: readonly string[]): Promise<void> {
  for (const m of memberIds) await exec.executeRaw('DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2', [groupId, m]);
}

/** Deletes the group; its memberships go with it (ON DELETE CASCADE). */
export async function deleteAccessGroup(exec: SqlExecutor, id: string): Promise<void> {
  await exec.executeRaw('DELETE FROM access_groups WHERE id = $1', [id]);
}
