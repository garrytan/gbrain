/**
 * `sources add --kind imessage`: the registered config. It takes no directory and no record mode: the source keeps
 * local_path NULL, and each sync decides where the pages live (owned-folder/destination.ts: files under
 * `.gbrain-owned/<id>/` in the default source's checkout on a personal brain, else the database only).
 */
import { SYNC_INTERVAL_MIN_FLOOR } from '../meetings/types.ts';

export interface AddSourceIMessageOpts {
  historyDays?: number;
  lookbackDays?: number;
  syncIntervalMin?: number;
  tokenEnv?: string;
  timezone?: string;
}

/** The `sources.config` a new imessage source is registered with. Only non-default tuning keys are written; no token ever is. */
export function imessageSourceConfig(opts: AddSourceIMessageOpts, federated: boolean | null | undefined): Record<string, unknown> {
  return {
    kind: 'imessage',
    ...(opts.historyDays !== undefined ? { i_history_days: opts.historyDays } : {}),
    ...(opts.lookbackDays !== undefined ? { i_lookback_days: opts.lookbackDays } : {}),
    ...(opts.timezone && opts.timezone !== 'UTC' ? { i_timezone: opts.timezone } : {}),
    ...(opts.tokenEnv ? { i_token_env: opts.tokenEnv } : {}),
    ...(opts.syncIntervalMin !== undefined ? { sync_interval_min: Math.max(SYNC_INTERVAL_MIN_FLOOR, opts.syncIntervalMin) } : {}),
    // Messages join unqualified reads only when the owner asks (--federated), as Slack channels do.
    federated: federated ?? false,
  };
}
