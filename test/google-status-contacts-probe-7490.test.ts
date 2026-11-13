/**
 * #7490: `gbrain google status` probes Contacts with a People request that
 * `contacts.readonly` covers. `people/me` now needs the `profile` scope,
 * which `gbrain google connect` never requests, so probing it reported a 403
 * error on a healthy, fully consented account. The probe lists one connection
 * instead, the request the contacts sweep itself makes.
 *
 * Synthetic responses only: example.invalid addresses, no network.
 */
import { describe, expect, test } from 'bun:test';
import { CalendarClient, GmailClient, PeopleClient, type FetchImpl } from '../src/core/google/google-clients.ts';
import { probeGoogleApiAccess, type GoogleIdentityClients } from '../src/core/google/api-access.ts';
import { resolveGoogleAccount } from '../src/core/persistence/connector-account.ts';

const OWNER = 'owner@example.invalid';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const GRANTED = ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/contacts.readonly'];
const tokens = { getAccessToken: async () => 'token', forceRefresh: async () => 'token' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Google's current answer to people/me for a token without the profile scope. */
const profileScopeRequired = () => json({ error: { code: 403, status: 'PERMISSION_DENIED',
  message: 'The caller does not have permission to request "people/me". Request requires one of the following scopes: [profile].' } }, 403);

function clients(): { clients: GoogleIdentityClients; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('/users/me/profile')) return json({ emailAddress: OWNER, historyId: '1' });
    if (path.endsWith('/calendars/primary')) return json({ id: OWNER });
    if (path.endsWith('/people/me')) return profileScopeRequired();
    if (path.endsWith('/people/me/connections')) return json({ connections: [{ resourceName: 'people/c1', emailAddresses: [{ value: 'alice@example.invalid' }] }], totalPeople: 1 });
    if (path.endsWith('/userinfo')) return json({ email: OWNER });
    throw new Error(`unexpected route ${url}`);
  };
  const args = [tokens, fetchImpl, () => {}, CLIENT_ID] as const;
  return { calls, clients: { gmail: new GmailClient(...args), calendar: new CalendarClient(...args), people: new PeopleClient(...args),
    userinfo: async () => ((await (await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo')).json()) as { email?: string }).email } };
}

describe('#7490 the Contacts probe needs only contacts.readonly', () => {
  test('a granted contacts.readonly reports Contacts ok while people/me demands the profile scope', async () => {
    const { clients: c, calls } = clients();
    const report = await probeGoogleApiAccess(c, OWNER, ['gmail', 'calendar', 'contacts'], GRANTED);
    expect(report.services.contacts).toEqual({ status: 'ok' });
    expect(report.problems).toEqual([]);
    expect(report.fix).toBeUndefined();
    const people = calls.filter(url => url.includes('people.googleapis.com'));
    expect(people.map(url => new URL(url).pathname)).toEqual(['/v1/people/me/connections']);
    const params = new URL(people[0]!).searchParams;
    expect([params.get('pageSize'), params.get('personFields')]).toEqual(['1', 'emailAddresses']);
  });

  test('Contacts alone resolves the account through userinfo, never from a contact\'s address', async () => {
    const { clients: c } = clients();
    const report = await probeGoogleApiAccess(c, OWNER, ['contacts'], GRANTED);
    expect(report).toMatchObject({ resolved_account: OWNER, resolved_via: 'userinfo', problems: [] });
    expect(report.services).toEqual({ contacts: { status: 'ok' } });
  });

  test('a Contacts-only managed sync pins the same account, through userinfo', async () => {
    const { clients: c, calls } = clients();
    const resolution = await resolveGoogleAccount(c, ['contacts']);
    expect(resolution).toMatchObject({ email: OWNER, via: 'userinfo' });
    expect(resolution.errors).toEqual({});
    expect(calls.some(url => new URL(url).pathname === '/v1/people/me')).toBe(false);
  });
});
