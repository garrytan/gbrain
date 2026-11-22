/** Parse an imessage source's `sources.config`. Dependency-light so the connector identity can import it. */
import { syncIntervalMinutes } from '../meetings/source-config.ts';
import { isValidTimeZone } from '../slack/source-config.ts';
import { IMESSAGE_DEFAULT_HISTORY_DAYS, IMESSAGE_DEFAULT_LOOKBACK_DAYS, IMESSAGE_DEFAULT_SYNC_INTERVAL_MIN, type IMessageSourceConfig } from './types.ts';

const positiveInt = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(max, Math.floor(value)) : fallback;

export function parseIMessageSourceConfig(config: Record<string, unknown>): IMessageSourceConfig {
  return {
    historyDays: positiveInt(config.i_history_days, IMESSAGE_DEFAULT_HISTORY_DAYS, 3650),
    lookbackDays: positiveInt(config.i_lookback_days, IMESSAGE_DEFAULT_LOOKBACK_DAYS, 60),
    timezone: typeof config.i_timezone === 'string' && isValidTimeZone(config.i_timezone) ? config.i_timezone : 'UTC',
    ...(typeof config.i_token_env === 'string' && config.i_token_env.trim() ? { tokenEnv: config.i_token_env.trim() } : {}),
    syncIntervalMin: syncIntervalMinutes(config, IMESSAGE_DEFAULT_SYNC_INTERVAL_MIN)!,
  };
}
