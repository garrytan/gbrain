/**
 * revision_backfill (#5216): pages written before page revisions existed wait
 * for the resumable `pages.knowledge_revision` backfill; until a page has its
 * revision, a write that names one is refused with `revision_backfill_pending`.
 * ok when the column is NOT NULL (backfill finished, or a fresh install).
 * Otherwise warns with the pending count and the command that resumes the
 * pass; failed rows are named with their page, attempt count and error, and
 * rows whose attempts are spent point at the torn-page preview instead, since
 * the resume command no longer retries them. Read-only.
 */
import {
  readRevisionBackfillStatus,
  REVISION_BACKFILL_MAX_ATTEMPTS,
  REVISION_BACKFILL_RESUME_COMMAND,
} from '../../../core/page-state/revision-backfill-schema.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/write-refusals.md#revision-backfill';
const LISTED = 5;

async function runRevisionBackfill(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const status = await readRevisionBackfillStatus(engine);
    if (status.column !== 'nullable') {
      checks.push({ name: 'revision_backfill', status: 'ok', details: { column: status.column, pending: 0, failed: [] },
        message: status.column === 'not_null' ? 'Every page has its revision; the page revision backfill is complete.'
          : 'This schema predates page revisions; the backfill starts with the migration that adds them.' });
      return checks;
    }
    const spent = status.failed.filter(f => f.attempts >= REVISION_BACKFILL_MAX_ATTEMPTS);
    const resumable = status.pending - spent.length;
    const details = { column: status.column, pending: status.pending, resumable, failed: status.failed,
      resume_command: REVISION_BACKFILL_RESUME_COMMAND, docs: DOCS };
    const listed = (rows: typeof status.failed) => rows.slice(0, LISTED)
      .map(f => `page id ${f.id} (${f.source_id}:${f.slug}, attempt ${f.attempts} of ${REVISION_BACKFILL_MAX_ATTEMPTS}: ${f.error})`).join('; ')
      + (rows.length > LISTED ? `; +${rows.length - LISTED} more` : '');
    const parts = [
      status.pending === 0
        ? 'Every page has a revision, but the page revision backfill has not finished making the column NOT NULL.'
        : `${status.pending} page(s) still have no revision; the page revision backfill is incomplete, and a write that names their revision is refused with revision_backfill_pending.`,
      ...(status.failed.length ? [`${status.failed.length} row(s) failed: ${listed(status.failed)}.`] : []),
      ...(spent.length ? [`${spent.length} of them used all ${REVISION_BACKFILL_MAX_ATTEMPTS} attempts, so resuming no longer retries them; `
        + 'the usual cause is a torn page body. Preview with foresights repair orphan-children (torn_pages lists them) and recover those pages from a backup or a re-sync.'] : []),
      ...(resumable > 0 || status.pending === 0 ? [`Resume the backfill on the brain host: ${REVISION_BACKFILL_RESUME_COMMAND} (it prints its progress).`] : []),
    ];
    const fix = resumable > 0 || status.pending === 0
      ? agentFix(REVISION_BACKFILL_RESUME_COMMAND.split(' '),
        'Re-runs the schema migration pass on the brain host, which resumes the page revision backfill and prints its progress; it changes no page content.',
        'revision_backfill', { requires_exclusive: true, docs: DOCS })
      : agentFix(['gbrain', 'repair', 'orphan-children'],
        'Previews orphaned child rows and lists torn page bodies (torn_pages) without changing anything.', 'revision_backfill',
        { docs: 'docs/guides/repair.md#orphan-children' });
    checks.push({ name: 'revision_backfill', status: 'warn', message: parts.join(' '), fix, details });
  } catch (err) {
    checks.push(checkError('revision_backfill', 'read the page revision backfill state', err));
  }
  return checks;
}

export const revisionBackfillEntry: DoctorEntry = { name: 'revision_backfill', emits: ['revision_backfill'], run: runRevisionBackfill };
