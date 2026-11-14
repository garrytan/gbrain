/**
 * #6741 C: doctor `purge_parked_pages`. The managed purge parks a soft-deleted
 * page after PURGE_PARK_LIMIT failed hard-deletes (purge-parks.ts), so the
 * purge phase stops taking a new permanent request id for it on every pass.
 * This check names each parked page with its last error; the fix is one more
 * attempt through the gated manual purge (`--retry-parked`), previewed first.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { isParked, PURGE_PARK_LIMIT, readPurgeParks } from '../../../core/persistence/purge-parks.ts';
import { readDerivedOriginParks } from '../../../core/persistence/derived-origin-hold.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'purge_parked_pages';
const SAMPLE = 20;

export async function checkPurgeParkedPages(engine: BrainEngine): Promise<Check> {
  let parked;
  try {
    parked = [...(await readPurgeParks(engine)).values()].filter(isParked);
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

/**
 * GST-2689: doctor `derived_origin_parked`. A soft-deleted page that is the only privacy of a page derived from it is kept
 * from every purge while that page could not be labelled private (persistence/derived-origin-hold.ts). Each is named
 * with the page that blocks it and the reason; the fix previews the label on the first blocking page.
 */
const ORIGIN_NAME = 'derived_origin_parked';

export async function checkDerivedOriginParked(engine: BrainEngine): Promise<Check> {
  let parks;
  try {
    parks = await readDerivedOriginParks(engine);
  } catch (error) {
    return checkError(ORIGIN_NAME, 'read the parked derived-page origins', error);
  }
  if (!parks.length) return { name: ORIGIN_NAME, status: 'ok', message: 'No soft-deleted page is kept from the purge to keep a page derived from it private.', details: { parked: 0, origins: [] } };
  const origins = parks.slice(0, SAMPLE).map(park => ({ source_id: park.source_id, slug: park.slug, blocking_slug: park.blocking_slug, code: park.code, reason: park.reason, parked_at: park.parked_at }));
  const listed = origins.map(origin => `${origin.source_id}/${origin.slug} (blocked by ${origin.blocking_slug ?? 'a derived page that could not be read'}: ${origin.code ?? 'error'}: ${origin.reason})`).join(', ');
  const first = origins.find(origin => origin.blocking_slug);
  return {
    name: ORIGIN_NAME, status: 'warn', details: { parked: parks.length, truncated: parks.length > origins.length, origins },
    message: `${parks.length} soft-deleted page(s) are kept from the purge, because a page derived from each reads as private only through it and could not be labelled private: ${listed}`
      + `${parks.length > origins.length ? ` (first ${origins.length} of ${parks.length} shown)` : ''}. Fix the cause each reason names, or give the blocking page its own visibility label; the next purge labels the rest and frees the origin, and the purge after removes it (a consented gbrain pages purge-deleted does both).`,
    ...(first ? { fix: agentFix(['gbrain', 'repair', 'visibility', '--source', first.source_id, '--slug', first.blocking_slug!],
      'Previews giving the blocking page its own visibility label; nothing is written.', ORIGIN_NAME) } : {}),
  };
}

async function runDerivedOriginParked(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkDerivedOriginParked(connectedEngine(ctx)));
  return checks;
}

export const derivedOriginParkedEntry: DoctorEntry = { name: 'derived_origin_parked', emits: ['derived_origin_parked'], run: runDerivedOriginParked };
