/**
 * Folder access reads: one SQL implementation for both engines. The access functions
 * (`gbrain_access_*`) are created by the schema migrations; a caller that wants a failed read
 * to count as restricted catches the error itself (`search/private-visibility.ts`).
 */
import type { LegacyUnscopedRead } from './brands.ts';

/**
 * Whether a page known by its slug sits under an applied folder rule, under a pending or invalid folder prefix, or
 * this database role cannot read the folder access tables. Judged against the applied rules, not a page row's stamp.
 */
export async function isFolderRestricted(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ restricted: boolean }>(
    'SELECT (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2) OR gbrain_access_state_unreadable()) AS restricted', [sourceId, slug]);
  return row?.restricted === true;
}

/** The newest applied folder-rule revision of one source, null when no revision of it has been applied. */
export interface AppliedPolicyRevision {
  source_id: string;
  rev: number | null;
}

/** The statement whoami and `_meta.access` (access/caller.ts appliedAccessSummary) ran through executeRaw. */
export const APPLIED_POLICY_REVISIONS_SQL = `SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`;

/** Each source with folder access state and its newest applied revision, by source id. */
export async function listAppliedPolicyRevisions(exec: LegacyUnscopedRead): Promise<AppliedPolicyRevision[]> {
  const rows = await exec.executeRaw<{ source_id: string; rev: number | string | null }>(APPLIED_POLICY_REVISIONS_SQL);
  return rows.map(r => ({ source_id: r.source_id, rev: r.rev === null ? null : Number(r.rev) }));
}
