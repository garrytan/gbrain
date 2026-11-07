/**
 * #7004/#7073: which account a Google credential belongs to, and which of the
 * Gmail, Calendar and People APIs it can reach.
 *
 * `probeGoogleAccount` checks each enabled service (Gmail profile, Calendar
 * primary calendar, People connections) and, when none names the account, the
 * OAuth userinfo endpoint (the `email` scope is always requested). Every
 * per-service failure stays in the result: the managed sync uses the first
 * address it finds, while `gbrain google setup` and `gbrain google status`
 * probe every service and name each disabled API or missing scope at once.
 */
import { CredentialError } from '../creds/errors.ts';
import { GOOGLE_SERVICE_SCOPES, fetchUserinfoEmail } from '../creds/providers/google.ts';
import type { Action } from '../agent-output.ts';
import type { GoogleAccessProvider } from './access.ts';
import { CalendarClient, GmailClient, GoogleApiDisabledError, PeopleClient, type FetchImpl } from './google-clients.ts';
import { ALL_GOOGLE_SERVICES, GOOGLE_SERVICE_API, type GoogleApiProblem, type GoogleService } from './types.ts';

export interface GoogleIdentityClients {
  gmail: Pick<GmailClient, 'getProfile'>;
  calendar: Pick<CalendarClient, 'fetchJSON'>;
  people: Pick<PeopleClient, 'fetchJSON'>;
  userinfo: () => Promise<string | undefined>;
}

export interface GoogleAccountProbe {
  /** Lower-cased address, or null when nothing named the account. */
  email: string | null;
  via: GoogleService | 'userinfo' | null;
  /** Each attempt that threw, in attempt order. */
  errors: Partial<Record<GoogleService | 'userinfo', unknown>>;
}

/** The clients a probe needs for one token source. */
export function googleIdentityClients(tokens: GoogleAccessProvider, clientId: string | undefined, fetchImpl: FetchImpl = fetch): GoogleIdentityClients {
  const args = [tokens, fetchImpl, () => {}, clientId] as const;
  return { gmail: new GmailClient(...args), calendar: new CalendarClient(...args), people: new PeopleClient(...args), userinfo: googleUserinfo(tokens, fetchImpl) };
}

export function googleUserinfo(tokens: GoogleAccessProvider, fetchImpl: FetchImpl = fetch): () => Promise<string> {
  return async () => fetchUserinfoEmail(await tokens.getAccessToken(), fetchImpl);
}

/**
 * Each listed service in order, stopping at the first address unless `every`
 * is set; userinfo only when no service named the account. Aborts propagate;
 * every other failure is recorded under its attempt.
 */
export async function probeGoogleAccount(clients: GoogleIdentityClients, services: readonly GoogleService[],
  opts: { signal?: AbortSignal; every?: boolean } = {}): Promise<GoogleAccountProbe> {
  const { signal } = opts;
  const request = signal ? { signal } : {};
  const attempts: Array<[GoogleService | 'userinfo', () => Promise<string | undefined>]> = [
    ['gmail', async () => (await clients.gmail.getProfile(request)).emailAddress],
    ['calendar', async () => (await clients.calendar.fetchJSON<{ id?: string }>('https://www.googleapis.com/calendar/v3/calendars/primary', 'calendar-json', request)).id],
    ['contacts', async () => {
      // Connections needs only contacts.readonly; contact addresses are not account identity.
      await clients.people.fetchJSON<unknown>(
        'https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=emailAddresses', 'people', request);
      return undefined;
    }],
    ['userinfo', clients.userinfo],
  ];
  const probe: GoogleAccountProbe = { email: null, via: null, errors: {} };
  for (const [attempt, run] of attempts) {
    if (attempt === 'userinfo' ? probe.email !== null : !services.includes(attempt)) continue;
    signal?.throwIfAborted();
    try {
      const email = (await run())?.trim().toLowerCase();
      if (email?.includes('@') && probe.email === null) {
        probe.email = email;
        probe.via = attempt;
        if (!opts.every) return probe;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      probe.errors[attempt] = error;
    }
  }
  return probe;
}

/** The problem behind one service failure, or null when the failure is something else. */
export function googleApiProblem(service: GoogleService, error: unknown): GoogleApiProblem | null {
  if (error instanceof GoogleApiDisabledError) {
    return { service, code: 'api_not_enabled', api: error.api, api_title: error.apiTitle, project: error.project, enable_url: error.enableUrl };
  }
  if (error instanceof CredentialError && error.code === 'scope_missing') {
    return { service, code: 'scope_missing', api: GOOGLE_SERVICE_API[service].api, api_title: GOOGLE_SERVICE_API[service].title, project: null, enable_url: null };
  }
  return null;
}

export interface GoogleApiAccessReport {
  account: string;
  /** The address the probe resolved, and how; null when nothing named the account. */
  resolved_account: string | null;
  resolved_via: GoogleAccountProbe['via'];
  services: Partial<Record<GoogleService, { status: 'ok' | GoogleApiProblem['code'] | 'error'; error?: string }>>;
  problems: GoogleApiProblem[];
  fix?: Action;
}

/**
 * Probe every service in `services`: one not in a known grant is
 * `scope_missing` without a request; the rest are read live.
 */
export async function probeGoogleApiAccess(clients: GoogleIdentityClients, account: string, services: readonly GoogleService[],
  grantedScopes: readonly string[], signal?: AbortSignal): Promise<GoogleApiAccessReport> {
  const ordered = ALL_GOOGLE_SERVICES.filter(service => services.includes(service));
  const ungranted = grantedScopes.length > 0 ? ordered.filter(service => !grantedScopes.includes(GOOGLE_SERVICE_SCOPES[service])) : [];
  const probe = await probeGoogleAccount(clients, ordered.filter(service => !ungranted.includes(service)), { every: true, ...(signal ? { signal } : {}) });
  const report: GoogleApiAccessReport = { account, resolved_account: probe.email, resolved_via: probe.via, services: {}, problems: [] };
  for (const service of ordered) {
    const problem = ungranted.includes(service) ? googleApiProblem(service, new CredentialError('scope_missing')) : googleApiProblem(service, probe.errors[service]);
    const error = probe.errors[service];
    if (problem) report.problems.push(problem);
    report.services[service] = problem ? { status: problem.code }
      : error === undefined ? { status: 'ok' } : { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  if (report.problems.length > 0) report.fix = googleApiAccessFix(account, report.problems);
  return report;
}

/**
 * One fix naming every problem: enabling an API is the user's step in the
 * Cloud console (`ask_user` with each link); a missing grant alone is the
 * user's reauth command (`tell_user_to_run`).
 */
export function googleApiAccessFix(account: string, problems: readonly GoogleApiProblem[]): Action {
  const verify = ['gbrain', 'google', 'status', '--json'];
  const disabled = problems.filter(problem => problem.code === 'api_not_enabled');
  const ungranted = problems.filter(problem => problem.code === 'scope_missing');
  const reauth = ['gbrain', 'google', 'connect', '--reauth', account];
  const steps = [
    ...disabled.map(problem => `enable the ${problem.api_title} (${problem.api}) for Google Cloud project ${problem.project ?? 'that owns the OAuth client'}: ${problem.enable_url}`),
    ...(ungranted.length ? [`grant ${ungranted.map(problem => problem.service).join(', ')} access: ${reauth.join(' ')}`] : []),
  ];
  const userMessage = `Google account ${account} cannot reach ${problems.map(problem => problem.service).join(', ')}. To fix it, ${steps.join('; ')}. `
    + `Then re-check with: ${verify.join(' ')}`;
  const shared = { consent: [], actor: 'user' as const, user_message: userMessage, verify: { argv: verify }, docs: 'docs/guides/google-connect.md#api-access', requires_exclusive: false };
  if (disabled.length > 0) {
    return { ask_user: true, ...shared,
      why: `${disabled.map(problem => problem.api_title).join(', ')} ${disabled.length === 1 ? 'is' : 'are'} disabled for the OAuth client's Google Cloud project; only the project owner can enable ${disabled.length === 1 ? 'it' : 'them'} in the console.` };
  }
  return { argv: reauth, ...shared, why: `The credential was granted without the ${ungranted.map(problem => problem.service).join(', ')} scope; a reauth asks the user to grant it.` };
}
