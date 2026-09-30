/**
 * Resolve the account a connector credential actually belongs to, before any
 * service runs (#5686 account pin). Credential-delivery fields are excluded
 * from the connector identity, so a swapped token behind an unchanged
 * `g_token_env` / `gh_token_env` name is caught here instead.
 */
import type { GoogleService } from '../google/types.ts';
import type { GmailClient, CalendarClient, PeopleClient } from '../google/google-clients.ts';
import type { GitHubClient, GitHubSourceConfig } from '../github-source.ts';
import type { ConnectorAccount } from './connector-state.ts';

/**
 * Google: the first enabled service whose granted scope can name the account
 * (Gmail profile, Calendar primary calendar, People `me`). Null when none can.
 */
export async function resolveGoogleAccount(clients: { gmail: GmailClient; calendar: CalendarClient; people: PeopleClient },
  services: readonly GoogleService[], signal?: AbortSignal): Promise<string | null> {
  const opts = signal ? { signal } : {};
  const attempts: Array<[GoogleService, () => Promise<string | undefined>]> = [
    ['gmail', async () => (await clients.gmail.getProfile(opts)).emailAddress],
    ['calendar', async () => (await clients.calendar.fetchJSON<{ id?: string }>('https://www.googleapis.com/calendar/v3/calendars/primary', 'calendar-json', opts)).id],
    ['contacts', async () => {
      const me = await clients.people.fetchJSON<{ emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }> }>(
        'https://people.googleapis.com/v1/people/me?personFields=emailAddresses', 'people', opts);
      return (me.emailAddresses?.find(address => address.metadata?.primary) ?? me.emailAddresses?.[0])?.value;
    }],
  ];
  for (const [service, attempt] of attempts) {
    if (!services.includes(service)) continue;
    signal?.throwIfAborted();
    try {
      const email = (await attempt())?.trim().toLowerCase();
      if (email && email.includes('@')) return email;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return null;
}

/**
 * GitHub: an App resolves to the installation its token was minted for; token
 * auth under `scope: auto` resolves to the authenticated login. Token auth
 * under `scope: repos` reads an explicit repo list, so it pins nothing.
 */
export async function resolveGitHubAccount(cfg: GitHubSourceConfig, client: GitHubClient,
  app: { getToken(): Promise<string>; installationId: number | null } | null, signal?: AbortSignal): Promise<ConnectorAccount> {
  if (app) {
    await app.getToken();
    return { kind: 'github', installationId: app.installationId, login: null };
  }
  if (cfg.scope !== 'auto') return { kind: 'github', installationId: null, login: null };
  const user = await client.fetchJSON<{ login?: string }>('/user', signal ? { signal } : {});
  return { kind: 'github', installationId: null, login: typeof user.login === 'string' ? user.login : null };
}
