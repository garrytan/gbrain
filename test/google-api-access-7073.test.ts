/**
 * #7073: the Google account resolves through OAuth userinfo when no enabled
 * service can name it, a disabled API carries its project and the enable
 * link from Google's error body, an insufficient-scope 403 is scope_missing
 * (not an unreadable calendar), and one probe names every blocked service.
 *
 * Synthetic responses only: example.invalid addresses, made-up project
 * numbers, no network.
 */
import { describe, expect, test } from 'bun:test';
import { CredentialError } from '../src/core/creds/errors.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';
import { CalendarClient, GmailClient, GoogleApiDisabledError, PeopleClient, calendarUnreadableStatus, type FetchImpl } from '../src/core/google/google-clients.ts';
import { probeGoogleApiAccess, type GoogleIdentityClients } from '../src/core/google/api-access.ts';
import { resolveGoogleAccount } from '../src/core/persistence/connector-account.ts';

const OWNER = 'owner@example.invalid';
const PROJECT = '987654321';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const tokens = { getAccessToken: async () => 'token', forceRefresh: async () => 'token' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Google's 403 for an API disabled in the project (ErrorInfo SERVICE_DISABLED with the activation link). */
function serviceDisabled(api: string, title: string): Response {
  const url = `https://console.developers.google.com/apis/api/${api}/overview?project=${PROJECT}`;
  return json({ error: { code: 403, status: 'PERMISSION_DENIED',
    message: `${title} has not been used in project ${PROJECT} before or it is disabled. Enable it by visiting ${url} then retry.`,
    errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }],
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com',
        metadata: { service: api, consumer: `projects/${PROJECT}`, activationUrl: url, serviceTitle: title, containerInfo: PROJECT } },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Google developers console API activation', url }] },
    ] } }, 403);
}

const insufficientScopes = () => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.',
  errors: [{ reason: 'insufficientPermissions', domain: 'global' }],
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com' }] } }, 403);

interface Routes { gmail?: () => Response; calendar?: () => Response; people?: () => Response; userinfo?: () => Response }

function clientsFor(routes: Routes): { clients: GoogleIdentityClients; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('/users/me/profile')) return routes.gmail?.() ?? json({ emailAddress: OWNER, historyId: '1' });
    if (path.endsWith('/calendars/primary')) return routes.calendar?.() ?? json({ id: OWNER });
    if (path.endsWith('/people/me')) return routes.people?.() ?? json({ emailAddresses: [{ value: OWNER, metadata: { primary: true } }] });
    if (path.endsWith('/people/me/connections')) return routes.people?.() ?? json({ connections: [] });
    if (path.endsWith('/userinfo')) return routes.userinfo?.() ?? json({ email: OWNER });
    throw new Error(`unexpected route ${url}`);
  };
  const args = [tokens, fetchImpl, () => {}, CLIENT_ID] as const;
  return {
    calls,
    clients: { gmail: new GmailClient(...args), calendar: new CalendarClient(...args), people: new PeopleClient(...args),
      userinfo: async () => ((await (await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo')).json()) as { email?: string }).email },
  };
}

describe('#7073 disabled API errors carry the project and the enable link from the body', () => {
  test('SERVICE_DISABLED names the API, its title, the project and the activation URL', async () => {
    const { clients } = clientsFor({ gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API') });
    const error = await clients.gmail.getProfile().catch(e => e);
    expect(error).toBeInstanceOf(GoogleApiDisabledError);
    expect(error).toMatchObject({ code: 'api_not_enabled', api: 'gmail.googleapis.com', apiTitle: 'Gmail API', project: PROJECT,
      enableUrl: `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${PROJECT}` });
    expect((error as CredentialError).fix).toContain(`overview?project=${PROJECT}`);
  });

  test('a link that is not a Google Cloud console URL is never relayed', async () => {
    const { clients } = clientsFor({ people: () => json({ error: { code: 403, message: 'People API is disabled.', errors: [{ reason: 'accessNotConfigured' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://attacker.example.invalid/enable' } }] } }, 403) });
    const error = await clients.people.fetchJSON('https://people.googleapis.com/v1/people/me', 'people').catch(e => e) as GoogleApiDisabledError;
    expect(error.enableUrl).toBe('https://console.cloud.google.com/apis/library/people.googleapis.com?project=123');
    expect(error.api).toBe('people.googleapis.com');
  });

  test('an insufficient-scope 403 is scope_missing, never an unreadable calendar', async () => {
    const { clients } = clientsFor({ calendar: insufficientScopes });
    const error = await clients.calendar.fetchJSON('https://www.googleapis.com/calendar/v3/calendars/primary', 'calendar-json').catch(e => e);
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe('scope_missing');
    expect(calendarUnreadableStatus(error)).toBeNull();
  });
});

describe('#7073 resolveGoogleAccount falls back to userinfo', () => {
  test('disabled Gmail with a valid userinfo resolves the account and keeps api_not_enabled in the result', async () => {
    const { clients, calls } = clientsFor({ gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API') });
    const resolution = await resolveGoogleAccount(clients, ['gmail']);
    expect(resolution.email).toBe(OWNER);
    expect(resolution.via).toBe('userinfo');
    expect(resolution.errors.gmail).toBeInstanceOf(GoogleApiDisabledError);
    expect(resolution.errors.gmail).toMatchObject({ code: 'api_not_enabled', project: PROJECT });
    expect(calls.some(url => url.endsWith('/v1/userinfo'))).toBe(true);
  });

  test('every service disabled or ungranted with userinfo working resolves through userinfo', async () => {
    const { clients } = clientsFor({
      gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API'),
      calendar: insufficientScopes,
      people: () => serviceDisabled('people.googleapis.com', 'People API'),
    });
    const resolution = await resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts']);
    expect(resolution).toMatchObject({ email: OWNER, via: 'userinfo' });
    expect(Object.keys(resolution.errors)).toEqual(['gmail', 'calendar', 'contacts']);
    expect((resolution.errors.calendar as CredentialError).code).toBe('scope_missing');
  });

  test('userinfo is not called when a service names the account', async () => {
    const { clients, calls } = clientsFor({ gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API') });
    expect(await resolveGoogleAccount(clients, ['gmail', 'calendar'])).toMatchObject({ email: OWNER, via: 'calendar' });
    expect(calls.some(url => url.endsWith('/v1/userinfo'))).toBe(false);
  });

  test('with userinfo failing too, the disabled API is the refusal', async () => {
    const { clients } = clientsFor({ gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API') });
    const resolution = resolveGoogleAccount({ ...clients, userinfo: async () => { throw new CredentialError('upstream', ': userinfo HTTP 401'); } }, ['gmail']);
    await expect(resolution).rejects.toMatchObject({ code: 'api_not_enabled', project: PROJECT });
  });
});

describe('#7073 one probe names every disabled API and missing scope', () => {
  test('Gmail and People disabled plus an ungranted Calendar scope: three problems, one ask_user fix with every link', async () => {
    const { clients, calls } = clientsFor({
      gmail: () => serviceDisabled('gmail.googleapis.com', 'Gmail API'),
      people: () => serviceDisabled('people.googleapis.com', 'People API'),
    });
    const granted = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/contacts.readonly'];
    const report = await probeGoogleApiAccess(clients, OWNER, ['gmail', 'calendar', 'contacts'], granted);
    expect(report.resolved_account).toBe(OWNER);
    expect(report.resolved_via).toBe('userinfo');
    expect(report.problems.map(p => [p.service, p.code, p.project])).toEqual([
      ['gmail', 'api_not_enabled', PROJECT], ['calendar', 'scope_missing', null], ['contacts', 'api_not_enabled', PROJECT],
    ]);
    expect(report.services).toEqual({ gmail: { status: 'api_not_enabled' }, calendar: { status: 'scope_missing' }, contacts: { status: 'api_not_enabled' } });
    // The ungranted service is not requested; both disabled ones are.
    expect(calls.some(url => url.includes('/calendars/primary'))).toBe(false);
    const fix = renderAction(report.fix!, cliRenderContext());
    expect(fix.next).toBe('ask_user');
    expect(fix.user_message).toContain(`https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${PROJECT}`);
    expect(fix.user_message).toContain(`https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=${PROJECT}`);
    expect(fix.user_message).toContain(`gbrain google connect --reauth ${OWNER}`);
    expect(fix.verify).toEqual({ argv: ['gbrain', 'google', 'status', '--json'] });
  });

  test('a missing scope alone is the reauth command for the user to run', async () => {
    const { clients } = clientsFor({ calendar: insufficientScopes });
    const report = await probeGoogleApiAccess(clients, OWNER, ['gmail', 'calendar'], []);
    expect(report.problems.map(p => p.code)).toEqual(['scope_missing']);
    const fix = renderAction(report.fix!, cliRenderContext());
    expect(fix.next).toBe('tell_user_to_run');
    expect(fix.argv).toEqual(['gbrain', 'google', 'connect', '--reauth', OWNER]);
  });

  test('every service reachable: no problems and no fix', async () => {
    const { clients } = clientsFor({});
    const report = await probeGoogleApiAccess(clients, OWNER, ['gmail', 'calendar', 'contacts'], []);
    expect(report).toMatchObject({ resolved_account: OWNER, resolved_via: 'gmail', problems: [] });
    expect(report.fix).toBeUndefined();
    expect(report.services).toEqual({ gmail: { status: 'ok' }, calendar: { status: 'ok' }, contacts: { status: 'ok' } });
  });
});
