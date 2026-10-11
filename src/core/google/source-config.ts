/** Parse a Google connector source's `sources.config`. Dependency-light so migrations and the connector identity can import it. */
import { ALL_GOOGLE_SERVICES, DEFAULT_CALENDAR_ID, DEFAULT_CONTACTS_DIR, type GoogleService, type GoogleSourceConfig } from './types.ts';
import { CALENDAR_FUTURE_DAYS_MAX } from './calendar-window.ts';
import { parseExcludeLabelTokens } from './loops-exclusion.ts';

export function parseGoogleSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): GoogleSourceConfig {
  const account =
    typeof config.g_account === 'string' ? config.g_account.trim().toLowerCase() : '';
  const services =
    typeof config.g_services === 'string'
      ? (config.g_services
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s): s is GoogleService => (ALL_GOOGLE_SERVICES as string[]).includes(s)))
      : [...ALL_GOOGLE_SERVICES];
  const historyDays =
    typeof config.g_history_days === 'number' &&
    Number.isFinite(config.g_history_days) &&
    config.g_history_days > 0
      ? Math.min(3650, Math.floor(config.g_history_days))
      : 90;
  const futureDays =
    typeof config.g_future_days === 'number' &&
    Number.isFinite(config.g_future_days) &&
    config.g_future_days >= 1 &&
    config.g_future_days <= CALENDAR_FUTURE_DAYS_MAX
      ? Math.floor(config.g_future_days)
      : undefined;
  const loopsExcludeLabels = parseExcludeLabelTokens(config.g_loops_exclude_labels);
  const calendarId =
    typeof config.g_calendar_id === 'string' && config.g_calendar_id.trim().length > 0
      ? config.g_calendar_id.trim()
      : DEFAULT_CALENDAR_ID;
  const contactsDir = parseContactsDir(config.g_contacts_dir) ?? DEFAULT_CONTACTS_DIR;
  const dir =
    typeof config.g_dir === 'string' && config.g_dir.length > 0 ? config.g_dir : fallbackDir;
  const access =
    config.g_access === 'command' || config.g_access === 'env' ? config.g_access : 'vault';
  return {
    account,
    services: services.length > 0 ? services : [...ALL_GOOGLE_SERVICES],
    historyDays,
    ...(futureDays !== undefined ? { futureDays } : {}),
    ...(loopsExcludeLabels.length > 0 ? { loopsExcludeLabels } : {}),
    calendarId,
    contactsDir,
    dir,
    access,
    ...(typeof config.g_token_command === 'string' && config.g_token_command.trim()
      ? { tokenCommand: config.g_token_command }
      : {}),
    ...(typeof config.g_token_env === 'string' && config.g_token_env.trim()
      ? { tokenEnv: config.g_token_env }
      : {}),
  };
}

/**
 * A contacts directory as the user wrote it, normalized (`/contacts/` →
 * `contacts`), or null when it is not a safe relative path: one or more
 * lower-case segments of `[a-z0-9_-]`, no dot segments, nothing hidden.
 */
export function parseContactsDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const dir = raw.trim().replace(/^\/+|\/+$/g, '');
  return /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(dir) ? dir : null;
}

/**
 * The per-source tuning keys `sources add` writes, each only when set so an
 * existing source's config keeps its exact shape (`DEFAULT_CALENDAR_ID` and
 * `CALENDAR_HORIZON_DAYS` stay parse-time fallbacks): `g_calendar_id`
 * (#5296), `g_contacts_dir` (#4845), `g_future_days` (#5442), `g_loops_exclude_labels` (#5445).
 */
export function googleTuningConfig(google: { calendarId?: string; contactsDir?: string; futureDays?: number; loopsExcludeLabels?: string[] }): Record<string, unknown> {
  return {
    ...(google.calendarId && google.calendarId !== DEFAULT_CALENDAR_ID ? { g_calendar_id: google.calendarId } : {}),
    ...(google.contactsDir && google.contactsDir !== DEFAULT_CONTACTS_DIR ? { g_contacts_dir: google.contactsDir } : {}),
    ...(google.futureDays !== undefined ? { g_future_days: google.futureDays } : {}),
    ...(google.loopsExcludeLabels && google.loopsExcludeLabels.length > 0 ? { g_loops_exclude_labels: google.loopsExcludeLabels.join(',') } : {}),
  };
}
