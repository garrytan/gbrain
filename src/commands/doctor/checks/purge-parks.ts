/**
 * #6741 C: doctor `purge_parked_pages`. The managed purge parks a soft-deleted
 * page after PURGE_PARK_LIMIT failed hard-deletes (purge-parks.ts), so the
 * purge phase stops taking a new permanent request id for it on every pass.
 * This check names each parked page with its last error; the fix is one more
 * attempt through the gated manual purge (`--retry-parked`), previewed first.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { PURGE_PARK_LIMIT, readPurgeParks } from '../../../core/persistence/purge-parks.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'purge_parked_pages';
const SAMPLE = 20;

export async function checkPurgeParkedPages(engine: BrainEngine): Promise<Check> {
  let parked;
  try {
    parked = [...(await readPurgeParks(engine)).values()].filter(park => park.failures >= PURGE_PARK_LIMIT);
  } catch (error) {
    return checkError(NAME, 'read the parked page purges', error);
  }
  if (!parked.length) return { name: NAME, status: 'ok', message: 'No soft-deleted page is parked by the managed purge.', details: { parked: 0 } };
  const pages = parked.slice(0, SAMPLE).map(park => ({ source_id: park.source_id, slug: park.slug, failures: park.failures, code: park.code, reason: park.reason }));
  const listed = pages.map(page => `${page.source_id}/${page.slug} (${page.code ?? 'error'})`).join(', ');
  return {
    name: NAME, status: 'warn', details: { parked: parked.length, truncated: parked.length > pages.length, pages },
    message: `${parked.length} soft-deleted page(s) are parked after ${PURGE_PARK_LIMIT} failed purges each, so the purge phase no longer resubmits them: ${listed}`
      + `${parked.length > pages.length ? ` (first ${pages.length} of ${parked.length} shown)` : ''}. Fix the cause the last error names, then retry each once.`,
    fix: { argv: ['gbrain', 'pages', 'purge-deleted', '--retry-parked', '--yes'], preview_argv: ['gbrain', 'pages', 'purge-deleted', '--retry-parked', '--dry-run', '--json'],
      consent: ['destructive'], actor: 'agent', ask_user: true, requires_exclusive: false, verify: doctorVerify(NAME),
      why: 'Purges every expired soft-deleted page and tries each parked one once more; a page that fails again stays parked.',
      user_message: `Permanently purge the expired soft-deleted pages, retrying the ${parked.length} parked one(s) once? Purged pages cannot be restored.` },
  };
}

async function runPurgeParkedPages(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkPurgeParkedPages(connectedEngine(ctx)));
  return checks;
}

export const purgeParkedPagesEntry: DoctorEntry = { name: 'purge_parked_pages', emits: ['purge_parked_pages'], run: runPurgeParkedPages };
