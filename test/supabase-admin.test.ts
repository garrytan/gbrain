import { describe, test, expect, afterEach } from 'bun:test';
import { discoverPoolerUrl, extractProjectRef, listProjects } from '../src/core/supabase-admin.ts';

// ---------------------------------------------------------------------------
// Management-API fetch mocking. All calls go through the module's apiFetch →
// globalThis.fetch; stub it per test and ALWAYS restore (no live network).
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('extractProjectRef', () => {
  test('extracts from dashboard URL', () => {
    expect(extractProjectRef('https://supabase.com/dashboard/project/rqfedtbsqoxrobdwfrsk/settings/database'))
      .toBe('rqfedtbsqoxrobdwfrsk');
  });

  test('extracts from direct connection URL', () => {
    expect(extractProjectRef('postgresql://postgres:password@db.rqfedtbsqoxrobdwfrsk.supabase.co:5432/postgres'))
      .toBe('rqfedtbsqoxrobdwfrsk');
  });

  test('extracts from pooler URL', () => {
    expect(extractProjectRef('postgresql://postgres.rqfedtbsqoxrobdwfrsk:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres'))
      .toBe('rqfedtbsqoxrobdwfrsk');
  });

  test('extracts from project URL', () => {
    expect(extractProjectRef('https://rqfedtbsqoxrobdwfrsk.supabase.co'))
      .toBe('rqfedtbsqoxrobdwfrsk');
  });

  test('returns null for non-supabase URL', () => {
    expect(extractProjectRef('postgresql://user:pass@localhost:5432/mydb')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractProjectRef('')).toBeNull();
  });

  test('returns null for random text', () => {
    expect(extractProjectRef('hello world')).toBeNull();
  });

  test('accepts alphanumeric refs (digits allowed — the [a-z]+-only regression)', () => {
    expect(extractProjectRef('https://supabase.com/dashboard/project/abc123xyz/settings/database'))
      .toBe('abc123xyz');
    expect(extractProjectRef('postgresql://postgres:password@db.abc123xyz.supabase.co:5432/postgres'))
      .toBe('abc123xyz');
    expect(extractProjectRef('https://abc123xyz.supabase.co')).toBe('abc123xyz');
  });
});

describe('listProjects', () => {
  test('200 → parsed project list; rows without a string id are dropped', async () => {
    stubFetch(() => jsonResponse([
      { id: 'abc123xyz', name: 'brain', region: 'us-east-1' },
      { id: 'noname456' }, // name falls back to id
      { name: 'id-less junk row' }, // filtered out
    ]));
    const projects = await listProjects('sbp_test_token');
    expect(projects).toEqual([
      { id: 'abc123xyz', name: 'brain', region: 'us-east-1' },
      { id: 'noname456', name: 'noname456', region: undefined },
    ]);
  });

  test('401 → invalid-token error (actionable, names the token page)', async () => {
    stubFetch(() => jsonResponse({ message: 'unauthorized' }, 401, 'Unauthorized'));
    await expect(listProjects('sbp_bad')).rejects.toThrow('Invalid Supabase access token');
  });

  test('non-200 non-401 → API error with the status', async () => {
    stubFetch(() => jsonResponse({ message: 'boom' }, 503, 'Service Unavailable'));
    await expect(listProjects('sbp_test')).rejects.toThrow('Supabase API error listing projects: 503');
  });

  test('the request is constructed WITH an AbortSignal (bounded-timeout contract)', async () => {
    // Never wait out the real ~10s timeout — the CONTRACT is that every
    // Management-API fetch carries a signal, so an unresponsive
    // api.supabase.com can never hang a headless init.
    const calls = stubFetch(() => jsonResponse([]));
    await listProjects('sbp_test');
    expect(calls.length).toBe(1);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    // And the auth header rides the same init.
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer sbp_test');
  });
});

describe('discoverPoolerUrl', () => {
  test('returns the API-reported connection string when present', async () => {
    stubFetch((url) => {
      if (url.endsWith('/config/database')) {
        return jsonResponse({
          connection_string: 'postgresql://postgres.abc123xyz:[YOUR-PASSWORD]@example.pooler.supabase.com:6543/postgres', /* allow-pg-url-literal */
        });
      }
      return jsonResponse({ ok: true });
    });
    const url = await discoverPoolerUrl('sbp_test', 'abc123xyz');
    expect(url).toContain('postgres.abc123xyz');
  });

  test('NO constructed aws-0 fallback: a hostless API answer THROWS with dashboard guidance', async () => {
    // The old behavior guessed `aws-0-<region>.pooler.supabase.com` when the
    // API returned no connection string (NXDOMAIN on prefix miss + wrong
    // port class). Pin the current contract: honest throw, never a
    // fabricated URL.
    stubFetch((url) => {
      if (url.endsWith('/config/database')) return jsonResponse({}); // no connection_string
      return jsonResponse({ ok: true });
    });
    let thrown: unknown;
    try {
      await discoverPoolerUrl('sbp_test', 'abc123xyz');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('did not return a connection string');
    expect(msg).toContain('gbrain init --url');
    expect(msg).not.toContain('aws-0');
  });

  test('404 on the project endpoint → project-not-found error', async () => {
    stubFetch(() => jsonResponse({ message: 'nope' }, 404, 'Not Found'));
    await expect(discoverPoolerUrl('sbp_test', 'missing123')).rejects.toThrow('Project not found: missing123');
  });
});
