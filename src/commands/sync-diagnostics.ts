import type { SyncResult } from './sync.ts';

export function printManagedSyncDiagnostic(result: SyncResult, sink: NodeJS.WriteStream): boolean {
  const d = result.managedWrite;
  if (!d) return false;
  const write = (line: string) => sink.write(line + '\n');
  write(result.status === 'blocked_by_failures'
    ? `Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed.`
    : 'Sync PARTIAL: an accepted write is not committed; last_commit is unchanged.');
  write(`  ${d.write_error} [${d.reason}]: ${d.message}`);
  write(`  Source: ${JSON.stringify(d.source_id)}; slug: ${JSON.stringify(d.slug)}; path: ${JSON.stringify(d.path)}`);
  write(`  Request: ${d.write_request.request_id} (${d.write_request.state})`);
  write(`  Fix: ${d.suggestion}`);
  if (d.ledger_recorded === false) write('  Local failure ledger unavailable; the durable receipt above remains authoritative.');
  return true;
}

/** Informational managed-sync lines: skipped slug collisions and the links derived after the checkpoint. */
export function printManagedSyncNotes(result: SyncResult, write: (line: string) => void): void {
  for (const collision of result.slugCollisions ?? []) {
    write(`  Slug collision: ${collision.skipped.join(', ')} and ${collision.kept} map to ${collision.slug}; kept ${collision.kept}. Rename one file to import both.`);
  }
  const links = result.links;
  if (links && (links.created || links.removed || links.remaining)) {
    write(`  Links: ${links.created} created, ${links.removed} removed across ${links.pages} page(s)` +
      (links.remaining ? `; ${links.remaining} page(s) still owe extraction — run 'gbrain extract --stale'.` : '.'));
  }
}
