/**
 * google-clients — client-behavior tests against a scripted fetchImpl.
 *
 * Covers: 401 → single token refresh + retry, 429 Retry-After honoring,
 * 403 accessNotConfigured → CredentialError 'api_not_enabled' with the
 * project deep link, 404/410 → GoogleCursorExpiredError, drainPages
 * pagination, and the Gmail/Calendar/People client normalizations
 * (MIME body extraction, quote trimming, cap, sorting, syncToken vs window).
 *
 * Synthetic data only: example.com addresses, hex message ids. No real
 * network — every request routes through the scripted fetchImpl, and the
 * token refresh path is served by the same script (no live OAuth).
 */
import { describe, expect, test } from 'bun:test';

import { CredentialError } from '../src/core/creds/errors.ts';
import { GoogleTokenProvider } from '../src/core/creds/providers/google.ts';
import type {
  CredentialEntry,
  CredentialMeta,
  CredentialVault,
  ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import {
  CalendarClient,
  GmailClient,
  GoogleApiClient,
  GoogleCursorExpiredError,
  PeopleClient,
  type FetchImpl,
} from '../src/core/google/google-clients.ts';

// ── In-memory vault (no filesystem, no token-refresh HTTP unless scripted) ──

class FakeVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string): Promise<CredentialEntry | null> {
    return this.entries.get(id) ?? null;
  }
  async put(entry: CredentialEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async list(): Promise<CredentialMeta[]> {
    return [];
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.clients.get(provider) ?? null;
  }
  async putClient(rec: ProviderClientRecord): Promise<void> {
    this.clients.set(rec.provider, rec);
  }
  async deleteClient(provider: string): Promise<boolean> {
    return this.clients.delete(provider);
  }
}

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function makeEntry(): CredentialEntry {
  return {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 't',
      refresh_token: 'r',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    meta: {
      account: 'a@example.com',
      sendas_aliases: ['alias@example.com'],
      connected_at: new Date().toISOString(),
      client_id: CLIENT_ID,
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Harness {
  vault: FakeVault;
  tokens: GoogleTokenProvider;
  fetchImpl: FetchImpl;
  calls: Array<{ url: string; auth: string | null }>;
  tokenPosts: () => number;
}

/** Every non-token request goes to `handler`; the token endpoint mints 't2'. */
function makeHarness(handler: (u: URL, init?: RequestInit) => Response | Promise<Response>): Harness {
  const vault = new FakeVault();
  vault.entries.set('google:a@example.com', makeEntry());
  vault.clients.set('google', {
    provider: 'google',
    client_id: CLIENT_ID,
    client_secret: 'GOCSPX-test-secret-0000',
    created_at: new Date().toISOString(),
  });
  const calls: Array<{ url: string; auth: string | null }> = [];
  let tokenPosts = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') {
      tokenPosts++;
      return json({ access_token: 't2', expires_in: 3600 });
    }
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ url, auth: headers.get('authorization') });
    return handler(u, init);
  };
  const tokens = new GoogleTokenProvider(vault, 'google:a@example.com', fetchImpl);
  return { vault, tokens, fetchImpl, calls, tokenPosts: () => tokenPosts };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── GoogleApiClient core: auth, retry, error mapping ─────────────────────────

describe('GoogleApiClient request core', () => {
  test('401 then success: refreshes the token exactly once and retries', async () => {
    let apiCalls = 0;
    const h = makeHarness(() => {
      apiCalls++;
      if (apiCalls === 1) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
      return json({ emailAddress: 'a@example.com', historyId: '77' });
    });
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const profile = await gmail.getProfile();
    expect(profile.emailAddress).toBe('a@example.com');
    expect(profile.historyId).toBe('77');
    expect(apiCalls).toBe(2);
    expect(h.tokenPosts()).toBe(1); // exactly one forceRefresh
    expect(h.calls[0].auth).toBe('Bearer t');
    expect(h.calls[1].auth).toBe('Bearer t2'); // retried with the refreshed token
    // The fake vault recorded the refresh.
    const entry = await h.vault.get('google:a@example.com');
    expect(entry?.secret.access_token).toBe('t2');
    expect(entry?.meta.last_refresh_ok_at).toBeDefined();
  });

  test('429 with Retry-After: 0 is retried', async () => {
    let apiCalls = 0;
    const h = makeHarness(() => {
      apiCalls++;
      if (apiCalls === 1) return json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
      return json({ emailAddress: 'a@example.com', historyId: '88' });
    });
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const profile = await gmail.getProfile();
    expect(profile.historyId).toBe('88');
    expect(apiCalls).toBe(2);
    expect(h.tokenPosts()).toBe(0); // no refresh on a rate limit
  });

  test('403 accessNotConfigured maps to api_not_enabled with the project deep link', async () => {
    const h = makeHarness(() =>
      json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Gmail API has not been used in project 123 before or it is disabled.',
            errors: [{ reason: 'accessNotConfigured' }],
          },
        },
        403,
      ),
    );
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    let thrown: unknown;
    try {
      await gmail.getProfile();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialError);
    const err = thrown as CredentialError;
    expect(err.code).toBe('api_not_enabled');
    expect(err.message).toContain('gmail.googleapis.com');
    expect(err.message).toContain('?project=123'); // project number from the client id
  });

  test('404 on history.list surfaces GoogleCursorExpiredError', async () => {
    const h = makeHarness(() => json({ error: { code: 404, message: 'not found' } }, 404));
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    let thrown: unknown;
    try {
      await gmail.listHistoryThreadIds('999');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GoogleCursorExpiredError);
    expect((thrown as GoogleCursorExpiredError).status).toBe(404);
  });

  test('drainPages follows nextPageToken and concatenates in order', async () => {
    const h = makeHarness((u) => {
      const t = u.searchParams.get('pageToken');
      if (!t) return json({ items: ['a1', 'a2'], nextPageToken: 'p2' });
      if (t === 'p2') return json({ items: ['b1'], nextPageToken: 'p3' });
      return json({ items: ['c1'] });
    });
    const client = new GoogleApiClient(h.tokens, h.fetchImpl);
    const items = await client.drainPages<string>(
      (t) => `https://gmail.googleapis.com/gmail/v1/fake?x=1${t ? `&pageToken=${t}` : ''}`,
      (body) => ({
        items: (body.items as string[] | undefined) ?? [],
        nextPageToken: (body.nextPageToken as string | undefined) ?? null,
      }),
      'gmail',
    );
    expect(items).toEqual(['a1', 'a2', 'b1', 'c1']);
    expect(h.calls.length).toBe(3);
  });

  test('drainPages throws when the page cap is hit', async () => {
    const h = makeHarness(() => json({ items: ['x'], nextPageToken: 'again' }));
    const client = new GoogleApiClient(h.tokens, h.fetchImpl);
    await expect(
      client.drainPages<string>(
        (t) => `https://gmail.googleapis.com/gmail/v1/fake${t ? `?pageToken=${t}` : ''}`,
        (body) => ({
          items: (body.items as string[] | undefined) ?? [],
          nextPageToken: (body.nextPageToken as string | undefined) ?? null,
        }),
        'gmail',
        { maxPages: 2 },
      ),
    ).rejects.toThrow(/pagination cap/);
  });
});

describe('GoogleApiClient retry exhaustion + 403 mapping', () => {
  test("always-429 (Retry-After: 0) exhausts the retries and maps to 'rate_limited'", async () => {
    let apiCalls = 0;
    const h = makeHarness(() => {
      apiCalls++;
      return json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
    });
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    let thrown: unknown;
    try {
      await gmail.getProfile();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialError);
    expect((thrown as CredentialError).code).toBe('rate_limited');
    // Default retries=2: attempts 0 and 1 are retried, attempt 2 throws.
    expect(apiCalls).toBe(3);
    expect(h.tokenPosts()).toBe(0); // a rate limit never triggers a token refresh
  });

  test("403 with a non-rate, non-quota reason maps to 'upstream' WITHOUT a retry", async () => {
    let apiCalls = 0;
    const h = makeHarness(() => {
      apiCalls++;
      return json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Access blocked by admin policy.',
            errors: [{ reason: 'domainPolicy' }],
          },
        },
        403,
      );
    });
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    let thrown: unknown;
    try {
      await gmail.getProfile();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialError);
    expect((thrown as CredentialError).code).toBe('upstream');
    expect((thrown as CredentialError).message).toContain('domainPolicy');
    expect(apiCalls).toBe(1); // fail-fast: no retry loop for a hard 403
    expect(h.tokenPosts()).toBe(0);
  });

  test('drainPages partialOk: returns the partial batch at maxPages instead of throwing', async () => {
    const h = makeHarness(() => json({ items: ['x'], nextPageToken: 'again' }));
    const client = new GoogleApiClient(h.tokens, h.fetchImpl);
    const build = (t: string | null): string =>
      `https://gmail.googleapis.com/gmail/v1/fake${t ? `?pageToken=${t}` : ''}`;
    const pick = (body: Record<string, unknown>) => ({
      items: (body.items as string[] | undefined) ?? [],
      nextPageToken: (body.nextPageToken as string | undefined) ?? null,
    });
    const partial = await client.drainPages<string>(build, pick, 'gmail', {
      maxPages: 2,
      partialOk: true,
    });
    // One item per page, two pages drained — the truncated batch comes back.
    expect(partial).toEqual(['x', 'x']);
    // Contrast: the SAME shape without partialOk still throws (reconciling
    // callers must never treat a truncated listing as complete).
    await expect(
      client.drainPages<string>(build, pick, 'gmail', { maxPages: 2 }),
    ).rejects.toThrow(/pagination cap/);
  });
});

// ── GmailClient ──────────────────────────────────────────────────────────────

describe('GmailClient', () => {
  test('listMessageIds passes q through and drains pages', async () => {
    const seenQ: Array<string | null> = [];
    const h = makeHarness((u) => {
      seenQ.push(u.searchParams.get('q'));
      const t = u.searchParams.get('pageToken');
      if (!t) {
        return json({
          messages: [{ id: '18c2f4a9b3d21e01', threadId: '17aa1111bbbb2222' }],
          nextPageToken: 'p2',
        });
      }
      return json({ messages: [{ id: '18c2f4a9b3d21e02', threadId: '17aa3333cccc4444' }] });
    });
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const ids = await gmail.listMessageIds('after:123 before:456');
    expect(ids).toEqual([
      { id: '18c2f4a9b3d21e01', threadId: '17aa1111bbbb2222' },
      { id: '18c2f4a9b3d21e02', threadId: '17aa3333cccc4444' },
    ]);
    expect(seenQ).toEqual(['after:123 before:456', 'after:123 before:456']);
  });

  test('listHistoryThreadIds dedupes thread ids across record kinds and returns the new cursor', async () => {
    const h = makeHarness(() =>
      json({
        historyId: '1010',
        history: [
          { messages: [{ threadId: '17aa1111bbbb2222' }] },
          { messagesAdded: [{ message: { threadId: '17aa1111bbbb2222' } }] },
          { labelsAdded: [{ message: { threadId: '17aa3333cccc4444' } }] },
        ],
      }),
    );
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const { threadIds, newHistoryId } = await gmail.listHistoryThreadIds('1000');
    expect(threadIds.sort()).toEqual(['17aa1111bbbb2222', '17aa3333cccc4444']);
    expect(newHistoryId).toBe('1010');
  });

  test('getThread: plain preferred, html stripped, quotes trimmed, oldest-first, listUnsubscribe', async () => {
    const rawThread = {
      id: '17aa1111bbbb2222',
      messages: [
        {
          // Newest served FIRST to prove the client sorts oldest-first.
          id: '18c2f4a9b3d21e03',
          threadId: '17aa1111bbbb2222',
          labelIds: ['SENT'],
          internalDate: String(Date.parse('2026-08-12T10:00:00Z')),
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'A Example <a@example.com>' },
              { name: 'To', value: 'charlie@example.com' },
              { name: 'Subject', value: 'Re: Zephyr roadmap' },
            ],
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: b64url('Sounds good.\n\nOn Mon, Aug 10, 2026 Charlie Example wrote:\n> earlier\n> more') },
              },
            ],
          },
        },
        {
          id: '18c2f4a9b3d21e01',
          threadId: '17aa1111bbbb2222',
          labelIds: [],
          internalDate: String(Date.parse('2026-08-10T09:00:00Z')),
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'Charlie Example <charlie@example.com>' },
              { name: 'To', value: 'a@example.com' },
              { name: 'Cc', value: 'dana@example.com' },
              { name: 'Subject', value: 'Zephyr roadmap' },
              { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' },
            ],
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('plain body wins') } },
              { mimeType: 'text/html', body: { data: b64url('<p>html body loses</p>') } },
            ],
          },
        },
        {
          id: '18c2f4a9b3d21e02',
          threadId: '17aa1111bbbb2222',
          labelIds: [],
          internalDate: String(Date.parse('2026-08-11T09:00:00Z')),
          payload: {
            mimeType: 'text/html',
            headers: [
              { name: 'From', value: 'Dana Example <dana@example.com>' },
              { name: 'To', value: 'a@example.com' },
              { name: 'Subject', value: 'Re: Zephyr roadmap' },
            ],
            body: { data: b64url('<div>Hello &amp; <b>welcome</b></div><br><div>Second line</div>') },
          },
        },
      ],
    };
    const h = makeHarness(() => json(rawThread));
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const thread = await gmail.getThread('17aa1111bbbb2222', 'a@example.com');

    expect(thread.threadId).toBe('17aa1111bbbb2222');
    expect(thread.account).toBe('a@example.com');
    // Sorted oldest-first regardless of the served order.
    expect(thread.messages.map((m) => m.id)).toEqual([
      '18c2f4a9b3d21e01',
      '18c2f4a9b3d21e02',
      '18c2f4a9b3d21e03',
    ]);

    const [first, second, third] = thread.messages;
    // text/plain preferred over text/html.
    expect(first.bodyText).toBe('plain body wins');
    expect(first.listUnsubscribe).toBe(true);
    expect(first.fromAddress).toBe('charlie@example.com');
    expect(first.to).toEqual(['a@example.com']);
    expect(first.cc).toEqual(['dana@example.com']);
    // html fallback stripped to text.
    expect(second.bodyText).toBe('Hello & welcome\n\nSecond line');
    expect(second.listUnsubscribe).toBe(false);
    // quoted tail trimmed.
    expect(third.bodyText).toBe('Sounds good.');
    expect(third.labelIds).toEqual(['SENT']);
  });

  test('getThread caps bodies at 8KB with a [truncated] marker', async () => {
    const rawThread = {
      id: '17aa5555dddd6666',
      messages: [
        {
          id: '18c2f4a9b3d21e04',
          threadId: '17aa5555dddd6666',
          labelIds: [],
          internalDate: String(Date.parse('2026-08-10T09:00:00Z')),
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Charlie Example <charlie@example.com>' },
              { name: 'To', value: 'a@example.com' },
              { name: 'Subject', value: 'Big body' },
            ],
            body: { data: b64url('x'.repeat(9_000)) },
          },
        },
      ],
    };
    const h = makeHarness(() => json(rawThread));
    const gmail = new GmailClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const thread = await gmail.getThread('17aa5555dddd6666', 'a@example.com');
    const body = thread.messages[0].bodyText;
    expect(body.endsWith('[truncated]')).toBe(true);
    expect(body.length).toBe(8_000 + '\n[truncated]'.length);
  });
});

// ── CalendarClient ───────────────────────────────────────────────────────────

const RAW_EVENTS = [
  {
    id: 'evt0000000000001',
    status: 'confirmed',
    summary: 'Zephyr planning',
    description: '<b>Agenda</b>',
    start: { dateTime: '2026-08-12T17:00:00Z' },
    end: { dateTime: '2026-08-12T18:00:00Z' },
    organizer: { email: 'A@Example.com' },
    attendees: [
      { email: 'A@Example.com', self: true, responseStatus: 'accepted' },
      { email: 'charlie@example.com', displayName: 'Charlie Example' },
    ],
    location: 'HQ',
    hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=evt0000000000001',
  },
  { id: 'evt0000000000002', status: 'cancelled', start: { date: '2026-08-13' }, end: { date: '2026-08-14' } },
];

describe('CalendarClient', () => {
  test('windowed listing sends timeMin/timeMax and normalizes events', async () => {
    const h = makeHarness((u) => {
      expect(u.searchParams.get('syncToken')).toBeNull();
      return json({ items: RAW_EVENTS, nextSyncToken: 'cal-1' });
    });
    const cal = new CalendarClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const { events, nextSyncToken } = await cal.listEvents('a@example.com', {
      timeMinIso: '2026-05-01T00:00:00.000Z',
      timeMaxIso: '2026-10-01T00:00:00.000Z',
    });
    expect(nextSyncToken).toBe('cal-1');
    expect(h.calls[0].url).toContain('timeMin=');
    expect(h.calls[0].url).toContain('timeMax=');
    expect(h.calls[0].url).toContain('singleEvents=true');

    expect(events.length).toBe(2);
    const [timed, allDay] = events;
    expect(timed.summary).toBe('Zephyr planning');
    expect(timed.organizer).toBe('a@example.com'); // lowercased
    expect(timed.attendees[0]).toEqual({ email: 'a@example.com', displayName: null, self: true, responseStatus: 'accepted' });
    expect(timed.attendees[1].displayName).toBe('Charlie Example');
    expect(timed.allDay).toBe(false);
    expect(timed.account).toBe('a@example.com');
    expect(allDay.allDay).toBe(true);
    expect(allDay.startIso).toBe('2026-08-13T00:00:00Z');
    expect(allDay.summary).toBe('(no title)');
    expect(allDay.status).toBe('cancelled');
  });

  test('syncToken listing sends syncToken instead of the window', async () => {
    const h = makeHarness((u) => {
      expect(u.searchParams.get('syncToken')).toBe('cal-1');
      expect(u.searchParams.get('timeMin')).toBeNull();
      return json({ items: [], nextSyncToken: 'cal-2' });
    });
    const cal = new CalendarClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const { events, nextSyncToken } = await cal.listEvents('a@example.com', { syncToken: 'cal-1' });
    expect(events).toEqual([]);
    expect(nextSyncToken).toBe('cal-2');
  });

  test('410 on an expired syncToken surfaces GoogleCursorExpiredError', async () => {
    const h = makeHarness(() => json({ error: { code: 410, message: 'Sync token is no longer valid' } }, 410));
    const cal = new CalendarClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    let thrown: unknown;
    try {
      await cal.listEvents('a@example.com', { syncToken: 'stale' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GoogleCursorExpiredError);
    expect((thrown as GoogleCursorExpiredError).status).toBe(410);
  });
});

// ── PeopleClient ─────────────────────────────────────────────────────────────

describe('PeopleClient', () => {
  test('listConnections requests personFields and normalizes contacts', async () => {
    const h = makeHarness((u) => {
      expect(u.searchParams.get('personFields')).toBe('names,emailAddresses,organizations');
      expect(u.searchParams.get('requestSyncToken')).toBe('true');
      return json({
        connections: [
          {
            resourceName: 'people/c000000001',
            names: [
              { displayName: 'Secondary Example' },
              { displayName: 'Alice Example', metadata: { primary: true } },
            ],
            emailAddresses: [{ value: ' Alice@Example.com ' }, { value: 'not-an-email' }],
            organizations: [{ name: 'Acme Example', title: 'Engineer', metadata: { primary: true } }],
          },
          { resourceName: 'people/c000000002', metadata: { deleted: true } },
        ],
        nextSyncToken: 'ppl-1',
      });
    });
    const people = new PeopleClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const { contacts, nextSyncToken } = await people.listConnections({});
    expect(nextSyncToken).toBe('ppl-1');
    expect(contacts.length).toBe(2);
    expect(contacts[0]).toEqual({
      resourceName: 'people/c000000001',
      displayName: 'Alice Example', // primary name wins
      emails: ['alice@example.com'], // trimmed, lowercased, non-addresses dropped
      organization: 'Acme Example',
      title: 'Engineer',
      deleted: false,
    });
    expect(contacts[1].deleted).toBe(true);
    expect(contacts[1].displayName).toBeNull();
    expect(contacts[1].emails).toEqual([]);
  });

  test('syncToken is forwarded; 410 surfaces GoogleCursorExpiredError', async () => {
    const h = makeHarness((u) => {
      if (u.searchParams.get('syncToken') === 'stale') {
        return json({ error: { code: 410, message: 'Sync token expired' } }, 410);
      }
      expect(u.searchParams.get('syncToken')).toBe('ppl-1');
      return json({ connections: [], nextSyncToken: 'ppl-2' });
    });
    const people = new PeopleClient(h.tokens, h.fetchImpl, () => {}, CLIENT_ID);
    const ok = await people.listConnections({ syncToken: 'ppl-1' });
    expect(ok.nextSyncToken).toBe('ppl-2');
    let thrown: unknown;
    try {
      await people.listConnections({ syncToken: 'stale' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GoogleCursorExpiredError);
    expect((thrown as GoogleCursorExpiredError).status).toBe(410);
  });
});
