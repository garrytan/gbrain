/**
 * #5012 item 9: calendar readability per linked Google source, for
 * `gbrain google status`. With a probe (the default) each source that syncs
 * Calendar gets one live `events.list` read of its configured calendar; with
 * `--no-probe` the result its last sweep recorded (`calendar_unreadable` in
 * connector state) is reported instead. A 403 or 404 is `calendar_unreadable`
 * with the commands that list readable calendars and change the source's
 * calendar id.
 */
import type { BrainEngine } from '../core/engine.ts';
import { readConnectorCursorState, type ConnectorSourceRow } from '../core/connectors/item-holds-store.ts';
import { parseGoogleSourceConfig } from '../core/google/source-config.ts';
import type { CalendarUnreadable } from '../core/google/types.ts';

export interface CalendarReadability {
  calendar_id: string;
  readable: boolean | null;
  checked: 'live' | 'last_sync';
  code?: 'calendar_unreadable';
  http_status?: 403 | 404;
  error?: string;
  fix?: { list_command: string; set_command: string };
}

export type CalendarProbe = (account: string, calendarId: string) => Promise<{ readable: true } | { readable: false; httpStatus: 403 | 404 }>;

export function calendarUnreadableFix(account: string, sourceId: string): { list_command: string; set_command: string } {
  return { list_command: `gbrain google calendars --account ${account}`, set_command: `gbrain sources set-calendar ${sourceId} <calendar-id>` };
}

/** Readability of one source's calendar, or null when the source does not sync Calendar. */
export async function sourceCalendarReadability(engine: BrainEngine, source: ConnectorSourceRow, probe: CalendarProbe | null): Promise<CalendarReadability | null> {
  const cfg = parseGoogleSourceConfig(source.config, '');
  if (!cfg.services.includes('calendar')) return null;
  const unreadable = (httpStatus: 403 | 404, checked: CalendarReadability['checked']): CalendarReadability => ({
    calendar_id: cfg.calendarId, readable: false, checked, code: 'calendar_unreadable', http_status: httpStatus, fix: calendarUnreadableFix(cfg.account, source.id) });
  if (probe) {
    try {
      const result = await probe(cfg.account, cfg.calendarId);
      return result.readable ? { calendar_id: cfg.calendarId, readable: true, checked: 'live' } : unreadable(result.httpStatus, 'live');
    } catch (e) {
      return { calendar_id: cfg.calendarId, readable: null, checked: 'live', error: e instanceof Error ? e.message : String(e) };
    }
  }
  const stored = (await readConnectorCursorState(engine, source))?.calendar_unreadable as CalendarUnreadable | null | undefined;
  if (stored && stored.calendar_id === cfg.calendarId) return unreadable(stored.http_status, 'last_sync');
  return { calendar_id: cfg.calendarId, readable: stored === null ? true : null, checked: 'last_sync' };
}
