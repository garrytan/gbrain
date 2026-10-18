/**
 * #6865 `unindexed_files`: committed files of a managed Git source with no
 * page and no hold, so they are absent from search and nothing else reports
 * them (typically files an older gbrain refused before refusals became holds).
 * The check never scans: it reads the result the maintenance phase
 * `unindexed_files` or `gbrain sources retry-held <id> --unindexed` stored
 * (`judgeUnindexedFiles`), plus the re-screen schedule and, for scheduled
 * paths a sync already re-screened, whether each now has a page or a hold.
 *
 * ok when every source's result is complete, recent and nothing is missing;
 * warn when files are unindexed (fix: `retry-held --unindexed`, then the
 * follow-up sync) or scheduled and waiting for that sync (fix: the sync); info
 * when a source has no result, a stale one (older than 7 days) or an
 * incomplete one that found nothing so far. Files sync skips on purpose as
 * folder scaffolding (`index.md` and the other metafile names) that carry a
 * frontmatter `type:` or `title:` are named separately (`metafile_skipped`):
 * renaming one is the user's call, so they never make the check warn and are
 * the info finding only when nothing else is.
 */
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { agentFix, checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { managedPersistenceEnabled } from '../../../core/persistence/ownership.ts';
import { judgeUnindexedFiles, type UnindexedState } from '../../../core/persistence/unindexed-files.ts';
import { gitFollowUpSync } from '../../sources-retry-held.ts';

const DOCS = 'docs/guides/repair.md#unindexed-files';

const hours = (ms: number | null) => ms === null ? null : Math.round(ms / 3_600_000);

/** Scheduling the source's unindexed files, then the sync that re-screens them, then this check. */
async function scheduleFix(ctx: DoctorContext, sourceId: string, why: string): Promise<Action> {
  const sync = await gitFollowUpSync(connectedEngine(ctx), sourceId, []);
  return agentFix(['gbrain', 'sources', 'retry-held', sourceId, '--unindexed'], why, 'unindexed_files', { docs: DOCS,
    then: { argv: sync, consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify('unindexed_files'), docs: DOCS,
      why: `The sync re-screens the scheduled files of ${sourceId}: each one that passes imports, each one that refuses is recorded as a hold that gbrain sources status ${sourceId} lists.` } });
}

/** One source's finding as a line: how many are missing or waiting, what the stored pass found, and the first paths. */
function sourceLine(state: UnindexedState): string {
  const record = state.record!;
  const codes = Object.entries(record.by_code).map(([code, n]) => `${code} ${n}`).join(', ');
  const found = `found ${record.unindexed} in ${record.scanned} file(s)${codes ? `: ${codes}` : ''}${record.slug_taken ? `; ${record.slug_taken} share a slug with another page` : ''}`;
  const samples = record.samples.slice(0, 5).map(sample => `${sample.path} [${sample.code}]`).join(', ');
  return `${state.source_id}: ${state.unscheduled + state.still_unindexed} unindexed, ${state.waiting} scheduled and waiting for a sync (${found}${record.complete ? '' : '; the scan is incomplete'}, `
    + `${hours(state.age_ms)} h ago${samples ? `; e.g. ${samples}` : ''})`;
}

/** The read-only note on files a re-screen cannot import (slug collisions, deleted pages), or '' when there are none. */
function blockedNote(states: UnindexedState[]): string {
  const found = states.filter(state => state.state !== 'missing' && state.blocked);
  if (!found.length) return '';
  const samples = found.flatMap(state => state.record!.samples.filter(sample => sample.slug_taken || sample.deleted_page).slice(0, 3)
    .map(sample => `${state.source_id}:${sample.path} (${sample.slug_taken ? 'its slug belongs to another page' : 'its page was deleted'})`)).slice(0, 5).join(', ');
  return `${found.reduce((n, state) => n + state.blocked, 0)} committed file(s) cannot be imported as they are${samples ? ` (e.g. ${samples})` : ''}: `
    + 'rename one of two files that share a slug, or delete the file of a deleted page (or restore the page with gbrain restore), commit, then sync.';
}

/** The read-only note on scaffolding-named files sync skips on purpose, or '' when there are none. */
function metafileNote(states: UnindexedState[]): string {
  const found = states.filter(state => state.state !== 'missing' && state.record?.metafile_skipped);
  if (!found.length) return '';
  const count = found.reduce((n, state) => n + state.record!.metafile_skipped, 0);
  const samples = found.flatMap(state => state.record!.metafile_samples.slice(0, 3).map(path => `${state.source_id}:${path}`)).slice(0, 5).join(', ');
  return `${count} file(s) with a frontmatter type: or title: are named like folder scaffolding (index.md, README.md, schema.md, log.md, RESOLVER.md), which sync skips on purpose (e.g. ${samples}). `
    + 'To index one, rename it (for example investors/fund-a/index.md -> investors/fund-a.md), commit, then sync.';
}

async function runUnindexedFiles(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    if (!(await managedPersistenceEnabled(engine))) {
      checks.push(infoCheck('unindexed_files', 'Not applicable: managed persistence is off, so no managed Git source is checked for unindexed files.', 'not_applicable', undefined, { docs: DOCS }));
      return checks;
    }
    const sources = await engine.executeRaw<{ id: string; incarnation: string }>(`SELECT s.id, s.incarnation::text AS incarnation FROM sources s
      WHERE s.archived IS NOT TRUE AND (s.config->>'kind') IS NULL AND s.config->'company_brain' IS NULL
        AND EXISTS (SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation)
        AND ($1::text[] IS NULL OR s.id=ANY($1::text[])) ORDER BY s.id`, [doctorSourceIds(ctx) ?? null]);
    if (!sources.length) {
      checks.push(infoCheck('unindexed_files', 'Not applicable: no managed Git source is bound to a checkout.', 'not_applicable', undefined, { docs: DOCS }));
      return checks;
    }
    const states = await judgeUnindexedFiles(engine, sources);
    const details = { docs: DOCS, sources: states.map(({ source_id, state, record, ...rest }) => !record || state === 'missing' ? { source_id, state }
      : { source_id, state, unscheduled: rest.unscheduled, waiting: rest.waiting, still_unindexed: rest.still_unindexed, age_hours: hours(rest.age_ms), complete: record.complete,
        scanned: record.scanned, unindexed: record.unindexed, slug_taken: record.slug_taken, deleted_page: record.deleted_page ?? 0, by_code: record.by_code, samples: record.samples, target: record.target, computed_at: record.computed_at,
        metafile_skipped: record.metafile_skipped ?? 0, metafile_samples: record.metafile_samples ?? [] }) };
    const scaffolding = [blockedNote(states), metafileNote(states)].filter(Boolean).join(' ');
    const unindexed = states.filter(state => state.state === 'unindexed');
    const waiting = states.filter(state => state.state === 'scheduled');
    if (unindexed.length || waiting.length) {
      const first = unindexed[0] ?? waiting[0]!;
      const fix = unindexed.length
        ? await scheduleFix(ctx, first.source_id, `Schedules the unindexed files of ${first.source_id} for a re-screen on its next sync and refreshes this check's stored result; nothing is imported or edited now.`)
        : agentFix(await gitFollowUpSync(engine, first.source_id, []), `The sync re-screens the ${first.waiting} scheduled file(s) of ${first.source_id}: each one that passes imports and each one that refuses is recorded as a hold.`,
          'unindexed_files', { docs: DOCS });
      checks.push({ name: 'unindexed_files', status: 'warn', details, fix,
        message: `Committed files in managed Git sources have no page and no hold, so they are missing from search: ${[...unindexed, ...waiting].map(sourceLine).join('; ')}. `
          + 'Usually an older gbrain refused them before refusals became holds. Schedule them with gbrain sources retry-held <id> --unindexed, then run the sync it prints: '
          + 'each file then imports or is held with its reason.'
          + (scaffolding ? ` ${scaffolding}` : '') });
      return checks;
    }
    const unknown = states.filter(state => state.state !== 'ok');
    if (unknown.length) {
      const first = unknown[0]!;
      const why = (state: UnindexedState) => state.state === 'missing' ? 'not computed yet' : state.state === 'stale' ? `computed ${hours(state.age_ms)} h ago, older than 7 days`
        : `incomplete: ${state.record!.scanned} file(s) checked so far, none missing`;
      checks.push(infoCheck('unindexed_files', `Unindexed files are not known for ${unknown.map(state => `${state.source_id} (${why(state)})`).join(', ')}. `
        + 'The maintenance phase unindexed_files computes them on each run and continues an incomplete scan; to compute them now, run gbrain sources retry-held <id> --unindexed.'
        + (scaffolding ? ` ${scaffolding}` : ''),
        'unknown', await scheduleFix(ctx, first.source_id, `Finds the committed files of ${first.source_id} with no page and no hold (bounded; it continues an incomplete scan), schedules them for a re-screen and stores the result this check reads.`), details));
      return checks;
    }
    if (scaffolding) {
      const first = states.find(state => state.record?.metafile_skipped || state.blocked)!;
      const metafile = first.record!.metafile_skipped ? first.record!.metafile_samples[0] : undefined;
      checks.push(infoCheck('unindexed_files', `Every other committed file of ${states.length} managed Git source(s) is indexed, held or excluded. ${scaffolding}`, 'degraded', {
        argv: await gitFollowUpSync(engine, first.source_id, []), consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify('unindexed_files'), docs: DOCS,
        why: metafile ? 'Sync skips index.md and the other scaffolding names on purpose; a file renamed to an ordinary name is imported by the next sync.'
          : 'A re-screen cannot import these files as they are; after the rename, delete or restore is committed, the next sync settles them.',
        user_message: metafile ? `Sync skips files named index.md (and README.md, schema.md, log.md, RESOLVER.md) on purpose, as folder scaffolding, so ${metafile} is not in search. `
          + 'To index such a file, rename it, for example investors/fund-a/index.md -> investors/fund-a.md, commit, then run this sync.' : blockedNote([first]) }, details));
      return checks;
    }
    checks.push({ name: 'unindexed_files', status: 'ok', details,
      message: `Every committed file of ${states.length} managed Git source(s) is indexed, held or excluded (${states.reduce((n, state) => n + (state.record?.scanned ?? 0), 0)} file(s) checked).` });
  } catch (error) {
    checks.push(checkError('unindexed_files', 'read the stored unindexed-file results', error, { details: { docs: DOCS } }));
  }
  return checks;
}

export const unindexedFilesEntry: DoctorEntry = { name: 'unindexed_files', emits: ['unindexed_files'], run: runUnindexedFiles };
