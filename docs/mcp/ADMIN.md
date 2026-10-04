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

## Legacy token grants

**Say to your agent:** *"Let the hosted token read the workspace source too."*
or *"Lock that old token out of every source."* The agent runs
`gbrain auth rescope --token <name>` on the brain host.

`gbrain auth rescope` is one grant editor for legacy bearer tokens
(`gbrain auth create`, `gbrain bootstrap harness`) and OAuth clients. Only the
flags you pass change; the secret is unchanged and grants apply on the next
request. With no grant flag it prints the stored grants. A bare name works
when it names exactly one token or client; a name that matches both refuses
(`rescope_target_ambiguous`), so pass `--token` or `--client`. `--json`
prints the result, and any refusal, as JSON on stdout.

```bash
gbrain auth rescope --token agent-example                     # print the stored grants
gbrain auth rescope --token agent-example --sources workspace,default
gbrain auth rescope --token agent-example --takes-holders world,brain
gbrain auth rescope --token agent-example --operations get_page,search,query
gbrain auth rescope --token agent-example --sources none        # deny-all
gbrain auth rescope --token agent-example --reset-default sources,takes-holders
gbrain auth rescope --id TOKEN_ID --sources default --if-version 3 --dry-run --json
gbrain auth rescope --client CLIENT_ID --sources workspace,default --operations get_page,search
```

| Flag | Value | Effect |
| --- | --- | --- |
| `--sources` | `a,b` or `none` | Source grant; the first id is the write source, the list is the read set. `default` is the source named `default`; to restore the no-grant floor use `--reset-default sources`. Tokens: `none` grants no source, so reads and writes to every source are refused (`permission_denied`, `fence=no_source_grant`), including writes accepted before the change. Clients: `none` refuses (`client_sources_none_unsupported`); cut a client off with `gbrain auth revoke-client <client_id>`. |
| `--read-sources` | `a,b` | Client only: a read set that differs from `--sources`. |
| `--takes-holders` | `a,b` or `none` | Token only: takes-holder allow-list; `none` hides every take. |
| `--operations` | `op,...` or `none` | Operation snapshot; `none` refuses every operation. |
| `--scopes` | `read,write,...` | Replaces the scopes. |
| `--reset-default` | `sources,takes-holders,operations` | Token only: restores the `auth create` default for those axes: no source grant (the historical `default` floor), holders `world`, no operation snapshot. |
| `--refresh-operations` | with optional `--add op,...` or `--all-new` | Token only: previews operations added since the snapshot. Without `--add` or `--all-new` nothing is widened. |
| `--if-version` | `N` | Refuses unless the stored grant revision is `N`; the refusal names the current revision. |
| `--adopt-permissions` / `--adopt-columns` | | Token only: resolves grant drift (below). |

Names are not unique; when several active tokens share a name, pass `--id`
from `gbrain auth list`. The older commands stay as aliases:
`gbrain auth rescope-token <name> ...` is `auth rescope --token <name> ...`,
`gbrain auth rescope-client <client_id> ...` is `auth rescope --client
<client_id>` with its own flags (`--source`, `--federated-read`,
`--allowed-operations`, `--surface`, `--profile`, ...), which also pass through
`auth rescope --client`, and `gbrain auth permissions <name>
set-takes-holders <list>` is `auth rescope --token <name> --takes-holders <list>`.

### One grant shape and the lazy migration

Tokens store their grant in the same columns as OAuth clients
(`access_tokens.source_grant`, `source_id`, `federated_read`,
`allowed_operations`, `takes_holders`, `grant_revision`). `source_grant` is
`default`, `scalar`, `federated` or `none`; NULL means the token still uses the
older `permissions` JSON shape. Those tokens keep working unchanged and are not
re-issued: the next `auth rescope` edit, every `auth create` and every harness
rotation write the columns, bump `grant_revision`, and rewrite `permissions` as
a mirror (other keys preserved) so older gbrain binaries enforce the same
grant. To migrate every remaining token at once, without changing any grant:

```bash
gbrain auth rescope --migrate-legacy --dry-run    # list
gbrain auth rescope --migrate-legacy
```

A token whose `permissions` value is not a JSON object is skipped: the HTTP
paths read it as no grant while publication denies it, so there is no faithful
column form. Ask the user which grant it should hold, then run
`gbrain auth rescope --id <id>` with explicit `--sources`, `--takes-holders`
and `--operations` (or `--reset-default sources,takes-holders,operations`).
`gbrain doctor` reports the count as `legacy_token_grant_shape`
(`details.legacy_shape_count`, `details.malformed`).

### Grant drift

If an older gbrain binary edits a migrated token's `permissions` JSON (for
example its `auth rescope-token`), the JSON and the columns disagree. Each
axis that disagrees (`sources`, `takes-holders`, `operations`) denies every
request until resolved, and grant edits on that token refuse. `gbrain doctor`
warns `legacy_token_grant_drift` (`details.drift: [{name, id, axes}]`). Ask the
user which grant is intended, then run one of:

```bash
gbrain auth rescope --token agent-example --adopt-permissions   # keep the JSON edit
gbrain auth rescope --token agent-example --adopt-columns       # restore the columns
```

A harness rotation of a drifted token carries the JSON edit, the same
resolution as `--adopt-permissions`, and the replaced token is revoked.

### Harness rotation

A `gbrain bootstrap harness` re-run rotates its token and carries the
replaced token's grants: takes holders and sources as stored (explicit empty
lists included; an explicit `--source` on the re-run wins), and the operation
snapshot narrowed to the run's own snapshot plus only the operations a
skills-policy change adds. Newer operations are withheld and the run names
the preview command:

```bash
gbrain auth rescope --token bootstrap-harness --refresh-operations
gbrain auth rescope --token bootstrap-harness --refresh-operations --add assemble_evidence
```

## Write attribution

**Say to your agent:** *"Who wrote this page, and which agent changed it last?"*
or *"Which client saved fact 42?"* The agent runs `gbrain attribution` (or the
`get_write_attribution` tool with an `admin` grant).

Journaled and coordinated writes record, on pages, page versions, facts, takes
and timeline entries, which request and which principal (OAuth client, legacy
token, local CLI or stdio writer, or the application) created each row and last
changed it. This is creation attribution, not a full audit of every write:
legacy direct writers record nothing and read as `unrecorded`. Only that (request,
principal) pair is stored; the operation, time and the principal's current name
are joined when you read it, so renaming a client renames it in every answer.

```bash
gbrain attribution notes/example-page              # created, last and live revision of the page
gbrain attribution notes/example-page --versions   # plus who wrote and who archived each version
gbrain attribution people/alice-example --fact 42  # one fact (about or fenced on the page)
gbrain attribution people/alice-example --take 3   # the take at row 3 of the page's takes table
gbrain attribution people/alice-example --timeline 17
```

Each attribution is `{ request_id, operation, principal: { kind, id, name }, at,
origin }`. Branch on `origin`:

| `origin` | Meaning |
| --- | --- |
| `request` | Written by the named journaled request; `operation` and `at` come from it. |
| `maintenance` | Written by a maintenance pass (cycle extraction, repair) as the named principal, with no request. |
| `unrecorded` | Written before attribution existed, or by a legacy writer that records none. Not an error. |

Who can read it:

- `get_write_attribution` needs `admin` scope (the local CLI always has it).
  Remote admins stay inside their source grant, see only `world` facts and only
  the take holders their grant allows. A page outside the grant reads as
  `page_not_found`.
- `get_versions` (`gbrain history`) adds `written_by` and `archived_by` to each
  version only for the local CLI and `admin` holders. A `read` or `write` grant
  gets the same version rows without any attribution field.

Rows written before this release start `unrecorded`. Fill the ones the write
journal proves exactly, after you agree; it is free and changes no content:

```bash
gbrain repair attribution-backfill           # preview: batches per table and the unrecorded_* counts left alone
gbrain repair attribution-backfill --apply   # fill them; rerun to resume after an interruption
```

The backfill fills a page revision or version only from the page write whose
recorded result is that exact revision, and a fact only from the `remember`
that inserted it. Everything else stays `unrecorded`; nothing is inferred.
`gbrain repair --all` and the doctor remediation plan include it.

## Read-only stdio serve

**Say to your agent:** *"Connect this agent to my brain read-only."* The agent
registers `gbrain serve --access read-only` as its stdio MCP command.

```bash
claude mcp add gbrain -- "$(command -v gbrain)" serve --access read-only
gbrain serve --surface starter --access read-only
```

`--access read-only` intersects the selected `--surface` with operations that
are read-scoped, non-mutating and need no capability scope. The same set
drives `tools/list`, the `gbrain://capabilities` resource (`access:
"read-only"`), skill resources and dispatch, so a guessed `put_page`,
`delete_page`, `remember`, `capture` or `request_tools` call answers
`unknown_tool` before any handler runs. It denies agent-requested
mutations; owner maintenance on the same process (startup migrations, hook
IPC banking) is a separate control. The default is `--access full`.
`gbrain serve --http --access read-only` refuses: narrow HTTP access per token
with `gbrain auth rescope-token <name> --operations <op,...>` or
`gbrain auth rescope-client <client_id> --allowed-operations <op,...>`.

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

<a id="admin-symptoms"></a>

| Symptom | What to do | Who acts | Consent | Verify |
| --- | --- | --- | --- | --- |
| Owner credential missing or refused | Use the server's protected credential mechanism; an MCP token cannot substitute. See owner credential recovery above. | brain host | `credentials` | a fresh login link opens the panel |
| Service unreachable or wrong URL | Verify the configured endpoint and existing service health; do not start a second brain. | brain host | none | the server's `/health` |
| Admin command unsupported by this server | Upgrade/restart the intended running server through its normal maintenance process. No local database fallback. | brain host | none | the server's reported version |
| Rate limited | Respect the retry timing; do not repeatedly mint login links or retry failed credentials. | provider | none | retry after the stated delay |
| Login link consumed/expired | Ask the authorized administrator for a new one; preserve the pending request ID when still valid. | brain host | `credentials` | the new link opens the panel |
| Consent expired/restarted/permissions changed | Restart authorization in the native client, then review its new request. | user (re-authorizes in the native client) | `credentials` | the client's tool list |
| Redirect or PKCE/authentication-method mismatch | Compare setup metadata with the native client's actual callback and method. The native client owns its verifier. | brain host | none | setup metadata matches the client's callback |
| Duplicate client name | Inspect the reported existing client ID; recover its setup instead of creating another client. | brain host | none | the client list |
| Mutation response lost or timed out | Outcome may be unknown. Inspect the client/list before retrying; a transport error does not prove nothing changed. | brain host | none | the client list |
| `grant_conflict` | Inspect the current revision and preview the intended action again. | brain host | none | the preview of the intended action |
| `permission_denied` with `fence=no_source_grant` | The legacy token's source grant is an explicit empty list. Grant sources with `gbrain auth rescope --token <name> --sources <id,...>` ([legacy token grants](#legacy-token-grants)); the refusal's `fix` names the token by `--id`. | brain host | none | the token's grant in the client list |
| Client/source list failed | Retry the failed request; an error is not an empty registration list or a missing source. | agent | none | the same list request |
| Public OAuth setup has no secret | Expected for authentication method `none`. Connect using native PKCE. | user | none | a native PKCE connection |
| Confidential secret delivery interrupted | Use `mcp admin setup … --credentials-out PRIVATE_FILE` to recover the retained delivery; never expose it in ordinary output. | brain host | `credentials` | the private credentials file exists |
| Recovery journal unavailable or secret no longer matches | Use an existing private handoff if available. Otherwise choose an explicit maintenance/reprovisioning action; do not silently rotate or duplicate. | brain host | `credentials` | the client list |
| Server probe passes but harness does not connect | Check the actual native configuration, reload/authorization state, and observed tool call. Report native verification as incomplete. | user (reloads the harness) | none | an observed tool call in the harness |

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
