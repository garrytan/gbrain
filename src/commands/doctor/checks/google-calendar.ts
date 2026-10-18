import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readConnectorCursorState, type ConnectorSourceRow } from '../../../core/connectors/item-holds-store.ts';
import { parseGoogleSourceConfig } from '../../../core/google/source-config.ts';
import type { CalendarUnreadable } from '../../../core/google/types.ts';
import { calendarUnreadableFix } from '../../google-calendar-status.ts';
import { agentFix } from '../check-fix.ts';

/**
 * #5012 item 9: Google sources whose last calendar sweep could not read the
 * configured calendar (403/404 recorded as `calendar_unreadable` in connector
 * state). Zero-network: it reads the stored result only; `gbrain google
 * status` probes the calendar live. Without it an unreadable calendar looks
 * exactly like an empty one.
 */
export async function googleCalendarReadableCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const rows = await engine.executeRaw<ConnectorSourceRow>(
      "SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' = 'google' ORDER BY id");
    const unreadable = [];
    for (const row of rows) {
      if (sourceIds && !sourceIds.includes(row.id)) continue;
      const cfg = parseGoogleSourceConfig(row.config, '');
      if (!cfg.services.includes('calendar')) continue;
      const stored = (await readConnectorCursorState(engine, row))?.calendar_unreadable as CalendarUnreadable | null | undefined;
      if (!stored || stored.calendar_id !== cfg.calendarId) continue;
      unreadable.push({ source_id: row.id, account: cfg.account, calendar_id: cfg.calendarId, http_status: stored.http_status, at: stored.at,
        ...calendarUnreadableFix(cfg.account, row.id) });
    }
    const details = { code: unreadable.length ? 'calendar_unreadable' : undefined, count: unreadable.length, sources: unreadable,
      docs: 'docs/guides/google-connect.md#unreadable-calendar' };
    if (!unreadable.length) return { name: 'google_calendar_readable', status: 'ok', message: 'No Google source recorded an unreadable calendar at its last sync.', details };
    const first = unreadable[0]!;
    return {
      name: 'google_calendar_readable', status: 'warn', details,
      message: unreadable.map((u) => `Google source ${u.source_id}: ${u.account} cannot read calendar "${u.calendar_id}" (HTTP ${u.http_status} at the last sync), `
        + `so it imports no events. List the readable calendars with ${u.list_command}, then run ${u.set_command}.`).join(' '),
      fix: agentFix(['gbrain', 'google', 'calendars', '--account', first.account, '--json'],
        'Read-only: lists the calendar ids this account can read; pick one and point the source at it with gbrain sources set-calendar.',
        'google_calendar_readable', { docs: 'docs/guides/google-connect.md#unreadable-calendar' }),
    };
  } catch (error) {
    return { name: 'google_calendar_readable', status: 'warn', fix_unavailable_reason: 'check_errored', details: { count: 'unknown' },
      message: `Google calendar readability could not be read from source state: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
