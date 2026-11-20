import type { BrainEngine } from './engine.ts';
import { opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';

// The archive predicates and the source scrub live with the archive statements (engine-sql/source-archive.ts).
export { EXPIRED_ARCHIVE_SQL, UNVERIFIED_ARCHIVE_SQL, removedSourceScrubCtes } from './engine-sql/source-archive.ts';
export const unverifiedArchiveReason = (id: string) =>
  `archive timestamps are missing or invalid, so the 72h recovery window cannot be verified; run gbrain sources restore ${id}, then gbrain sources archive ${id} to restart it`;

/**
 * Delete a `sources` row together with that incarnation's persistence source
 * binding (#5732). `persistence_source_bindings` has no FK to `sources`, so a
 * delete that leaves the binding would make a same-id replacement read as
 * claimed. A binding of another incarnation is never touched here; `gbrain
 * repair orphan-bindings` removes those. The source's managed-sync cursors
 * (`op_checkpoints`, also no FK) go too (#8741): nothing can resume them, and doctor `managed_sync_backlog` would warn with a resume command
 * that fails `unknown_source`. The same statement runs
 * removedSourceScrubCtes, and a second statement repeats it once the row is
 * gone, unless a source with this id exists again by then: a replacement
 * created between the two statements keeps its rows. A source that still has
 * pages is deleted only when the pages cascade (#7072), in the same statement;
 * otherwise nothing is deleted and `source_pages_remain` is thrown. Returns whether a row
 * was deleted. The statements are the engine member `deleteSourceRecord`
 * (engine-sql/source-archive.ts); the Rust engine removes the pages and the same rows in one write transaction.
 */
export async function deleteSourceRow(
  engine: Pick<BrainEngine, 'deleteSourceRecord'>,
  id: string,
  opts: { expiredArchiveOnly?: boolean } = {},
): Promise<boolean> {
  const result = await engine.deleteSourceRecord(id, opts.expiredArchiveOnly === true);
  if (result.stranded > 0) throw sourcePagesRemain(id, result.stranded);
  return result.deleted;
}

function sourcePagesRemain(id: string, n: number) {
  return opError('source_pages_remain', `Deleting source '${id}' would leave ${n} page(s) with no source row, so nothing was deleted.`,
    `The database would not cascade the delete of source '${id}' to its ${n} page(s): the pages -> sources foreign key on this brain is missing, does not cascade or is disabled. `
    + `The source and its pages are unchanged. Keep the source (if it is archived, gbrain sources restore ${id} makes it active again) and give the brain host's operator the output of the command in fix.`,
    { fix: { ...readFix('Reports the brain\'s schema and health, read-only.', { argv: ['gbrain', 'doctor', '--json'] }), actor: 'host_admin' } });
}
