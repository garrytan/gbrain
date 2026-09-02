/**
 * google/types — shared shapes for the google source kind.
 *
 * The clients module (google-clients.ts) normalizes raw Gmail/Calendar/People
 * API payloads into these; the renderer (google-render.ts) and the loop
 * detector (loop-detect.ts) consume them. Pure data, no I/O.
 */

export type GoogleService = 'gmail' | 'calendar' | 'contacts';

export const ALL_GOOGLE_SERVICES: readonly GoogleService[] = ['gmail', 'calendar', 'contacts'];

/** The account's primary calendar — the Calendar API's own alias, and the default a google source sweeps. */
export const DEFAULT_CALENDAR_ID = 'primary';

export interface GoogleSourceConfig {
  /** Account email — vault credential pointer in vault mode; identity only
   *  (From/To matching, deep-link authuser) in command/env modes. */
  account: string;
  services: GoogleService[];
  /** Backfill/reconcile window in days (default 90). */
  historyDays: number;
  /** Calendar swept by this source (default DEFAULT_CALENDAR_ID). One calendar per
   *  source so each keeps its own sync token — point a second source at a
   *  secondary calendar id to ingest it too. */
  calendarId: string;
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
  /**
   * Calendar id `calendar_sync_token` was minted for. A token is only valid
   * against its own calendar: when g_calendar_id changes, the sweep discards
   * the token and re-lists windowed instead of pairing the new calendar with
   * the old cursor. Absent on legacy state, which predates secondary
   * calendars and was therefore always primary's.
   */
  calendar_id?: string | null;
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
  /**
   * iCalendar method when the message carries a `text/calendar` part or an
   * `.ics` attachment — 'REQUEST' | 'REPLY' | 'CANCEL' | 'COUNTER' | '' when a
   * calendar part is present without an explicit method. `null`/absent means
   * no calendar part was seen. Google Calendar attaches one to every
   * invitation, update, response and cancellation, which is what makes this a
   * structural signal rather than a subject guess.
   */
  calendarMethod?: string | null;
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
