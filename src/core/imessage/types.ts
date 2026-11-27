/**
 * iMessage source kind (`sources.config.kind = 'imessage'`): one page per chat per day, read from the GBrain Helper
 * running on the same Mac over 127.0.0.1. The source is always owner-only (access/owner-only.ts) and every page is
 * `visibility: private`. On a personal, unmanaged brain whose default source is a Git checkout the pages are also
 * files under `.gbrain-owned/<id>/` there, committed before the rows (owned-folder/); anywhere else the database is
 * the record. The text is other people's words, so the pages carry the external-untrusted tier.
 */

export const IMESSAGE_DEFAULT_HISTORY_DAYS = 30;
/** Recent days re-read every run, so edits and unsends converge. */
export const IMESSAGE_DEFAULT_LOOKBACK_DAYS = 7;
export const IMESSAGE_DEFAULT_SYNC_INTERVAL_MIN = 15;
/** The brain config key holding the helper's loopback port. */
export const IMESSAGE_HELPER_PORT_KEY = 'apple.helper.port';

export interface IMessageSourceConfig {
  historyDays: number;
  lookbackDays: number;
  /** The IANA zone whose midnight starts a day page. */
  timezone: string;
  /** An environment variable holding the helper token, read instead of the credential store. Excluded from the identity. */
  tokenEnv?: string;
  /** Minutes between scheduled syncs. Excluded from the identity. */
  syncIntervalMin: number;
}

/** A chat as the helper lists it. `threadId` is the chat identifier (a handle or a group id): never rendered or logged. */
export interface IMessageThread {
  threadId: string;
  displayName: string | null;
  participants: string[];
  isGroup: boolean;
  lastMessageAt: string | null;
}

export interface IMessageMessage {
  /** The message guid. */
  id: string;
  rowid: number;
  /** ISO 8601 UTC. */
  timestamp: string;
  isFromMe: boolean;
  text: string | null;
  textStatus: 'ok' | 'empty' | 'undecodable';
  /** The sender's handle in a group chat; null for the owner or a one-to-one chat. */
  from: string | null;
  hasAttachments: boolean;
  editedAt: string | null;
  retracted: boolean;
}
