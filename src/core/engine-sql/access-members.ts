/**
 * Access member and group writes: one SQL implementation for both engines (rust/docs/store/access-members.md).
 *
 * The member commands (access/members.ts) write members, groups and credential bindings through these. The
 * statements are the text the callers sent through `executeRaw` before, in the same order and the same transactions.
 * The callers keep every input check and every refusal; these only write.
 */
import type { SqlExecutor } from './executor.ts';

/** An enabled member linked to a person of a trusted system, with its groups in `group_id` order. */
export interface LinkedMemberRow { id: string; groups: string[] | null }

/**
 * The enabled member (not disabled, not tombstoned) the link (system, externalId) names, with its groups, or null. The
 * attested-actor check (access/actor.ts linkedMember) reads it; a schema before the link tables fails, and the caller
 * reads that as unlinked.
 */
export async function readLinkedMember(exec: Pick<SqlExecutor, 'executeRaw'>, system: string, externalId: string): Promise<LinkedMemberRow | null> {
  const [row] = await exec.executeRaw<LinkedMemberRow>(
      `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
       FROM access_member_links l JOIN access_members m ON m.id = l.member_id LEFT JOIN access_group_members g ON g.member_id = m.id
       WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id`, [system, externalId]);
  return row ?? null;
}
