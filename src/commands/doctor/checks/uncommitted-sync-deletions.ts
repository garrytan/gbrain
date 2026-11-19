/**
 * #7130 `uncommitted_sync_deletions`: soft-deleted pages a managed sync removed although Git never held their recorded
 * file (`.gitignore` excludes it, or no commit holds it and it is not on the disk), one reader in
 * `src/core/uncommitted-deletions.ts`. Before #7130 sync read such an absent file as a deletion, so the tombstone may hold
 * the only copy of the page and the purge removes it for good after its retention window. The finding names the
 * read-only `gbrain repair uncommitted-deletions --source <id>` preview; restoring is the user's decision.
 *
 * Read-only and bounded: at most `DOCTOR_PATH_LIMIT` tombstones read and checked per run across sources (descending page
 * id), with `truncated` / `exact` details; a bounded source names the `next_after` page id, and the message names the
 * repair preview that continues from it (`--after`). Pages deleted by another writer are counted apart
 * and never warn. Off the owner host, on a brain without managed sync or with no bound source it is `ok` + info
 * (`not_applicable`); a checkout or Git history that cannot be read is the unknown convention (`warn`, `health: unknown`).
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { DOCTOR_PATH_LIMIT, PURGED_NOTE, scanUncommittedDeletions, type UncommittedDeletionScan } from '../../../core/uncommitted-deletions.ts';
import { sortSourcesById } from '../../../core/source-rows.ts';

const DOCS = 'docs/guides/repair.md#uncommitted-deletions';
const SAMPLE_LIMIT = 5;

async function runUncommittedSyncDeletions(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const sourceIds = sortSourcesById(await engine.listAllSources()).map(row => row.id);
    const scans: UncommittedDeletionScan[] = [];
    let budget = DOCTOR_PATH_LIMIT;
    for (const sourceId of sourceIds) {
      const scan = await scanUncommittedDeletions(engine, sourceId, { pathLimit: budget });
      budget -= scan.tombstones;
      scans.push(scan);
    }
    const bySync = scans.flatMap(scan => scan.pages.filter(page => page.deleted_by === 'sync'));
    const byOther = scans.flatMap(scan => scan.pages.filter(page => page.deleted_by !== 'sync'));
    const unknown = scans.filter(scan => scan.status === 'unknown' || scan.unknown > 0);
    const truncated = scans.some(scan => scan.truncated);
    const details = { count: bySync.length, other_writer_count: byOther.length, truncated, exact: !truncated && !unknown.length, purged: PURGED_NOTE, docs: DOCS,
      by_source: scans.map(scan => ({ source_id: scan.source_id, status: scan.status, ...(scan.reason ? { reason: scan.reason } : {}), sync_deleted: scan.pages.filter(page => page.deleted_by === 'sync').length,
        other_writer: scan.pages.filter(page => page.deleted_by !== 'sync').length, tombstones: scan.tombstones, checked: scan.checked, unknown: scan.unknown, truncated: scan.truncated,
        ...(scan.next_after !== undefined ? { next_after: scan.next_after } : {}) })),
      samples: bySync.slice(0, SAMPLE_LIMIT).map(({ source_id, slug, source_path, deleted_at, evidence }) => ({ source_id, slug, source_path, deleted_at, evidence })) };
    const otherNote = byOther.length ? ` ${byOther.length} more soft-deleted page(s) with an uncommitted file were deleted by another writer, not by a sync (the preview lists them; --include-ambiguous restores them).` : '';
    const continueNote = truncated ? ` This check is bounded (${DOCTOR_PATH_LIMIT} tombstones per run); preview past it with `
      + `${scans.filter(scan => scan.truncated).map(scan => `gbrain repair uncommitted-deletions --source ${scan.source_id}${scan.next_after !== undefined ? ` --after ${scan.next_after}` : ''}`).join('; ')}.` : '';
    if (bySync.length) {
      const sources = [...new Set(bySync.map(page => page.source_id))];
      checks.push({ name: 'uncommitted_sync_deletions', status: 'warn', details: { ...details, ...(unknown.length ? { health: 'unknown' } : {}) },
        message: `${bySync.length}${details.exact ? '' : '+'} soft-deleted page(s) were removed by a sync although Git never held their file (.gitignore excludes it, or it was never committed), so each tombstone may be the only copy and the purge removes it for good `
          + `(${sources.map(source => `${source}: ${bySync.filter(page => page.source_id === source).length}`).join('; ')}; e.g. ${details.samples.map(page => `${page.source_id}:${page.slug} (${page.source_path}, ${page.evidence})`).join(', ')}). `
          + `Preview the restore with gbrain repair uncommitted-deletions --source ${sources[0]}. ${PURGED_NOTE}${otherNote}${continueNote}`,
        fix: agentFix(['gbrain', 'repair', 'uncommitted-deletions', '--source', sources[0]!, '--json'],
          'Read-only preview: lists each page with its recorded path, deletion time and evidence, and prints the apply command with its hash. Apply only after the user agrees (each page comes back live and database-only).',
          'uncommitted_sync_deletions', { docs: DOCS }) });
      return checks;
    }
    if (unknown.length) {
      checks.push({ name: 'uncommitted_sync_deletions', status: 'warn', details: { ...details, health: 'unknown' },
        message: `Soft-deleted pages of ${unknown.map(scan => `${scan.source_id} (${scan.reason ?? `${scan.unknown} unreadable path(s)`})`).join(', ')} could not be checked: the checkout or its Git history could not be read, so no count is reported.`,
        fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--source', unknown[0]!.source_id, '--json'],
          'Read-only: shows the source\'s canonical root and owner host so the checkout can be inspected.', 'uncommitted_sync_deletions', { docs: DOCS }) });
      return checks;
    }
    if (!scans.some(scan => scan.status === 'known')) {
      const reason = scans.some(scan => scan.reason === 'not_owner_host') ? 'not_owner_host' : scans[0]?.reason === 'not_managed' ? 'not_managed' : 'not_applicable';
      checks.push({ name: 'uncommitted_sync_deletions', status: 'ok', severity: 'info', readiness_state: 'not_applicable', details: { ...details, reason },
        message: reason === 'not_owner_host'
          ? 'Not applicable on this host: soft-deleted pages are checked against each source\'s checkout on its canonical owner host (run doctor there).'
          : reason === 'not_managed' ? 'Not applicable: this brain has no managed sync, which is what removed pages whose file Git never held.'
          : 'Not applicable: no source has a canonical checkout on this host.' });
      return checks;
    }
    checks.push({ name: 'uncommitted_sync_deletions', status: 'ok', details,
      message: `No soft-deleted page was removed by a sync while Git never held its file (${scans.reduce((sum, scan) => sum + scan.checked, 0)} tombstone(s) checked${truncated ? '; bounded, more not checked' : ''}).${otherNote}${continueNote}` });
  } catch (error) {
    checks.push(checkError('uncommitted_sync_deletions', 'check soft-deleted pages for files Git never held', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const uncommittedSyncDeletionsEntry: DoctorEntry = { name: 'uncommitted_sync_deletions', emits: ['uncommitted_sync_deletions'], run: runUncommittedSyncDeletions };
