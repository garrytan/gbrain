import type { BrainEngine } from './engine.ts';
import { opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';

export { EXPIRED_ARCHIVE_SQL, UNVERIFIED_ARCHIVE_SQL, removedSourceRescrubStatement, removedSourceScrubCtes, sourceIncarnationDeleteStatement } from './engine-sql/sources.ts';
export const unverifiedArchiveReason = (id: string) =>
  `archive timestamps are missing or invalid, so the 72h recovery window cannot be verified; run gbrain sources restore ${id}, then gbrain sources archive ${id} to restart it`;

/**
 * Delete a `sources` row with what is keyed by it (`engine.deleteSourceRecord`, contract in engine-sql/sources.ts:
 * the incarnation's persistence binding, managed-sync cursors and the removedSourceScrubCtes rows). A source whose
 * pages would not cascade (#7072) is not deleted and `source_pages_remain` is thrown. Returns whether a row was deleted.
 */
export async function deleteSourceRow(
  engine: Pick<BrainEngine, 'deleteSourceRecord'>,
  id: string,
  opts: { expiredArchiveOnly?: boolean } = {},
): Promise<boolean> {
  const { deleted, stranded } = await engine.deleteSourceRecord(id, opts);
  if (stranded > 0) throw sourcePagesRemain(id, stranded);
  return deleted;
}

function sourcePagesRemain(id: string, n: number) {
  return opError('source_pages_remain', `Deleting source '${id}' would leave ${n} page(s) with no source row, so nothing was deleted.`,
    `The database would not cascade the delete of source '${id}' to its ${n} page(s): the pages -> sources foreign key on this brain is missing, does not cascade or is disabled. `
    + `The source and its pages are unchanged. Keep the source (if it is archived, gbrain sources restore ${id} makes it active again) and give the brain host's operator the output of the command in fix.`,
    { fix: { ...readFix('Reports the brain\'s schema and health, read-only.', { argv: ['gbrain', 'doctor', '--json'] }), actor: 'host_admin' } });
}
