/**
 * google/types — shared shapes for the google source kind.
 *
 * The clients module (google-clients.ts) normalizes raw Gmail/Calendar/People
 * API payloads into these; the renderer (google-render.ts) and the loop
 * detector (loop-detect.ts) consume them. Pure data, no I/O.
 */

export type GoogleService = 'gmail' | 'calendar' | 'contacts';

export const ALL_GOOGLE_SERVICES: readonly GoogleService[] = ['gmail', 'calendar', 'contacts'];

export interface GoogleSourceConfig {
  /** Account email — vault credential pointer in vault mode; identity only
   *  (From/To matching, deep-link authuser) in command/env modes. */
  account: string;
  services: GoogleService[];
  /** Backfill/reconcile window in days (default 90). */
  historyDays: number;
  /** Managed dir where pages are materialized. */
  dir: string;
  /**
   * How the sweep obtains a Google access token (default 'vault'):
   *  - 'vault'   — gbrain's credential vault (BYO OAuth / hosted relay).
   *  - 'command' — run `tokenCommand`, expect a token on stdout (gog,
   *                gcloud, a credential gateway's mint command).
   *  - 'env'     — read a live token from the env var named `tokenEnv`
   *                (refreshed by something outside gbrain).
   */
  access: 'vault' | 'command' | 'env';
  tokenCommand?: string;
  tokenEnv?: string;
}

/** Cursor state persisted at <dir>/.google-source.json. */
export interface GoogleSourceState {
  /** Gmail delta cursor (history.list startHistoryId). */
  gmail_history_id: string | null;
  /**
   * Backfill floor, epoch MILLISECONDS: everything strictly newer than this
   * within the window is already imported. Moves DOWNWARD during the initial
   * backfill (newest→oldest, batch-committed) so a killed backfill resumes
   * where it stopped instead of restarting (outside-voice F7a).
   */
  gmail_backfill_floor_ms: number | null;
  gmail_backfill_done: boolean;
  /** Bookmark for the history-expired fallback: newest internalDate imported. */
  gmail_newest_ms: number | null;
  /**
   * Poison-thread ledger: consecutive fetch failures per thread id. A thread
   * failing MAX_THREAD_FAILURES times is skipped (loudly) instead of wedging
   * the backfill floor / delta cursor forever; entries clear on success.
   */
  gmail_fail_counts?: Record<string, number>;
  calendar_sync_token: string | null;
  contacts_sync_token: string | null;
  last_full_at: string | null;
}

/**
 * Derive the suggested/created source id for a connected account. Shared by
 * `gbrain google setup` (which creates it) and connect's next-step hint
 * (which prints it) so the two can never diverge — SOURCE_ID_RE rejects
 * dots, so a dotted Gmail local part must be sanitized identically in both.
 */
export function deriveSourceId(account: string): string {
  const local = account.split('@')[0] ?? 'gmail';
  const id = `gmail-${local}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/-+$/, '');
  return id || 'gmail';
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  from: string;
  /** Lowercased bare addresses. */
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string;
  dateIso: string;
  internalDateMs: number;
  labelIds: string[];
  listUnsubscribe: boolean;
  /** Extracted, HTML-stripped, quote-trimmed, capped body text. */
  bodyText: string;
}

export interface GmailThreadData {
  threadId: string;
  /** The connected account (authuser for deep links). */
  account: string;
  /** Chronological (oldest first). */
  messages: GmailMessageMeta[];
}

export interface CalendarEventData {
  /** Recurrence-instance id when expanded (singleEvents=true). */
  id: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  organizer: string | null;
  attendees: Array<{ email: string; displayName: string | null; self: boolean; responseStatus: string | null }>;
  location: string | null;
  hangoutLink: string | null;
  htmlLink: string | null;
  status: string;
  account: string;
}

export interface ContactData {
  resourceName: string;
  displayName: string | null;
  emails: string[];
  organization: string | null;
  title: string | null;
  deleted: boolean;
}

/** Extract the bare lowercase address from "Name <a@b.c>" or "a@b.c". */
export function bareAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  return addr;
}

/** Split a To:/Cc: header into bare lowercase addresses. */
export function splitAddressList(raw: string): string[] {
  if (!raw.trim()) return [];
  // Commas inside display names ("Doe, Jane" <j@x.co>) hide behind quotes;
  // strip quoted segments before splitting.
  const unquoted = raw.replace(/"[^"]*"/g, '');
  return unquoted
    .split(',')
    .map((part) => bareAddress(part))
    .filter((a) => a.includes('@'));
}
