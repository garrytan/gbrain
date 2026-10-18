/**
 * `gbrain sources set-calendar <source> <calendar-id> [--yes]` (#5012 item 9):
 * points a Google source's calendar sweep at another calendar
 * (`sources.config.g_calendar_id`; `primary` is the account's own). It is the
 * fix `calendar_unreadable` names: `gbrain google calendars` lists the ids
 * the account can read. The write is updateSourceConfig's single-key merge.
 *
 * The next sweep discards the old calendar's sync token and lists the new
 * calendar from a fresh window; pages already imported from the old calendar
 * stay. On a managed brain the connector cursor is keyed by the source's
 * configuration, so a source that also syncs Gmail or Contacts re-reads their
 * history on its next sync; that needs `--yes` (exit 3 without it).
 */
import type { BrainEngine } from '../core/engine.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { parseGoogleSourceConfig } from '../core/google/source-config.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';

const CALENDAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._%+#@-]{0,253}$/;

export async function runSetCalendar(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, calendarId] = args.filter((a) => !a.startsWith('--'));
  const usage = 'Usage: gbrain sources set-calendar <source> <calendar-id> [--yes]. List the calendar ids the account can read with: gbrain google calendars';
  if (!id || !calendarId) exitCliError(usageError('gbrain sources set-calendar needs a source id and a calendar id.', usage), 'sources');
  if (!CALENDAR_ID_RE.test(calendarId!)) exitCliError(usageError(`"${calendarId}" is not a Google calendar id.`, usage), 'sources');
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1 AND archived IS NOT TRUE', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src!.config);
  if (config.kind !== 'google') {
    exitCliError(usageError(`Source "${id}" is not a Google source; only a Google source has a calendar.`, 'List sources and their kind with: gbrain sources list'), 'sources');
  }
  const google = parseGoogleSourceConfig(config, '');
  if (google.calendarId === calendarId) {
    console.log(`Source "${id}" already syncs calendar ${calendarId}.`);
    return;
  }
  const others = google.services.filter((s) => s !== 'calendar');
  if (others.length > 0 && !args.includes('--yes') && await readManagedMode(engine)) {
    exitCliError(opError('confirmation_required', `Changing the calendar of "${id}" makes its next sync re-read ${others.join(' and ')} history from the start.`,
      `On this managed brain the source's sync cursor is keyed by its configuration, so the change starts a fresh cursor for every service the source syncs (${google.services.join(', ')}); pages already imported stay. With the user's agreement, run gbrain sources set-calendar ${id} ${calendarId} --yes.`, {
        fix: { argv: ['gbrain', 'sources', 'set-calendar', id!, calendarId!, '--yes'], consent: [], actor: 'agent', why: 'Points the source at the new calendar after the user agrees to the re-read.', requires_exclusive: false,
          ask_user: true, user_message: `Point ${id} at calendar ${calendarId}? Its next sync re-reads ${others.join(' and ')} history (no cost; already imported pages stay).` },
      }), 'sources');
  }
  await engine.updateSourceConfig(id!, { g_calendar_id: calendarId });
  console.log(`Source "${id}" now syncs calendar ${calendarId} (was ${google.calendarId}).`);
  console.log(`  The next sync lists it from a fresh window; pages from the old calendar stay. Run it now: gbrain sync --source ${id}`);
}
