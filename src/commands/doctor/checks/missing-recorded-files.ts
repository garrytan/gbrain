/**
 * #6609 (D5) `missing_recorded_files`: live pages of a classic source (a
 * checkout on this host, managed persistence off) whose recorded canonical
 * file is not among the files `gbrain sync --full` enumerates, so the next
 * full sync soft-deletes them. The usual cause is a page restored after its
 * file left the checkout (`git rm --cached`, an ignore rule, a deletion not
 * committed yet). Keeping such a page is the user's choice: put the file back
 * and sync, or keep it database-only with delete then `restore --detach`.
 * Read-only; at most `MISSING_FILES_SCAN_LIMIT` pages per source. Managed
 * sources are `ghost_pages`'s, on their owner host.
 */
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { scanMissingRecordedFiles, type MissingRecordedFiles } from '../../../core/persistence/detached-pages.ts';

const DOCS = 'docs/storage-tiering.md#restoring-a-page-whose-file-is-gone';

async function runMissingRecordedFiles(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const sourceIds = ctx.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const scans: MissingRecordedFiles[] = [];
    for (const sourceId of sourceIds) {
      const scan = await scanMissingRecordedFiles(engine, sourceId);
      if (scan) scans.push(scan);
    }
    const found = scans.filter(scan => scan.pages.length);
    const count = found.reduce((sum, scan) => sum + scan.pages.length, 0);
    const details = { count, sources: scans.map(scan => ({ source_id: scan.source_id, count: scan.pages.length, inspected: scan.inspected, truncated: scan.truncated,
      samples: scan.pages.slice(0, 5) })), docs: DOCS };
    if (!scans.length) {
      checks.push({ name: 'missing_recorded_files', status: 'ok', severity: 'info', readiness_state: 'not_applicable', details,
        message: 'Not applicable: no source is a classic checkout on this host (managed sources are checked by ghost_pages).' });
      return checks;
    }
    if (!count) {
      checks.push({ name: 'missing_recorded_files', status: 'ok', details,
        message: `Every live page's recorded file is in its checkout (${scans.reduce((sum, scan) => sum + scan.inspected, 0)} page(s) inspected${scans.some(scan => scan.truncated) ? '; bounded, more not checked' : ''}).` });
      return checks;
    }
    const first = found[0]!;
    const sample = first.pages[0]!;
    checks.push({ name: 'missing_recorded_files', status: 'warn', details,
      message: `${count} live page(s) record a canonical file that is not in their checkout, so the next gbrain sync --full soft-deletes them `
        + `(${found.map(scan => `${scan.source_id}: ${scan.pages.length}`).join('; ')}; e.g. ${found.flatMap(scan => scan.pages.slice(0, 3).map(page => `${scan.source_id}:${page.slug} (${page.source_path})`)).slice(0, 5).join(', ')}). `
        + 'A page restored after its file left the checkout is the usual cause. To keep one with its file, put the file back, commit it and run gbrain sync; '
        + `to keep it database-only, run gbrain delete ${sample.slug} --source-id ${first.source_id}, then gbrain restore ${sample.slug} --source-id ${first.source_id} --detach. A page whose file you removed on purpose needs nothing.`,
      fix: { consent: [], actor: 'agent', ask_user: true, requires_exclusive: false, docs: DOCS, verify: doctorVerify('missing_recorded_files'),
        why: 'Whether each page keeps its file, becomes database-only, or goes away with its file is the user\'s choice; nothing here runs on its own.',
        user_message: `${count} page(s) point at files that are no longer in your checkout (for example ${sample.slug}), so the next full sync will delete them. `
          + 'For each one: should I keep it without a file (database-only), will you put the file back, or should it go?' } });
  } catch (error) {
    checks.push(checkError('missing_recorded_files', 'check live pages for a recorded file missing from their checkout', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const missingRecordedFilesEntry: DoctorEntry = { name: 'missing_recorded_files', emits: ['missing_recorded_files'], run: runMissingRecordedFiles };
