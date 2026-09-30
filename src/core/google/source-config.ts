/** Parse a Google connector source's `sources.config`. Dependency-light so migrations and the connector identity can import it. */
import { ALL_GOOGLE_SERVICES, DEFAULT_CALENDAR_ID, type GoogleService, type GoogleSourceConfig } from './types.ts';

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
  const calendarId =
    typeof config.g_calendar_id === 'string' && config.g_calendar_id.trim().length > 0
      ? config.g_calendar_id.trim()
      : DEFAULT_CALENDAR_ID;
  const dir =
    typeof config.g_dir === 'string' && config.g_dir.length > 0 ? config.g_dir : fallbackDir;
  const access =
    config.g_access === 'command' || config.g_access === 'env' ? config.g_access : 'vault';
  return {
    account,
    services: services.length > 0 ? services : [...ALL_GOOGLE_SERVICES],
    historyDays,
    calendarId,
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
