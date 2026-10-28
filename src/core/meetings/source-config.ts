/** Parse a meetings source's `sources.config`. Dependency-light so migrations and the connector identity can import it. */
import {
  isMeetingProviderName, MEETINGS_DEFAULT_HISTORY_DAYS, MEETINGS_DEFAULT_LOOKBACK_DAYS, MEETINGS_DEFAULT_SYNC_INTERVAL_MIN,
  SYNC_INTERVAL_MIN_FLOOR, type MeetingsSourceConfig,
} from './types.ts';

const positiveInt = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(max, Math.floor(value)) : fallback;

/** The per-source scheduled-sync interval in minutes, floored; null for a config that sets none. */
export function syncIntervalMinutes(config: Record<string, unknown>, fallback: number | null): number | null {
  const value = config.sync_interval_min;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(SYNC_INTERVAL_MIN_FLOOR, Math.floor(value));
}

export function parseMeetingsSourceConfig(config: Record<string, unknown>, fallbackDir: string): MeetingsSourceConfig {
  const record = config.m_record === 'git' ? 'git' : 'database';
  const dir = typeof config.m_dir === 'string' && config.m_dir.length > 0 ? config.m_dir : record === 'git' && fallbackDir ? fallbackDir : null;
  return {
    provider: isMeetingProviderName(config.m_provider) ? config.m_provider : 'fireflies',
    historyDays: positiveInt(config.m_history_days, MEETINGS_DEFAULT_HISTORY_DAYS, 3650),
    lookbackDays: positiveInt(config.m_lookback_days, MEETINGS_DEFAULT_LOOKBACK_DAYS, 60),
    transcript: config.m_transcript === 'full' ? 'full' : 'none',
    ...(typeof config.m_token_env === 'string' && config.m_token_env.trim() ? { tokenEnv: config.m_token_env.trim() } : {}),
    record,
    dir: record === 'git' ? dir : null,
    privateOnly: config.m_visibility === 'private',
    syncIntervalMin: syncIntervalMinutes(config, MEETINGS_DEFAULT_SYNC_INTERVAL_MIN)!,
  };
}
