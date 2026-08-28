/**
 * google-clients — fetch clients for the Gmail / Calendar / People REST APIs.
 *
 * Hand-rolled (no googleapis dep, house style — see github-source.ts):
 *  - auth via GoogleTokenProvider (vault-backed, auto-refreshing)
 *  - 401 → forceRefresh() + single retry
 *  - 403/429 → Retry-After honored (delta-seconds AND http-date)
 *  - 403 accessNotConfigured → CredentialError 'api_not_enabled' with the
 *    exact enable deep link (project number extracted from the client id)
 *  - uniform pageToken pagination with a safety cap
 *  - fetchImpl injectable for tests
 */

import { CredentialError } from '../creds/errors.ts';
import type { GoogleAccessProvider } from './access.ts';
import { apiEnableLink } from '../creds/providers/google.ts';
import { parseRetryAfterMs } from '../github-source.ts';
import {
  bareAddress,
  splitAddressList,
  type CalendarEventData,
  type ContactData,
  type GmailMessageMeta,
  type GmailThreadData,
} from './types.ts';
import { htmlToText, trimQuotedReply } from './google-render.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const PEOPLE_BASE = 'https://people.googleapis.com/v1';

const PAGINATION_CAP = 500;

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string }>;
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
    opts: { signal?: AbortSignal; retries?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const token = await this.tokens.getAccessToken();
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 && attempt < retries) {
        this.log('[google] HTTP 401; refreshing access token');
        await this.tokens.forceRefresh();
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
      if (res.status === 403) {
        const reason = body.error?.errors?.[0]?.reason ?? '';
        const msg = body.error?.message ?? '';
        if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(msg)) {
          throw new CredentialError('api_not_enabled', apiEnableLink(apiHint, this.clientId));
        }
        if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || /rate/i.test(msg)) {
          // fall through to the retry-after sleep below
        } else if (!/quota/i.test(`${reason} ${msg}`)) {
          throw new CredentialError('upstream', `: HTTP 403 ${reason || msg} on ${apiHint}`);
        }
      }
      if (res.status === 403 || res.status === 429) {
        const waitMs = parseRetryAfterMs(res.headers.get('retry-after')) ?? Math.min(60_000, 2 ** attempt * 2_000);
        if (attempt < retries) {
          this.log(`[google] HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s`);
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

// ── Gmail ────────────────────────────────────────────────────────────────────

interface RawGmailHeader {
  name: string;
  value: string;
}

interface RawGmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: RawGmailPart[];
}

interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: RawGmailPart & { headers?: RawGmailHeader[] };
}

interface RawGmailThread {
  id: string;
  historyId?: string;
  messages?: RawGmailMessage[];
}

function header(msg: RawGmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

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
  const stack: RawGmailPart[] = [part];
  let html: string | null = null;
  while (stack.length > 0) {
    const p = stack.shift()!;
    if (p.mimeType === 'text/plain' && p.body?.data) {
      return { text: decodeB64Url(p.body.data), isHtml: false };
    }
    if (p.mimeType === 'text/html' && p.body?.data && html === null) {
      html = decodeB64Url(p.body.data);
    }
    if (p.parts) stack.push(...p.parts);
  }
  if (html !== null) return { text: html, isHtml: true };
  // Single-part messages sometimes carry data at the top level with no mimeType match.
  if (part.body?.data) return { text: decodeB64Url(part.body.data), isHtml: false };
  return { text: '', isHtml: false };
}

export class GmailClient extends GoogleApiClient {
  async getProfile(opts: { signal?: AbortSignal } = {}): Promise<{ emailAddress: string; historyId: string }> {
    return this.fetchJSON(`${GMAIL_BASE}/users/me/profile`, 'gmail', opts);
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
   */
  async listHistoryThreadIds(
    startHistoryId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ threadIds: string[]; newHistoryId: string | null }> {
    const threadIds = new Set<string>();
    let newHistoryId: string | null = null;
    await this.drainPages(
      (t) =>
        `${GMAIL_BASE}/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&maxResults=100${t ? `&pageToken=${encodeURIComponent(t)}` : ''}`,
      (body) => {
        if (typeof body.historyId === 'string') newHistoryId = body.historyId;
        const records = (body.history as Array<Record<string, unknown>> | undefined) ?? [];
        for (const rec of records) {
          for (const key of ['messages', 'messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
            const arr = rec[key] as Array<{ threadId?: string; message?: { threadId?: string } }> | undefined;
            for (const m of arr ?? []) {
              const tid = m.threadId ?? m.message?.threadId;
              if (tid) threadIds.add(tid);
            }
          }
        }
        return { items: [], nextPageToken: (body.nextPageToken as string | undefined) ?? null };
      },
      'gmail',
      opts,
    );
    return { threadIds: [...threadIds], newHistoryId };
  }

  async getThread(
    threadId: string,
    account: string,
    opts: { signal?: AbortSignal; bodyCapChars?: number } = {},
  ): Promise<GmailThreadData> {
    const raw = await this.fetchJSON<RawGmailThread>(
      `${GMAIL_BASE}/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
      'gmail',
      opts,
    );
    const cap = opts.bodyCapChars ?? 8_000;
    const messages: GmailMessageMeta[] = (raw.messages ?? []).map((m) => {
      const fromRaw = header(m, 'From');
      const { text: rawText, isHtml } = extractBody(m.payload);
      // Pre-truncate before conversion: only the first `cap` output chars
      // survive, so a multi-hundred-KB marketing email must not pay ~15
      // full-body regex passes in htmlToText inside the per-thread hot loop.
      const text = rawText.length > cap * 16 ? rawText.slice(0, cap * 16) : rawText;
      let bodyText = isHtml ? htmlToText(text) : text;
      bodyText = trimQuotedReply(bodyText);
      if (bodyText.length > cap) bodyText = bodyText.slice(0, cap) + '\n[truncated]';
      const internalDateMs = Number(m.internalDate ?? 0);
      return {
        id: m.id,
        threadId: raw.id,
        from: fromRaw,
        fromAddress: bareAddress(fromRaw),
        to: splitAddressList(header(m, 'To')),
        cc: splitAddressList(header(m, 'Cc')),
        subject: header(m, 'Subject'),
        dateIso: internalDateMs > 0 ? new Date(internalDateMs).toISOString() : new Date(0).toISOString(),
        internalDateMs,
        labelIds: m.labelIds ?? [],
        listUnsubscribe: header(m, 'List-Unsubscribe') !== '',
        bodyText,
      };
    });
    messages.sort((a, b) => a.internalDateMs - b.internalDateMs);
    return { threadId: raw.id, account, messages };
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────────

interface RawCalendarEvent {
  id: string;
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
    },
  ): Promise<{ events: CalendarEventData[]; nextSyncToken: string | null }> {
    let nextSyncToken: string | null = null;
    const base = `${CALENDAR_BASE}/calendars/primary/events?maxResults=250&singleEvents=true`;
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
    const events = raw.map((e): CalendarEventData => ({
      id: e.id,
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
    }));
    return { events, nextSyncToken };
  }
}

// ── People (Contacts) ────────────────────────────────────────────────────────

interface RawPerson {
  resourceName: string;
  names?: Array<{ displayName?: string; metadata?: { primary?: boolean } }>;
  emailAddresses?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string; title?: string; metadata?: { primary?: boolean } }>;
  metadata?: { deleted?: boolean };
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
          personFields: 'names,emailAddresses,organizations',
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
    const contacts = raw.map((p): ContactData => {
      const primaryName = p.names?.find((n) => n.metadata?.primary) ?? p.names?.[0];
      const primaryOrg = p.organizations?.find((o) => o.metadata?.primary) ?? p.organizations?.[0];
      return {
        resourceName: p.resourceName,
        displayName: primaryName?.displayName ?? null,
        emails: (p.emailAddresses ?? [])
          .map((e) => (e.value ?? '').trim().toLowerCase())
          .filter((e) => e.includes('@')),
        organization: primaryOrg?.name ?? null,
        title: primaryOrg?.title ?? null,
        deleted: p.metadata?.deleted ?? false,
      };
    });
    return { contacts, nextSyncToken };
  }
}
