/** Parse a slack source's `sources.config`. Dependency-light so migrations and the connector identity can import it. */
import { syncIntervalMinutes } from '../meetings/source-config.ts';
import {
  SLACK_DEFAULT_HISTORY_DAYS, SLACK_DEFAULT_LOOKBACK_DAYS, SLACK_DEFAULT_MAX_REQUESTS, SLACK_DEFAULT_SYNC_INTERVAL_MIN, SLACK_SKIPPABLE,
  type SlackSkippable, type SlackSourceConfig,
} from './types.ts';

const positiveInt = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(max, Math.floor(value)) : fallback;

/** A Slack channel id: a C (public or private) or G (legacy private) prefix, then upper-case letters and digits. */
export const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,20}$/;

/** The channel list as stored: upper-case, unique, sorted, so the identity does not depend on the order typed. */
export function normalizeSlackChannels(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.map(String) : [];
  return [...new Set(raw.map(id => id.trim().toUpperCase()).filter(Boolean))].sort();
}

export function isValidTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

export function parseSlackSourceConfig(config: Record<string, unknown>, fallbackDir: string): SlackSourceConfig {
  const record = config.s_record === 'git' ? 'git' : 'database';
  const dir = typeof config.s_dir === 'string' && config.s_dir.length > 0 ? config.s_dir : record === 'git' && fallbackDir ? fallbackDir : null;
  const timezone = typeof config.s_timezone === 'string' && isValidTimeZone(config.s_timezone) ? config.s_timezone : 'UTC';
  const skip = (Array.isArray(config.s_skip) ? config.s_skip : typeof config.s_skip === 'string' ? config.s_skip.split(',') : [])
    .map(String).filter((s): s is SlackSkippable => (SLACK_SKIPPABLE as readonly string[]).includes(s));
  return {
    channels: normalizeSlackChannels(config.s_channels),
    historyDays: positiveInt(config.s_history_days, SLACK_DEFAULT_HISTORY_DAYS, 3650),
    lookbackDays: positiveInt(config.s_lookback_days, SLACK_DEFAULT_LOOKBACK_DAYS, 60),
    timezone,
    ...(typeof config.s_token_env === 'string' && config.s_token_env.trim() ? { tokenEnv: config.s_token_env.trim() } : {}),
    record,
    dir: record === 'git' ? dir : null,
    privateOnly: config.s_visibility === 'private',
    syncIntervalMin: syncIntervalMinutes(config, SLACK_DEFAULT_SYNC_INTERVAL_MIN)!,
    maxRequests: positiveInt(config.s_max_requests, SLACK_DEFAULT_MAX_REQUESTS, 10_000),
    skip: [...new Set(skip)].sort(),
  };
}
