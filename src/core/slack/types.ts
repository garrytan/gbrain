/**
 * Slack channel source kind (`sources.config.kind = 'slack'`): one page per
 * channel per day from the Slack Web API, read with the user's own internal
 * Slack app token. The client normalizes nothing it does not need; the
 * renderer neutralizes every outside field.
 */
import type { MeetingRecordMode } from '../meetings/types.ts';

export const SLACK_DEFAULT_HISTORY_DAYS = 14;
export const SLACK_DEFAULT_LOOKBACK_DAYS = 7;
export const SLACK_DEFAULT_SYNC_INTERVAL_MIN = 30;
/** Requests one run makes before it stops partial and resumes next run (T11). */
export const SLACK_DEFAULT_MAX_REQUESTS = 2000;

/** Message kinds a source may leave out (T11). */
export type SlackSkippable = 'bot_message' | 'channel_join';
export const SLACK_SKIPPABLE: readonly SlackSkippable[] = ['bot_message', 'channel_join'];

/** The bot token scopes the source needs (the app manifest in the guide grants exactly these). */
export const SLACK_SCOPES = ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'users:read'] as const;

export interface SlackSourceConfig {
  /** Channel ids (C… public, G… or C… private), upper-case, sorted, unique. */
  channels: string[];
  historyDays: number;
  /** Recent days re-read every run, so edits, deletions and new thread replies converge. */
  lookbackDays: number;
  /** The IANA zone whose midnight starts a day page. */
  timezone: string;
  /** An environment variable holding the token, read instead of the credential store. Excluded from the identity. */
  tokenEnv?: string;
  record: MeetingRecordMode;
  dir: string | null;
  /** Every page is written `visibility: private`. */
  privateOnly: boolean;
  /** Minutes between scheduled syncs. Excluded from the identity. */
  syncIntervalMin: number;
  /** Requests per run before it stops partial. Excluded from the identity. */
  maxRequests: number;
  skip: SlackSkippable[];
}

/** Who a token belongs to: the account pin. */
export interface SlackAccount { teamId: string; enterpriseId: string | null; team: string | null; botUserId: string | null }

export interface SlackChannelInfo { id: string; name: string; isPrivate: boolean; isArchived: boolean }

/** A Slack message as conversations.history / conversations.replies return it (the fields gbrain reads). */
export interface SlackMessage {
  ts: string;
  type?: string;
  subtype?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts?: string; user?: string };
  files?: Array<{ name?: string; title?: string }>;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string;
}

export interface SlackUser { name: string; deleted: boolean; bot: boolean }
