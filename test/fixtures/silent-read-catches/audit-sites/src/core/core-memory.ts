// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/core-memory.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/core-memory.ts:355-364
export async function pendingCoreNotices(exec: Pick<BrainEngine, 'executeRaw'>, sourceIds?: readonly string[]): Promise<Array<{ source_id: string; slug: string; revision: string | null; actor: string; created_at: string }>> {
  try {
    return await exec.executeRaw(
      `SELECT DISTINCT ON (source_id, slug) source_id, slug, revision, actor, created_at::text AS created_at
         FROM core_edit_notices WHERE acked_at IS NULL ${sourceIds ? 'AND source_id = ANY($1::text[])' : ''}
        ORDER BY source_id, slug, id DESC LIMIT 50`, sourceIds ? [[...sourceIds]] : []);
  } catch {
    return [];
  }
}
