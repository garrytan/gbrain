/**
 * transcript_archive_freshness doctor check (GST-2768 PR 3): is the conversation archive keeping up?
 *
 * Off (switched off, or a shared brain that is only offered it) is one quiet ok row and reads no session. On, it
 * reads archiveStatus (the readers this machine has and the archive ledger) and the maintenance record
 * (transcripts.archive.last_maintenance), and warns when:
 *   - a harness's newest archived day is more than transcripts.archive.stale_days (default 2) behind the newest
 *     session day its reader sees: fix gbrain transcripts archive run, or backfill --from <first missing day> when
 *     that day is older than one run's window;
 *   - no maintenance pass has run the archive in stale_days (or ever, on a brain older than that): fix
 *     gbrain autopilot --install (persistent, so ask the user first);
 *   - days are held (listed with their codes), a reader failed, or the last pass recorded an error.
 * A harness with no readable sessions is informational.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Action } from '../../../core/agent-output.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { resolveArchiveEnabled } from '../../../core/transcripts/archive-default.ts';
import {
  ARCHIVE_STALE_DAYS_KEY, DEFAULT_ARCHIVE_STALE_DAYS, readArchiveMaintenance,
} from '../../../core/transcripts/archive-maintenance.ts';
import { addDays, localDay } from '../../../core/transcripts/archive-day.ts';

const name = 'transcript_archive_freshness';
const DAY_MS = 86_400_000;

const dayMs = (day: string) => Date.parse(day + 'T00:00:00.000Z');

export async function checkTranscriptArchiveFreshness(
  engine: BrainEngine,
  opts: { readers?: import('../../../core/transcripts/archive.ts').ArchiveReader[]; nowMs?: number } = {},
): Promise<Check> {
  try {
    const { loadConfig } = await import('../../../core/config.ts');
    const enablement = await resolveArchiveEnabled(engine, { config: (() => { try { return loadConfig(); } catch { return null; } })() });
    if (!enablement.enabled) {
      return { name, status: 'ok', message: 'The conversation archive is off (' + enablement.reason + ').', details: { enabled: false, source: enablement.source, offered: enablement.offered } };
    }
    const archive = await import('../../../core/transcripts/archive.ts');
    const nowMs = opts.nowMs ?? Date.now();
    const staleRaw = Number((await engine.getConfig(ARCHIVE_STALE_DAYS_KEY))?.trim());
    const staleDays = Number.isFinite(staleRaw) && staleRaw > 0 ? staleRaw : DEFAULT_ARCHIVE_STALE_DAYS;
    const windowRaw = Number((await engine.getConfig('transcripts.archive.run_window_days'))?.trim());
    const runWindow = Number.isSafeInteger(windowRaw) && windowRaw > 0 ? windowRaw : archive.DEFAULT_RUN_WINDOW_DAYS;
    const status = await archive.archiveStatus(engine, opts.readers ? { readers: opts.readers } : {});
    const today = localDay(new Date(nowMs).toISOString(), status.timezone ?? status.configured_timezone);
    const problems: string[] = [];
    let fix: Action | undefined;
    const behind: Array<{ harness: string; newest_session_day: string; newest_archived_day: string | null; days_behind: number }> = [];
    for (const h of status.harnesses) {
      if (h.info) continue;
      if (!h.newest_session_day) continue;
      const gap = h.newest_archived_day ? Math.round((dayMs(h.newest_session_day) - dayMs(h.newest_archived_day)) / DAY_MS) : Infinity;
      if (gap <= staleDays) continue;
      behind.push({ harness: h.harness, newest_session_day: h.newest_session_day, newest_archived_day: h.newest_archived_day, days_behind: Number.isFinite(gap) ? gap : -1 });
      problems.push(h.harness + ': the newest archived day (' + (h.newest_archived_day ?? 'none') + ') is ' + (Number.isFinite(gap) ? gap + ' day(s) behind' : 'missing; sessions run to') + ' the newest session day ' + h.newest_session_day);
      const firstMissing = h.newest_archived_day ? addDays(h.newest_archived_day, 1) : addDays(h.newest_session_day, -30);
      if (!fix) {
        fix = firstMissing < addDays(today, -runWindow)
          ? agentFix(['gbrain', 'transcripts', 'archive', 'backfill', '--from', firstMissing],
            'Archives the missing days from ' + firstMissing + ', newest first, one capped run at a time (transcripts.archive.backfill_days_per_run); their embedding is held until the owner approves its cost (gbrain embed --held --dry-run).', name)
          : agentFix(['gbrain', 'transcripts', 'archive', 'run'], 'Archives the last ' + (runWindow + 1) + ' local days from every readable harness now.', name);
      }
    }
    if (status.rescope) problems.push(status.rescope.message.replace(/\.$/, ''));
    for (const e of status.errors) problems.push(e.reader + ' could not be read (' + e.code + '): ' + e.message.slice(0, 200));
    if (status.held.length) problems.push(status.held.length + ' day(s) held: ' + status.held.slice(0, 10).map(h => h.harness + ' ' + h.day + ' (' + h.code + ')').join(', ') + (status.held.length > 10 ? ', ...' : ''));
    const record = await readArchiveMaintenance(engine);
    if (record?.errors.length) problems.push('the last maintenance pass (' + record.at + ', ' + record.runner + ') recorded ' + record.errors.map(e => e.code).filter((c, i, a) => a.indexOf(c) === i).join(', ') + ': ' + record.errors[0]!.message.slice(0, 200));
    else if (record?.status === 'skipped' && record.code) problems.push('the last maintenance pass skipped the archive (' + record.code + '): ' + (record.message ?? ''));
    let staleSince: number | null = record ? Date.parse(record.at) : null;
    if (staleSince === null) {
      const [oldest] = await engine.executeRaw<{ created_at: string | Date | null }>('SELECT min(created_at) AS created_at FROM sources');
      staleSince = oldest?.created_at ? new Date(oldest.created_at).getTime() : null;
    }
    const passStale = staleSince !== null && nowMs - staleSince > staleDays * DAY_MS;
    if (passStale) {
      problems.push('no maintenance pass has run the archive in ' + staleDays + ' day(s)' + (record ? ' (last ' + record.at + ', ' + record.runner + ')' : ''));
      fix ??= agentFix(['gbrain', 'autopilot', '--install'],
        'Installs the background maintenance daemon, which runs the conversation archive with the rest of upkeep; a persistent install, so ask the user first. Without it the archive runs while an agent\'s gbrain serve is idle.',
        name, { consent: ['persistent_install'] });
    }
    const details = {
      enabled: true, source_id: status.source_id, stale_days: staleDays, behind, held: status.held,
      harnesses: status.harnesses.map(h => ({ harness: h.harness, reader: h.reader, readable: !h.info, newest_session_day: h.newest_session_day, newest_archived_day: h.newest_archived_day })),
      ...(record ? { last_maintenance: record } : {}), docs: 'docs/guides/conversation-archive.md#doctor',
    };
    if (problems.length) return { name, status: 'warn', message: 'Conversation archive: ' + problems.join('; ') + '.', details, ...(fix ? { fix } : {}) };
    const readable = status.harnesses.filter(h => !h.info && h.newest_session_day);
    const idle = [...new Set(status.harnesses.filter(h => h.info).map(h => h.harness))];
    const idleNote = idle.length ? 'no readable sessions for ' + idle.join(', ') + ' (gbrain transcripts archive status names each reader)' : '';
    if (!readable.length) return infoCheck(name, 'Conversation archive is on; ' + (idleNote || 'no harness has readable sessions yet') + '.', 'not_applicable', undefined, details);
    return { name, status: 'ok', message: 'Conversation archive is up to date (' + readable.map(h => h.harness + ' ' + h.newest_archived_day).join(', ') + ')' + (idleNote ? '; ' + idleNote : '') + '.', details };
  } catch (error) {
    return checkError(name, 'read the conversation archive', error);
  }
}

async function runTranscriptArchive(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkTranscriptArchiveFreshness(connectedEngine(ctx)));
  return checks;
}

export const transcriptArchiveEntry: DoctorEntry = {
  name: 'transcript_archive_freshness',
  emits: ['transcript_archive_freshness'],
  run: runTranscriptArchive,
};
