/**
 * Apple connector types (issue #6855). macOS-only, read-only: Calendar
 * (EventKit), Contacts (Contacts.framework), Mail (Mail.app scripting).
 *
 * Contract shared with src/core/apple/readers/* (READERS builder).
 */
// No runtime import here: this file is in the PGLite snapshot/migration import closure (via source-config.ts),
// so it stays free of the reader code. `AppleReaderError` lives in ./readers/errors.ts.
import type { AppleReaderErrorCode } from './readers/errors.ts';

export type { AppleReaderErrorCode } from './readers/errors.ts';

export type AppleService = 'calendar' | 'contacts' | 'mail';
export const ALL_APPLE_SERVICES: AppleService[] = ['calendar', 'contacts', 'mail'];
export const DEFAULT_CONTACTS_DIR = 'people';

export interface AppleSourceConfig {
  account: string;
  services: AppleService[];
  historyDays: number;
  futureDays: number;
  calendarIds: string[];
  contactsDir: string;
  mailMailboxes: string[];
  mailDays: number;
  /** Per-run cap on messages read (a_mail_max). */
  mailMax: number;
  /**
   * Explicit mailbox-owner addresses (a_mail_owner_addresses): lower-case bare addresses. They alone decide
   * which messages are the owner's for open-loop tracking; the account label and Sent-mailbox membership never do.
   */
  mailOwnerAddresses: string[];
  /**
   * a_loops_extract_consent (default false): the owner agreed that Mail thread text may go to the configured
   * chat provider for commitment/decision extraction. Deterministic unanswered tracking never needs it.
   */
  loopsExtractConsent: boolean;
  dir: string;
}

export interface AppleCalendarEvent {
  id: string;
  calendarId: string;
  calendarTitle: string;
  title: string;
  /** ISO 8601 */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  organizer?: string;
  attendees: { name?: string; email?: string }[];
  status?: string;
  recurring: boolean;
  lastModified?: string;
}

export interface AppleContact {
  id: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  organization?: string;
  jobTitle?: string;
  emails: string[];
  phones: string[];
  groups: string[];
  lastModified?: string;
}

export interface AppleMailMessage {
  id: string;
  threadId: string;
  mailbox: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  /** plain text, capped 20000 chars by the reader */
  body: string;
  read: boolean;
  /** The helper's header verdict: RFC 3834 Auto-Submitted (not "no") or a text/calendar part. Machine mail neither opens nor closes a loop. Absent = the reader did not classify. */
  automated?: boolean;
  /** The helper's header verdict: List-Unsubscribe, List-Id, Precedence bulk/list/junk or a no-reply Reply-To. Bulk mail owes no reply. */
  bulk?: boolean;
}

/** Public Mail account metadata the Apple reader may read, as the helper echoes it back to prove the scope it was given. */
export interface AppleMailAccountScope {
  id: string;
  /** The account's `server name` exactly as Mail reported it (not normalized). */
  serverName: string;
  /** The account's `account type` exactly as Mail reported it (imap, pop, iCloud). */
  accountType: string;
}

export type AppleMailRoutingStatus = 'apple' | 'mixed' | 'google_only' | 'no_enabled_accounts' | 'unknown';

export interface AppleMailRoutingUnknown {
  /** The account id, or null when Mail would not give one. Never a name or an address. */
  id: string | null;
  reason: 'account_id_unreadable' | 'duplicate_account_id' | 'enabled_unreadable' | 'server_name_unreadable' | 'server_name_malformed'
    | 'google_like_host' | 'account_type_unsupported';
}

/**
 * Which Mail accounts the Apple connector may read (mail-routing.ts). Additive: a reader without `mailRouting` behaves as
 * before. `fingerprint` binds a read, a cursor and staged evidence to the exact scope they were made under.
 */
export interface AppleMailAccountObservation {
  /** Public Mail dictionary metadata echoed back to the helper to refuse a stale routing decision. */
  id: string;
  serverName: string | null;
  accountType: string | null;
  enabled: boolean | null;
}

export interface AppleMailRouting {
  version: number;
  /** Public identity metadata for every account seen, including Google and disabled; the helper compares it before reading. */
  observed: AppleMailAccountObservation[];
  /** Stable ids for every account seen by the metadata probe, including Google and disabled (the helper validates this set). */
  accountIds: string[];
  /** SHA-256 of the policy version and every eligible account's (id, host, type); not of Google or disabled accounts. */
  fingerprint: string;
  status: AppleMailRoutingStatus;
  /** Enabled accounts on a non-Google provider: the only accounts a Mail read may touch. */
  eligible: AppleMailAccountScope[];
  /** Enabled accounts on a documented Google host: routed to the Google connector, never read here (ids only). */
  google: string[];
  /** Disabled accounts: never read (ids only). */
  disabled: string[];
  /** Enabled accounts whose provider cannot be determined: any entry makes `status` unknown and stops the Mail sweep. */
  unknown: AppleMailRoutingUnknown[];
}

/** One message the reader proved unreadable (stable id, received date, owning thread). */
export interface AppleUnavailableMessage {
  id: string;
  /** ISO 8601 received date, the same value the message carries when readable. */
  date: string;
  threadId: string;
}

/** A specific message to re-read wherever it is, outside the incremental read window. */
export interface AppleMailTarget {
  id: string;
  date: string;
}

/**
 * What a mail reader may return instead of a bare array when it knows the
 * listing is not the whole story. A bare `AppleMailMessage[]` means "complete".
 */
export interface AppleMailListing {
  messages: AppleMailMessage[];
  /** More messages matched than the per-run cap; the OLDEST cap-many are returned, resume from the newest. */
  truncated?: boolean;
  /** `truncated` because the helper's body-read time budget ran out (slow Mail bodies), not because of the cap. */
  budgetExhausted?: boolean;
  /** Threads with a message that could not be read: present in the account, so never to be swept as deleted. */
  unavailableThreads?: string[];
  /**
   * Messages PROVEN unreadable: the reader tried each one on its own (or got a definite "no body" for it) and failed,
   * with the stable id, the received date and the thread it belongs to. Only these may feed an item hold, because
   * only these identify the poison message rather than its batch neighbours.
   */
  unavailableMessages?: AppleUnavailableMessage[];
  /**
   * The subset of `unavailableThreads` that is NOT explained by a proven message (a batch that failed and could not be
   * retried in time, a message that vanished mid-read): the cursor stays pinned and nothing is counted. When omitted
   * next to `unavailableMessages`, every unavailable thread without a proven message is treated as deferred.
   */
  deferredThreads?: string[];
  /** Targeted reads only: requested messages the mailbox no longer has (deleted or moved); their holds can be dropped. Reported only when the read scope covered every Mail account. */
  targetMissing?: string[];
  /**
   * Targeted reads only: requested messages not found in the scoped accounts while other accounts (Google, disabled) are
   * outside the scope. They may be gone OR merely routed away, so they are never `targetMissing`: their holds are kept.
   */
  targetOutOfScope?: string[];
  /** The routing scope this read was made under (echoed from the request); the sweep refuses a read made under another. */
  routing?: { version: number; fingerprint: string };
  /** A message could not even be attributed to a thread: nothing may be swept as deleted this run. */
  incomplete?: boolean;
}

export interface AppleReaders {
  calendar(opts: {
    from: Date;
    to: Date;
    calendarIds: string[];
    signal?: AbortSignal;
  }): Promise<AppleCalendarEvent[]>;
  contacts(opts: { signal?: AbortSignal }): Promise<AppleContact[]>;
  mail(opts: {
    since: Date;
    mailboxes: string[];
    max?: number;
    /** Exclusive stable cursor; used with `since` at date-1ms for tied timestamps. */
    after?: { date: string; id: string };
    /** Stable ids of held messages the reader must not read (it neither lists nor reports them). */
    exclude?: string[];
    /** The accounts to read (from `mailRouting`). The macOS helper refuses a read without it: it never reads unified mailboxes. */
    routing?: AppleMailRouting;
    signal?: AbortSignal;
  }): Promise<AppleMailMessage[] | AppleMailListing>;
  /**
   * Re-reads specific messages by stable id and received date, wherever they are. Optional: a reader without it
   * cannot retry a held message outside the incremental window (the hold stays, visible).
   */
  mailMessages?(opts: { mailboxes: string[]; targets: AppleMailTarget[]; routing?: AppleMailRouting; signal?: AbortSignal }): Promise<AppleMailListing>;
  /**
   * Which Mail accounts may be read (public metadata only: id, server name, account type, enabled). Optional so a read-only
   * fake needs no stub; a reader without it is read exactly as before.
   */
  mailRouting?(opts?: { signal?: AbortSignal }): Promise<AppleMailRouting>;
  probe(
    service: AppleService,
  ): Promise<{ ok: true; routing?: AppleMailRouting } | { ok: false; code: AppleReaderErrorCode; fix: string }>;
  /**
   * Show the macOS permission prompt for a service that has not been asked yet
   * (probe reports `permission_not_determined`) without reading any item.
   * Optional so a read-only fake needs no stub; setup skips the request when absent.
   */
  requestAccess?(service: AppleService): Promise<{ ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string }>;
}

/** One grace-held thread (the Google shape: the loop its last detection would open at `due_ms`). */
export interface AppleLoopGraceHold {
  due_ms: number;
  slug: string | null;
  /** Newest message id of the page the spec was computed from. */
  rev: string | null;
  spec: {
    loopType: 'unanswered_inbound' | 'unanswered_outbound';
    counterpartyEmail: string;
    summary: string;
    evidence: Array<{ message_id?: string; page_slug?: string; quote?: string }>;
    lastActivityMs: number;
    openedMs: number;
  } | null;
}

/** One Mail message as open-loop tracking keeps it (bounded text; direction is decided by the owner addresses at detection time). */
export interface AppleLoopMessage {
  id: string;
  /** Lower-case bare sender address. */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  ms: number;
  /** Reader header verdicts; undefined = unclassified, which refuses the thread (fail closed). */
  auto?: boolean;
  bulk?: boolean;
  /** Quote-trimmed body, capped; a question mark past the cap is kept as a trailing "?". */
  body: string;
}

export interface AppleMailLoopsState {
  /** Bounded recent-thread diagnostic cache. Detection/recovery use complete evidence on durable pages, never this cache. */
  threads?: Record<string, AppleLoopMessage[]>;
  /** Digest of the owner addresses the stored loops were computed for. */
  digest?: string;
  /** The whole mail window must be re-read after identity changes or coverage gaps; cleared only by clean recovery. */
  reread?: boolean;
  /** Finish time of the last run that detected loops on the whole mail listing with nothing partial; the only freshness stamp. */
  complete_at?: string;
  /** Legacy extraction marker, retained when reading old checkpoints; never a catch-up completion authority. */
  extract_seen?: boolean;
  /** Known unreadable/failed threads, cleared only by successful observed recovery, never an empty listing. */
  pending_threads?: string[];
  /** Open deterministic rows require reconciliation under the new owner set. Manual dispositions are retained. */
  identity_reconcile?: boolean;
  /** Unattributed unreadability requires a nonempty complete window walk before claiming coverage again. */
  coverage_gap?: boolean;
  loop_grace_holds?: Record<string, AppleLoopGraceHold>;
}

/**
 * Bounded persistent staging of Mail hold recovery (mail-recovery.ts): the by-id evidence of held thread imports accumulates
 * here across runs, because a slow Mail.app hands the helper only a few bodies per call. It lives in the one cursor state, so
 * it is saved by the same canonical checkpoint write as the holds it belongs to and is dropped with them.
 */
export interface AppleMailRecoveryState {
  version: 1;
  /** Runs that read for recovery; the rotation clock (no wall clock, no failure count). */
  turn: number;
  /** Largest targeted batch the helper has been seen to resolve; a hint, never a proof. */
  capacity?: number;
  /** Holds admitted to staging (hold key -> last served turn, the targets reserved, and when it last made progress). */
  units: Record<string, { turn: number; n: number; at?: string }>;
  /** Messages read by id and not yet rendered, by message id. */
  staged: Record<string, { at: string; m: AppleMailMessage }>;
  /** Messages a read by id found gone upstream, by message id (value: when). */
  gone: Record<string, string>;
}

/** Cursor / state file persisted next to the managed clone. */
export interface AppleSourceState {
  version: 1;
  calendar: {
    window?: { from: string; to: string };
    hashes: Record<string, string>;
  };
  contacts: { hashes: Record<string, string> };
  mail: {
    /** Start of the mail window the last sweep covered. */
    since?: string;
    hashes: Record<string, string>;
    /** Newest message date read by the last complete run; the next run re-reads a 2-day overlap before it. */
    newest?: string;
    /** Message date at the current capped-read boundary. */
    resume_from?: string;
    /** Stable message id at that timestamp, to paginate timestamp ties without repeating them. */
    resume_id?: string;
    /**
     * The Mail routing scope every cursor, hash and staged message here was made under (mail-routing.ts). A different
     * fingerprint (or none: a legacy cursor) resets the cursors and drops staged evidence; stored pages and holds are kept.
     * `legacy` is sticky: pages may exist that came from accounts the scope no longer reads, so a `--full` never removes mail pages.
     */
    routing?: { v: number; fp: string; legacy?: true };
    /** Stable enumeration scope/purpose. A suffix cannot stand in for a different full/identity walk. */
    walk?: {
      key: string; since: string; purpose: 'full' | 'reread' | 'incremental'; seen: string[];
      /** A whole-window walk that also recovers held threads no remembered message list can rebuild (Mail hold recovery): when it began (ISO). */
      recover?: string;
      /** Such held threads whose page this walk has landed (cleared only when the walk completes), bounded by the hold cap. */
      landed?: string[];
    };
  };
  /** ItemHoldsState (connectors/item-holds.ts); opaque here so types.ts stays dependency-free. */
  item_holds: unknown;
  /** Open-loop tracking over Mail (src/core/apple/loops.ts); absent until a run had owner addresses. */
  mail_loops?: AppleMailLoopsState;
  /** Staged Mail hold recovery evidence (mail-recovery.ts); absent when nothing is staged. */
  mail_recovery?: AppleMailRecoveryState;
  last_probe?: Record<string, { ok: boolean; at: string; code?: string }>;
  last_full_at?: string;
}
