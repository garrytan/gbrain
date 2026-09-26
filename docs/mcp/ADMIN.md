# Administer a running GBrain MCP server

Use this guide to open the owner dashboard, register a client, deliver setup
instructions, change permissions, or end access. Run commands from the brain
host or a separately authorized administrator harness. They use the running
server's HTTP API and database connection, including when PGLite is already open.

Connecting a harness is a separate task: see
[hosted setup](../guides/hosted-harness-access.md). To start or expose the server,
see [deployment](DEPLOY.md).

## Identify your authority

| Caller or credential | Can do | Cannot do |
| --- | --- | --- |
| Server-hosting harness with the configured owner credential | Open the owner dashboard and manage clients through HTTP | Assume another server uses the same credential |
| Remote administrator given that owner credential through a protected mechanism | The same owner actions on the selected server | Gain host shell or filesystem access from that credential |
| Owner browser with its `gbrain_admin` session cookie | Dashboard administration and OAuth consent | Treat the cookie as an MCP access token |
| OAuth client with `read`, `write`, or `admin` scope | Its granted MCP operations, subject to source and operation restrictions | Open an owner session or administer other clients |
| Native public PKCE client | Start authorization and exchange its code using its own verifier | Use a client secret; public clients have none |
| Endpoint URL or public discovery metadata | Find the server and setup guidance | Prove ownership or grant access |

The OAuth `operator` profile and `admin` scope refer to eligible **brain
operations**, not owner administration. `gbrain://capabilities` describes the
current MCP connection; it does not upgrade that connection's authority.

If you are only the connecting client, give the owner this next action:

> In the harness that administers the running server, follow
> https://raw.githubusercontent.com/garrytan/gbrain/master/docs/mcp/ADMIN.md.
> Use the server's configured URL and protected owner credential to register my
> client or issue a login link. My MCP access token is not an owner credential.

## Select the running server and credential

Every command below accepts `--url` with the server URL or its `/mcp` endpoint.
Examples use the fictional `https://brain.example.com/mcp`. Substitute the
configured endpoint of the intended brain, not an old tunnel URL or the client
machine's localhost.

Supply `--admin-token-file /absolute/private/admin-token`. Its file must contain
the running server's owner bootstrap credential and have private permissions.
The file takes precedence over `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`; without the flag,
that environment variable is used. Configure secrets through your existing
protected service/harness mechanism. Do not put their values in chat, command
arguments, screenshots, commits, or diagnostic receipts.

`--json` returns machine-readable output. For `mcp admin`, `--timeout-ms` applies
separately to each HTTP request (default 30000; accepted range 100–300000).
Authentication and subsequent requests can make the total command take longer.
Ordinary inspection and setup output are redacted. The explicitly requested
login link is sensitive and short-lived; credential exports require an explicit
private destination.

**For a running PGLite server, use this HTTP path.** Do not launch another
server, open the database from another CLI process, or remove a live lock to
perform administration. `mcp grant` also accepts the same owner file/environment
credential for machine-client creation and permission changes.

### Set up or recover the owner credential

For a headless service, provision a stable `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` in the
service's protected environment before starting the existing server. Use at
least 32 characters from `A–Z`, `a–z`, `0–9`, `_`, and `-`; a random 32-byte
hexadecimal secret is suitable. Keep the
same value available to the authorized administrator harness.

Without a configured value, the server generates a credential for that process.
Interactive startup prints it; captured/non-TTY startup hides it. Starting
`gbrain serve --http --print-admin-token` separately does **not** reveal the
credential of the already running process. If that process's generated value is
unavailable, use the host's normal maintenance procedure to restart the existing
service with a protected configured credential. Existing login sessions, links,
and pending OAuth approvals do not survive a restart; restart the connection
from the native client afterward.

## Open the owner dashboard

```bash
gbrain mcp admin login-link --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

Deliver the returned `url` privately to the requesting owner. The link is
single-use and expires after five minutes. **Do not fetch, preview, or open it
to test it.** Doing so can consume it before the owner arrives. A plain `/admin/`
URL opens the login page; it does not authenticate the browser.

During native OAuth connection, the browser may already show a URL containing
`oauth_request`. Preserve that opaque request ID:

```bash
gbrain mcp admin login-link --oauth-request REQUEST_ID \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

This lets the owner open the new link in a fresh browser/tab and still reach the
pending consent page. Review the client, redirect URI, permissions, and sources
before approving. Only then does the native client receive an authorization
code. The native client keeps its PKCE verifier and performs the exchange;
the administering harness should not construct a replacement authorization URL.

If the request expired, was completed, or the server restarted, restart the
connection from the native client to obtain a new request. Reissuing a login
link cannot recreate a lost OAuth request or verifier.

## Register and connect a client

First choose how the **intended harness** connects:

| Connection | Registration | Delivered setup |
| --- | --- | --- |
| Native OAuth, public PKCE | `mcp admin register`, auth method `none` | Endpoint, client ID, redirect URIs, scopes; no secret |
| Native OAuth, confidential PKCE | `mcp admin register`, auth method `client_secret_post` or `client_secret_basic` | Same metadata plus an explicitly exported private secret |
| Machine credentials or managed bearer configuration | `mcp grant --harness …` | Existing private machine handoff for `gbrain connect` |

### Native OAuth with PKCE

Get the exact redirect URI from the intended client's connection settings or
current documentation. Do not invent it. Repeat `--redirect-uri` when the client
requires multiple callbacks. Select the authentication method the client uses.

Preview a public registration:

```bash
gbrain mcp admin register agent-example \
  --redirect-uri https://client.example.com/oauth/callback \
  --token-endpoint-auth-method none --profile memory-writer --source default \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --dry-run --json
```

Review the result, then repeat without `--dry-run`. Native registration grants
`authorization_code` and `refresh_token`; it does not mint a machine token.
Without explicit permissions, the CLI defaults to `read` on source `default`.
Use `--profile` for a preset or `--scopes` for explicit scopes. If both are
supplied, explicit scopes override the profile's scope list; review the resulting
operation and source restrictions as well.

For confidential PKCE, change the method to `client_secret_post` or
`client_secret_basic` and add `--credentials-out /absolute/private/oauth-setup.json`
when creating the client. Do not distribute that file to a public client.

Generate instructions for the registered client:

```bash
gbrain mcp admin setup CLIENT_ID --harness generic --flow authorization-code \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

Use the actual harness ID from `gbrain mcp adapters`; `generic` gives the native
protocol/settings path without pretending to install a vendor configuration.
Setup reads the registration's real authentication method and redirect URIs.
Add `--credentials-out /absolute/private/oauth-setup.json` only when a private
credential delivery is required. This `OAuthClientSetup` document is distinct
from a machine handoff: do not pass it to `gbrain connect --credentials-file`.

Enter the supplied fields in the native client's MCP settings and initiate its
OAuth connection. Sign in as owner and approve the pending request as described
above. **Registered** and **setup delivered** do not mean **connected**: observe
a successful authenticated MCP call inside the actual harness.

### Machine credentials

```bash
gbrain mcp grant agent-example --harness codex --profile memory-writer \
  --source default --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token \
  --credentials-out /absolute/private/machine-handoff.json --json
```

Use `--dry-run` first for a preview. Deliver the private handoff to the target
harness, then follow [installation and verification](../guides/hosted-harness-access.md#2-install-inside-the-intended-harness)
there. For an existing client, `mcp admin setup CLIENT_ID --harness ID --flow
client-credentials` produces its matching instructions; credential recovery is
explicit via `--credentials-out`.

### Self-service dynamic registration

Manual owner registration works without dynamic client registration (DCR).
Enable `--enable-dcr` on the existing service only when the owner chooses
self-registration for native clients. DCR does not grant owner administration
or bypass consent. Its scope ceiling and redirect validation remain enforced;
see [DCR](DEPLOY.md#dynamic-client-registration-dcr). If DCR is disabled, manually
register the client and enter its metadata where that harness supports it.

## Inspect clients and edit access

```bash
gbrain mcp admin clients --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
gbrain mcp admin client CLIENT_ID --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

The list includes active and revoked registrations. Inspect the client ID,
connection method, sources, effective grant, and revision before acting.
Inspection never reveals the secret or reads a credential delivery for display.
Dashboard filters may hide revoked clients; clear that filter to see all rows.

Preview a permission change against the inspected revision:

```bash
gbrain mcp grant agent-example --client CLIENT_ID --if-version REVISION \
  --harness generic --profile memory-reader \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --dry-run --json
```

The example omits source and path flags to preserve the client's existing
restrictions. Review before/after and repeat without `--dry-run`. Omit `--profile` to preserve
the existing profile, scopes, operation snapshot, and restrictions while editing
specific flags. An explicit profile regrants its eligible operations. A stale
revision refuses the edit; inspect and preview again.

Removed scopes and source/path/operation restrictions apply to subsequent
requests. Added scopes require a fresh token; refresh cannot widen the original
token's scope ceiling. Native OAuth clients must reconnect and obtain fresh
owner approval. TTL changes affect future tokens only.

## Invalidate tokens, revoke, or delete

| Action | Result | How the client reconnects |
| --- | --- | --- |
| `invalidate-tokens` | Deletes current access tokens, refresh tokens and codes; invalidates pending approval policy | Active machine credentials can obtain new tokens; native OAuth restarts authorization |
| `revoke` | Disables issuance and access; retains the registration and audit | Provision a new client when access is wanted again |
| `delete` | Removes the registration and its tokens/codes; retains audit history | Register a new client; deletion cannot restore the old ID or credentials |

Each command previews by default. For example:

```bash
gbrain mcp admin invalidate-tokens CLIENT_ID \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

After reviewing consequences, apply with the displayed revision:

```bash
gbrain mcp admin invalidate-tokens CLIENT_ID --yes --if-version REVISION \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

Substitute `revoke` or `delete` for the other actions. A revision conflict
requires a new preview. Deleting a registration does not delete brain memory or
promise erasure of historical logs/backups. Revoking a client cannot undo an
external operation already running. Removing a client configuration alone does
not revoke server access.

Previously accepted jobs continue under their existing grant checks after
token invalidation. Revocation or deletion denies those jobs at their next
authority check; external work already admitted may complete. All three actions
retain request history, audit records, spending reservations, and settlement.

## Recover a failed step

| Symptom | What to do |
| --- | --- |
| Owner credential missing or refused | Use the server's protected credential mechanism; an MCP token cannot substitute. See owner credential recovery above. |
| Service unreachable or wrong URL | Verify the configured endpoint and existing service health; do not start a second brain. |
| Admin command unsupported by this server | Upgrade/restart the intended running server through its normal maintenance process. No local database fallback. |
| Rate limited | Respect the retry timing; do not repeatedly mint login links or retry failed credentials. |
| Login link consumed/expired | Ask the authorized administrator for a new one; preserve the pending request ID when still valid. |
| Consent expired/restarted/permissions changed | Restart authorization in the native client, then review its new request. |
| Redirect or PKCE/authentication-method mismatch | Compare setup metadata with the native client's actual callback and method. The native client owns its verifier. |
| Duplicate client name | Inspect the reported existing client ID; recover its setup instead of creating another client. |
| Mutation response lost or timed out | Outcome may be unknown. Inspect the client/list before retrying; a transport error does not prove nothing changed. |
| `grant_conflict` | Inspect the current revision and preview the intended action again. |
| Client/source list failed | Retry the failed request; an error is not an empty registration list or a missing source. |
| Public OAuth setup has no secret | Expected for authentication method `none`. Connect using native PKCE. |
| Confidential secret delivery interrupted | Use `mcp admin setup … --credentials-out PRIVATE_FILE` to recover the retained delivery; never expose it in ordinary output. |
| Recovery journal unavailable or secret no longer matches | Use an existing private handoff if available. Otherwise choose an explicit maintenance/reprovisioning action; do not silently rotate or duplicate. |
| Server probe passes but harness does not connect | Check the actual native configuration, reload/authorization state, and observed tool call. Report native verification as incomplete. |

The host journal is private material under `.gbrain/credential-deliveries` and
is excluded from default backups. Recovery validates the live registration;
it does not undo a permission edit or revive a revoked/deleted client.

**Legacy secret rotation exists, with limits.** `gbrain agent register --reissue`
is a local operator maintenance path for confidential clients that have the
`client_credentials` grant; inspect its `--help` for the full invocation. It
rotates the secret and mints replacement access, while outstanding access
tokens survive until expiry unless separately invalidated/revoked. It is not a
native-PKCE recovery command or a remote admin rotation API, and it does not
refresh the modern credential delivery journal. Keep the private output from
rotation; the old journal will fail live-secret validation. With a running
PGLite server, schedule host maintenance instead of opening a second database
connection. Prefer journal recovery when the original secret is still valid.

For support, share the redacted command result, failing stage, endpoint, client
ID/revision when known, and whether the result was failed or unknown. Exclude
owner secrets, cookies, login links, client secrets, and OAuth codes/verifiers.
