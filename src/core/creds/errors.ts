/**
 * creds/errors — the typed credential error catalog.
 *
 * Every failure a user can hit while connecting or refreshing a credential
 * maps to one CredentialError with four user-facing fields: what happened
 * (problem), why (cause), the exact fix, and a doc link. Two renderings:
 *  - conversational one-liner, fix first (stderr / [SHOW USER] blocks)
 *  - structured JSON (`--json` envelopes: { code, problem, cause, fix, doc_url })
 *
 * The catalog is the single source of truth for
 * docs/guides/google-connect.md's troubleshooting table — update both
 * together. No CLI imports here: the hosted product reuses this module.
 */

export type CredentialErrorCode =
  // client-credential intake
  | 'client_json_wrong_type'
  | 'client_shape_invalid'
  | 'client_json_unreadable'
  // non-vault access modes (--access command|env)
  | 'access_command_failed'
  | 'access_env_missing'
  // consent flow
  | 'redirect_uri_mismatch'
  | 'access_denied_test_user'
  | 'pasted_wrong_url'
  | 'state_mismatch'
  | 'admin_policy_enforced'
  | 'wrong_account_consented'
  | 'port_in_use'
  | 'consent_timeout'
  // token lifecycle
  | 'invalid_grant_testing_expiry'
  | 'invalid_grant_revoked'
  | 'invalid_grant_clock_skew'
  | 'code_reused'
  | 'invalid_client'
  | 'no_refresh_token'
  // API usage
  | 'api_not_enabled'
  | 'rate_limited'
  | 'scope_missing'
  // relay (hosted fast path)
  | 'relay_unreachable'
  | 'relay_session_expired'
  | 'claim_already_used'
  | 'relay_disabled'
  // generic
  | 'not_connected'
  | 'upstream';

const DOC_BASE = 'https://github.com/garrytan/gbrain/blob/master/docs/guides/google-connect.md';

interface CatalogEntry {
  problem: string;
  cause: string;
  fix: string;
}

/**
 * The catalog. `%s` placeholders are filled by the `detail` argument of
 * credentialError() where present; entries read correctly with or without it.
 */
const CATALOG: Record<CredentialErrorCode, CatalogEntry> = {
  client_json_wrong_type: {
    problem: 'This OAuth client is a Web application, but the loopback flow needs a Desktop app client.',
    cause: 'The downloaded client_secret.json has a top-level "web" key instead of "installed". Web clients only allow pre-registered redirect URIs, so the local loopback redirect is rejected.',
    fix: 'In Google Cloud console → APIs & Services → Credentials, create a new OAuth client ID with application type "Desktop app", download its JSON, and re-run `gbrain google connect --client-json <path>`.',
  },
  client_shape_invalid: {
    problem: 'The client ID or secret looks malformed.',
    cause: 'Client IDs end in ".apps.googleusercontent.com" and secrets start with "GOCSPX-". A copy/paste through chat often picks up smart quotes, whitespace, or truncation.',
    fix: 'Re-copy the value, or skip manual copying entirely: download the client JSON from the credentials page and pass it with `--client-json <path>` (or paste its contents via `--client-json -`).',
  },
  client_json_unreadable: {
    problem: 'The client JSON could not be read or parsed.',
    cause: 'The path does not exist, or the file is not the JSON downloaded from Google Cloud console.',
    fix: 'Download the OAuth client JSON (Credentials page → your Desktop app client → Download JSON) and pass its path with `--client-json <path>`.',
  },
  redirect_uri_mismatch: {
    problem: 'Google rejected the redirect URI.',
    cause: 'Desktop-app clients accept loopback redirects automatically; this error almost always means the client is a Web application client.',
    fix: 'Create a "Desktop app" OAuth client and reconnect with its JSON.',
  },
  access_denied_test_user: {
    problem: 'Google blocked the consent screen (access_denied).',
    cause: 'The consent screen is External + Testing and this Google account is not listed as a test user — or the user clicked Cancel.',
    fix: 'Add your own email under Audience → Test users at https://console.cloud.google.com/auth/audience, then open the same consent URL again.',
  },
  pasted_wrong_url: {
    problem: 'That looks like the Google consent page URL, not the redirect.',
    cause: 'After approving, the browser lands on an http://127.0.0.1/... page that fails to load — its address bar URL is the one to paste.',
    fix: 'Approve access in the browser first, then copy the FULL address-bar URL of the "site can\'t be reached" page (it starts with http://127.0.0.1) and paste that.',
  },
  state_mismatch: {
    problem: 'The redirect did not match this connect attempt.',
    cause: 'The state parameter differs — the paste came from an older attempt, or something interfered with the flow.',
    fix: 'Re-run `gbrain google connect` and use the freshly printed URL.',
  },
  admin_policy_enforced: {
    problem: 'Your Google Workspace admin has blocked this app (Error 400: admin_policy_enforced).',
    cause: 'Workspace API controls only allow admin-trusted third-party apps — and that includes OAuth clients you created yourself.',
    fix: 'Ask your admin to trust the app (Admin console → Security → Access and data control → API controls → Manage Third-Party App Access), or create the OAuth client in a project whose consent screen is "Internal" to your Workspace.',
  },
  wrong_account_consented: {
    problem: 'A different Google account approved the consent.',
    cause: 'The browser was signed into multiple Google accounts and defaulted to another one.',
    fix: 'Re-run connect — the consent URL now pre-selects the expected account (login_hint) — and pick the right account on the chooser.',
  },
  port_in_use: {
    problem: 'The local callback port is already in use.',
    cause: 'Another process is bound to the loopback port the flow tried to listen on.',
    fix: 'Re-run connect (a fresh ephemeral port is chosen automatically), or pass --port <n>, or use --paste to skip the local listener entirely.',
  },
  consent_timeout: {
    problem: 'Timed out waiting for the consent redirect.',
    cause: 'The consent URL was never opened, or the browser session stalled.',
    fix: 'Re-run `gbrain google connect` and open the printed URL within 10 minutes. On a remote/SSH machine use --paste and paste the redirect URL back.',
  },
  invalid_grant_testing_expiry: {
    problem: 'Google revoked the refresh token (invalid_grant) — this looks like the 7-day Testing-mode expiry.',
    cause: 'Consent screens left in "Testing" with user type External expire refresh tokens after 7 days, every time.',
    fix: 'Publish the app to Production at https://console.cloud.google.com/auth/audience (safe for personal use; you\'ll click through an "unverified app" warning once), then run `gbrain google connect --reauth <email>`. Workspace accounts can instead set the consent screen to "Internal", which never expires.',
  },
  invalid_grant_revoked: {
    problem: 'Google rejected the refresh token (invalid_grant).',
    cause: 'Access was revoked — a password change, a security event, manual revocation at myaccount.google.com/permissions, or the OAuth client was deleted/rotated.',
    fix: 'Run `gbrain google connect --reauth <email>` to re-authorize.',
  },
  invalid_grant_clock_skew: {
    problem: 'Token request rejected (invalid_grant) and this machine\'s clock is off.',
    cause: 'OAuth token exchange is time-sensitive; a clock skewed by more than about a minute makes Google reject otherwise-valid grants.',
    fix: 'Fix system time sync (chrony/ntpd/systemsetup), verify with `date -u`, then retry.',
  },
  code_reused: {
    problem: 'The authorization code was already used.',
    cause: 'Authorization codes are single-use; the exchange ran twice (double paste, page reload).',
    fix: 'Re-run `gbrain google connect` to start a fresh consent.',
  },
  invalid_client: {
    problem: 'Google rejected the OAuth client credentials (invalid_client).',
    cause: 'The client secret was rotated or the client was deleted in Google Cloud console — the stored copy no longer matches.',
    fix: 'Download the current client JSON from the Credentials page and re-run `gbrain google connect --client-json <path>`.',
  },
  no_refresh_token: {
    problem: 'Google did not return a refresh token.',
    cause: 'A prior consent for this client already exists, and Google only re-issues refresh tokens when consent is re-prompted.',
    fix: 'Re-run connect (the flow always sends prompt=consent); if it persists, remove the app at myaccount.google.com/permissions and reconnect.',
  },
  api_not_enabled: {
    problem: 'The Google API for this service is not enabled in your project.',
    cause: 'Each API (Gmail, Calendar, People) must be enabled once per Google Cloud project.',
    fix: 'Enable it, then retry: %s',
  },
  rate_limited: {
    problem: 'Google rate-limited the request.',
    cause: 'Per-user or per-project quota was hit; this clears on its own.',
    fix: 'Nothing to do — the client honors Retry-After and backs off automatically. If it persists for hours, check quota in the Cloud console.',
  },
  scope_missing: {
    problem: 'The stored credential is missing a required scope.',
    cause: 'The account was connected with --scopes narrower than what this operation needs.',
    fix: 'Run `gbrain google connect --reauth <email>` to grant the full scope set (incremental auth keeps existing grants).',
  },
  relay_unreachable: {
    problem: 'The gbrain.io connect fast path is unreachable.',
    cause: 'Network failure or a relay outage.',
    fix: 'Retry later, or connect without the relay: `gbrain google connect` (BYO client) always works.',
  },
  relay_session_expired: {
    problem: 'The relay connect session expired before the consent completed.',
    cause: 'Relay sessions are valid for 10 minutes.',
    fix: 'Re-run `gbrain google connect --via gbrain.io` and complete the consent within 10 minutes.',
  },
  claim_already_used: {
    problem: 'This relay session was already claimed.',
    cause: 'Tokens are handed over exactly once; a second claim is refused by design.',
    fix: 'If you did not receive the tokens, re-run `gbrain google connect --via gbrain.io` for a fresh session.',
  },
  relay_disabled: {
    problem: 'The hosted connect fast path is not enabled in this build.',
    cause: 'GBRAIN_OAUTH_RELAY_URL is not set.',
    fix: 'Use the standard flow: `gbrain google connect` (bring-your-own OAuth client).',
  },
  not_connected: {
    problem: 'No Google account is connected%s.',
    cause: 'The credential vault has no matching entry.',
    fix: 'Run `gbrain google connect` (or `gbrain google setup` for the full guided flow).',
  },
  access_command_failed: {
    problem: 'The configured token command did not produce a Google access token%s.',
    cause:
      'This source uses `--access command`: gbrain runs your command (e.g. a gog/gcloud/gateway CLI) and expects an access token on stdout. It exited non-zero, timed out, or printed nothing usable.',
    fix: 'Run the command by hand and confirm it prints a bare token (or JSON with a `token`/`access_token` field). Update it: `gbrain sources add <id> --kind google --access command --token-command "<cmd>" ...`.',
  },
  access_env_missing: {
    problem: 'The configured token environment variable is empty%s.',
    cause:
      'This source uses `--access env`: gbrain reads a Google access token from the named env var, refreshed by something outside gbrain. The variable is unset or blank in this process.',
    fix: 'Export the variable with a live access token before running the sync (short-lived tokens: refresh them externally, e.g. via cron), or switch the source back to the vault flow: `gbrain google setup`.',
  },
  upstream: {
    problem: 'Google returned an unexpected error%s.',
    cause: 'Transient upstream failure or an unhandled response shape.',
    fix: 'Retry; if it persists, run `gbrain google status --json` and file the output.',
  },
};

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  readonly problem: string;
  readonly cause_text: string;
  readonly fix: string;
  readonly doc_url: string;

  constructor(code: CredentialErrorCode, detail?: string, causeErr?: unknown) {
    const entry = CATALOG[code];
    const problem = entry.problem.includes('%s')
      ? entry.problem.replace('%s', detail ?? '')
      : entry.problem;
    const fix = entry.fix.includes('%s') ? entry.fix.replace('%s', detail ?? '') : entry.fix;
    super(`${problem} ${fix}`);
    this.name = 'CredentialError';
    this.code = code;
    this.problem = problem;
    this.cause_text = entry.cause;
    this.fix = fix;
    // The guide's troubleshooting entries are table rows under one heading,
    // not per-code headings — anchor to the section so links land somewhere.
    this.doc_url = `${DOC_BASE}#troubleshooting`;
    if (causeErr !== undefined) (this as { cause?: unknown }).cause = causeErr;
  }

  /** Structured shape for --json envelopes (Stripe-style five fields). */
  toJSON(): { code: string; problem: string; cause: string; fix: string; doc_url: string } {
    return {
      code: this.code,
      problem: this.problem,
      cause: this.cause_text,
      fix: this.fix,
      doc_url: this.doc_url,
    };
  }

  /** Conversational one-liner, fix first (Elm-style): for stderr. */
  toHuman(): string {
    return `${this.problem}\n  fix: ${this.fix}\n  why: ${this.cause_text}\n  docs: ${this.doc_url}`;
  }
}

export function isCredentialError(e: unknown): e is CredentialError {
  return e instanceof CredentialError;
}
