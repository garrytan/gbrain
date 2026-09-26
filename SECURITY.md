# Security

## Reporting Vulnerabilities

If you discover a security issue in GBrain, please report it privately by opening
a [private security advisory](https://github.com/garrytan/gbrain/security/advisories/new)
on GitHub.

Do not open a public issue for security vulnerabilities.

## Automated security scanning

CI runs three automated security checks alongside secret scanning (Gitleaks):

- **Dependency vulnerabilities** — OSV-Scanner
  (`.github/workflows/osv-scanner.yml`) runs weekly and on any PR that touches
  `package.json` or `bun.lock`.
- **Static analysis (SAST)** — Semgrep CE (`.github/workflows/semgrep.yml`)
  runs on every PR and weekly. On a PR it is **blocking for findings new since
  the PR base** (`--baseline-commit`), so a net-new issue fails the check while
  pre-existing findings never block an unrelated PR. Scheduled/dispatch runs do
  a full-tree report-only scan.
- **Release binary provenance** — release builds
  (`.github/workflows/release.yml`) attest each compiled binary with
  [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations),
  and build the admin UI fresh from `admin/src` at release time so the shipped
  binary embeds a bundle traceable to source (not committed `admin/dist` bytes).
  Verify a downloaded release binary manually with:

  ```bash
  gh attestation verify ./gbrain-darwin-arm64 -R garrytan/gbrain
  gh attestation verify ./gbrain-linux-x64 -R garrytan/gbrain
  ```

All security workflows use SHA-pinned actions and least-privilege permissions,
enforced structurally by actionlint on every workflow change.

### Install-path trust model

- **Compiled-binary self-update (`gbrain upgrade` on `darwin-arm64` /
  `linux-x64`)** verifies integrity automatically before it installs: it
  computes the downloaded binary's SHA-256 and checks it against the build
  provenance attestation fetched from the GitHub REST API — a different origin
  than the asset CDN — confirming both the attested digest and that the
  attestation's builder id is this repo's release workflow. Verification is
  fail-closed: on a mismatch or an unfetchable attestation, the download is
  discarded and the running binary is left untouched. It also refuses a binary
  whose reported version doesn't match the release it was fetched for (a
  downgrade-replay guard). The dependency-free check is GitHub-account trust
  plus origin separation and a digest/identity match against the attestation
  fetched over TLS; it does NOT independently verify the attestation's Sigstore
  signature (the Fulcio certificate chain or Rekor inclusion).
- **From-source and pinned-tag installs remain trust-on-first-use.**
  `bun install -g github:garrytan/gbrain#latest-stable` follows a force-moved
  tag, and the `codex-plugin` branch / template repo are force-published; these
  paths trust TLS + GitHub without an independent integrity check. From-source
  installs also serve the committed `admin/dist` bundle (devDeps for a fresh
  admin build are not installed by a global install), so that bundle is
  trust-on-first-use on this path. For the strongest guarantee, install the
  attested release binary and run `gh attestation verify` as above.

## Environment variables and cwd `.env` files

gbrain is usually a globally installed CLI (or a compiled binary) that runs
with an arbitrary working directory — the repo you happen to be in, the
workspace an agent hook fires from. Bun auto-loads `.env`, `.env.local` and
the `.env.<NODE_ENV>[.local]` variants from that working directory into the
process environment before any gbrain code runs, for `bun run` and for
compiled binaries alike, and it expands `${VAR}` references inside those
files. A `.env` committed into a cloned repository is therefore **untrusted
input** — it was written by whoever authored the repo, not by you.
Compiled `gbrain` binaries are built with `--no-compile-autoload-bunfig`, so a
`bunfig.toml` in the working directory is inert — it cannot preload code into
the binary before gbrain starts (a CI guard keeps every build invocation
flagged). The development runtime `bun src/cli.ts` stays bun-native; a
contributor's own working directory is trusted. Script-mode installs
(`bun install -g github:garrytan/gbrain`, `git clone` + `bun link`) run
`src/cli.ts` as an ordinary Bun script, and Bun applies the current
directory's `bunfig.toml` before any gbrain code runs — gbrain prints a
one-line warning when it finds a top-level `preload` there, but it cannot
undo it. Only the compiled binary ignores a cwd `bunfig.toml`; run script-mode
gbrain from directories you control, or use the release binary in untrusted
checkouts.

**The trust boundary.** Security-relevant variables are honored from your
shell environment, from a service `EnvironmentFile`, and from
`~/.gbrain/.env` (the operator-owned secrets file). They are **never** honored
from a `.env` file in the current directory. At startup every gbrain process
checks the working directory's `.env` family and, for each protected variable
that one of those files *assigns* (whatever the value — an expanded
`${PWD}/…` looks like an ordinary absolute path by the time it reaches the
process), drops the variable and prints one line to stderr:

```
[env] Ignoring GBRAIN_PLUGIN_PATH because a .env file in the current directory assigns it — cwd .env files are untrusted for security settings. Export it from your shell or set it in ~/.gbrain/.env.
```

When a `.env` file in the current directory assigns any protected variable
(`GBRAIN_GUARDRAILS_MODULE` is the one exception — it refuses to run instead,
see below), gbrain drops it, prints one `[env] Ignoring …` line, and then re-runs itself
once from an empty temporary directory with the sanitized environment, switches
back to your directory, and exits with that run's status. The re-run's
environment simply lacks the dropped variables (they are never carried as empty
strings, which git and the dynamic loader would treat as set), so every program
gbrain spawns — git, the claude CLI, workers — inherits the clean view. The
internal variable `GBRAIN_CWD_ENV_QUARANTINED` marks the re-run — it is not a
setting, and gbrain honours it only when it provably started in the empty
directory the marker names. A signal-killed re-run maps to exit 128+signal;
the wrapper's exit status is always the re-run's (it relays the child and
nothing else), and the re-run dies with its wrapper: if the wrapper is
force-killed (SIGKILL cannot be forwarded), the re-run notices within about a
second, removes its neutral directory and exits, so a supervisor tracking the
wrapper's pid never leaves an orphaned worker behind. With a controlling terminal, Ctrl-C reaches the re-run directly
from that terminal and the wrapper does not forward it; with no controlling
terminal (a supervisor, cron, a detached harness) a SIGINT that reaches the
wrapper alone is forwarded once so the re-run is not orphaned; SIGTERM/SIGHUP
sent to the wrapper are always forwarded. When the dropped variable was a
planted `HOME`, the re-run receives your real home directory (derived from the
startup environment, never from the file) so git identity and `~/`-relative
paths keep working. gbrain processes that gbrain itself starts from
that directory (a supervised worker, a background push) repeat the step once
for their own subtree. This costs nothing when the working directory has no
`.env`, or when nothing protected is assigned there.

**Protected variables.** Two groups, one predicate
(`isCwdDotenvProtectedKey` in `src/core/env-trust.ts`):

- The security-relevant `GBRAIN_*` keys (`CWD_DOTENV_PROTECTED_KEYS`):
  code-loading `GBRAIN_GUARDRAILS_MODULE`, `GBRAIN_PLUGIN_PATH`; exec-target
  `GBRAIN_CLAUDE_CLI_BIN`, `GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG`,
  `GBRAIN_JOB_CHILD_CLI`, `GBRAIN_BIN_OVERRIDE`; root/registry redirect
  `GBRAIN_HOME`, `GBRAIN_MOUNTS_PATH`; the brain connection string
  `GBRAIN_DATABASE_URL` (a cwd `.env` would retarget every hook, query and
  write at a database it names — the `DATABASE_URL` value guard covers only
  the bare name) and the OAuth relay `GBRAIN_OAUTH_RELAY_URL`; posture-widening
  `GBRAIN_ALLOW_SHELL_JOBS`, `GBRAIN_ALLOW_PRIVATE_REMOTES`,
  `GBRAIN_ALLOW_UNVERIFIED_REMOTE`, `GBRAIN_GIT_ALLOW_FILE_TRANSPORT`,
  `GBRAIN_ALLOW_MASS_RECONCILE`, `GBRAIN_ALLOW_DEFAULT_WRITE`,
  `GBRAIN_NO_SANITY`, `GBRAIN_REMOTE_PRIVATE_PAGES`.
- The variable families through which a checkout could hijack the programs
  gbrain spawns rather than gbrain itself (`CWD_DOTENV_PROTECTED_PREFIXES`,
  `CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS`): the `LD_*`/`DYLD_*` dynamic-loader
  family, git configuration/hook/exec injection (`GIT_*`), Bun and npm runtime
  configuration (`BUN_*`, `NPM_CONFIG_*`/`npm_config_*`), Node preload and
  TLS knobs (`NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`,
  `NODE_TLS_REJECT_UNAUTHORIZED`), the `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/
  `XDG_CACHE_HOME` and `GNUPGHOME` roots that git and other tools read as
  global configuration, the `SSL_CERT_FILE`/`SSL_CERT_DIR`/`CURL_CA_BUNDLE`/
  `REQUESTS_CA_BUNDLE` trust stores, the OpenSSL provider/engine loaders
  (`OPENSSL_CONF`, `OPENSSL_ENGINES`, `OPENSSL_MODULES` — a planted
  configuration loads a shared object into every OpenSSL-linked child such as
  git over https), the temp roots (`TMPDIR`, `TMP`, `TEMP`) that the sanitized
  re-run's neutral directory and every temp write resolve through, `HOME` and
  `USERPROFILE` (inert while exported, but where `HOME` is unset a planted
  value would relocate `~/.gitconfig`, `~/.ssh` and `~/.gbrain` into the
  checkout), the shell-startup and interpreter-home family the
  non-interactive shells gbrain's children start would read (`BASH_ENV`,
  `SHELLOPTS`/`PS4`, `BASHOPTS`, `PROMPT_COMMAND`, `ZDOTDIR`, `PYTHONHOME`,
  `PERLLIB`, `GCONV_PATH`, and exported functions under the `BASH_FUNC_*`
  prefix), `EDITOR`/`VISUAL`/`PAGER`, ssh askpass
  programs, interpreter preload for Python/Perl/Ruby helpers, HTTP(S)/ALL proxy
  variables in both spellings, and every AI-provider endpoint or credential
  variable gbrain's gateway reads from the environment (`CLAUDE_CONFIG_DIR`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_BASE_URL`,
  `OPENROUTER_BASE_URL`, `LITELLM_BASE_URL`, `OLLAMA_BASE_URL`,
  `LMSTUDIO_BASE_URL`, `LLAMA_SERVER_BASE_URL`, `LLAMA_SERVER_RERANKER_BASE_URL`).
  The endpoint-redirect `GBRAIN_*` keys (`GBRAIN_REMOTE_MCP_URL`,
  `GBRAIN_REMOTE_ISSUER_URL`, `GBRAIN_DIRECT_DATABASE_URL`) and the re-run
  marker itself are in the first group. This is a denylist of known hijack
  families; it grows as new families are identified.

`GBRAIN_GUARDRAILS_MODULE` additionally accepts only an absolute path or a
`~/` path: cwd-relative specs and bare package names are refused (a package
name would resolve from the current directory's `node_modules`). It is also
the one key that fails closed at the cwd boundary: when a cwd `.env` assigns
it and a non-empty value was dropped, gbrain does not re-run without it — it
refuses to start (exit 1, `guardrails: GBRAIN_GUARDRAILS_MODULE is assigned by
a .env file in the current directory; refusing to run without the operator's
firewall …`), because Bun merges the file before gbrain starts and a value you
exported cannot be told apart from the file's. A benign repository never
assigns this gbrain-specific key; your own setting belongs in your shell or in
`~/.gbrain/.env`.

**Semantics worth knowing.**

- *Per process, then inherited.* Every gbrain process re-applies the check at
  startup; the one-time sanitized re-run above is what makes the result reach
  git, the agent CLI and workers. The supervisor passes the shell-job opt-in to
  workers — and workers to per-job child processes — as the
  `--allow-shell-jobs` flag so the quarantine cannot silently disable it.
- *Key presence, not value.* If a cwd `.env` assigns a protected key, a value
  you exported from the shell is dropped too while you stay in that directory —
  the warning tells you so. Move the setting to `~/.gbrain/.env` or run from
  another directory. A family member you exported (say `GIT_AUTHOR_NAME`) is
  untouched unless the cwd `.env` assigns that same name.
- *Everything else still loads.* Routing and tuning `GBRAIN_*` variables and
  every variable not listed above still load from a cwd `.env` as before.
  `DATABASE_URL` keeps its own, value-matching guard (see `docs/ENGINES.md`).
  `GBRAIN_DATABASE_URL` exported from your shell is always honored, but a
  `GBRAIN_DATABASE_URL` *assigned by a cwd `.env`* is dropped like any other
  protected key — a project directory never gets to choose which brain you
  write to. Move it to your shell or `~/.gbrain/.env`.
- *Your own config directory.* Running gbrain from inside `~/.gbrain` (or
  `$GBRAIN_HOME/.gbrain`) makes its `.env` the "cwd `.env`". That file is
  yours, so it is honored without a warning — unless a cwd `.env` assigns
  any key the config directory is derived from (`GBRAIN_HOME`, `HOME`,
  `USERPROFILE`); a planted home is never treated as your config directory.
- *Server deployments.* `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, `GBRAIN_HTTP_CORS_ORIGIN`
  and `GBRAIN_HTTP_TRUST_PROXY` are deliberately not on the list so documented
  container deployments that co-locate them keep working — launch
  `gbrain serve --http` from a directory you control.
- *Compiled binaries included.* The check and the sanitized re-run behave
  identically in `bun run src/cli.ts` and in the compiled `gbrain` binary.

If you kept one of the protected variables in a project's `.env` on purpose,
move it to `~/.gbrain/.env` (loaded before anything else, never overriding a
shell export) or export it from your shell profile.

## Remote MCP Security

### Keep dynamic client registration disabled unless explicitly needed

GBrain disables Dynamic Client Registration (DCR) by default. Keep that
default for internet-reachable deployments and pre-register trusted clients
with operator-approved scopes and source access. Enabling DCR lets network
callers create OAuth client records, so use it only when the deployment's
trust model requires self-service registration. Self-registered clients still
need the owner's approval in the admin dashboard for every authorization-code
connection; DCR by itself never yields a token.

When DCR is on, a self-registered client passes three gates. At registration
it may request at most `read write`; a request for any privileged scope is
rejected with HTTP 400 `invalid_client_metadata` (never silently narrowed) and
the error text points at the operator path (`gbrain auth register-client`, the
admin API, or a later `gbrain auth rescope-client <client_id> --scopes ...`).
Every authorization-code connection then stops at the admin dashboard for the
owner's approval before a code is minted — approval never widens the
registered scope. Finally, codes and tokens are re-intersected with the
client's current registered scope on every request, so a rescope takes effect
immediately.

Do not enable `--enable-dcr-insecure` on an untrusted network. That option is
reserved for deployments that intentionally allow self-registered
machine-to-machine (`client_credentials`) clients, which are issued tokens
without owner approval; such clients are capped at **read-only** scope.

### Recommended: `gbrain serve --http` published with `gbrain mcp expose`

GBrain ships a built-in HTTP transport (OAuth 2.1 plus the existing
`access_tokens` bearer table). The recommended way to publish it from your own
computer is `gbrain mcp expose`:

```bash
# Publish on your Tailscale tailnet (HTTPS, tailnet-only, user service keeps it running)
gbrain mcp expose

# Public HTTPS on the same name — only for agents that run in a vendor's cloud
gbrain mcp expose --funnel

# Provision each client with a least-privilege grant through the running server
gbrain mcp grant agent-example --harness codex --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/agent-example.json
```

**Say to your agent:** *"use my brain over mcp"* — *"put my brain on tailscale"*
— the `remote-mcp` skill shows you the plan and asks before installing
Tailscale or a service.

Why this shape: the server keeps its loopback bind and Tailscale terminates
TLS, so nothing listens on a LAN or public interface; tailnet-only reach means
only your own devices, under your Tailscale ACLs, can even see the name; Funnel
is an explicit opt-in and every request still needs a gbrain token; the admin
bootstrap token lives in a 0600 file the service reads at run time and is
never printed or stored in the service definition; `--remove` undoes only
gbrain's own handler and service. Self-service registration stays off unless
you pass `--enable-dcr`. Details and the troubleshooting table:
[docs/guides/remote-mcp.md](docs/guides/remote-mcp.md).

Running the server yourself behind ngrok or on a cloud host works the same way
(`gbrain serve --http --public-url https://…`; [docs/mcp/DEPLOY.md](docs/mcp/DEPLOY.md)).
Bearer tokens are managed via `gbrain auth create/list/revoke`; OAuth clients
via `gbrain auth register-client` / `gbrain mcp grant` and the admin dashboard.

### If you must use a custom HTTP wrapper

1. **Require a secret for client registration** — check a header or body
   parameter before creating new OAuth clients
2. **Disable `client_credentials` grant** — only allow `authorization_code`
   with browser-based approval
3. **Restrict scopes** — never issue tokens with unlimited scope
4. **Log all token issuance** — alert on unexpected registrations
5. **Rate-limit registration and token endpoints**

### Pre-registering claude.ai / ChatGPT clients without DCR (v0.41.3+)

The recommended hardening posture above is: ship `gbrain serve --http`
**without** `--enable-dcr` and pre-register every client manually. As of
v0.41.3, `gbrain auth register-client` accepts the OAuth fields
browser-based clients need:

```bash
# Pre-register claude.ai (confidential client; two redirect URIs)
gbrain auth register-client claude-ai \
  --scopes "read write" \
  --redirect-uri https://claude.ai/api/mcp/auth_callback \
  --redirect-uri https://claude.com/api/mcp/auth_callback
# --grant-types is auto-set to authorization_code,refresh_token when
# --redirect-uri is passed; pass --grant-types explicitly to override.

# Pre-register ChatGPT (public PKCE client; no client_secret minted)
gbrain auth register-client chatgpt \
  --scopes "read write" \
  --redirect-uri https://chatgpt.com/connector/oauth/<HASH> \
  --token-endpoint-auth-method none
```

Auth methods (`--token-endpoint-auth-method`):

- `client_secret_post` (default) — confidential client, secret in body
- `client_secret_basic` — confidential client, secret in `Authorization` header
- `none` — public PKCE-only client (no secret minted; ChatGPT custom
  connector, Claude Code, Cursor)

The same validator applies to CLI, admin, and DCR registration paths, so
unknown authentication methods are rejected consistently. Browser-based
clients can be configured entirely through the supported CLI flags; operators
do not need to edit OAuth database rows by hand.

### DCR consent default and scope ceiling

The "disable `client_credentials`, only allow `authorization_code`" guidance
above is the built-in default for the DCR path, not just advice for custom
wrappers. With `--enable-dcr` on, a self-registered client defaults to the
`authorization_code` (owner-approval) grant, and an explicit
`client_credentials` request is rejected with `invalid_client_metadata`.
Operators who genuinely need the machine-to-machine grant on the registration
endpoint opt in with `--enable-dcr-insecure` (which implies `--enable-dcr`);
those anonymous machine clients are limited to `read`. While DCR is enabled,
OAuth discovery advertises only the self-registration ceiling (`read write`)
as `scopes_supported`, so a client that registers with the advertised scopes
is accepted, and an explicit request above the ceiling is still refused. A
startup WARNING prints whenever DCR is enabled, and a second when the insecure
grant is allowed. Pre-registering clients via the CLI / admin API is unchanged
and accepts every scope; discovery without DCR lists every scope such a client
may hold.

`gbrain doctor` (`oauth_client_scope_health`) warns about active clients that
hold a scope beyond the self-registration ceiling but carry no operator grant
record, with the exact `rescope-client` / `revoke-client` remedy. Remote
`sources_remove` callers may remove only their own write source (a federated
read grant naming a source does not make it removable); any other id answers
`not_found`, indistinguishable from a nonexistent source. `sources_status`
keeps the read-scope confinement it shares with `sources_list`, and the local
CLI keeps full operator authority.

### Owner approval for authorization-code connections

`/authorize` never issues an authorization code on its own. It records a
pending request and sends the browser to the admin dashboard, where the brain
owner signs in (bootstrap token or magic link), reviews the client name,
redirect URI and requested scopes, and approves or denies. Only an approval
mints a code; the code is bound to the client, redirect URI and S256 PKCE
challenge of the pending request and is delivered to the client's registered
redirect URI. A denial returns `error=access_denied`. This applies equally to
clients that self-registered through Dynamic Client Registration — with
`--enable-dcr`, self-registration lets a network caller create a client record
and a pending request, never a token. Revoked clients are refused at
`/authorize` before a pending request is created.

Pending requests expire after ten minutes and do not survive a server restart.
They are bounded twice: a server-wide ceiling on the in-memory store and a
per-client ceiling of ten requests awaiting a decision. Beyond either,
`/authorize` sends the client back to its registered redirect URI with
`error=too_many_requests` and no code until earlier requests are decided or
expire; a `429` status on `/authorize` comes only from the MCP SDK's built-in
per-IP limits, which remain in force on `/authorize`, `/register` and `/token`.

### Token Management

New authorization-code connections require owner approval in the admin UI and
S256 PKCE for public and confidential clients. Consent requests expire after
ten minutes; restart the client connection after expiry or a server restart.
Existing active-client sessions remain valid. Review and revoke unwanted
clients in the existing Agents page.

Queued work also retains its submitting authority and is revalidated before
execution. Worker upgrades require a stopped-service cutover; see the
[authorization and worker upgrade guide](docs/guides/authorization-upgrade.md)
before migrating an existing queue. That guide also covers the Bun 1.3.11
minimum and guarded outbound connections.

```bash
gbrain auth create "claude-desktop"   # Create a new token
gbrain auth list                       # List all tokens
gbrain auth revoke "claude-desktop"    # Revoke a token
gbrain auth test <url> --token <tok>   # Smoke-test a remote server
```

Tokens are stored as SHA-256 hashes in the `access_tokens` table. The
plaintext token is shown once at creation and never stored.

## `gbrain serve --http` hardening (v0.22.7+)

The built-in HTTP transport ships with several layers of hardening on by
default. All env vars below are optional; the defaults are intentionally
conservative.

### Bind address (v0.34: loopback by default)

`gbrain serve --http` listens on `127.0.0.1` by default. Personal-laptop
installs cannot accidentally publish the brain to the LAN. Self-hosted
deployments that need remote access pass `--bind 0.0.0.0` (all
interfaces) or `--bind <interface-ip>` (specific NIC). A stderr WARN
fires when `--public-url` is set without `--bind` so the operator sees
the binding before the first request — common cause of "ngrok forwards
to me but the agent can't reach the upstream" misconfigurations.

### PGLite and Postgres

`gbrain serve --http` runs on both engines (both schemas carry
`access_tokens` and the OAuth tables). PGLite is single-writer: while the
HTTP server holds the brain, administer it through the running server
(`gbrain mcp grant … --admin-token-file`, the admin dashboard) rather than a
second process that opens the database — such a process fails fast with
`live_serve`; `gbrain sync` and `gbrain sweep --once` delegate into the live
serve. Mint bearer tokens (`gbrain auth create`) before the service runs, or
grant scoped clients through the server. Local agents on the same machine can
still use stdio (`gbrain serve`) when no HTTP server is running.

### Docker network isolation (self-hosted Postgres)

OAuth and source scoping enforce isolation on the `serve --http` path only.
Raw Postgres reachability bypasses both: a container that shares Docker's
default `bridge` network with the brain's Postgres can open a direct DB
session without any token and read every source. Put the brain's Postgres on
a user-defined Docker network with nothing untrusted on it, publish its port
loopback-only (if at all), and never put `DATABASE_URL` or a Postgres
password in untrusted agent containers — those should reach the brain
exclusively via OAuth against `serve --http`. Full operator checklist:
[docs/mcp/DEPLOY.md — Co-located Docker workloads](docs/mcp/DEPLOY.md#co-located-docker-workloads-self-hosted-postgres).

### CORS

Default-deny: no `Access-Control-Allow-Origin` header is sent unless an
allowlist is configured. To allow browser-based MCP clients:

```bash
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
# Multiple origins: comma-separated
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai,https://your.app gbrain serve --http
```

When the request `Origin` matches the allowlist, the server echoes it
back in `Access-Control-Allow-Origin` (with `Vary: Origin`). Otherwise no
CORS header is sent and the browser blocks the request.

The same allowlist gates the complete MCP and OAuth HTTP surface. Actual
requests and browser preflight requests use one allowlist-gated policy, so
unlisted origins receive no cross-origin authorization. A startup stderr
warning fires when `--bind 0.0.0.0` is set without
`GBRAIN_HTTP_CORS_ORIGIN`, surfacing the default-deny posture before the
first request.

### Rate limiting

Two buckets, both stored in a bounded LRU map (default 10K keys, evicts
least-recently-used on overflow, prunes entries older than 2× the
window):

| Bucket | When it fires | Default | Env var |
|---|---|---|---|
| Pre-auth IP | Before the DB lookup, on every `/mcp` request | 30 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| Post-auth token | After a valid token is resolved | 60 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| LRU cap | Maximum distinct keys across both buckets | 10000 | `GBRAIN_HTTP_RATE_LIMIT_LRU` |

On exhaustion the server returns `429 Too Many Requests` with a
`Retry-After` header.

**Caveat for tunneled deployments (ngrok, Tailscale Funnel, Cloudflare
Tunnel):** all requests share one egress IP, so the pre-auth IP bucket
becomes effectively shared by all clients on that tunnel. The
post-auth token-id bucket is the load-bearing limiter for tunnel-fronted
deployments.

### Reverse-proxy trust

**Loopback-only by default** (v0.41.3+ Express server agrees with the
legacy transport; pre-v0.41.3 the Express server hardcoded `'loopback'`
while docs claimed "disabled by default" — that disagreement is gone).
The default trusts only same-host proxies (127.0.0.1, ::1, fc00::/7);
external forwarded-for headers are ignored regardless. To widen or
narrow trust:

```bash
# Trust exactly one hop — Fly.io, Render, Vercel, single-layer nginx
GBRAIN_HTTP_TRUST_PROXY=1 gbrain serve --http --port 8787

# Trust N hops — Cloudflare → nginx → gbrain
GBRAIN_HTTP_TRUST_PROXY=2 gbrain serve --http --port 8787

# Disable entirely — direct-exposure deployment with no proxy
GBRAIN_HTTP_TRUST_PROXY=0 gbrain serve --http --port 8787

# Named Express modes (uniquelocal, linklocal) or CIDR lists pass through
GBRAIN_HTTP_TRUST_PROXY=uniquelocal gbrain serve --http --port 8787
GBRAIN_HTTP_TRUST_PROXY="10.0.0.0/8,192.168.1.0/24" gbrain serve --http --port 8787
```

Both transports (Express OAuth server in `src/commands/serve-http.ts` and
the legacy bearer transport in `src/mcp/http-transport.ts`) read the same
env var, so single source of truth.

**Critical safety contract:** only widen past `'loopback'` when **both**
of these are true:

1. gbrain is reachable only via a trusted reverse proxy (not directly
   exposed to the internet on the configured port). As of v0.34
   `gbrain serve --http` binds `127.0.0.1` by default, so the
   reverse-proxy-only posture is the out-of-the-box shape; only
   override with `--bind 0.0.0.0` (or a specific interface IP) when
   gbrain itself needs to accept remote connections directly.
2. The proxy strips any client-supplied `X-Forwarded-For` and `X-Real-IP`
   headers, then sets them itself. (nginx with `proxy_set_header
   X-Forwarded-For $remote_addr` does this; Cloudflare and most cloud
   load balancers handle it automatically.)

If gbrain is reachable directly AND `GBRAIN_HTTP_TRUST_PROXY=1` (or any
non-loopback value) is set, clients can spoof their IP by sending
arbitrary `X-Forwarded-For` headers, defeating the pre-auth IP rate
limit. The `'loopback'` default protects against this by ignoring all
forwarded-for headers and using the socket peer address.

### Body size cap

Default 1 MiB, stream-counted (chunked transfers without
`Content-Length` are still capped). Override:

```bash
GBRAIN_HTTP_MAX_BODY_BYTES=2097152 gbrain serve --http   # 2 MiB
```

Over-cap requests get `413 Payload Too Large` immediately, before any
body is materialized in memory.

### Audit log

Every `/mcp` request writes one row to `mcp_request_log`:

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, token_name, operation, status, latency_ms
   FROM mcp_request_log
   ORDER BY created_at DESC LIMIT 100"
```

`status` is one of: `success`, `error`, `auth_failed`, `rate_limited`,
`body_too_large`, `parse_error`, `unknown_method`. Failed-auth rows have
`token_name = NULL`. Inserts are fire-and-forget so audit failures
never block requests.

**v0.26.9 redaction default.** The `params` column now stores
`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}` instead
of raw JSON-RPC payloads. Declared keys (intersected against the operation's
spec) preserve for debug visibility; unknown keys are counted but never
named so attackers can't probe key existence; byte sizes bucket to 1KB so
content sizes can't be binary-searched. The same shape is broadcast on the
admin SSE feed at `/admin/events`. Operators on a personal laptop who want
raw payloads back can pass `gbrain serve --http --log-full-params` (loud
stderr warning at startup). Multi-tenant deployments should leave it
on the redacted default.

## If a secret reached the brain

Transcript ingest, captures and syncs redact credential-shaped strings before
anything is written: vendor key prefixes, JWTs, cloud/API key shapes, `Bearer`
headers, connection strings carrying inline passwords, PEM private keys, and
high-entropy `KEY=`/`TOKEN=`/`PASSWORD=` assignments. No pattern set is
complete. If you find a live credential in a page:

1. **Rotate the credential first.** Anything readable by a connected agent
   should be treated as exposed.
2. **Remove the page immediately**, from the host machine:

   ```bash
   gbrain delete <slug> --purge
   ```

   `--purge` is honored only by the local CLI; remote/MCP callers keep the
   72-hour soft delete. It removes the row and its chunks, links and raw session
   metadata with no recovery window, and it refuses to report success while
   the page's markdown file remains on disk: it retries the removal and, if the
   file still cannot be removed, stops with `storage_error` naming the path so
   you can fix permissions and re-run (the row stays soft-deleted until the
   file is gone). Verify with `gbrain get <slug>` (expects not found).
3. **Check the other copies.** The brain-repo git history, a synced working
   tree, an export directory or a compiled context file may still hold the
   value; rewrite/re-push or regenerate those as needed.
4. Add a value's fingerprint (printed with every `gbrain sources push` finding)
   to `<workspace>/.gbrain-scan-allow` ONLY for values you have confirmed are
   not credentials.

**Say to your agent:** *"a secret leaked into a brain page — rotate it and
purge the page"* (your agent rotates the credential, then runs
`gbrain delete <slug> --purge` on the host).

Behavior note: connection strings with inline passwords now block
`gbrain sources push` / bootstrap verify and are dropped from compiled-context
entries. The escape hatch is the same `.gbrain-scan-allow` fingerprint line.
