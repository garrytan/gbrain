/**
 * google-clients — fetch clients for the Gmail / Calendar / People REST APIs.
 *
 * Hand-rolled (no googleapis dep, house style — see github-source.ts):
 *  - auth via GoogleTokenProvider (vault-backed, auto-refreshing)
 *  - 401 → forceRefresh() + single retry
 *  - 403/429 → Retry-After honored (delta-seconds AND http-date). A
 *    rate-limit-class response (403 rateLimitExceeded/userRateLimitExceeded,
 *    403 quota, or 429) gets a MUCH more patient retry budget than other
 *    retryable failures — DEFAULT_RATE_LIMIT_RETRIES, exponential backoff
 *    with jitter capped at 60s — because Gmail's per-user rate limiting
 *    under backfill burst load is common and self-clearing; giving up after
 *    two tries used to poison threads that would have succeeded a few
 *    seconds later.
 *  - 403 accessNotConfigured / SERVICE_DISABLED → GoogleApiDisabledError
 *    ('api_not_enabled') naming the API, the project and the enable link
 *    Google put in the error body (the client id's project number otherwise)
 *  - 403 insufficient authentication scopes → CredentialError 'scope_missing'
 *  - uniform pageToken pagination with a safety cap
 *  - fetchImpl injectable for tests
 */

import { CredentialError } from '../creds/errors.ts';
import type { GoogleAccessProvider } from './access.ts';
import { apiEnableLink, projectNumberFromClientId } from '../creds/providers/google.ts';
import { parseRetryAfterMs } from '../github-source.ts';
import { readBoundedHttpBody } from '../guarded-http.ts';
import {
  bareAddress,
  DEFAULT_CALENDAR_ID,
  GOOGLE_SERVICE_API,
  splitAddressList,
  type GoogleService,
  type CalendarEventData,
  type ContactData,
  type GmailMessageMeta,
  type GmailThreadData,
} from './types.ts';
import { htmlToText, trimQuotedReply } from './google-render.ts';
import { truncateUtf8 } from '../text-safe.ts';
import { GMAIL_MIME_LIMITS, gmailPartHeader, inspectGmailAttachments, walkGmailMime, type GmailMimePart } from './attachment-receipts.ts';
import { fetchTextOriginals, ORIGINAL_LIMITS } from './attachment-originals.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const PEOPLE_BASE = 'https://people.googleapis.com/v1';

const PAGINATION_CAP = 500;

/** Retry budget for a 401 needing a token refresh-and-retry. */
const DEFAULT_RETRIES = 2;

/**
 * Retry budget for a rate-limit-class response (403 rateLimitExceeded /
 * userRateLimitExceeded / quota, or 429) — deliberately much larger than
 * DEFAULT_RETRIES. Gmail's per-user rate limiting under backfill burst load
 * clears on its own within seconds to low minutes; two tries (~6s total)
 * gave up before it cleared and poisoned threads that would otherwise have
 * succeeded.
 */
const DEFAULT_RATE_LIMIT_RETRIES = 6;

/** Backoff ceiling for a rate-limit retry with no Retry-After header. */
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;

/**
 * Exponential backoff with EQUAL jitter (half fixed, half random), capped at
 * RATE_LIMIT_BACKOFF_CAP_MS. Only used when Google didn't send Retry-After —
 * jitter avoids many gbrain processes hitting the same per-user/per-project
 * quota resynchronizing their retries in lockstep.
 */
export function rateLimitBackoffMs(attempt: number): number {
  const base = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, 2 ** attempt * 2_000);
  const half = base / 2;
  return Math.round(half + Math.random() * half);
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ '@type'?: string; reason?: string; metadata?: Record<string, unknown>; links?: Array<{ url?: unknown }> }>;
  };
}

type ApiHint = 'gmail' | 'calendar-json' | 'people';

/** Shared request core with auth, refresh-retry, and rate-limit handling. */
export class GoogleApiClient {
  constructor(
    protected readonly tokens: GoogleAccessProvider,
    protected readonly fetchImpl: FetchImpl = fetch,
    public readonly log: (msg: string) => void = () => {},
    /** For the api_not_enabled deep link. */
    protected readonly clientId?: string,
  ) {}

  async fetchJSON<T>(
    url: string,
    apiHint: ApiHint,
    opts: { signal?: AbortSignal; retries?: number; rateLimitRetries?: number; maxResponseBytes?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? DEFAULT_RETRIES;
    // Rate-limit-class failures get their OWN (larger) retry budget — see
    // the class doc comment. The shared `attempt` counter is bounded by
    // whichever budget is larger; each branch below still checks its own
    // budget, so a plain 401 exhausts at `retries` exactly as before.
    const rateLimitRetries = opts.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
    const maxAttempt = Math.max(retries, rateLimitRetries);
    for (let attempt = 0; attempt <= maxAttempt; attempt++) {
      const token = await this.tokens.getAccessToken();
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const readJSON = () => opts.maxResponseBytes
        ? readBoundedHttpBody(new Response(res.body), opts.maxResponseBytes, opts.signal ?? new AbortController().signal)
          .then(bytes => JSON.parse(bytes.toString('utf8')))
        : res.json();
      if (res.ok) return (await readJSON()) as T;

      if (res.status === 401 && attempt < retries) {
        this.log('[google] HTTP 401; refreshing access token');
        await this.tokens.forceRefresh();
        continue;
      }
      const body = (await readJSON().catch(() => ({}))) as GoogleErrorBody;
      if (res.status === 403) {
        const reason = body.error?.errors?.[0]?.reason ?? '';
        const msg = body.error?.message ?? '';
        const errorInfo = body.error?.details?.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
        if (reason === 'accessNotConfigured' || errorInfo?.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(msg)) {
          throw googleApiDisabledError(body, apiHint, this.clientId);
        }
        if (reason === 'insufficientPermissions' || errorInfo?.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient authentication scopes/i.test(msg)) {
          throw new CredentialError('scope_missing', undefined, `HTTP 403 on ${apiHint}: ${msg || reason}`);
        }
        if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || /rate/i.test(msg)) {
          // fall through to the retry-after sleep below
        } else if (!/quota/i.test(`${reason} ${msg}`)) {
          throw new GoogleForbiddenError(`: HTTP 403 ${reason || msg} on ${apiHint}`);
        }
      }
      if (res.status === 403 || res.status === 429) {
        const waitMs = parseRetryAfterMs(res.headers.get('retry-after')) ?? rateLimitBackoffMs(attempt);
        if (attempt < rateLimitRetries) {
          this.log(
            `[google] HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s ` +
              `(rate limit, attempt ${attempt + 1}/${rateLimitRetries})`,
          );
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          continue;
        }
        throw new CredentialError('rate_limited', undefined, `HTTP ${res.status} on ${url}`);
      }
      // 404 / 410 surface to callers — cursor-expiry handling is theirs.
      if (res.status === 404 || res.status === 410) {
        throw new GoogleCursorExpiredError(res.status, url);
      }
      if (res.status === 400 && apiHint === 'people' && new URL(url).searchParams.get('syncToken')) {
        const details = body.error?.details;
        const expired = (Array.isArray(details) && details.some(detail =>
          detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && detail.reason === 'EXPIRED_SYNC_TOKEN',
        )) || /^Sync token (?:is )?expired\b/i.test(body.error?.message ?? '');
        if (expired) throw new GoogleCursorExpiredError(res.status, url);
        throw new GoogleSyncTokenRejectedError(url, body.error?.message ?? 'no detail');
      }
      throw new CredentialError('upstream', `: HTTP ${res.status} on ${apiHint} (${body.error?.message ?? 'no detail'})`);
    }
    throw new CredentialError('upstream', `: unreachable ${apiHint}`);
  }

  /**
   * Drain a pageToken-paginated endpoint. `build(pageToken)` returns the URL.
   * At the page cap: throws by default (callers that RECONCILE must never
   * treat a truncated list as complete), or returns the partial batch when
   * `partialOk` is set (callers with their own resume cursor — the Gmail
   * backfill — make forward progress from whatever landed instead of
   * wedging forever on a >cap window).
   */
  async drainPages<T>(
    build: (pageToken: string | null) => string,
    pick: (body: Record<string, unknown>) => { items: T[]; nextPageToken: string | null },
    apiHint: ApiHint,
    opts: { signal?: AbortSignal; maxPages?: number; partialOk?: boolean } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | null = null;
    const cap = opts.maxPages ?? PAGINATION_CAP;
    for (let page = 0; page < cap; page++) {
      const body = await this.fetchJSON<Record<string, unknown>>(build(pageToken), apiHint, opts);
      const { items, nextPageToken } = pick(body);
      out.push(...items);
      if (!nextPageToken) return out;
      pageToken = nextPageToken;
    }
    if (opts.partialOk) return out;
    throw new CredentialError('upstream', `: pagination cap (${cap}) hit on ${apiHint}`);
  }
}

const SERVICE_FOR_HINT: Record<ApiHint, GoogleService> = { gmail: 'gmail', 'calendar-json': 'calendar', people: 'contacts' };

/** Only a Google Cloud console link is relayed from an error body; anything else falls back to the derived link. */
function consoleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'console.developers.google.com' || url.hostname === 'console.cloud.google.com') ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * #7073: an API disabled for the OAuth client's project. Carries the API, its
 * title, the project and the enable link from Google's ErrorInfo (the Help
 * link or the message when ErrorInfo is absent), so setup, status and doctor
 * can name every disabled API with its own link.
 */
export class GoogleApiDisabledError extends CredentialError {
  constructor(readonly api: string, readonly apiTitle: string, readonly project: string | null, readonly enableUrl: string) {
    super('api_not_enabled', enableUrl);
    this.name = 'GoogleApiDisabledError';
  }
}

function googleApiDisabledError(body: GoogleErrorBody, apiHint: ApiHint, clientId: string | undefined): GoogleApiDisabledError {
  const details = body.error?.details ?? [];
  const metadata = details.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.metadata ?? {};
  const text = (key: string): string | null => typeof metadata[key] === 'string' && (metadata[key] as string).trim() ? (metadata[key] as string).trim() : null;
  const helpUrl = details.flatMap(detail => detail?.links ?? []).map(link => consoleUrl(link?.url)).find(url => url !== null) ?? null;
  const messageUrl = consoleUrl(body.error?.message?.match(/https:\/\/\S+/)?.[0]?.replace(/[.,;)]+$/, ''));
  const consumer = text('consumer')?.replace(/^projects\//, '') ?? text('containerInfo');
  const project = consumer ?? body.error?.message?.match(/in project (\d+)/)?.[1] ?? (clientId ? projectNumberFromClientId(clientId) : null);
  const fallback = GOOGLE_SERVICE_API[SERVICE_FOR_HINT[apiHint]];
  return new GoogleApiDisabledError(text('service') ?? fallback.api, text('serviceTitle') ?? fallback.title, project,
    consoleUrl(metadata.activationUrl) ?? helpUrl ?? messageUrl ?? apiEnableLink(apiHint, clientId));
}

/** Gmail 404-on-historyId / Calendar-People 410-on-syncToken. */
export class GoogleCursorExpiredError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`Google cursor expired (HTTP ${status}) on ${url}`);
    this.name = 'GoogleCursorExpiredError';
  }
}

/**
 * #5012 item 9: a 403 that is neither a disabled API, a rate limit nor a
 * quota: the token cannot read this resource. Still an upstream
 * `CredentialError` for every caller that does not classify it; the calendar
 * sweep and `google status` read it as an unreadable calendar.
 */
export class GoogleForbiddenError extends CredentialError {
  constructor(detail: string) {
    super('upstream', detail);
    this.name = 'GoogleForbiddenError';
  }
}

/** #5012 item 9: the HTTP status when `e` says the calendar cannot be read by this account (403 or 404), else null. */
export function calendarUnreadableStatus(e: unknown): 403 | 404 | null {
  if (e instanceof GoogleForbiddenError) return 403;
  if (e instanceof GoogleCursorExpiredError && e.status === 404) return 404;
  return null;
}

/**
 * #6324: People answered a syncToken request with a 400 that is NOT the typed
 * expiry. The People API requires every other parameter of an incremental
 * request to match the call that minted the token, so a token minted under a
 * different `personFields` lands here. Still an upstream `CredentialError`
 * for every caller that does not own a contacts cursor; the contacts sweep
 * treats it as cursor-invalid and re-lists once.
 */
export class GoogleSyncTokenRejectedError extends CredentialError {
  constructor(url: string, detail: string) {
    super('upstream', `: HTTP 400 on people (${detail})`);
    this.name = 'GoogleSyncTokenRejectedError';
    this.url = url;
  }
  readonly url: string;
}

// ── Gmail ────────────────────────────────────────────────────────────────────

type RawGmailPart = GmailMimePart;

interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: RawGmailPart;
}

interface RawGmailThread {
  id: string;
  historyId?: string;
  messages?: RawGmailMessage[];
}

function partHeader(part: RawGmailPart | undefined, name: string): string {
  return gmailPartHeader(part, name);
}

function header(msg: RawGmailMessage, name: string): string {
  return partHeader(msg.payload, name);
}

/**
 * RFC 3834 `Auto-Submitted`: any keyword other than `no` (`auto-generated`,
 * `auto-replied`, `auto-notified`, extensions) marks machine mail, matched
 * case-insensitively with parameters and comments ignored. An absent or empty
 * header is human mail.
 */
function isAutoSubmittedHeader(value: string): boolean {
  const keyword = value.replace(/\([^)]*\)/g, ' ').split(';')[0]!.trim().toLowerCase();
  return keyword !== '' && keyword !== 'no';
}

/** iCalendar METHOD parameter of a Content-Type value (quoted or bare). */
const CALENDAR_METHOD_RE = /method\s*=\s*"?([a-z]+)"?/i;

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/** MIME walk: prefer text/plain, fall back to text/html (caller strips). */
export function extractBody(part: RawGmailPart | undefined): { text: string; isHtml: boolean } {
  if (!part) return { text: '', isHtml: false };
  let html: string | null = null;
  const attachmentPaths: string[] = [];
  for (const { part: p, path } of walkGmailMime(part).parts) {
    if (attachmentPaths.some(parent => path.startsWith(`${parent}.`))) continue;
    if (p.filename || p.mimeType === 'message/rfc822' || /^attachment\b/i.test(partHeader(p, 'Content-Disposition'))) {
      attachmentPaths.push(path);
      continue;
    }
    if (p.mimeType === 'text/plain' && p.body?.data) {
      return { text: decodeB64Url(p.body.data), isHtml: false };
    }
    if (p.mimeType === 'text/html' && p.body?.data && html === null) {
      html = decodeB64Url(p.body.data);
    }
  }
  if (html !== null) return { text: html, isHtml: true };
  // Single-part messages sometimes carry data at the top level with no mimeType match.
  if (!part.mimeType && !part.filename && part.body?.data) return { text: decodeB64Url(part.body.data), isHtml: false };
  return { text: '', isHtml: false };
}

/**
 * iCalendar method for a message: the METHOD of its `text/calendar` /
 * `application/ics` MIME part ('' when the part carries no parsable method),
 * or null when the message has no calendar MIME part at all — including the
 * bare-.ics-filename-attachment shape, which is a human forwarding an invite
 * file, not Calendar system mail.
 *
 * Structural, not textual: Google Calendar attaches a `text/calendar` part
 * (`method=REQUEST|REPLY|CANCEL`) to every invitation, update, response and
 * cancellation, so this identifies calendar system mail without matching on
 * subject wording or sender address — both of which are wrong signals, since
 * the mail arrives FROM the colleague's real address. Only a NON-EMPTY method
 * classifies as system mail (isCalendarSystemMail); '' and null both fall to
 * the anchored subject-prefix fallback.
 */
export function extractCalendarMethod(part: RawGmailPart | undefined): string | null {
  if (!part) return null;
  for (const { part: p } of walkGmailMime(part).parts) {
    const mime = typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : '';
    if (mime.startsWith('text/calendar') || mime === 'application/ics') {
      // Gmail's MessagePart.mimeType is the BARE media type; the `method=`
      // parameter lives in the part's own Content-Type header (format=full
      // carries headers on nested parts). Read that first — a parser that
      // only looked at mimeType read '' for every real invite, which silently
      // downgraded the structural signal to the subject-prefix fallback. A
      // mimeType that still carries the params (other providers / fixtures)
      // remains the fallback parse.
      const contentType = partHeader(p, 'Content-Type');
      const m = CALENDAR_METHOD_RE.exec(contentType) ?? CALENDAR_METHOD_RE.exec(p.mimeType ?? '');
      return (m?.[1] ?? '').toUpperCase();
    }
    // A bare `.ics` FILENAME with a non-calendar MIME type claims nothing:
    // that shape is a human attaching an invite file, not Calendar system
    // mail, and short-circuiting '' here used to suppress the whole message
    // from loop detection. Keep scanning — a real text/calendar part
    // elsewhere in the tree still wins.
  }
  return null;
}

export class GmailClient extends GoogleApiClient {
  async getProfile(opts: { signal?: AbortSignal } = {}): Promise<{ emailAddress: string; historyId: string }> {
    return this.fetchJSON(`${GMAIL_BASE}/users/me/profile`, 'gmail', opts);
  }

  /** The account's labels (system and user), for resolving `g_loops_exclude_labels` names to ids once per sweep (#5445). */
  async getLabels(opts: { signal?: AbortSignal } = {}): Promise<Array<{ id: string; name: string; type: string }>> {
    const body = await this.fetchJSON<{ labels?: Array<{ id?: string; name?: string; type?: string }> }>(`${GMAIL_BASE}/users/me/labels`, 'gmail', opts);
    return (body.labels ?? []).flatMap((l) => typeof l.id === 'string' && typeof l.name === 'string' ? [{ id: l.id, name: l.name, type: l.type ?? 'user' }] : []);
  }

  /** Message ids matching a Gmail search query (includes SENT; excludes SPAM/TRASH). */
  async listMessageIds(
    q: string,
    opts: { signal?: AbortSignal; maxPages?: number; partialOk?: boolean } = {},
  ): Promise<Array<{ id: string; threadId: string }>> {
    return this.drainPages(
      (t) =>
        `${GMAIL_BASE}/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}${t ? `&pageToken=${encodeURIComponent(t)}` : ''}`,
      (body) => ({
        items: (body.messages as Array<{ id: string; threadId: string }> | undefined) ?? [],
        nextPageToken: (body.nextPageToken as string | undefined) ?? null,
      }),
      'gmail',
      opts,
    );
  }

  /**
   * Thread ids touched since the stored historyId. Throws
   * GoogleCursorExpiredError(404) when the cursor is too old (~1 week).
   * Returns the new historyId to store after a successful drain.
   *
   * #5581 (fix wave 4): with `maxThreads`, the listing stops before the
   * history record that would exceed it and returns `truncated: true` with
   * `newHistoryId` set to the last record fully included, so the caller can
   * bank that far and resume from there without dropping any change. A
   * record without an id cannot be bounded safely, so the listing then
   * drains everything.
   */
  async listHistoryThreadIds(
    startHistoryId: string,
    opts: { signal?: AbortSignal; maxThreads?: number } = {},
  ): Promise<{ threadIds: string[]; newHistoryId: string | null; truncated: boolean; versions: Map<string, string> }> {
    const threadIds = new Set<string>();
    // The latest history record touching each thread: its upstream version for the item holds.
    const versions = new Map<string, string>();
    let newHistoryId: string | null = null;
    let lastRecordId: string | null = null;
    let truncated = false;
    await this.drainPages(
      (t) =>
        `${GMAIL_BASE}/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&maxResults=100${t ? `&pageToken=${encodeURIComponent(t)}` : ''}`,
      (body) => {
        const records = (body.history as Array<Record<string, unknown>> | undefined) ?? [];
        for (const rec of records) {
          const touched = new Set<string>();
          for (const key of ['messages', 'messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
            const arr = rec[key] as Array<{ threadId?: string; message?: { threadId?: string } }> | undefined;
            for (const m of arr ?? []) {
              const tid = m.threadId ?? m.message?.threadId;
              if (tid) touched.add(tid);
            }
          }
          const fresh = [...touched].filter((tid) => !threadIds.has(tid));
          const recordId = typeof rec.id === 'string' ? rec.id : null;
          if (opts.maxThreads !== undefined && lastRecordId && recordId && threadIds.size + fresh.length > opts.maxThreads) {
            truncated = true;
            return { items: [], nextPageToken: null };
          }
          for (const tid of fresh) threadIds.add(tid);
          if (recordId) {
            lastRecordId = recordId;
            for (const tid of touched) versions.set(tid, recordId);
          }
        }
        if (typeof body.historyId === 'string') newHistoryId = body.historyId;
        return { items: [], nextPageToken: (body.nextPageToken as string | undefined) ?? null };
      },
      'gmail',
      opts,
    );
    return { threadIds: [...threadIds], newHistoryId: truncated ? lastRecordId : newHistoryId, truncated, versions };
  }

  async getThread(
    threadId: string,
    account: string,
    opts: { signal?: AbortSignal; bodyCapChars?: number; metadataOnly?: boolean } = {},
  ): Promise<GmailThreadData> {
    let fields = '';
    if (opts.metadataOnly) {
      let payload = 'partId,mimeType';
      for (let depth = GMAIL_MIME_LIMITS.depth; depth >= 0; depth--) {
        payload = `partId,mimeType,filename,headers(name,value),body(attachmentId,size),parts(${payload})`;
      }
      fields = `&fields=${encodeURIComponent(`id,messages(id,internalDate,labelIds,payload(${payload}))`)}`;
    }
    const raw = await this.fetchJSON<RawGmailThread>(
      `${GMAIL_BASE}/users/me/threads/${encodeURIComponent(threadId)}?format=full${fields}`,
      'gmail',
      opts.metadataOnly ? { ...opts, maxResponseBytes: 2 * 1024 * 1024 } : opts,
    );
    const cap = opts.bodyCapChars ?? 8_000;
    if (opts.metadataOnly && (typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.messages) || !raw.messages.length ||
      raw.messages.some(m => !m || typeof m.id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(m.id)) ||
      new Set(raw.messages.map(m => m.id)).size !== raw.messages.length)) {
      throw new Error('Gmail returned malformed thread identities; historical metadata was preserved.');
    }
    const normalizedThreadId = typeof raw.id === 'string' && raw.id ? raw.id : threadId;
    let receiptBudget: number = GMAIL_MIME_LIMITS.receiptBytes;
    const messages: GmailMessageMeta[] = (raw.messages ?? []).map((m, index) => {
      const messageId = typeof m.id === 'string' && m.id ? m.id : `missing:${threadId}:${index}`;
      const fromRaw = header(m, 'From');
      const { text: rawText, isHtml } = opts.metadataOnly ? { text: '', isHtml: false } : extractBody(m.payload);
      // Pre-truncate before conversion: only the first `cap` output chars
      // survive, so a multi-hundred-KB marketing email must not pay ~15
      // full-body regex passes in htmlToText inside the per-thread hot loop.
      const text = truncateUtf8(rawText, cap * 16);
      let bodyText = isHtml ? htmlToText(text) : text;
      bodyText = trimQuotedReply(bodyText);
      if (bodyText.length > cap) bodyText = truncateUtf8(bodyText, cap) + '\n[truncated]';
      const internalDateMs = Number(m.internalDate ?? 0);
      const attachmentInspection = inspectGmailAttachments(m.payload, account, messageId, receiptBudget);
      receiptBudget -= Buffer.byteLength(JSON.stringify(attachmentInspection));
      return {
        id: messageId,
        threadId: normalizedThreadId,
        from: fromRaw,
        fromAddress: bareAddress(fromRaw),
        to: splitAddressList(header(m, 'To')),
        cc: splitAddressList(header(m, 'Cc')),
        subject: header(m, 'Subject'),
        dateIso: internalDateMs > 0 ? new Date(internalDateMs).toISOString() : new Date(0).toISOString(),
        internalDateMs,
        labelIds: m.labelIds ?? [],
        listUnsubscribe: header(m, 'List-Unsubscribe') !== '',
        autoSubmitted: isAutoSubmittedHeader(header(m, 'Auto-Submitted')),
        precedence: header(m, 'Precedence').trim().toLowerCase(),
        listId: header(m, 'List-Id') !== '',
        replyTo: splitAddressList(header(m, 'Reply-To')),
        calendarMethod: extractCalendarMethod(m.payload),
        bodyText,
        attachmentInspection,
      };
    });
    if (!opts.metadataOnly) {
      const budget = { bytes: ORIGINAL_LIMITS.threadBytes as number, count: 0 };
      for (const [index, message] of messages.entries()) {
        await fetchTextOriginals(message, raw.messages?.[index]?.payload, account,
          (id, handle) => this.fetchJSON(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(handle)}`, 'gmail',
            { ...opts, maxResponseBytes: ORIGINAL_LIMITS.bytes * 2 }), budget);
      }
    }
    messages.sort((a, b) => a.internalDateMs - b.internalDateMs);
    return { threadId: normalizedThreadId, account, messages };
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────────

interface RawCalendarEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; responseStatus?: string }>;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  visibility?: string;
}

function calendarEvent(e: RawCalendarEvent, account: string): CalendarEventData {
  return {
    id: e.id,
    ...(e.etag ? { etag: e.etag } : {}),
    summary: e.summary ?? '(no title)',
    description: e.description ?? '',
    startIso: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : ''),
    endIso: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : ''),
    allDay: Boolean(e.start?.date),
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: (a.email ?? '').toLowerCase(),
      displayName: a.displayName ?? null,
      self: a.self ?? false,
      responseStatus: a.responseStatus ?? null,
    })),
    location: e.location ?? null,
    hangoutLink: e.hangoutLink ?? null,
    htmlLink: e.htmlLink ?? null,
    status: e.status ?? 'confirmed',
    account,
    private: e.visibility === 'private' || e.visibility === 'confidential',
  };
}

export class CalendarClient extends GoogleApiClient {
  /**
   * Incremental when syncToken is set; windowed otherwise. Throws
   * GoogleCursorExpiredError(410) on an expired syncToken — caller drops the
   * token and re-runs windowed.
   */
  async listEvents(
    account: string,
    opts: {
      syncToken?: string | null;
      timeMinIso?: string;
      timeMaxIso?: string;
      signal?: AbortSignal;
      /** Calendar to sweep. Defaults to DEFAULT_CALENDAR_ID. A secondary calendar id is
       *  an address like `...@group.calendar.google.com`; each calendar gets
       *  its OWN gbrain source so their sync tokens never collide. */
      calendarId?: string;
    },
  ): Promise<{ events: CalendarEventData[]; nextSyncToken: string | null }> {
    let nextSyncToken: string | null = null;
    const calId = encodeURIComponent(opts.calendarId?.trim() || DEFAULT_CALENDAR_ID);
    const base = `${CALENDAR_BASE}/calendars/${calId}/events?maxResults=250&singleEvents=true`;
    const raw = await this.drainPages<RawCalendarEvent>(
      (t) => {
        const params = new URLSearchParams();
        if (opts.syncToken) params.set('syncToken', opts.syncToken);
        else {
          if (opts.timeMinIso) params.set('timeMin', opts.timeMinIso);
          if (opts.timeMaxIso) params.set('timeMax', opts.timeMaxIso);
        }
        if (t) params.set('pageToken', t);
        const qs = params.toString();
        return qs ? `${base}&${qs}` : base;
      },
      (body) => {
        if (typeof body.nextSyncToken === 'string') nextSyncToken = body.nextSyncToken;
        return {
          items: (body.items as RawCalendarEvent[] | undefined) ?? [],
          nextPageToken: (body.nextPageToken as string | undefined) ?? null,
        };
      },
      'calendar-json',
      opts,
    );
    return { events: raw.map((e) => calendarEvent(e, account)), nextSyncToken };
  }

  /**
   * GBRA-130 A-3: one event by id, for re-attempting a held event that no
   * listing of this run returns. Null when the event is gone (404/410).
   */
  async getEvent(account: string, calendarId: string, eventId: string, opts: { signal?: AbortSignal } = {}): Promise<CalendarEventData | null> {
    const calId = encodeURIComponent(calendarId.trim() || DEFAULT_CALENDAR_ID);
    try {
      return calendarEvent(await this.fetchJSON<RawCalendarEvent>(`${CALENDAR_BASE}/calendars/${calId}/events/${encodeURIComponent(eventId)}`, 'calendar-json', opts), account);
    } catch (e) {
      if (e instanceof GoogleCursorExpiredError) return null;
      throw e;
    }
  }

  /**
   * Enumerate every calendar the account can read (calendarList). Discovery
   * only — the sweep still reads ONE calendar per source, so this exists to
   * find the id you pass to `sources add --calendar-id`.
   */
  /**
   * #5012 item 9: one cheap read of the calendar's events (`maxResults=1`).
   * `readable: false` carries the 403/404 that says the account cannot read
   * it; any other failure throws.
   */
  async probeCalendar(calendarId: string, opts: { signal?: AbortSignal } = {}): Promise<{ readable: true } | { readable: false; httpStatus: 403 | 404 }> {
    try {
      await this.fetchJSON(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId.trim() || DEFAULT_CALENDAR_ID)}/events?maxResults=1&fields=kind`,
        'calendar-json', { ...opts, retries: 1, rateLimitRetries: 1 });
      return { readable: true };
    } catch (e) {
      const httpStatus = calendarUnreadableStatus(e);
      if (httpStatus === null) throw e;
      return { readable: false, httpStatus };
    }
  }

  async listCalendars(opts: { signal?: AbortSignal } = {}): Promise<
    Array<{ id: string; summary: string; primary: boolean; accessRole: string }>
  > {
    const base = `${CALENDAR_BASE}/users/me/calendarList?maxResults=250`;
    const raw = await this.drainPages<{
      id?: string;
      summary?: string;
      primary?: boolean;
      accessRole?: string;
    }>(
      (t) => (t ? `${base}&pageToken=${encodeURIComponent(t)}` : base),
      (body) => ({
        items: (body.items as Array<Record<string, unknown>> | undefined) ?? [],
        nextPageToken: (body.nextPageToken as string | undefined) ?? null,
      }),
      'calendar-json',
      opts,
    );
    return raw
      .filter((c) => typeof c.id === 'string' && c.id.length > 0)
      .map((c) => ({
        id: c.id as string,
        summary: c.summary ?? '(no name)',
        primary: Boolean(c.primary),
        accessRole: c.accessRole ?? 'unknown',
      }));
  }
}

// ── People (Contacts) ────────────────────────────────────────────────────────

interface RawPerson {
  resourceName: string;
  etag?: string;
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
  organizations?: Array<{ name?: string; title?: string; metadata?: { primary?: boolean } }>;
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>;
  metadata?: { deleted?: boolean };
}

interface RawContactGroup {
  resourceName?: string;
  name?: string;
  formattedName?: string;
  groupType?: string;
}

/**
 * #6324: the People field mask every contacts request carries. A syncToken is
 * only valid for requests with the parameters that minted it, so the sweep
 * records this string next to the token (`contacts_person_fields`) and
 * re-lists when it changes. Change it here and nowhere else.
 */
export const CONTACT_PERSON_FIELDS = 'names,emailAddresses,organizations,phoneNumbers,memberships';

/** Google's built-in groups (`contactGroups/myContacts`, `starred`, …) say nothing a page should carry. */
const SYSTEM_CONTACT_GROUPS = new Set(
  ['all', 'myContacts', 'starred', 'blocked', 'chatBuddies', 'friends', 'family', 'coworkers'].map((id) => `contactGroups/${id}`),
);

/** Bounded directory walk: 1000 groups a page, ten pages; past that the result is explicitly incomplete. */
const CONTACT_GROUP_PAGES = 10;

function contactData(p: RawPerson): ContactData {
  const primaryName = p.names?.find((n) => n.metadata?.primary) ?? p.names?.[0];
  const primaryOrg = p.organizations?.find((o) => o.metadata?.primary) ?? p.organizations?.[0];
  return {
    resourceName: p.resourceName,
    ...(p.etag ? { etag: p.etag } : {}),
    displayName: primaryName?.displayName ?? null,
    emails: (p.emailAddresses ?? [])
      .map((e) => (e.value ?? '').trim().toLowerCase())
      .filter((e) => e.includes('@')),
    phones: [...new Set((p.phoneNumbers ?? [])
      .map((n) => (n.canonicalForm ?? n.value ?? '').trim())
      .filter((n) => n.length > 0))],
    organization: primaryOrg?.name ?? null,
    title: primaryOrg?.title ?? null,
    groups: [...new Set((p.memberships ?? [])
      .map((m) => m.contactGroupMembership?.contactGroupResourceName ?? '')
      .filter((g) => g.startsWith('contactGroups/') && !SYSTEM_CONTACT_GROUPS.has(g)))]
      .map((id) => ({ id, name: null })),
    deleted: p.metadata?.deleted ?? false,
  };
}

export class PeopleClient extends GoogleApiClient {
  /** Incremental with syncToken; full otherwise. 410 → GoogleCursorExpiredError. */
  async listConnections(opts: {
    syncToken?: string | null;
    signal?: AbortSignal;
  }): Promise<{ contacts: ContactData[]; nextSyncToken: string | null }> {
    let nextSyncToken: string | null = null;
    const raw = await this.drainPages<RawPerson>(
      (t) => {
        const params = new URLSearchParams({
          personFields: CONTACT_PERSON_FIELDS,
          pageSize: '200',
          requestSyncToken: 'true',
        });
        if (opts.syncToken) params.set('syncToken', opts.syncToken);
        if (t) params.set('pageToken', t);
        return `${PEOPLE_BASE}/people/me/connections?${params.toString()}`;
      },
      (body) => {
        if (typeof body.nextSyncToken === 'string') nextSyncToken = body.nextSyncToken;
        return {
          items: (body.connections as RawPerson[] | undefined) ?? [],
          nextPageToken: (body.nextPageToken as string | undefined) ?? null,
        };
      },
      'people',
      opts,
    );
    return { contacts: raw.map(contactData), nextSyncToken };
  }

  /**
   * GBRA-130 A-3: one contact by resource name, for re-attempting a held
   * contact that no listing of this run returns. Null when it is gone (404/410).
   */
  async getContact(resourceName: string, opts: { signal?: AbortSignal } = {}): Promise<ContactData | null> {
    const path = resourceName.split('/').map(encodeURIComponent).join('/');
    try {
      return contactData(await this.fetchJSON<RawPerson>(`${PEOPLE_BASE}/${path}?personFields=${CONTACT_PERSON_FIELDS}`, 'people', opts));
    } catch (e) {
      if (e instanceof GoogleCursorExpiredError) return null;
      throw e;
    }
  }

  /**
   * #6324: the account's user-created contact groups, resource name → display
   * name. `complete` is false when the directory has more pages than the
   * bounded walk read; the caller keeps raw ids for whatever is missing
   * instead of treating one page as the whole directory.
   */
  async listContactGroups(opts: { signal?: AbortSignal } = {}): Promise<{ names: Record<string, string>; complete: boolean }> {
    let morePages = false;
    const raw = await this.drainPages<RawContactGroup>(
      (t) => {
        const params = new URLSearchParams({ pageSize: '1000', groupFields: 'name,groupType' });
        if (t) params.set('pageToken', t);
        return `${PEOPLE_BASE}/contactGroups?${params.toString()}`;
      },
      (body) => {
        const nextPageToken = (body.nextPageToken as string | undefined) ?? null;
        morePages = nextPageToken !== null;
        return { items: (body.contactGroups as RawContactGroup[] | undefined) ?? [], nextPageToken };
      },
      'people',
      { ...opts, maxPages: CONTACT_GROUP_PAGES, partialOk: true },
    );
    const names: Record<string, string> = {};
    for (const g of raw) {
      if (!g.resourceName || g.groupType === 'SYSTEM_CONTACT_GROUP' || SYSTEM_CONTACT_GROUPS.has(g.resourceName)) continue;
      const name = (g.formattedName ?? g.name ?? '').trim();
      if (name) names[g.resourceName] = name;
    }
    return { names, complete: !morePages };
  }
}
