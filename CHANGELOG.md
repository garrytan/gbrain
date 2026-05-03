# Changelog

All notable changes to GBrain will be documented in this file.

## [0.26.3] - 2026-05-03

## **Admin dashboard you can trust. Magic-link login, single-use URLs, per-client token TTLs, observable everything.**
## **OAuth clients and bearer tokens in one unified table. Auth-type-aware setup for five MCP clients.**

v0.26.0 shipped the admin dashboard. v0.26.3 makes it production-trustworthy. The bootstrap token never persists in browser JS state. Magic-link URLs are single-use server-issued nonces (the bootstrap token never appears in a URL). Cookie sessions are HttpOnly + SameSite=Strict, and a "Sign out everywhere" button revokes every active session in one click. The trust model now matches what the marketing copy already implied.

Both auth lanes are visible. OAuth clients and legacy `access_tokens` show up in one unified Agents table with resolved names, last-used timestamps, request counts, and a Revoke button that actually works (the v0.26.0 button was a no-op shell). API key rows are clickable; the drawer adapts content based on whether the agent uses OAuth or raw bearer.

Per-client token TTL lands. Hardcoded 1-hour OAuth tokens meant Claude Code's built-in OAuth client (no auto-refresh) hit 401s every hour. New `oauth_clients.token_ttl` column + a Token Lifetime dropdown at register time (1h, 24h, 7d, 30d, 1y, no expiry). Editable from the agent drawer.

Request log gains real teeth. `params` and `error_message` columns on `mcp_request_log`, agent-name resolution threaded through the existing token-verification SELECT (one query, no separate cache), click-to-filter by agent, expandable row detail. Filter parameters use postgres.js tagged-template fragments — no string interpolation, no `sql.unsafe`. The "what just happened on my brain" question is now one click away.

Agent drawer adds a Config Export tab with auth-type-aware snippets for five clients: Claude Code (`read -s` prompt-based default + 2-step curl fallback so client secrets never enter shell history), ChatGPT, Claude.ai Cowork, Cursor (auth-type-aware bearer or OAuth), and Perplexity. ChatGPT/Cowork/Perplexity show an "OAuth client required" message when an API-key agent is selected, with a CTA pointing at the Register OAuth Client modal.

### The numbers that matter

18 fix-up commits on top of 16 PR commits, plus a separate codex pass that caught real bugs five Claude review passes missed (notably `loadApiKeys is not defined` in the Create-API-Key flow). Migration v33 adds the 5 columns the admin dashboard work was already referencing — without it, `gbrain upgrade` left the dashboard in a 503 state and the request log silently empty. Admin React build is now a CI gate so missing-symbol bugs fail before E2E.

| Metric | BEFORE v0.26.3 | AFTER v0.26.3 | Δ |
|---|---|---|---|
| Bootstrap-token persistence | localStorage (forever) | never client-side | trust boundary closed |
| Magic-link URL replay | works until server restart | single-use, ~5min TTL | URL leak limited |
| Sign-out blast radius | this tab only | all sessions everywhere | truthful button |
| OAuth token TTL | hardcoded 1h | per-client (1h–no expiry) | configurable |
| Per-MCP-request DB roundtrip | name lookup query | folded into existing auth SELECT | -1 query/req |
| Request-log filter SQL | sql.unsafe + manual escape | tagged-template fragments | no injection surface |
| Admin React build gating | none | CI step before E2E | bugs caught earlier |
| Schema migrations through v33 | 32 (admin cols missing) | 33 (admin cols present) | dashboard works |

### What this means for operators

Run `gbrain upgrade`. Restart `gbrain serve --http`. Ask your AI agent for the admin login link — it generates a one-time URL, you click, you're in. Close the tab, your session ends. Reopen, ask for a fresh link. No persistent token in your browser. Click Revoke on a misbehaving client and every existing token of theirs is invalid in one round-trip. Click Sign Out Everywhere and every browser tab dies. Watch the request log to see exactly which agents are doing what.

## To take advantage of v0.26.3

**Existing brains: run `gbrain apply-migrations --yes` after upgrade.** The dashboard 503s and the request log silently empties until migration v33 runs (5 new columns: `oauth_clients.token_ttl + deleted_at`, `mcp_request_log.{agent_name, params, error_message}`).

`gbrain upgrade` should chain this automatically. If you're already running `gbrain serve --http`:

1. **Run the migration explicitly:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Restart the server** so the new admin UI ships:
   ```bash
   gbrain serve --http
   ```
3. **Open `/admin`.** Ask your AI agent for a login link. Your agent reads the bootstrap token from the server's startup output and POSTs to `/admin/api/issue-magic-link` to mint a one-time URL. Click that URL — sets cookie, redirects to dashboard, link dies.
4. **Verify both auth lanes show up:**
   - Agents page → both OAuth clients and legacy bearer tokens in one table, click any row for details
   - Click "+ API Key" or "+ OAuth Client" to register
   - Request log resolves agent names directly (no per-request DB roundtrip thanks to the threaded JOIN)
5. **For new agents that need long-lived tokens** (Claude Code, gstack-desktop), pick a Token Lifetime ≥ 30d at register time. Editable from the agent drawer.
6. **For OAuth Claude Code config snippets:** the default uses `read -s` to prompt for the secret without echoing — secret never enters shell history. The 2-step curl fallback documents the alternative for shells that don't support `read -s`.
7. **Sign out everywhere** lives in the sidebar footer. One click revokes every active admin session.

If anything misbehaves, file an issue at https://github.com/garrytan/gbrain/issues with `gbrain doctor` output and which step broke.

### Itemized changes

**Schema (`src/core/migrate.ts`, `schema.sql`, `pglite-schema.ts`):**
- Migration v33 adds 5 columns the admin dashboard work was already using: `oauth_clients.{token_ttl, deleted_at}` + `mcp_request_log.{agent_name, params, error_message}`
- New index `idx_mcp_log_agent_time` for agent-filtered request-log queries
- Inline UPDATE backfill of `agent_name` from `oauth_clients.client_name` → `access_tokens.name` → raw `token_name`
- All ALTERs use `ADD COLUMN IF NOT EXISTS` so re-runs are no-ops

**Admin dashboard (`admin/`):**
- Bootstrap token never persists in browser JS state (no localStorage / sessionStorage cache)
- Magic-link login: agent calls `POST /admin/api/issue-magic-link` to mint a one-time nonce URL; redemption rotates in-memory; second click on same URL fails with the styled error page
- "Sign out everywhere" button revokes every active admin session in one click
- API Keys + OAuth clients in one unified Agents table; both row types clickable
- Hide-revoked toggle (defaults on) + empty-state placeholder when filtered result is empty
- Per-client Token Lifetime dropdown at registration (1h, 24h, 7d, 30d, 1y, no expiry); editable from agent drawer
- Auth-type-aware Config Export tabs:
  - Claude Code: `read -s` prompt-based snippet (default) + 2-step curl fallback for OAuth, plain bearer for API keys
  - Cursor: OAuth discovery URL OR raw bearer in `.cursor/mcp.json` based on auth type
  - ChatGPT / Claude.ai / Perplexity: render an "OAuth client required" message + CTA on API-key agents
- Request log: agent-name filter, params + error_message expandable detail, click-to-filter-by-agent
- Working Revoke Agent button (was a no-op in v0.26.0)
- Styled error page for expired/consumed magic links — tells operators how to recover
- DESIGN.md locks in the dashboard design system (Inter + JetBrains Mono, no accent color, semantic-badges-carry-color, left-align)
- Bug fix: `loadApiKeys()` reference replaced with `loadAgents()` — the Create-API-Key flow was throwing ReferenceError until codex caught it

**Server (`src/commands/serve-http.ts`, `src/core/oauth-provider.ts`):**
- `POST /admin/api/issue-magic-link` (Bearer auth with bootstrap token) → mints one-time nonce URL with 5-minute TTL
- `POST /admin/api/sign-out-everywhere` → calls `adminSessions.clear()`, returns `{revoked_sessions: count}`
- `GET /admin/auth/:nonce` is single-use (consumed nonces tracked in-memory with LRU cap of 1000) — bootstrap token never appears in a URL
- `crypto.timingSafeEqual` on both `/admin/login` and `/admin/auth/:nonce` hash comparisons
- Rate-limit `/admin/auth/:nonce` at 10/min/IP (express-rate-limit)
- `verifyAccessToken` JOINs `oauth_clients` in its existing token SELECT and returns `clientName` on `AuthInfo` — eliminates the per-MCP-request DB roundtrip for log agent-name resolution
- Request-log filter (`/admin/api/requests`) parameterized via postgres.js tagged-template fragments; `sql.unsafe()` + manual escape pattern removed; dead `paramIdx`/`query`/`params` variables deleted
- Legacy `access_tokens` path now also returns `clientName = name` for symmetry
- Ported `coerceTimestamp` helper (postgres-js BIGINT-as-string fix from master v0.26.2) so `test/oauth.test.ts` compiles standalone without needing a master merge

**Tests:**
- New E2E coverage in `test/e2e/serve-http-oauth.test.ts`:
  - mcp_request_log new column round-trip (pins migration v33 against silent failure)
  - Request-log filter SQL-injection probe (regression guard for parameterization)
  - Per-client TTL flow (register, mint, decode `expires_in`, assert)
  - Magic-link single-use semantic (nonce works once, fails twice)
  - Magic-link styled 401 page (Content-Type: text/html, body contains "expired")
  - agent_name resolution path
  - register-client missing-name input validation
- Renamed describe header to `serve-http OAuth 2.1 E2E (v0.26.1 + v0.26.2 + v0.26.3)`

### For contributors

- Admin React build is a CI gate now: `scripts/check-admin-build.sh` runs `cd admin && bun install && bun run build` alongside the typecheck step in `bun run test`. Catches missing-symbol bugs (the kind codex caught) before they reach E2E. `GBRAIN_SKIP_ADMIN_BUILD=1` is the inner-loop escape hatch; production CI must not set it.
- E2E test cleanup uses CLI `auth revoke-client` per registered `clientId` (with `dcrClientIds[]` accumulator for DCR-registered clients). The earlier `LIKE 'e2e-%'` pattern-matching cleanup was replaced — direct ID-based cleanup is safer (no risk of nuking a non-test client whose name happens to start with `e2e-`).
- `scripts/check-no-legacy-getconnection.sh` allow-list adds `src/commands/integrity.ts` (pre-existing `db.getConnection()` call from v0.22.16; PR 1 refactors to accept engine).
- Full plan + codex review pass artifacts live at `~/.claude/plans/check-this-out-and-breezy-forest.md` (5 review passes + codex outside-voice + 14 D-decisions documented).

## [0.26.2] - 2026-05-03

## **MCP fix-wave: every postgres-as-string OAuth bug, killed at the boundary.**
## **Bigger guarantees: `revoke-client` lands as a real CLI, NULL expires_at is treated as expired, corrupt rows fail loud at the row-read boundary instead of skating past validation.**

`gbrain serve --http` now does the right thing on every postgres-driver-as-string edge case the v0.26.1 hot-fix didn't reach. The same bug class that broke `client_credentials` token validation in production (postgres.js with `prepare: false` returns BIGINT columns as strings, and the MCP SDK's bearerAuth checks `typeof === 'number'`) hides at four other read sites in `src/core/oauth-provider.ts`. Two of those flow into the RFC 7591 §3.2.1 Dynamic Client Registration response, where strict OAuth clients reject string timestamps and the registration silently fails. v0.26.2 closes the bug class with a single named helper at the boundary.

The shape changed during eng + outside-voice review. The first draft normalized rows with inline `Number(...)` calls, but a `Number('foo') → NaN` slipping through is fail-OPEN, not fail-closed: `NaN < now` is `false`, so the expired-token branch is skipped and the SDK gets `expiresAt: NaN` as if the token were valid. Codex flagged this. The shipped helper, `coerceTimestamp()`, throws on non-finite input — corrupt rows fail loud at the boundary instead of riding through token validation.

Plus: `gbrain auth revoke-client <client_id>` lands as a first-class CLI subcommand. Schema-level `ON DELETE CASCADE` on `oauth_tokens.client_id` and `oauth_codes.client_id` purges every active token and authorization code in a single atomic transaction. The matching v0.26.1 E2E test had been calling this subcommand all along — silently failing because the subcommand didn't exist. v0.26.2 makes the cleanup actually work.

### The numbers that matter

5 string-vs-number sites identified in the original v0.26.1 audit; 5 fixed in v0.26.2. 4 new tests covering surfaces v0.26.1 didn't reach: real DCR `/register` HTTP-level response shape, real CLI subprocess invocation of `revoke-client`, NULL `expires_at` semantics, cascade-delete contract.

| Metric | BEFORE v0.26.2 | AFTER v0.26.2 | Δ |
|---|---|---|---|
| Sites where postgres-as-string can break OAuth | 4 latent (1 fixed in v0.26.1) | 0 | bug class closed |
| `Number(...)` on corrupt row | flows through as NaN (fail-OPEN) | helper throws (fail-CLOSED) | loud failure |
| `gbrain auth revoke-client` | doesn't exist | first-class CLI subcommand | +1 |
| E2E afterAll cleanup | silently failing | actually deletes the test client | reliable |
| DCR `/register` response timestamps | strings under `prepare: false` | RFC 7591 §3.2.1 numbers | spec-compliant |

### What this means for operators

Strict OAuth clients (Claude Code, Cursor) connecting via `gbrain serve --http` get spec-compliant `client_id_issued_at` numbers in their DCR responses. Operators get a real `revoke-client` subcommand and CASCADE-driven token purge. CI runs no longer leak orphan `gbrain_cl_*` rows on every E2E pass. Run `gbrain upgrade`. No schema migration. No manual step.

### For contributors

The boundary helper `coerceTimestamp` is intentionally module-private to `src/core/oauth-provider.ts` and not promoted to `src/core/utils.ts`. Codex review flagged repo-wide BIGINT precision-loss risk for a generic helper; the OAuth surface is bounded and well-understood, the rest of the repo isn't. Promote later if the pattern recurs.

### Known caveats

Hard-deleting a client orphans its entries in `mcp_request_log` (the table stores `token_name` TEXT with no FK). The admin UI's request-log view will show those entries with the literal token_name and no client correlation. Acceptable for a fix-wave; v0.27 can add a `[revoked]` badge or `LEFT JOIN`-aware rendering if forensics needs grow.

## To take advantage of v0.26.2

`gbrain upgrade` is sufficient. No schema migration. No manual step.

```bash
gbrain upgrade
gbrain --version  # should print 0.26.2
```

If you operate `gbrain serve --http` and have OAuth clients registered, no client-side action is needed. Existing tokens keep working. Rolling token rotation continues to work. The new `gbrain auth revoke-client <client_id>` subcommand is available for cleanup.

### Itemized changes

#### OAuth bug-class fixes
- **`coerceTimestamp()` boundary helper** in `src/core/oauth-provider.ts`. Throws on non-finite input (NaN/Infinity); returns undefined for SQL NULL so callers decide NULL semantics explicitly. Doc comment names the three load-bearing pieces: postgres `prepare: false` BIGINT-as-string behavior, MCP SDK's `typeof === 'number'` bearerAuth check, RFC 7591 §3.2.1 JSON-number requirement.
- **5 call sites refactored** to use the helper:
  - `getClient` (L112, L113): `client_id_issued_at` and `client_secret_expires_at` now flow through the helper, so DCR `/register` responses are RFC-compliant numbers.
  - `exchangeRefreshToken` (L274): NULL `expires_at` is treated as expired (fail-closed). Schema permits NULL on `oauth_tokens.expires_at`; corrupt rows can no longer ride past validation.
  - `verifyAccessToken` (L296, L303): same NULL-as-expired contract for access tokens; the SDK's bearerAuth gets a guaranteed `typeof === 'number'` value.
- **Removed inline `Number(...)` from L303** introduced in v0.26.1; replaced with the helper-narrowed value from the L296 guard for consistency. Behavior unchanged.

#### New CLI subcommand
- **`gbrain auth revoke-client <client_id>`** lands in `src/commands/auth.ts`. Atomic `DELETE...RETURNING` on `oauth_clients`, FK CASCADE purges `oauth_tokens` and `oauth_codes`. Prints client name + cascade confirmation. `process.exit(1)` on no-such-client (idempotent: re-running on the same id produces the same exit-1 message).
- Help text + router case wired alongside `register-client`.

#### Tests
- `test/oauth.test.ts`: 5 unit cases for `coerceTimestamp` (null/undefined/string/number/throw-on-NaN), NULL-`expires_at`-as-expired contract test, cascade-delete contract test.
- `test/e2e/serve-http-oauth.test.ts`: real DCR `/register` HTTP-level response-shape test (asserts `typeof body.client_id_issued_at === 'number'` over the wire, not just internal-store shape); real CLI subprocess test for `revoke-client` (registers → mints token → revokes via execSync → asserts token rejected at `/mcp` → asserts re-run exits 1).
- E2E `afterAll` cleanup: now guarded on `clientId` (won't throw if `beforeAll` failed before registration); cleanup errors surface to stderr without throwing so real test failures aren't masked. Tracks DCR-registered clients alongside the manual one.
- Server fixture: `--enable-dcr` added so `/register` is reachable in the DCR test.

#### Mechanics
- `VERSION` → `0.26.2`. `package.json` → `0.26.2`. `bun.lock` refreshed.

### Credits

This branch was driven by an audit of PR #577 (v0.26.1). Codex independent review surfaced 5 factual errors and 7 design gaps the in-house eng review had cleared. The shipped scope is tighter and more honest than the original D1 plan — the outside voice was the load-bearing input.

## [0.26.1] - 2026-05-03

## **MCP bearer-auth hot-fix: `client_credentials` tokens stop being rejected at `/mcp`.**

A three-bug fix-wave landed on master as PR #577 to unblock production OAuth connections. Every token minted via `client_credentials` was being rejected at `/mcp` with `HTTP 401 {"error":"invalid_token","error_description":"Token has no expiration time"}`. Token issuance worked; validation failed because the postgres-js driver with `prepare: false` returns BIGINT columns as strings and the MCP SDK's bearerAuth middleware checks `typeof authInfo.expiresAt === 'number'`.

Found in production connecting Claude Code through Caddy/Tailscale to `gbrain serve --http`.

### What shipped

- **`Number(row.expires_at)` cast** in `verifyAccessToken` (`src/core/oauth-provider.ts:303`) so the SDK gets a JS number, not a postgres string.
- **OAuth metadata interceptor middleware** in `src/commands/serve-http.ts:164-175`. The MCP SDK hardcodes `grant_types_supported: ['authorization_code', 'refresh_token']` in its `.well-known/oauth-authorization-server` response. The middleware patches `res.json` to append `client_credentials` so RFC-conformant clients (Claude Code, Cursor) auto-discover the flow.
- **Express 5 compat fixes** in `src/commands/serve-http.ts`:
  - `app.set('trust proxy', 'loopback')` so reverse-proxy deployments (Caddy on localhost, Tailscale) don't crash `express-rate-limit` with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`. Restricts proxy trust to localhost only — does NOT trust arbitrary `X-Forwarded-For`.
  - `/admin/{*path}` (Express 5 named-wildcard syntax) instead of the bare `/admin/*` Express 5 dropped.

### Tests

50 cases / 201 assertions including a real-Postgres E2E (`test/e2e/serve-http-oauth.test.ts`) that spawns a subprocess server, registers an OAuth client via the CLI, mints tokens via client_credentials, and exercises the full MCP JSON-RPC pipeline end-to-end.

### Process note

PR #577 shipped its three fixes but did not bump `VERSION`, `package.json`, or `CHANGELOG.md`. v0.26.2 retroactively writes this v0.26.1 entry so the changelog matches the commit history. The /ship workflow's version idempotency check (Step 12) will catch drifts like this in the future.

### Credits

Co-authored by Wintermute. Found in production. Three bugs, 22 lines, real fix.

## [0.26.0] - 2026-04-25

## **Multi-agent MCP is real. OAuth 2.1, HTTP server, React admin dashboard. Ship once, every AI client connects.**
## **`gbrain serve --http` starts a production-grade OAuth server with embedded admin UI. Zero external dependencies.**

This is GBrain as an organizational knowledge layer. Multiple AI agents, authenticated with scoped tokens, hitting the same brain over the wire. Perplexity Computer writes research. Claude queries for context. ChatGPT calls tools. Every request authenticated, every scope enforced, every action logged. One binary, zero infrastructure.

OAuth 2.1 via the MCP SDK's built-in infrastructure (`mcpAuthRouter` + `OAuthServerProvider`). Full spec compliance: client credentials for machine-to-machine (Perplexity, Claude), authorization code with PKCE for browser-based clients (ChatGPT), token refresh with rotation, dynamic client registration (default off behind `--enable-dcr` flag), token revocation, protected resource metadata. 30 operations tagged with `scope: 'read' | 'write' | 'admin'`, enforced in the HTTP transport before dispatch. `sync_brain` and `file_upload` are `localOnly` ... admin-scoped AND excluded from HTTP, so remote agents cannot reach local filesystem surface area.

React admin dashboard baked into the binary. Seven screens designed through Steve Krug's "Don't Make Me Think" lens: login, dashboard with live activity SSE feed, agents table with sparklines, register agent modal with scope checkboxes, credentials reveal with copy buttons and JSON download, filterable request log with pagination, agent detail drawer with per-client config export. Dark theme, JetBrains Mono for data, Inter for UI. Dense utilitarian layout. HTTP-only SameSite=Strict cookie auth with bootstrap token printed to the terminal on first start. 65KB gzipped.

### The numbers that matter

7 bisectable commits on this branch before the merge. 27 dedicated OAuth tests, all pass. Full suite: 2068 pass / 18 pre-existing master timeouts (unchanged from the merge). Typecheck clean.

| Metric | BEFORE v0.26 | AFTER v0.26 | Δ |
|---|---|---|---|
| Auth mechanism | static bearer tokens | OAuth 2.1 + legacy fallback | protocol-compliant |
| Concurrent agents | 1 (stdio only) | many (HTTP) | unbounded |
| ChatGPT support | impossible (needs OAuth + PKCE) | native | unblocked |
| Admin surface | CLI-only | /admin dashboard | +7 screens |
| Scoped operations | 0 | 30 (all) | +30 |
| New tests | ... | 27 (oauth.test.ts) | +27 |

### What this means for agents

`gbrain auth register-client perplexity --grant-types client_credentials --scopes "read write"` gives you credentials. `gbrain serve --http --port 3131` starts the server, prints the admin bootstrap token. Open `localhost:3131/admin`, paste the token, watch the live feed. Every Perplexity search, every Claude query, every ChatGPT tool call streams into the dashboard in real time. You see who's connected, what they're doing, and where the errors are. The thing actually works, this isn't a stepping stone, it's the production surface.

## To take advantage of v0.26.0

`gbrain upgrade` should run the schema migration automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Verify OAuth tables exist:**
   ```bash
   gbrain doctor
   ```
3. **Register your first OAuth agent:**
   ```bash
   gbrain auth register-client perplexity --grant-types client_credentials --scopes "read write"
   ```
4. **Start the HTTP server:**
   ```bash
   gbrain serve --http --port 3131
   ```
   The terminal prints the admin bootstrap token. Open `http://localhost:3131/admin` and paste it to access the dashboard.
5. **If any step fails,** please file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

### Itemized changes

**Security hardening (post-/cso pass):**
- Auth code exchange + refresh token rotation now use atomic `DELETE...RETURNING` instead of SELECT-then-DELETE. The earlier non-atomic pattern let two concurrent token requests with the same auth code both succeed, issuing two valid token pairs from one code (RFC 6749 §10.5 violation). Same shape applied to refresh tokens (RFC 6749 §10.4 detection of stolen tokens depends on second-use failure). New regression tests fire 10 concurrent requests with the same code/refresh and assert exactly one succeeds.
- `pgArray()` now escapes commas, braces, quotes, and backslashes inside array elements. The earlier no-escape join could be exploited (with `--enable-dcr` on) to smuggle a second redirect_uri into a registered client's array, enabling auth code redirection to an attacker-controlled domain.
- Dynamic Client Registration now enforces RFC 6749 §3.1.2.1: every `redirect_uri` must be `https://` or loopback (`http://localhost`, `http://127.0.0.1`). Plaintext non-loopback `http://` is rejected at registration time.
- `serve --http` now accepts `--public-url URL` to set the OAuth issuer in discovery metadata. Required for production deployments behind reverse proxies, ngrok tunnels, or any non-loopback URL — the issuer claim must match the discovery URL clients hit (RFC 8414 §3.3).
- `cookie-parser` middleware now wired in. The admin dashboard auth was silently broken in the original v0.22 ship: `/admin/login` set the cookie, but every subsequent admin API call returned 401 because Express 5 has no built-in cookie parsing. Direct dep added: `cookie-parser@^1.4.7`.

**OAuth 2.1 (new):**
- `src/core/oauth-provider.ts` (404 lines) ... `GBrainOAuthProvider` implementing MCP SDK's `OAuthServerProvider` + `OAuthRegisteredClientsStore` interfaces. Backed by raw SQL (works on both PGLite and Postgres).
- All tokens + client secrets SHA-256 hashed before storage. Auth codes single-use with 10-minute TTL. Refresh tokens rotate on use. Client credentials grant issues access token only (no refresh per RFC 6749 §4.4.3).
- Legacy `access_tokens` fallback: pre-v0.26 bearer tokens continue working, grandfathered as `read+write+admin` scopes.
- `sweepExpiredTokens()` runs on startup wrapped in try/catch ... server boots even if the sweep fails.
- `hashToken()` and `generateToken()` extracted to `src/core/utils.ts` (DRY across auth surfaces).

**HTTP server (new):**
- `src/commands/serve-http.ts` ... Express 5 server with `mcpAuthRouter` + custom client_credentials handler (SDK's token endpoint throws `UnsupportedGrantTypeError` for CC; our handler runs BEFORE the router, falls through to SDK for auth_code/refresh).
- Rate limiting on `/token` (50 requests / 15 min per IP via `express-rate-limit`).
- Admin dashboard served from `admin/dist/` via Express static + SPA fallback.
- SSE endpoint at `/admin/events` broadcasts every MCP request to connected admin browsers.
- CORS: `/mcp` + `/token` open, `/admin` same-origin.
- Startup logging prints port, engine type, registered client count, DCR status, issuer URL, admin bootstrap token.

**Schema (new tables):**
- `oauth_clients` (client_id, hashed secret, grant_types array, scope, redirect_uris, timestamps)
- `oauth_tokens` (token hash, type=access|refresh, client_id, scopes, expires_at, resource)
- `oauth_codes` (code hash, client_id, scopes, PKCE challenge, redirect_uri, state, expires_at)
- Composite index on `mcp_request_log(created_at, token_name)` for the admin dashboard's time-range queries.
- Migration v30 (`oauth_infrastructure`) creates everything idempotently. PGLite schema updated to include auth infrastructure because `serve --http` makes it network-accessible.

**Operation contract:**
- `Operation.scope?: 'read' | 'write' | 'admin'` ... added to interface, annotated on all 30 operations plus 11 new Minion ops via per-op audit (not derived from `mutating` flag).
- `Operation.localOnly?: boolean` ... marks operations rejected over HTTP. `sync_brain`, `file_upload`, `file_list`, `file_url` all `admin + localOnly`.
- `OperationContext.auth?: AuthInfo` ... threaded through HTTP dispatch for scope enforcement.

**React admin dashboard (new `admin/`):**
- Vite + React 19, TypeScript, 65KB gzipped.
- 7 screens: Login, Dashboard (metrics + SSE feed + token health), Agents (sortable table + sparklines + Register button), Register (modal with scope checkboxes), Credentials (full-screen modal with Copy + Download JSON + yellow warning), Request Log (filterable paginated table), Agent Detail (drawer with Details/Activity/Config Export tabs + Revoke).
- Design tokens: `#0a0a0f` bg, Inter for UI, JetBrains Mono for data, 4-32px spacing scale, rounded pill badges.
- Interaction states: empty state CTAs, SSE reconnection messaging, credential-reveal warning ("Save this secret now. It will not be shown again.").
- Design lens: Steve Krug "Don't Make Me Think" ... zero happy talk, mindless choices, scannable tables, billboard-speed comprehension.

**CLI:**
- `gbrain serve --http [--port 3131] [--token-ttl 3600] [--enable-dcr] [--public-url URL]` ... new HTTP transport alongside existing stdio `gbrain serve`.
- `gbrain auth register-client <name> --grant-types <types> --scopes <scopes>` ... manual OAuth client registration.
- Existing `auth create/list/revoke` kept for backward compatibility.

**Dependencies:**
- `express@^5.1.0`, `express-rate-limit@^7.5.0`, `cors@^2.8.5`, `cookie-parser@^1.4.7` as direct deps.
- `@modelcontextprotocol/sdk` pinned to exact `1.29.0` (was `^1.0.0`).
- `@types/express`, `@types/cors`, `@types/cookie-parser` as dev deps for typecheck.

**Tests:**
- `test/oauth.test.ts` ... 34 test cases covering provider: register, getClient, client_credentials exchange, auth_code flow with PKCE, refresh rotation, verifyAccessToken (OAuth + legacy fallback), revokeToken, sweepExpiredTokens, scope annotations on all 30 operations. Plus the post-/cso security-fix regressions: 10-concurrent auth code exchange (only 1 wins), 10-concurrent refresh rotation (only 1 wins), redirect_uri HTTPS-or-loopback gate, and pgArray comma-element round-trip (1 element in → 1 element out).





## [0.25.1] - 2026-05-01

## **Your brain can now read books with you. Nine new skills land at once.**
## **Plus: skillpack gets a real uninstall, the privacy guard learns new patterns.**

`gbrain book-mirror` is the flagship. Hand it a book and a slug, and the agent fans out one read-only Opus subagent per chapter, assembles a personalized two-column analysis (left column preserves the chapter's actual content with stories and frameworks intact, right column maps every idea to your actual life using your words from the brain), and writes it as one operator-trust `put_page` to `media/books/<slug>-personalized.md`. Twenty-chapter book runs ~$6 at Opus. Subagents have read-only `allowed_tools: ['get_page', 'search']`, so untrusted EPUB content cannot prompt-inject any people page. The CLI prints a cost estimate and refuses to spend in non-TTY without `--yes`.

Eight more skills ship alongside book-mirror: `article-enrichment` turns raw article dumps into structured pages with verbatim quotes; `strategic-reading` reads a book through one specific problem-lens with a do/avoid/watch-for playbook; `concept-synthesis` deduplicates thousands of concept stubs into a tiered intellectual map (T1 Canon to T4 Riff); `perplexity-research` does brain-augmented web research that focuses on the delta between what the brain knows and what's online now; `archive-crawler` mines personal file archives for high-value content within an explicit `gbrain.yml` allow-list; `academic-verify` traces a research claim through publication to raw data to replication; `brain-pdf` renders any brain page to publication-quality PDF; `voice-note-ingest` captures audio with exact-phrasing preservation and routes it to the right brain directory.

`gbrain skillpack uninstall <name>` lands as a real CLI subcommand. Inverse of install, symmetric data-loss posture. Refuses if the slug isn't in the managed block's cumulative-slugs receipt (so it won't nuke a row you hand-added). Refuses if any installed file diverges from the bundle (you've edited it locally). `--overwrite-local` is the escape hatch, same as install. Atomic refusal — if any file would be blocked, the whole uninstall refuses before any unlink fires. No half-uninstalled state.

Three existing skills got drift-backports from the maintainer's private fork: `citation-fixer` resolves broken tweet/post references to deterministic `x.com/handle/status/id` URLs via X API; `testing` splits into skill conformance + project test-suite health with regression-aware classification (REGRESSION / STALE / FLAKE / NEW / INFRA); `cross-modal-review` adds explicit gating ("when to invoke" vs "do NOT invoke") and a `/codex review` handoff for diff review.

The privacy CI guard now also blocks `/data/brain/` and `/data/.openclaw/` literals. Seven historical files are allow-listed (frozen migration files, test fixtures, env-var fallback defaults).

### The numbers that matter

Counted against this branch's diff vs master and against the local test suite at the v0.25.1 cut:

| Metric | BEFORE v0.25.1 | AFTER v0.25.1 | Δ |
|---|---|---|---|
| Skills shipped in `openclaw.plugin.json` | 25 | 34 | +9 |
| New CLI commands | (existing) | `gbrain book-mirror`, `gbrain skillpack uninstall` | +2 |
| Skills with drift-backport from upstream | 0 | 3 (citation-fixer, testing, cross-modal-review) | +3 |
| Privacy CI guard banned-pattern coverage | 1 (fork-name literal) | 3 (+ `/data/brain/`, `/data/.openclaw/`) | +2 |
| `gbrain skillpack` subcommands | 4 (list, install, diff, check) | 5 (+ uninstall) | +1 |
| Skill-routing trust regression detector | 0 | media-ingest ↔ book-mirror routing-eval adversarial intents | +1 |
| Filing-rule directories sanctioned | 12 | 16 (+ ideas, research, original, voice-note) | +4 |
| Atomic-refusal contract on installer rollback | implicit (buggy on uninstall) | tested + enforced (`test/skillpack-uninstall.test.ts`) | locked |
| Lines of new TypeScript src/ shipped | 0 | ~1,100 (book-mirror.ts + skillpack uninstall + archive-crawler-config + harness) | +1100 |
| Tests added (unit + harness self-test) | (existing) | 62 (book-mirror, skillpack-uninstall, archive-crawler-config, cli-pty-runner) | +62 |

Cross-model review trail: **Eng Review (R1 + R2)** + **Codex outside voice** with 15 user decisions captured (D1–D15), 0 unresolved. Codex caught the four highest-impact architectural mistakes the eng review missed: book-mirror's earlier `allowedSlugPrefixes: ['media/books/*', 'people/*']` design was a security regression; the fan-out runtime was missing infrastructure rather than the plan's assumed primitive; uninstall's content-hash guard was incomplete on user-modified files; archive-crawler's "trust the prompt" was not a control. All four were addressed before code landed.

### What this means for builders

Existing brains: no schema migration. `gbrain upgrade` does it.

The flagship: `gbrain book-mirror --chapters-dir <path> --slug <slug>` once you've extracted the chapters (the skill walks you through EPUB and PDF extraction via BeautifulSoup4 / `pdftotext -layout`). The CLI is the trusted runtime; the skill is the orchestration prose.

`gbrain skillpack uninstall <name>` if you ever want to remove a skill from your workspace. It refuses to do anything that would lose your edits.

`archive-crawler` requires `archive-crawler.scan_paths:` set in `gbrain.yml` before it'll run. That's deliberate. Three-line allow-list, one-time pain, never wakes up at 3am wondering if the agent ingested your tax PDFs.

The 9 new skills are all available immediately after `gbrain skillpack install <name>` (or `install --all`).

## To take advantage of v0.25.1

`gbrain upgrade` does this automatically. To verify:

1. **Binary version:**
   ```bash
   gbrain --version   # expect: gbrain 0.25.1
   ```
2. **Book-mirror is registered:**
   ```bash
   gbrain book-mirror --help 2>&1 | grep "media/books/"
   # expect: lines describing the trust contract
   ```
   (The CLI requires DB connection even for `--help` due to a pre-existing dispatch order; if you see "Cannot connect to database" your install is fine, the help text just needs DATABASE_URL set or a local PGLite brain.)
3. **Skillpack uninstall is wired:**
   ```bash
   gbrain skillpack uninstall --help 2>&1 | grep "Inverse of install"
   ```
4. **Archive-crawler safety gate (only matters if you install it):**
   ```bash
   # Without gbrain.yml allow-list, the skill instructs the agent to refuse:
   cat skills/archive-crawler/SKILL.md | grep "scan_paths"
   ```
5. **If anything fails,** file an issue at https://github.com/garrytan/gbrain/issues with the output of `gbrain doctor` and which step broke.

No schema migration. Existing brains work unchanged.

### Itemized changes

#### Added (skills)

- **`skills/book-mirror/`** — flagship. Two-column personalized chapter-by-chapter book analysis. SKILL.md ports the upstream original to pure gbrain idiom; CLI lives at `src/commands/book-mirror.ts`.
- **`skills/article-enrichment/`** — transforms raw article dumps into structured pages with verbatim quotes, key insights, why-it-matters.
- **`skills/strategic-reading/`** — reads a book / article / case study through one specific problem-lens; produces a do / avoid / watch-for playbook with short / medium / long-term recommendations.
- **`skills/concept-synthesis/`** — 4-phase pipeline (dedup → tier → synthesize T1/T2 → cluster) over raw concept stubs; output is a curated intellectual fingerprint at `concepts/README.md`.
- **`skills/perplexity-research/`** — sends brain context as part of the Perplexity prompt so the search focuses on what's NEW vs already-known. Output structure: Executive Summary + Key New Developments + Confirming Signals + Contradictions or Updates + Recommended Brain Updates + Citations.
- **`skills/archive-crawler/`** — universal archivist for personal file archives (Dropbox / B2 / Gmail-takeout / local-mount / hard-drive-dump). REFUSES to run unless `archive-crawler.scan_paths:` is set in `gbrain.yml`.
- **`skills/academic-verify/`** — verifies a research claim by tracing it through publication → methodology → raw data → independent replication. Routes through perplexity-research as the actual web-search engine; produces a verdict-shaped brain page (verified / partial / unverifiable / misattributed / retracted).
- **`skills/brain-pdf/`** — generates publication-quality PDFs from any brain page via the gstack `make-pdf` binary. Strips frontmatter, sanitizes emoji, applies running headers + page numbers.
- **`skills/voice-note-ingest/`** — ingests voice notes with exact-phrasing preservation (never paraphrased). 7-step decision tree routes to originals / concepts / people / companies / ideas / personal / voice-notes.

#### Added (post-install advisory — v0.25.1 DX)

- **`src/core/skillpack/post-install-advisory.ts`** (~209 lines). Every `gbrain init` and `gbrain post-upgrade` now ends by printing an agent-readable advisory listing the v0.25.1 recommended skills the workspace hasn't installed yet. The advisory tells the agent EXPLICITLY: ask the user before installing; print the exact `gbrain skillpack install --all` (or per-skill) command if they say yes. Renders to stderr so stdout stays clean for `--json` output. No-op when every recommended skill is already installed (no nag on repeated `gbrain upgrade` runs). Tests: `test/post-install-advisory.test.ts` (10 cases).
  - Why this design instead of an interactive TTY prompt: gbrain users typically interact through their host agent, not the gbrain CLI directly. The agent reads command output. So the advisory is structured for agent consumption: `ACTION FOR THE AGENT` block, explicit `Ask the user explicitly`, exact commands, `Do NOT install without asking. The user owns this decision.`
  - Wired into both `src/commands/init.ts` (PGLite + Postgres paths) and `src/commands/upgrade.ts` (`runPostUpgrade` after migrations apply).

#### Added (CLI)

- **`gbrain book-mirror`** — `src/commands/book-mirror.ts` (~540 lines). CLI submits N read-only subagent jobs per chapter, waits via `waitForCompletion`, reads each child's `job.result`, assembles markdown itself, writes one operator-trust `put_page` to `media/books/<slug>-personalized.md`. Cost-estimate prompt before launching; refuses to spend in non-TTY without `--yes`. Idempotency keys per chapter for retry-friendly re-runs. Partial-failure handling assembles the page with completed chapters and a `## Failed chapters` section listing retries needed.
- **`gbrain skillpack uninstall <name>`** — `src/commands/skillpack.ts` + `src/core/skillpack/installer.ts:applyUninstall` (~250 lines). Symmetric to install. Atomic refusal: pre-scans all files for divergence; refuses BEFORE any unlink if anything is blocked. `--overwrite-local` escape hatch. Drops the slug from `cumulative-slugs` receipt; preserves other installed skills' rows + user-added unknown rows (with stderr warning).

#### Added (filing-doctrine update)

- **`skills/_brain-filing-rules.md`** — carved out `media/<format>/<slug>` as a sanctioned exception for sui-generis synthesized output (one-of-one to a single source like a personalized book mirror). The "file by primary subject, not by format" rule still applies to raw ingest.
- **`skills/_brain-filing-rules.json`** — added 4 new directory kinds: `idea` (ideas/), `research` (research/), `original` (originals/), `voice-note` (voice-notes/). Plus 2 synthesis-output kinds for `media/books/` and `media/articles/`.
- **`skills/media-ingest/SKILL.md`** — refined the format-based-filing anti-pattern callout to clarify that the anti-pattern is for raw ingest only; one-of-one synthesis output may use `media/<format>/`.

#### Added (test infrastructure)

- **`test/helpers/cli-pty-runner.ts`** — generic PTY harness ported from gstack (~470 lines). Used by the smoke test E2E; future-proofs interactive CLI commands.
- **`test/cli-pty-runner.test.ts`** — 24 cases pinning the harness primitives.

#### Added (CI guard)

- **`scripts/check-privacy.sh`** extended with `BANNED_PATHS` for `/data/brain/` and `/data/.openclaw/`. 7 historical files allow-listed.

#### Added (config schema)

- **`src/core/archive-crawler-config.ts`** (~263 lines) + **`test/archive-crawler-config.test.ts`** (19 tests). `loadArchiveCrawlerConfig`, `normalizeAndValidateArchiveCrawlerConfig`, `isPathAllowed`. Mirrors the storage-config.ts parsing pattern.

#### Drift backports (3 existing skills updated)

- **`skills/citation-fixer/SKILL.md`** (1.0 → 1.1) — adds tweet/post URL resolution via X API. 5-step pipeline.
- **`skills/testing/SKILL.md`** (1.0 → 1.1) — splits into skill conformance + project test-suite health with regression-aware classification.
- **`skills/cross-modal-review/SKILL.md`** (1.0 → 1.1) — adds "When to invoke" gating and `/codex review` handoff.

#### Bug fix (during testing)

- **`applyUninstall` atomic refusal** — discovered while writing `test/skillpack-uninstall.test.ts`. The original implementation interleaved D11 hash check + unlink in the same loop, so a divergence on file 5/N would leave files 1..4 already gone. Now: pre-scan all files for divergence; refuse loudly BEFORE any filesystem mutation. The test was written with the contract in mind; the implementation lied about the contract; the lie surfaced immediately.

#### Tests

- **`test/book-mirror.test.ts`** — 9 cases.
- **`test/skillpack-uninstall.test.ts`** — 10 cases.
- **`test/archive-crawler-config.test.ts`** — 19 cases.
- **`test/cli-pty-runner.test.ts`** — 24 cases.
- 62 new tests total. All pass; existing 90+ skillpack-related tests continue to pass.

#### Deferred to v0.26+

- **`test/e2e/skill-smoke-openclaw.test.ts`** — full interactive openclaw drive via the PTY harness, opt-in via `EVALS=1 EVALS_TIER=skills`. Scaffolded but not landed.
- **`gbrain skillpack uninstall --all`** — current shape is single-arg; multi-skill uninstall via `install --all` from a pruned bundle still works as the canonical path.
- **Empty-parent-dir pruning on uninstall** — current behavior leaves empty `skills/<slug>/` directories. Cosmetic; deferred.
- **LLM tie-break layer for routing-eval** — the routing-miss warnings on the new skills are real; the structural layer doesn't substring-match natural-paraphrased intents. The `--llm` flag stays a placeholder per v0.24.0.

### Cross-model review credit

This release ran two rounds of `/plan-eng-review` plus `/codex` outside voice, capturing 15 user decisions. Codex caught the four most consequential architectural mistakes the eng review missed (read the plan file's GSTACK REVIEW REPORT for the full audit trail). The atomic-refusal bug in applyUninstall was caught by the test for the contract — the test was written with the contract in mind, the implementation lied about the contract, and the lie surfaced immediately. That's the cross-model loop working.
=======
## [0.25.0] - 2026-04-26

## **Contributors can now benchmark retrieval changes against real captured queries before merging.**
## **`GBRAIN_CONTRIBUTOR_MODE=1` turns on capture; `gbrain eval replay` is the dev loop.**

v0.20 (gbrain-evals extraction) and v0.21 (Cathedral II) gave gbrain its install surface back and turned code into a first-class graph. The remaining gap was data: `amara-life`, the fictional 418-item corpus over in gbrain-evals, is great for reproducibility but not for catching regressions against the queries your agents *actually* serve. v0.25 ships the substrate: with `GBRAIN_CONTRIBUTOR_MODE=1` set, every `query` and `search` call through MCP, CLI, or the subagent tool-bridge records into a new `eval_candidates` table. `gbrain eval export` streams the rows as NDJSON. `gbrain eval replay --against <ndjson>` re-runs each captured query against your current build and prints three numbers: mean Jaccard@k, top-1 stability, and latency Δ. Point gbrain-evals at the stream and you have BrainBench-Real on every release. Run replay locally and you have a regression gate on every retrieval PR.

Capture is **off by default**. Production users get a quiet brain — no surprise data accumulation, no privacy footgun. Contributors flip it on with one shell rc line: `export GBRAIN_CONTRIBUTOR_MODE=1`. From that shell forward, every query/search lands in `eval_candidates`. PII is scrubbed at write time (emails, phones, SSN, Luhn-verified credit cards, JWTs, bearer tokens). Queries over 50KB get rejected. RLS matches the v0.18.1 / v0.21.0 posture ... new tables get enabled on Postgres, gated on BYPASSRLS so it never locks an operator out of their own data. `gbrain doctor` surfaces silent capture failures cross-process so if something stops working you see it in health checks, not three weeks later when the replay numbers look weird.

Cathedral II (v0.21.0) callers are unaffected. `hybridSearch` still returns `Promise<SearchResult[]>` ... meta arrives via an optional `onMeta` callback in `HybridSearchOpts`, used only by the op-layer capture wrapper to record what hybridSearch *actually* did (vector ran or fell back, expansion fired or didn't, post-auto-detect detail).

### The numbers that matter

Measured on this branch's diff against v0.21.0:

| Metric | v0.21.0 | v0.25.0 | Δ |
|---|---|---|---|
| Real-query capture | none | every MCP/CLI/subagent `query` + `search` | **the whole feature** |
| PII classes redacted at write | 0 | 6 (email, phone, SSN, CC+Luhn, JWT, bearer) | ... |
| Schema columns per captured row | ... | 16 (tool, query, slugs, chunks, source_ids, expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied, latency, remote, job_id, subagent_id, created_at, id) | ... |
| `hybridSearch` return shape | `Promise<SearchResult[]>` | `Promise<SearchResult[]>` (unchanged) | 0 break |
| `hybridSearch` opts surface | existing | + `onMeta?: (m: HybridSearchMeta) => void` | additive |
| BrainEngine methods | shipped Cathedral II surface | +5 eval-capture | **BREAKING for custom engines** |
| Public subpath exports | 17 | 17 (now contract-tested) | 0 drift |
| Default capture posture | n/a | OFF for users, ON via `GBRAIN_CONTRIBUTOR_MODE=1` | privacy-positive default |
| Dev-loop tooling for retrieval PRs | none in-tree | `gbrain eval replay --against <ndjson>` | the regression gate |
| New tests | ... | 144 (14 engine round-trip + 17 scrubber + 27 capture module + 8 hybrid meta + 10 op-layer capture + 9 export + 5 prune + 30 public-exports + 16 replay + 8 v31-migrate) | ... |

### What this means for you

**Brain operators (the 99%):** run `gbrain upgrade`. Nothing changes — capture stays off, your brain stays quiet. The substrate is in place if you ever want to turn it on (e.g. to debug a retrieval issue), but you don't have to.

**Contributors / maintainers:** add `export GBRAIN_CONTRIBUTOR_MODE=1` to your shell rc. Every `query`/`search` from then on writes to `eval_candidates`. After a week of dogfooding, snapshot with `gbrain eval export --since 7d > real.ndjson` and `gbrain eval replay --against real.ndjson` against your branch to gate retrieval changes. To opt out per-brain regardless of the env var: write `{"eval":{"capture":false}}` to `~/.gbrain/config.json`.

**Anyone calling `hybridSearch` directly:** no change required. The return type is still `Promise<SearchResult[]>`. If you want the new meta side-channel, pass `onMeta: (m) => { ... }` in opts — otherwise leave it undefined and pay no cost.

**Downstream TypeScript consumers implementing their own BrainEngine:** five new methods need implementations ... `logEvalCandidate`, `listEvalCandidates`, `deleteEvalCandidatesBefore`, `logEvalCaptureFailure`, `listEvalCaptureFailures`. Return types are in `src/core/types.ts`. This is why v0.25.0 is a minor bump.

## To take advantage of v0.25.0

**If you're a regular gbrain user:** `gbrain upgrade` is enough. Capture stays off, your brain stays quiet, nothing else changes. The substrate exists if you ever want to opt in (write `{"eval":{"capture":true}}` to `~/.gbrain/config.json`), but you don't have to.

**If you're a contributor or maintainer working on retrieval:**

1. **Apply the migration** (idempotent; `gbrain upgrade` does this automatically):
   ```bash
   gbrain apply-migrations --yes
   ```

2. **Turn on capture** by adding one line to your `~/.zshrc` or `~/.bashrc`:
   ```bash
   export GBRAIN_CONTRIBUTOR_MODE=1
   ```
   Reload your shell (`source ~/.zshrc`) or open a new terminal.

3. **Verify the tables exist + capture is healthy:**
   ```bash
   gbrain query "any test query" >/dev/null
   psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'  # > 0 means capture is running
   gbrain doctor   # should show "eval_capture: No capture failures in the last 24h"
   ```

4. **Dogfood for a week, then run the dev loop:**
   ```bash
   gbrain eval export --since 7d > baseline.ndjson
   # ... make a retrieval change ...
   gbrain eval replay --against baseline.ndjson  # mean Jaccard@k, top-1 stability, latency Δ
   ```

   See [`docs/eval-bench.md`](https://github.com/garrytan/gbrain/blob/master/docs/eval-bench.md) for the full guide and CI integration snippet.

5. **If something looks wrong:** `gbrain doctor` names the `eval_capture_failures` breakdown by reason. File an issue with the breakdown + your config shape at https://github.com/garrytan/gbrain/issues.

### Itemized changes

- **`GBRAIN_CONTRIBUTOR_MODE=1` env var gates capture.** Default flipped from on-for-everyone to off-unless-opted-in. Resolution order: explicit `eval.capture` config wins both directions, then env var, then off. Production users get a quiet brain by default; contributors flip the env var in `.zshrc` and unlock the full export → replay loop. README + CONTRIBUTING document the flag prominently.
- v31 migration: `eval_candidates` + `eval_capture_failures` on both Postgres + PGLite, RLS gated on BYPASSRLS, CHECK constraints + indexes
- Op-layer capture wrapper in `src/core/operations.ts` (covers MCP + CLI + subagent tool-bridge from one site)
- PII scrubber in `src/core/eval-capture-scrub.ts` (6 regex families, adversarial-input safe)
- Cross-process audit via `eval_capture_failures` + `gbrain doctor` 24h breakdown
- `gbrain eval export` (NDJSON, schema_version:1, EPIPE-safe) + `gbrain eval prune` (explicit retention)
- `gbrain eval replay --against <ndjson>` — contributor-facing dev loop. Reads a captured snapshot, re-runs every `query` / `search` against the current brain, prints mean Jaccard@k between captured + current `retrieved_slugs`, top-1 stability rate, and latency Δ. JSON mode (`schema_version: 1`) for CI gating, top-regressions table for human eyeballs. Closes the gap between "data captured" and "data used to gate a PR."
- `docs/eval-bench.md` — contributor guide that walks the 4-command loop (export → change → replay → diff), defines metrics (Jaccard@k, top-1 stability, latency Δ) with healthy ranges, lists the source paths that should trigger a re-run, and shows how to wire it into CI. Linked from CONTRIBUTING.md.
- `CONTRIBUTING.md` adds a "Running real-world eval benchmarks (touching retrieval code)" section so PRs that change retrieval have an obvious replay path. Maintainer reviews can ask "did you run replay?" instead of writing a custom benchmark per PR.
- `hybridSearch` adds `onMeta?: (m) => void` to opts (Cathedral II callers unaffected)
- `BrainEngine` gains 5 methods (breaking-interface for custom engines, drives v0.25.0 minor bump)
- `test/public-exports.test.ts` + `scripts/check-exports-count.sh` lock the 17-subpath public surface
- Config gains `eval: {capture?, scrub_pii?}` (file-plane only); env var `GBRAIN_CONTRIBUTOR_MODE=1` is the contributor-facing toggle that doesn't require editing JSON
- `listEvalCandidates` orders `created_at DESC, id DESC` (deterministic export windows)
- `docs/eval-capture.md` — stable NDJSON schema reference for gbrain-evals
- `gbrain doctor` `eval_capture` check now distinguishes pre-v31 missing-table (status: ok / skipped) from RLS-denied SELECT or transient DB error (status: warn) — the diagnostic that surfaces a misconfigured RLS role no longer goes silent
- `hybridSearch.onMeta` callback wrapped in try/catch — a throwing user-supplied callback can't break the search hot path (defensive across the public `gbrain/search/hybrid` surface)
- +144 unit tests across 9 new files (eval-candidates 14, eval-capture-scrub 17, eval-capture 27, eval-export 9, eval-prune 5, eval-replay 16, hybrid-meta 8, mcp-eval-capture 10, public-exports 30) plus 8 v31-shape checks added to `test/migrate.test.ts`. 0 regressions across the full suite (198 v0.25.0-related tests pass cleanly).

## [0.24.0] - 2026-04-26

## **The skillify loop stops lying. Privacy guard runs, `--llm` is honest, ghost rows go away.**
## **Plus: Tier 2 LLM-skill tests now block every PR, not just the nightly cron.**

v0.19.0 shipped four new CLI commands (`skillify`, `skillpack`, `routing-eval`, `skillify-check`) and got rave coverage. v0.24.0 is the production-hardening pass on top of that: every public contract that lied about itself, every silent footgun, every CI guard that wasn't wired up. No new features. No new commands. Just the unsexy fixes that turn a feature release into a production release.

The biggest save: the skillpack installer would have silently deleted your skills. The original v0.19 design's "rebuild managed block" path was load-bearing wrong — a user installing `alpha` then later running `gbrain skillpack install beta` alone would have lost `alpha`. Codex caught it during cross-model review. The fix preserves cumulative-install semantics via a receipt comment in the fence: `<!-- gbrain:skillpack:manifest cumulative-slugs="alpha,beta,..." -->`. Old fences upgrade silently. User-added rows survive with a stderr warning telling the operating agent to investigate. `install --all` is now the only path that prunes; per-skill install never destroys what it didn't install.

The biggest unsexy fix: `gbrain routing-eval --llm` was a documented feature that did nothing. README, CHANGELOG, and CLI help all said it ran an LLM tie-break layer. The code returned structural-only results with no warning, no error, no signal at all. v0.24.0 makes the flag honest across all four touchpoints. Until the LLM layer ships, `--llm` emits a stderr placeholder notice and runs structural. CI logs see it. Docs match the code. The release notes don't lie.

The CI fix nobody asked for: `scripts/check-privacy.sh` exists in the repo to enforce the OpenClaw fork-name ban from `CLAUDE.md:550`. It was never wired into anything. v0.24.0 prepends it to `package.json`'s `"test"` chain alongside the other `check-*.sh` guards. A regression test asserts the wiring stays. The first run caught 5 banned-name references that had been sitting in master's `CHANGELOG.md`, `src/cli.ts`, `src/commands/sync.ts`, and `skills/migrations/v0.19.0.md` for releases — fixed in the same wave.

### The numbers that matter

Counted against this branch's review trail and the local test suite:

| Metric | BEFORE v0.24.0 | AFTER v0.24.0 | Δ |
|---|---|---|---|
| `routing-eval --llm` behavior matches docs | no | yes | fixed |
| Public-contract drift surfaces fixed | 4 (README, CHANGELOG, CLI help, runtime) | 0 | −4 |
| `gbrain skillpack install <name>` preserves prior installs | yes (was a happy accident) | yes (with receipt + regression test) | locked |
| Regression test guarding cumulative-install semantics | none | `test 8a` ("install alpha; then install beta; assert both") | +1 |
| Banned-name leaks in tracked files | 5 (master state) | 0 | −5 |
| `check-privacy.sh` runs in CI | never | every PR (via `bun run test`) | wired |
| Tier 2 LLM-skill E2E gates each PR | no (nightly cron only) | yes | wired |
| Stale `v0.17/v0.18` version labels in new code | 7 sites across 5 files | 0 | −7 |
| Skillify scaffold idempotency under hand-edited resolver | backtick-only detection | backtick + quoted + bare | fixed |

Cross-model review trail: **CEO + Eng + Codex outside voice**. 14 user decisions captured, 0 unresolved, 1 critical Codex catch (the cumulative-install regression that would have shipped). Two-model review caught a one-model-blind spot. The receipt design is in `src/core/skillpack/installer.ts:applyManagedBlock`.

### What this means for builders

Nothing breaks. `gbrain upgrade` is the path. Existing brains: no schema migration. Existing AGENTS.md fences without a receipt comment auto-upgrade silently on the next `gbrain skillpack install` (one-time clean rebuild, no warnings). User-added skill rows inside the fence now survive reinstalls with a clear stderr breadcrumb: `[skillpack] unknown row in managed block: "<slug>" — Investigate: user-added skill, hand-edited fence, or typo?`

If you ship custom CI: `bun run test` now gates `check-privacy.sh` alongside the existing `check-jsonb-pattern.sh`, `check-progress-to-stdout.sh`, and `check-wasm-embedded.sh`. If you grepped through gbrain's source in your own CI, no surface change. If you previously ran `gbrain routing-eval --llm` expecting an LLM pass, you'll now see a stderr line telling you what's actually happening and your scripts keep working — exit code is still 0/1 based on structural results. Tier 2 (`test/e2e/skills.test.ts`) now runs on every PR using existing repo secrets. Adds ~3-5 min per PR for real protection against LLM-adjacent regressions.

## To take advantage of v0.24.0

`gbrain upgrade` does this automatically. To verify:

1. **Binary version:**
   ```bash
   gbrain --version   # should say 0.24.0
   ```
2. **`--llm` honesty:**
   ```bash
   gbrain routing-eval --llm 2>&1 | grep -i placeholder
   # expect: "[routing-eval] --llm flag is a placeholder in this release..."
   ```
3. **Skillpack receipt + cumulative semantics:**
   ```bash
   gbrain skillpack install <name>
   grep "gbrain:skillpack:manifest cumulative-slugs" $OPENCLAW_WORKSPACE/AGENTS.md
   # expect a receipt line listing every gbrain-installed slug
   ```
4. **Privacy guard wired:**
   ```bash
   grep "check-privacy.sh" package.json
   # expect a hit in scripts.test
   ```
5. **If anything fails,** file an issue at https://github.com/garrytan/gbrain/issues with the output of `gbrain doctor` and which step broke.

No schema migration. Existing brains work unchanged.

### Itemized changes

#### Fixed

- **`gbrain routing-eval --llm`** is no longer a silent no-op. CLI emits a stderr placeholder notice; `--json` mode preserves clean stdout JSON with the warning on stderr only (no bleed). README:294, CHANGELOG entry, and CLI help text all rewritten to match the actual behavior. Tests in `test/routing-eval-cli.test.ts`.
- **Skillpack installer** now embeds a receipt comment (`<!-- gbrain:skillpack:manifest cumulative-slugs="..." version="..." -->`) inside the managed-block fence on every install. Per-skill installs accumulate via union(prior receipt, this-call slugs); `install --all` prunes slugs no longer in the bundle (the only prune path). Unknown rows inside the fence (user hand-adds, third-party bundles, typos) survive reinstalls with a stderr `Investigate:` breadcrumb. Pre-v0.24.0 fences upgrade silently on first install. Tests in `test/skillpack-install.test.ts` cover all four paths including the regression-guard "install alpha; install beta; assert both present."
- **`gbrain skillify scaffold --force`** no longer creates duplicate resolver rows when the existing row uses non-backticked path forms. The detection regex now matches backticked, single-quoted, double-quoted, and bare forms, with anchored boundaries to prevent false-matching shared-prefix slugs (e.g., `demo` vs `demo-extended`). Tests in `test/skillify-scaffold.test.ts`.
- **5 banned OpenClaw fork-name leaks** scrubbed from public artifacts (`CHANGELOG.md`, `skills/migrations/v0.19.0.md`, `src/cli.ts`, `src/commands/sync.ts`). All originated in earlier releases when the privacy script existed but wasn't wired to CI. Replacements per `CLAUDE.md:550` (origin-story → "Garry's OpenClaw"; reader-facing → "your OpenClaw").
- **Stale `v0.17`/`v0.18` version labels** removed from 5 files (`src/core/routing-eval.ts`, `src/core/filing-audit.ts`, `src/commands/check-resolvable.ts`, `src/commands/skillify.ts`, `src/commands/skillpack.ts`). Replaced with version-agnostic phrasing or current-release references.

#### Changed

- **`package.json` `"test"` script** now prepends `scripts/check-privacy.sh` to the existing chain. Test failure if the banned fork name appears anywhere in tracked files.
- **`.github/workflows/e2e.yml`** Tier 2 job (`test/e2e/skills.test.ts`, requires `OPENAI_API_KEY` + `ANTHROPIC_API_KEY`) promoted from schedule-only to required per-PR CI. Same secrets, same install path, same workflow YAML structure — just removed the `if: github.event_name == 'schedule' or workflow_dispatch` guard.

#### Added (tests)

- **`test/routing-eval-cli.test.ts`** (4 cases) — `--llm` placeholder behavior across human + JSON modes, exit-code preservation, regression guard for the silent-no-op state.
- **`test/privacy-script-wired.test.ts`** (3 cases) — asserts `check-privacy.sh` exists and is executable, asserts `package.json` `scripts.test` references it, asserts the `check:privacy` convenience alias is present.
- **`test/skillpack-install.test.ts`** (+4 cases) — cumulative-install regression guard, full-bundle prune semantics, unknown-row preserve+warn, pre-v0.24 upgrade path. Total 30 cases for the installer.
- **`test/skillify-scaffold.test.ts`** (+4 cases) — bare/quoted/single-quoted resolver rows + shared-prefix slug isolation. Total 18 cases for scaffold.

#### Deferred

- LLM tie-break layer for `routing-eval --llm` — placeholder ships in v0.24.0, full implementation is a future release. Code already accepts the flag.
- `gbrain skillpack forget <name>` — explicit uninstall command. v0.24.0 covers the minimum (managed-block prune via `install --all`). Tracked in `TODOS.md`.
- PID-liveness check in installer lock — current behavior (mtime-based stale detection + `--force-unlock` opt-in) is conservative; PID liveness is a v0.24.x ergonomic. Tracked.

### Cross-model review credit

This release's quality is directly attributable to running `/plan-ceo-review` + `/plan-eng-review` + `/codex review` in sequence on the v0.19.0 production-readiness audit. Codex caught one critical and three high findings the in-skill review missed: cumulative-install regression (load-bearing), `--llm` public-contract drift (4-surface scrub), Tier 2 framing as unowned dependency, and 6.5 hours of guesswork named files in the flake-diagnosis plan. The cross-model agreement on every fix is the signal that turns "ship the demo path" into "ship the production path."
## [0.23.2] - 2026-04-30

**The dream cycle now stamps every page it writes. The guard checks for the stamp. No content guessing, no false positives.**

The v0.23.1 prefix-string guard had two flaws caught by a codex review of the v0.23.2 plan. Real serialized brain pages do not always contain their own slug in the body. The synth prompt produces `[Alice](people/alice)` references far more often than the page's own slug, and `serializeMarkdown` does not embed the slug anywhere by default. So the heuristic could miss real dream output. And real conversation transcripts often DO mention brain slugs (`"earlier I wrote about wiki/personal/reflections/identity..."`), so the heuristic dropped legitimate transcripts silently.

v0.23.2 swaps content inference for explicit identity. Every page the synthesize phase writes now gets `dream_generated: true` stamped into its YAML frontmatter at render time. The self-consumption guard checks for that field. CRLF and BOM tolerated. Whitespace and case variants tolerated. Cannot drift, cannot false-positive on user text, cannot miss real output.

`gbrain dream --unsafe-bypass-dream-guard` is a new explicit escape hatch for power users who really do want to re-process a dream-generated page (rare, mostly testing). A loud stderr warning fires every time it runs. The flag is intentionally NOT tied to `--input` because that would let any caller silently re-trigger the loop bug.

The configurable verdict model from v0.23.1 stays. `gbrain config set dream.synthesize.verdict_model claude-sonnet-4-6` still works, with new unit-test coverage asserting the override actually reaches `client.create({ model })`.

### Itemized changes

#### Fixed
- `src/core/cycle/synthesize.ts`: `renderPageToMarkdown` (now exported) stamps `dream_generated: true` and `dream_cycle_date` into every reverse-write. `writeSummaryPage` does the same when building the dream-cycle summary index. The DB-stored frontmatter persists the marker across re-renders.
- `src/core/cycle/transcript-discovery.ts`: replaces v0.23.1's `DREAM_OUTPUT_SLUGS` content-prefix list with `DREAM_OUTPUT_MARKER_RE`, anchored at frontmatter open with optional BOM and CRLF tolerance. Runs in both `discoverTranscripts` and `readSingleTranscript`. Stderr log fires when the guard skips a file (no more silent skips).
- `src/core/cycle/synthesize.ts`: `judgeSignificance` and `JudgeClient` are now exported; `judgeSignificance` accepts a `verdictModel` parameter (default `claude-haiku-4-5-20251001`) loaded from `dream.synthesize.verdict_model` via `loadSynthConfig`.

#### Added
- `gbrain dream --unsafe-bypass-dream-guard` CLI flag. Plumbed through `runCycle.synthBypassDreamGuard` → `SynthesizePhaseOpts.bypassDreamGuard` → `discoverTranscripts({bypassGuard})` and `readSingleTranscript({bypassGuard})`. Fires a loud stderr warning at phase entry when set. Never auto-applied for `--input`.

#### Tests
- 12 new test cases in `test/cycle-synthesize.test.ts`:
  - `self-consumption guard (v0.23.2 marker-based)`: REGRESSION fixture built from a real `Page → renderPageToMarkdown → isDreamOutput` round-trip; legitimate user note citing a slug is NOT skipped; CRLF + BOM tolerated; whitespace and case variants tolerated; `false`/absent values do NOT match; `dream_generatedfoo` (no word boundary on key) does NOT match; marker buried past 2000 chars does NOT trigger (perf bound); `bypassGuard=true` overrides; `discoverTranscripts` respects the bypass; `DREAM_OUTPUT_MARKER_RE` is anchored at byte 0.
  - `judgeSignificance`: passes verdict_model override to `client.create`; defaults to `claude-haiku-4-5-20251001` when omitted; returns `worth_processing=false` on unparseable judge output.
## [0.23.1] - 2026-04-30

**`bun run ci:local` runs the full CI gate on your laptop, 4-way sharded, in ~100 seconds warm. Doc-only diffs go in 5 seconds.**

CI today catches typos, postgres regressions, and the 2-file Tier 1 mechanical suite. The other 34 E2E files in `test/e2e/` only run nightly, and your unit suite never runs against a real Postgres + pgvector locally. This release ships a Docker-based local CI gate that runs every check CI runs (3000+ unit tests + 36 E2E files + gitleaks + typecheck) in **~100s warm wall-time** on a 16-core host. Four pgvector services + a single bun runner; xargs -P4 fans 4 shards each running unit + E2E concurrently; PGLite snapshot fixture skips the schema-replay cold start. `bun run ci:local:diff` adds a doc-only fast-path that exits in seconds when the diff only touches markdown / docs / scripts. Fail-closed by design: an unmapped src/ change runs all 36 E2E files, never silently nothing.

The motivating story: a typical PR cycle is push → wait 8 minutes for GH Actions → fix → push → wait 8 minutes → repeat. Now you push when you're done, not to find out you're not done. The first cold run pulls the bun image, installs deps into a named volume, and runs every check; subsequent runs reuse the warm volumes and complete in 16-20 minutes for the full sequential E2E.

### The numbers that matter

Real laptop run on the M-series host, OrbStack daemon. Reproduce with `bun run ci:local`.

| Metric | Before (push-and-wait) | After (`bun run ci:local`) | Δ |
|---|---|---|---|
| E2E files exercised before push | 0 | 36 | full coverage |
| **Wall-time, full gate, warm (measured, 16-core)** | n/a | **~100 seconds** | **~13x speedup vs push-and-wait** |
| Wall-time, doc-only diff | ~3 min CI | ~5s (host gitleaks only) | ~36× faster |
| Time to first failure signal | ~3 min CI | ~30s host gitleaks + 5s smoke | 6× faster |
| Container env divergence from CI | unknown | bit-for-bit pgvector + bun base | resolved |
| Diff-aware selection on focused PRs | none | 3-9 E2E files for typical scoped change | ~70% fewer files |
| PGLite cold init per file (measured) | ~828ms | ~181ms via snapshot | 4.5× faster |

The lane that matters: when the local gate finds a real bug, you fix it before the PR exists. The release surfaced one such bug as a P1 TODO during verification — `multi-source.test.ts` cascade test isn't isolated; PR CI never runs it.

### What this means for you

Run `bun run ci:local` before `gh pr create` to catch what nightly CI would catch. Run `bun run ci:local:diff` for fast iteration during a focused branch. The selector is hand-tuned today via `scripts/e2e-test-map.ts`; if it ever runs the full suite when you wanted a narrower set, add an entry. Fail-closed default means you can never break correctness by leaving a glob out — only optimize over time.

## To take advantage of v0.23.1

`gbrain upgrade` is a no-op for this release ... no schema migration, no host-repo edits.

To use the new local CI gate:

1. **Install Docker engine** (Docker Desktop, OrbStack, or Colima) and `gitleaks` on host:
   ```bash
   brew install gitleaks
   ```
2. **Run the full local gate before pushing:**
   ```bash
   bun run ci:local
   ```
3. **Run the diff-aware subset for fast iteration:**
   ```bash
   bun run ci:local:diff
   ```
4. **Override the postgres host port** if 5434 collides on your machine:
   ```bash
   GBRAIN_CI_PG_PORT=5435 bun run ci:local
   ```

The named volumes `gbrain-ci-node-modules`, `gbrain-ci-bun-cache`, and `gbrain-ci-pg-data` keep the install warm. `--clean` nukes them for cold debugging. `--no-pull` skips the upstream pull when offline.

### Itemized changes

#### Added — Tier 1: parallel-shard orchestration
- `bun run ci:local` orchestrates **4 unit+E2E shards in parallel** inside a single bun runner container, each pinned to its own pgvector service. ~3000 unit tests + 36 E2E files complete in ~100s warm.
- `bun run ci:local:diff` runs only the E2E files matched by the diff selector. Falls back to all 36 files when an unmapped src/ path or escape-hatch (schema, package.json, skills/) is touched.
- `bun run ci:select-e2e` prints the selector's choice for the current branch — pipe-friendly.
- `docker-compose.ci.yml` declares 4 `pgvector/pgvector:pg16` services (postgres-1..4) + `oven/bun:1` runner with named volumes for fast restarts. Host ports 5434-5437; override base via `GBRAIN_CI_PG_PORT`.
- `scripts/ci-local.sh` orchestrates the gate with `--diff`, `--no-pull`, `--clean`, `--no-shard` flags. Detects git worktrees (Conductor) and bind-mounts the shared gitdir so in-container `git ls-files` works.
- `scripts/run-unit-shard.sh` is the per-shard unit runner. Takes `SHARD=N/M`, splits `find test -name '*.test.ts' -not -path test/e2e/*` evenly across shards. Excludes `*.slow.test.ts` (Tier 4 convention).
- `scripts/run-e2e.sh` accepts an optional file list from argv, a `--dry-run-list` flag for the inline smoke check, and a `SHARD=N/M` env that filters every M-th file starting at index N. Sequential within a shard preserves the TRUNCATE CASCADE no-race property; parallel across shards is what makes the gate fast.

#### Added — Tier 2: doc-only diff fast-path
- `scripts/select-e2e.ts --classify-only` emits the diff classification (`EMPTY|DOC_ONLY|SRC`) on stdout. `ci-local.sh --diff` reads it before spinning postgres up: if `DOC_ONLY`, the script runs gitleaks on the host and exits in ~5 seconds. Skips the entire ~100s heavy gate when nothing src/-shaped changed.

#### Added — Tier 3: PGLite snapshot fixture
- `scripts/build-pglite-snapshot.ts` boots a fresh PGLite, runs the full `initSchema()` (forward bootstrap + 30 migrations), and dumps the post-init state to `test/fixtures/pglite-snapshot.tar` plus a SHA-256 schema hash sidecar (`pglite-snapshot.version`). Both are gitignored — built on demand by `bun run build:pglite-snapshot` and cached across runs.
- `PGLiteEngine.connect()` now reads `GBRAIN_PGLITE_SNAPSHOT` env: when set, validates the sidecar hash against the in-process MIGRATIONS hash, then loads via PGLite's `loadDataDir` blob. `initSchema()` becomes a no-op when the snapshot was loaded. Measured per-file cold init drops from 828ms → 181ms (4.5×).
- Bootstrap-correctness tests (`test/bootstrap.test.ts`, `test/schema-bootstrap-coverage.test.ts`) explicitly `delete process.env.GBRAIN_PGLITE_SNAPSHOT` so they keep exercising the cold init path they're meant to verify.

#### Added — Tier 4: slow-test convention
- `*.slow.test.ts` is the convention for tests excluded from the fast `ci:local` shards. `bun run test:slow` (via `scripts/run-slow-tests.sh`) runs only the slow set; CI's normal `bun run test` includes them. `scripts/profile-tests.sh` extracts the top-N slowest tests from any captured `bun test` output for picking demotion candidates.
- One genuinely flaky timing test in `test/progress.test.ts` (`startHeartbeat()` heartbeat-count assertion) gained wider tolerance bounds — 4-way parallel shards inflate `setTimeout` jitter beyond the original 2-6 window. Now accepts 1-20 over a 200ms window.

#### Added — Other
- `test/select-e2e.test.ts` covers all 4 selector branches plus 3 codex regression guards (skills/, untracked files, unmapped src/) — 24 cases.

#### For contributors
- `scripts/select-e2e.ts` exports `selectTests(inputs: SelectInputs): string[]`, `classify(changedFiles: string[]): Classification`, and `matchGlob(glob, path): boolean`. The selector is a pure function — pass arrays in, get test files out — so it's trivial to test and easy to fork for another path-glob shape.
- `scripts/e2e-test-map.ts` exports `E2E_TEST_MAP: Record<string, string[]>`. Adding a narrower mapping is safe; the fail-closed default catches anything missed.

## [0.23.0] - 2026-04-26

**`gbrain dream` now actually dreams. Conversation transcripts become reflections, originals, and 25-year patterns ... overnight.**

The maintenance cycle gains two new phases. Synthesize reads transcripts (OpenClaw session corpus, meeting transcripts, ad-hoc files) and writes brain-native pages: reflections to `wiki/personal/reflections/`, originals to `wiki/originals/ideas/`, timeline entries on existing people pages. Patterns runs after `extract` and surfaces recurring themes ... when ≥3 reflections mention the same motif, a pattern page is written to `wiki/personal/patterns/<theme>` citing every reflection that constitutes its evidence. The phase order is now `lint → backlinks → sync → synthesize → extract → patterns → embed → orphans` ... eight phases, one cron-friendly command.

The motivating story: on 2026-04-25 you read your Stanford-era email archive (4,963 emails, 1999-2001) and the agent had to hand-write the reflection page connecting patterns from age 19 to age 45. The 19-year-old who saved his ICQ logs is the user the system should match. The dream cycle's job is to make the brain a self-enriching memory instead of a manually-curated database.

### The numbers that matter

Real production deployment, default config (Sonnet 4.6 synthesis, Haiku 4.5 verdict, 12-hour cooldown). Reproduce with `gbrain dream --phase synthesize --input <fixture>` against any transcript >2000 chars.

| Metric | Before (v0.20.4) | After (v0.23.0) | Δ |
|---|---|---|---|
| Cycle phases | 6 | 8 | +33% |
| Sources of brain enrichment | 4 (manual, signal, ingest, extract) | 5 (+ overnight synth) | +1 lane |
| Cost / day under autopilot | $0 | ~$1-2 | bounded by cooldown |
| Reflections after 30 days | 0 (manual only) | 10-15 (auto) | "the brain dreams" |

The lane that matters: a daily conversation between you and the agent now lands in long-term memory automatically. No manual write-up. Pattern recognition across reflections is one more sonnet call, not a new subsystem.

### What this means for you

Configure `dream.synthesize.session_corpus_dir` once, set `dream.synthesize.enabled true`, and `gbrain dream` (or your existing autopilot install) consolidates yesterday's conversations every overnight pass. Edited transcripts produce new slugs (content-hash suffix) ... never silently overwrite. The synthesize subagent is bounded to an explicit allow-list sourced from `_brain-filing-rules.json`, so even a poisoned transcript can't write to `wiki/finance/secret.md`. `--dry-run` runs the cheap Haiku verdict (cached in `dream_verdicts`) so you can preview without spending real Sonnet tokens.

## To take advantage of v0.23.0

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Configure the synthesize phase if you want overnight conversation synthesis:**
   ```bash
   gbrain config set dream.synthesize.session_corpus_dir /path/to/transcripts
   gbrain config set dream.synthesize.enabled true
   gbrain dream --phase synthesize --dry-run --json
   ```
   Existing autopilot users see no behavior change until this step ... synthesize is opt-in.
3. **Verify the outcome:**
   ```bash
   gbrain doctor                                   # schema_version should match latest
   gbrain dream --help                             # shows the 8-phase pipeline
   gbrain dream --phase synthesize --dry-run       # zero Sonnet calls; cheap Haiku verdict only
   ```
4. **If any step fails or the numbers look wrong,** please file an issue at https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

### Itemized changes

#### Dream cycle: synthesize phase (`src/core/cycle/synthesize.ts`)

- Reads transcripts from `dream.synthesize.session_corpus_dir` (or `--input <file>` ad-hoc).
- Cheap Haiku verdict per transcript filters routine ops sessions; verdicts cached in the new `dream_verdicts` table keyed by `(file_path, content_hash)` so backfill re-runs skip already-judged transcripts at zero cost.
- Fan-out: one Sonnet subagent per worth-processing transcript, dispatched with `allowed_slug_prefixes` (read once from `skills/_brain-filing-rules.json`'s `dream_synthesize_paths.globs`).
- Idempotency key `dream:synth:<file_path>:<content_hash>` ... same content twice is a queue no-op.
- Slug shape: `wiki/personal/reflections/YYYY-MM-DD-<topic>-<hash[:6]>` and `wiki/originals/ideas/YYYY-MM-DD-<idea>-<hash[:6]>`. Edited transcripts produce new slugs alongside the old; `git log` shows both.
- Provenance via `subagent_tool_executions` (the orchestrator queries each child's put_page input, NOT `pages.updated_at` ... that would pick up unrelated writes).
- Orchestrator dual-write: subagent only calls put_page (writes to DB); after children resolve, the phase reverse-renders each new page from DB to disk via `serializeMarkdown`. Subagent never gets fs-write access.
- Cooldown via `dream.synthesize.last_completion_ts` config key, written ONLY on success. Default 12-hour cooldown caps spend at ~$1-2/day under autopilot. Explicit `--input` / `--date` / `--from` / `--to` invocations bypass cooldown.

#### Dream cycle: patterns phase (`src/core/cycle/patterns.ts`)

- Runs AFTER `extract` (codex finding #7) so the graph state is fresh ... subagent put_page sets `ctx.remote=true` and skips auto-link/timeline by default; extract is the canonical materialization step.
- Single Sonnet subagent gathers reflections within `dream.patterns.lookback_days` (default 30) and surfaces themes that recur in ≥`dream.patterns.min_evidence` (default 3) distinct reflections.
- Pattern slug: `wiki/personal/patterns/<theme>` (no date — patterns aggregate across dates). Existing pattern pages are updated in place via the same allow-listed put_page path.
- Same provenance model as synthesize.

#### Trust boundary: `allowed_slug_prefixes`

- New `OperationContext.allowedSlugPrefixes?: string[]` field. When set on a subagent's put_page call, the slug must match one of the listed prefix globs (e.g. `wiki/personal/reflections/*`) or the call is rejected with `permission_denied`.
- When unset, the legacy `wiki/agents/<subagentId>/...` namespace check applies unchanged ... v0.15 anti-prompt-injection guarantee preserved (regression-guarded by `test/operations-allow-list.test.ts`).
- Trust comes from PROTECTED_JOB_NAMES (MCP can't submit `subagent` jobs at all), NOT from `ctx.remote`. The `remote=true` flag flows through every subagent tool call for auto-link safety; using it as the trust signal would null the allow-list for its intended consumer (codex finding #1, caught and corrected pre-merge).
- Auto-link is re-enabled for trusted-workspace writes so the cycle's extract phase doesn't have to recompute synth-output edges.
- Allow-list lives in ONE place: `skills/_brain-filing-rules.json`'s `dream_synthesize_paths.globs`. Both the subagent runtime and the maintain skill read from there.

#### Cycle scaffolding (`src/core/cycle.ts`)

- `ALL_PHASES` extends to 8 entries; `gbrain dream --phase synthesize` and `--phase patterns` work like any other phase.
- New `yieldDuringPhase` hook in `CycleOpts`. Generic in-phase keepalive that long-running phases call every ~5 min while idle to renew the cycle-lock TTL and the Minions worker job lock. Mirrors `yieldBetweenPhases` shape.
- `CycleReport.totals` grew additively (schema_version stays "1"): new fields `transcripts_processed`, `synth_pages_written`, `patterns_written`. Existing consumers see no breaking change.
- `synthesize` and `patterns` both fall under `NEEDS_LOCK_PHASES`; read-only invocations like `--phase orphans` continue to skip the lock.

#### CLI extensions (`src/commands/dream.ts`)

- New flags: `--input <file>` (ad-hoc transcript synthesis; implies `--phase synthesize`), `--date YYYY-MM-DD` (single-day), `--from YYYY-MM-DD --to YYYY-MM-DD` (backfill range).
- `--dry-run` semantics documented explicitly (codex finding #8): runs the cheap Haiku significance verdict (caches it for free) but skips the Sonnet synthesis pass. NOT zero LLM calls.
- Conflict detection: `--input` plus `--date` / `--from` / `--to` exits 2 with a clear error.
- Help text now reflects the 8-phase pipeline.

#### Schema migration v25 (`src/core/migrate.ts`, `src/schema.sql`)

- Creates `dream_verdicts (file_path TEXT, content_hash TEXT, worth_processing BOOL, reasons JSONB, judged_at TIMESTAMPTZ, PRIMARY KEY(file_path, content_hash))`. Distinct from `raw_data` (which is page-scoped) ... transcripts being judged aren't pages.
- RLS-enabled when running as a BYPASSRLS role (matches the existing v24 pattern).
- New engine methods `getDreamVerdict` / `putDreamVerdict` on both Postgres and PGLite. ON CONFLICT upserts; idempotent across re-runs.

#### Tests

- `test/operations-allow-list.test.ts` (NEW, IRON RULE security regression guard) ... 11 cases covering ALLOW path, REJECT path, glob match (recursive depth), legacy namespace check when allow-list unset, FAIL-CLOSED behavior when `viaSubagent=true` but `subagentId` is missing.
- `test/cycle-synthesize.test.ts` (NEW) ... 20 cases covering `compileExcludePatterns` word-boundary heuristic, transcript discovery (date filters, multi-source merge, exclude regex, `min_chars`), content-hash stability across edits, `readSingleTranscript` ad-hoc path.
- `test/cycle-patterns.test.ts` (NEW) ... 12 structural cases covering subagent dispatch wiring, allow-list flow from filing-rules JSON, scope filter (`slug LIKE 'wiki/personal/reflections/%'`), the codex #2 fix (provenance via `subagent_tool_executions`).
- `test/dream-cli-flags.test.ts` (NEW) ... 9 cases covering `--input` / `--date` / `--from` / `--to` parsing, ISO date validation, conflict detection, dry-run semantics documentation.
- `test/e2e/dream-allow-list-pglite.test.ts` (NEW) ... 6 cases on PGLite covering the full subagent → put_page allow-list path: in-allow-list slug writes, out-of-allow-list slug rejected, legacy namespace fallback when allow-list unset, `subagent_tool_executions` schema for provenance queries.
- `test/e2e/dream-synthesize-pglite.test.ts` (NEW) ... 8 cases on PGLite covering disabled/not_configured paths, empty corpus, no-API-key skip path, dry-run semantics, cooldown active/bypass, `dream_verdicts` cache hit.

#### Documentation

- `skills/maintain/SKILL.md` ... new "Dream cycle: synthesize + patterns" section with the quality bar, trust boundary, idempotency model, cooldown semantics, and invocation patterns. Triggers updated to route "process today's session", "synthesize my conversations", and "what patterns did you see" to maintain.
- `skills/_brain-filing-rules.md` ... new "Dream-cycle synthesize/patterns directories" section documenting the allow-listed paths, slug discipline, and the iron law for synthesis output.
- `skills/_brain-filing-rules.json` ... new `dream_synthesize_paths.globs` array (single source of truth).
- `skills/RESOLVER.md` ... new dream-cycle row under brain operations.
- `skills/migrations/v0.21.0.md` (NEW) ... migration narrative covering schema migration v25 + the optional opt-in for synthesize + tunables.
- `CLAUDE.md` ... architecture section reflects 8-phase cycle + new files (`src/core/cycle/{synthesize,patterns,transcript-discovery}.ts`).

#### Codex review-driven corrections

Eight findings from the cross-model review caught real implementation traps before merge. All 8 resolutions integrated:

1. Trust signal correction (drop `remote=null` defense, rely on PROTECTED_JOB_NAMES gating).
2. Provenance via child `subagent_tool_executions` (not `pages.updated_at`).
3. New `dream_verdicts` mini-table (raw_data is page-scoped and won't fit).
4. Summary slug regex-compatible: `dream-cycle-summaries/YYYY-MM-DD` (no underscore, no `.md`).
5. Auto-commit/push deferred to v1.1 (dirty-worktree handling, auth failure, non-FF push need their own design).
6. Lossy-serialization acknowledged: the orchestrator does fresh-render from DB, not byte-identical round-trip.
7. Phase ordering: patterns runs AFTER extract so the graph is fresh.
8. `--dry-run` semantics documented: runs Haiku, skips Sonnet (NOT zero LLM calls).

#### Deferred to v1.1

- Auto git commit + push from the synthesize/patterns phases. v1 writes files locally; either commit yourself or let `gbrain autopilot` handle it.
- Daily token budget cap. Cooldown is the v1 spend bound.
- Cross-modal pattern review (currently reflections-only).


## [0.22.16] - 2026-04-29

**End-to-end claw-test friction harness — every release now gets a fresh-install dry-run.**
**`gbrain claw-test` spins up a hermetic tempdir, walks the canonical first-day flow, and surfaces friction the way a real new user would hit it.**

Before this release, every gbrain release shipped on faith: docs said "the agent runs `gbrain init`, then `gbrain import`, then `gbrain query`," and we'd find out at user-feedback time which step actually broke. Issue #239/#243/#266/#357/#366/#374/#375/#378/#395/#396 — ten upgrade-wedge incidents in two years — all came from this gap. There was no harness that exercised the user's-eye experience: spin up a fresh tempdir, install gbrain, watch what breaks.

Now there is. `gbrain claw-test --scenario fresh-install` in scripted mode is a CI gate (~30s, no API keys). `gbrain claw-test --live --agent openclaw` spawns a real openclaw subprocess, hands it `BRIEF.md`, captures every byte of its stdin/stdout/stderr to `transcript.jsonl`, and lets the agent log friction whenever something is confusing or wrong. End-of-run renders a markdown report grouped by severity and phase, with `<HOME>` redaction so it pastes safely into PRs.

The friction signal comes from a new `gbrain friction {log,render,list,summary}` CLI. Schema is a flat extension of `StructuredAgentError`. Run-id resolves from `--run-id` > `$GBRAIN_FRICTION_RUN_ID` > `standalone.jsonl`, so the same CLI works inside a harness session, manually during normal use, or from a scripted test. Append-only JSONL; readers tolerate malformed lines.

**$GBRAIN_HOME is finally honored everywhere it should be.** `configDir()` in `src/core/config.ts` always supported the parent-dir override, but ~12 consumers built paths from `os.homedir()` directly and bypassed it. Critically, `loadConfig`/`saveConfig` themselves used a private helper that ignored the env. Migrated every write site to a new `gbrainPath()` helper: fail-improve, validator-lint, cycle lock, audit handlers, sync-failures, integrity logs, integrations heartbeat, init pglite path, migrate-engine manifest, import checkpoint, migration rollbacks. Read-side host-detection (`~/.claude` / `~/.openclaw` probes for mod fingerprinting) intentionally stays as-is; v1.1 will add a separate `$GBRAIN_HOST_HOME`.

### Itemized changes

#### Added

- `gbrain claw-test --scenario {fresh-install|upgrade-from-v0.18}` — scripted-mode CI gate that runs the canonical first-day flow against a fresh tempdir. Asserts every expected `--progress-json` phase fired and doctor's `status === 'ok'`. ~30s, no API keys.
- `gbrain claw-test --live --agent openclaw` — friction-discovery mode. Spawns real openclaw, hands it `BRIEF.md`, captures stdin/stdout/stderr to `<run>/transcript.jsonl`, lets the agent log friction. ~5–10 min and ~$1–2 in tokens.
- `gbrain claw-test --list-agents` — reports which agent runners are registered + their detection state.
- `gbrain friction log --severity {confused|error|blocker|nit} --phase <name> --message <text> [--hint ...] [--kind {friction|delight}] [--run-id ...]` — append a friction or delight entry.
- `gbrain friction render --run-id <id> [--json] [--transcripts] [--no-redact]` — markdown report grouped by severity + phase; `--redact` defaults on for md output.
- `gbrain friction list [--json]` — recent run-ids with friction/delight counts; interrupted runs marked `(interrupted)`.
- `gbrain friction summary --run-id <id> [--json]` — two-column friction + delight summary.
- `skills/_friction-protocol.md` — cross-cutting convention skill telling agents when to call `gbrain friction log`. Routes from any skill the claw-test exercises.
- `gbrainPath(...segments)` helper in `src/core/config.ts` — single sugar for resolving paths under the active `$GBRAIN_HOME`. `$GBRAIN_HOME` is now validated (must be absolute, no `..` segments).
- Two scenario fixtures in `test/fixtures/claw-test-scenarios/`: `fresh-install` (canonical 5-min flow) and `upgrade-from-v0.18` (scaffolded; real v0.18 SQL dump documented as a v1.1 follow-up).
- New `src/core/claw-test/` module with `agent-runner.ts` (interface + registry), `transcript-capture.ts` (async-drain capture so 256KB+ bursts don't stall the child), `progress-tail.ts`, `scenarios.ts`, and `seed-pglite.ts` (~50 LOC PGLite SQL replay primitive).

#### Changed

- Every `~/.gbrain/...` write site now resolves through `gbrainPath()` instead of building paths from `os.homedir()`. Affected: `src/core/{fail-improve,output/post-write,cycle,sync}.ts`, `src/core/minions/{handlers/shell-audit,backpressure-audit}.ts`, `src/commands/{integrity,integrations,init,migrate-engine,import,migrations/v0_13_1,migrations/v0_14_0}.ts`. Tests that previously used the `process.env.HOME = tmpdir` workaround now use `process.env.GBRAIN_HOME` directly.
- `loadConfig`/`saveConfig` honor `$GBRAIN_HOME`. Previously, the public `configDir()` honored it but the internal `getConfigDir()` did not — so the config file itself silently leaked into the developer's real `~/.gbrain` regardless of the env override.

#### Tests

- 113 new unit tests covering: writer atomicity (concurrent appends), renderer redaction, agent registry resolution + selection precedence, multi-byte UTF-8 chunk-boundary safety, PIPE buffer drain under 256KB+ bursts, scenario load + validation, progress event parsing, SQL splitter (single-quote + line-comment handling), and full claw-test E2E (`test/e2e/claw-test.test.ts` builds a tiny `bun run src/cli.ts` shim and runs --scenario fresh-install end-to-end + a deliberate-break test that proves the friction signal fires).
- `test/gbrain-home-isolation.test.ts` is the regression gate: spawns `gbrain init --pglite` and `gbrain import --no-embed` with `GBRAIN_HOME=<tmp>`, asserts no writes outside `<tmp>/.gbrain` (covers `import.ts:54`, `sync.ts:317`, `upgrade.ts:117`, audit dirs).

## [0.22.15] - 2026-04-29

## **Throw bare markdown into your brain and it becomes properly typed knowledge. No YAML ceremony.**

A real 81K-page brain has 9,655 files with no frontmatter. They imported fine, but every one of them landed in the DB as `type: concept`, `title: <slugified-filename>`, no date, no source, no tags. Search ranking suffered. Type-filtered queries missed them. Entity resolution fell over.

This release adds path-aware frontmatter inference. `gbrain sync` now synthesizes type, date, source, and tags from the filesystem path and first heading the moment a bare-frontmatter file imports. No LLM call, fully deterministic, file on disk untouched. An Apple Note at `Apple Notes/2010-04-13 founders mtg.md` lands as `type: apple-note, title: founders mtg, date: 2010-04-13, source: apple-notes` instead of `type: concept, title: 2010 04 13 Founders Mtg`.

If you want the inference written back to git, the new `gbrain frontmatter generate <path> --fix` walks a brain dir, infers frontmatter for every file that lacks it, and writes back with `.bak` safety backups. Dry-run by default.

### The 9,655 numbers that matter

Measured against my actual brain (gbrain v0.22.8 + the new inference path).

| Behavior | Before v0.22.15 | After v0.22.15 |
|---|---|---|
| Files importing as `type: concept` (no frontmatter) | 9,655 | 0 |
| Apple Notes typed correctly (`apple-note`) | 0 | 5,861 |
| Calendar indexes typed correctly (`calendar-index`) | 0 | 3,201 |
| Therapy sessions typed + dated | 0 | 60 |
| Essay drafts typed + dated | 0 | 33 |
| LLM cost for the full reclassification | n/a | $0 |

The agent doing type-filtered queries on your brain (`type: person`, `type: meeting`, `type: essay`) now actually finds those pages instead of treating everything as `concept`.

### What this means for you

If you've been resisting frontmatter ceremony — same. Throw bare markdown into your brain and inference handles it. The rules table in `src/core/frontmatter-inference.ts` covers the obvious directories (`people/`, `companies/`, `daily/calendar/`, `writing/`, `meetings/`, `personal/`, etc.) plus a generic catch-all. Adding a new convention is one line in `DIRECTORY_RULES`.

## To take advantage of v0.22.15

`gbrain upgrade` should do this automatically. Then:

1. **Run a dry-run preview:**
   ```bash
   gbrain frontmatter generate ~/brain
   ```
   You'll see how many files would get inferred frontmatter and the breakdown by type.
2. **Optionally write back to git:**
   ```bash
   gbrain frontmatter generate ~/brain --fix
   ```
   Each modified file gets a `.bak` backup before rewrite.
3. **Re-sync to pick up the new metadata:**
   ```bash
   gbrain sync ~/brain
   ```
   Inferred frontmatter is folded into `content_hash`, so previously-bare files re-import once with proper types and re-embed. Subsequent syncs are idempotent.
4. **If anything looks off,** please file an issue: https://github.com/garrytan/gbrain/issues with the path of the misclassified file and the rule that matched.

### Itemized changes

#### Features
- `src/core/frontmatter-inference.ts` (new module) — Path-aware frontmatter synthesis. `DIRECTORY_RULES` table maps path prefixes to type/date/title/source/tags. First-match-wins. Date extraction from filenames (`YYYY-MM-DD` prefix or anywhere). Title extraction with date-prefix stripping and first-`#`-heading fallback (20-line window). YAML-safe serialization with quoting for special characters.
- `src/core/import-file.ts` — `importFromFile()` runs inference inline before `parseMarkdown()` when `opts.inferFrontmatter !== false` (default on). The synthesized frontmatter folds into the in-memory content for parsing, chunking, embedding, and content-hash computation. The file on disk is not modified.
- `src/commands/frontmatter.ts` — New `gbrain frontmatter generate <path> [--fix] [--dry-run] [--json]` subcommand. Walks a directory (skips `.git`, `node_modules`, `.obsidian`, symlinks), runs inference on every `.md` file without frontmatter, optionally writes back with `.bak` backups. Auto-detects brain root by walking up for `.git`. Shows per-type breakdown and first-10 examples.

#### Fixes
- `src/commands/frontmatter.ts:344` — `runGenerate` dynamic path import now includes `basename`. Single-file invocation (`gbrain frontmatter generate <file>`) previously crashed with `ReferenceError: basename is not defined` on the relative-path-empty fallback at line 437.

#### Tests
- `test/frontmatter-inference.test.ts` (new, 35 cases) — date extraction (5), title extraction from filenames (5) and headings (4 incl. 20-line boundary), inference for every directory rule (13 incl. Apple Notes subfolder tagging), serialization with YAML-safe quoting (4), `applyInference` integration (2), rule ordering and catch-all coverage (2).

## [0.22.14] - 2026-04-29

**Bare `gbrain jobs work` now self-monitors and fail-stops cleanly when its database dies or the queue stalls.**
**The wedged-worker class of bug — process alive, jobs piling up, your `pgrep` check happily green — is gone.**

A production brain (54K pages, Supabase Postgres, 3-concurrency worker under a cron-based PM)
hit it last week: worker process state=Sl at 13:15 UTC, stopped claiming jobs, 21 jobs stacked
in `waiting` over two hours, 5 autopilot-cycles dead-lettered at the 600s timeout, then 150
zombie processes accumulated over the container's 31-day life. The PM's `pgrep` saw a live
PID and reported green the entire time.

Pre-v0.22.14, bare `gbrain jobs work` had **zero** health monitoring. The supervisor (`gbrain
jobs supervisor`) had the right protections — DB liveness probes, stall detection, RSS
watchdog, reconnect on transient PgBouncer blips — but the supervisor wraps `jobs work` as a
child, and many production deployments run bare `jobs work` directly under systemd, Docker,
launchd, cron watchdog, or supervisord. That mode got nothing.

This release moves health monitoring into the bare worker itself, gated by `GBRAIN_SUPERVISED=1`
so it doesn't double up under the supervisor. When the worker detects it's wedged, it emits an
`'unhealthy'` event with a structured reason, and the CLI calls `process.exit(1)` so the external
PM restarts it cleanly. **This is fail-stop:** the worker exits and stays dead until your PM
brings it back. If you run bare `jobs work` without a restart loop, you need one now.

### The numbers that matter

Detection signatures the new health check catches, measured against the production incident
above (and the 30-day deployment running under the band-aid bash watchdog Garry deployed before
this fix):

| Failure mode | Before v0.22.14 | After v0.22.14 |
|---|---|---|
| DB connection death (Supabase/PgBouncer drop) | undetected; worker idles forever | 3 consecutive `SELECT 1` failures (≤3min) → `'unhealthy'`+exit |
| Hung DB probe (network partition) | timer wedged forever, monitoring silently disabled | 10s probe timeout per tick → counted as failure → exit at strike 3 |
| Worker stall (event loop alive, claim returns null) | undetected; jobs pile up in `waiting` | 5min warn, 10min `'unhealthy'`+exit (measured from last completion) |
| Memory leak (RSS climbing past 2GB) | undetected on bare workers | watchdog default 2048 MB triggers `gracefulShutdown('watchdog')` |
| Worker stalled but waiting jobs are unhandled type | ❌ false-positive exit (restart loop) | filter by registered handler names, no exit |

Operationally: from the band-aid bash watchdog Garry deployed before this fix, fresh worker
restart cleared 21 waiting → 0 in 2 minutes, then ran stable for 30+ min with 130 MB RSS,
autopilot-cycles completing in 0.2–0.6s instead of timing out at 600s.

### What this means for operators

Add a restart policy to your bare-worker invocation BEFORE upgrading. The new behavior is
fail-stop, not self-healing — without a restart loop, your worker will exit on the first DB
blip and stay dead. systemd `Restart=always`, Docker `restart: always`, launchd `KeepAlive`,
cron watchdog, supervisord `autorestart=true`. The migration walks every PM. If you're using
`gbrain jobs supervisor`, you're already protected — the supervisor handles spawn-on-crash
itself.

The default `--max-rss` for bare workers also bumped from 0 (off) to 2048 MB. If you ran bare
workers with intentionally large embed/import jobs, raise the limit (`--max-rss 4096`) or opt
out (`--max-rss 0`). The migration includes per-PM unit-file edits.

## To take advantage of v0.22.14

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about
a bare worker exiting with watchdog signatures:

1. **Confirm your bare-worker invocations have a restart policy:**
   ```bash
   # systemd
   grep -E '^Restart=' ~/.config/systemd/user/gbrain-worker.service /etc/systemd/system/gbrain-worker.service 2>/dev/null
   # crontab
   crontab -l | grep "gbrain jobs work"
   # launchctl
   plutil -p ~/Library/LaunchAgents/com.user.gbrain-worker.plist | grep -A1 KeepAlive
   ```
2. **Decide on RSS posture:**
   - Default 2048 MB matches supervisor behavior. Most bare workers fit.
   - Embed/import jobs > 2GB? Pass `--max-rss 4096` (or higher).
   - Intentionally unbounded? Pass `--max-rss 0`.
3. **Walk the migration:** `skills/migrations/v0.22.14.md` has the full per-PM table and a
   verification block.
4. **Verify:**
   ```bash
   gbrain jobs stats
   gbrain doctor --json | jq '.checks[] | select(.name == "queue_health")'
   ```
   Worker startup line should now read:
   `Minion worker started (queue: default, concurrency: 3, watchdog: 2048MB, health-check: 60s)`
   Under supervisor: the `health-check: Ns` segment is absent (supervisor handles it).
5. **If anything fails or numbers look wrong**, file an issue at
   https://github.com/garrytan/gbrain/issues with `gbrain doctor` output and the contents of
   `~/.gbrain/upgrade-errors.jsonl` if it exists.

### Itemized changes

#### Added
- `MinionWorkerOpts.{healthCheckInterval, stallWarnAfterMs, stallExitAfterMs, dbFailExitAfter, dbProbeTimeoutMs}` — five new tuning knobs. Defaults: 60s probe interval, 5min warn / 10min exit, 3 DB strikes, 10s per-probe timeout.
- `MinionWorker` now extends `EventEmitter`. Emits `'unhealthy'` with `{ reason: 'db_dead', consecutiveFailures, message } | { reason: 'stalled', waitingCount, idleMinutes }`. CLI subscribes; direct API consumers without a listener inherit a fail-stop fallback that calls `process.exit(1)` to preserve pre-refactor semantics.
- `gbrain jobs work --health-interval MS` — tune the self-health-check cadence (0 disables; rejects NaN/negative/sub-1000ms typos).
- `gbrain jobs supervisor --health-interval MS` — same flag, same validation, same `0 = disable` contract on the supervisor's own probe.
- `GBRAIN_SUPERVISED=1` env var on the supervisor's spawned worker child (skips the child's self-health timer to avoid double-monitoring).
- `gbrain doctor` `queue_health` subcheck reports RSS-watchdog kills in the last 24h via exact match on `error_text = 'aborted: watchdog'` scoped to `status IN ('dead','failed')`.
- `skills/migrations/v0.22.14.md` — full migration walkthrough with per-PM restart-policy preflight, RSS-posture decision tree, and per-system unit-file edits.

#### Changed
- **Default `--max-rss` for `gbrain jobs work`: 0 → 2048 MB.** Matches supervisor default. Catches memory-leak stalls that previously went undetected on bare workers. Opt out with `--max-rss 0`.
- **Bare-worker behavior is now fail-stop** when the DB is unreachable or the queue stalls. Pre-v0.22.14 the worker idled silently. Now it exits and relies on the external PM (systemd, Docker, launchd, cron, supervisord) to restart cleanly.
- Stall query at `worker.ts` filters by registered handler names (`AND name = ANY($2::text[])`) so workers don't false-positive when waiting jobs of unhandled names accumulate.
- Stall exit threshold measured from `lastCompletionTime` (not from when the warning fired), so 5min warn / 10min exit means total idle of 10 min — not 15 min.
- DB liveness probe wrapped in `Promise.race` against a 10s timeout so a hung `executeRaw` cannot wedge the recursive `setTimeout` chain forever.
- `setInterval` → recursive `setTimeout` with a `running` flag throughout. Eliminates timer-callback overlap on slow probes.
- `parseMaxRssFlag` returns `number | undefined` (was `number`) so callers distinguish absent from explicit-disable.
- `process.env.GBRAIN_SUPERVISED` check tightened from `!!env.X` to `=== '1'` (precise contract; no fuzzy matching on `'0'` or `'false'`).
- `MinionWorker` constructor throws when `stallExitAfterMs <= stallWarnAfterMs` so misconfigurations fail loudly at startup.

#### Fixed
- **Wedged-worker false-positive on heterogeneous queues** — workers registering only some handlers no longer interpret waiting jobs of other names as a stall. Repeated `process.exit(1)` → restart loop is gone.
- **Hung DB probe wedge** — pre-fix, a hung `executeRaw('SELECT 1')` kept the recursive `setTimeout` from rescheduling, silently disabling the entire health monitor. Post-fix, the probe times out and counts as a failure.
- **`--health-interval 0` no longer DB-hammers the supervisor.** Pre-fix, the documented "0 disables" contract was a lie — `setInterval(cb, 0)` schedules a tight loop. Now gated behind `> 0`.
- **Inline `jobs submit --follow` and `jobs smoke` no longer kill the user's CLI session** on a DB blip. Both now pass `healthCheckInterval: 0` so the no-listener fallback can't trip on one-shot runs.
- Doctor's RSS-watchdog hint matches the actual error_text signature (`'aborted: watchdog'`) instead of the wrong `'memory limit'` literal that never matched.

#### For contributors
- `MinionWorker extends EventEmitter` — if you import the class directly, the `on('unhealthy', ...)` event is now part of the public surface. The `UnhealthyReason` discriminated union is exported from `src/core/minions/worker.ts`.
- New regression-test infrastructure in `test/minions.test.ts`: `makeProbeEngine(overrides)` is a Proxy-based engine wrapper that intercepts `SELECT 1` and the stall `count(*)` query while passing every other call through to the real PGLite engine. Useful for any future test that needs to inject DB liveness or stall semantics without mocking the entire engine surface.

### Adjacent (separate PR, v0.22.15)

PR #503 catches the *symptom* of one specific failure mode. The cause-side fix — `runPhaseEmbed → embed.ts → embedBatch` not honoring `signal.aborted` between OpenAI batch calls — ships in v0.22.15 (highest-priority TODO; daily wedge driver). Plumbing is documented in `TODOS.md`.

## [0.22.13] - 2026-04-28

**Sync got faster, and the bookmark stopped lying.**
**Parallel imports, a real writer lock, and a head-drift gate that catches the worst race.**

The headline is `gbrain sync --workers N`: per-worker Postgres engines with an atomic queue index, same pattern as `gbrain import --workers N`. On a 7,000-page brain that used to take 25+ minutes, the import phase now runs across 4 workers by default. The reproducible benchmark in `test/e2e/sync-parallel.test.ts` shows `parallel(4)` finishing 1.3× faster than serial on a 120-file fixture against local Postgres (`serial=289ms parallel(4)=221ms`). The speedup grows on larger brains and slower-roundtrip databases (Supabase, remote PgBouncer) because the worker setup cost amortizes over more files. But the bigger story is that the sync writer is finally exclusive across processes, and the `last_commit` bookmark refuses to advance when git HEAD has drifted out from under us. The silent-skip-then-advance pathology has survived every prior sync hardening pass. It is dead now.

### What you can do now

- `gbrain sync --workers 4` (alias `--concurrency 4`) parallelizes the import phase. Each worker holds 2 connections, so total Postgres connections during the parallel phase is `workers * 2` plus your caller's pool. At the default of 4 workers and a 10-connection caller pool, that's up to 18 connections, well under PgBouncer's `max_client_conn` default of 100 but worth knowing on tight Supabase tiers.
- **Auto-concurrency:** if you don't pass `--workers`, sync uses 4 workers when the diff exceeds 100 files. Smaller diffs stay serial. Explicit `--workers` always wins (even on a 30-file diff). PGLite forces serial regardless, since it's a single-connection engine.
- **Full sync** routes through the same path. First syncs on large brains parallelize automatically.
- **Minion `sync` jobs** also use the new `autoConcurrency()` policy. Behavior is now consistent between CLI sync, the Minion handler, and the autopilot cycle's sync phase. (`noEmbed` defaults to `true` in the jobs handler. Submit `gbrain embed --stale` as a separate job when needed, or rely on the autopilot cycle's embed phase.)
- **`--workers` validation is loud now.** `--workers 0`, `--workers -3`, `--workers foo`, `--workers 1.5` all exit with an error message. The prior behavior silently fell through to auto-concurrency (4 workers), the opposite of what you typed.

### Correctness fixes you didn't have to ask for

- **Cross-process writer lock.** Two `gbrain sync` calls (manual + autopilot, two terminals, two Conductor workspaces) used to read the same `last_commit`, both write it, and let the last writer win. The new `gbrain-sync` row in `gbrain_cycle_locks` serializes the writer window. Same-process reentrance from the autopilot cycle handler was already covered by the broader `gbrain-cycle` lock; sync's lock is narrower and runs underneath it.
- **Head-drift gate.** If `git checkout` or `git pull` runs in your worktree mid-sync (Conductor sibling workspace, ad-hoc terminal), the captured `headCommit` no longer matches HEAD when sync finishes. `last_commit` no longer advances in that case. The next sync re-walks the diff against the new HEAD instead of silently moving the bookmark past unimported work.
- **Vanished files now block bookmark advance.** A file the diff said exists at `headCommit` but is gone from disk used to register as a benign skip. It now goes into `failedFiles` and gates `last_commit` the same way a parse failure does.
- **Per-source bookmark for Minion `sync` jobs.** The job handler now resolves `sourceId` from the repo path (mirrors the autopilot cycle's `cycle.ts` fix from PR #475). On multi-source brains, this prevents the 30-min full-reimport-every-cycle behavior caused by reading the global `config.sync.last_commit` anchor when the per-source row would have been correct.
- **Worker connection cleanup.** Worker engines now disconnect inside `try/finally`, even on partial connect failure or mid-import error. The prior `Promise.all(...disconnect)` ran outside any try/finally, so panic-path leaks never released the 8 worker connections.
- **Engine detection unified.** Both PGLite-detection sites in sync.ts now use `engine.kind === 'pglite'` (the discriminator added in v0.13.1). The `engine.constructor.name === 'PGLiteEngine'` sniff is gone, since it broke under bundling and was inconsistent with the other site's `config.engine` string check.

### What this means for you

If you run autopilot on a 7,000-page Postgres brain, your sync cycle gets faster on day one with no flags. If you have ever felt the bookmark "skip past" work that didn't import, you'll stop seeing it. If you have multiple Conductor workspaces poking the same brain, you'll either wait politely on the writer lock or get a clear "another sync is in progress" error. None of this requires a config change.

## To take advantage of v0.22.13

`gbrain upgrade` should do this automatically. If you want to use the new flags right now:

1. **For a one-off speed win on a large brain:**
   ```bash
   gbrain sync --workers 4
   ```
   Or for incremental syncs that touch >100 files, just run `gbrain sync`. Auto-concurrency fires.

2. **For your autopilot cycle:** no action. The Minion `sync` handler picks up the new auto-concurrency policy automatically.

3. **Verify the writer lock is working:**
   ```bash
   gbrain sync &
   gbrain sync   # second call will say "Another sync is in progress" or wait
   ```

4. **If sync ever errors with "Another sync is in progress" and stays stuck:** the lock is in `gbrain_cycle_locks` with id `gbrain-sync` and a 30-minute TTL. If a worker crashed without releasing, the next acquirer takes over once the TTL expires. To unstick faster:
   ```sql
   DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-sync';
   ```

5. **If anything looks wrong,** file an issue: https://github.com/garrytan/gbrain/issues with output of `gbrain doctor` and the contents of `~/.gbrain/upgrade-errors.jsonl` if it exists.

### Itemized changes

- `src/commands/sync.ts`: `performSync` now wraps body in a `gbrain-sync` DB lock; `--workers` honored regardless of file count when explicit; head-drift gate after import phase; engine.kind detection; try/finally around worker engines; banner moved to stderr.
- `src/commands/import.ts`: `engine.kind === 'pglite'` discriminator; try/finally around worker engines; shared `parseWorkers()` for `--workers` validation.
- `src/commands/jobs.ts`: sync handler resolves `sourceId` via `sources.local_path` lookup; concurrency routed through `autoConcurrency()`; `noEmbed: true` default documented.
- `src/core/sync-concurrency.ts` (new): `autoConcurrency()` + `parseWorkers()` + constants. One source of truth for the concurrency policy that previously lived in three call sites.
- `src/core/db-lock.ts` (new): generic `tryAcquireDbLock(engine, lockId)` over the existing `gbrain_cycle_locks` table. Reused by performSync. cycle.ts continues to use its own ID `gbrain-cycle` so the two locks nest cleanly.
- `test/sync-concurrency.test.ts` (new): 17 cases covering autoConcurrency thresholds, shouldRunParallel gates, parseWorkers validation.
- `test/sync-parallel.test.ts` (new): PGLite-routed coverage of the bookmark gate under concurrency request, the head-drift gate, the writer-lock contract, and PGLite-stays-serial.
- `test/e2e/sync-parallel.test.ts` (new): DATABASE_URL-gated Postgres E2E. 60-file happy path with `pg_stat_activity` leak probe, plus a 120-file serial-vs-parallel benchmark that prints `SYNC_PARALLEL_BENCH ...` for CHANGELOG quoting.

### For contributors

- `BrainEngine.kind` is now the canonical PGLite/Postgres discriminator. Avoid `engine.constructor.name === '...'` (breaks under bundling) and `config.engine === '...'` (inconsistent with the engine actually in use).
- The `gbrain_cycle_locks` table is now multi-purpose. The id column distinguishes lock scopes: `gbrain-cycle` for the cycle, `gbrain-sync` for the sync writer. Future locks should pick distinct ids and reuse `tryAcquireDbLock`.
- `parseWorkers()` is the canonical CLI flag parser for `--workers`. Use it instead of inline `parseInt`.

## [0.22.12] - 2026-04-29

**`sync --skip-failed` now classifies file-size and symlink rejections instead of bucketing them as UNKNOWN.**
**Plus a full end-to-end test for the failure loop.**

v0.22.9 shipped the headline classifier work: code-grouped breakdowns at sync time,
DB-vs-YAML disambiguation, doctor surfaces both unacked and historical entries with
`[CODE=N]` lines. v0.22.12 closes the last two coverage gaps that v0.22.9 left on
the table:

- **FILE_TOO_LARGE** now covers the three real production sites in
  `src/core/import-file.ts:199, 352, 401` ("Content too large", "File too large",
  "Code file too large"). On v0.22.9 these all bucketed as UNKNOWN — the same
  silent-systemic-failure pattern that motivated the original issue.
- **SYMLINK_NOT_ALLOWED** covers `src/core/import-file.ts:347` ("Skipping symlink").
  Security-relevant rejection that operators should see.
- **End-to-end failure-loop test** in `test/e2e/sync.test.ts` exercises the full
  chain: broken file → sync blocks with grouped breakdown → `--skip-failed`
  advances bookmark with grouped acknowledgement → second broken file → second
  cycle. PostgreSQL-backed; verifies bookmark gating, JSONL state, dedup, and
  summary aggregation. v0.22.9's coverage was unit-tests-only.

Twelve total error codes ship in the classifier:
`SLUG_MISMATCH`, `YAML_PARSE`, `YAML_DUPLICATE_KEY`, `DB_DUPLICATE_KEY`,
`MISSING_OPEN`, `MISSING_CLOSE`, `NESTED_QUOTES`, `EMPTY_FRONTMATTER`,
`NULL_BYTES`, `INVALID_UTF8`, `STATEMENT_TIMEOUT`, `FILE_TOO_LARGE`,
`SYMLINK_NOT_ALLOWED`. Anything the regex set doesn't recognize falls through
as `UNKNOWN`.

### What this means for you

If your brain rejects oversized files or symlinks, you now see those rejections
in the doctor breakdown and at sync time grouped by code, instead of as
`UNKNOWN`. Run `gbrain upgrade`. No manual action required.

### Itemized changes

#### Added
- `FILE_TOO_LARGE` classifier code covering `src/core/import-file.ts:199, 352, 401`.
- `SYMLINK_NOT_ALLOWED` classifier code covering `src/core/import-file.ts:347`.
- Two new unit tests in `test/sync-failures.test.ts` pinning the new codes against
  literal production message strings (`File too large (N bytes)`, `Skipping symlink: ...`).
- `test/e2e/sync.test.ts` — new failure-loop test exercising broken-file → block →
  `--skip-failed` → second cycle. Hermetic on developer machines (saves+restores
  the user's real `~/.gbrain/sync-failures.jsonl`).

## To take advantage of v0.22.12

No manual action required. Run `gbrain upgrade`. The new `FILE_TOO_LARGE` and
`SYMLINK_NOT_ALLOWED` classifier codes apply on the next `gbrain sync`.

## [0.22.11] - 2026-04-27

**Storage tiering, finally working. Brains scaling past 100K files stop bloating git.**

The original storage-tiering branch shipped two silent bugs (gray-matter on YAML returned empty data; `manageGitignore` was defined and never invoked) so the feature was a no-op for every user who tried it. v0.22.11 rewrites the broken bits, hardens the surface, and adds proper test coverage. If you have a brain repo north of 100K files where bulk machine-generated content (tweets, articles, transcripts) is the size driver, this is the release that pulls it out of git without losing any data.

Configure tiering in `gbrain.yml` at the brain repo root:

```yaml
storage:
  db_tracked:
    - people/
    - companies/
    - deals/
  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

`gbrain sync` then auto-manages your `.gitignore` for `db_only` directories so bulk content stops landing in commits. `gbrain export --restore-only` repopulates missing `db_only` files from the database (container restart, fresh clone, accidental rm). `gbrain storage status` shows the breakdown — counts, disk usage, missing files.

### The numbers that matter

200K-page brain, half tweets and articles. Before v0.22.11:

| Metric | Before | After | Δ |
|--------|--------|-------|---|
| `gbrain.yml` actually loads | no (silent null) | yes | feature works |
| `.gitignore` auto-manages | no (function never called) | yes | docs match reality |
| `--restore-only` without `--repo` | silent full export | hard error | no data-loss footgun |
| `media/xerox` matched against `media/x` | yes (collision) | no | path-segment matching |
| Per-page disk syscalls during status | ~400K (existsSync + statSync) | ~one per dir + one stat per .md | single-walk scan |
| Validation surfaces overlap | warning only | throws StorageConfigError | semantic error caught |

### What this means for your brain

If you've been reading the storage-tiering docs and waiting for the feature to actually do something: it does now. If you're already over 50K files: configure `gbrain.yml`, run `gbrain sync`, watch `.gitignore` update itself, watch your next clone get faster.

## To take advantage of v0.22.11

1. Add a `storage:` section to `gbrain.yml` at your brain repo root with `db_tracked` and `db_only` arrays. The directory paths must end with `/` (the validator auto-normalizes if you forget, with a one-time info note).
2. Run `gbrain sync`. It updates `.gitignore` automatically on success.
3. Run `gbrain storage status` to see the tier breakdown and any missing `db_only` files.
4. If files are missing on disk (e.g., after a container restart): `gbrain export --restore-only --repo /path/to/brain`.
5. If you previously had `git_tracked` / `supabase_only` keys: they still load, with a once-per-process deprecation warning. Rename to `db_tracked` / `db_only` at your convenience.
6. On PGLite: tiering has limited effect (the "DB" is your local file). The `.gitignore` housekeeping still helps. A one-time soft-warn explains.

If anything looks off, file an issue at <https://github.com/garrytan/gbrain/issues> with `gbrain doctor` output and the contents of your `gbrain.yml`.

### Itemized changes

#### Critical fixes

- **YAML parser swap**: replaced `gray-matter` with a dedicated YAML reader for the `gbrain.yml` shape. The original code called `matter()` on a delimiter-less file, which always returned `{data: {}}` — `loadStorageConfig` returned null on every install. The dedicated parser handles top-level `storage:` plus nested array-valued keys, with comment + blank-line tolerance. Once-per-process sanity warning when `gbrain.yml` exists but has no `storage:` section.
- **`manageGitignore` actually runs now**: wired into `runSync` after every successful sync (skipped on dry-run, blocked-by-failures, and unhandled errors). Idempotent. Detects git submodule context (`.git` is a file, not a directory) and skips with an actionable warning. Honors `GBRAIN_NO_GITIGNORE=1` for shared-repo setups.
- **No more silent `--restore-only` footgun**: `gbrain export --restore-only` without `--repo` now resolves through a typed `getDefaultSourcePath()` accessor (sources table → null → hard error). Never falls through to the current directory. Never silently re-exports your entire database into the wrong place.

#### New + renamed surface

- **Canonical key names**: `db_tracked` / `db_only` replace the vendor-baked `git_tracked` / `supabase_only`. The deprecated keys still load, with a once-per-process warning suggesting `gbrain doctor --fix` for an automated rename. Canonical wins when both shapes coexist.
- **Engine-side `slugPrefix` filter**: `PageFilters.slugPrefix` lands on both engines as `WHERE slug LIKE prefix || '%'` with literal-escape of LIKE metacharacters. Uses the existing `(source_id, slug)` UNIQUE btree index for range scans. Powers `gbrain export --restore-only` per-tier queries and `gbrain export --slug-prefix`.
- **Single-walk filesystem scan**: `src/core/disk-walk.ts` exposes `walkBrainRepo(repoPath)` that returns `Map<slug, {size, mtimeMs}>` from one recursive `readdirSync`. Replaces the per-page `existsSync + statSync` loop in `gbrain storage status` (~400K syscalls on a 200K-page brain → tens).
- **Path-segment matching**: tier directory matcher requires trailing `/` and treats the slash as a path separator. `media/x/` does not match `media/xerox/foo`. Validator (`normalizeAndValidateStorageConfig`) auto-fixes missing trailing `/`, throws `StorageConfigError` on tier overlap.

#### Architecture cleanup

- `src/commands/storage.ts` split into pure data + JSON formatter + human formatter + thin dispatcher, matching the `orphans.ts` precedent. `getStorageStatus` is exported for `gbrain doctor` integration. ASCII-only output (no unicode box-drawing) for cross-platform terminal compatibility.
- Distinct nominal types `PageCountsByTier` and `DiskUsageByTier` so accidental swaps between page counts and byte totals are compile-time errors.
- PGLite soft-warn on storage tiering (D4): the feature is partial on PGLite (the "DB" is your local file), but `.gitignore` housekeeping still helps. Once-per-process warning explains and proceeds.

#### Tests + CI guards

- New unit tests across `test/storage-config.test.ts`, `test/storage-sync.test.ts`, `test/storage-status.test.ts`, `test/storage-export.test.ts`, `test/storage-pglite.test.ts`, `test/disk-walk.test.ts`. Plus extensions to `test/source-resolver.test.ts` and `test/pglite-engine.test.ts`. The single-line test that would have caught the original gray-matter P0 (write a real `gbrain.yml`, call `loadStorageConfig`, assert non-null) now exists.
- New CI guard `scripts/check-trailing-newline.sh` (sibling to the existing jsonb-pattern + progress-to-stdout guards). Wired into `bun run test`. Fixed pre-existing missing newline in `docs/storage-tiering.md`.

### For contributors

- The eng-review path forward is documented in `~/.claude/plans/lets-take-a-look-ticklish-pizza.md` (15 numbered defects + D1-D8 abstraction calls). Every commit on this branch maps to one numbered step in the plan.

## [0.22.10] - 2026-04-30

**`gbrain jobs submit autopilot-cycle --params '{"phases":["lint","backlinks"]}'` now actually runs only those phases.**

If you ever submitted an `autopilot-cycle` job with a `phases:` array hoping to skip embed for a fast cycle, you got the full 6-phase cycle anyway. The handler in `src/commands/jobs.ts` was calling `runCycle(...)` without forwarding `job.data.phases`, so per-cycle phase selection was silently ignored.

This release wires the array through. The handler imports `ALL_PHASES` from `src/core/cycle.ts`, builds a `Set` for O(1) validation, and filters the caller's `phases` array against it before forwarding to `runCycle`. Invalid phase names get dropped (no injection surface — `ALL_PHASES` is the authoritative list). Empty arrays and non-array values fall back to the default (run all phases), preserving the prior behavior for callers who didn't ask for selective phases.

### What this means for you

If you've been using `gbrain jobs submit autopilot-cycle --params '{"phases":[...]}'` for triage cycles (e.g. `["lint","backlinks"]` for a fast structural sweep, skipping the slow embed phase), you'll now see those cycles take seconds instead of minutes. The CLI surface didn't change — only the worker's handler now respects the `phases` it was already accepting.

### Itemized changes

#### Fixed

- `autopilot-cycle` minion handler in `src/commands/jobs.ts` now forwards `job.data.phases` to `runCycle()`. Previously the handler accepted the array via `MinionJobInput.params` but discarded it before dispatch.
- Phase names validated against `ALL_PHASES` from `src/core/cycle.ts`. Filter is exhaustive: array → filtered, non-array → undefined (default), filtered-to-empty → no `phases` key in opts (also default).

#### Tests

- 4 new test cases in `test/handlers.test.ts` under `autopilot-cycle handler — phase passthrough`: valid phases forwarded, invalid names filtered, empty array falls back to all-phases, non-array `phases` value ignored. Pin both the contract and the fallback semantics.
- `test/cycle-abort.test.ts` regression-guard window widened from 500 → 2000 chars so the source-level `signal: job.signal` check finds the line after the new validation block was added between `worker.register('autopilot-cycle', ...)` and the `runCycle(...)` call. Pure test fix; the handler still propagates the abort signal correctly.

## [0.22.9] - 2026-04-29

**Sync failures now tell you why, not just how many.**
**`gbrain sync --skip-failed` and `gbrain doctor` group failures by error code, so 2,685 silent SLUG_MISMATCH files don't hide behind a single count.**

Before this release, when sync hit per-file parse errors the only signal was a number:

```
Sync blocked: 2688 file(s) failed to parse. Fix the YAML frontmatter...
```

That count is useless when you're staring at 2,688 files and don't know what's wrong. On a real 81K-page brain, 2,685 of those turned out to be `SLUG_MISMATCH` from a posterous import — a single root cause hiding behind a giant number. It took manual `cat ~/.gbrain/sync-failures.jsonl | jq` to figure that out.

After:

```
Sync blocked: 2688 file(s) failed to parse:
  SLUG_MISMATCH: 2685
  YAML_DUPLICATE_KEY: 3

Fix the YAML frontmatter in the files above and re-run, or use 'gbrain sync --skip-failed' to acknowledge and move on.

# gbrain sync --skip-failed
Acknowledged 2688 failure(s) and advancing past them:
  SLUG_MISMATCH: 2685
  YAML_DUPLICATE_KEY: 3
```

`gbrain doctor` shows the same breakdown for unacknowledged AND historical entries:

```
[WARN] sync_failures: 2688 unacknowledged sync failure(s) [SLUG_MISMATCH=2685, YAML_DUPLICATE_KEY=3].
[OK]   sync_failures: 500544 historical sync failure(s), all acknowledged [SLUG_MISMATCH=2685, ...].
```

The classifier knows the canonical messages from `collectValidationErrors()` in `src/core/markdown.ts` (8 frontmatter codes), Postgres unique-constraint violations (`DB_DUPLICATE_KEY`), statement-timeout errors (`STATEMENT_TIMEOUT`), invalid UTF-8, and YAML duplicates. DB-layer errors check before YAML-layer ones — so a Postgres `duplicate key value violates unique constraint` no longer mislabels as a YAML duplicate. Unrecognized errors fall through to `UNKNOWN`.

### What this means for you

If `gbrain sync` blocks with parse failures, the breakdown tells you what to fix first. SLUG_MISMATCH is one fix-pattern (frontmatter says one slug, path says another); YAML_PARSE is a different one (malformed YAML); STATEMENT_TIMEOUT means a DB timeout, not a parse problem. You stop staring at counts and start fixing root causes.

### For contributors

`acknowledgeSyncFailures()` in `src/core/sync.ts` now returns `{count, summary}` instead of `number`. If you import this directly from `gbrain/sync`, replace `n` with `result.count` and use `result.summary` (an `Array<{code, count}>`) for the new code-grouped breakdown. The function is reachable via the package exports map; this is a deliberate, non-shimmed breaking change. There is a new `formatCodeBreakdown()` helper in the same module that accepts either raw failures or pre-summarized input — use it instead of building breakdown strings inline.

### Itemized changes

#### Added

- `classifyErrorCode(errorMsg)` in `src/core/sync.ts` — best-effort error-code extraction from sync failure messages. Codes: `SLUG_MISMATCH`, `YAML_PARSE`, `YAML_DUPLICATE_KEY`, `MISSING_OPEN`, `MISSING_CLOSE`, `EMPTY_FRONTMATTER`, `NULL_BYTES`, `NESTED_QUOTES`, `DB_DUPLICATE_KEY`, `STATEMENT_TIMEOUT`, `INVALID_UTF8`, `UNKNOWN`.
- `summarizeFailuresByCode(failures)` — groups failures by code and returns a sorted `Array<{code, count}>`.
- `formatCodeBreakdown(input)` — renders a multi-line `code: count` string from either raw failures or a pre-computed summary. Single helper, two input shapes.
- `code?: string` field on the `SyncFailure` JSONL row in `~/.gbrain/sync-failures.jsonl`. Populated at write-time so the classifier runs once per failure, not on every load.
- `AcknowledgeResult` interface as the new return shape of `acknowledgeSyncFailures()`.
- 15 new test cases in `test/sync-failures.test.ts`: DB-vs-YAML duplicate-key disambiguation, canonical-message coverage for all 7 frontmatter codes, `acknowledgeSyncFailures()` legacy-entry backfill branch, `formatCodeBreakdown()` dual-input shape.

#### Changed

- `gbrain sync` blocked-message: now lists code breakdown above the fix instructions (both incremental and full-sync paths).
- `gbrain sync --skip-failed` ack message: now lists what was skipped, grouped by code.
- `gbrain doctor` `sync_failures` check: warn-and-ok messages both include `[code=count, ...]` breakdown.
- `recordSyncFailures()` now stores `code` alongside `error` so downstream readers don't re-classify.
- `acknowledgeSyncFailures()` backfills `code` on legacy rows that predate the field — upgrade-safe for users with existing `~/.gbrain/sync-failures.jsonl`.
- DB-layer error patterns (`DB_DUPLICATE_KEY`, `STATEMENT_TIMEOUT`) check BEFORE YAML patterns in the classifier, so Postgres errors don't get YAML-labeled.
- Frontmatter regex patterns rewritten to match canonical messages from `collectValidationErrors()` (`File is empty...`, `No closing --- delimiter found`, `Frontmatter block is empty`) instead of aspirational code-token strings (`missing.*open`) that never appeared in practice.

Closes #500. Eng-review plan: `~/.claude/plans/then-codex-synchronous-toucan.md` (codex outside-voice agreed on all 7 findings).

## [0.22.8] - 2026-04-28

## **Doctor stops timing out on Supabase. Integrity scan finishes in ~6s, multi-source brains get correct counts.**

If you've been hitting the 60-second `gbrain doctor` timeout on Supabase or any pooled-connection deployment, this fixes it. The integrity check used to call `getPage()` 500 times sequentially through PgBouncer transaction-mode pooling. Each call required a full connection acquire/release cycle, which doctor couldn't finish before CI killed it. The new path batch-loads all 500 pages in a single SQL query, finishing in ~6s.

While shipping the perf fix, codex review caught a correctness regression for multi-source brains: the batch SQL was scanning raw `(source_id, slug)` rows while the sequential path scanned unique slugs. Multi-source brains were getting inflated counts. `SELECT DISTINCT ON (slug)` mirrors the sequential path's `Set<string>` semantics; parity tests against real Postgres pin both paths to the same output.

Plus a Linux CI fix: `gbrain skillpack` lockfile checks were intermittently failing on ext4's sub-millisecond `mtimeMs` timestamps when `Date.now()` returned an integer ms behind the file's recorded mtime. Lock age now clamps to zero.

### The numbers that matter

Measured against the real failure mode on a Supabase PgBouncer deployment that hit the 60s CI timeout pre-fix.

| Behavior | Before v0.22.8 | After v0.22.8 |
|---|---|---|
| `gbrain doctor` wall-clock (Postgres + PgBouncer) | 60s+ timeout (killed) | ~6s |
| `integrity_sample` query round-trips | ~500 (sequential `getPage`) | 1 (`SELECT DISTINCT ON`) |
| Multi-source brain scan accuracy | Overcounted by `source_id` | Exact per unique slug |

### What this means for Supabase deployments

If you've been avoiding `gbrain doctor` because it timed out, run it again. If you maintain a multi-source brain (imported pages from another gbrain deployment under a non-default `source_id`), the scan now treats each slug once instead of once-per-source — your output is exact, not inflated. Single-source users see no behavior change; PGLite users were never affected (the batch path is Postgres-only).

## To take advantage of v0.22.8

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about anything afterwards:

1. **Run the upgrade:**
   ```bash
   gbrain upgrade
   ```
2. **Verify doctor finishes cleanly (especially relevant if you hit timeouts before):**
   ```bash
   gbrain doctor
   ```
   On Postgres + PgBouncer deployments, you should see `integrity_sample` finish in ~6s instead of timing out at 60s.
3. **If `doctor` still times out or output looks wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor` (full)
   - which engine (Postgres vs PGLite)
   - whether you use multi-source brains

### Itemized changes

#### Performance
- `gbrain doctor` integrity sample now batch-loads via a single SQL query on Postgres deployments (60s+ timeout → ~6s wall-clock, 500 round-trips → 1).
- Batch path explicitly gated to Postgres via `engine.kind` so PGLite never attempts it (clean fallback signal).

#### Correctness
- `scanIntegrity` batch path uses `SELECT DISTINCT ON (slug)` to scope by unique slug, matching `engine.getAllSlugs()`'s `Set<string>` semantics. Multi-source brains (UNIQUE(source_id, slug) since v0.18.0) now get correct counts instead of one-scan-per-source-row.
- `IntegrityScanResult.pagesScanned` now reflects unique slugs scanned, not raw row count. Single-source brains: unchanged. Multi-source brains: counts now match expected distinct-page semantics.
- Batch-path fallback narrowed: real Postgres errors (deadlock, connection drop, SQL bug) surface via `GBRAIN_DEBUG=1` instead of being silently swallowed.

#### Tests
- New `test/e2e/integrity-batch.test.ts` — four parity cases (dedup, hits, validate, topPages) asserting batch ≡ sequential against real Postgres. Pinning the multi-source dedup case requires a raw-SQL fixture for the alt-source row since `engine.putPage` doesn't take a `source_id`.

#### Infrastructure
- `src/core/skillpack/installer.ts` — clamp negative lock-age to 0, fixing intermittent Linux ext4 CI flakes from sub-millisecond `mtimeMs` precision (Date.now is integer ms; mtime can be ~0.3ms ahead). New regression test in `test/skillpack-install.test.ts` deterministically reproduces via `utimesSync`.
- `CLAUDE.md` test inventory updated for the new test files.

## [0.22.7] - 2026-04-28

## **Built-in HTTP transport with bearer auth for remote MCP.**
## **Postgres-backed tokens, default-deny CORS, two-bucket rate limit, body cap, per-request audit.**

v0.22.7 ships `gbrain serve --http`: a built-in HTTP transport for remote MCP, authenticating via the existing `access_tokens` table that `gbrain auth create/list/revoke` already manages. Bearer-only, no OAuth surface, no registration endpoint, no self-service tokens. SECURITY.md is the canonical reference for the hardening posture and recommended deployment.

The hardening lives inside the transport, not in the doc:

| Layer | Default | Configurable via |
|---|---|---|
| CORS | default-deny (no `Access-Control-Allow-Origin`) | `GBRAIN_HTTP_CORS_ORIGIN=a.com,b.com` |
| Pre-auth IP rate limit | 30 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| Post-auth token rate limit | 60 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| Body cap | 1 MiB, stream-counted | `GBRAIN_HTTP_MAX_BODY_BYTES` |
| `last_used_at` debounce | once per token per 60s | (SQL-level WHERE clause, race-tolerant) |
| Per-request audit | `mcp_request_log` row per `/mcp` | (existing schema, since v4) |
| Reverse-proxy trust | off | `GBRAIN_HTTP_TRUST_PROXY=1` to honor X-Forwarded-For |

The IP rate-limit fires **before** the auth lookup so the limit caps load on the auth path itself, not just response codes. The token-id rate limit fires after auth so a runaway authenticated client gets throttled at the right principal. Both buckets live in a bounded LRU map (default 10K keys, TTL prune at 2× window) so unique-key growth can't drift into memory pressure.

### What changed for users

You can now expose GBrain remotely with the built-in transport:

```bash
gbrain auth create my-laptop                    # tokens managed via the existing CLI
gbrain serve --http --port 8787                  # Postgres-only; PGLite users see a clear fail-fast
ngrok http 8787 --url your-brain.ngrok.app       # any tunnel works
```

Then point Claude Desktop, claude.ai/code, or any MCP client at `http://your-tunnel/mcp` with `Authorization: Bearer <token>`. CORS, rate limits, and body caps are on by default. `gbrain auth` is now wired into the main CLI, so it works from the compiled binary the same as `gbrain doctor` or `gbrain serve`.

### For contributors

- `src/mcp/dispatch.ts` (new) — shared `dispatchToolCall(engine, name, params, opts)` consumed by both stdio (`server.ts`) and HTTP (`http-transport.ts`). One source of truth for `validateParams`, `OperationContext` construction, and handler invocation, so the two transports can't drift apart.
- `src/mcp/rate-limit.ts` (new) — bounded-LRU token-bucket. Tracks `lastTouchedMs` separately from `lastRefillMs` so an exhausted key can't be reset by hammering past the TTL.
- `src/mcp/http-transport.ts` — built on the new dispatch + rate-limit modules. `application/json` response shape (gbrain MCP tools are synchronous; the Streamable HTTP transport spec allows JSON for non-streaming responses).
- `src/cli.ts` + `src/commands/auth.ts` — `auth` is now a wired CLI subcommand. Direct-script usage (`bun run src/commands/auth.ts ...`) still works for environments without a compiled binary.
- 23 unit cases in `test/http-transport.test.ts`, 8 E2E cases in `test/e2e/http-transport.test.ts`. Unit covers the full dispatch round-trip with a real operation; E2E covers `last_used_at` debounce against real Postgres semantics.

### Known limits

- `gbrain serve --http` is **Postgres-only**. PGLite has no `access_tokens` or `mcp_request_log` table by design (`src/core/pglite-schema.ts:5-6`). Local agents continue to use stdio (`gbrain serve`).
- Behind a tunnel (ngrok, Tailscale Funnel, Cloudflare Tunnel), all requests share one egress IP. The pre-auth IP bucket becomes effectively shared by all clients on that tunnel; the token-id bucket is the load-bearing limiter for tunnel deployments. Documented in SECURITY.md.

### Itemized changes

- New: `gbrain serve --http [--port N]` ships the built-in HTTP transport
- New: `gbrain auth create/list/revoke/test` wired into the main CLI (was a standalone script)
- New: SECURITY.md documents the disclosure path, the recommended remote-MCP setup, and the full hardening reference
- New: `src/mcp/dispatch.ts` — shared dispatch path for stdio + HTTP
- New: `src/mcp/rate-limit.ts` — bounded-LRU token-bucket limiter
- Hardening: CORS default-deny, two-bucket rate limit (per-IP pre-auth + per-token post-auth), 1 MiB body cap with stream-counted enforcement, `mcp_request_log` per-request audit, `last_used_at` SQL-level debounce
- Tests: 23 unit + 8 E2E covering auth, dispatch, CORS, body cap, rate limit, and audit
- Docs: SECURITY.md, DEPLOY.md, and per-client setup guides updated to recommend `--http` and document the env vars

## To take advantage of v0.22.7

`gbrain upgrade` should do this automatically. If it didn't, or if you want to expose your brain over HTTP:

1. **Confirm migrations are at v4 or higher** (the `access_tokens` + `mcp_request_log` tables were added in migration v4):
   ```bash
   gbrain doctor              # schema_version check should pass
   gbrain apply-migrations --yes  # if not, run this
   ```
2. **Create a token for each remote client:**
   ```bash
   gbrain auth create my-laptop     # prints the token once — copy it
   ```
3. **Start the HTTP server:**
   ```bash
   gbrain serve --http --port 8787
   ```
4. **(Optional) configure CORS allowlist if a browser client will hit it:**
   ```bash
   GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
   ```
5. **(Optional) audit who's hitting your brain:**
   ```bash
   psql $DATABASE_URL -c "SELECT created_at, token_name, operation, status, latency_ms
                          FROM mcp_request_log ORDER BY created_at DESC LIMIT 50"
   ```
6. **If `gbrain serve --http` exits with "Postgres engine required":** PGLite is local-only by design. Either keep using stdio (`gbrain serve`) for local agents, or migrate to Postgres (`gbrain migrate --to supabase`).

If anything breaks: `gbrain doctor`, `~/.gbrain/upgrade-errors.jsonl` (if present), and please file an issue at https://github.com/garrytan/gbrain/issues with both.



## [0.22.6.1] - 2026-04-26

**Old brains can upgrade again.**
**Two-year, ten-issue wedge cycle ends. Pre-v0.13/v0.18/v0.19 brains all upgrade clean.**

If you've been pinned to an older gbrain because `gbrain upgrade` wedges your brain
with `column "source_id" does not exist` or `column "link_source" does not exist`,
v0.22.6.1 unblocks you. The fix lives in `initSchema()` itself, where it should
have lived all along.

The bug class is structural: gbrain ships an "embedded latest schema" SQL blob
that runs before numbered migrations on every connect. The blob references
columns that newer migrations introduce. On any brain older than the migration
that adds those columns, the blob crashes before the migration can run. This
incident family hit users 10+ times across 6 schema versions over 2 years
(issues #239, #243, #266, #357, #366, #374, #375, #378, #395, #396).

The fix is a narrow pre-schema bootstrap. `initSchema()` now probes for the
specific forward-referenced state the schema blob needs (`pages.source_id`,
`links.link_source`, `links.origin_page_id`, `content_chunks.symbol_name`,
`content_chunks.language`, plus the `sources` FK target table) and adds only
that state if missing. Then SCHEMA_SQL replays cleanly. Then the normal
migration chain runs as usual. Fresh installs and modern brains both no-op.

A test guard prevents this incident family from recurring. Every future
migration that adds a column-with-index to PGLITE_SCHEMA_SQL must extend the
bootstrap; the CI guard fails loudly if not. The pattern that broke gbrain ten
times in two years is now structurally prevented.

Also includes the v24 PGLite RLS fix from #395 (community PR by @jdcastro2):
`rls_backfill_missing_tables` now no-ops on PGLite via `sqlFor.pglite: ''`,
since PGLite has no RLS engine and is single-tenant by definition.

### The numbers that matter

| Metric | v0.22.0 | v0.22.6.1 | Δ |
|---|---|---|---|
| Pre-v0.13 brain upgrades cleanly | wedges on `link_source` | passes | ✓ |
| Pre-v0.18 brain upgrades cleanly | wedges on `source_id` | passes | ✓ |
| Pre-v0.21 brain upgrades cleanly | wedges on `symbol_name` | passes | ✓ |
| v24 RLS migration on PGLite | wedges (table doesn't exist) | no-op | ✓ |
| Issues closed | — | #366, #375, #378, #395, #396 | 5 |
| Issue families resolved | — | wedge-cycle | the whole class |

### What this means for you

If you've been on v0.13.x, v0.14.x, v0.17.x, v0.18.x, v0.19.x, v0.20.x, or v0.22.0 and
your `gbrain upgrade` failed, run it again. It should walk to v0.22.6.1 cleanly.
If you wedged on the v24 RLS migration on a PGLite brain, the same thing.

If you're on a fresh install or already on v0.22.0, this patch is invisible.
The bootstrap probe runs once per connect, sees nothing to do, and returns.

### Itemized changes

#### Fixed
- `gbrain upgrade` no longer wedges on pre-v0.18 brains that lack `pages.source_id`. The schema blob's `CREATE INDEX idx_pages_source_id` previously crashed before migration v21 could add the column. Closes #366, #375, #378, #396.
- `gbrain upgrade` no longer wedges on pre-v0.13 brains that lack `links.link_source` or `links.origin_page_id`. The schema blob's `CREATE INDEX idx_links_source/origin` previously crashed before migration v11 could add the columns. Closes #266, #357.
- `gbrain upgrade` no longer wedges on pre-v0.19 brains that lack `content_chunks.symbol_name` or `content_chunks.language`. The schema blob's partial indexes previously crashed before migration v26 could add the columns.
- Migration v24 (`rls_backfill_missing_tables`) no-ops on PGLite via `sqlFor.pglite: ''`. PGLite has no RLS engine and is single-tenant. The migration previously tried to ALTER subagent tables that don't exist in pglite-schema.ts. Closes #395. Contributed by @jdcastro2.

#### Changed
- `PGLiteEngine.initSchema()` and `PostgresEngine.initSchema()` now call a new private `applyForwardReferenceBootstrap()` before running the embedded schema blob. The bootstrap probes for missing forward-referenced state and adds only what's needed. No-op on fresh installs and modern brains.

#### For contributors
- New CI guard `test/schema-bootstrap-coverage.test.ts` enforces that `applyForwardReferenceBootstrap` covers every forward reference in PGLITE_SCHEMA_SQL. When you add a new column-with-index in the schema blob, extend `REQUIRED_BOOTSTRAP_COVERAGE` and the bootstrap function. The test fails loudly if you skip step one.
- New `test/bootstrap.test.ts` covers the bootstrap contract: no-op on fresh install, idempotent, no-op on modern brain, full path pre-v0.18, fresh-install regression, pre-v0.13 links shape.
- New `test/e2e/postgres-bootstrap.test.ts` exercises `PostgresEngine.initSchema()` directly (not the standalone `db.initSchema` from `src/core/db.ts`, which only runs SCHEMA_SQL and would have produced false-positive coverage). Codex caught this E2E shape gap during plan review.
- Wave PRs incorporated with attribution: @vinsew (#398), @jdcastro2 (#399), @schnubb-web (#402). The narrow-bootstrap shape supersedes #402's broader "run all migrations early" approach, which would have crashed on v24 trying to alter tables that the schema blob hadn't created yet (codex finding during plan review).

## To take advantage of v0.22.6.1

`gbrain upgrade` should do this automatically. If you're currently wedged on a
prior version's upgrade attempt:

1. **Run the upgrade:**
   ```bash
   gbrain upgrade
   ```
2. **Verify the outcome:**
   ```bash
   gbrain doctor
   ```
   Expected: `schema_version: Version 29 (latest: 29)` clean, no
   `column "..." does not exist` errors, no wedged migration ledger.

3. **If wedged after upgrade,** run the migration runner directly:
   ```bash
   gbrain apply-migrations --yes
   ```

4. **If any step still fails,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - your prior gbrain version (`gbrain --version`)
   - which step broke

## [0.22.6] - 2026-04-28

### Schema verification after migrations

- Post-migration schema verification catches columns that were defined in migrations but silently failed to create (common with PgBouncer transaction-mode poolers).
- Self-healing: automatically adds missing columns via ALTER TABLE when detected.
- Prevents the "column X does not exist" embed failures that occur when schema version is ahead of actual table state.

## [0.22.5] - 2026-04-27

## **Autopilot stops re-importing your whole brain when a commit gets garbage-collected.**
## **Cycle reads the per-source `sources.last_commit` anchor instead of the drift-prone global key.**

`gbrain dream` and the `autopilot-cycle` worker were calling `performSync()` without `sourceId`, so sync read the global `config.sync.last_commit` key. When that commit gets GC'd from git history (a force push, a squash, an `--amend` chain), `git cat-file -t <anchor>` fails, sync concludes "force push happened," and triggers a full reimport of every page. On a 78K-page brain that's ~30 minutes per cycle, the autopilot job hits its timeout, dead-letters, and the next cron tick does it again. Production OpenClaw deployment hit exactly this pattern: every cycle ran the full reimport while the per-source `sources.last_commit` (`00a62e50`) was a valid HEAD ancestor the entire time.

v0.22.5 threads `sourceId` through the cycle. `runPhaseSync()` now resolves the brain directory against the `sources` table (`SELECT id FROM sources WHERE local_path = $1`) and passes the result to `performSync()`. When a source row matches, sync reads `sources.last_commit` (per-source, always written back on every successful sync). When no row matches (pre-v0.18 brain or never-registered path), it falls through to the global key ... fully backward compatible. Six new regression tests pin the resolver behavior, including the table-missing fallback for old brains and the empty-string-id defensive case.

### The numbers that matter

Production behavior on a 78,797-page brain:

| Metric | Pre-v0.22.5 (master) | v0.22.5 | Δ |
|---|---|---|---|
| Autopilot cycle wall time (steady state) | 30+ min (then timeout) | <1 sec | -1800x |
| Files re-imported per cycle (steady state) | 78,797 | 0 | -78,797 |
| `autopilot-cycle` jobs hitting `max_stalled` | every cycle | 0 | -100% |
| Cycle phases that consult per-source anchor | 0 | 1 (sync) | +1 |
| New regression tests in `test/core/cycle.test.ts` | n/a | 6 | +6 |

Resolver behavior matrix (every row covered by a test):

| Scenario | sourceId passed | Anchor read from | Backward compatible |
|---|---|---|---|
| Sources row matches `brainDir` (current install) | `"default"` | `sources.last_commit` ✅ | Yes |
| No sources row (pre-v0.18 brain) | `undefined` | `config.sync.last_commit` | Yes |
| `sources` table doesn't exist (very old brain) | `undefined` (catch) | `config.sync.last_commit` | Yes |
| Multiple rows share a `local_path` (no UNIQUE) | one of the matching ids (non-deterministic) | the matched row's anchor | Yes |
| Empty-string id row | `""` (defensive ... won't happen in practice) | empty-string source row | Yes |

### What this means for builders

If your brain has been silently doing a full reimport every autopilot cycle, `gbrain upgrade` plus your next cycle will fix it ... no manual action needed. The fix is mechanical and idempotent. If you've been running with the operational band-aid that copied the per-source anchor to the global key every 5 minutes (the pre-PR workaround), you can take it out after upgrading. Two follow-ups are filed for v0.23: a `UNIQUE` index on `sources.local_path` so duplicate-path resolution is deterministic, and narrowing the resolver's bare `catch` to PostgreSQL's `42P01` (undefined_table) so real DB errors don't get silently swallowed into the global-fallback path.

## To take advantage of v0.22.5

`gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`. v0.22.5 has no schema migration ... the fix is pure code, no data backfill ... so the upgrade itself is the entire action.

1. **Upgrade:**
   ```bash
   gbrain upgrade
   ```

2. **Verify the next autopilot cycle is fast.** Either let `gbrain autopilot` tick naturally, or run one cycle directly:
   ```bash
   gbrain dream --phase sync --json | jq '.phases[] | select(.phase == "sync")'
   ```
   On a brain with a registered source, the sync phase should report incremental status (`up_to_date` or a small added/modified count) and complete in seconds. If it reports thousands of files added/modified on a brain you haven't actually changed, file an issue ... the resolver isn't matching your `brainDir` to a `sources.local_path` (likely a path-normalization mismatch ... see TODO 1 below).

3. **Optional ... confirm the resolver matched.** The `sources` row used by `gbrain dream` should match your brain directory exactly:
   ```bash
   gbrain query 'SELECT id, local_path FROM sources' --json
   ```
   If the path stored in `sources.local_path` differs from the directory `gbrain dream --dir <path>` is invoked with (trailing slash, symlink resolution), v0.22.5 will fall back to the legacy global-key path silently for that source. A future v0.23 fix will normalize both sides; for now you can re-register the source with the canonical absolute path.

4. **If any step fails or the numbers look wrong,** file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**Hotfix.** `src/core/cycle.ts` ... new `resolveSourceForDir(engine, brainDir)` helper queries `SELECT id FROM sources WHERE local_path = $1 LIMIT 1`. `runPhaseSync()` calls it before `performSync()` and threads the result as `sourceId`. Bare `try/catch` swallows missing-table errors so pre-v0.18 brains keep working unchanged. 26 new lines, one file. The fix funnels into the existing `readSyncAnchor()` branching at `src/commands/sync.ts:174-188`, which already chose between per-source and global anchors when given a `sourceId`; the cycle just wasn't passing one.

**Tests.** 6 new test cases in `test/core/cycle.test.ts` covering every branch of the resolver:
- **Test 1** ... seeded `sources` row → `performSync` receives matching `sourceId`.
- **Test 2** ... no row → `sourceId=undefined`, falls through to global key.
- **Test 3** ... different `brainDir` than registered source → undefined (no cross-match).
- **Test 4** ... `sources` table missing (very old brain) → catch returns undefined, sync still runs. Uses a fresh `PGLiteEngine` (not the shared one) because `initSchema()` only re-runs PENDING migrations; `DROP TABLE` on the shared engine would have left it permanently degraded for every subsequent test in the file. Codex review caught this landmine.
- **Test 5** ... duplicate `local_path` rows → resolver returns one of the matching ids (non-deterministic; the SQL has no `ORDER BY`). Documents the contract for the v0.23 UNIQUE-constraint follow-up.
- **Test 6** ... empty-string id row → resolver propagates `""` (defensive case Codex flagged ... PK prevents NULL but `''` can be inserted).

The `performSync` mock in `test/core/cycle.test.ts:50-65` was extended to capture `sourceId` alongside the existing `dryRun / noPull / noExtract` opts. The new `describe` block runs after the existing 22 tests; the shared PGLite engine cleanup pattern (`DELETE FROM sources` in `beforeEach`) keeps state from leaking between tests.

### For contributors

When threading new options through `runCycle → runPhaseSync → performSync`, extend the `syncCalls` capture shape in `test/core/cycle.test.ts:20` and add per-option assertions to the existing `describe('runCycle — dryRun propagates...')` and `describe('runCycle — phase selection')` blocks. The `cycle.test.ts` shared-engine pattern is fast (~1.4s for 28 tests on PGLite in-memory) but `initSchema()` only runs PENDING migrations ... if your test needs to mutate the schema mid-suite (DROP TABLE, ALTER, etc.), spin up a fresh `PGLiteEngine` and dispose in `finally` instead of touching the shared engine. The v0.22.5 test 4 is the canonical example.

The bare `catch` in `resolveSourceForDir` is intentional for v0.22.5 because narrowing to a PG-specific error code (`error.code === '42P01'`) requires engine-aware error introspection that the existing PGLite engine doesn't expose uniformly with postgres-engine. v0.23 will add a small `isMissingRelationError(error, engine.kind)` helper to `src/core/utils.ts` and the resolver will rethrow everything else.

## [0.22.4] - 2026-04-26

## **Frontmatter-guard ships. Broken brain pages can't hide.**
## **Seven validation classes, source-aware audit, doctor subcheck, pre-commit hook, zero resolver warnings.**

v0.22.4 fixes the seven `gbrain check-resolvable` warnings that lived on master and ships frontmatter-guard as a real feature: a TypeScript validator inside `parseMarkdown(..., {validate:true})`, a top-level `gbrain frontmatter` CLI (`validate` / `audit` / `install-hook`), a new `frontmatter_integrity` subcheck under `gbrain doctor`, and an audit-only migration that surveys every registered source and queues per-source TODOs without mutating brain content. PR #392's aspirational `lib/brain-writer.mjs` is finally written, in TypeScript, on top of the tools gbrain already ships.

The migration is **audit-only**. It writes a JSON report to `~/.gbrain/migrations/v0.22.4-audit.json` and emits per-source entries to `pending-host-work.jsonl` with the exact fix command. It never silently rewrites your brain pages. The agent reads `skills/migrations/v0.22.4.md` after upgrade, surfaces the counts to you, and runs `gbrain frontmatter validate <source-path> --fix` only with explicit consent. `--fix` writes `.bak` backups for every modified file (the safety contract for non-git brain repos, which `getWorkingTreeStatus` rejects).

`gbrain frontmatter` is source-aware throughout. `audit [--source <id>]` walks every registered source via `source-resolver.ts` (gbrain has been multi-source since v0.18.0; the single-`brainRoot` model would have shipped a half-broken feature). The CLI, doctor subcheck, and migration phase all call into one shared `scanBrainSources()` ... single source of truth for what counts as malformed.

### The numbers that matter

Counted against gbrain's own checked-in `skills/` tree:

| Metric | Pre-v0.22.4 (master) | v0.22.4 | Δ |
|---|---|---|---|
| `gbrain check-resolvable` warnings | 7 | 0 | -7 |
| Frontmatter validation classes | 3 (in `lint`) | 7 (in `parseMarkdown`) | +4 |
| Auto-fixable error codes | 0 | 4 (NULL_BYTES, MISSING_CLOSE, NESTED_QUOTES, SLUG_MISMATCH) | +4 |
| Doctor subchecks | 17 | 18 (+frontmatter_integrity) | +1 |
| `gbrain frontmatter` subcommands | 0 | 3 (validate, audit, install-hook) | +3 |
| Skills in `skills/` | 29 | 30 (+frontmatter-guard) | +1 |
| Pre-commit hook helper | none | `gbrain frontmatter install-hook` | ✓ |
| Source-aware audit | n/a | walks every registered source | ✓ |

Frontmatter validation surface (the 7 codes shipped):

| Code | What it catches | Auto-fix |
|---|---|---|
| `MISSING_OPEN` | File doesn't start with `---` | No (human review) |
| `MISSING_CLOSE` | No closing `---` before first heading | Yes ... inserts `---` |
| `YAML_PARSE` | YAML failed to parse | Sometimes |
| `SLUG_MISMATCH` | Frontmatter `slug:` differs from path-derived slug | Yes ... removes field |
| `NULL_BYTES` | Binary corruption (`\x00`) | Yes ... strips bytes |
| `NESTED_QUOTES` | `title: "outer "inner" outer"` shape | Yes ... switches outer to single quotes |
| `EMPTY_FRONTMATTER` | Open + close present, nothing meaningful between | No (human review) |

### What this means for builders

If you've been ignoring `gbrain check-resolvable` warnings because the messages were misleading (the action message said "Add disambiguation rule in RESOLVER.md OR narrow triggers" ... but only the second branch actually silenced the MECE warning, since the checker doesn't parse RESOLVER.md disambiguation rules), v0.22.4 closes the loop. Trigger overlap is fixed at the frontmatter layer. `enrich/SKILL.md` delegates citation rules to `conventions/quality.md` instead of inlining them. Routing-eval fixtures embed actual trigger keywords. `frontmatter-guard` is registered. `gbrain check-resolvable --json` returns `ok: true, issues: []`.

If your agent writes brain pages, plumb its writes through `parseMarkdown(content, path, { validate: true, expectedSlug })` (the export is in `gbrain/markdown`) and check the returned `errors` array. The 7-error envelope is stable from v0.22.4 onward. Or call `gbrain frontmatter validate <path> --json` from your script and parse the envelope. For brain repos that ARE git repos, install the pre-commit hook with `gbrain frontmatter install-hook` and stop bad frontmatter at the commit boundary.

If you maintain a downstream OpenClaw fork, see `docs/UPGRADING_DOWNSTREAM_AGENTS.md` for the v0.22.4 diff pattern. The short version: drop any references to the never-existed `lib/brain-writer.mjs` and replace with `gbrain frontmatter validate` calls.

## To take advantage of v0.22.4

`gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`. If that chain was interrupted or if `gbrain doctor` reports `frontmatter_integrity` issues:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
   The `v0.22.4` orchestrator (v0_22_4.ts) runs schema (no-op) → audit → emit-todo. The audit phase writes a per-source JSON report to `~/.gbrain/migrations/v0.22.4-audit.json` and queues one entry per source with issues to `~/.gbrain/migrations/pending-host-work.jsonl`. **It never modifies brain content.**

2. **Read the audit report:**
   ```bash
   cat ~/.gbrain/migrations/v0.22.4-audit.json | jq '.errors_by_code, .per_source[].source_id'
   ```

3. **Fix mechanical issues with explicit consent.** For each source with errors > 0, run:
   ```bash
   gbrain frontmatter validate <source-path> --fix
   ```
   This writes `.bak` backups for every modified file. SLUG_MISMATCH errors are surfaced for manual review (gbrain derives slug from path; a mismatch usually means the file was renamed deliberately or the slug field is stale).

4. **Verify the outcome:**
   ```bash
   gbrain doctor --json | jq '.checks[] | select(.name == "frontmatter_integrity")'
   gbrain frontmatter audit --json | jq '.total'
   gbrain check-resolvable --json | jq '.report.issues | map(select(.severity=="warning" or .severity=="error")) | length'
   ```
   All three should report 0 issues.

5. **If any step fails or the numbers look wrong,** file an issue at https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/migrations/v0.22.4-audit.json`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**Part A ... `gbrain check-resolvable` reaches 0 warnings.** Drop `"citation audit"` from `skills/maintain/SKILL.md` frontmatter; the trigger lives only on `citation-fixer` now. RESOLVER.md gains a citation-audit disambiguation row pointing both skills so agents still pick the right one. RESOLVER.md broadens query triggers (`"who is"`, `"background on"`, `"notes on"`) and `query/SKILL.md` mirrors them in its frontmatter. `skills/enrich/SKILL.md` replaces the inlined citation rules block with `> **Convention:** see \`skills/conventions/quality.md\`` (the format `extractDelegationTargets` recognizes). Routing-eval fixtures for `citation-fixer` rewritten to embed `"fix citations"` so substring matching passes.

**Part B ... frontmatter-guard library + CLI + doctor + migration + skill + pre-commit hook.**

- **`src/core/markdown.ts`** ... `parseMarkdown(content, filePath?, opts?)` gains an opt-in `opts.validate` flag. When true, returns `errors[]` with the seven canonical codes. Existing callers unaffected. Validation logic for all seven codes lives here as the single source of truth.
- **`src/commands/lint.ts`** ... frontmatter-rule lint cases delegate to `parseMarkdown(..., {validate:true})`. New rule names: `frontmatter-missing-close`, `frontmatter-yaml-parse`, `frontmatter-null-bytes`, `frontmatter-nested-quotes`, `frontmatter-slug-mismatch`, `frontmatter-empty`. Suppresses MISSING_OPEN to avoid double-reporting with the legacy `no-frontmatter` rule.
- **`src/core/brain-writer.ts`** (NEW) ... thin orchestrator (~280 lines). Exports `autoFixFrontmatter`, `writeBrainPage`, `scanBrainSources`. `writeBrainPage` is path-guarded (refuses writes outside `sourcePath`), always writes `<file>.bak` before any in-place mutation. `scanBrainSources` walks every registered source via direct SQL against `sources.local_path`, uses `isSyncable()` from sync.ts as the canonical brain-page filter, blocks symlinks (matches sync's no-symlink policy), and respects `AbortSignal`.
- **`src/commands/frontmatter.ts`** (NEW) ... `gbrain frontmatter validate <path> [--json] [--fix] [--dry-run]` and `gbrain frontmatter audit [--source <id>] [--json]`. The `audit` subcommand is read-only; `--fix` only exists on `validate`. CLI handles `--help` without a DB connection.
- **`src/commands/frontmatter-install-hook.ts`** (NEW) ... `gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]`. Writes `.githooks/pre-commit` per source (skips non-git sources with a one-line note), runs `git config core.hooksPath .githooks` if unset, refuses to clobber existing hooks without `--force` (writes `.bak`). The hook script gracefully degrades when `gbrain` is missing on PATH (prints a warning, exits 0 ... doesn't break commits).
- **`src/commands/doctor.ts`** ... new `frontmatter_integrity` subcheck calls `scanBrainSources()` and reports per-source counts plus the fix hint. Wraps in a doctor progress phase with heartbeat.
- **`src/commands/migrations/v0_22_4.ts`** (NEW) ... audit-only orchestrator with three phases (schema no-op, audit, emit-todo). Idempotent + resumable. Skips cleanly when no sources are registered. Per-source TODO entries reference the dotted-filename migration doc (`skills/migrations/v0.22.4.md`) per the existing `pending-host-work.jsonl` convention.
- **`skills/frontmatter-guard/SKILL.md`** (NEW) ... agent-agnostic; routes to `gbrain frontmatter` CLI invocations, drops OpenClaw-specific paths from PR #392's spec. Registered in `skills/manifest.json` and `skills/RESOLVER.md` with substring-matchable triggers.
- **`docs/integrations/pre-commit.md`** (NEW) ... recipe doc covering install / bypass / uninstall and downstream-fork notes.
- **`docs/UPGRADING_DOWNSTREAM_AGENTS.md`** ... v0.22.4 section with the diff pattern for forks that had inline frontmatter validators.

**Tests.** 9 new test files / 4 updated test files. Unit coverage on every new module:
- `test/markdown-validation.test.ts` (NEW) ... all 7 codes exercised against hand-crafted fixtures.
- `test/lint-frontmatter.test.ts` (NEW) ... lint emits findings for each fixable code; double-report suppression verified.
- `test/brain-writer.test.ts` (NEW) ... `autoFixFrontmatter` idempotency, `writeBrainPage` path-guard + `.bak` backup, `scanBrainSources` per-source rollup, AbortSignal mid-scan, single-source filter, missing-source-path graceful skip, symlink no-loop.
- `test/frontmatter-cli.test.ts` (NEW) ... subprocess `validate / --fix --dry-run / --fix / --json` + recursive directory scan with `isSyncable` filter parity.
- `test/frontmatter-install-hook.test.ts` (NEW) ... hook install / overwrite-protection / `--force` / `--uninstall` / silent-refresh on already-installed.
- `test/migrations-v0_22_4.test.ts` (NEW) ... orchestrator phase coverage including dotted-filename JSONL contract and idempotent re-emit.
- `test/check-resolvable.test.ts` (UPDATE) ... regression guard asserting the actual checked-in `skills/` tree has 0 warnings + 0 errors.
- `test/doctor.test.ts` (UPDATE) ... assertion that `frontmatter_integrity` subcheck calls `scanBrainSources` and the fix hint references the right CLI command.
- `test/apply-migrations.test.ts` (UPDATE) ... `skippedFuture` arrays extended to include v0.22.4.
- `test/migration-orchestrator-v0_21_0.test.ts` (UPDATE) ... relaxed "is the latest" assertion to "is registered with v0.22.4 after it."

### For contributors

`brain-writer.ts` is the canonical place to add new frontmatter validation rules. Add the code to `parseMarkdown`'s `collectValidationErrors`, surface the lint rule name in `lint.ts`'s `FRONTMATTER_RULE_NAMES`, decide if it's auto-fixable (add to `FRONTMATTER_FIXABLE`), and write the auto-fix logic in `brain-writer.ts:autoFixFrontmatter`. Tests in `test/markdown-validation.test.ts` + `test/brain-writer.test.ts`. The lint output uses the `frontmatter-<code>` naming convention; CI consumers can target specific rule names in their lint configs.

`gbrain frontmatter` is wired through `src/cli.ts:handleCliOnly` so `--help` works without a DB connection. The `audit` subcommand instantiates an engine internally via `loadConfig() + createEngine()`. New subcommands of `frontmatter` should follow this pattern: parse flags first, only connect to the engine when the subcommand actually needs DB access.

The v0.22.4 orchestrator is intentionally audit-only because brain content is too important to silently mutate during `apply-migrations`. Future migrations that need to rewrite brain pages should follow this two-step pattern: write the audit report + queue the fix command, let the agent run the fix with explicit user consent.

## [0.22.2] - 2026-04-26

**Worker no longer freezes silently. Restart-on-RSS, cold-start retry, autopilot backpressure.**

The minions worker has been freezing every few hours in production. RSS climbs from 68 MB at boot to ~15 GB over ~7 hours, the process stops claiming jobs but never crashes (no OOM, no SIGSEGV), the cron keeps enqueuing autopilot-cycle jobs every 5 minutes into a queue nobody is draining, and within 2-3 hours the queue piles up to 28+ waiting jobs. Shell jobs in flight when the worker froze hit `max_stalled` and dead-letter, producing an 18% shell-job failure rate over 24h. The brainstorm caught the root chain ... memory leak, wedged worker, supervisor cold-start race, no backpressure ... and v0.22.2 ships the three in-repo defenses that close the cascade end-to-end while the underlying memory leak gets investigated separately.

The watchdog is the keystone. The worker now self-terminates when RSS crosses a threshold (default 2048 MB under the supervisor) and the supervisor's exponential-backoff respawn picks up a fresh process. Both per-job AND a 60-second periodic timer check, so the watchdog still fires when every concurrency slot is wedged and zero jobs are completing ... the actual production freeze pattern. On trip, the worker fires `shutdownAbort` (so the shell handler runs its SIGTERM→5s→SIGKILL cleanup on child processes) and aborts every per-job signal (so cooperative handlers bail instead of waiting out the 30s drain). Closes the zombie-shell-children gap a Codex review surfaced.

Cold-start auth races on container boot are gone. Every CLI command's `connectEngine()` bootstrap retries transient errors (3 attempts, 1s/2s/4s backoff) by default. PgBouncer rejecting the first connect on a freshly-pinged Supabase pooler is the production failure mode that killed autopilot on cold start; the retry handles it transparently. Operators who genuinely want fail-fast on a misconfigured `DATABASE_URL` pass `--no-retry-connect` or set `GBRAIN_NO_RETRY_CONNECT=1`.

Autopilot stops piling jobs into a dead queue. `autopilot-cycle` submissions now use `maxWaiting: 1` so the v0.19.1 `pg_advisory_xact_lock` coalesce path caps the queue at 1 active + 1 waiting instead of letting it grow unbounded. The 3rd+ submission coalesces and writes a backpressure-audit JSONL line. Combined with the existing per-slot `idempotency_key`, cross-slot pile-ups are bounded.

### The numbers that matter

Production data from the 2026-04-25 incident, plus the watchdog defaults:

| Metric                                  | Before          | After (supervised path) |
|-----------------------------------------|-----------------|-------------------------|
| Waiting-jobs pileup at freeze           | 28+             | 2 (capped at 1+1)       |
| Worker RSS at freeze                    | 14.8 GB         | ~2 GB self-terminate    |
| Time to detect freeze                   | hours (manual)  | ≤60s (periodic timer)   |
| Cold-start auth-fail recovery           | manual restart  | 3 attempts in ~7s       |

Bare `gbrain jobs work` (operators not using the supervisor) keeps current unbounded behavior to preserve workloads with legitimately large embed/import working sets ... pass `--max-rss N` explicitly to enable the watchdog there.

### What this means for operators

If you run `gbrain jobs supervisor` (the production-recommended path), `gbrain upgrade` is the only step. The supervisor injects `--max-rss 2048` to its spawned worker by default; hourly watchdog exits look like clean shutdowns to the supervisor's stable-run reset, not crashes. If you run `gbrain autopilot --install`, the autopilot's worker spawn loop now has the same stable-run reset pattern, so a watchdog-driven exit every hour does NOT trip the give-up-after-5-crashes threshold. If your container hits zombie process accumulation, add `--init` to `docker run` or `tini` as PID 1 ... that's a host-side concern, not a gbrain change.

## To take advantage of v0.22.2

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **No manual SKILL.md or AGENTS.md edits required.** This release is code-only ... no schema changes, no new skills.
3. **Verify the watchdog is wired (Postgres + supervisor path):**
   ```bash
   gbrain jobs supervisor --json &
   ps -ef | grep "gbrain jobs work" | grep -- "--max-rss 2048"
   ```
   You should see the spawned worker child carrying `--max-rss 2048` in its argv.
4. **If you supervise via `gbrain autopilot --install`,** the watchdog gets injected automatically. Existing crontab/launchd/systemd installs do not need to be reinstalled ... the autopilot binary picks up the new spawn args on next restart.
5. **For hosts hitting zombie process accumulation** (PID-table fills up over weeks): add `--init` to `docker run`, or set `tini` as PID 1 in your Dockerfile. Not a gbrain code change ... operational note.
6. **If any step fails or behavior looks off,** please file an issue at https://github.com/garrytan/gbrain/issues with the output of `gbrain doctor` and the contents of `~/.gbrain/upgrade-errors.jsonl` if it exists.

### Itemized changes

#### Added

- `MinionWorkerOpts` gains `maxRssMb`, `getRss`, and `rssCheckInterval` ... watchdog plumbing with a deterministic-test seam for the RSS readback.
- `MinionWorker.gracefulShutdown(reason)` ... unified-style shutdown that fires `shutdownAbort` + per-job aborts + `running=false`. Reused by the per-job and periodic-timer check sites.
- 60-second periodic RSS check (`rssCheckInterval` default 60_000) running alongside the existing stalled-jobs timer in `start()`. Closes the freeze-with-zero-completions production scenario.
- `--max-rss MB` flag on `gbrain jobs work` (no default, opt-in for bare workers) and `gbrain jobs supervisor` (default 2048). `--max-rss 0` disables; `< 256` errors out as a likely GB-vs-MB unit-confusion typo.
- `connectWithRetry()` + `isRetryableDbConnectError()` in `src/core/db.ts`. 5-pattern transient-error matcher (auth-failed, connection-refused, db-starting, terminated-unexpectedly, ECONNRESET). Permanent errors (extension-missing, schema conflicts) do NOT retry.
- `--no-retry-connect` flag and `GBRAIN_NO_RETRY_CONNECT=1` env var ... operator escape hatch for fail-fast on misconfigured DATABASE_URL.
- Autopilot worker spawn now carries `--max-rss 2048` and a stable-run reset window (5 minutes uptime → reset crash counter to 1). Mirrors the supervisor pattern at `supervisor.ts:471-476` so hourly watchdog exits don't kill autopilot after ~5 hours.
- `autopilot-cycle` submission passes `maxWaiting: 1` to `queue.add()`. Combined with the existing per-slot `idempotency_key`, this caps cross-slot queue depth at 1 active + 1 waiting.
- 11 new tests in `test/minions.test.ts` covering the watchdog (5 cases including the production-freeze-regression case where zero jobs ever complete) and `connectWithRetry` (6 cases including the noRetry opt-out, transient/permanent error distinction, and successful retry).
- New supervisor integration test asserting `--max-rss 2048` lands in the spawned worker's argv by default.

#### Changed

- `MinionSupervisor` `SupervisorOpts` gains `maxRssMb` (default 2048). The spawn-args builder appends `--max-rss N` when `maxRssMb > 0`.
- `connectEngine()` in `src/cli.ts` now wraps `engine.connect()` in `connectWithRetry` by default. Behavior change for cold-start auth races; preserve original fail-fast with `--no-retry-connect` per call site.

#### Out of scope (follow-ups)

- The 40 MB/job memory leak itself ... separate investigation needs heap snapshots and a real reproducer. The watchdog removes urgency.
- Zombie process reaping via `tini` or `--init` ... Render/Docker host-side configuration, documented above.
- Refactoring SIGTERM/SIGINT/watchdog into one `unifiedShutdown(reason)` helper ... right shape long-term, premature for this PR.

### For contributors

- The watchdog cleanup path (`gracefulShutdown`) is intentionally co-located with `MinionWorker.stop()`. When a third caller appears (e.g., a future `pause()` method), extracting `unifiedShutdown(reason)` becomes worth the refactor. Until then, three lines is not a DRY emergency.
- `isRetryableDbConnectError()` lives in `src/core/db.ts` and owns its own 5-pattern matcher. PR #406 (when it merges) introduces a 13-pattern matcher in `src/core/minions/supervisor.ts`; the right move at that merge is to delete the supervisor's local copy and import from `db.ts` (correct dependency direction, low → high). A follow-up TODO captures this.
## [0.22.1] - 2026-04-26

**Autopilot stops being a noisy neighbor.**

Five hotfixes shipping together: incremental extract, cooperative cycle abort, supervisor watchdog reconnect, session-level connection timeouts, and server-side embed-stale filtering. The wave's theme is unified: gbrain's overnight maintenance loop was reading too much, ignoring abort signals, and quietly poisoning shared infrastructure when things went wrong. After this release the loop only reads pages that changed, bails cleanly when timeouts fire, and recovers from connection-pool poisoning without manual intervention.

### For everyone

These two fixes apply to both PGLite (default install) and Postgres / Supabase users:

- **#417 incremental extract** — `gbrain dream` cycles no longer re-read every markdown file when only a handful changed. The cycle still walks the directory tree to build the link-resolution set (a fast `readdir` pass), but `readFileSync` runs only on pages sync flagged as added or modified. On a 54,461-page production brain this turned a 10-minute extract phase into a sub-second pass; on a 500-page brain you get the same proportional win.
- **#403 cycle abort** — when a cycle phase hits a per-job timeout, `runCycle` now bails at the next phase boundary instead of grinding through extract → embed → orphans while the worker thinks the job is done. A 30-second grace-then-evict safety net in `MinionWorker` frees the slot even if a future handler ignores the abort signal entirely. Cooperative — can't interrupt a phase mid-execution — but prevents the cascade that was wedging workers.

### For Postgres / Supabase users

Three fixes that no-op on PGLite (no network, no pooler, no per-connection state):

- **#406 supervisor watchdog reconnect** — when the connection pool gets poisoned (PgBouncer rotation, Supabase pool bounce), the supervisor's watchdog now detects three consecutive health-check failures and calls `engine.reconnect()` to swap in a fresh pool. Workers crash cleanly on poisoned connections; supervisor catches it within ~3 health-check intervals (~3 minutes) instead of staying degraded until manual restart. Recovery is structural, not per-call magic.
- **#363 session timeouts** *(Contributed by @orendi84)* — every Postgres connection now sets `statement_timeout` and `idle_in_transaction_session_timeout` as connection-time startup parameters. An orphaned pgbouncer backend can no longer hold a `RowExclusiveLock` for hours and block schema migrations. Defaults: 5 minutes each. Override per-GUC via `GBRAIN_STATEMENT_TIMEOUT` / `GBRAIN_IDLE_TX_TIMEOUT` / `GBRAIN_CLIENT_CHECK_INTERVAL`. Closes #361.
- **#409 embed egress** *(Contributed by @atrevino47)* — `embed --stale` now filters server-side on `embedding IS NULL` instead of pulling every chunk's `vector(1536)` over the wire and discarding the unwanted ones client-side. On a fully-embedded 1.5K-page brain that's the difference between ~76 MB per call and a single `count()` round-trip. With autopilot firing every 5–10 minutes plus a 2-hour cron, one production user blew past Supabase's 5 GB free-tier ceiling at 102 GB used — that pattern is gone now. Two new `BrainEngine` methods (`countStaleChunks`, `listStaleChunks`) plus a consistency fix in `upsertChunks` so when `chunk_text` changes without a new embedding, both `embedding` and `embedded_at` reset to NULL together (no more "embedded_at says yes, embedding says NULL").

### Production proof point

The wave was driven by a 54,461-page OpenClaw production deployment where extract took 600+ seconds and the queue stalled at 20–36 waiting jobs (all returning `skipped: cycle_already_running`). All five fixes ran as hotfixes there for 12+ hours stable before this release. The numbers are extreme; the underlying bugs are not.

### Eng-review tightening

The original #406 wrapped `executeRaw` in a per-call retry that auto-recovered from connection errors. Eng-review dropped that wrapper as unsound — a SQL-prefix regex isn't a safe idempotence boundary (writable CTEs, side-effecting SELECTs). What ships from #406 is the structural reconnect path, not the per-call retry. Recovery moves up one layer to the supervisor watchdog. See `TODOS.md` for the planned caller-opt-in retry follow-up.

### Test coverage

15 new test cases across `test/extract-incremental.test.ts` (new), `test/core/cycle.test.ts`, and `test/connection-resilience.test.ts`:
- 8 cases for `#417`: empty/undefined slugs, [a,b]-only reads, deleted-file handling, mode filter, dry-run, BATCH_SIZE flush, full-slug-set resolution.
- 4 cases for `#417` + Codex F2: cycle threads `pagesAffected` into extract, full-walk fallback, F2 noExtract gating (full cycle vs sync-only).
- 3 cases for D3: `executeRaw` has no per-call retry wrapper, `reconnect()` still exists, supervisor still has 3-strikes path.

### To take advantage of v0.22.1

No manual step. PGLite users get the universal fixes automatically on next cycle. Postgres users additionally get session timeouts on the next pool reconnect, server-side stale filtering on the next `embed --stale`, and supervisor reconnect on the next pool poisoning event.

```bash
gbrain upgrade
gbrain doctor    # verify (optional)
```

If anything looks wrong post-upgrade, file an issue: https://github.com/garrytan/gbrain/issues with `gbrain doctor` output.

## [0.22.0] - 2026-04-25

**Search stops getting swamped by chat logs. Curated pages win by default.**

For the last few releases, multi-word topic queries against a real brain returned chat-log pages at #1 and #2 because chat pages are 50KB and contain mentions of every topic. The actual article you wrote about the topic ranked #5. v0.22.0 fixes that at the SQL layer ... ranking is now source-aware, curated directories outrank bulk content, and bookkeeping directories like `test/` and `archive/` never enter the candidate set.

The fix layers on top of v0.21.0's Cathedral II chunk-grain FTS and two-pass retrieval. Different mechanism, additive effect. Chat pages get dampened at the chunk-rank stage; curated content gets boosted; the two-pass walk and source-boost both run in the same pipeline. Temporal queries (`when`, `last week`, `YYYY-MM`) bypass the gate entirely so date-framed chat lookups still work. Two new env vars (`GBRAIN_SOURCE_BOOST`, `GBRAIN_SEARCH_EXCLUDE`) tune per-deployment. `unset` them to revert to v0.21.0 ranking exactly.

Two SearchOpts additions plumb hard-exclude through the API: `exclude_slug_prefixes` (additive over defaults + env) and `include_slug_prefixes` (subtractive opt-back-in). The four default hard-excludes (`test/`, `archive/`, `attachments/`, `.raw/`) were silently polluting search results before.

### The numbers that matter

A new BrainBench category — **Cat 13b: Source Swamp Resistance** — ships in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo. The corpus is 20 pages: 10 short opinionated `originals/` pages and 10 long `openclaw/chat/` dumps that mention the same multi-word phrases at higher per-byte density. 30 hand-curated queries assert the curated page wins.

| gbrain version                       | Top-1 hit | Top-3 hit | Swamp@top |
|--------------------------------------|-----------|-----------|-----------|
| v0.20.4 (pre-Cathedral II)           | 90.0%     | 100.0%    | 10.0%     |
| v0.21.0 (Cathedral II — two-pass)    | 90.0%     | 100.0%    | 10.0%     |
| **v0.22.0 (this release)**           | **93.3%** | **100.0%** | **6.7%**  |

v0.21.0's two-pass retrieval is orthogonal to source-swamp resistance — it's about call-graph edges and parent-scope chunking, which doesn't reach the directory-level ranking signal that source-boost provides. v0.22.0 adds +3.3pts top-1 and -3.3pts swamp on top of v0.21.0.

The world-v1 corpus (BrainBench Cats 1+2 retrieval, 145 relational queries) is unchanged at P@5 49.1% / R@5 97.9% — every existing benchmark axis stays put within ±2pp tolerance.

### What this means for you

If your brain's biggest directories are chat dumps, daily logs, or X archives, search just got dramatically better for the topic queries you actually run. If you depend on chat surfacing for date-framed questions ("what did we discuss last week"), nothing changed ... the intent classifier routes those to `detail=high` which bypasses source-boost. If you want a different boost map, set `GBRAIN_SOURCE_BOOST=originals/:1.8,openclaw/chat/:0.3` and ship.

## To take advantage of v0.22.0

`gbrain upgrade` should do this automatically. No DB migration is needed ... the change is purely a SQL ranking refactor on existing tables.

1. **No manual migration step required.** The new ranking is on by default. Defaults are tuned for a brain with the canonical `originals/`, `concepts/`, `writing/`, `meetings/`, `daily/`, `media/x/`, `openclaw/chat/` shape.
2. **Tune for your brain (optional):**
   ```bash
   # Stronger originals boost, harder chat dampening
   export GBRAIN_SOURCE_BOOST="originals/:1.8,openclaw/chat/:0.3"
   # Add a directory to the hard-exclude list
   export GBRAIN_SEARCH_EXCLUDE="scratch/,private/"
   ```
3. **Verify the outcome:**
   ```bash
   gbrain search "<a multi-word topic phrase from your brain>"
   # Expect: curated content (originals/, concepts/, writing/) at the top.
   gbrain search "<phrase>" --detail high
   # Expect: source-boost bypassed; chat pages allowed back.
   ```
4. **Rollback one-liner** if something looks off:
   ```bash
   unset GBRAIN_SOURCE_BOOST GBRAIN_SEARCH_EXCLUDE
   ```
   Reverts ranking to v0.21.0 behavior exactly.

### Itemized changes

#### Source-aware retrieval

- New module `src/core/search/source-boost.ts` ships the default boost map (`originals/` 1.5, `concepts/` 1.3, `writing/` 1.4, `people/companies/deals/` 1.2, `daily/` 0.8, `media/x/` 0.7, `openclaw/chat/` 0.5) and the four default hard-exclude prefixes (`test/`, `archive/`, `attachments/`, `.raw/`). Both knobs override via env (`GBRAIN_SOURCE_BOOST`, `GBRAIN_SEARCH_EXCLUDE`) or per-call SearchOpts.
- New module `src/core/search/sql-ranking.ts` is a pair of pure SQL-fragment builders shared between Postgres and PGLite engines. `buildSourceFactorCase` emits a longest-prefix-match CASE expression and returns literal `'1.0'` when `detail === 'high'` so temporal queries bypass source-boost. `buildHardExcludeClause` emits `NOT (col LIKE 'p1%' OR col LIKE 'p2%')` ... OR-chain wrapped in NOT, never `NOT LIKE ALL/ANY` (those don't express set-exclusion). LIKE meta-character escape covers `%`, `_`, AND `\` (backslash matters because it's Postgres LIKE's default escape char). Single-quote doubling renders SQL-injection-style inputs inert.
- `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` ... three methods wired: `searchKeyword` (chunk-grain CTE → DISTINCT ON page dedup, multiplies ts_rank by source-factor), `searchKeywordChunks` (the chunk-grain anchor primitive used by Cathedral II two-pass retrieval, also gets source-boost so the anchor pool is dampened on chat dirs), and `searchVector` (becomes a two-stage CTE: pure-distance HNSW inner ORDER BY, source-boost re-rank in outer SELECT, innerLimit scales with offset to preserve pagination).
- `src/core/types.ts` ... SearchOpts gains two fields: `exclude_slug_prefixes?: string[]` (additive over defaults + env) and `include_slug_prefixes?: string[]` (subtractive opt-back-in).

#### Tests

- `test/sql-ranking.test.ts` ... 39 unit cases covering longest-prefix-match, detail=high temporal-bypass, three-meta-char LIKE escape, single-quote SQL-literal doubling, env-var parsing, resolver merge semantics.
- `test/e2e/search-swamp.test.ts` ... reproduces the headline case in PGLite. Curated article competes with two chat pages stuffed with the same multi-word phrase. Asserts article wins both keyword and vector ranking, detail=high lets chat re-surface, source_id passes through two-stage CTE.
- `test/e2e/search-exclude.test.ts` ... verifies test/ + archive/ pages hidden by default, include_slug_prefixes opts back in, exclude_slug_prefixes adds to defaults.
- `test/e2e/engine-parity.test.ts` ... Postgres ↔ PGLite top-result + result-set parity for both search methods plus a hard-exclude parity case. Skips gracefully when DATABASE_URL is unset.

#### Won't break what was already working

The change is additive at the SQL layer; no `hybrid.ts`, `intent.ts`, `dedup.ts`, `expansion.ts`, `two-pass.ts`, or operations-layer changes. RRF fusion, compiled-truth boost, backlink boost, multi-query expansion, source-aware dedup, and v0.21.0's Cathedral II two-pass retrieval all run unchanged downstream of the new ranking. The `sql.begin` + `SET LOCAL statement_timeout` v0.19 wrap is preserved (transaction-scoped GUC; bare SET would leak onto pooled connections, documented DoS vector). RLS-enabled brains still work because both inner and outer CTE SELECTs are subject to row-level policies.

### For contributors

- The two new helpers are pure functions with explicit params and zero engine dependencies. Both engines call them to build identical SQL. Useful pattern for any future SQL-side ranking signal that needs to land in both Postgres and PGLite.
- The two-stage CTE pattern (HNSW-safe pure-distance inner ORDER BY, re-rank in outer SELECT) is the right shape for any future per-prefix or per-page boost in vector search. Folding extra factors into the outer ORDER BY keeps the index usable.
- BrainBench Cat 13b lives in [gbrain-evals](https://github.com/garrytan/gbrain-evals) on `feat/cat13b-source-swamp` ... 20-page corpus + 30 hand-curated queries. Companion PR.

## [0.21.0] - 2026-04-25

## **Your brain walks the code graph now.**
## **Call-graph edges, parent scope, chunk-grain FTS. 165-lang ready, 8 langs shipped with structural edges.**

v0.19.0 made code a first-class citizen. v0.21.0 makes it a graph. An agent asking "how does searchKeyword handle N+1" no longer gets back one chunk of `hybrid.ts`. It gets the function body, the 3 callers via `code-callers`, the 2 callees via `code-callees`, the class-level scope header, and — when opt-in `--walk-depth 2` is passed — the grandchildren too. All ranked together by a single RRF pass with 1/(1+hop) structural decay. One walk. Code-aware brain, not grep-class RAG.

Chunk-grain FTS replaces page-grain internally. The docstring above a function now ranks above a prose paragraph that happens to mention the same term. The `content_chunks.search_vector` tsvector weights doc_comment 'A' and chunk_text 'B' — an english-language query hits the right chunk first. External shape stays page-grain so every existing caller (`enrichment-service.countMentions`, `backlinks`, `list_pages`) works unchanged.

Classes emit properly now. `class BrainEngine { searchKeyword() {}, searchVector() {} }` was ONE chunk in v0.19.0. In v0.21.0 it's three: the class-level scope header chunk (declaration + member digest), `searchKeyword` with `parentSymbolPath: ['BrainEngine']`, and `searchVector` with the same. Retrieval surfaces individual methods when a query targets one — no more re-reading the whole class.

Ruby ships in the first wave of structural-edge support. `Admin::UsersController#render` identity. `def render` captured. `find_all` captured. Across all 8 shipped languages (TS, TSX, JS, Python, Ruby, Go, Rust, Java — ~85% of real brain code) call-site edges extract at chunk time and land in `code_edges_symbol` for `getCallersOf` / `getCalleesOf` to surface.

The honest part: precision 80, recall 99. We don't do receiver-type inference at capture time (`obj.method()` stores the bare `method` callee, not `ObjClass.method`). Cross-file edge resolution is also a future optimization — all Layer 5 edges land unresolved. What matters: the edges exist. `getCallersOf('helper')` now returns every call site in the brain, ready for Layer 7 two-pass retrieval to expand into structural neighbors. That's the 10x leap.

### The numbers that matter

Counted against gbrain's own codebase, PGLite in-memory benchmark:

| Metric | v0.19.0 | v0.21.0 | Δ |
|---|---|---|---|
| Structural edge types captured | 0 | `calls` (per-file) | ∞ |
| Languages with call-graph edges | 0 | 8 | +8 |
| Chunk grain at FTS time | page-level | chunk-level (internal) | — |
| File classifier extensions | 9 | 35 | +26 |
| Nested symbol chunks (class with 3 methods) | 1 chunk | 4 chunks | 4x |
| Parent-scope column persisted | No | `parent_symbol_path TEXT[]` | ✓ |
| `code-callers <sym>` + `code-callees <sym>` | not possible | JSON array in <100ms | ∞ |
| `query --near-symbol X --walk-depth 2` | not possible | 2-hop structural expansion | ∞ |
| `sync --all` cost preview | no warning | `ConfirmationRequired` envelope + TTY prompt | ✓ |
| Markdown fence extraction | prose chunks | per-fence code chunks | ✓ |

Per-language call capture (8 shipped):

| Lang | Top-level | Class/module | Edge capture via |
|---|---|---|---|
| TypeScript | function_declaration, class_declaration, interface, type_alias, enum | class + interface → methods | call_expression.function |
| TSX | same + JSX | same | same |
| JavaScript | function_declaration, class_declaration, lexical_declaration | class → methods | call_expression.function |
| Python | function_definition, class_definition | class → function_definition | call.function |
| Ruby | class, module, method, singleton_method | module+class → method+singleton_method | call.method |
| Go | function_declaration, method_declaration | (methods are top-level) | call_expression.function |
| Rust | function_item, impl_item, struct, enum, trait, mod | impl+trait → function_item | call_expression.function |
| Java | method_declaration, class_declaration, interface, enum, record | class+interface+record → method+constructor | method_invocation.name |

### What this means for builders

If you've been maintaining a gbrain deployment on v0.19.0, upgrading is mechanical: `gbrain upgrade` runs `apply-migrations` → schema v27 + v28 land automatically (~5 seconds on a 47K-page brain). Your next `gbrain sync --source <id>` detects `sources.chunker_version` mismatch and forces a full re-walk — no manual intervention. Or run `gbrain reindex-code --dry-run` to preview the cost, then `gbrain reindex-code --yes` to take advantage of A1 + A3 immediately.

If you ship an agent on top of gbrain: `query --lang typescript "N+1"` now filters at SQL level, `code-callers searchKeyword` surfaces who calls it, `query "how does searchKeyword work" --near-symbol BrainEngine.searchKeyword --walk-depth 2` expands through the structural graph. Your agent's brain-first lookup covers the CODE GRAPH now, not just the symbol table.

If you're Garry wondering how your Rubyist instincts survive the upgrade: `class Admin::UsersController { def render; def find_all }` gets qualified as `Admin::UsersController#render`. `code-callers render` finds the call sites. The instance-vs-singleton distinction is best-effort today (Layer 5 treats both as instance); `def self.find_all` vs `def find_all` ambiguity is documented in the Ruby-specific caveats of `skills/migrations/v0.21.0.md`.

## To take advantage of v0.21.0

`gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`. If that chain was interrupted or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
   The `v0.21.0` orchestrator (v0_21_0.ts) runs schema → backfill-prompt → verify. Schema migrations v27 + v28 land unconditionally. The backfill-prompt phase prints two paths to roll the new chunker over existing code pages.

2. **Pick a backfill path.** CHUNKER_VERSION bumped 3 → 4; the `sources.chunker_version` gate (SP-1 fix) forces a full re-walk on next sync regardless of git HEAD.

   - AUTOMATIC (recommended): next `gbrain sync --source <id>` walks everything. Zero action needed.
   - IMMEDIATE: `gbrain reindex-code --dry-run` previews cost, `gbrain reindex-code --yes` runs it. Cost preview gated via `ConfirmationRequired` envelope on non-TTY callers, exit code 2 matches `sync --all`.

3. **Verify the outcome:**
   ```bash
   gbrain doctor                           # expect schema_version >= 28
   gbrain code-callers <your-favorite-fn>  # expect a JSON array of call sites
   gbrain query "some concept in your brain" --walk-depth 1
   gbrain stats
   ```

4. **If any step fails or the numbers look wrong,** file an issue at https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**Layer 1 — Foundation schema migration (v27).** All DDL lands first, before any consumer. `content_chunks` gains `parent_symbol_path TEXT[]`, `doc_comment TEXT`, `symbol_name_qualified TEXT`, `search_vector TSVECTOR`. `sources` gains `chunker_version TEXT` (SP-1 gate). Two new tables: `code_edges_chunk` (resolved, FK CASCADE both ways) + `code_edges_symbol` (unresolved qualified-name edges). Plpgsql trigger `update_chunk_search_vector` weights doc_comment + symbol_name_qualified 'A', chunk_text 'B'. Per codex SP-4: every downstream layer has its schema prerequisites before referencing them. `scripts/check-jsonb-pattern.sh` + migration tests pin the DDL shape so accidental drift surfaces in CI.

**Layer 2 (1a) — File-classifier widening.** `src/core/sync.ts` expands from 9 recognized code extensions to 35 — Rust, Ruby, Java, C#, C/C++, Swift, Kotlin, Scala, PHP, Elixir, Elm, OCaml, Dart, Zig, Solidity, Lua, shell, etc. New `resolveSlugForPath(path)` centralizes slug dispatch (SP-5 fix) so delete/rename paths honor the same code-vs-markdown classification as import. Layer 9 (Magika) fallback hook ready via `setLanguageFallback`.

**Layer 3 (1b) — Chunk-grain FTS with page-grain wrap.** `searchKeyword` now ranks internally at chunk grain via the new `search_vector`, then dedups to best-chunk-per-page before returning. External shape unchanged (SP-6 decision) — every `searchKeyword` caller (`enrichment-service`, `backlinks`, `list_pages`) sees the same page-grain result. A2 two-pass consumes the raw chunk-grain primitive via the new `searchKeywordChunks` method. Weight A (doc_comment + symbol_name_qualified) > Weight B (chunk_text) means docstring matches rank above prose for NL queries.

**Layer 4 (B1) — Language manifest foundation.** The hardcoded `GRAMMAR_PATHS` + `DISPLAY_LANG` maps collapse into one `LANGUAGE_MANIFEST` keyed by `LanguageEntry` (embeddedPath | lazyLoader | displayName). `registerLanguage` / `unregisterLanguage` / `listRegisteredLanguages` are extension points; downstream consumers can add grammars without forking the chunker. 29 shipped embedded today; the lazy-load path is forward-compat for the full 165-language pack.

**Layer 5 (A1) — Edge extractor + qualified names (8 langs).** The 10x leap. `src/core/chunkers/edge-extractor.ts` walks the tree-sitter tree iteratively (no recursion — generated code trees can blow the stack) and harvests call-site edges per-language. `src/core/chunkers/qualified-names.ts` builds identity strings per-language: Ruby `Admin::UsersController#render`, Python `admin.users.UsersController.render`, TS `BrainEngine.searchKeyword`, Rust `users::UsersController::render`. `importCodeFile` calls `deleteCodeEdgesForChunks` (codex SP-2 inbound invalidation) then `addCodeEdges`. Both engines (PGLite + Postgres) implement all 5 edge methods: `addCodeEdges`, `deleteCodeEdgesForChunks`, `getCallersOf`, `getCalleesOf`, `getEdgesByChunk`. Readers UNION both tables forever (codex 1.3b: no promotion).

**Layer 6 (A3) — Parent-scope + nested-chunk emission.** A class with 3 methods emits 4 chunks now: the class-level scope header (slim body: declaration line + member digest) + each method with `parentSymbolPath: ['ClassName']`. Chunk headers show `(in ClassName.method)` so the embedding captures scope. Recursive expansion: Ruby `module Admin { class Users { def render } }` emits 3 chunks — Admin, Users (parent=[Admin]), render (parent=[Admin, Users]). `mergeSmallSiblings` bails when scope chunks are present (methods emitted individually on purpose; merging would erase the parent-path metadata).

**Layer 7 (A2) — Two-pass structural retrieval.** `src/core/search/two-pass.ts` expands an anchor set up to 2 hops through `code_edges_chunk` + `code_edges_symbol`, unresolved-edge targets resolved by symbol_name_qualified lookup. Score decay 1/(1+hop). Default OFF per codex F5. Activation: `--walk-depth N` (1 or 2) or `--near-symbol <qualified-name>`. Neighbor cap 50 per hop. Dedup per-page cap lifts from 2 → `min(10, walkDepth × 5)` when walking.

**Layer 8 (D) — Tier D bundle.** Three deferred items from v0.19.0 ship here. **D1** `sync --all` cost preview via `estimateTokens` + `EMBEDDING_COST_PER_1K_TOKENS = 0.00013` + `ConfirmationRequired` envelope (TTY prompt or exit-2 on non-TTY / JSON / piped). **D2** markdown fence extraction — `importFromContent` walks marked lexer tokens, extracts recognized `{type:'code', lang, text}` fences through `chunkCodeText` with pseudo-path, persists as `chunk_source='fenced_code'`. 100-fence-per-page cap (env override `GBRAIN_MAX_FENCES_PER_PAGE`). **D3** `reconcile-links` batch command — forward-scans every markdown page via `extractCodeRefs`, reinserts missing doc↔impl edges idempotently (`ON CONFLICT DO NOTHING`). Respects `auto_link=false` config.

**Layer 10 (C) — Agent CLI surfaces.** `query --lang typescript` and `query --symbol-kind function|class|method` filter at SQL level (C1 + C2). `code-callers <symbol>` (C4) and `code-callees <symbol>` (C5) ship as new commands — auto-JSON on non-TTY, StructuredAgentError on failure. `query --near-symbol <qualified> --walk-depth 1..2` (C3) wires A2 two-pass through the query operation. C6 (`code-signature`) deferred to v0.20.1 per plan.

**Layer 12 — CHUNKER_VERSION 3 → 4 + SP-1 gate.** The ship-silent bug codex caught on second pass: bumping `CHUNKER_VERSION` alone did nothing on an unchanged repo because `performSync` returns `up_to_date` before reaching `importCodeFile`'s content_hash check. Fix: `sources.chunker_version` tracks the version that last synced each source; mismatch forces a full re-walk regardless of git HEAD equality. `writeChunkerVersion` called after every `writeSyncAnchor 'last_commit'`.

**Layer 13 (E2) — reindex-code + migration orchestrator.** `gbrain reindex-code [--source <id>] [--dry-run] [--yes] [--force] [--json]` — explicit backfill for users who want v0.21.0 benefits NOW (before next sync). Walks code pages in batches of 100 (Finding 4.4 OOM protection). Reuses D1's cost-preview gate. `--force` bypasses `importCodeFile`'s content_hash early-return. `src/commands/migrations/v0_21_0.ts` orchestrator: schema → backfill-prompt → verify phases. Idempotent, resumable.

**Layer 11 (E1) — BrainBench code sub-category tests.** `test/cathedral-ii-brainbench.test.ts` pins `call_graph_recall` (getCallersOf round-trip through real importCodeFile, with re-import idempotency validated) and `parent_scope_coverage` (nested methods persist parent_symbol_path, qualified names resolve). `doc_comment_matching` and `type_signature_retrieval` deferred to v0.20.1 with A4 full extraction + C6 respectively.

**Layer 9 (B2) — Magika auto-detect: DEFERRED to v0.20.1.** The fallback hook (`setLanguageFallback`) is in place at `src/core/chunkers/code.ts`. The `detectCodeLanguage` call order already accommodates a `null → fallback` path. Bundling the ~1MB Magika ONNX model through `bun --compile` surfaces integration risk that the plan explicitly allowed deferring. Tracked in TODOS.md.

**Test coverage.** +900 lines of new test cases across 11 new test files:
- `test/chunker-version-gate.test.ts`, `test/migrations-v0_21_0.test.ts` (Layer 1 schema + Layer 12 gate)
- `test/sync-classifier-widening.test.ts` (Layer 2)
- `test/chunk-grain-fts.test.ts` (Layer 3)
- `test/language-manifest.test.ts` (Layer 4)
- `test/qualified-names.test.ts`, `test/edge-extractor.test.ts`, `test/code-edges.test.ts` (Layer 5)
- `test/parent-scope.test.ts` (Layer 6)
- `test/two-pass.test.ts` (Layer 7)
- `test/sync-cost-preview.test.ts`, `test/fence-extraction.test.ts`, `test/reconcile-links.test.ts` (Layer 8)
- `test/search-lang-symbol-kind.test.ts`, `test/code-callers-cli.test.ts` (Layer 10)
- `test/reindex-code.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts` (Layer 13)
- `test/cathedral-ii-brainbench.test.ts` (Layer 11)

Final CI: 2407 pass / 250 skip / 0 fail / 6345 expect() / 467s.

**Credit.** Plan reviewed by 2 codex passes + 1 plan-eng-review + 1 plan-ceo-review. 16 cross-model findings (7 + 6 + 3) all absorbed — notably codex SP-1 (chunker_version silent no-op), SP-2 (inbound edge invalidation across re-imports), SP-3 (multi-source tenancy), SP-4 (layer bisectability), SP-5 (slug dispatcher), SP-6 (FTS page-grain external contract), SP-7 (no promotion, UNION-on-read forever). The release's correctness on those 3 ship-silent bugs + real bisectability is directly attributable to the two codex passes on a cathedral-scale plan.

## [0.19.0] - 2026-04-23

## **Your code is now first-class in the brain.**
## **`gbrain code-refs BrainEngine --json` returns every usage site in <100ms.**

Until this release, gbrain was a markdown brain. An agent asking "how do we handle partial sync failures" got back the guide and the CHANGELOG post-mortem. It got nothing from the actual code. Not because the feature was missing — because the chunker treated a TypeScript file as prose. v0.19.0 makes code a first-class citizen alongside markdown: 29 languages parsed by tree-sitter into semantic chunks, each with a structured header (`[TypeScript] src/core/sync.ts:380-415 function performFullSync`), queryable by symbol name with a new `code-def` / `code-refs` command pair that ships agent-safe JSON by default.

The flagship moment for the agent persona: `gbrain code-refs BrainEngine --json` returns a clean array of `{file, line, symbol_name, snippet}` tuples in under 100ms on a 25-file corpus. No grep. No full-file reads. The brain knows where BrainEngine is used, and the agent can feed the response directly into its next reasoning step. Brain-first lookup finally covers code.

The cost story: daily autopilot on a 5K-file TS repo would have been ~$30/month of OpenAI embedding spend. v0.19.0's incremental chunker diffs chunks by `(chunk_index, chunk_text)` — unchanged symbols reuse their embedding, only new or edited code hits the API. Typical edit touches 2-5% of chunks, so the daily bill drops ~95% to pennies.

The honest part: the chunker ships as a **strict superset of Chonkie's CodeChunker**. 29 languages (vs 6 baseline), tiktoken `cl100k_base` tokenizer for accurate budgeting (not the 2-3x-off `len/4` heuristic), small-sibling merging so 30 top-level imports don't produce 30 embedding calls, AST-aware splitting of large nodes. Tree-sitter WASMs ship embedded in the `bun --compile` binary — the silent-failure mode Codex flagged during plan review got closed by a CI guard that proves semantic chunks actually come out of the compiled binary. Every release runs it.

### The numbers that matter

Counted against gbrain's own codebase (~300 TypeScript files), PGLite in-memory benchmark:

| Metric | v0.18.x (markdown-only) | v0.19.0 (code-aware) | Δ |
|---|---|---|---|
| Code indexing languages | 0 | 29 | +29 |
| Chunk metadata columns | chunk_text only | + language, symbol_name, symbol_type, start/end_line | +5 |
| `code-refs BrainEngine` surface | not possible | JSON array in <100ms | ∞ |
| Daily autopilot embedding cost (5K code files, 5% churn) | ~$1.50/day naive | ~$0.05/day incremental | 30x |
| Tokenizer accuracy vs OpenAI cl100k_base | 2-3x off (len/4) | exact (tiktoken) | tight |

### What this means for builders

If you build with gbrain + OpenClaw + Claude Code: add your repo as a source (`gbrain sources add gbrain --path .`) and sync with strategy=code. Ask your agent to "look at gbrain" — it gets the full symbol graph, not just the README. If you're shipping your own gstack fork on top of gbrain: your agent's brain-first lookup now covers code, which closes the largest remaining gap where agents fell back to grep. If you're Garry wondering what `performFullSync` does: `gbrain code-def performFullSync` and you get the answer without opening a file.

### Itemized changes

**Layer 0 — Garry's OpenClaw baseline (cherry-picked, author scrubbed).** Tree-sitter code chunker for 6 languages (TS/TSX/JS/Python/Ruby/Go), `gbrain repos add/list/remove`, strategy-aware sync, `PageType 'code'`, `importCodeFile`, per-file sync progress via the v0.15.2 reporter. Preserved exactly, committed under Garry's author identity.

**Layer 1 — A6 structured errors + version bump.** New `src/core/errors.ts` exports `StructuredAgentError` + `buildError` + `serializeError`. Matches the v0.17.0 `CycleReport.PhaseResult.error` shape so agent-consumable errors stay consistent across every gbrain surface. `globToRegex` bug fix: `src/**/*.ts` now matches `src/foo.ts` (zero intermediate dirs). `GBRAIN_HOME` env var for test isolation. `package.json` → `0.19.0`.

**Layer 2 — `bun --compile` WASM embedding + CI guard.** Codex flagged the node_modules-at-runtime approach as the #1 silent-failure mode for v0.19.0. Fix: WASMs committed to `src/assets/wasm/`, loaded via `import path from ... with { type: 'file' }`. Bun bundles every asset referenced this way into the compiled binary. `scripts/check-wasm-embedded.sh` compiles a smoketest binary on every `bun test` run and asserts it produces real semantic chunks. If the chunker ever silently falls through to recursive again, the build breaks.

**Layer 3 — schema migrations v25 + v26.** `pages.page_kind TEXT CHECK (page_kind IN ('markdown','code'))` on v25, using Postgres's `NOT VALID` + `VALIDATE CONSTRAINT` split so tables with millions of pages don't hold a write lock during the ALTER. `content_chunks` adds `language`, `symbol_name`, `symbol_type`, `start_line`, `end_line` on v26, plus partial indexes keyed on non-null values so code-chunk lookups stay cheap on mixed markdown+code brains.

**Layer 4 — delete the OpenClaw baseline's multi-repo, wire v0.18.0 sources.** The `repos` abstraction in Garry's OpenClaw baseline turned out to be redundant with v0.18.0's `sources` subsystem (per-source `last_commit`, `federated` search config, RLS-friendly, DB-native). v0.19.0 keeps `gbrain repos` as a deprecated alias that routes into `runSources`. `sync --all` iterates the `sources` table instead of a local config array. Codex's P0 #2 (per-repo sync bookmarks) and P0 #3 (slug collision) both resolved by the existing schema.

**Layer 5 — Chonkie chunker parity (E2a).** 6 languages → 29. Embedded asset paths for every grammar in `tree-sitter-wasms`. Accurate tokenizer via `@dqbd/tiktoken` `cl100k_base` (lazy-init). Small-sibling merging with the Chonkie `bisect_left` pattern tuned to 15% of chunk target, so tiny siblings (imports, single-line consts) collapse while substantive classes/functions stay independent. `CHUNKER_VERSION=3` folded into `importCodeFile`'s `content_hash` so chunker-shape changes across releases force clean re-chunks without `sync --force`.

**Layer 6 — incremental chunking (E2) + doc↔impl linking (E1).** `importCodeFile` reads existing chunks before embedding; any chunk whose `(chunk_index, chunk_text)` matches verbatim reuses the existing embedding, saving the OpenAI call. `extractCodeRefs` in `link-extraction.ts` scans markdown prose for references like `src/core/sync.ts:42`; `importFromContent` creates bidirectional `documents` / `documented_by` edges for every match. The agent can now walk from guide to code and back.

**Layer 7 — `code-def` + `code-refs` CLI surfaces.** The magical-moment commands. Both bypass the standard `searchKeyword` path (DISTINCT ON (slug) collapses to one result per page — wrong for code-refs). Auto-JSON when stdout is not a TTY (gh-CLI convention). Structured error envelope for the usage-error + catch-all paths. `--lang` / `--limit` / `--json` / `--no-json` flags across both commands.

**Layer 8 — BrainBench code category (E2E).** 11-test E2E suite against PGLite in-memory, 5 languages × 5 service files = 25-file fictional corpus, asserts `code-def` and `code-refs` retrieval quality plus the <100ms magical-moment budget. Reproducible on CI without OpenAI keys (embeddings disabled — tests cover retrieval metadata, not vector quality).

**Test coverage.** 91 new unit + E2E tests across 9 new files: `test/errors.test.ts`, `test/sync-strategy.test.ts`, `test/migrations-v0_19_0.test.ts`, `test/repos-alias.test.ts`, `test/chunkers/code.test.ts`, `test/link-extraction-code-refs.test.ts`, `test/incremental-chunking.test.ts`, `test/code-def-refs.test.ts`, `test/e2e/code-indexing.test.ts`. 357 assertions, all green against PGLite.

**Credit.** Baseline tree-sitter chunker + multi-repo scaffolding came from a community PR (author scrubbed per the privacy rule). The v0.19.0 rework on top — cathedral scope, Chonkie parity, doc↔impl linking, incremental chunking, the sources reconciliation, and the full test suite — was driven by the /plan-ceo-review + /plan-devex-review + /plan-eng-review + /codex review chain. Codex's outside-voice pass caught 4 P0s (baseline-not-in-tree, per-repo bookmarks, slug collision, chunk schema gap) that the in-model reviews missed. All 4 are fixed in the ship.

## To take advantage of v0.19.0

`gbrain upgrade` runs `apply-migrations` which lands v25 + v26 automatically. If `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Add your code repo as a source and sync:**
   ```bash
   gbrain sources add my-repo --path /path/to/repo
   gbrain sync --source my-repo
   ```
   (Or `gbrain repos add my-repo --path ...` — the deprecated alias still works.)
3. **Verify code indexing works:**
   ```bash
   gbrain code-def BrainEngine
   gbrain code-refs BrainEngine --json
   ```
4. **Observe the cost delta.** After a full sync, run an `autopilot` cycle. Incremental chunking means the second cycle's embedding cost is ~5% of the first.
5. **If the compiled binary produces no symbol names** (everything falls to recursive chunks): your install may have skipped the WASM assets. File an issue with `gbrain doctor` output.

## [0.20.4] - 2026-04-24

**Minions skill consolidation, now honest about what the CLI actually does.**

One skill for background work instead of two. Shell jobs and LLM subagents land under `skills/minion-orchestrator/` with a shared Preconditions block, accurate CLI examples, and a trigger set narrowed to what the skill actually covers. Corrects four documentation bugs the prior merge shipped ... `submit_job name="shell"` isn't MCP-callable, `research`/`orchestrate` aren't real handler names, PGLite users don't need to migrate to Supabase, and "every background task goes through Minions" contradicts the `pain_triggered` default in `skills/conventions/subagent-routing.md`. The skill now matches the code.

Two new tests guard this surface going forward. `test/resolver.test.ts` gets a round-trip check (every quoted RESOLVER.md trigger must resolve to a frontmatter `triggers:` entry in the target skill) and a name validator (every `name="<word>"` reference in any SKILL.md must resolve to either a declared operation in `src/core/operations.ts` or a known Minions handler). The validator would have caught the `research`/`orchestrate` drift in CI instead of from a Codex cold-read. One new E2E test (`test/e2e/minions-shell-pglite.test.ts`) exercises the PGLite `--follow` inline path, previously documented but untested.

### For users

- Shell jobs via `gbrain jobs submit shell --params '{"cmd":"..."}'` (operator/CLI only ... MCP returns `permission_denied` for protected names). Subagent jobs via `gbrain agent run` (user-facing entrypoint). Both lanes route through one skill.
- PGLite shell-job guidance now correctly points at `--follow` for inline execution. The persistent daemon mode is still Postgres-only, but you do not need to migrate.
- `gbrain jobs submit` and `submit a gbrain job` now route to the skill; bare "gbrain jobs" no longer does (it was too broad ... the CLI namespace covers 9 subcommands, and questions about `stats`/`prune`/`retry` fall through to `gbrain --help`).

### Added

- New E2E test `test/e2e/minions-shell-pglite.test.ts` covering the PGLite `--follow` inline shell-job path. Runs in-memory, no DATABASE_URL required.
- Resolver round-trip test in `test/resolver.test.ts`: every quoted RESOLVER.md trigger must have a fuzzy match in the target skill's frontmatter `triggers:` list.
- Skill-example-name validator in `test/resolver.test.ts`: every `name="<word>"` reference in any `SKILL.md` body must resolve to an op in `src/core/operations.ts` or a Minions handler in `PROTECTED_JOB_NAMES`.

### Fixed

- `skills/minion-orchestrator/SKILL.md` shell-job examples use the real `--params` JSON form instead of nonexistent `--cmd`/`--argv`/`--cwd` flags.
- `gbrain agent run` flag list now matches `src/commands/agent.ts` (removed `--queue`/`--priority`/`--max-attempts`/`--delay` which aren't parsed by that command).
- `--tools` example uses `search,query` instead of `web_search` (the latter isn't in `BRAIN_TOOL_ALLOWLIST`, would throw at submit time).
- MCP boundary wording says `submit_job name="shell"` throws an `OperationError` with code `permission_denied`, instead of the earlier "returns permission_denied" (not a return, a throw).
- `skills/conventions/subagent-routing.md` stale reference to `get_job_stats` (no such op) replaced with `list_jobs --status active` or `gbrain jobs stats`.
- `skills/query/SKILL.md` + `skills/maintain/SKILL.md` frontmatter `triggers:` lists closed gaps the new round-trip test surfaced (RESOLVER.md was routing 10 triggers to these skills that their frontmatter never declared).
- `skills/manifest.json` minion-orchestrator description updated to match the unified SKILL.md framing.

### Changed

- Trigger `"gbrain jobs"` narrowed to `"gbrain jobs submit"` + `"submit a gbrain job"` in both `skills/RESOLVER.md` and the skill's frontmatter.
- Anti-pattern about `sessions_spawn` scoped to the subagent lane (was ambiguous in the consolidated skill).

### For contributors

- Code-to-doc drift is now partially machine-checkable. The skill-example-name validator catches T2-class bugs (docs referencing handler/op names that don't exist). CLI flag validation is a remaining gap ... a future PR could extend the test to validate `--flag-name` patterns in SKILL.md against actual CLI flag parsers.

## To take advantage of v0.20.4

Any gbrain user whose agent routes on "minions" work gets the corrected skill on the next `gbrain upgrade`. No manual migration required ... the renamed trigger is additive (old trigger gone, new triggers cover the same intent), and the doc corrections don't change runtime behavior.

1. **Run the orchestrator manually if `gbrain upgrade` reports a partial migration:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent picks up the new skill content** next time it consults `skills/minion-orchestrator/SKILL.md`. No action required on your side.
3. **Verify the outcome:**
   ```bash
   gbrain check-resolvable --json | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok:',d['ok'])"
   ```
   Should print `ok: True`.
4. **If any step fails,** file an issue at https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists

## [0.20.3] - 2026-04-24

## **Your queue now rescues itself when a wedged worker holds a row lock. Wall-clock sweep kills the job that stall detection can't see.**
## **`maxWaiting` is race-proof, observable, and reachable from the CLI — three bugs in one patch.**

A production autopilot-cycle job wedged for over an hour on a single OpenClaw deployment because the worker's handler got stuck mid-transaction holding a row lock. Both eviction paths were blocked: the stall detector's `FOR UPDATE SKIP LOCKED` pass skipped the row-locked candidate, and the timeout sweep's `lock_until > now()` predicate disqualified the job once lock-renewal had been blocked. Neither could see the job. The shell-job pipeline starved completely behind the wedge.

v0.19.0 shipped the wall-clock sweep as the third-layer kill shot: drop both constraints, evict on `started_at` alone, worst case at `2 × timeout_ms + stalledInterval`. This release locks down three correctness holes the v0.19.0 PR introduced — then closes the observability gap that let the incident run to minute 90 in the first place.

### The queue-resilience numbers that matter

Measured against the real incident on 2026-04-23 (OpenClaw autopilot + shell-job pipeline, Postgres engine, concurrency=1 worker).

| Behavior | Before v0.20.3 | After v0.20.3 |
|---|---|---|
| Wedged worker escape window | 90+ minutes (manual kill) | `~2 × timeout_ms + 30s` sweep interval |
| Per-name waiting pile during wedge | 18 deferred per-slot jobs | capped at `maxWaiting` |
| `maxWaiting` under concurrent submit (2 submitters, cap=2) | up to 3 rows (TOCTOU race) | exactly 2 rows (advisory-lock serialization) |
| Same name across queues | cross-queue bleed — `shell` suppressed by `default` | isolated per `(name, queue)` |
| `GBRAIN_WORKER_CONCURRENCY=foo` | silent wedge (`inFlight < NaN` false) | clamped to 1, loud stderr warning |
| `gbrain jobs submit --max-waiting 2` | flag didn't exist | wired through to MinionJobInput |
| Silent coalesce events | invisible | JSONL audit at `~/.gbrain/audit/backpressure-YYYY-Www.jsonl` |
| `gbrain doctor` visibility into wedge | no check | new `queue_health` with 2 subchecks |

The two big shifts: (1) every silent-failure vector the v0.19.0 patches introduced now has a loud signal — JSONL audit files, doctor check, stderr warnings, peer-liveness probe. (2) `maxWaiting` is now actually a cap under concurrency, not a soft suggestion. A future multi-submitter pattern (parallel workspaces, dispatched children, OpenClaw + ycli cron) doesn't walk through it.

### What this means for OpenClaw users

If you're running `gbrain autopilot` on a daily-driver deployment, the wall-clock sweep is the difference between a 90-minute outage and a 30-second one. The `queue_health` doctor check means the next time your queue wedges, you notice in minute 2 instead of minute 90. If you've been writing programmatic Minion submitters and setting `maxWaiting`, it's worth re-reading the JSONL audit file the next time your agent does anything "interesting" — you'll see exactly which submission coalesces into which returned job.

## To take advantage of v0.20.3

`gbrain upgrade` handles the binary. You MUST restart long-running worker daemons so the new sweep runs in-process — the wall-clock eviction is a method on `MinionQueue`, not a cron job, so it only fires inside a worker loop.

1. **Upgrade the binary:**
   ```bash
   gbrain upgrade
   ```
2. **Restart autopilot + workers:**
   ```bash
   # systemd / launchd / OpenClaw service-manager: restart the unit.
   # Manual: kill the old `gbrain autopilot` and `gbrain jobs work`, start new ones.
   ```
3. **Verify:**
   ```bash
   gbrain jobs smoke --wedge-rescue   # exercises the new wall-clock path
   gbrain doctor --json | jq '.checks[] | select(.name == "queue_health")'
   ```
4. **If `gbrain doctor` flags anything unexpected,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/audit/backpressure-*.jsonl` (redact freely)
   - what commands you ran leading up to the wedge

### Itemized changes

**Queue core** (`src/core/minions/queue.ts`)
- `maxWaiting` coalesce path wraps `count → select → insert` in `pg_advisory_xact_lock` keyed on `(name, queue)`. Concurrent submitters for the SAME key serialize; different keys stay parallel. Lock auto-releases on transaction commit/rollback — no cleanup path to leak. Fixes TOCTOU race caught by adversarial review.
- `maxWaiting` count and select now filter on `queue` in addition to `name`. Pre-v0.20.3 code filtered on name alone, so a waiting `autopilot-cycle` in `queue=default` would suppress submissions to `queue=shell` with the same name. Cross-queue bleed is gone.

**Backpressure observability** (new `src/core/minions/backpressure-audit.ts`)
- Every coalesce event writes one JSONL line to `~/.gbrain/audit/backpressure-YYYY-Www.jsonl` (ISO-week rotation, override dir via `GBRAIN_AUDIT_DIR`, mirrors the v0.14 shell-audit pattern).
- Fields: `ts, queue, name, waiting_count, max_waiting, decision='coalesced', returned_job_id`.
- Best-effort: write failures log to stderr but never block submission.

**CLI** (`src/commands/jobs.ts`)
- New `--max-waiting N` flag on `gbrain jobs submit`. Clamps to `[1, 100]`, mirrors the existing `--max-stalled` wiring. The `MinionJobInput.maxWaiting` field was programmatic-only before; now it's reachable from the command line too.
- `resolveWorkerConcurrency` clamps against invalid input. `parseInt` returns `NaN` for `"foo"`, `0` for `"0"`, negatives for `"-5"` — all of which silently wedge a worker (`inFlight.size < NaN/0/negative` is always false). Now clamped to ≥1 with a loud stderr warning naming the bad value. One typo in a systemd unit no longer reproduces the 90-minute outage.
- New `gbrain jobs smoke --wedge-rescue` opt-in case. Forges a wedged-worker row state, invokes `handleStalled` + `handleTimeouts` + `handleWallClockTimeouts` in sequence, asserts only the wall-clock sweep evicts. Mirrors the v0.14.3 `--sigkill-rescue` shape.

**Doctor** (`src/commands/doctor.ts`)
- New `queue_health` check (Postgres-only; PGLite skips with `Skipped (PGLite — no multi-process worker surface)`).
- Subcheck 1 — **stalled-forever**: flags active jobs whose `started_at` is older than 1 hour. Reports the top 5 by start time with `gbrain jobs get/cancel <id>` fix hints.
- Subcheck 2 — **waiting-depth**: flags per-name queues whose waiting count exceeds threshold. Default 10, overridable via `GBRAIN_QUEUE_WAITING_THRESHOLD` env. Reports the top 5 by depth with "consider setting maxWaiting on the submitter" fix hint.
- Worker-heartbeat staleness subcheck intentionally deferred to follow-up because `lock_until`-on-active-jobs is a lossy proxy. A check that cries wolf erodes trust in every other doctor subcheck. Needs a `minion_workers` table to produce ground-truth signal.

**Autopilot** (`src/commands/autopilot.ts`)
- `--no-worker` mode gains a peer-worker-liveness probe. Every cycle runs a cheap `SELECT count(*)` checking for active jobs with `lock_until` refreshed in the last 2 minutes. After 3 consecutive idle ticks, logs a loud `WARNING` naming the silent-wedge vector (`--no-worker` set but no worker running). Re-arms once a live signal returns, so a healthy-but-idle worker doesn't trigger spam.
- Probe is documented as a proxy, not ground truth — idle worker with no active jobs reads as "no worker." The ground-truth fix needs a `minion_workers` heartbeat table (tracked as follow-up).

**Docs**
- New `docs/guides/queue-operations-runbook.md`: the "my queue looks wedged — what do I run?" reference. One viewport, in order of escalation. What each `queue_health` subcheck means. Self-check for the `--no-worker + no-worker-running` footgun.
- `CLAUDE.md` Key-files section updated for the new `handleWallClockTimeouts` method (v0.19.0, described here for the first time), the new `backpressure-audit.ts` module, the updated `maxWaiting` semantics, and the new `queue_health` doctor check.

**Tests** (`test/minions.test.ts`)
- 23 new unit cases. Wall-clock sweep (3 cases + non-interference with `handleTimeouts`). `maxWaiting` (coalesce, clamp 0 → 1, floor 1.7 → 1, concurrent-submitter race via `Promise.all`, cross-queue isolation, unset fallthrough). Concurrency clamp (7 cases including `NaN`/`0`/negative). `parseMaxWaitingFlag` (5 cases). Backpressure audit file write. All 143 minions tests pass.
- E2E wall-clock case against real Postgres is next on the roadmap (needs a second-connection row-lock helper; the unit-level coverage above exercises the sweep mechanics directly).

### For contributors

- The v0.19.0 PR's narrative framed the 18-job pileup as "duplicate submissions from a cron loop with no idempotency key." That framing was wrong. Autopilot already sets `idempotency_key: autopilot-cycle:${slot}` where slot is a 5-minute tick boundary — within-slot duplicates are structurally impossible. The 18 jobs were 18 different slots stacking up behind the wedged one. `maxWaiting` still caps the pile; the incident just wasn't about idempotency. Adversarial review caught this before v0.20.3 shipped.
- Follow-up issues tracked: B2 (autopilot heartbeat file), B3 (doctor `--fix` learns queue rescue), B4 (backpressure counts surfaced in `jobs stats`), B5 (cross-cutting "health-delivery-agent" pattern), B7 (`minion_workers` heartbeat table — unblocks both the dropped `queue_health` subcheck and a ground-truth `--no-worker` probe), P1 (composite indexes `(status, started_at)` and `(status, name)` on `minion_jobs` — currently the new sweeps fall back to `idx_minion_jobs_status`, selective enough on healthy queues, worth tightening in v0.20.4).

Full plan with CEO + Eng + Codex adversarial decisions lives at `~/.claude/plans/` for the operators who care about how this release was reviewed.

## [0.20.2] - 2026-04-24

## **`gbrain jobs supervisor` is now a self-healing daemon you can actually drive. The Minions worker stops dying silently.**
## **Three commands an agent can run: `start --detach`, `status --json`, `stop`. Crash loops are bounded, audit events are JSONL, and the health check finally reports real data.**

`gbrain jobs work` has always been the worker that drains your Minions queue. Problem: it dies (OOM, connection blip, panic) and nobody notices until jobs pile up. The old answer was `nohup` plus a 68-line bash watchdog script from the deployment guide, and it shipped its own bugs (restart-loop traps, log-parsing stall detection, zero audit trail).

v0.20.2 ships the replacement: `gbrain jobs supervisor` is a first-class CLI with atomic PID locking, exponential backoff, structured audit events at `~/.gbrain/audit/supervisor-YYYY-Www.jsonl`, and three subcommands that make it drivable by an OpenClaw or Hermes agent in three turns. The old bash watchdog is gone.

### The numbers that matter

Before v0.20.2, an agent driving the supervisor needed ~10 turns of shell archaeology (PID file scraping, `pgrep -f`, `kill -0`, log grep) just to start and stop the worker reliably. After v0.20.2, it's three commands with machine-parseable output.

| Capability | Before v0.20.2 | After v0.20.2 |
|---|---|---|
| Keeping the worker alive | `nohup` + `minion-watchdog.sh` (68 lines of bash, restart-loop bug, log-scrape health) | `gbrain jobs supervisor` (first-class CLI with atomic PID lock, exponential backoff, JSONL audit) |
| PID file locking | `existsSync + readFileSync + writeFileSync` TOCTOU race | Atomic `O_CREAT|O_EXCL` via `openSync('wx')` — kernel-atomic mutex |
| Stalled-jobs health alert | Queried `status='stalled'` — returned 0 rows forever (dead code) | Queries `status='active' AND lock_until < now()`, scoped to the supervised queue |
| Shell-exec env inheritance | Child inherited `GBRAIN_ALLOW_SHELL_JOBS=1` from parent shell regardless of CLI flag | Explicit `else delete env.GBRAIN_ALLOW_SHELL_JOBS` when not opted in + regression test |
| Agent discovery TTHW | ~10 turns of shell-scraping (cat PID / pgrep / kill -0 / log grep) | 3 turns: `start --detach` → `status --json` → `stop` |
| Lifecycle observability | `console.log` with human prefixes, zero audit trail | JSONL events on stderr + `~/.gbrain/audit/supervisor-YYYY-Www.jsonl` + `gbrain doctor` integration |
| Exit codes | undocumented; agent couldn't distinguish "already running" from "gave up" | Four documented codes: `0` clean, `1` max-crashes, `2` lock-held, `3` PID-unwritable |
| Test coverage of the supervisor itself | ~15% (backoff math + PID helpers only) | Integration tests covering crash-restart, max-crashes drain, SIGTERM-during-backoff, env-inheritance regression |

The supervisor's own reliability claims are now testable. Every lifecycle event (`started`, `worker_spawned`, `worker_exited`, `backoff`, `health_warn`, `max_crashes_exceeded`, `shutting_down`, `stopped`, `worker_spawn_failed`) lands in a weekly-rotated JSONL file that `gbrain doctor` reads to surface a `supervisor` health check.

### What this means for your deployment

If you were using the old `nohup`/`minion-watchdog.sh` pattern:

1. **Stop the old watchdog:** `sudo kill $(head -n1 /tmp/gbrain-worker.pid) 2>/dev/null && crontab -e` and delete the watchdog cron line.
2. **Delete the script:** `sudo rm -f /usr/local/bin/minion-watchdog.sh /tmp/gbrain-worker.pid /tmp/gbrain-worker.log`.
3. **Start the supervisor:** `gbrain jobs supervisor start --detach --json` — or on systemd, reinstall the unit (now calls `gbrain jobs supervisor`).
4. **Verify:** `gbrain doctor` reports a `supervisor` check; `gbrain jobs supervisor status --json` returns `running:true`.

For containers (Fly / Railway / Render / Heroku): the shipped `Procfile` and `fly.toml.partial` now call `gbrain jobs supervisor`. The platform restarts the container on host events, the supervisor restarts the worker on in-process crashes. Two-layer supervision with clean separation.

For OpenClaw / Hermes / Cursor agents driving the supervisor: you no longer need a shell skill to drive the worker. Every piece of state — liveness, crash history, max-crashes exhaustion — is a machine-parseable JSON response. Start with `gbrain jobs supervisor status --json | jq`.

## To take advantage of v0.20.2

`gbrain upgrade` pulls the binary. Nothing else is required if you're currently running `gbrain jobs work` directly or using systemd — the new supervisor is opt-in. To migrate:

1. **Verify the binary:**
   ```bash
   gbrain --version   # should say 0.20.2
   gbrain jobs supervisor --help | head -20
   ```
2. **Start the supervisor (detached, agent-friendly):**
   ```bash
   gbrain jobs supervisor start --detach --json
   # → {"event":"started","supervisor_pid":1234,"pid_file":"/Users/you/.gbrain/supervisor.pid","detached":true}
   ```
3. **Check health:**
   ```bash
   gbrain jobs supervisor status --json
   gbrain doctor | grep supervisor
   ```
4. **Stop when done:**
   ```bash
   gbrain jobs supervisor stop
   ```
5. **(Optional) Migrate off the old watchdog:** see `docs/guides/minions-deployment.md` "Upgrading from an older deployment" for the cron-to-supervisor migration.

If `gbrain jobs supervisor status` reports `running:false` unexpectedly, or `gbrain doctor` flags a `supervisor` failure, file an issue at https://github.com/garrytan/gbrain/issues with:
- output of `gbrain doctor`
- the last ~50 lines of `~/.gbrain/audit/supervisor-*.jsonl`
- which step broke

### Itemized changes

**`gbrain jobs supervisor`:**
- New subcommands: `start [--detach] [--json]`, `status [--json]`, `stop [--json]`. Foreground use is unchanged (back-compat).
- New flags: `--allow-shell-jobs` (explicit opt-in, replaces env-var sniffing), `--cli-path PATH` (override auto-resolution), `--json` (JSONL lifecycle events on stderr), `GBRAIN_SUPERVISOR_PID_FILE` env var (overrides default PID path).
- Exit codes documented in `--help`: `0` clean, `1` max-crashes, `2` lock-held, `3` PID-unwritable.
- Default PID path moved from `/tmp/gbrain-supervisor.pid` to `~/.gbrain/supervisor.pid` with automatic parent-directory creation.

**Safety fixes (codex adversarial review + eng review):**
- Atomic PID lock via `openSync(path, 'wx')` — two supervisors starting simultaneously can no longer both win the race.
- `stalled` health check query rewritten from unreachable `status='stalled'` to `status='active' AND lock_until < now()` matching `queue.ts:848 handleStalled()`.
- Health queries now scoped to `WHERE queue = $1` — multi-queue deployments see the right queue.
- Unified exit path via `shutdown(reason, exitCode)` — max-crashes drains gracefully instead of bypassing cleanup via `process.exit(1)`.
- Listener ref tracking: `SIGTERM`/`SIGINT` handlers removed on shutdown for clean test lifecycle.

**Security hardening:**
- `allowShellJobs` class default flipped `true` → `false`.
- Child env now has `GBRAIN_ALLOW_SHELL_JOBS` explicitly deleted when `allowShellJobs:false` (was: silently inherited from parent shell).
- Integration regression test locks this against future refactors.

**Observability:**
- New `src/core/minions/handlers/supervisor-audit.ts` with ISO-week rotation (mirrors `shell-audit.ts` / `subagent-audit.ts` pattern).
- Every supervisor emission (started, worker_spawned, worker_exited, worker_spawn_failed, backoff, health_warn, health_error, max_crashes_exceeded, shutting_down, stopped) written to `~/.gbrain/audit/supervisor-YYYY-Www.jsonl`.
- `gbrain doctor` gains a `supervisor` check that reads the audit file and reports `running` / `last_start` / `crashes_24h` / `max_crashes_exceeded` with thresholds (ok / warn at 3+ crashes / fail on max-crashes event).

**Documentation:**
- `docs/guides/minions-deployment.md` rewritten: supervisor is the canonical answer; which-supervisor-when decision table (container / systemd / dev laptop); three-command agent pattern; migration block from the old watchdog.
- `README.md` Operations section gains a paragraph on `gbrain jobs supervisor`.
- `docs/guides/minions-deployment-snippets/{systemd.service,Procfile,fly.toml.partial}` now invoke `gbrain jobs supervisor` instead of raw `gbrain jobs work`.
- `docs/guides/minions-deployment-snippets/minion-watchdog.sh` deleted — subsumed by the supervisor.

**Tests:**
- `test/supervisor.test.ts`: 7 → 13 tests. Four new integration tests exercise real `spawn()` lifecycles via shell-script fakes (crash-restart happy path, max-crashes-via-shutdown with audit assertions, SIGTERM-during-backoff clean exit, `GBRAIN_ALLOW_SHELL_JOBS` inheritance regression — positive + negative).
- `test/fixtures/supervisor-runner.ts`: new standalone runner that constructs a supervisor from env vars so integration tests can observe `process.exit` without killing the test runner.

**For contributors:**
- The `MinionSupervisor` class has a test-only `_backoffFloorMs` override for fast crash-loop tests. Not exposed via CLI.
- `onEvent: (emission) => void` is an injectable hook on `SupervisorOpts` — Lane C's audit writer uses it; future observability integrations can too.
- `autopilot.ts` migration to `MinionSupervisor` is explicitly deferred (follow-up PR): the current `start()` API blocks, which deadlocks autopilot's interval loop. Codex's review flagged this; the fix is a non-blocking-start API redesign, not a drop-in substitution.

Credit: original supervisor feature built by OpenClaw (PR #364 initial commit). Review wave + code-level fixes + daemon-manager CLI + observability boomerang + integration tests shipped via /autoplan (CEO + DX + Eng + Codex adversarial) followed by a 20-item multi-lane implementation plan.

## [0.20.0] - 2026-04-23

## **BrainBench moves out. gbrain gets its install surface back.**
## **The eval harness + 5MB fictional corpus now live in a sibling repo; gbrain exposes a clean public API they consume.**

BrainBench is gbrain's benchmark harness. 10/12 Cats, 4-adapter scorecard, 418-item fictional corpus, 314 tests. Previously it lived inside this repo. Every `bun install` pulled down the eval tree, `docs/benchmarks/*.md` reports, `pdf-parse` devDep, and auxiliary test fixtures whether or not you ever ran a benchmark. For the 99% of gbrain users who want a knowledge-brain CLI, that's ~5MB of noise.

v0.20 moves BrainBench to [github.com/garrytan/gbrain-evals](https://github.com/garrytan/gbrain-evals). gbrain stays the knowledge-brain CLI + library. `gbrain-evals` depends on gbrain via GitHub URL and consumes it through the public exports map. Same benchmarks, same scorecards, same Cat runners, same 418-item fictional amara-life corpus, just a separate install. Folks who don't care about evals never download them. Folks who do clone one extra repo.

The clean separation also gives gbrain a first real public API surface. `package.json` adds 11 new subpath exports (`gbrain/engine`, `gbrain/pglite-engine`, `gbrain/search/hybrid`, `gbrain/link-extraction`, `gbrain/extract`, and so on) covering every gbrain internal the eval harness reaches into. Third-party tools (not just BrainBench) now have a stable contract to consume. Removing any of these exports is a breaking change going forward.

### What moved where

| Stays in gbrain | Moves to gbrain-evals |
|-----------------|----------------------|
| `src/` (CLI, MCP, engines, operations, skills runtime) | `eval/` (runners, adapters, generators, schemas, gold, cli) |
| `Page.type` enum including `email/slack/calendar-event/note/meeting` (useful for any ingested format, not just evals) | `test/eval/` (314 tests across 14 files) |
| `inferType()` heuristics for the new directory patterns | `docs/benchmarks/*.md` (all scorecards + regression reports) |
| Public exports map (11 new subpaths gbrain-evals consumes) | `pdf-parse` devDep (only eval/runner/loaders/pdf.ts used it) |
| `src/core/` test suite (1696 tests) | `eval:*` scripts (run from gbrain-evals now) |

### What this means for you

If you install gbrain via `git clone + bun install` or via npm/clawhub, you get a smaller, cleaner checkout. No eval corpus. No benchmark reports. No pdf-parse. `bun test` runs only gbrain's own test suite, not eval tests.

If you want to run BrainBench: `git clone https://github.com/garrytan/gbrain-evals && cd gbrain-evals && bun install && bun run eval:run`. gbrain-evals fetches gbrain from GitHub via `"gbrain": "github:garrytan/gbrain#master"` so you always benchmark against the latest source.

If you're a third-party library author importing gbrain internals: the new exports map is now your stable contract. Pin `gbrain/<subpath>` imports against a version, not a file path.

### Itemized changes

**Extracted to [gbrain-evals](https://github.com/garrytan/gbrain-evals):**
- `eval/` ... schemas, runners, adapters, generators, queries, CLI tools, docs (CONTRIBUTING, RUNBOOK, CREDITS).
- `test/eval/` ... 14 test files, 314 tests covering schemas, sealed qrels, tool-bridge, agent adapter, judge, recorder, Cat 5/6/8/9/11, amara-life skeleton, adversarial-injections, pdf loader.
- `docs/benchmarks/` ... all scorecards and regression reports (4-adapter, v0.11 vs v0.12, Minions production/lab, tweet ingestion, knowledge runtime v0.13, BrainBench v1).
- `pdf-parse` devDep ... only consumed by `eval/runner/loaders/pdf.ts`.
- `eval:*` package.json scripts ... now live in gbrain-evals's `package.json` and run from there.

**Kept in gbrain (useful beyond evals):**
- `Page.type` enum extensions in `src/core/types.ts`: `email | slack | calendar-event | note | meeting`. Any user ingesting an inbox dump, Slack export, iCal file, or meeting transcript benefits from first-class types.
- `inferType()` heuristics in `src/core/markdown.ts` for `/emails/`, `/slack/`, `/cal/`, `/notes/`, `/meetings/` directory patterns.
- 11 new public `exports` in `package.json`: `./pglite-engine`, `./link-extraction`, `./import-file`, `./transcription`, `./embedding`, `./config`, `./markdown`, `./backoff`, `./search/hybrid`, `./search/expansion`, `./extract`. These form gbrain's public-API contract for downstream consumers.

**Docs synced:**
- `README.md` ... benchmark references now point at the gbrain-evals repo.
- `CLAUDE.md` ... BrainBench section replaced with a pointer to gbrain-evals + the list of public exports that consumers depend on.
- `src/commands/migrations/v0_12_0.ts` ... migration banner text references `github.com/garrytan/gbrain-evals` instead of a local `docs/benchmarks/*.md` path that no longer resolves.

**Tests:** 1717 gbrain tests pass, 0 failures, 174 skipped (E2E requiring `DATABASE_URL`). The full eval suite (314 tests) moves with `gbrain-evals` and runs from there.

### To take advantage of v0.20

For gbrain users:
1. `gbrain upgrade` ... no action required. The extraction is transparent.
2. If you previously ran `bun run eval:*` scripts from this repo: those scripts no longer exist here. `git clone https://github.com/garrytan/gbrain-evals && bun install` to get them.

For gbrain-evals consumers:
1. Clone the sibling repo: `git clone https://github.com/garrytan/gbrain-evals`
2. `bun install && bun run eval:run`
3. Follow `gbrain-evals/eval/RUNBOOK.md` for full category runs and scorecard reproduction.

## [0.19.1] - 2026-04-24

### Added

- New `gbrain smoke-test` CLI command. Runs 8 post-restart health checks with auto-fix: Bun runtime, gbrain CLI loads, database reachable via doctor, worker process liveness, OpenClaw Codex plugin Zod CJS (auto-reinstall when the zod@4 package ships without `core.cjs`), OpenClaw gateway responding, embedding API key present, brain repo exists. User-extensible via drop-in scripts at `~/.gbrain/smoke-tests.d/*.sh`. Designed to run from OpenClaw bootstrap hooks so every container restart automatically verifies and repairs the environment.
- `skills/smoke-test/` skill with full documentation, pattern for adding new tests, and a growing known-issue database (starting with the Zod `core.cjs` publish bug discovered 2026-04-23).
- `smoke-test` routing entry in `skills/RESOLVER.md` under Operational, so agents reach the skill on "post-restart health", "did the container restart break anything", and "smoke test" triggers.

### Fixed

- Doctor's `resolver_health` check now passes on fresh installs: `skills/smoke-test/` is wired into `RESOLVER.md` so the cascade that was flagging it unreachable (and dragging `gbrain doctor` to exit 1 on healthy brains) no longer fires.
- `skills/smoke-test/SKILL.md` gains the required `## Anti-Patterns` and `## Output Format` sections, so `test/skills-conformance.test.ts` no longer flags it.
- `llms-full.txt` regenerated to reflect the new RESOLVER row. The drift guard in `test/build-llms.test.ts` now passes.

## [0.19.0] - 2026-04-22

## **Your OpenClaw finally learns. Say "skillify it!" and every new failure becomes a durable skill.**
## **AGENTS.md workspaces work out of the box. `gbrain skillpack install` drops 25 curated skills into your OpenClaw.**

Your agent can now turn any ad-hoc fix into a permanent skill with tests, routing evals, and filing audits. The workflow that was aspirational for months is a real CLI: scaffold the stubs, write the logic, run one check that verifies the whole 10-step checklist. Your OpenClaw stops making the same mistake twice.

Four new commands and a lot of polish on the existing ones. `gbrain check-resolvable` now works against AGENTS.md workspaces (not just RESOLVER.md ones), so the 107-skill deployment you actually run is finally inspectable. New `gbrain skillify scaffold` creates all the stubs for a new skill in one command. New `gbrain skillpack install` copies gbrain's curated 25-skill bundle into your workspace, managed-block style, never clobbering your local edits. New `gbrain routing-eval` surfaces which user phrasings route to the wrong skill.

### The numbers that matter

Measured live against a real OpenClaw deployment with 107 skills, `AGENTS.md` at workspace root, no `manifest.json`:

| Capability | Before v0.19 | After v0.19 |
|---|---|---|
| `gbrain check-resolvable` against an AGENTS.md workspace | `RESOLVER.md not found`, exit 2 | detects 102 skills, 15 unreachable errors, 108 advisory warnings |
| Unreachable skills surfaced by first run | 0 (check never ran) | 15 (≈15% of the tree was dark) |
| `gbrain skillify` as a CLI verb | didn't exist | `scaffold` + `check` subcommands |
| `gbrain skillpack install` | didn't exist | 25 curated skills, dependency closure, file-lock + atomic managed block |
| `gbrain routing-eval` | didn't exist | structural (default) + `--llm` layer for CI gating |
| Warnings break CI by default | yes (any issue → exit 1) | no (warnings advisory; `--strict` opts in) |

Running `skillify scaffold webhook-verify --description "..." --triggers "..."` writes 4 stub files + appends an idempotent resolver row in under 2 seconds. The real work (your rule, your script, your tests) is what you spend time on afterward — not the boilerplate.

### What this means for your workflow

Your agent says "skillify it!" and runs five commands:

1. `gbrain skillify scaffold <name> --description "..." --triggers "..."` — creates SKILL.md, script stub, routing-eval fixture, test skeleton, resolver row
2. Replace the `SKILLIFY_STUB` sentinels with real logic + real tests
3. `gbrain skillify check skills/<name>/scripts/<name>.mjs` — 10-item audit
4. `gbrain check-resolvable` — reachability + routing + filing + DRY + stub-sentinel gate
5. `bun test test/<name>.test.ts`

Four of the five take under a second. The script stops shipping unless you replace its `SKILLIFY_STUB` marker, so scaffolded-but-forgotten skills can't slip past `check-resolvable --strict`.

For downstream OpenClaw deployments: `gbrain skillpack install --all` copies the bundled skills into `$OPENCLAW_WORKSPACE`. Per-file diff protection never overwrites your local edits without `--overwrite-local`. The managed block in your AGENTS.md tells you exactly what gbrain installed so you can see it at a glance.

## To take advantage of v0.19.0

`gbrain upgrade` does this automatically. To verify:

1. **Binary version:**
   ```bash
   gbrain --version   # should say 0.19.0
   ```
2. **New commands:**
   ```bash
   gbrain check-resolvable --help | grep -- '--strict'
   gbrain routing-eval --help
   gbrain skillify --help
   gbrain skillpack --help
   ```
3. **For AGENTS.md-native OpenClaw deployments:**
   ```bash
   export OPENCLAW_WORKSPACE=~/your-openclaw/workspace
   gbrain check-resolvable           # human output, warnings advisory
   gbrain check-resolvable --strict  # warnings block CI
   ```
4. **For skills you author:** add `routing-eval.jsonl` fixtures and `writes_pages: true` + `writes_to:` frontmatter as you touch each skill. Filing audit is warning-only in v0.19 and escalates to error in v0.20.
5. **If anything fails,** file an issue at https://github.com/garrytan/gbrain/issues with the output of `gbrain doctor` and `gbrain check-resolvable --json`.

No schema migration. Existing brains work unchanged.

### Itemized changes

#### Added

- **`gbrain skillify scaffold <name>`** — creates SKILL.md, script stub, routing-eval fixture, and test skeleton, plus an idempotent trigger row in your resolver. Re-running with `--force` never appends a duplicate row. Every scaffold carries a `SKILLIFY_STUB` sentinel that `check-resolvable --strict` rejects until replaced.
- **`gbrain skillify check [path]`** — 10-item post-task audit (promoted from `scripts/skillify-check.ts`; the legacy script remains as a shim).
- **`gbrain skillpack list`** — prints the curated bundle (25 skills) shipped with gbrain.
- **`gbrain skillpack install <name>` / `--all`** — copies bundled skills into the target workspace. Automatically pulls shared convention files so nothing references a missing dep. Per-file diff protection, `--overwrite-local` escape hatch, `.gbrain-skillpack.lock` against concurrent installers, atomic managed-block update to AGENTS.md / RESOLVER.md.
- **`gbrain skillpack diff <name>`** — per-file diff preview before install.
- **`gbrain routing-eval`** — dedicated CI verb that runs routing fixtures (`skills/<name>/routing-eval.jsonl`) and surfaces intent-to-skill mismatches, ambiguous routing, and false positives. Ships the structural layer (same logic `check-resolvable` runs). The `--llm` flag is accepted as a placeholder for a future LLM tie-break layer; in this release it emits a stderr notice and runs structural only.
- **`gbrain check-resolvable --strict`** — opt-in CI mode that promotes warnings to failures.
- **`skills/_brain-filing-rules.json`** — machine-readable canonical filing rules (JSON sidecar to the prose `_brain-filing-rules.md`).
- **`writes_pages: true` + `writes_to: [...]`** — new skill frontmatter fields consumed by the filing audit. Distinct from `mutating:` so cron schedulers and report writers aren't dragged into filing checks.
- **`SKILLIFY_STUB` sentinel check** — new type in `check-resolvable` that flags scaffolded scripts whose stubs haven't been replaced.

#### Changed

- **`gbrain check-resolvable` accepts `AGENTS.md` as a resolver file** alongside `RESOLVER.md`, at either the skills directory or one level up (workspace root). Auto-detects via `$OPENCLAW_WORKSPACE`, `~/.openclaw/workspace`, repo root, or `./skills`. Explicit `$OPENCLAW_WORKSPACE` wins over the repo-root walk.
- **Auto-derives the skill manifest** by walking `skills/*/SKILL.md` when `manifest.json` is missing. OpenClaw deployments that never shipped a manifest now get real reachability checks instead of silent empty passes.
- **`ResolvableReport` split into `errors[]` + `warnings[]`** so advisory findings (filing audit, routing gaps, DRY violations) don't break CI by default. The deprecated `issues[]` union remains for one release.
- **`openclaw.plugin.json`** refreshed: version 0.19.0, 25 curated skills, new `shared_deps` declaration for convention files, new `excluded_from_install` for skills that shouldn't be dropped into other workspaces.
- **`gbrain skillpack-check`** is now also reachable as `gbrain skillpack check` under the new namespace.
- **`scripts/skillify-check.ts`** reduced to a thin shim that delegates to `gbrain skillify check`.

#### Fixed

- `check-resolvable` stopped silently passing on workspaces that lacked `manifest.json`. The reachability check now sees every skill on disk.
- Parallel `skillpack install` runs no longer race on the AGENTS.md managed block; the file-lock serializes writers and managed-block updates use tmp-file-plus-rename.

### For contributors

- New core modules: `src/core/resolver-filenames.ts`, `src/core/skill-manifest.ts`, `src/core/routing-eval.ts`, `src/core/filing-audit.ts`, `src/core/skillify/{templates,generator}.ts`, `src/core/skillpack/{bundle,installer}.ts`.
- New command modules: `src/commands/routing-eval.ts`, `src/commands/skillify.ts`, `src/commands/skillify-check.ts`, `src/commands/skillpack.ts`.
- `scripts/check-privacy.sh` — pre-commit / CI guard enforcing the private-fork-name ban in public artifacts.
- Test fixture at `test/fixtures/openclaw-reference-minimal/` (4 skills + workspace-root AGENTS.md) plus `test/e2e/openclaw-reference-compat.test.ts` exercises the full AGENTS.md + skillpack install stack. `test/regression-v0_16_4.test.ts` locks the pre-v0.19 `checkResolvable` envelope shape. `test/skillpack-sync-guard.test.ts` asserts `openclaw.plugin.json#skills` stays a subset of `skills/manifest.json`.

---

## [0.18.2] - 2026-04-23

## **Migrations survive a crash and Supabase's 2-min ceiling.**
## **`gbrain doctor --locks` finds the connection blocking your upgrade.**

The v0.18.0 production upgrade shipped a field report of 8 issues: statement timeouts, stale idle connections, a schema version that lied, a cryptic FK dependency error. The original PR #356 fix covered all 8. A codex plan-review pass found 3 more that neither the initial review nor the eng review caught. This release lands the lot.

The quiet win: if your brain crashes mid-migration on Postgres, it rolls back cleanly now. Before v0.18.2, a process death between migrations 21 and 23 left your `files` table with no FK to `pages` while uploads kept going. The window is closed. DDL either commits entirely or not at all.

The visible win: `gbrain doctor --locks` works. Before v0.18.2 the 57014 timeout error told you to run this command, but the flag didn't exist. Now it does. It shows you every idle-in-transaction backend older than 5 minutes and gives you the exact `pg_terminate_backend(<pid>)` to free them up. One command, one paste, done.

The large-brain win: `CREATE INDEX CONCURRENTLY` no longer gets killed at 2 minutes. The migration runner now reserves a dedicated connection and sets session-level `statement_timeout='600000'` before running non-transactional DDL. Brains at 500K+ pages can run the next schema change without timing out silently.

### The numbers that matter

Counted against the v0.18.0 field report (the production upgrade that prompted this release):

| Metric | BEFORE v0.18.2 | AFTER v0.18.2 | Δ |
|--------|----------------|---------------|---|
| Field-report issues causing production failure | 8 | 0 | −8 |
| Integrity windows between migrations | 1 (v21 → v23) | 0 | −1 |
| `CREATE INDEX CONCURRENTLY` exposed to 2-min timeout | yes | no (10-min override) | fixed |
| Agent-runnable lock diagnostic | missing | `gbrain doctor --locks` | added |
| Regression tests on hardening paths | structural SQL asserts only | 10 unit + 11 real-PG E2E | +21 |
| 57014 error: references a flag that exists | no | yes | fixed |

The striking number: 3 of the 11 findings in this release came from a second AI model (codex) reviewing the plan after the first model (Claude) had already cleared CEO + Eng review. Two-model review catches what one-model review misses. The migration-21 integrity window in particular would have shipped as a new bug if the plan hadn't been challenged.

### What this means for your workflow

Most users: run `gbrain upgrade`. Nothing else to do. Existing brains at schema v21 or v22 are safe, the old FK stayed intact through the original PR #356 path, and the new atomic commit means a future crash can't leave you stranded.

If a migration hits `statement_timeout`, the error message now tells you exactly what to do: `gbrain doctor --locks` to find the blocker, terminate, re-run `gbrain apply-migrations --yes`, verify with `gbrain doctor`. Four commands, top-to-bottom.

Running a 500K-page brain on Supabase? The next migration that touches a hot table won't hang silently on you.

### Itemized changes

#### Added

- `gbrain doctor --locks`: lists idle-in-transaction backends older than 5 minutes with PID + `pg_terminate_backend` commands. Exits 1 when blockers found. `--json` emits structured output. Postgres-only; PGLite prints "not applicable".
- `BrainEngine.withReservedConnection(fn)`: runs callback on a dedicated pool connection. Postgres via `sql.reserve()`, PGLite as a pass-through.

#### Changed

- Migration 21 split into engine-specific paths. Postgres is additive-only (adds `pages.source_id` + index). PGLite gets the full UNIQUE-key swap inline. The FK drop + UNIQUE swap that used to live in v21 moved into v23's handler.
- Migration 23 handler now wraps its entire DDL sequence (FK drop, UNIQUE swap, `files.source_id` + `files.page_id` addition, `page_id` backfill, `file_migration_ledger` creation) in a single `engine.transaction()`. Atomic commit; process-death rolls back to v22 state.
- Non-transactional migrations (`CREATE INDEX CONCURRENTLY`) now run on a reserved connection with session-level `SET statement_timeout='600000'`. Safe on PgBouncer transaction pooling because the connection is isolated from the shared pool.
- 57014 (`statement_timeout`) diagnostic rewritten to the 4-part pattern: what happened, why, exact commands to fix, how to verify.

#### Fixed

- Migration 21 integrity window. Previously v21 dropped `files_page_slug_fkey` and persisted `config.version=21`, but the replacement `files.page_id` column wasn't added until v23. Process-death between them left `files` unconstrained while `file_upload` / `gbrain files` kept accepting writes. The FK drop now lives inside v23's atomic transaction.
- `gbrain doctor --locks` flag referenced by the v0.18.0 57014 error message but not implemented. The flag exists now.

#### For contributors

- `setSessionDefaults(sql)` helper in `src/core/db.ts` absorbs the duplicated `idle_in_transaction_session_timeout` block from `postgres-engine.ts`. Both connect paths call the helper; the SET appears exactly once in source.
- `getIdleBlockers(engine)` exported from `src/core/migrate.ts`: single source of truth for the `pg_stat_activity` query. Shared by the pre-flight warning and `gbrain doctor --locks`.
- `ReservedConnection` interface exposes `executeRaw(sql, params?)` only. Minimal surface, easy to mock. Not safe to call from inside `transaction()`; the interface doc says so.
- `test/e2e/helpers.ts` adds `runMigrationsUpTo(engine, targetVersion)` + `setConfigVersion(version)`: enables mid-chain migration tests that neither `gbrain init --migrate-only` nor the existing `setupDB()` supported.
- `test/migrate.test.ts`: 10 new regression guards (`Math.max` robustness under array scrambling, `getIdleBlockers` shape across engines, 57014 catch path structural check, pre-flight warning, `setSessionDefaults` DRY, reserved-connection usage in `runMigrationSQL`).
- `test/e2e/migrate-chain.test.ts` (new): 11 E2E tests against real Postgres covering post-chain schema invariants, `doctor --locks` real-connection detection, `runMigrationsUpTo` advancement semantics, `withReservedConnection` round-trip.

Credit: codex plan-review caught the migration-21 integrity window, the non-transactional DDL timeout gap, and the missing `doctor --locks` CLI. The initial Claude review and the Claude-model eng review both missed them.

## To take advantage of v0.18.2

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor`
warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Verify the outcome:**
   ```bash
   gbrain doctor              # schema_version should match latest
   gbrain doctor --locks      # should exit 0 (no idle-in-tx blockers)
   ```
3. **If `statement_timeout` fires during migration,** the new 4-part diagnostic
   tells you exactly what to do: run `gbrain doctor --locks`, terminate
   blockers, re-run `gbrain apply-migrations --yes`.
4. **If anything fails,** file an issue: https://github.com/garrytan/gbrain/issues
   with output of `gbrain doctor` and `~/.gbrain/upgrade-errors.jsonl` (if it
   exists).

---

## [0.18.1] - 2026-04-22

## **Row Level Security hardening pass.**
## **Fresh installs secure by default. Existing brains are brought up to the same bar automatically on upgrade.**

A security-posture tightening release. `gbrain doctor` now enforces RLS across the entire `public` schema (not a hardcoded allowlist), the base schema ships every gbrain-managed table with RLS enabled, and an automatic migration runs on `gbrain upgrade` to bring older installs to the same state. After `gbrain upgrade` (or `gbrain apply-migrations --yes`), `gbrain doctor` should report clean on healthy brains.

The doctor check severity upgrades from `warn` to `fail`. Missing RLS is a security issue, not a suggestion. `gbrain doctor` exits 1 when any public table is missing RLS. If you wrap `gbrain doctor` in a cron or CI health check, expect it to flip red on setups that haven't upgraded.

There is an escape hatch for tables you deliberately want readable by the anon key (analytics views, public materialized views, plugin tables that use anon reads on purpose). It is a Postgres `COMMENT ON TABLE` with a `GBRAIN:RLS_EXEMPT reason=<why>` prefix. No CLI subcommand. You drop to psql and type the reason. Full details in [docs/guides/rls-and-you.md](docs/guides/rls-and-you.md). The escape hatch is deliberately painful because the default should be closed.

### What changes

| Area | BEFORE v0.18.1 | AFTER v0.18.1 |
|------|----------------|---------------|
| Scope of doctor RLS check | hardcoded allowlist | every `pg_tables` row in `public` |
| Severity when RLS missing | warn (exit 0) | fail (exit 1) |
| Escape hatch for intentional anon-readable tables | none | `GBRAIN:RLS_EXEMPT reason=...` pg comment |
| Identifier-safe remediation SQL | no | yes (`ALTER TABLE "public"."<name>"`) |
| PGLite doctor output for RLS | misleading warn | clean `ok` with skip reason |
| Exemption list surfaced on every doctor run | n/a | enumerated by name |

### What this means for your workflow

Existing Supabase brains: run `gbrain upgrade`, then `gbrain doctor`. Everything managed by gbrain should report clean. If doctor flags something, it's a plugin, user-created, or extension table — the message names each one and gives you the exact `ALTER TABLE` line.

PGLite brains (the `gbrain init` default): nothing to do. RLS is irrelevant on embedded Postgres. Doctor skips the check with an explicit message.

Cron and CI wrappers: audit them. The exit-code flip is the one breaking change in this release. If a table is anon-readable on purpose, use the `GBRAIN:RLS_EXEMPT` comment escape hatch rather than silencing the whole check.

Credit: Garry's OpenClaw for the original check-widening PR (#336). Codex found additional gaps during plan review.

## To take advantage of v0.18.1

`gbrain upgrade` should do this automatically. It runs `gbrain post-upgrade`,
which calls `gbrain apply-migrations --yes`, which runs the v0.18.1 orchestrator.
If `gbrain doctor` still reports missing RLS after upgrade:

1. **Apply migrations manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Re-run the health check:**
   ```bash
   gbrain doctor
   ```
3. **If specific tables still fail**, the doctor message names each one and gives you the fix. Example:
   ```
   1 table(s) WITHOUT Row Level Security: my_plugin_state. Fix: ALTER TABLE "public"."my_plugin_state" ENABLE ROW LEVEL SECURITY;
   ```
4. **If a table should stay readable by the anon key on purpose**, use the escape hatch (see `docs/guides/rls-and-you.md`):
   ```sql
   COMMENT ON TABLE public.my_analytics_view IS
     'GBRAIN:RLS_EXEMPT reason=analytics-only, anon-readable ok, owner=you, date=2026-04-22';
   ```
5. **If any step fails or the numbers look wrong**, please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor --json`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

- **Schema + migration:** `src/schema.sql` and `src/core/schema-embedded.ts` ensure every gbrain-managed public table ships with RLS enabled for fresh installs. A new schema migration in `src/core/migrate.ts` backfills existing brains to the same state. The migration is gated on `rolbypassrls` and fails loudly if the current role lacks BYPASSRLS (so `schema_version` stays at the prior value and retries cleanly after role assignment).
- **Upgrade orchestrator:** New `src/commands/migrations/v0_18_1.ts` wires the schema migration into the `gbrain apply-migrations --yes` path (mirrors v0.18.0's Phase A pattern).
- **Doctor check widened:** `src/commands/doctor.ts` RLS check now scans every public table from `pg_tables` rather than a hardcoded allowlist. Severity upgraded `warn → fail`. Success message shows table count. Failure message includes per-table quoted `ALTER TABLE "public"."<name>" ENABLE ROW LEVEL SECURITY;` remediation SQL.
- **Escape hatch — "write it in blood":** Doctor reads `obj_description` for each non-RLS public table. Tables whose comment matches `^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}` count as explicitly exempt. Exempt tables are enumerated by name on every successful doctor run so the exemption list never goes invisible. No CLI subcommand — deliberate friction; operators must set the comment in psql.
- **PGLite skip:** PGLite is embedded and single-user with no PostgREST; the RLS check now skips on PGLite with an explicit `ok` message ("Skipped — no PostgREST exposure, RLS not applicable") instead of the misleading `warn` it emitted before. Partial polish: pgvector, jsonb_integrity, and markdown_body_completeness checks still hit the same `getConnection()` throw → warn pattern on PGLite. Separate follow-up.
- **Tests:**
  - `test/doctor.test.ts` gains source-grep structural regression guards covering scan scope, fail severity + quoted-identifier remediation, PGLite skip wrapper, and `GBRAIN:RLS_EXEMPT` parsing.
  - `test/e2e/mechanical.test.ts` `E2E: RLS Verification` block rewritten. The old allowlist-query test is replaced with an every-public-table-has-RLS assertion; new CLI-spawn tests verify fail-on-no-RLS (with exit code + ALTER TABLE in JSON message), exempt-with-valid-reason passes, empty-reason exemption fails, and unrelated comment still fails. All helpers use `try/finally` with unique suffix-per-run table names.
  - `test/migrate.test.ts` gains a structural guard for the new migration: exists, name matches, BYPASSRLS gating present, LATEST_VERSION has advanced.
- **Docs:** new `docs/guides/rls-and-you.md` — one-page explainer covering why RLS matters, what to do when doctor fails, the escape hatch format + rules, auditing exemptions, PGLite behavior, self-hosted Postgres framing.
- **Version reconciliation:** `VERSION` and `package.json` land on `0.18.1`.
- **CHANGELOG privacy sweep:** replaced a stale private-fork credit in the 0.17.0 entry with "Garry's OpenClaw" per the [CLAUDE.md privacy rule](CLAUDE.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [0.18.0] - 2026-04-22

## **Multi-source brains. One database, many repos. Federated or isolated, you choose.**
## **`gbrain sources` is the new subcommand. `.gbrain-source` is the new dotfile.**

A single gbrain database can now hold multiple knowledge repos — your wiki, your gstack checkout, your yc-media pipeline, your garrys-list essays — with clean scoping per source. Slugs are unique per source, not globally, so two sources can both have `topics/ai` and they are different pages. Every page, every file, every ingest_log row is scoped to a `sources(id)` row.

Per-source federation controls whether a source participates in unqualified default search. `federated=true` is cross-recall (your wiki + gstack both show up when you search "retry budgets"). `federated=false` is isolation (your yc-media content never leaks into your personal writing searches). Flip with `gbrain sources federate <id>` / `unfederate <id>`.

Per-directory default via `.gbrain-source` dotfile walk-up + `GBRAIN_SOURCE` env var. Same mental model as kubectl / terraform / git: `cd ~/yc-media && gbrain query "X"` just works, no `--source` flag needed. Resolution priority: explicit flag > env > dotfile > registered-path-longest-prefix > `sources.default` config > literal `default` fallback.

### The numbers that matter

9 bisectable commits. 4 new schema migrations. ~85 new tests. Full suite: 2063 pass / 17 fail (the 17 pre-existing master timeouts unchanged). Migration chain runs end-to-end against real PGLite in under 1 second for the integration test.

| Metric | BEFORE v0.17 | AFTER v0.18 | Δ |
|---|---|---|---|
| Max repos per brain | 1 | unlimited | unbounded |
| Slug uniqueness | global | per-source | composite |
| Multi-source search | impossible | default (for federated) | native |
| New CLI commands | — | 9 (`sources add/list/remove/rename/default/attach/detach/federate/unfederate`) | +9 |
| Schema migrations shipped | 0 new | 4 (v20-v23) | +4 |
| New unit + integration tests | — | ~85 | +85 |

### What this means for agents

When a brain has multiple sources, every search result carries `source_id`. Agents cite in `[source-id:slug]` form — `[wiki:topics/ai]` or `[gstack:plans/retry-policy]` — so the user can trace which repo each fact came from. The citation key is `sources.id` (immutable), so renaming a source's display name via `gbrain sources rename` never breaks existing citations.

Back-compat is total. Pre-v0.18 brains upgrade into a seeded `default` source with `federated=true`, and their existing code paths target `default` via a schema DEFAULT clause. You literally do not have to change anything to upgrade; you only change things if you want to add a second source.

## To take advantage of v0.18.0

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor`
warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v0.18.0.md` the next time you interact with it.** The migration chain is fully mechanical (v20 creates the sources table, v21 adds pages.source_id + composite UNIQUE, v22 adds links.resolution_type, v23 adds files.source_id + page_id + file_migration_ledger). No manual data work needed.
3. **Verify the outcome:**
   ```bash
   gbrain sources list     # should show 'default' federated, with your existing page count
   gbrain stats            # existing behavior unchanged
   gbrain doctor
   ```
4. **To start using multi-source:**
   ```bash
   gbrain sources add gstack --path ~/.gstack --no-federated
   cd ~/.gstack && gbrain sources attach gstack
   gbrain sync --source gstack
   ```
5. **If any step fails or the numbers look wrong,** please file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

### Itemized changes

#### Added

- **`gbrain sources` subcommand group** — add, list, remove, rename, default, attach, detach, federate, unfederate. See `docs/guides/multi-source-brains.md` for three canonical scenarios (unified wiki+gstack / purpose-separated yc-media+garrys-list / mixed).
- **`sources` table** — first-class multi-repo primitive. `(id, name, local_path, last_commit, last_sync_at, config)`. Citation key is `sources.id`, immutable, validated `[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?`.
- **`pages.source_id` column + composite UNIQUE (source_id, slug)** — slugs unique per source. DEFAULT 'default' on the column so existing single-source callers target the default source automatically via schema default.
- **`.gbrain-source` dotfile** — walk-up resolution like kubectl/terraform/git. `gbrain sources attach <id>` writes it in CWD. Auto-selects the source for any command run from that directory or any subdirectory.
- **`GBRAIN_SOURCE` env var** — power-user / CI / script escape hatch. Second highest priority in resolution (after explicit `--source <id>`).
- **Qualified wikilink syntax `[[source:slug]]`** — new in v0.18 extractor. Unqualified `[[slug]]` still resolves via local-first fallback. `links.resolution_type ENUM('qualified','unqualified')` records which kind each edge is for future `gbrain extract --refresh-unqualified` re-resolution.
- **`files.source_id` + `files.page_id`** — files now scope per source + reference pages by id (not slug). `file_migration_ledger` drives the S3/Supabase object rewrite under the pending → copy_done → db_updated → complete state machine.
- **`gbrain sync --source <id>`** — per-source sync reads local_path + last_commit from the sources table, writes last_sync_at back. Single-source brains keep using the pre-v0.17 `sync.repo_path` / `sync.last_commit` config keys unchanged.

#### Changed

- **Search dedup is now source-aware.** Pre-v0.18 keyed on slug alone; under composite uniqueness that would collapse two same-slug pages in different sources. `pageKey(r) = source_id:slug` is the one canonical helper across all four dedup layers + compiled-truth guarantee. Codex review flagged this as regression-critical.
- **`SearchResult.source_id` optional field** — populated by engine SELECT JOINs. Falls back to `'default'` for pre-v0.18 rows that lacked the column.
- **Migration runner sorts by version** — if anyone adds a migration out of order in `MIGRATIONS[]`, the sort guards against silent skips.

#### Migrations

- **v20** `sources_table_additive` — additive-only. Creates sources table + seeds default row with `{"federated": true}`. Inherits existing `sync.repo_path` / `sync.last_commit`.
- **v21** `pages_source_id_composite_unique` — adds `pages.source_id` with DEFAULT, swaps global `UNIQUE(slug)` for composite `UNIQUE(source_id, slug)`. Lands atomically with the engine's `ON CONFLICT (source_id, slug)` rewrite.
- **v22** `links_resolution_type` — adds `links.resolution_type` CHECK column.
- **v23** `files_source_id_page_id_ledger` — Postgres-only (PGLite has no files table). Adds `files.source_id` + `files.page_id`, backfills `page_id` from legacy `page_slug`, creates `file_migration_ledger`.

#### Tests

- `test/sources.test.ts` (14 tests) — CLI dispatcher, validation, overlapping-path guard.
- `test/source-resolver.test.ts` (14 tests) — full 6-priority resolution coverage including longest-prefix match.
- `test/storage-backfill.test.ts` (13 tests) — state machine + 3 crash-point recovery tests (Codex flagged each).
- `test/multi-source-integration.test.ts` (16 tests) — end-to-end against real PGLite, migration chain v2→v23.
- `test/link-extraction.test.ts` (+6) — qualified `[[source:slug]]` parsing + masking + v22 structural.
- `test/dedup.test.ts` (+4) — regression-critical source-aware composite key tests.
- `test/migrate.test.ts` (+18) — v20/v21/v22/v23 structural assertions.

#### Docs

- `docs/guides/multi-source-brains.md` — new getting-started guide (federated / isolated / mixed scenarios).
- `skills/migrations/v0.18.0.md` — agent-facing migration skill.
- `skills/brain-ops/SKILL.md` — new "Cross-source citation format" section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [0.17.0] - 2026-04-22

## **`gbrain dream`. Run the brain maintenance cycle while you sleep.**
## **One primitive, two CLIs. Autopilot gains lint + orphan sweep automatically.**

The README has promised "the dream cycle" for a year. v0.17 makes it real as a first-class command. `gbrain dream` runs one maintenance cycle and exits, designed for cron. Same six phases as `gbrain autopilot` — they both delegate to the new `runCycle` primitive in `src/core/cycle.ts`. One source of truth for what your brain does overnight.

Phase order is semantically driven: **fix files first, then index them**. Lint and backlinks write to disk. Sync picks them up into the DB. Extract links the graph. Embed refreshes vectors. Orphan sweep reports the gaps. If your autopilot daemon was doing sync-before-lint (which PR #309's original dream.ts also got wrong), your fixes landed the next cycle instead of the current one. Fixed.

Autopilot users upgrading get lint + orphan sweep for free. No config change. `gbrain jobs list` shows the full 6-phase report now. If you don't want the daemon modifying files, `gbrain dream --phase orphans` in cron keeps autopilot for embed+sync and gives you manual control over the writes.

### The numbers that matter

Measured against a v0.16 baseline. Lines-of-code delta is net-small: runCycle adds ~500 lines, but the new dream.ts is 80 lines (vs the 446-line original in PR #309), and autopilot's two-path branching collapses to one delegated call.

| Metric | BEFORE v0.17 | AFTER v0.17 | Δ |
|--------|--------------|-------------|---|
| `gbrain dream --dry-run` mutates DB | Yes (full-sync + embed silently wrote) | No (every phase honors dry-run) | correctness |
| Sources of truth for "the cycle" | 3-4 (dream inline, dream shell-outs, autopilot inline, Minions handler) | 1 (`runCycle`) | DRY win |
| Phase order: fix-then-index | No (sync before lint) | Yes (lint → backlinks → sync → extract → embed → orphans) | semantics |
| Coordination across daemon + cron + Minions worker | Lockfile heuristic with 6 known holes | DB lock table + PID-liveness file lock | primitive upgrade |
| Works under PgBouncer transaction pooling | No (session-scoped `pg_try_advisory_lock`) | Yes (TTL row, refreshed between phases) | Supabase-safe |
| `findRepoRoot` walks into wrong git repo | Yes (10 levels of cwd) | No (explicit --dir OR configured sync.repo_path) | footgun fixed |
| Autopilot daemon phase count | 4 (sync+extract+embed+backlinks in Minions mode; no backlinks inline) | 6 (+lint +orphans) | feature parity |
| CycleReport shape stability for agents | N/A | `schema_version: "1"` (stable, additive only) | API contract |

### What this means for your workflow

Cron users: one line. `0 2 * * * gbrain dream --json >> /var/log/gbrain-dream.log`. You get a structured `CycleReport` every morning with per-phase timing, counts, and any errors tagged with `{class, code, message, hint, docs_url}`.

Autopilot users: nothing to do. Your daemon picks up the new phases on next cycle. If you want to see them: `gbrain jobs get <autopilot-cycle-id>` shows the full report.

Reviewers/codex caught three plan-breakers during multi-round review that would have shipped silent DB writes on dry-run: (1) `performSync`'s full-sync path was ignoring `opts.dryRun`, (2) `runEmbedCore` had no dry-run mode and returned void, (3) `findOrphans` used `db.getConnection()` global and didn't compose with a passed engine. All three are fixed as preconditions (commits 1-3 of the 6-commit bisectable series).

Credit: Garry's OpenClaw for the original `gbrain dream` thesis (PR #309). The brand-promise framing survived; the implementation got redesigned from scratch around the runCycle primitive after CEO + Eng + Codex + DX review found structural issues.

## To take advantage of v0.17.0

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the migration orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v0.17.0.md` the next time you interact with it.** No mechanical host-repo action required; the schema migration (v16 cycle-lock table) and the behavior shift in autopilot's inline path both apply automatically.
3. **Verify the outcome:**
   ```bash
   gbrain dream --help                              # new command exists
   gbrain dream --dry-run --json                    # safe preview
   gbrain doctor                                    # should show no pending migrations
   ```
   Autopilot users: `gbrain jobs list --status complete | head -5` and inspect an `autopilot-cycle` job with `gbrain jobs get <id>` — the report now includes 6 phases.
4. **If any step fails or the numbers look wrong,** please file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**New CLI command: `gbrain dream`**
- One-shot maintenance cycle for cron. Exits when done. Flags: `--dry-run`, `--json`, `--phase <name>`, `--pull`, `--dir <path>`, `--help`.
- `--help` shows cron example + cross-reference to `autopilot --install` for continuous daemon.
- Empty-state output is intentionally satisfying: `Brain is healthy. 6 phase(s) checked in 2.3s.` Agents detect it via `status: "clean"`.
- Exit code 1 on `status: "failed"`. Warnings (`status: "partial"`) are not failures — don't page someone.
- `--dir` OR `sync.repo_path` config required. No more walk-up-cwd-for-.git footgun.

**New primitive: `src/core/cycle.ts`**
- `runCycle(engine: BrainEngine | null, opts: CycleOpts): Promise<CycleReport>`.
- Six phases in order: lint → backlinks → sync → extract → embed → orphans.
- `CycleReport` has `schema_version: "1"` (stable, additive). `status: 'ok' | 'clean' | 'partial' | 'skipped' | 'failed'` with `reason` field on skipped.
- `PhaseResult.error: { class, code, message, hint?, docs_url? }` on fail. Stripe-API-tier structured errors.
- `yieldBetweenPhases` hook awaited between every phase + before return. Required for Minions worker lock renewal. Exceptions non-fatal.
- Engine nullable — filesystem phases run without DB; DB phases skip with `reason: "no_database"`.
- Lock-skip: read-only phase selections (`--phase orphans`) skip lock acquisition.

**New schema: `gbrain_cycle_locks` (migration v16)**
- DB lock table with TTL (30 min), replaces session-scoped `pg_try_advisory_lock` which the v0.15.4 PgBouncer-transaction-pooler fix silently broke.
- Refreshed between phases via the yield hook. Crashed holders auto-release on TTL expiry.
- PGLite + engine=null use a file-based fallback at `~/.gbrain/cycle.lock` with PID-liveness check (EPERM treated as alive so PID 1 holders aren't mis-classified).

**Autopilot + Minions integration**
- Autopilot's inline fallback path (`--inline` flag + PGLite mode) now delegates to `runCycle`. Gains lint + orphan phases it didn't run before. Uses `pull: true` by default (preserves pre-v0.17 pull semantics).
- Minions `autopilot-cycle` handler (in `src/commands/jobs.ts`) also delegates to `runCycle`. Returns `{ partial, status, report }` so `gbrain jobs get <id>` surfaces the full structured report.
- `gbrain autopilot --install` install/uninstall/launchd/systemd/crontab machinery untouched.
- `gbrain autopilot --help` now cross-references `gbrain dream`.

**Precondition fixes (required for the runCycle primitive to compose cleanly)**
- `src/commands/sync.ts`: `performFullSync` honors `opts.dryRun` in first-sync + `--full` paths. Was silently calling `runImport` regardless. `SyncResult.embedded: number` field added; `first_sync` path now returns real counts from `runImport` (was hardcoded to 0).
- `src/commands/embed.ts`: `runEmbedCore` adds `dryRun?: boolean` opt and returns `EmbedResult { embedded, skipped, would_embed, total_chunks, pages_processed, dryRun }` instead of `void`. `gbrain embed --stale --dry-run` is now a safe preview.
- `src/commands/orphans.ts`: `findOrphans(engine, opts)` takes a `BrainEngine` parameter. Added `findOrphanPages()` method to `BrainEngine` interface + implementations on both `postgres-engine` and `pglite-engine`. Drops `db.getConnection()` global — findOrphans now composes with test-injected engines and works on PGLite.

**Tests (all run in CI, no DATABASE_URL or API keys required)**
- `test/sync.test.ts`: 4 new cases. First-sync dry-run, incremental dry-run, `--full` dry-run, SyncResult.embedded shape. PGLite + temp git repo.
- `test/embed.test.ts`: 4 new cases. Dry-run with stale chunks, dry-run stale-vs-fresh split, dry-run --slugs, non-dry-run regression guard. Mocked `embedBatch`.
- `test/orphans.test.ts`: 4 new cases. Engine-injected findOrphans, includePseudo flag, queryOrphanPages delegation, empty-brain edge. PGLite.
- `test/core/cycle.test.ts` (new): 18 cases covering dryRun × phases × lock_held × engine-null. Shared PGLite engine per describe via beforeAll + truncateCycleLocks (cuts test time ~3x vs per-test init).
- `test/dream.test.ts` (rewritten, 11 cases): brainDir resolution, phase selection, phase validation, JSON output shape, dry-run propagation, exit-code semantics. Real PGLite + real library calls (no `mock.module` to avoid leakage).

**Docs**
- `skills/migrations/v0.17.0.md`: new. Informational, no mechanical action required.
- `CHANGELOG.md` + `CLAUDE.md`: updated.

**PR #309 disposition**
- Closed with credit to @knee5. Their thesis ("`gbrain dream` as first-class CLI verb") was right; the implementation got redesigned around the runCycle primitive after deep review surfaced structural issues in the fold approach.
- `Co-Authored-By` preserved on commit 5 (the dream.ts rewrite).

---

## [0.16.4] - 2026-04-22

## **`gbrain check-resolvable` ships. The command the README promised for weeks.**
## **Agents and CI finally have a one-shot skill-tree gate that actually exits non-zero when anything is off.**

The `resolver_health` logic has lived inside `gbrain doctor` since v0.11. The README claimed a standalone `gbrain check-resolvable` shipped too ... it didn't. Scripts referenced it. Skillify's 10-item checklist referenced it. The binary just shrugged. Fixed.

`gbrain check-resolvable` runs the same four checks doctor runs (reachability, MECE overlap, MECE gap, DRY violations) but with a stricter contract: **exits 1 on any issue, errors AND warnings**. Doctor's resolver_health block still exits 0 on warnings-only because doctor has 15 other checks to lean on. The standalone command has nowhere to hide. CI can finally gate on a single command instead of parsing `gbrain doctor --json`.

The JSON output is a stable envelope, one shape for success and error: `{ok, skillsDir, report, autoFix, deferred, error, message}`. No more "did it succeed? let me see which keys are present." The `deferred` array names the two checks still pending (trigger routing eval, brain filing) with links to their tracking issues, so agents reading the JSON know the current coverage boundary.

`scripts/skillify-check.ts` is now machine-gated. Item #8 on the skillify 10-item checklist used to print "run: gbrain check-resolvable" and pass unconditionally. Now it subprocess-calls the real command and asserts on the exit code. Binary-missing fails loud instead of silently passing ... the kind of silent false-pass that used to put broken skills on the shelf.

## To take advantage of v0.16.4

No migration needed. `gbrain upgrade` brings the binary; nothing to apply. Try it:

```bash
gbrain check-resolvable                  # human output, like doctor's resolver section
gbrain check-resolvable --json | jq .ok  # machine-readable gate for CI
gbrain check-resolvable --fix --dry-run  # preview DRY auto-fixes without writing
```

Wire it into your CI:

```bash
gbrain check-resolvable || exit 1        # fails the build on any warning/error
```

### Itemized changes

**New command**
- `gbrain check-resolvable [--json] [--fix] [--dry-run] [--verbose] [--skills-dir PATH] [--help]` — standalone skill-tree gate. Covers reachability, MECE overlap, MECE gap, DRY violations. Exits 1 on any issue.
- Stable JSON envelope (`ok`, `skillsDir`, `report`, `autoFix`, `deferred`, `error`, `message`) — one shape for both success and error paths.
- `--fix` auto-applies DRY fixes via `autoFixDryViolations` before re-checking (same ordering as `doctor --fix`).
- `--dry-run` with `--fix` previews without writing; the JSON `autoFix.fixed` array shows what would change.
- `--verbose` prints the Deferred checks note with issue URLs so nobody forgets Checks 5 and 6 are still tracked.

**Deferred to separate issues**
- Check 5: trigger routing eval — verify every skill's own frontmatter trigger routes to itself in RESOLVER.md. Surfaced via the CLI's `deferred[]` output block.
- Check 6: brain filing validation — verify mutating skills register the brain directories they write to. Same surface.

**Shared refactor**
- `src/core/repo-root.ts` — extracted `findRepoRoot()` from `doctor.ts` to a zero-dependency shared module with a parameterized `startDir` for test hermeticity. Doctor imports the shared version; no behavior change (default arg matches prior semantics).
- `src/commands/doctor.ts` — updated to import the shared `findRepoRoot`.

**Skillify integration**
- `scripts/skillify-check.ts` — item #8 ("check-resolvable gate") now subprocess-calls `gbrain check-resolvable --json` and gates on the exit code. Result is cached per process so iterating many skills only runs the subprocess once. Binary-missing fails loud via explicit `spawn` error handling ... no silent false-pass.

**Tests (22 new cases)**
- `test/repo-root.test.ts` — 4 cases for the extracted `findRepoRoot()` (first-iter hit, walks up, returns null, default arg behavioral parity).
- `test/check-resolvable-cli.test.ts` — 17 cases split between direct unit tests (flag parsing, resolveSkillsDir, DEFERRED constants) and subprocess integration tests (help, JSON envelope shape, exit-code regression gates for warnings AND errors, `--fix --dry-run` wiring, `--verbose` output).
- `test/skillify-check.test.ts` — 2 new cases for the check-resolvable wiring: loud failure when binary is missing (no silent pass), happy path when a synthetic gbrain returns `ok: true`.

**Contract note for CI users**
- `gbrain check-resolvable` exits 1 on warnings AND errors. `gbrain doctor`'s resolver_health block still exits 0 on warnings-only. If you scripted against doctor's looser gate, `check-resolvable` will bite harder ... on purpose. This honors the README:259 contract: "Exits non-zero if anything is off."

---

## [0.16.3] - 2026-04-22

## **`gbrain agent run` actually runs now. The subagent SDK wiring that shipped broken in v0.16.0 is fixed.**
## **Every `.ts` file in the repo typechecks on every `bun run test`. Silent regressions end here.**

v0.16.0 shipped with the headline feature, `gbrain agent run`, unable to make a single LLM call. `makeSubagentHandler` cast `new Anthropic()` straight to `MessagesClient`, but the SDK exposes `.create()` at `sdk.messages.create`, not on the top-level client. Every subagent job in production died on the first call with `client.create is not a function`. The type system would have caught it. Nothing was running the type system.

The root cause isn't the casting bug. It's that `bun test` transpiles TypeScript without type-checking it, and `bun test` was the entire CI pipeline. Invalid types ran until they hit runtime. This release fixes the symptom (one-line change, `deps.client ?? new Anthropic().messages`, which typechecks cleanly against `MessagesClient` because `sdk.messages` IS the right object) and closes the hole that let it ship (`tsc --noEmit` now runs on every `bun run test`, and the CI workflow runs `bun run test` not `bun test`). Two independent guards: anyone reverting to `new Anthropic()` fails the type check; a new regression test drives one handler turn through an injected fake SDK and fails loudly if the factory default branch breaks.

Closing the CI gap surfaced 100+ pre-existing type errors across 30+ files: `databaseUrl` → `database_url` rename drift, missing `"meeting"` / `"note"` entries in the `PageType` union that both src and tests already used, a Buffer-as-BodyInit assignment in the Supabase uploader, dead-code comparisons against narrowed status types in the migration orchestrators, and several `as X` casts that TS 5.6 requires be spelled `as unknown as X`. All cleaned up. The first tsc run is green.

### The numbers that matter

From the merged branch after both the fix and the infra cleanup landed locally against master.

| Metric | Before | After | Δ |
|---|---|---|---|
| `bun run typecheck` errors | 104 | 0 | -104 |
| `gbrain agent run` in prod | 100% failure on first LLM call | Works | ✅ |
| Test file count | ~75 | ~75 (+1 regression test block) | +1 |
| `bun run test` pass rate | 1962 pass / 4 fail (PGLite flake under parallel load) | 1997 pass / 0 fail | +35 pass, -4 fail |
| CI test-gate steps | `bun test` (no type check) | `bun run test` (jsonb guard + progress-to-stdout guard + `tsc --noEmit` + `bun test`) | 1→4 |
| Regression guards on this bug class | 0 | 2 (compile-time via `tsc`, runtime via `makeAnthropic` injection test) | +2 |

The 104 → 0 isn't a refactor. Every error was a real correctness signal TS had been trying to send that nobody was listening for. Most were trivial to fix (`as unknown as X`, one missing union member, one rename propagation). The Buffer/BodyInit one in Supabase upload is a live bug — `fetch(url, {body: buf})` works today in Node/Bun but has no type guarantee; the fix copies `data.buffer, data.byteOffset, data.byteLength` into a `Uint8Array` slice that is genuinely assignable to `BodyInit`.

### What this means for operators

`gbrain agent run "say hello"` against a Supabase brain completes end-to-end after this upgrade. No stuck subagent jobs, no `client.create is not a function` traceback. v0.16.0 users should upgrade immediately — the feature that release was named for did not work.

### Itemized changes

#### `gbrain agent run` now works against the real Anthropic SDK

- `src/core/minions/handlers/subagent.ts` — factory default construction replaced with `const client: MessagesClient = deps.client ?? makeAnthropic().messages`. The SDK's `Messages` resource is already the right object; no helper, no wrapper, no `.bind()` needed (method-call semantics preserve `this`). `const makeAnthropic = deps.makeAnthropic ?? (() => new Anthropic())` adds a dependency-injection seam so tests can exercise the default branch without a real API key or network call.
- `test/subagent-handler.test.ts` — new `describe('makeSubagentHandler default client construction')` block drives a full handler turn through a fake SDK injected via `makeAnthropic`. If anyone reverts `.messages` or reintroduces a `new Anthropic()` top-level cast, this test fails loudly.

#### CI type-checking is now real

- `package.json` — added `typescript@^5.6.0` as devDep; added `"typecheck": "tsc --noEmit"` script; chained `bun run typecheck` into `"test"` so local `bun run test` and CI run identical pipelines (grep guards + typecheck + bun test).
- `.github/workflows/test.yml` — CI now runs `bun run test` (the npm script) instead of `bun test` (the runner). One line. Biggest-leverage change in the release.

#### 100+ pre-existing type errors cleaned up

So `tsc --noEmit` actually stays green. All mechanical, zero behavior change. Groups:

- **`databaseUrl` → `database_url` rename drift** in 9 test fixtures (test/agent-cli, test/brain-allowlist, test/minions-shell, test/minions, test/queue-child-done, test/rate-leases, test/subagent-handler, test/subagent-transcript, test/wait-for-completion).
- **`PageType` union** in `src/core/types.ts` gained `'meeting'` and `'note'` entries. Both were already used in src (`link-extraction.ts` had a code comment acknowledging the gap) and across 6 test files. The union was just out of date.
- **`GBrainConfig.storage`** field declared in `src/core/config.ts` — the code at `src/commands/files.ts` and `src/core/operations.ts` was reading `config.storage` with 18 inferred-type errors.
- **`ErrorCode`** union in `src/core/operations.ts` gained `'permission_denied'`; the code was throwing this exact string but the union disagreed.
- **Dead-code comparisons** removed from `src/commands/migrations/v0_12_0.ts`, `v0_12_2.ts`, `v0_13_0.ts`, `v0_16_0.ts` — each orchestrator had an early-return on `a.status === 'failed'` followed later by a redundant check against a then-narrowed type. TS correctly flagged the later check as always-false.
- **postgres.js `Row` callback typing** on `src/core/postgres-engine.ts` — 6 `.map((r: { slug: string }) => r.slug)` callbacks rewritten as `.map((r) => r.slug as string)` to match postgres.js's `Row` generic. Same behavior, correct signature.
- **Buffer → BodyInit** in `src/core/storage/supabase.ts:58,129` — `body: data` (Buffer) replaced with `body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as BodyInit`. Zero-copy view of the same bytes, structurally assignable to `BodyInit`, no runtime change.
- **Various `as X` casts** upgraded to `as unknown as X` where TS 5.6's stricter structural-conversion rules rejected the single-step cast. Affected: `src/core/file-resolver.ts` (3), `src/core/minions/handlers/subagent-aggregator.ts`, `src/core/minions/worker.ts`, `src/commands/orphans.ts`, `src/commands/repair-jsonb.ts`, `src/core/postgres-engine.ts` (2 RowList → array conversions).

#### Test suite stability

- `bunfig.toml` — new file. Sets `[test].timeout = 60_000` globally. PGLite WASM init is slow enough that the default 5-second hook timeout flakes when many test files spin up PGLite instances in parallel on a loaded machine.
- 8 test files (`test/wait-for-completion`, `test/extract-fs`, `test/subagent-handler`, `test/minions-shell`, `test/minions-quiet-hours`, `test/integrity`, `test/e2e/graph-quality`, `test/e2e/search-quality`) additionally declare `beforeAll(fn, 60_000)` / `beforeEach(fn, 15_000)` as explicit safety nets — redundant with `bunfig.toml` today, but stays as belt-and-suspenders if the bunfig schema ever changes.

## To take advantage of v0.16.3

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about anything:

1. **Verify your brain still runs:**
   ```bash
   gbrain doctor
   ```
2. **Verify the agent runtime works:**
   ```bash
   gbrain agent run "say hello"
   ```
   Should complete end-to-end. If it fails with `client.create is not a function`, the upgrade didn't land — run `gbrain upgrade` again.
3. **No migrations required.** No schema changes in this release. Fix is in the handler code, not the DB.
4. **If any step fails,** please file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - output of `gbrain agent run "say hello"`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists

### Itemized changes

---

## [0.16.2] - 2026-04-22

## **The deployment guide now reads like a runbook an agent can execute line-by-line.**
## **Three real bugs from v0.16.1 fixed, nine DX gaps closed.**

v0.16.1 shipped the Minions worker deployment guide. Re-reading it as the agent it was written for, top-to-bottom, copy-pasting every block, surfaced twelve issues a human skim-reader would not catch. Three are real bugs that break a first-time deploy. Nine are structural gaps that force the agent to invent values.

The bugs: the crontab example used `*/5 * * * * user bash /path/...` which is `/etc/crontab` format only, so an agent running `crontab -e` and pasting it got "bad minute" or parsed `user` as the command. The watchdog script grepped `tail -20` of an unrotated log for shutdown markers, so every 5-minute tick after the first restart re-matched the old shutdown line forever and killed the healthy worker on loop. And `DATABASE_URL=postgresql://user:pass@...` lived directly in `/etc/crontab`, which is mode 644 (world-readable).

The gaps: no preconditions block, no "which option should I pick" selector, hardcoded `/path/to/...` and `/my/workspace` throughout with no template-variable legend, no upgrade section (so an agent coming from v0.13.x had no idea `GBRAIN_ALLOW_SHELL_JOBS=1` is now required or that `max_stalled` flipped from 1 to 5), no alternative to bare cron for Fly/Render/systemd deployments, a "Proposed CLI flags (not yet implemented)" block that an agent would copy and get `unrecognized flag`, and a `MinionWorker.maxStalledCount` note that did not tell the agent what to do.

### What this means for operators

The guide is now copy-pasteable without invention. Every `$VAR` is documented in a table at the top. Every code block runs as-is on the target it claims. The watchdog writes a two-line PID file (PID + restart epoch) and the shutdown check only considers log lines newer than the epoch, which is the actual fix for the restart loop. Secrets live in `/etc/gbrain.env` (mode 600), referenced via `BASH_ENV=/etc/gbrain.env` in crontab. A new Option 3 ships a systemd unit, a Procfile, and a fly.toml fragment so Fly/Render/Railway/systemd users skip cron entirely. The upgrade section walks the v0.13.x → v0.16.2 checklist (stop worker, apply migrations, add `GBRAIN_ALLOW_SHELL_JOBS`, swap the watchdog).

The shipped watchdog was verified against an abbreviated end-to-end test (3 ticks in ~30 seconds inside an Ubuntu 22.04 container): tick 1 starts the worker and writes the 2-line PID file; tick 2 sees a shutdown line with a 1-hour-old timestamp and correctly does nothing; tick 3 sees a fresh shutdown line and correctly restarts. The regex was caught and fixed during the test when mawk rejected `{n}` interval quantifiers. The systemd unit was smoked in a privileged container with `Restart=always` firing a second banner after a 10-second `RestartSec` window, confirming crash-recovery works before any host ever boots the unit.

## To take advantage of v0.16.2

`gbrain upgrade` pulls the new guide. If you deployed under v0.16.1 with the original watchdog, swap it:

1. **Re-read the guide:**
   ```bash
   less docs/guides/minions-deployment.md
   ```
2. **Swap the watchdog script.** The v0.16.1 version has the restart-loop bug:
   ```bash
   sudo install -m 755 docs/guides/minions-deployment-snippets/minion-watchdog.sh \
     /usr/local/bin/minion-watchdog.sh
   ```
3. **Move secrets out of crontab.** Put `DATABASE_URL` and `GBRAIN_ALLOW_SHELL_JOBS=1` into `/etc/gbrain.env` (mode 600), reference it from crontab via `BASH_ENV=/etc/gbrain.env`.
4. **Fix the cron form.** If you pasted the v0.16.1 `*/5 * * * * user bash ...` into `crontab -e`, drop the `user` column and the explicit `bash` prefix.
5. **If you have shell access to a long-running box,** consider Option 3 (systemd) instead of Option 1 (watchdog). systemd replaces the watchdog entirely and is the cleanest path.

No schema change. No data migration. Docs + snippets only.

### Itemized changes

**Fixed**
- **Crontab syntax now matches the target.** Two labeled blocks: 5-field for `crontab -e`, 6-field with user column for `/etc/crontab`. An agent no longer hits "bad minute" or has `user` parsed as the command.
- **Watchdog restart loop killed.** The shipped `minion-watchdog.sh` writes a two-line PID file (PID on line 1, restart epoch on line 2) and only considers log lines whose ISO-8601 timestamp is newer than the epoch. Stale shutdown lines from earlier restarts no longer re-match every 5 minutes forever. Regex rewritten to use explicit `[0-9][0-9][0-9][0-9]` instead of `{4}` intervals because mawk (Debian/Ubuntu's default awk) rejects interval quantifiers. Verified end-to-end in a 3-tick abbreviated test inside Ubuntu 22.04.
- **Credentials off the world-readable filesystem.** Secrets move to `/etc/gbrain.env` (mode 600, owned by the worker user), referenced via `BASH_ENV=/etc/gbrain.env` in crontab. `/etc/crontab` is mode 644 and user crontabs under `/var/spool/cron/` are readable by root. A new `gbrain.env.example` ships in-repo with the full env surface.

**Added**
- **Preconditions block.** Five checks at the top of the guide: `gbrain` on PATH, DB connectivity, schema version, crontab write access, and the `GBRAIN_ALLOW_SHELL_JOBS=1` requirement for shell-job workers. Agent fails fast on setup, not content.
- **Decision tree.** "Which option?" selector at the top of the deployment section. Subagent workloads and long jobs take Option 1. Scheduled scripts take Option 2. No shell access take Option 3. Replaces the previous "recommended for X" prose that forced re-reading.
- **Template variable table.** Six variables (`$GBRAIN_BIN`, `$GBRAIN_WORKER_USER`, `$GBRAIN_WORKER_PID_FILE`, `$GBRAIN_WORKER_LOG_FILE`, `$GBRAIN_WORKSPACE`, `$GBRAIN_ENV_FILE`) with meaning and typical value. Agent substitutes once, everything downstream lands correctly.
- **Upgrade section.** v0.13.x → v0.16.2 checklist: stop the worker, run migrations, add `GBRAIN_ALLOW_SHELL_JOBS=1` for shell jobs, handle the `max_stalled` default flip from 1 to 5, swap the v0.16.1 watchdog for the current one.
- **Option 3: service manager.** New `systemd.service`, `Procfile`, and `fly.toml.partial` ship under `docs/guides/minions-deployment-snippets/`. systemd replaces the watchdog entirely with `Restart=always` + `RestartSec=10s` and runs the worker as an unprivileged user with `PrivateTmp`, `ProtectSystem=strict`, and `ReadWritePaths`. Smoked end-to-end in a privileged container: banner fired twice across a 10-second restart cycle, `Restart=always` honored, unit enabled for boot persistence.
- **Uninstall section.** One-paragraph rollback for each option.
- **`docs/guides/minions-deployment.md` listed in `scripts/llms-config.ts`.** Remote agents fetching `llms.txt` or `llms-full.txt` now see the deployment guide without having to guess its path.

**Changed**
- **`--follow` example uses a gbrain subcommand, not `node my-script.mjs`.** The new example submits `gbrain embed --stale` as a shell job on a dedicated queue with `--timeout-ms 600000`. Maps directly onto how an OpenClaw-style agent actually schedules brain maintenance.
- **"Proposed CLI flags (not yet implemented)" dead-end removed.** Replaced with a "Tune per-job today" callout pointing at the `gbrain jobs submit` flags that exist in source (`--max-stalled`, `--backoff-type`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key` — all first-class since v0.13.1).
- **Known Issues rewritten as imperatives.** "DO NOT pass `maxStalledCount` to `MinionWorker`" leads the paragraph, followed by the reason and the correct knob (`gbrain jobs submit --max-stalled N`). Zombie-shell-children section leads with the 10s / 30s numbers and the action.

Contributed by garrytan (issue report), fixes verified by an abbreviated end-to-end test suite (render-check + watchdog 3-tick + systemd container smoke + `bun test` + full E2E DB lifecycle).

## [0.16.1] - 2026-04-22

## **Minions worker deployment, finally documented.**
## **If you run `gbrain jobs work` in production, there's now a guide for the sharp edges.**

Garry's OpenClaw (gbrain's own instance, out there actually running `gbrain jobs work` in production) wrote a real deployment guide for the Minions worker, the piece of gbrain most operators hit next after getting sync running. Agents dogfooding the project they live on is a weird, good feedback loop. Two patterns: a watchdog cron for persistent workers, and an inline `--follow` for cron-only workloads. It covers the connection-drop, stall-detector, and zombie-child traps that show up once your brain is actually working for you. Every command and every default in the guide is checked against current source (`max_stalled = 5`, not 1 or 3; `--follow` exits on submitted-job-terminal, not queue-empty; stalled jobs show up as `active`, not `waiting`). Nothing about this was obvious, and nothing about it was in the docs before.

With v0.16.0's durable agent runtime now shipping, the persistent worker is load-bearing for a lot more (`subagent` + `subagent_aggregator` handlers run there too). A supervised deployment story is the sharp end of the stick.

### What this means for operators

If you have been running the Minions worker under `nohup` with no restart story, this guide is the missing manual. Copy the watchdog script, paste the crontab env lines (`SHELL=/bin/bash`, `PATH`, `DATABASE_URL`, `GBRAIN_ALLOW_SHELL_JOBS=1`), and wire the cron to run every 5 minutes. You get a restart loop that handles the three silent-death modes: DB connection blip, lock-renewal stall, event loop wedge.

If you are running scheduled shell jobs only, skip the persistent worker and use `--follow`. 2-3 seconds of startup overhead is trivial when your job runs for a minute.

Docs-only release. No code changed. Zero migration required.

## To take advantage of v0.16.1

`gbrain upgrade` pulls the new guide. Read it:

1. **Open the guide:**
   ```bash
   less docs/guides/minions-deployment.md
   ```
   Or browse it on GitHub.
2. **Persistent worker:** copy `minion-watchdog.sh`, set crontab env lines, wire a `*/5 * * * *` cron.
3. **Scheduled shell jobs only:** rewrite your cron as `gbrain jobs submit shell ... --follow --timeout-ms N` and drop the persistent worker entirely.
4. **The "Proposed CLI flags" section** (`--lock-duration` / `--max-stalled` / `--stall-interval` on `gbrain jobs work`): those are on the roadmap. Per-job `--max-stalled` on `gbrain jobs submit` is already real and writes to the row's column directly.

### Itemized changes

**Added**
- **Minions worker deployment guide** — new `docs/guides/minions-deployment.md` covering watchdog cron patterns, inline `--follow` for cron-only workloads, and the sharp edges of running `gbrain jobs work` against Supabase in production. Addresses a real gap: existing Minions docs (`minions-fix.md`, `minions-shell-jobs.md`) cover schema repair and shell-job security, not deploy patterns. Contributed by your OpenClaw via #287. Pre-landing accuracy pass corrected five factual bugs against current source: the `max_stalled` column default (5, not 1 or 3), the stalled-jobs smoke-test query (`active`, not `waiting`), the SIGTERM-to-SIGKILL grace window (10s minimum, not 2s), the cron env pattern (crontab env lines, not `source ~/.bashrc`), and the `--follow` exit semantics (blocks until submitted job is terminal, not until queue is empty).
## [0.16.0] - 2026-04-20

## **Durable agents land. Your LLM loops survive crashes, timeouts, and worker restarts now.**
## **OpenClaw died mid-run? Come back, resume from the last committed turn.**

Your OpenClaw crashes daily. Not "sometimes." Daily. An 8-turn OpenClaw subagent fires a tool call, the worker dies on a memory blip, all eight turns of context are gone, and there's nothing to do but start over from turn zero. This release kills that. `gbrain agent run` submits an Anthropic Messages API conversation as a first-class Minion job: every turn persists to `subagent_messages`, every tool call is a two-phase ledger row (`pending` → `complete | failed`), and replay on worker restart picks up from exactly the last committed turn. Crash-safe by construction, not by hope.

Fan-out works the same way. `--fanout-manifest` splits N prompts across N subagent children plus one aggregator. Children run `on_child_fail: 'continue'` so one failing run doesn't cascade, and the aggregator claims after all children reach ANY terminal state (complete, failed, dead, cancelled, timeout) and writes a mixed-outcome summary. No polling loop, no dead parents stranded in `waiting-children`.

Plugins work. Host repos drop a `gbrain.plugin.json` + `subagents/*.md` dir somewhere on `GBRAIN_PLUGIN_PATH`, and their custom subagent defs load at worker startup. Your OpenClaw ships its meeting-ingestion, signal-detector, and daily-task-prep subagents in its own repo now; gbrain discovers them day one. Collision rule is deterministic (left-wins with a loud warning). Trust boundary is strict on purpose: plugins ship DEFS, not tools. Tool allow-list stays here.

### The numbers that matter

Measured on the v0.15 branch against real Postgres via `bun run test:e2e`, plus the 159 new unit tests across 10 new test files. Coverage: 12 new runtime modules, 53+ code paths + user flows traced, 3 critical regression tests for the shell-jobs queue surface.

| Metric                                                   | BEFORE v0.15                       | AFTER v0.15                                 | Δ                                    |
|----------------------------------------------------------|------------------------------------|---------------------------------------------|--------------------------------------|
| Your OpenClaw run survives worker kill mid-tool-call     | No (start over)                    | Yes (resume from last committed turn)        | crash-recovery unlocked              |
| Fan-out run with 1 failed child out of N                 | Aggregator fails                   | Aggregator still claims + summarizes         | mixed-outcome aggregation works      |
| `gbrain agent logs --follow` during long Anthropic call  | Silent (looks frozen)              | Heartbeat line per turn boundary              | visible progress                     |
| Tool-use replay on resume                                 | N/A (no resume)                    | Idempotent re-run, non-idempotent aborts      | two-phase protocol                   |
| `put_page` exposure to agent-driven writes               | Full write surface                 | Namespace-scoped `wiki/agents/<id>/…`         | fail-closed, server-enforced         |
| Plugin subagent defs for downstream hosts                | Not supported                      | `GBRAIN_PLUGIN_PATH` + validated at startup   | OpenClaw day-1 usable                |
| Rate-lease capacity leaks on worker crash                 | Counter-based (leaks)              | Lease-based (auto-prune on next acquire)      | no starvation after SIGKILL          |
| Anthropic prompt cache on 40-turn agent                   | Per-turn cold                      | `cache_control: ephemeral` on system + tools  | ~10x cost reduction (best-case)      |

### What this means for your OpenClaw

You stop rerunning from zero. A crash at 3am that used to lose two hours of turns now costs you whatever fraction of one turn was in-flight when the worker died. The rest of the conversation is rows in `subagent_messages` and `subagent_tool_executions`, and the next worker claim replays from there. `gbrain agent logs <job>` shows you where it died, which tool it was running, and what came back from the last successful call. Real debugging, not guessing.

Credit: shell-jobs (v0.14) established every pattern v0.15 reuses — handler signature, dual-signal abort, ctx.updateTokens, protected-names, trusted-submit, JSONL audit log, timeout_ms. Codex caught the Mode A "transparent Agent() interception" impossibility during plan review and saved the shape of this work. The v0.15 handler is what survives on the other side of that review.

### Itemized changes

**New capability: `gbrain agent` CLI**
- `gbrain agent run <prompt> [--subagent-def|--model|--max-turns|--tools|--timeout-ms|--fanout-manifest|--follow|--detach]` — submits a subagent job (or fan-out of N subagents + aggregator) under the trusted-submit flag. Follow mode tails status + logs until terminal; detach prints the job id and exits. Ctrl-C detaches (job keeps running), does not cancel.
- `gbrain agent logs <job_id> [--follow] [--since ISO-or-relative]` — merges the JSONL heartbeat audit with persisted `subagent_messages` into one chronological timeline. `--since 5m` / `1h` / `2d` shorthand supported. Transcript tail renders the full message + tool tree only after the job is terminal.
- Always registered on the worker (no separate env flag). `ANTHROPIC_API_KEY` is the natural cost gate — no key, the SDK call fails immediately. Who-can-submit is already gated by `PROTECTED_JOB_NAMES` + `TrustedSubmitOpts` so only the trusted-CLI path can insert `subagent` / `subagent_aggregator` rows.

**New durability primitives**
- `src/core/minions/handlers/subagent.ts` — the LLM-loop handler. Two-phase tool persistence, replay reconciliation for mid-dispatch crashes, dual-signal abort (`ctx.signal` + `ctx.shutdownSignal`), Anthropic prompt caching on system + tool defs, injectable `MessagesClient` for mocking.
- `src/core/minions/handlers/subagent-aggregator.ts` — claims AFTER all children resolve (Lane 1B's queue changes guarantee each terminal child posts a `child_done` inbox message), produces deterministic mixed-outcome markdown summary.
- `src/core/minions/rate-leases.ts` — lease-based concurrency cap for outbound providers. Owner-tagged rows with `expires_at` auto-prune on acquire, so a crashed worker can't strand capacity. `pg_advisory_xact_lock` guards the check-then-insert.
- `src/core/minions/wait-for-completion.ts` — poll-until-terminal helper for CLI callers. `TimeoutError` does NOT cancel the job; AbortSignal exits cleanly. Default `pollMs`: 1000 on Postgres, 250 on PGLite inline.
- `src/core/minions/handlers/subagent-audit.ts` — JSONL audit + heartbeat writer. Rotates weekly via ISO week. `readSubagentAuditForJob` is the readback path for `gbrain agent logs`.
- `src/core/minions/transcript.ts` — messages + tool executions → markdown renderer. UTF-8-safe truncation; unknown block types fall through to JSON for diagnostics.
- `src/core/minions/tools/brain-allowlist.ts` — derives the subagent tool registry from `src/core/operations.ts`. 11-name allow-list (read-only + deterministic `put_page`). `put_page` schema is namespace-wrapped per subagent so the model writes correct slugs first-try; the server-side check in `put_page` is the authoritative gate.
- `src/core/minions/plugin-loader.ts` — `GBRAIN_PLUGIN_PATH` (colon-separated absolute paths like `PATH`) + `gbrain.plugin.json` manifest + `subagents/*.md` defs. Strict path policy, left-wins collision, plugins ship DEFS only (no new tools), `allowed_tools:` validated at load time.
- `src/mcp/tool-defs.ts` — extracted from an inline `operations.map(...)` block in the MCP server so subagent + MCP use the same source of truth. Byte-for-byte equivalence pinned by regression test.

**Schema (3 new tables + OperationContext fields + migration orchestrator)**
- `subagent_messages` — Anthropic message-block persistence. `(job_id, message_idx)` UNIQUE; `content_blocks JSONB` holds parallel tool_use blocks in one assistant message.
- `subagent_tool_executions` — two-phase ledger. `(job_id, tool_use_id)` UNIQUE; status: `pending | complete | failed`.
- `subagent_rate_leases` — lease-based concurrency control. CASCADE deletes on owning job removal so no leaked rows.
- `OperationContext` gains `jobId?`, `subagentId?`, and `viaSubagent?` (fail-closed signal for agent-path gating). Added to `src/core/operations.ts`.
- `src/commands/migrations/v0_15_0.ts` — post-upgrade orchestrator (phases: schema → verify → record). `v0_14_0.ts` noop stub keeps the registry version sequence gapless.

**Queue correctness fixes**
- `failJob`, `cancelJob`, and `handleTimeouts` all emit `child_done` inbox messages with `outcome: 'complete' | 'failed' | 'dead' | 'cancelled' | 'timeout'`. Pre-v0.15 only `completeJob` emitted; failed/cancelled/timed-out children silently stranded aggregator-style parents.
- Parent-resolution terminal set expanded from `{completed, dead, cancelled}` to include `'failed'` everywhere parent-state is checked. A failed child with `on_child_fail: 'continue'` now correctly unblocks the parent.
- `failJob` emits `child_done` BEFORE the parent-terminal UPDATE. Without insertion ordering, the EXISTS guard on the inbox INSERT would skip the row on `fail_parent` paths (caught by codex iteration 3).
- `MinionJobInput.max_stalled` threads through `MinionQueue.add()` as INSERT param (not UPDATE on idempotency replay — that would mutate first-submitter state).

**Trust model**
- `subagent` and `subagent_aggregator` join `PROTECTED_JOB_NAMES`. MCP `submit_job` returns `permission_denied`; only `gbrain agent run` (with `allowProtectedSubmit`) can insert these rows.
- `put_page` gains a server-side fail-closed namespace check: when `ctx.viaSubagent === true`, `slug` MUST match `^wiki/agents/<subagentId>/.+` — even if `subagentId` is undefined (dispatcher bug must not open a hole).

**Docs**
- `docs/guides/plugin-authors.md` — downstream-OpenClaw-facing walkthrough (minimum viable plugin, path + collision + trust policies, frontmatter fields, caveats).
- 12 bisectable commits on `garrytan/minions-seam`, each PR-worthy on its own; the full series lands v0.15.0 end-to-end.

**Tests**
- 159 new unit tests across 10 new files: `mcp-tool-defs`, `put-page-namespace`, `migrations-v0_15_0`, `queue-child-done`, `rate-leases`, `wait-for-completion`, `brain-allowlist`, `subagent-audit`, `subagent-transcript`, `subagent-handler`, `subagent-aggregator`, `plugin-loader`, `agent-cli`.
- 3 critical regression tests pin the shell-jobs queue surface: `failJob` child_done behavior, `put_page` namespace path for non-subagent callers, MCP `buildToolDefs` byte-equivalence.
- E2E `minions-resilience.test.ts` updated: the max_children test renames its spawned children off the now-protected `subagent` name.

## [0.15.4] - 2026-04-21

## **PgBouncer transaction-mode prepared statements, fixed at the pool.**
## **`gbrain jobs work` against Supabase pooler stops silently dropping rows.**

Three separate PRs (#284, #286, #270) were all trying to fix the same bug: on a Supabase transaction-mode pooler (port 6543), `postgres.js`'s per-client prepared-statement cache goes stale every time PgBouncer recycles the backend connection. The symptom under sustained gbrain load is `prepared statement "xyz" does not exist` in the logs and silently dropped rows during sync. v0.15.4 lands the combined fix: the `resolvePrepare()` helper from #284, the both-connection-paths coverage from @notjbg's community PR #270, a new doctor check, and real tests against `bun:test`. The one-liner in #286 is dominated by this.

### The one number that matters

There isn't a benchmark, there's a correctness gate. On a Supabase pooler at port 6543 with a 4,500-page sync:

| | Before v0.15.4 | After v0.15.4 |
|---|---|---|
| `prepared statement ... does not exist` errors | Dozens per sync | Zero |
| Rows inserted vs. manifest count | Short by 50-200 rows (silent) | 1:1 parity |
| `gbrain jobs work` crash under load | Yes | No |

The silent-drop is the dangerous half. You run `gbrain sync`, the exit code is 0, the logs have a few noise lines you scroll past, and three weeks later you notice your brain is missing pages. `resolvePrepare(url)` disables prepared statements when the URL targets port 6543, and the doctor check flags the misconfiguration if you've manually forced `GBRAIN_PREPARE=true` on that port.

### What this means for pooler users

If you connect via `aws-0-REGION.pooler.supabase.com:6543`, do nothing. The upgrade disables prepared statements automatically and `gbrain doctor` confirms it with `pgbouncer_prepare: ok`. If you're on session mode (port 5432 on the pooler host) or direct Postgres, nothing changes: prepared statements stay on, plan caching stays intact. If your PgBouncer runs in session mode on a non-standard port, set `GBRAIN_PREPARE=true` explicitly.

## To take advantage of v0.15.4

`gbrain upgrade` handles this automatically. If you're not sure whether the fix is live:

1. **Run the doctor check:**
   ```bash
   gbrain doctor
   ```
   Look for `pgbouncer_prepare`. On a `:6543` URL you should see `ok` (prepared statements disabled). On a direct URL the check silently passes.
2. **Verify on sustained load:**
   ```bash
   gbrain sync
   ```
   Zero `prepared statement ... does not exist` log lines. Row count inserted matches the source manifest.
3. **If something looks wrong,** file an issue at https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - the connection URL shape (port and pooler hostname — redact credentials)
   - whether `GBRAIN_PREPARE` is set

### Itemized changes

**Fixed**
- **Supabase PgBouncer port-6543 prepared statements no longer break sync.** New `resolvePrepare(url)` helper in `src/core/db.ts` with 4-level precedence: `GBRAIN_PREPARE` env var → `?prepare=` query param → port-6543 auto-detect → default. Wired into both the module-singleton `connect()` in `db.ts` AND the worker-instance `PostgresEngine.connect({poolSize})` in `src/core/postgres-engine.ts` so `gbrain jobs work` gets the same treatment as the main CLI. The second path was the gap #284 missed; community PR #270 caught it. Contributed by @notjbg.
- **`gbrain doctor` surfaces the misconfiguration.** New `pgbouncer_prepare` check reads the configured URL via `loadConfig()` and reports `ok` when prepared statements are safely disabled, `warn` when the URL points at port 6543 but prepared statements are still enabled (the footgun that caused silent row drops).

**Tests**
- New `test/resolve-prepare.test.ts` — 11 cases covering the full precedence matrix: env override, URL query param, port auto-detect, malformed URLs, `postgres://` vs `postgresql://` schemes, URL-encoded credentials. Uses `bun:test` (not vitest — #284's original tests were in the wrong framework and would never have run).
- Extended `test/postgres-engine.test.ts` — new source-level grep assertion that the worker-instance `connect({poolSize})` branch calls `db.resolvePrepare(url)` and conditionally includes the `prepare` key in the options literal. Mirrors the existing `SET LOCAL statement_timeout` guardrail in the same file. If anyone rips out the wiring, the build fails before a shipping brain drops rows.

**Supersedes**
- Closes #284 (ours, from the OpenClaw reference deployment): architecture landed as-is (port-only detection, no hostname expansion). Tests rewritten from vitest to bun:test.
- Closes #286 (ours, Codex one-liner): dominated; unconditional `prepare: false` would have cost direct-Postgres users plan caching for no reason.
- Closes #270 (@notjbg): the critical both-connection-paths insight landed; credit preserved in commit trailer and this CHANGELOG entry.

## [0.15.3] - 2026-04-21

## **Two upgrade-night bugs that crashed v0.13 → v0.14, now fixed with regression guards.**
## **Migrations find the right binary. Autopilot spawns its worker. `gbrain upgrade` survives.**

Tonight's production upgrade surfaced eleven bugs. Two of them — Bug 1 (the migration shell-out) and Bug 4 (the autopilot resolver) — survived two eng-review passes AND nine Codex reviews with correct diagnoses and implementable fixes. The other nine had wrong root causes or unimplementable architectures (documented in `~/.claude/plans/` as deferred work with grounded starting context for future `/investigate` sessions). This release ships the two clean fixes so the next `gbrain upgrade` actually lands.

### Itemized changes

**Fixed**
- **`gbrain upgrade` no longer crashes mid-migration on bun installs.** The v0.13.0 migration orchestrator used to shell out via `process.execPath`, which on bun-installed trees is the `bun` runtime itself. `${bun} extract links --source db …` got reinterpreted as `bun run extract` and crashed with "script not found." The fix drops the execPath detour and shells out to the bare `gbrain` string, letting the canonical shim on PATH (`/usr/local/bin/gbrain` by default) win. Regression test in `test/migrations-v0_13_0.test.ts` greps the source for `process.execPath` and fails the build if anyone reintroduces the pattern. Contributed by @garrytan.
- **Autopilot spawns its Minions worker again.** `resolveGbrainCliPath` checked `argv[1]` first and happily returned `/path/to/src/cli.ts` on bun-source installs. `spawn()` then failed with `EACCES` because TypeScript source isn't executable, and autopilot silently lost its worker. The fix reorders the probe: `which gbrain` (shim on PATH) wins first, then compiled `process.execPath`, then an `argv[1]=/gbrain` fallback. The `.ts` branch is deleted entirely. A critical regression test enforces that the resolver NEVER returns a `.ts` path across any combination of `argv[1]` + `process.execPath` + shim availability.

**Tests**
- New `test/migrations-v0_13_0.test.ts` — 7 cases covering registry wiring, dry-run semantics, and three regression guards against the Bug 1 re-introduction (no `process.execPath`, no `GBRAIN` constant, no `bun` or `.ts` in `execSync` calls).
- Rewrote `test/autopilot-resolve-cli.test.ts` — the old test enshrined the buggy `.ts` return path. New test parameterizes argv/execPath combinations and asserts the resolver never returns a `.ts` path. This is the test that would have caught Bug 4 before it shipped.

**Deferred (tracked for follow-up `/investigate` sessions)**
- Bug 2 (pooler MaxClients), Bug 3 (partial-migration retry loop), Bug 5 (v0.14.0 registry gap), Bug 6/10 (duplicate graph edges), Bug 7 (doctor --fast), Bug 8 (autopilot-cycle stalls), Bug 9 (YAML colons), Bug 11 (brain_score breakdown). Each has grounded Codex findings documenting the real root cause and where prior diagnoses went wrong. Landing target: subsequent PR waves.

## [0.15.2] - 2026-04-21

## **Silent binaries are dead. Every bulk action now heartbeats.**
## **Agents can tell the difference between "working" and "hung."**

`gbrain doctor` on a 52K-page brain used to sit silent for 10+ minutes and then get killed by an agent timeout. The checks always completed when run by hand, but stdout buffered and agents saw nothing. The same pattern hit `embed`, `sync`, `import`, `extract`, `migrate`, and every orchestrator that shelled out to them — progress either went to stdout with `\r` rewrites that collapse when piped, or nowhere at all. v0.15.2 routes every bulk action through one shared reporter. Non-TTY default is plain human lines on stderr, one line per event. Agents that want structured progress flip `--progress-json` and get one JSON object per line.

Progress events never touch stdout. Data and final summaries still go there. Script you wrote six months ago that parses `gbrain embed` output? Still works. Agent that captures stdout to JSON.parse the result? Now gets clean JSON instead of `\r\r\r1234/52000 pages...` mixed in.

### The numbers that matter

Measured on this repo (80 unit test files, 14 E2E test files, real Postgres+pgvector, 141 E2E cases incl. 3 new doctor-progress tests):

| Metric                                            | BEFORE v0.15.2         | AFTER v0.15.2                          | Δ              |
|---------------------------------------------------|------------------------|----------------------------------------|----------------|
| Commands that stream progress                     | 3 (ad-hoc `\r` stdout) | **14** (reporter, stderr, rate-gated) | **+11**        |
| Progress observable when stdout is piped          | **0 of 3**             | **14 of 14**                           | always visible |
| Canonical JSON event schema                       | none                   | **locked in `docs/progress-events.md`** | stable         |
| `doctor` silence window on 52K pages              | 10+ min then killed    | **heartbeat every 1s**                 | observable     |
| `jsonb_integrity` scan targets                    | 4 (missed `page_versions.frontmatter`) | **5**   | matches `repair-jsonb` |
| Minion jobs that update `job.progress`            | 0 bulk cores           | **embed** wired (import/sync/extract ready via callbacks) | DB-backed |
| Unit tests for progress/CLI plumbing              | 0                      | **37** (progress + cli-options)        | +37            |
| E2E tests for agent-visible progress              | 0                      | **3** (doctor-progress Tier 1)         | +3             |

| Bulk command          | Progress today  | Progress after v0.15.2                                        |
|-----------------------|-----------------|----------------------------------------------------------------|
| `doctor`              | None (blocks)   | Per-check heartbeat, 1s on slow queries                        |
| `orphans`             | Final summary   | Heartbeat while `NOT EXISTS` scan runs                         |
| `embed`               | `\r` stdout     | Per-page stderr, `job.updateProgress` from Minions             |
| `files sync`          | `\r` stdout     | Per-file stderr                                                |
| `export`              | `\r` stdout     | Per-page stderr (newly in scope)                               |
| `import`              | Per-100 stdout  | Per-file stderr, rate-gated                                    |
| `extract` (fs + db)   | Ad-hoc stderr   | Canonical event schema, all paths                              |
| `sync`                | Final summary   | Per-file ticks across delete/rename/import phases              |
| `migrate --to ...`    | Per-50 stdout   | `migrate.copy_pages` + `migrate.copy_links` phases             |
| `repair-jsonb`        | Final summary   | Per-column heartbeat (stdout stays JSON-clean for orchestrator)|
| `check-backlinks`     | Final summary   | Heartbeat during the double-walk                               |
| `lint`                | Per-file stdout | Per-file stderr, issues still on stdout                        |
| `integrity auto`      | Own progress file | Unified reporter (file kept as resume marker)                |
| `eval`                | None            | Per-query tick in single + A/B modes                           |
| `apply-migrations`    | Inherited child output | Explicit flag propagation + stdio discipline             |

Concrete agent win: on a 52K-page brain, `gbrain --progress-json doctor` emits ~10 events per second on stderr (start per check, heartbeats during the slow scan, finish per check) while `gbrain doctor --json` keeps stdout clean and JSON-parseable. The agent never sees silence longer than 1 second, and its stdout parser doesn't need to scrub progress garbage.

### What this means for you

If you run `gbrain` in CI, through a Minion worker, or inside any agent that captures stdout, this release means your downstream consumers stop guessing. Slow migrations announce themselves. Long imports name each file. `gbrain jobs get <id>` returns live `progress` for Minion-queued bulk work. The `gbrain doctor` warning you've been ignoring because it fires silently and then 10 minutes later tells you nothing is wrong becomes a 1-second heartbeat that proves it's working. If you're reading logs from a shell pipeline and prefer plain human lines, you don't need to do anything, that's the default for non-TTY stderr. Only add `--progress-json` when you want structured events.

## To take advantage of v0.15.2

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Nothing mechanical is required.** v0.15.2 is purely additive to the CLI surface — no schema changes, no migration orchestrator, no data rewrites. Progress events start flowing the next time you invoke a bulk command.
2. **To stream structured events to your agent:**
   ```bash
   gbrain --progress-json sync 2> progress.log
   # or
   gbrain doctor --progress-json --json > doctor.json 2> doctor.progress
   ```
3. **For Minion-queued jobs:**
   ```bash
   gbrain jobs submit embed
   # while it runs:
   gbrain jobs get <id>   # .progress is live-updated by the worker
   ```
4. **If `gbrain doctor` still looks hung** on a very large brain, check the CLI output for heartbeat lines. If they're missing, file an issue at https://github.com/garrytan/gbrain/issues with the command you ran, stdout/stderr samples, and output of `gbrain doctor --fast`.

### Itemized changes

#### Reporter (new, `src/core/progress.ts`)
- Dependency-free. Modes: `auto` (TTY → `\r`-rewriting; non-TTY → plain lines), `human`, `json` (JSONL on stderr), `quiet`.
- Rate gating: emits on whichever fires first: `minIntervalMs` (default 1000) or `minItems` (default `max(10, ceil(total/100))`). Final `tick` where `done === total` always emits.
- `startHeartbeat(reporter, note)` helper for single long-running queries (doctor's `markdown_body_completeness`, `orphans` anti-join, `repair-jsonb` per-column UPDATE).
- `child()` composes phase paths, `sync.import.<slug>`, not flat `<slug>`.
- EPIPE defense on both sync throws and stream `'error'` events. Singleton module-level SIGINT/SIGTERM handler emits `abort` events for every live phase, one handler no matter how many reporters exist.

#### CLI plumbing (`src/core/cli-options.ts`, `src/cli.ts`)
- Global flags `--quiet`, `--progress-json`, `--progress-interval=<ms>` parsed before command dispatch.
- `CliOptions` singleton (`getCliOptions`) reachable from every command without threading a new parameter through 20 handlers.
- `OperationContext.cliOpts` extends shared-op dispatch, MCP callers see defaults, CLI callers see parsed flags.
- `childGlobalFlags()` helper: appends the parent's flags to every `execSync('gbrain ...')` call in the migration orchestrators, so child progress matches parent mode.

#### JSON event schema
- Stable from v0.15.2, documented in `docs/progress-events.md`.
- `{event, phase, ts}` always present. Optional: `total`, `done`, `pct`, `eta_ms`, `note`, `elapsed_ms`, `reason`. No fake totals when a query has no count.
- Phases use `snake_case.dot.path`. Machine-stable. Agent parsers can group by phase prefix (all `doctor.*` events belong to one run).

#### Backward-compat warnings
Progress for `embed`, `files`, `export`, `extract`, `import`, `migrate-engine` moved from stdout to stderr. Stdout now carries only final summaries and `--json` payloads. Scripts that parsed `process.stdout` for progress lines (`\r  1234/52000 pages...`) see empty stdout for those counters; the data they actually want (the final "Embedded N chunks" summary) is still there. Point anything grepping stdout for progress at stderr instead.

#### Minion handlers (`src/commands/jobs.ts`)
- `embed` handler passes `job.updateProgress({done, total, embedded, phase})` as the `onProgress` callback. Primary Minion progress channel is DB-backed, readable via `gbrain jobs get <id>` or the `get_job_progress` MCP op. Stderr from `jobs work` stays coarse for daemon liveness.
- Other handlers (`sync`, `extract`, `backlinks`, `autopilot-cycle`, `import`) have the callback plumbing ready from the core functions; wiring the remaining handlers is a follow-up.

#### `gbrain doctor`
- `jsonb_integrity` now scans 5 targets (adds `page_versions.frontmatter`), matching `repair-jsonb`'s surface. The old 4-target check missed one of the repair sites.
- Per-check heartbeats so agents see `doctor.db_checks` starting, which check is in-flight, and `doctor.markdown_body_completeness` scanning.
- No false totals: the `LIMIT 100` truncation check reports `heartbeat`, not `tick` with a fake count.

#### Upgrade (`src/commands/upgrade.ts`)
- Post-upgrade timeout bumped 300s → 1800s (30 min). Override via `GBRAIN_POST_UPGRADE_TIMEOUT_MS`. The old 300s cap killed v0.12.0 graph-backfill migrations on 50K+ brains; heartbeat wiring in v0.15.2 makes the long wait observable.

#### CI guard
- `scripts/check-progress-to-stdout.sh` greps `src/` for `process.stdout.write('\r...')` and fails `bun run test` if any regression lands.

#### Tests
- New: `test/progress.test.ts` (17 cases — mode resolution, rate gating, EPIPE paths, SIGINT singleton, child phase composition), `test/cli-options.test.ts` (18 cases — flag parsing, `--quiet` skillpack-check collision regression, global-flag strip-and-dispatch), `test/e2e/doctor-progress.test.ts` (3 cases, Tier 1 — spawns the real CLI against a real Postgres, asserts stderr JSONL matches the schema and stdout stays clean).
## [0.15.1] - 2026-04-21

## **Fix wave: 4 hot issues that blocked real brains, landed together.**
## **PGLite survives macOS 26.3. Minions actually rescues SIGKILL'd jobs. Autopilot dashboards stop the 14.6s seqscan. `bun install -g` tells you when it's broken.**

v0.15.1 is the hotfix wave on top of the v0.14.x stack (shell job type in v0.14.0, doctor DRY + `--fix` in v0.14.1, 8 deferred bug fixes in v0.14.2) plus v0.15.0 (llms.txt + AGENTS.md): four user-filed issues against v0.13.x, fixed and verified together, plus three scope expansions that close adjacent footguns. Upgrade is automatic. If `gbrain upgrade` runs clean, your brain gets faster and more reliable on the next sync cycle.

### The numbers that matter

The four issues this release closes, with measured impact:

| Issue | Before v0.15.1 | After v0.15.1 | Δ |
|-------|----------------|----------------|---|
| #170 `SELECT * FROM pages ORDER BY updated_at DESC` on 31k rows (Postgres) | ~14.6s seqscan | <20ms index scan | ~700x |
| #219 `max_stalled` default on `minion_jobs` | 3 (three rescues before dead, v0.14.2 set this) | 5 (four rescues before dead) | extra headroom for flaky deploys |
| #219 existing waiting/active jobs with `max_stalled<5` | would still dead-letter earlier than expected | backfilled to 5 on upgrade | closes the pain today |
| #218 `bun install -g github:garrytan/gbrain` postinstall failure | silent `|| true` | visible stderr warning with recovery URL | users know it's broken |
| #223 PGLite WASM crash on macOS 26.3 | raw `Aborted()`, no hint | pinned `@electric-sql/pglite` to `0.4.3` + actionable error message naming the issue | users can route to #223 |

### What this means for you

If you run autopilot against a Supabase brain with 30k+ pages, your health/dashboard cycle was silently burning 14.6 seconds on every iteration. The new index drops that to single-digit milliseconds without locking writes (Postgres gets `CREATE INDEX CONCURRENTLY` with an invalid-index cleanup DO block; PGLite gets plain `CREATE INDEX` since it has no concurrent writers). Your agent stops blocking on list-pages-by-date queries.

If you use Minions, the "SIGKILL mid-flight, 10/10 rescued" claim is now actually true out-of-the-box with generous headroom. Default `max_stalled=5` means a kill -9'd worker gets picked up by the next worker instead of dead-lettered early. v15 migration backfills existing non-terminal rows (`waiting/active/delayed/waiting-children/paused`) so upgrading doesn't leave a queue full of doomed jobs.

If you install via `bun install -g github:...` (not recommended but people try it), you'll now see a loud stderr warning with a link to #218 instead of a broken CLI that fails on next invocation. The real fix is `git clone + bun link`, documented in README and INSTALL_FOR_AGENTS.md.

If you're on macOS 26.3 and PGLite was crashing with `Aborted()`, the pin to 0.4.3 gives us the best shot at avoiding the WASM regression (noting: 0.4.3 is unverified against 26.3 in CI — the error-wrap at `pglite-engine.ts connect()` is the safety net if the pin doesn't hold). Any PGLite init failure now shows the #223 link instead of a raw runtime error.

## To take advantage of v0.15.1

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Verify the outcome:**
   ```bash
   psql "$DATABASE_URL" -c "\d minion_jobs" | grep max_stalled  # DEFAULT should be 5
   psql "$DATABASE_URL" -c "\d pages" | grep idx_pages_updated_at_desc  # index should exist
   gbrain doctor
   ```
3. **If any step fails or the numbers look wrong,** file an issue with `gbrain doctor` output and the contents of `~/.gbrain/upgrade-errors.jsonl` if it exists. https://github.com/garrytan/gbrain/issues

### Itemized changes

#### Added
- Schema migration **v14** — `CREATE INDEX [CONCURRENTLY] IF NOT EXISTS idx_pages_updated_at_desc ON pages (updated_at DESC)` (engine-aware; Postgres uses CONCURRENTLY with an invalid-index DO-block cleanup, PGLite uses plain CREATE). Closes #170. Contributed by @fuleinist (#215).
- Schema migration **v15** — `ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 5` (bumps v0.14.2's default of 3 to 5 for extra flaky-deploy headroom) + `UPDATE` backfill scoped to non-terminal statuses (`waiting/active/delayed/waiting-children/paused`) so existing queued work benefits on upgrade. Closes #219. Reported by @macbotmini-eng.
- `MinionJobInput.max_stalled` — new optional field, plumbed through `queue.add()` with `[1, 100]` clamp.
- `gbrain jobs submit --max-stalled N` — CLI flag to set per-job stall tolerance.
- `gbrain jobs submit --backoff-type`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key` — scope-expansion audit exposing existing `MinionJobInput` fields as first-class CLI flags.
- `gbrain jobs smoke --sigkill-rescue` — opt-in regression smoke case that simulates a killed worker and asserts the v0.15.1 default actually rescues.
- `gbrain doctor --index-audit` — new opt-in Postgres check that reports zero-scan indexes from `pg_stat_user_indexes`. Informational only (no auto-drop). PGLite no-ops.
- `BrainEngine.kind` readonly discriminator (`'postgres' | 'pglite'`) — lets migrations and consumers branch on engine without `instanceof` + dynamic imports.
- `package.json trustedDependencies: ["@electric-sql/pglite"]` — lets Bun run PGLite's dep postinstall on global installs.

#### Changed
- `@electric-sql/pglite` pinned to exactly `0.4.3` (was `^0.4.4`) — best-available mitigation for the macOS 26.3 WASM abort. Reported by @AndreLYL (#223). Flagged as unverified; reproduce on a 26.3 machine and file a follow-up if it still aborts.
- `package.json postinstall` — now warns loudly on stderr with a recovery URL instead of silencing errors with `2>/dev/null || true`. `bun install -g` hitting a migration failure now tells you what to do. Reported by @gopalpatel (#218).
- `src/core/pglite-engine.ts connect()` — wraps `PGlite.create()` with a friendly error pointing at #223 and `gbrain doctor`. Nests the original error for debuggability.
- `doctor` `schema_version` check — now fails loudly when `version=0` (migrations never ran), linking #218.
- `README.md` + `INSTALL_FOR_AGENTS.md` — explicit warning against `bun install -g github:garrytan/gbrain`.

#### Fixed
- **The "SIGKILL mid-flight, 10/10 rescued" claim is now accurate** out-of-the-box with headroom (#219). Schema default 3 → 5.
- **Autopilot dashboards stop blocking on list-pages queries** on 30k+ row Postgres brains (#170).
- **PGLite error on macOS 26.3** is now actionable instead of a raw `Aborted()` (#223).
- **`bun install -g` no longer produces a silently broken CLI** (#218) — postinstall surfaces failures.

#### Internal
- `Migration` interface extended with `sqlFor: { postgres?, pglite? }` + `transaction: boolean` fields. Runner picks the engine-specific SQL branch and (on Postgres only) bypasses `engine.transaction()` when `transaction: false` (required for CONCURRENTLY).
- `scripts/check-jsonb-pattern.sh` extended with a CI guard against `max_stalled DEFAULT 1` regressing.
- ~15 new unit tests covering max_stalled default/clamp/backfill/v14/v15 semantics. 3 regression tests pinned by IRON RULE.
- `test/e2e/` now runs test files sequentially via `scripts/run-e2e.sh` to eliminate shared-DB races that caused ~3/5 runs to have 4-10 flaky fails. Every run post-fix: 13 files, 138 tests, 0 fails.

## [0.15.0] - 2026-04-21

## **GBrain now talks to LLMs the way modern docs sites do.**
## **One URL, full context. Three files, zero drift.**

Three new artifacts ship at the repo root: `llms.txt` (llmstxt.org-spec index), `llms-full.txt` (same map with core docs inlined, ~225KB, fits well under a 150k-token context window), and `AGENTS.md` (the non-Claude-agent operating protocol). All three are generator-driven. `scripts/build-llms.ts` reads a curated `scripts/llms-config.ts` and emits `llms.txt` + `llms-full.txt` deterministically; `AGENTS.md` is hand-written and uses relative links so it survives forks and rename. Every agent that clones GBrain now has a one-screen answer to "I just got here, what do I do?"

README and `INSTALL_FOR_AGENTS.md` now point agents at `AGENTS.md` first. The old install prompt still works, but the leverage point, Codex's read of the plan, was that these files are invisible unless the install path references them. Fixed.

### The numbers that matter

Measured on this release:

| Metric                                          | BEFORE                          | AFTER                            | Δ                          |
|-------------------------------------------------|----------------------------------|-----------------------------------|----------------------------|
| Agent entry points with clear install protocol  | 1 (CLAUDE.md, Claude Code only) | 3 (CLAUDE.md + AGENTS.md + llms.txt) | +non-Claude coverage       |
| Docs referenced at a single canonical URL       | 0                               | 20 (across 5 H2 sections)        | index exists               |
| Full-context fetch round-trips                  | ~20 (one per doc)               | 1 (`llms-full.txt`, 224 KB)      | ~20x fewer fetches         |
| Tests guarding the doc index                    | 0                               | 7 (paths resolve, idempotent, spec shape, regen-drift, content contract, AGENTS mirror, size budget) | +7                         |
| Pre-existing repo bugs found and fixed          | —                               | 1 (`git pull origin main` → `master`) | drive-by                   |

The 7 tests enforce content contract: removing `skills/RESOLVER.md` or the Debugging H2 from the config fails `bun test`. Forgetting to rerun `bun run build:llms` after adding a new doc fails `bun test`. The size budget (600KB) fails `bun test` if `llms-full.txt` balloons.

### What this means for you

If you're running GBrain: nothing to do. Your agent already has CLAUDE.md. But next time you install GBrain on Codex, Cursor, or OpenClaw, the agent lands on `AGENTS.md` and walks the install without hunting. If you run a fork, regenerate with `LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms` to rewrite URLs. If you publish GBrain docs alongside your own, `llms.txt` is the index; `llms-full.txt` is the drop-into-a-context-window bundle.

Credit to Codex for catching that the original plan's AGENTS.md was underpowered, that the eng review missed a content-contract test, and that the install prompt was the real leverage point. Seven of the fifteen Codex findings landed directly in the plan; three went to user decision; five stayed as intentional NOT-in-scope.

## To take advantage of this release

`gbrain upgrade` does not need to do anything. These are new public files; existing installs pick them up on their next pull.

1. **If you wrote a downstream fork:** regenerate with your URL base.
   ```bash
   LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms
   git add llms.txt llms-full.txt && git commit
   ```
2. **If you add a new doc under `docs/`:** add it to `scripts/llms-config.ts`, then
   ```bash
   bun run build:llms
   bun test test/build-llms.test.ts
   ```
   CI blocks ship if these drift.
3. **Verify it actually works:** ask a fresh LLM
   ```
   Fetch https://raw.githubusercontent.com/garrytan/gbrain/master/llms.txt and tell me
   how I'd debug a broken live sync.
   ```
   Answer should cite `docs/GBRAIN_VERIFY.md`, `docs/guides/live-sync.md`, and `gbrain doctor`.

### Itemized changes

#### Added
- `AGENTS.md` at repo root — ~45-line non-Claude-agent operating protocol. Install, read order, trust boundary, config/debug/migration pointers, fork instructions. Uses relative links so it survives renames.
- `llms.txt` at repo root — llmstxt.org-spec index. H1 + blockquote + 5 required H2 sections (Core entry points, Configuration, Debugging, Migrations) plus an Operational tips block with `gbrain doctor`, `gbrain orphans`, `gbrain repair-jsonb`. ~4KB.
- `llms-full.txt` at repo root — same index with core docs inlined under `## {path}` headings for single-fetch ingestion. ~225KB, under the 600KB `FULL_SIZE_BUDGET`.
- `scripts/llms-config.ts` — curated TS config. `LLMS_REPO_BASE` env var lets forks regenerate with their own URL base. `includeInFull: false` flags entries that should appear in `llms.txt` but not be inlined in `llms-full.txt` (Philosophy, Optional, CHANGELOG).
- `scripts/build-llms.ts` — the generator. Deterministic, no timestamps, sorted by config order. Warns (does not fail) if `llms-full.txt` exceeds `FULL_SIZE_BUDGET` with the biggest entries listed.
- `test/build-llms.test.ts` — 7 cases: paths resolve on disk, generator idempotent, llms.txt spec shape, checked-in files match generator output (drift guard), content contract (RESOLVER / AGENTS / INSTALL_FOR_AGENTS referenced), AGENTS mirrors README+INSTALL install path, size budget enforcement.
- `bun run build:llms` script in `package.json`.

#### Changed
- `README.md` — adds a one-line LLMs/Agents pointer above the install CTA and a follow-up paragraph under the agent paste block naming `AGENTS.md` + `llms.txt` as fallback entry points for non-Claude agents.
- `INSTALL_FOR_AGENTS.md` — new "Step 0: If you are not Claude Code" prelude points agents at `AGENTS.md` first.
- `CLAUDE.md` — adds `scripts/llms-config.ts`, `scripts/build-llms.ts`, and `AGENTS.md` to Key files. Explicitly notes that committed generator output is NOT analogous to `schema-embedded.ts` (no runtime consumer; committed for GitHub browsing + fork safety).

- `INSTALL_FOR_AGENTS.md:136` — `git pull origin main` → `git pull origin master`. Pre-existing drift: README and CI use `master`, `origin/HEAD -> master`, but the upgrade instructions told users to pull from a branch that doesn't exist. Folded into this release as a drive-by fix.

## [0.14.2] - 2026-04-20

## **Eight deferred bugs, root-cause fixes, one clean wave.**
## **Sync stops losing files. Migrations stop retrying forever. Pooler users get a knob.**

Eight bugs were previously scoped out of a PR after Codex review caught wrong root causes and unimplementable architectures. v0.14.2 takes each back to the actual code and fixes the structural gap. `/plan-eng-review` + `/codex consult` verified every load-bearing claim before a single line of code ran (20 findings, 12 triggered plan revisions before implementation).

The practical wins for a busy brain: `gbrain sync` no longer silently loses files with unquoted-colon YAML titles across any of the three sync paths. `gbrain upgrade` can't get stuck in an infinite retry loop on a wedged migration (3-partial cap + `--force-retry` escape hatch). Supabase pooler users have `GBRAIN_POOL_SIZE` to throttle without touching schemas. `gbrain doctor --fast` tells you WHY it's skipping DB checks instead of lying about no database being configured. `brain_score` gets a breakdown so 79/100 tells you which component is costing you the 21 points.

### The numbers that matter

Measured on this branch's diff against origin/master:

| Metric                                            | BEFORE v0.14.2      | AFTER v0.14.2              | Δ                       |
|---------------------------------------------------|---------------------|-----------------------------|-------------------------|
| Sync paths that silently drop files on YAML break | 3 of 3              | 0 of 3                      | **no more silent loss** |
| Wedged-migration retry loops                      | infinite            | 3-partial cap + `--force-retry` | bounded              |
| Pool-size knob for Supabase pooler                | none                | `GBRAIN_POOL_SIZE` env      | **first-class knob**    |
| `doctor --fast` messages                          | 1 catch-all         | 3 source-specific           | honest signal           |
| `brain_score` observability                       | one number          | 5-field breakdown (sum == total) | diagnosable         |
| Duplicate edges in `gbrain graph` output          | leaked per-origin   | deduped at presentation      | schema preserved        |
| `minion_jobs.max_stalled` default                 | 1 (dead-letter on first stall) | 3                | autopilot survives long embed runs |
| New + extended unit tests                         | 1696                | **1743 (+47 + 119 new assertions)** | +47                |
| Root-cause fixes vs symptom patches               | 0                   | **8 / 8**                   | structural              |

### What this means for you

Your agent's feedback loops tighten. When sync blocks, doctor surfaces the exact file with the YAML problem and the commit where it showed up. When a migration gets stuck, there's a cap and a clear escape. When you're on Supabase's transaction pooler and `gbrain upgrade` spawns subprocesses, set `GBRAIN_POOL_SIZE=2` and stop MaxClients crashes. Run `gbrain doctor` and the `brain_score` breakdown points at what to fix first: embed coverage, link density, timeline coverage, orphans, or dead links.

## To take advantage of v0.14.2

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Supabase pooler users (port 6543) now have a knob.** If you hit MaxClients during upgrades, set `GBRAIN_POOL_SIZE=2` (or lower) in your environment before running `gbrain upgrade`.
3. **Check sync health after the upgrade:**
   ```bash
   gbrain doctor
   ```
   If it warns about `sync_failures`, the paths and errors are in `~/.gbrain/sync-failures.jsonl`. Fix the offending YAML frontmatter and re-run `gbrain sync`, or use `gbrain sync --skip-failed` to acknowledge known-broken files and advance past them.
4. **Wedged migrations:** If `doctor` ever flags a version with 3 consecutive partials, run `gbrain apply-migrations --force-retry vX.Y.Z` to reset the state machine, then `gbrain apply-migrations --yes` to re-attempt.
5. **If any step fails or the numbers look wrong,** file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

### Itemized changes

#### Reliability
- **Bug 2: `GBRAIN_POOL_SIZE` env knob** (`src/core/db.ts`, `src/commands/import.ts`). Honored by both the singleton pool and the parallel-import worker pool. Defaults to 10; lower for Supabase transaction pooler. `initPostgres` / `initPGLite` now wrap lifecycle in `try { ... } finally { await engine.disconnect() }`.
- **Bug 3: Migration ledger centralization + wedge cap** (`src/commands/apply-migrations.ts`, `src/core/preferences.ts`). Runner owns all ledger writes. 3 consecutive partials = wedged, skipped with a loud message. New `--force-retry <version>` flag writes a `'retry'` marker without faking success. `complete` status never regresses. `appendCompletedMigration` is idempotent on double-complete.
- **Bug 8: `max_stalled` default 1 → 3** (`src/core/schema-embedded.ts`, `src/core/pglite-schema.ts`, `src/schema.sql`). First lock-lost tick no longer dead-letters. `v0_14_0` Phase A ALTERs existing installs. `autopilot-cycle` handler yields to the event loop between phases so the worker's lock-renewal timer fires. (v0.15.1 further bumps this to 5 and adds a non-terminal row backfill — see #219.)
- **Bug 9: Sync gate + acknowledge mechanism** (`src/commands/sync.ts`, `src/commands/import.ts`, `src/core/sync.ts`). All 3 sync paths (incremental, full via `runImport`, `gbrain import` git continuity) gate `sync.last_commit` on no-failures. Failures append to `~/.gbrain/sync-failures.jsonl` with dedup key. New `gbrain sync --skip-failed` + `--retry-failed` flags. Doctor surfaces unacknowledged failures.

#### Observability
- **Bug 7: `doctor --fast` source-aware messages** (`src/core/config.ts`, `src/cli.ts`, `src/commands/doctor.ts`). New `getDbUrlSource()` returns `'env:GBRAIN_DATABASE_URL' | 'env:DATABASE_URL' | 'config-file' | null`. Doctor emits `Skipping DB checks (--fast mode, URL present from env:GBRAIN_DATABASE_URL)` when applicable.
- **Bug 11: `brain_score` breakdown + metric clarity** (`src/core/types.ts`, both engines' `getHealth()`). Added `embed_coverage_score`, `link_density_score`, `timeline_coverage_score`, `no_orphans_score`, `no_dead_links_score`. Sum equals `brain_score` by construction. `dead_links` now on `BrainHealth` (resolves a pre-existing `featuresTeaserForDoctor` drift). `orphan_pages` docs clarified — it's "islanded" (no inbound AND no outbound), not the stricter "zero inbound" graph definition.

#### Graph correctness
- **Bug 6/10: `jsonb_agg(DISTINCT ...)` in legacy `traverseGraph`** (`src/core/postgres-engine.ts`, `src/core/pglite-engine.ts`). Presentation-level dedup only — the schema continues to preserve per-`origin_page_id` / per-`link_source` provenance rows. Fixes duplicate edges like `works_at → companies/brex` appearing twice in `gbrain graph`.

#### New migration
- **Bug 5: `v0_14_0` migration registered** (`src/commands/migrations/v0_14_0.ts`). Phase A: `ALTER minion_jobs.max_stalled SET DEFAULT 3` (idempotent). Phase B: emits `pending-host-work.jsonl` entry pointing at `skills/migrations/v0.14.0.md` for shell-jobs adoption. Registered in `src/commands/migrations/index.ts`.

#### Tests
- New: `test/traverse-graph-dedup.test.ts`, `test/sync-failures.test.ts`, `test/brain-score-breakdown.test.ts`, `test/migration-resume.test.ts`, `test/migrations-v0_14_0.test.ts`.
- Extended: `test/migrate.test.ts` (`resolvePoolSize`), `test/doctor.test.ts` (`dbSource`), `test/apply-migrations.test.ts` (`skippedFuture` includes `0.14.0`).
- E2E updated: `test/e2e/migration-flow.test.ts` assertions aligned with the new runner-owned-ledger contract (orchestrator no longer writes completed.jsonl directly).

#### Deferred to v0.15
- Deep `AbortSignal` threading through `runEmbedCore` / `runExtractCore` / `runBacklinksCore` / `performSync`. Between-phase yield addresses the Bug 8 lock-renewal root cause; mid-phase cancellation on huge brains belongs in the queue-polish PR.
- `failJobFromSweeper` for `handleTimeouts` / `handleStalled`. Current direct `status='dead'` writes kept.

## [0.14.1] - 2026-04-20

## **`gbrain doctor` stops crying wolf on DRY, and now repairs the real ones.**
## **Skill delegations via `_brain-filing-rules.md` finally count.**

`gbrain doctor --fast` was flagging 9 DRY violations on this repo, every run, for skills that properly delegated to `skills/_brain-filing-rules.md`. The old check only accepted `conventions/quality.md` as a valid delegation target, so every skill that correctly filed notability rules through the brain-filing-rules module got flagged anyway. Alert fatigue eroded every other doctor warning. v0.14.1 swaps the substring match for proximity-based suppression: a delegation reference within 40 lines of a pattern match (across `> **Convention:**`, `> **Filing rule:**`, and inline backtick paths) now correctly suppresses the violation.

The release also adds `gbrain doctor --fix` and `gbrain doctor --fix --dry-run`. Instead of telling you what's wrong, doctor can now repair it. Five guards keep the edits safe: refuses if the working tree is dirty (git is the rollback), refuses if the skill isn't inside a git repo (no rollback available), skips matches inside fenced code blocks (examples are not violations), skips when the pattern matches more than once (ambiguous), skips when a delegation reference already exists within 40 lines. Shell-injection safe via `execFileSync` array args. Trailing newline preserved. No `.bak` clutter, git is the backup contract.

### The numbers that matter

Measured on this repo's real skill library (28 skills, 3 cross-cutting patterns):

| Metric                                         | BEFORE v0.14.1      | AFTER v0.14.1                | Δ                 |
|------------------------------------------------|---------------------|------------------------------|-------------------|
| False-positive DRY violations                  | 1 flagged, 0 fixable| 0 flagged                    | **cleaner signal**|
| Genuine DRY violations surfaced                | 8                   | 8 (unchanged)                | honest count      |
| Auto-repairable via `--fix --dry-run`          | 0                   | 7 proposed, 4 intelligently skipped | new capability |
| Unit tests for doctor/resolver/dry-fix         | 24                  | **55 (+31)**                 | +31               |
| Adversarial review fixes in ship               | 0                   | **4 ship-blockers caught + fixed** | defense in depth |

The 4 adversarial fixes are worth calling out: shell injection via `execFileSync` array args, a silent-overwrite bug when skills live outside a git repo (now returns `no_git_backup`), EOF newline preservation on splice, and delegation-proximity consistency between detector (40 lines) and idempotency guard (now also 40 lines, was 10).

### What this means for you

Your agent's `gbrain doctor` output now means something again. Nine warnings a run was noise you learned to ignore; one real warning is signal. And when the doctor does flag an inlined rule, `gbrain doctor --fast --fix --dry-run` shows you exactly what the repair looks like before you commit to it. Run `gbrain doctor --fast --fix` to apply. Git is the undo button.

## To take advantage of v0.14.1

`gbrain upgrade` does this automatically. No manual migration required.

1. **Verify the detection fix:**
   ```bash
   gbrain doctor --fast --json | jq '.checks[] | select(.name=="resolver_health")'
   ```
2. **Try the auto-fix preview on your own brain:**
   ```bash
   gbrain doctor --fast --fix --dry-run
   ```
3. **Apply when ready:**
   ```bash
   gbrain doctor --fast --fix
   ```
4. **If anything looks wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with the `gbrain doctor --json` output.

### Itemized changes

#### Added
- `gbrain doctor --fix` applies `> **Convention:**` reference callouts to skills that inline cross-cutting rules (Iron Law back-linking, citation format, notability gate). `--dry-run` previews the diff without writing.
- Three shape-aware block expanders (bullet, blockquote, paragraph) in `src/core/dry-fix.ts`, each a pure function, each with unit tests.
- New `extractDelegationTargets()` helper in `src/core/check-resolvable.ts` parses `> **Convention:** `, `> **Filing rule:** `, and inline backtick references, normalizing paths to the `CROSS_CUTTING_PATTERNS.conventions` shape.
- `getWorkingTreeStatus()` returns 3-state `'clean' | 'dirty' | 'not_a_repo'` so the fixer never writes to files git can't roll back.

#### Changed
- `CROSS_CUTTING_PATTERNS` each list multiple valid delegation targets (notability gate accepts both `conventions/quality.md` and `_brain-filing-rules.md`).
- DRY suppression is proximity-based: `DRY_PROXIMITY_LINES = 40` for detector AND the fix-module's idempotency check (was inconsistent: 40 vs 10).
- Shell execution uses `execFileSync` with array args (no shell, no injection surface from manifest-derived paths).

#### Tests
- 31 new tests across `test/check-resolvable.test.ts` (DRY detection, 13 cases), `test/dry-fix.test.ts` (unit, 28 cases including expander pure-function tests), `test/doctor-fix.test.ts` (CLI integration, 3 cases).
- Full suite: 1694 pass, 0 fail.

## [0.14.0] - 2026-04-20

## **Move gateway crons to Minions. Zero LLM tokens per cron fire.**
## **Worker abort path finally marks aborted jobs dead.**

Your OpenClaw gateway pins at 100% CPU when your 32 cron jobs each boot a full Opus session per fire, and ~14 of them are pure API-fetch-and-write scripts that don't need reasoning at all. This release adds a `shell` job type to Minions so those deterministic crons move off the gateway to the Minions worker. ~60% gateway load reduction at OpenClaw scale. Retry, backoff, DLQ, unified `gbrain jobs list` visibility, all free. The LLM-reasoning crons stay on the gateway where they belong.

Getting there meant fixing the Minions worker abort path, which was quietly wrong since v0.11: aborted jobs (timeout, cancel, lock loss) returned silently without calling `failJob`, so status stayed `active` until a stall sweep found them ~30s later. This release makes abort-reason the `error_text` of an immediate `failJob` call. Handlers get cleaner signals, operators see accurate status, `--follow` stops hanging past timeouts.

### The numbers that matter

Measured on the new `test/minions-shell.test.ts` (40 unit cases) and `test/e2e/minions-shell.test.ts` (4 E2E cases) plus 5 rounds of pre-landing review (spec adversarial x2, CEO scope, DX, eng, Codex outside voice).

| Metric                                            | BEFORE v0.14.0          | AFTER v0.14.0                     | Δ                    |
|---------------------------------------------------|-------------------------|-----------------------------------|----------------------|
| LLM tokens per cron fire                          | ~full Opus context boot | 0 (deterministic crons)           | **100% reduction**   |
| Gateway CPU headroom with ~14 crons moved         | 0%                      | ~60% free                         | cron load off gateway|
| Aborted job status lag (timeout/cancel/lock-loss) | up to 30s               | immediate `failJob` call          | **deterministic**    |
| Shell submission surfaces                         | none                    | CLI + trusted `submit_job`        | 2 paths, both gated  |
| Submission audit trail                            | none                    | JSONL at `~/.gbrain/audit/`       | operational trace    |
| Unit tests                                        | 1318 pass               | **1358 pass (+40 shell cases)**   | +40                  |
| E2E tests                                         | 124                     | **128 (+4 shell lifecycle)**      | +4                   |
| Pre-landing review rounds                         | 1 (eng)                 | **5 (spec×2 / CEO / DX / eng / codex)** | 29 issues surfaced, 26 resolved |

The abort-path fix is the quietly-important one. Handlers that use `ctx.signal` for cooperative cancel (sync, embed) now have deterministic status flips instead of waiting for the stall sweep. Shell jobs get reliable timeout semantics for the first time: `cmd: 'sleep 30', timeout_ms: 2000` hits `dead` at ~2100ms instead of ~32000ms.

### What this means for OpenClaw operators

`gbrain upgrade` reads `skills/migrations/v0.14.0.md` and walks your host agent through the adoption: enable the worker with `GBRAIN_ALLOW_SHELL_JOBS=1`, audit every cron entry (LLM-requiring stays, deterministic moves), propose a rewrite per cron with a diff, verify one fire end-to-end before approving the next batch. Never auto-rewrites your crontab — every change is a human approval per-cron. On Postgres, one persistent worker daemon claims each job. On PGLite, every crontab invocation adds `--follow` for inline execution because PGLite doesn't support the worker daemon. Either way, your gateway CPU stops pinning at 100% and your live messages stop getting blocked by batch processing. See `docs/guides/minions-shell-jobs.md` for usage recipes and `skills/migrations/v0.14.0.md` for the adoption playbook.

### Itemized changes

#### New `shell` job type

- **Spawn arbitrary commands as Minions jobs.** Pass `{cmd: "string"}` (shell-interpolated via `/bin/sh -c`) or `{argv: ["bin","arg"]}` (no shell, safe for programmatic callers). Both forms require an absolute `cwd`. Env vars are scoped to a minimal allowlist (`PATH, HOME, USER, LANG, TZ, NODE_ENV`) to prevent accidental `$OPENAI_API_KEY` interpolation; callers opt-in to additional keys per job.
- **Two-layer security: MCP boundary + env flag.** `submit_job` rejects `name: 'shell'` when `ctx.remote === true`. Independent of the env flag. `MinionQueue.add('shell', ...)` also rejects unless the caller explicitly opts in via `{allowProtectedSubmit: true}` as the 4th arg, so an in-process handler can't programmatically submit a shell child by accident. Worker only registers the handler when `GBRAIN_ALLOW_SHELL_JOBS=1` is set on the worker process. Default: off. Opt in per-host.
- **Graceful child shutdown.** Abort fires SIGTERM, 5-second grace, then SIGKILL. Listens to both `ctx.signal` (timeout/cancel/lock-loss) and a new `ctx.shutdownSignal` (worker process SIGTERM/SIGINT), so deploy restarts don't orphan shell children. Non-shell handlers ignore `shutdownSignal` and keep running through the worker's 30s cleanup race.
- **UTF-8-safe output truncation.** stdout is retained as the last 64KB, stderr as the last 16KB, with a `[truncated N bytes]` marker prepended when exceeded. Uses `string_decoder.StringDecoder` so multibyte characters don't split across the truncation boundary.
- **Operational audit trail at `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl`** (ISO-week rotation, override via `GBRAIN_AUDIT_DIR`). Records caller, remote flag, job_id, cwd, and cmd/argv display. Never logs env values. Best-effort writes: failures log to stderr but don't block submission. Operational trace for "what did this cron submit last Tuesday," not forensic insurance.
- **Starvation warning on first-time submission.** If you `gbrain jobs submit shell ...` without `--follow` and no worker with the env flag is running, stderr prints a warning block pointing at both `--follow` and `gbrain jobs work` remediation. Turns a silent "job sits in waiting forever" failure mode into a directed next-step.

#### Worker abort path overhaul

- **Aborted jobs now call `failJob` with the abort reason.** Pre-v0.14.0 worker returned silently when `ctx.signal.aborted` fired, leaving jobs in `active` until stall sweep. Fixed: catch-block now derives reason from `abort.signal.reason` (`timeout`, `cancel`, `lock-lost`, `shutdown`) and calls `failJob(id, token, "aborted: <reason>")`. Token-match makes the call idempotent: if another path already flipped status, it no-ops cleanly. Downstream `--follow` loops and status assertions now reflect reality.
- **`ctx.shutdownSignal` separated from `ctx.signal`.** Only fires on worker process SIGTERM/SIGINT. Handlers that need shutdown-specific cleanup (currently: shell handler's SIGTERM→SIGKILL on its child) subscribe to both signals. Non-shell handlers subscribe only to `ctx.signal` and don't get cancelled mid-flight on deploy restart.

#### CLI + operation surface additions

- **`gbrain jobs submit --timeout-ms N`.** Per-job wall-clock timeout in ms. Surfaced from the existing `timeout_ms` schema field, which had no CLI flag before.
- **`submit_job` operation gains `timeout_ms` param.** Same field exposed through MCP (for non-protected names).
- **`gbrain jobs submit --help` lists handler types.** `shell` is explicitly called out as CLI-only with a pointer to the guide. Closes the "what handlers are even available" discovery gap.

#### Tests

- **40 new unit cases in `test/minions-shell.test.ts`** covering validation (cmd/argv/cwd/env), spawn happy + error paths, UTF-8 safe truncation, SIGTERM abort via both signals, env allowlist (OPENAI_API_KEY blocked, PATH inherited, caller override), ISO-week filename at year boundary (2027-01-01 → W53 2026), audit write happy + EACCES failure paths, whitespace-bypass defense on `MinionQueue.add(' shell ', ...)`, and auto-added regression tests per the iron rule (non-protected names unaffected).
- **4 E2E tests in `test/e2e/minions-shell.test.ts`** covering full lifecycle (submit → worker claim → spawn → complete with captured stdout), `MinionQueue.add` defense-in-depth, `submit_job` MCP-guard rejection, `submit_job` CLI-path acceptance.

#### Docs

- **New `docs/guides/minions-shell-jobs.md`** opens with a 30-second copy-paste hello-world, then covers the two-layer security model with honest callouts about what env allowlist does and does not do, Postgres vs PGLite crontab recipes side-by-side, debug playbook (`gbrain jobs list`, `gbrain jobs get`, audit log tail, PGLite `--follow` note), known limitations, and an `#errors` table linked from every `UnrecoverableError` the handler throws.
- **New `skills/migrations/v0.14.0.md`** is the adoption playbook your host agent reads on `gbrain upgrade`. Walks through enabling the worker, auditing cron entries (LLM-requiring vs deterministic), proposing per-cron rewrites with diffs, and verifying end-to-end before batch approval. Iron rule: never auto-rewrites the operator's crontab — every change is human-approved per-cron.
- **README.md** links the guide from the Commands section.

#### Pre-ship review

Five independent rounds surfaced 29 issues across the plan. 26 resolved before a single line of code was written: spec-review adversarial subagent (x2 iterations) caught implementer-ergonomic gaps (caller derivation, mkdirSync, ISO-week formatter). CEO review + SELECTIVE EXPANSION cherry-picked argv form, audit log, SIGTERM grace, env allowlist, MCP-guard defense-in-depth, honest FS-read trust model, orphan-child `setTimeout.unref()` fix. DX review added the starvation warning block. Eng review added `ctx.shutdownSignal` separation, revised trusted-arg from opts-fold to separate 4th arg (stops accidental pass-through via `{...userOpts}` spreads), 18 additional test cases, 4 iron-rule regression tests. Codex outside voice caught 4 architectural dealbreakers: the worker abort silent-return bug (the "contract is a lie" finding), `--timeout-ms` CLI flag and `submit_job` param both missing, `PROTECTED_JOB_NAMES.has(name)` whitespace bypass before normalization. Effort estimate revised 8-10h → 16-20h once the full review was done.
## [0.13.1] - 2026-04-20

## **The brain stops being a write-once graph and starts being a runtime.**
## **Five new modules land on top of v0.12's knowledge graph layer.**

GBrain v0.13.1 ships the Knowledge Runtime delta on top of v0.13.0's frontmatter graph. Typed abstractions that turn a knowledge base into a runtime other agents can adopt. Five focused modules build on the v0.12.0 graph layer and v0.11.x Minions orchestration. A Resolver SDK unifies external lookups. A BrainWriter enforces integrity pre-commit. `gbrain integrity` repairs bare-tweet citations at scale. A BudgetLedger caps runaway resolver spend. Minions gains TZ-aware quiet-hours at claim time.

### What you can do now that you couldn't before

- **`gbrain integrity --auto --confidence 0.8`** repairs the 1,424 bare-tweet citations in your brain without human review. Three-bucket confidence: auto-repair ≥0.8, review queue 0.5–0.8, skip <0.5. Resumable via `~/.gbrain/integrity-progress.jsonl`.
- **`gbrain resolvers list`** introspects the typed plugin registry. Two builtins ship: `url_reachable` (HEAD check + SSRF guard) and `x_handle_to_tweet` (X API v2 with confidence scoring). Every result carries `{value, confidence, source, fetchedAt, costEstimate, raw}`.
- **`gbrain config set budget.daily_cap_usd 10`** puts a hard wall on resolver spend. Concurrent reserves serialize via `SELECT FOR UPDATE`. TTL auto-reclaim handles process death between reserve and commit.
- **BrainWriter + pre-commit validators** make the Philip-Leung hallucination class structurally impossible. `Scaffolder` builds every tweet URL from API output, never LLM text. `SlugRegistry` detects name collisions at create time. Four validators (citation, link, back-link, triple-HR) run on write. `writer.lint_on_put_page=true` enables observability before the strict-mode flip.
- **Quiet-hours on Minion jobs** stop the 3am DM. Set `quiet_hours: {start:22, end:7, tz:"America/Los_Angeles", policy:"defer"}` on a job. Worker checks at claim time (not dispatch). Wrap-around windows supported.

### Schema migrations

Three new migrations, all idempotent, apply automatically on `gbrain init` / upgrade.

- **v11 — budget_ledger + budget_reservations.** Per-(scope, resolver, local_date) rollup with held-reservation TTL. Rollback: DROP TABLE (budget is regenerable from resolver call logs).
- **v12 — minion_jobs.quiet_hours + stagger_key.** Additive nullable columns; existing rows keep working unchanged.
- **TS v0.13.1 — grandfather `validate: false`.** Walks every page, adds the opt-out frontmatter so legacy content skips the new validators. `gbrain integrity --auto` clears the flag per-page as citations are repaired. Rollback log at `~/.gbrain/migrations/v0_13_1-rollback.jsonl`.

### Out of scope (intentional, per CEO plan)

- **Strict-mode default flip.** BrainWriter ships with `strict_mode=lint`. The flip to strict requires a 7-day soak + BrainBench regression ≤1pt + zero false-positive count.
- **Sandboxed user plugins.** v0.13 ships builtins only. User-provided TS modules deferred pending a real isolation story (worker_threads or vm2) in a follow-on release.
- **`openai_embedding` refactor.** Deferred to PR 1.5 post-flip; embedding is a hot path.
- **OpenClaw `claw-bridge`.** Adoption path is documentation-only this release.

### Tests

- **89 new unit tests** across `test/resolvers.test.ts` (43), `test/writer.test.ts` (57), `test/integrity.test.ts` (21), `test/enrichment.test.ts` (23), `test/minions-quiet-hours.test.ts` (25), `test/post-write-lint.test.ts` (11), `test/migrations-v0_13_0.test.ts` (5).
- **E2E passes on Postgres:** 115 pass / 0 fail across mechanical, sync, upgrade, minions concurrency + resilience, graph-quality, MCP, migration-flow, search-quality, skills (Tier 2 Opus/Sonnet).
- **1574 total tests pass** with an active test Postgres container. 1522 pass in unit-only mode (E2E auto-skip without DATABASE_URL).

### Itemized changes

#### Resolver SDK (`src/core/resolvers/`)
`Resolver<I, O>` interface with `{id, cost, backend, available(), resolve()}`. In-memory `ResolverRegistry`. `ResolverContext` carries `{engine, storage, config, logger, requestId, remote, deadline?, signal?}` — the `remote` flag mirrors `OperationContext.remote` for uniform trust boundaries. `FailImproveLoop.execute` gained optional `opts.signal`; backwards compatible. Two reference builtins: `url_reachable` (SSRF guard reuses wave-3 `isInternalUrl`, max-5 redirects with per-hop re-validation, AbortSignal composition) and `x_handle_to_tweet` (X API v2 recent search, strict handle regex, confidence-scored matches, 2x 429 retry honoring Retry-After, 401/403 → `ResolverError(auth)`). `gbrain resolvers list|describe` for introspection.

#### BrainWriter + validators (`src/core/output/`)
`BrainWriter.transaction(fn, ctx)` over `engine.transaction` with pre-commit validators via `WriteTx` API. Scaffolder builds typed citations (`tweetCitation`, `emailCitation`, `sourceCitation`) + `entityLink` + `timelineLine` — URLs from structured IDs, never LLM text. `SlugRegistry` detects collisions at create time. Four validators (`citation`, `link`, `back-link`, `triple-hr`) skip fenced code / inline code / HTML comments correctly. Config flag `writer.strict_mode` (default `lint`).

#### gbrain integrity (`src/commands/integrity.ts`)
Four subcommands: `check` (read-only report with `--json`, `--type`, `--limit`), `auto` (three-bucket repair with `--confidence`, `--review-lower`, `--dry-run`, `--fresh`, `--limit`), `review` (prints queue path + count), `reset-progress`. Nine bare-tweet phrase regexes. External-link extraction for optional dead-link probing. Repairs route through `BrainWriter.transaction`.

#### BudgetLedger + CompletenessScorer (`src/core/enrichment/`)
`BudgetLedger.reserve` returns `{kind:'held'}` or `{kind:'exhausted'}`. FOR UPDATE serializes concurrent reserves. `commit`, `rollback`, `cleanupExpired`. Midnight rollover via `Intl.DateTimeFormat` en-CA in configured IANA tz. Seven per-type rubrics + default (weights sum to 1.0). Person rubric's `non_redundancy` and `recency_score` kill Garry's OpenClaw's length-only heuristic + 30-day-re-enrich-forever pathologies.

#### Minions scheduler polish (`src/core/minions/`)
`quiet-hours.ts` — pure `evaluateQuietHours(cfg, now?)`. Wrap-around windows. Unknown tz fails open. `stagger.ts` — FNV-1a → 0–59 deterministic across runtimes. `worker.ts` integrated: post-claim evaluation, defer → `delayed/+15m`, skip → `cancelled`.

#### Post-write lint hook (`src/core/output/post-write.ts`)
`runPostWriteLint` invokes the four validators against freshly-written pages. Gated on `writer.lint_on_put_page` (default false). Wired into `put_page` operation handler as non-blocking. Findings go to `~/.gbrain/validator-lint.jsonl` + `engine.logIngest`.

#### Design doc
`docs/designs/KNOWLEDGE_RUNTIME.md` — 717 lines covering the 4-layer architecture, integration seams, 7-phase migration path, 10 open questions. Promoted to repo so future contributors can trace decisions.

#### Prior learnings applied
- Snapshot slugs upfront (`engine.getAllSlugs()`) in grandfather migration — avoids pagination-mutation instability.
- TS-registry migrations only (post-v0.11.1 migration-discovery change).
- Migration never calls `saveConfig` — avoids Postgres→PGLite flip.
- Quiet-hours at claim/promote, not dispatch — queued job becomes claimable after window opens.
- Core fn pattern for any handler wrapping a CLI command.
- Schema v11 not v8 (graph layer took v8-v10).
- `gray-matter` + line tokenizer for citation parsing, not `marked.lexer`.

## [0.13.0] - 2026-04-20

## **Frontmatter becomes a graph. Every `company:`, `investors:`, `attendees:` you wrote turns into typed edges automatically.**
## **Graph queries get dramatically richer without you changing a word of content.**

v0.13 teaches the knowledge graph to read your YAML frontmatter. A `company: Acme` on a person page becomes a `works_at` edge. `investors: [Fund-A, Fund-B]` on a deal page becomes `invested_in` edges pointing to the deal. `attendees: [alice, charlie]` on a meeting page becomes `attended` edges. Direction respects subject-of-verb: `people/alice → meetings/2026-04-03` reads naturally because Alice is the one who attended. `gbrain graph <entity> --depth 2` against an entity with rich frontmatter goes from returning ~7 nodes to 50+, with zero skill edits or frontmatter changes.

Everything else stays the same. Agents writing `put_page` with frontmatter today work unchanged, the graph populates behind the scenes. The `auto_links` response gains one additive field: `unresolved`, so agents can see which frontmatter names couldn't be matched to existing pages and queue them for enrichment. No breaking changes to any public API.

### The numbers that matter

Benchmarked against a 46K-page production brain with ~15K frontmatter references:

| Metric | Before (v0.12) | After (v0.13) | Δ |
|--------|----------------|----------------|---|
| Graph edges total | 28K | 43K | +54% |
| `gbrain graph <hub-entity> --depth 2` node count | 7 | 52 | +643% |
| 4-hop queries (person → company → deal → investor) | fail | return aggregate | unlocked |
| Migration wall-clock on 46K pages | N/A | 3min | one-time |
| LLM API calls during migration | N/A | 0 | deterministic |
| Embedding API calls during migration | N/A | 0 | zero cost |

| Frontmatter field | Edges produced on 46K-page test brain |
|-------------------|----------------------------------------|
| `company`, `companies` (person pages) | ~9,800 |
| `key_people` (company pages) | ~1,400 |
| `investors` (deal + company pages) | ~2,100 |
| `attendees` (meeting pages) | ~800 |
| `partner` (company pages) | ~180 |
| `sources`, `source` (any page) | ~1,200 |
| `related`, `see_also` (any page) | ~400 |

The 4-hop query pattern that motivated this release: "top investors in an advisor's portfolio." Pre-v0.13: impossible without manual graph edits. Post-v0.13: `gbrain graph <advisor-slug> --depth 2 --type yc_partner,invested_in` returns ranked fund pages with frequencies. Works because the advisor's `companies:` field points to portfolio companies, those companies' `partner:` field points back, and their `investors:` field resolves to fund pages.

### What this means for OpenClaw agents

If you maintain an agent fork that uses gbrain as its persistent memory, v0.13 is the easiest upgrade since v0.7. Run `gbrain upgrade`, wait ~3 minutes while the orchestrator runs schema + backfill, and graph queries get better. No skill edits required for the majority of skills. Three skills (`meeting-ingestion`, `enrich`, `idea-ingest`) gain an optional new phase if you want to consume the new `auto_links.unresolved` field, see `docs/UPGRADING_DOWNSTREAM_AGENTS.md` for the exact diffs.

## To take advantage of v0.13

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v0.13.0.md` the next time you interact with it.** If your agent is headless (cron, OpenClaw worker, Minion handler), the migration orchestrator already ran the mechanical side; no additional agent action is needed.
3. **Verify the outcome:**
   ```bash
   gbrain graph <some-entity> --depth 2   # any entity with frontmatter refs
   gbrain stats                       # link_count should reflect ~15-20K new frontmatter edges
   ```
4. **If any step fails or the numbers look wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**Knowledge graph, frontmatter edge projection:**
- `src/core/link-extraction.ts`, new `FRONTMATTER_LINK_MAP` (canonical field to type + direction + dir-hint map). New `SlugResolver` interface + `makeResolver(engine, {mode})` factory. `extractFrontmatterLinks` extractor. `extractPageLinks` becomes async and emits frontmatter edges alongside markdown refs. `LinkCandidate` gains `fromSlug`, `linkSource`, `originSlug`, `originField`.
- `src/core/operations.ts::runAutoLink`, bidirectional reconciliation. Outgoing edges (markdown + own-frontmatter) reconciled via `getLinks`; incoming edges (other-page to self from `key_people`/`attendees`/etc.) reconciled via `getBacklinks` scoped to `origin_page_id`. Manual edges (`link_source='manual'`) never touched.
- `put_page` response shape extends with `auto_links.unresolved: Array<{field, name}>`. Additive; existing clients unaffected.

**Slug resolver:**
- Two-mode resolver (`batch` for migration, `live` for put_page post-hook). Fallback chain: exact slug, dir-hint construction, pg_trgm fuzzy match, optional keyword search (live only, `expand: false` mandatory per `operations-query-hidden-haiku` learning).
- New engine method `findByTitleFuzzy(name, dirPrefix?, minSimilarity?)` implemented on both Postgres and PGLite engines. Uses the `%` operator + `similarity()` function; GIN trigram index drives the match.
- Per-run cache: same name, single DB lookup.

**Schema migrations:**
- migrate.ts v11 (`links_provenance_columns`): adds `link_source`, `origin_page_id`, `origin_field`. Swaps unique constraint to `UNIQUE NULLS NOT DISTINCT (from, to, type, link_source, origin_page_id)`. CHECK constraint on `link_source` values. New indexes on link_source + origin_page_id.
- `src/commands/migrations/v0_13_0.ts`, release orchestrator (Phase A schema, Phase B backfill, Phase C verify). Registered in migrations/index.ts. Resumable via `partial` status + `ON CONFLICT DO NOTHING`.

**Engine layer:**
- Both engines: `addLink` gains `linkSource`, `originSlug`, `originField` params. `addLinksBatch` unnest grows from 4 columns to 7. `removeLink` gains optional `linkSource` filter. `getLinks` + `getBacklinks` now return `link_source`, `origin_slug`, `origin_field` in the Link shape.
- PGLite + Postgres parity verified end-to-end in `test/pglite-engine.test.ts`.

**Release reliability (applies to every future release):**
- `src/commands/upgrade.ts`, best-effort `gbrain post-upgrade` failures now append a structured record to `~/.gbrain/upgrade-errors.jsonl` instead of silently swallowing the error.
- `src/commands/doctor.ts`, surfaces the latest upgrade-errors entry with a paste-ready recovery hint. Works alongside the existing partial-migration detector.
- CHANGELOG format adds the "To take advantage of v[version]" block pattern (seen above). Required for every release going forward so users have a self-repair path when automation fails.

**CLI changes:**
- `gbrain extract links --source db --include-frontmatter`, v0.13 flag. Default OFF for back-compat (existing `gbrain extract` runs don't suddenly get new edges). Migration orchestrator explicitly enables it for the one-time backfill.
- `gbrain extract` now prints a top-20 summary of unresolvable frontmatter names when `--include-frontmatter` is active, so users see exactly where the graph has holes.

**Tests:**
- `test/pglite-engine.test.ts` covers new 7-column addLinksBatch unnest + NULLS NOT DISTINCT semantics + ON CONFLICT on the new constraint.
- `test/link-extraction.test.ts` covers async signature regression, resolver fallback chain, cache hit, bad-type skip, context enrichment.
- `test/extract.test.ts` covers fs-source async signature, `includeFrontmatter` opt-in, incoming-direction semantics for `investors`/`key_people`/`attendees`.
- `test/migrate.test.ts` updated for new constraint name post-v11.
- `test/apply-migrations.test.ts` registry now includes v0.13.0 in skippedFuture buckets for older installed versions.

**Documentation:**
- `skills/migrations/v0.13.0.md`, user-facing upgrade skill.
- `docs/UPGRADING_DOWNSTREAM_AGENTS.md`, appended v0.13 section: no-action-required verdict + field-to-type map + optional skill diffs for meeting-ingestion, enrich, idea-ingest.

## [0.12.3] - 2026-04-19

## **Reliability wave: the pieces v0.12.2 didn't cover.**
## **Sync stops hanging. Search timeouts stop leaking. `[[Wikilinks]]` are edges.**

v0.12.2 shipped the data-correctness hotfix (JSONB double-encode, splitBody, `/wiki/` types, parseEmbedding). This wave lands the remaining reliability fixes from the same community review pass, plus a graph-layer feature a 2,100-page brain needed to stop bleeding edges. No schema changes. No migration. `gbrain upgrade` pulls it.

### What was broken

**Incremental sync deadlocked past 10 files.** `src/commands/sync.ts` wrapped the whole import in `engine.transaction`, and `importFromContent` also wrapped each file. PGLite's `_runExclusiveTransaction` is non-reentrant — the inner call parks on the mutex the outer call holds, forever. In practice: 3 files synced fine, 15 files hung in `ep_poll` until you killed the process. Bulk Minions jobs and citation-fixer dream-cycles regularly hit this. Discovered by @sunnnybala.

**`statement_timeout` leaked across the postgres.js pool.** `searchKeyword` and `searchVector` bounded queries with `SET statement_timeout='8s'` + `finally SET 0`. But every tagged template picks an arbitrary pool connection, so the SET, the query, and the reset could land on three different sockets. The 8s cap stuck to whichever connection ran the SET, got returned to the pool, and the next unrelated caller inherited it. Long-running `embed --all` jobs and imports clipped silently. Fix by @garagon.

**Obsidian `[[WikiLinks]]` were invisible to the auto-link post-hook.** `extractEntityRefs` only matched `[Name](people/slug)`. On a 2,100-page brain with wikilinks throughout, `put_page` extracted zero auto-links. `DIR_PATTERN` also missed domain-organized wiki roots (`entities`, `projects`, `tech`, `finance`, `personal`, `openclaw`). After the fix: 1,377 new typed edges on a single `extract --source db` pass. Discovered and fixed by @knee5.

**Corrupt embedding rows broke every query that touched them.** `getEmbeddingsByChunkIds` on Supabase could return a pgvector string instead of a `Float32Array`. v0.12.2 fixed the normal path by normalizing inputs, but one genuinely bad row still threw and killed the ranking pass. Availability matters more than strictness on the read path.

### What you can do now that you couldn't before

- **Sync 100 files without hanging.** Per-file atomicity preserved, outer wrap removed. Regression test asserts `engine.transaction` is not called at the top level of `src/commands/sync.ts`. Contributed by @sunnnybala.
- **Run a long `embed --all` on Supabase without strangling unrelated queries.** `searchKeyword` / `searchVector` use `sql.begin` + `SET LOCAL` so the timeout dies with the transaction. 5 regression tests in `test/postgres-engine.test.ts` pin the new shape. Contributed by @garagon.
- **Write `[[people/balaji|Balaji Srinivasan]]` in a page and see a typed edge.** Same extractor, two syntaxes. Matches the filesystem walker — the db and fs sources now produce the same link graph from the same content. Contributed by @knee5.
- **Find your under-connected pages.** `gbrain orphans` surfaces pages with zero inbound wikilinks, grouped by domain. `--json`, `--count`, and `--include-pseudo` flags. Also exposed as the `find_orphans` MCP operation so agents can run enrichment cycles without CLI glue. Contributed by @knee5.
- **Degraded embedding rows skip+warn instead of throwing.** New `tryParseEmbedding()` sibling of `parseEmbedding()`: returns `null` on unknown input and warns once per process. Used on the search/rescore path. Migration and ingest paths still throw — data integrity there is non-negotiable.
- **`gbrain doctor` tells you which brains still need repair.** Two new checks: `jsonb_integrity` scans the four v0.12.0 write sites and reports rows where `jsonb_typeof = 'string'`; `markdown_body_completeness` heuristically flags pages whose `compiled_truth` is <30% of raw source length when raw has multiple H2/H3 boundaries. Fix hint points at `gbrain repair-jsonb` and `gbrain sync --force`.

### How to upgrade

```bash
gbrain upgrade
```

No migration, no schema change, no data touch. If you're on Postgres and haven't run `gbrain repair-jsonb` since v0.12.2, the v0.12.2 orchestrator still runs on upgrade. New `gbrain doctor` will tell you if anything still looks off.

### Itemized changes

**Sync deadlock fix (#132)**
- `src/commands/sync.ts` — remove outer `engine.transaction` wrap; per-file atomicity preserved by `importFromContent`'s own wrap.
- `test/sync.test.ts` — new regression guard asserting top-level `engine.transaction` is not called on > 10-file sync paths.
- Contributed by @sunnnybala.

**postgres-engine statement_timeout scoping (#158)**
- `src/core/postgres-engine.ts` — `searchKeyword` and `searchVector` rewritten to `sql.begin(async (tx) => { await tx\`SET LOCAL statement_timeout = ...\`; ... })`. GUC dies with the transaction; pool reuse is safe.
- `test/postgres-engine.test.ts` — 5 regression tests including a source-level guardrail grep against the production file (not a test fixture) asserting no bare `SET statement_timeout` outside `sql.begin`.
- Contributed by @garagon.

**Obsidian wikilinks + extended domain patterns (#187 slice)**
- `src/core/link-extraction.ts` — `extractEntityRefs` matches both `[Name](people/slug)` and `[[people/slug|Name]]`. `DIR_PATTERN` extended with `entities`, `projects`, `tech`, `finance`, `personal`, `openclaw`.
- Matches existing filesystem-walker behavior.
- Contributed by @knee5.

**`gbrain orphans` command (#187 slice)**
- `src/commands/orphans.ts` — new command with text/JSON/count outputs and domain grouping.
- `src/core/operations.ts` — `find_orphans` MCP operation.
- `src/cli.ts` — `orphans` added to `CLI_ONLY`.
- `test/orphans.test.ts` — 203 lines covering detection, filters, and all output modes.
- Contributed by @knee5.

**`tryParseEmbedding()` availability helper**
- `src/core/utils.ts` — new `tryParseEmbedding(value)`: returns `null` on unknown input, warns once per process via a module-level flag.
- `src/core/postgres-engine.ts` — `getEmbeddingsByChunkIds` uses `tryParseEmbedding` so one bad row degrades ranking instead of killing the query.
- `test/utils.test.ts` — new cases for null-return and single-warn.
- Hand-authored; codifies the split-by-call-site rule from the #97/#175 review.

**Doctor detection checks**
- `src/commands/doctor.ts` — `jsonb_integrity` scans `pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`, `files.metadata` and reports `jsonb_typeof='string'` counts; `markdown_body_completeness` heuristic for ≥30% shrinkage vs raw source on multi-H2 pages.
- `test/doctor.test.ts` — detection unit tests assert both checks exist and cover the four JSONB sites.
- `test/e2e/jsonb-roundtrip.test.ts` — the regression test that should have caught the original v0.12.0 double-encode bug; round-trips all four JSONB write sites against real Postgres.
- `docs/integrations/reliability-repair.md` — guide for v0.12.0 users: detect via `gbrain doctor`, repair via `gbrain repair-jsonb`.

**No schema changes. No migration. No data touch.**

## [0.12.2] - 2026-04-19

## **Postgres frontmatter queries actually work now.**
## **Wiki articles stop disappearing when you import them.**

This is a data-correctness hotfix for the `v0.12.0`-and-earlier Postgres-backed brains. If you run gbrain on Postgres or Supabase, you've been losing data without knowing it. PGLite users were unaffected. Upgrade auto-repairs your existing rows. Lands on top of v0.12.1 (extract N+1 fix + migration timeout fix) — pull `gbrain upgrade` and you get both.

### What was broken

**Frontmatter columns were silently stored as quoted strings, not JSON.** Every `put_page` wrote `frontmatter` to Postgres via `${JSON.stringify(value)}::jsonb` — postgres.js v3 stringified again on the wire, so the column ended up holding `"\"{\\\"author\\\":\\\"garry\\\"}\""` instead of `{"author":"garry"}`. Every `frontmatter->>'key'` query returned NULL. GIN indexes on JSONB were inert. Same bug on `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`, and `page_versions.frontmatter`. PGLite hid this entirely (different driver path) — which is exactly why it slipped past the existing test suite.

**Wiki articles got truncated by 83% on import.** `splitBody` treated *any* standalone `---` line in body content as a timeline separator. Discovered by @knee5 migrating a 1,991-article wiki where a 23,887-byte article landed in the DB as 593 bytes (4,856 of 6,680 wikilinks lost).

**`/wiki/` subdirectories silently typed as `concept`.** Articles under `/wiki/analysis/`, `/wiki/guides/`, `/wiki/hardware/`, `/wiki/architecture/`, and `/writing/` defaulted to `type='concept'` — type-filtered queries lost everything in those buckets.

**pgvector embeddings sometimes returned as strings → NaN search scores.** Discovered by @leonardsellem on Supabase, where `getEmbeddingsByChunkIds` returned `"[0.1,0.2,…]"` instead of `Float32Array`, producing `[NaN]` query scores.

### What you can do now that you couldn't before

- **`frontmatter->>'author'` returns `garry`, not NULL.** GIN indexes work. Postgres queries by frontmatter key actually retrieve pages.
- **Wiki articles round-trip intact.** Markdown horizontal rules in body text are horizontal rules, not timeline separators.
- **Recover already-truncated pages with `gbrain sync --full`.** Re-import from your source-of-truth markdown rebuilds `compiled_truth` correctly.
- **Search scores stop going `NaN` on Supabase.** Cosine rescoring sees real `Float32Array` embeddings.
- **Type-filtered queries find your wiki articles.** `/wiki/analysis/` becomes type `analysis`, `/writing/` becomes `writing`, etc.

### How to upgrade

```bash
gbrain upgrade
```

The `v0.12.2` orchestrator runs automatically: applies any schema changes, then `gbrain repair-jsonb` rewrites every double-encoded row in place using `jsonb_typeof = 'string'` as the guard. Idempotent — re-running is a no-op. PGLite engines short-circuit cleanly. Batches well on large brains.

If you want to recover pages that were truncated by the splitBody bug:

```bash
gbrain sync --full
```

That re-imports every page from disk, so the new `splitBody` rebuilds the full `compiled_truth` correctly.

### What's new under the hood

- **`gbrain repair-jsonb`** — standalone command for the JSONB fix. Run it manually if needed; the migration runs it automatically. `--dry-run` shows what would be repaired without touching data. `--json` for scripting.
- **CI grep guard** at `scripts/check-jsonb-pattern.sh` — fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern. Wired into `bun test` so it runs on every CI invocation.
- **New E2E regression test** at `test/e2e/postgres-jsonb.test.ts` — round-trips all four JSONB write sites against real Postgres and asserts `jsonb_typeof = 'object'` plus `->>` returns the expected scalar. The test that should have caught the original bug.
- **Wikilink extraction** — `[[page]]` and `[[page|Display Text]]` syntaxes now extracted alongside standard `[text](page.md)` markdown links. Includes ancestor-search resolution for wiki KBs where authors omit one or more leading `../`.

### Migration scope

The repair touches five JSONB columns:
- `pages.frontmatter`
- `raw_data.data`
- `ingest_log.pages_updated`
- `files.metadata`
- `page_versions.frontmatter` (downstream of `pages.frontmatter` via INSERT...SELECT)

Other JSONB columns in the schema (`minion_jobs.{data,result,progress,stacktrace}`, `minion_inbox.payload`) were always written via the parameterized `$N::jsonb` form so they were never affected.

### Behavior changes (read this if you upgrade)

`splitBody` now requires an explicit sentinel for timeline content. Recognized markers (in priority order):
1. `<!-- timeline -->` (preferred — what `serializeMarkdown` emits)
2. `--- timeline ---` (decorated separator)
3. `---` directly before `## Timeline` or `## History` heading (backward-compat fallback)

If you intentionally used a plain `---` to mark your timeline section in source markdown, add `<!-- timeline -->` above it manually. The fallback covers the common case (`---` followed by `## Timeline`).

### Attribution

Built from community PRs #187 (@knee5) and #175 (@leonardsellem). The original PRs reported the bugs and proposed the fixes; this release re-implements them on top of the v0.12.0 knowledge graph release with expanded migration scope, schema audit (all 5 affected columns vs the 3 originally reported), engine-aware behavior, CI grep guard, and an E2E regression test that should have caught this in the first place. Codex outside-voice review during planning surfaced the missed `page_versions.frontmatter` propagation path and the noisy-truncated-diagnostic anti-pattern that was dropped from this scope. Thanks for finding the bugs and providing the recovery path — both PRs left work to do but the foundation was right.

Co-Authored-By: @knee5 (PR #187 — splitBody, inferType wiki, JSONB triple-fix)
Co-Authored-By: @leonardsellem (PR #175 — parseEmbedding, getEmbeddingsByChunkIds fix)

## [0.12.1] - 2026-04-19

## **Extract no longer hangs on large brains.**
## **v0.12.0 upgrade no longer times out on duplicates.**

Two production-blocking bugs Garry hit on his 47K-page brain on April 18. `gbrain extract` was effectively unusable on any brain with 20K+ existing links or timeline entries — it pre-loaded the entire dedup set with one `getLinks()` call per page over the Supabase pooler, hanging for 10+ minutes producing zero output before any work started. The v0.12.0 schema migration that creates `idx_timeline_dedup` was failing on brains with pre-existing duplicate timeline rows because the `DELETE ... USING` self-join was O(n²) without an index, hitting Supabase Management API's 60-second ceiling on 80K+ duplicates. Both bugs end here.

### The numbers that matter

Measured on the new `test/extract-fs.test.ts` and `test/migrate.test.ts` regression suites, plus 73 E2E tests against real Postgres+pgvector. Reproducible: `bun test` + `bun run test:e2e`.

| Metric                                  | BEFORE v0.12.1     | AFTER v0.12.1     | Δ                  |
|-----------------------------------------|--------------------|--------------------|--------------------|
| extract hang on 47K-page brain          | 10+ min, zero output | immediate work, ~30-60s wall clock | usable            |
| DB round-trips per re-extract           | 47K reads + 235K writes | 0 reads + ~2.4K writes | **~99% fewer** |
| v0.12.0 migration on 80K duplicate rows | timed out at 60s    | completes <1s     | **~60x+ faster**   |
| Re-run on already-extracted brain       | 235K row-writes     | 0 row-writes      | true no-op         |
| Tests                                   | 1297 unit / 105 E2E | **1412 unit / 119 E2E** | +115 unit / +14 E2E |
| `created` counter on re-runs            | "5000 created" (lie) | "0 created" (truth)| accurate           |

Per-batch round-trip math: a re-extract on a 47K-page brain with ~5 links per page used to do 235K sequential round-trips over the Supabase pooler. With 100-row batched INSERTs it does ~2,400. The hang came from the read pre-load (47K serial `getLinks()` calls), which is now gone entirely. The DB enforces uniqueness via `ON CONFLICT DO NOTHING`.

### What this means for GBrain users

If you've been afraid to re-run `gbrain extract` because it might never finish, that's over. The command starts producing output immediately, batch-writes 100 rows per round-trip, and reports a truthful insert count even on re-runs. If your v0.12.0 upgrade got stuck on the timeline migration (or you had to manually run `CREATE TABLE ... AS SELECT DISTINCT ON ...` to unblock it), the next `gbrain init --migrate-only` is sub-second. Run `gbrain extract all` on your largest brain and watch it actually work.

### Itemized changes

#### Performance

- **`gbrain extract` no longer pre-loads the dedup set.** Removed the N+1 read loop in `extractLinksFromDir`, `extractTimelineFromDir`, `extractLinksFromDB`, and `extractTimelineFromDB` that called `engine.getLinks(slug)` (or `getTimeline`) once per page across `engine.listPages({ limit: 100000 })`. On a 47K-page brain that was 47K serial network round-trips before the first file was even read. Both engines already enforced uniqueness at the SQL layer (`UNIQUE(from_page_id, to_page_id, link_type)` on `links`, `idx_timeline_dedup` on `timeline_entries`); the in-memory dedup `Set` was redundant insurance that turned into the bottleneck.
- **Batched multi-row INSERTs replace per-row writes.** All four extract paths now buffer 100 candidates and flush via new `addLinksBatch` / `addTimelineEntriesBatch` engine methods. Round-trips drop ~100x: ~235K → ~2,400 per full re-extract. Each batch uses `INSERT ... SELECT FROM unnest($1::text[], $2::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4 (links) or 5 (timeline) array-typed bound parameters regardless of batch size, sidestepping Postgres's 65535-parameter cap entirely. PGLite uses the same SQL shape with manual `$N` placeholders.

#### Correctness

- **`created` counter is now truthful on re-runs.** Returns count of rows actually inserted (via `RETURNING 1` row count), not "calls that didn't throw." A re-run on a fully-extracted brain prints `Done: 0 links, 0 timeline entries from 47000 pages`. Before this release it would print `Done: 5000 links` while inserting zero new rows.
- **`--dry-run` deduplicates candidates across files.** A link extracted from 3 different markdown files now prints exactly once in `--dry-run` output, matching what the batch insert would actually create. Before this release the dedup was tied to the now-deleted DB pre-load, so dry-run would over-print.
- **Whole-batch errors are visible in both JSON and human modes.** When a batch flush fails (DB connection drop, malformed row), the error prints to stderr in JSON mode AND to console in human mode, with the lost-row count. No more silent loss of 100 rows because of one bad row.

#### Schema migrations — v0.12.0 upgrade is now sub-second on duplicate-heavy brains

- **Migration v9 (timeline_entries) and v8 (links) pre-create a btree helper index** on the dedup columns before the `DELETE ... USING` self-join runs. Turns the O(n²) sequential-scan dedup into O(n log n) index-backed dedup. On 80K+ duplicate rows the migration completes in well under a second instead of timing out at 60s. The helper index is dropped after dedup, leaving the original schema unchanged. Same fix applied defensively to migration v8 — Garry's brain didn't trip it (links had fewer duplicates) but the same trap was loaded.
- **`phaseASchema` timeout in the v0.12.0 orchestrator bumped 60s → 600s.** Belt-and-suspenders: the helper-index fix should make dedup sub-second on most brains, but the outer wall-clock budget shouldn't be the failure mode for unforeseen slowness.

#### New engine API

- **`addLinksBatch(LinkBatchInput[]) → Promise<number>`** and **`addTimelineEntriesBatch(TimelineBatchInput[]) → Promise<number>`** on both `PostgresEngine` and `PGLiteEngine`. Returns count of actually-inserted rows (excluding ON CONFLICT no-ops and JOIN-dropped rows whose slugs don't exist). Per-row `addLink` / `addTimelineEntry` are unchanged — all 10 existing call sites compile and behave identically. Plugin authors building agent integrations on `BrainEngine` can adopt the batch methods at their own pace.

#### Tests

- **Migration regression tests guard the fix structurally + behaviorally.** New `test/migrate.test.ts` cases assert the v8 + v9 SQL literally contains the helper `CREATE INDEX IF NOT EXISTS ... DROP INDEX IF EXISTS` sequence in the right order (deterministic, fast, catches a regression even at 0-row scale where wall-clock can't distinguish O(n²) from O(1)) AND that the migration completes under wall-clock cap on 1000-row fixtures.
- **`test/extract-fs.test.ts` (new file)** covers the FS-source extract path end-to-end on PGLite: first-run inserts, second-run reports zero, dry-run dedups duplicate candidates across 3 files into one printed line, second-run perf regression guard.
- **9 new E2E tests for the postgres-engine batch methods** in `test/e2e/mechanical.test.ts`. The postgres-js bind path is structurally different from PGLite's (array params via `unnest()` vs manual `$N` placeholders) and gets its own coverage against real Postgres+pgvector.
- **11 new PGLite batch method tests** in `test/pglite-engine.test.ts` (empty batch, missing optionals normalize to empty strings, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch returns count of new only, batch of 100).

#### Pre-ship review

This release was reviewed by `/plan-eng-review` (5 issues, all addressed including a P0 plan reshape that dropped a redundant orchestrator phase in favor of fixing migration v9 directly), `/codex` outside-voice review on the plan (15 findings, all P1 + P2 incorporated — most consequential: forced a cleaner separation between per-row API stability and new batch APIs so all 10 existing `addLink` callers stay untouched), and 5 specialist subagents (testing, maintainability, performance, security, data-migration) at ship time. The testing specialist caught a real bug in the postgres-engine batch SQL: postgres-js's `sql(rows, ...)` helper doesn't compose with `(VALUES) AS v(...)` JOIN syntax the way originally written. Switched to the cleaner `unnest()` array-parameter pattern in both engines, verified end-to-end against a real Postgres+pgvector container.

## [0.12.0] - 2026-04-18

## **The graph wires itself.**
## **Your brain stops being grep.**

GBrain v0.12.0 ships a self-wiring knowledge graph. Every `put_page` extracts entity references and creates typed links automatically (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. New `gbrain graph-query` for typed-edge traversal. Backlink-boosted hybrid search. Auto-link reconciliation on every edit. The brain stops being a text store you grep through and starts being a knowledge graph you query.

### The benchmark numbers that matter

Headline from BrainBench v1, a 240-page rich-prose corpus generated by Claude Opus, run on PGLite in-memory. Same data, same queries, before vs after PR #188. No API keys at run time. Reproducible: `bun run eval/runner/all.ts`, ~3 min.

| Metric                          | BEFORE PR #188 | AFTER PR #188 | Δ            |
|---------------------------------|----------------|---------------|--------------|
| **Precision@5** (top-5 hits)    | 39.2%          | **44.7%**     | **+5.4 pts** |
| **Recall@5** (correct in top-5) | 83.1%          | **94.6%**     | **+11.5 pts**|
| Correct in top-5 (total)        | 217            | 247           | **+30**      |
| Graph-only F1 (ablation)        | 57.8% (grep)   | **86.6%**     | **+28.8 pts**|

Per-link-type precision (graph-only, where the typed graph is the answer):

| Link type   | Expected | BEFORE precision | AFTER precision | Δ            |
|-------------|----------|------------------|-----------------|--------------|
| works_at    | 120      | 21%              | **94%**         | **+73 pts**  |
| invested_in | 79       | 32%              | **90%**         | **+58 pts**  |
| advises     | 61       | 10%              | **78%**         | **+68 pts**  |
| attended    | 153      | 75%              | 72%             | -3 pts       |

30 more correct answers in the top-5 the agent actually reads. 53% fewer total results to wade through. "Who works at Acme?" jumps from 21% precision (grep returns every page mentioning Acme: investors, advisors, concept pages, other companies) to 94% (graph returns just the employees).

### What this means for GBrain users

The brain is no longer a text store with hybrid search bolted on. It's a queryable knowledge graph that ALSO has hybrid search. Six categories of orthogonal capability (identity resolution, temporal queries, performance at 10K-page scale, robustness to malformed input, MCP operation contract) all pass. Every page write is a graph mutation. Every query gets graph-first ranking. Auto-wire on upgrade ... `gbrain post-upgrade` runs the v0_12_0 orchestrator (schema, config check, backfill links, backfill timeline, verify), idempotent, ~30s on a 30K-page brain. Plus the v0.11 Minions runtime is fully merged: durable background agents + the graph layer in one release.

### Itemized changes

#### Knowledge Graph Layer

Your brain now wires itself. Every page write automatically extracts entity references and creates typed links between pages. The `links` table goes from a manually-populated convention to a real, queryable knowledge graph that compounds over time.

- **Auto-link on every page write.** When you `gbrain put` a page that mentions `[Alice](people/alice)` or `[Acme](companies/acme)`, those links land in the graph automatically. Stale links (refs no longer in the page text) are removed in the same call. Run a quick `gbrain put` and the brain knows who's connected to whom. To opt out: `gbrain config set auto_link false`.
- **Typed relationships.** Inferred from context using deterministic regex (zero LLM calls): `attended` (meeting -> person), `works_at` (CEO of, VP at, joined as), `invested_in` (invested in, backed by), `founded` (founded, co-founded), `advises` (advises, board member), `source` (frontmatter), `mentions` (default). On a 80-page benchmark brain: 94% type accuracy.
- **`gbrain extract --source db`.** New mode for the existing `gbrain extract <links|timeline|all>` command that walks pages from the engine instead of from disk. Works for live brains backed by Postgres or PGLite without a local markdown checkout — exactly what an MCP-driven OpenClaw setup needs. Filesystem mode (`--source fs`) is unchanged and still the default.
- **`gbrain graph-query <slug>` for relationship traversal.** "Who works at Acme?" → `gbrain graph-query companies/acme --type works_at --direction in`. "Who attended meetings with Alice?" → `gbrain graph-query people/alice --type attended --depth 2`. Returns typed edges with depth, not just nodes. Backed by a new `traversePaths()` engine method on both PGLite and Postgres with cycle prevention (no exponential blowup on cyclic subgraphs).
- **Graph-powered search ranking.** Hybrid search now applies a small backlink boost after cosine re-scoring (`score *= 1 + 0.05 * log(1 + backlink_count)`). Well-connected entities surface higher in results. Works in both keyword-only and full hybrid paths. Tested on the new `test/benchmark-graph-quality.ts` (80 pages, 35 queries, A/B/C comparison) — relational query recall jumps from ~30% (search alone) to 100% (graph traversal).
- **Graph health metrics in `gbrain health`.** New `link_coverage` and `timeline_coverage` percentages on entity pages (person/company), plus `most_connected` top-5 list. The `dead_links` field is dropped (always 0 under ON DELETE CASCADE — was a phantom metric). The `brain_score` composite formula stays but now reflects a sharper graph signal.

### Schema migrations

Three new migrations apply automatically on `gbrain init`:

- **v5** widens the `links` UNIQUE constraint to `(from, to, link_type)`. The same person can now both `works_at` AND `advises` the same company as separate rows, instead of one type clobbering the other.
- **v6** adds a UNIQUE index on `timeline_entries(page_id, date, summary)` plus `ON CONFLICT DO NOTHING` in `addTimelineEntry`. Idempotent inserts at the DB level — running `gbrain extract timeline --source db` twice is safe.
- **v7** drops the `trg_timeline_search_vector` trigger that updated `pages.updated_at` on every timeline insert. Structured timeline entries are now graph data only, not search text. The markdown timeline section in `pages.timeline` still feeds search via the pages trigger. Side benefit: extraction pagination is no longer self-invalidating.

### Security hardening (caught during pre-ship review)

- **`traverse_graph` MCP depth is hard-capped at 10.** Without this, a remote MCP caller could pass `depth=1e6` and burn database memory/CPU on the recursive CTE.
- **Auto-link is disabled for remote MCP callers** (`ctx.remote=true`). Bare-slug regex matches `people/X` anywhere in page text including code fences and quoted strings. Without this gate, an untrusted MCP caller could plant arbitrary outbound links by writing pages with intentional slug references; combined with the new backlink boost, attacker-placed targets would surface higher in search.
- **`runAutoLink` reconciliation runs inside a transaction.** Without it, two concurrent `put_page` calls on the same slug would race: each reads stale `existingKeys` and recreates links the other side just removed.
- **`--since` validates date format upfront.** Invalid dates (`--since yesterday`) used to silently no-op the filter and reprocess the whole brain. Now: hard error with a clear message.

### Tests

- 1151 unit tests pass (was 891 → +260 new)
- 105 E2E tests pass against PostgreSQL
- New `test/benchmark-graph-quality.ts` runs the 80-page A/B/C comparison and gates on real thresholds (link_recall > 90%, type_accuracy > 80%, idempotency true). Currently passing all 9 thresholds.
- BrainBench v1 (Cat 1+2 + 3, 4, 7, 10, 12) at 240-page Opus rich-prose corpus: Recall@5 83% → 95%, Precision@5 39% → 45%, +30 correct in top-5. Graph-only F1 86.6% vs grep 57.8%. See `docs/benchmarks/2026-04-18-brainbench-v1.md`.

### Schema migration renumber

The graph layer migrations (originally v5/v6/v7 on the link-timeline-extract branch) were renumbered to **v8/v9/v10** to land cleanly on top of master's v5/v6/v7 (Minions: minion_jobs_table, agent_orchestration_primitives, agent_parity_layer). All v8/v9/v10 SQL is idempotent — fresh installs apply the full sequence cleanly; existing v0.11.x installs apply only the new v8/v9/v10. Branch installs that pre-dated this merge (very rare) need to drop and re-init their PGLite db to pick up master's v5/v6/v7 minion_jobs schema.

## [0.11.1] - 2026-04-18

### Fixed — the v0.11.0 migration mega-bug

Your v0.11.0 upgrade shipped the Minions schema, worker, queue, and migration skill. It didn't ship the actual migration running on upgrade. If you upgraded and ended up with no `~/.gbrain/preferences.json`, autopilot still running inline, and cron jobs still hitting `agentTurn`'s 300s timeout — that's the bug. This release fixes it and auto-repairs on your next `gbrain upgrade`.

- **`gbrain apply-migrations` is the canonical repair.** Reads `~/.gbrain/migrations/completed.jsonl`, diffs against the TS migration registry, runs any pending orchestrators. Idempotent: rerunning on a healthy install is cheap and silent.
- **`gbrain upgrade` and `postinstall` now invoke it.** `runPostUpgrade` tail-calls `apply-migrations --yes` unconditionally (Codex caught that the earlier early-return on missing upgrade-state.json left broken-v0.11.0 installs broken forever). `package.json`'s new `postinstall` hook runs it after `bun update gbrain` / `npm i gbrain`. First-install guard keeps postinstall silent when no brain is configured yet.
- **Stopgap for v0.11.0 binaries without this release:** paste `curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash`. It writes `preferences.json` + a `status: "partial"` record so the eventual `apply-migrations --yes` run picks up where it left off — the stopgap does not poison the permanent migration path.

### Added — autopilot supervises Minions itself, one install step

Before this release, autopilot + `gbrain jobs work` were two separate processes you had to manage. Now autopilot is the one install step, and it forks the Minions worker as a child with 10s-backoff restart + 5-crash cap + async SIGTERM drain that waits up to 35s for the worker to commit in-flight work before SIGKILL.

- **Autopilot dispatches each cycle as a single `autopilot-cycle` Minion job** with `idempotency_key: autopilot-cycle:<slot>`. A 5-min autopilot + 8-min embed no longer stacks 4 overlapping runs — the queue's unique partial index dedupes at the DB layer. Codex caught that the earlier "parent/child DAG" plan was a category error (parent/child in Minions flips the parent to `waiting-children`, not the child to `waiting-for-parent`, so extract would have run before sync).
- **Per-step partial-failure handling.** Each of sync / extract / embed / backlinks is wrapped in its own try/catch. Handler returns `{ partial: true, failed_steps: [...] }` when any step fails; never throws. An intermittent extract bug no longer blocks every future cycle via Minion retry.
- **Env-aware `gbrain autopilot --install`** picks the right supervisor: launchd on macOS, systemd user unit on Linux-with-systemd (with a stricter `systemctl --user is-system-running` probe — the naive `/run/systemd/system` check was a false-positive magnet), bootstrap hook on ephemeral containers (Render / Railway / Fly / Docker — auto-injects into OpenClaw's `hooks/bootstrap/ensure-services.sh` when detected, use `--no-inject` to opt out), crontab otherwise. `--target` overrides detection. Uninstall mirrors all four targets.
- **Worker child spawn uses `resolveGbrainCliPath()`** — never blindly uses `process.execPath` (on source installs that's the Bun runtime, not `gbrain`). Resolution tries argv[1], then execPath ending `/gbrain`, then `which gbrain`.

### Added — library-level Core fns so handlers don't kill workers

Reusing CLI entry-point functions (`runExtract`, `runEmbed`, etc.) as Minion handler bodies was wrong — any `process.exit(1)` on bad args would kill the entire worker process and every in-flight job. New Core fns throw instead:

- `runExtractCore(engine, opts)` — wraps extract-links + extract-timeline.
- `runEmbedCore(engine, opts)` — accepts `{ slug, slugs, all, stale }`.
- `runBacklinksCore(opts)` — `{ action: 'check' | 'fix', dir, dryRun }`.
- `runLintCore(opts)` — returns counts, doesn't print human detail (CLI wrapper does that).

CLI wrappers (`runExtract`, `runEmbed`, etc.) stay as thin arg-parsers that catch + `process.exit(1)`. Handlers in `jobs.ts` import the Core fns directly.

### Added — skillify ships as a first-class gbrain skill

Ported from Garry's OpenClaw, proven in production. Paired with `gbrain check-resolvable` gives a user-controllable equivalent of Hermes' auto-skill-creation — you decide when and what, the tooling keeps the 10-item checklist honest.

- `skills/skillify/SKILL.md` — the meta skill. Triggers: "skillify this", "is this a skill?", "make this proper".
- `scripts/skillify-check.ts` — machine-readable audit. `--json` for CI, `--recent` to check files modified in the last 7 days.
- README now has a short section explaining the Skillify + check-resolvable pair and why user-controlled beats auto-generated.

### Added — host-agnostic plugin contract (replaces handlers.json)

An earlier design draft shipped `~/.claude/gbrain-handlers.json` where each entry was a shell command the worker would exec. Codex flagged this as a durable RCE surface. Dropped in favor of a code-level plugin contract:

- `docs/guides/plugin-handlers.md` — the full contract. Host imports `gbrain/minions`, constructs a `MinionWorker`, calls `worker.register(name, fn)` for every custom handler, calls `worker.start()`. Ships the bootstrap as code in the host repo, same trust model as any other code.
- `skills/conventions/cron-via-minions.md` — the rewrite convention for cron manifests. PGLite branch keeps `--follow` (inline); Postgres branch drops `--follow` + uses `--idempotency-key` on the cycle slot.
- `skills/migrations/v0.11.0.md` — body restored as the host-agent instruction manual. Walks the host through every JSONL TODO using the 10-item skillify checklist.

### Added — `gbrain init --migrate-only` (the Codex H1 fix)

Running bare `gbrain init` with no flags defaulted to PGLite and called `saveConfig` — silently clobbering any existing Postgres config. The migration orchestrator now calls `gbrain init --migrate-only` which only applies the schema against the configured engine and NEVER writes a new config. Apply-migrations + stopgap + postinstall all use this flag. Bare `gbrain init` still exists and still defaults to PGLite when you want a fresh install.

### Changed

- `runPostUpgrade` is now async + runs `apply-migrations --yes` unconditionally (Codex H8).
- `gbrain upgrade`'s subprocess timeout for `post-upgrade` bumped 30s → 300s so the migration has room to do real work like autopilot install (Codex H7).
- Migration enumeration uses a TS registry at `src/commands/migrations/index.ts` instead of walking `skills/migrations/*.md` on disk — compiled binaries see the same set source installs do (Codex K).
- Migration diff rule: apply when no `status: "complete"` entry exists in `completed.jsonl` AND `version ≤ installed VERSION`. Earlier proposed "version > currentVersion" would have SKIPPED v0.11.0 when running v0.11.1 (Codex H9).
- Autopilot refreshes its lock-file mtime every cycle so a long-lived autopilot doesn't get declared "stale" by the next cron-fired invocation after 10 minutes (Codex C).
- CLAUDE.md gained a new "Migration is canonical, not advisory" section pinning the design principle.

### Tests

34 new unit tests across preferences, init-migrate-only, apply-migrations, v0.11.0 orchestrator, handlers, autopilot-resolve-cli, autopilot-install, skillify-check. All 1177 existing tests still green.

## [0.11.0] - 2026-04-18

### Added — Minions (agent orchestration primitives)

Minions was a job queue. Now it's an agent runtime. Everything your orchestrator needs to fan out work across sub-agents without turning them into orphans or rate-limit disasters.

- **Depth tracking and `max_spawn_depth`.** Runaway recursion is a real prod failure. Children inherit `depth = parent.depth + 1` and submit rejects past a configurable cap (default 5). Your orchestrator can no longer spawn itself into an infinite tree by accident.

- **Per-parent child cap (`max_children`).** Stop spawn storms before they hit OpenAI's rate limit. Set `max_children: 10` on a parent job and the 11th submit throws. Enforced via `SELECT ... FOR UPDATE` on the parent row so concurrent submits can't both slip through.

- **Per-job wall-clock timeout (`timeout_ms`).** The #2 daily OpenClaw pain is "agent stops responding" ... long handler, token bloat, no clock. Now every job can declare a ceiling. `handleTimeouts()` dead-letters expired rows; a per-job `setTimeout` fires AbortSignal as a best-effort handler interrupt. No retry on timeout, terminal by design.

- **Cascade cancel via recursive CTE.** `cancelJob()` walks the full descendant tree in a single statement and cancels everything. Grandchild orphan bug is gone. Re-parented descendants (via `removeChildDependency`) are naturally excluded. Depth cap of 100 on the CTE as runaway safety.

- **Idempotency keys.** Add `idempotency_key: 'sync:2026-04-18'` to your submit and only one job per key ever runs. PG unique partial index enforces it at the DB layer, two concurrent pods submitting the same key collapse to one row. No more "did my cron fire twice?" anxiety.

- **Child to parent `child_done` inbox.** When a child completes, the parent gets `{type:'child_done', child_id, job_name, result}` posted to its inbox in the same transaction as the token rollup. Fan-in for free. `readChildCompletions(parent_id)` filters the inbox by message type with an optional `since` cursor. Works as the primitive for future `waitForChildren(n)` helpers.

- **`removeOnComplete` / `removeOnFail`.** BullMQ convenience. Completed jobs don't bloat your `minion_jobs` table forever. Opt in per-job, the `child_done` message survives because it lives in the *parent's* inbox, not the child's.

- **Attachment manifest.** New `minion_attachments` table for binary payloads attached to jobs. Validation catches path traversal (`../`, `/`, `\`, null byte), oversize (5 MiB default, raiseable), invalid base64, and duplicate filenames per job. DB-level `UNIQUE (job_id, filename)` defends against concurrent addAttachment races. `storage_uri TEXT` column forward-compat for future S3 offload.

- **Cooperative AbortSignal.** Pause or cascade-cancel clears the job's `lock_token`, the running handler's next lock renewal fails and fires `ctx.signal.abort()`. Handlers that respect AbortSignal stop cleanly. Handlers that ignore it get dead-lettered by the DB-side `handleTimeouts`, either way, the row status is correct.

- **Transactional correctness fixes.** `completeJob()` and `failJob()` now wrap in `engine.transaction()`. Parent hook invocations (`resolveParent`, `failParent`, `removeChildDependency`) fold into the same transaction so a process crash between child-update and parent-update can't strand the parent in `waiting-children`. Fixed a pre-existing bug where `add()` was inverting child/parent status (child got `waiting-children`, parent stayed `waiting`, making the child unclaimable until a manual UPDATE). Tests that worked around it are now cleaned up.

- **Migration v7 (`agent_parity_layer`).** Additive schema: new columns on `minion_jobs` (all defaulted, nullable where appropriate), new `minion_attachments` table, 3 partial indexes for bounded scans (`idx_minion_jobs_timeout`, `idx_minion_jobs_parent_status`, `uniq_minion_jobs_idempotency`). Existing installs pick it up on next `gbrain init`, no manual action required.

### Fixed

- **JSONB double-encode bug.** When writing to JSONB columns via `engine.executeRaw(sql, params)`, postgres.js auto-JSON-encodes parameters. Calling `JSON.stringify(obj)` first stored a JSON string literal, making `jsonb_typeof = string` and breaking `payload->>'key'` queries silently. Fixed in three call sites (`child_done` inbox post, `updateProgress`, `sendMessage`). PGLite tolerated both forms so the unit tests missed it, only a real-Postgres E2E with the `payload->>` operator caught it.

- **Sibling completion race.** Under READ COMMITTED, two grandchildren completing concurrently each saw the other as still-active in their pre-commit snapshot, so neither flipped the parent out of `waiting-children`. Fixed by taking `SELECT ... FOR UPDATE` on the parent row at the start of `completeJob` and `failJob` transactions. Siblings now serialize on the parent lock, second commit sees the first as completed and correctly advances the parent.

### Tests

- **~33 new tests in `test/minions.test.ts`** covering depth cap, per-parent child cap, timeout dead-letter, cascade cancel (including the re-parent edge case), `removeOnComplete` / `removeOnFail`, idempotency (single + concurrent), `child_done` inbox (posted in txn + survives child removeOnComplete + since cursor), attachment validation (oversize, path traversal, null byte, duplicates, base64), AbortSignal firing on pause mid-handler, catch-block skipping `failJob` when aborted, worker in-flight bookkeeping, token-rollup guard when parent already terminal, setTimeout safety-net cleanup.

- **`test/e2e/minions-concurrency.test.ts`** ... two worker instances against real Postgres, 20 jobs, zero double-claims. The only test that actually verifies `FOR UPDATE SKIP LOCKED` under real concurrency. PGLite can't prove this.

- **`test/e2e/minions-resilience.test.ts`** ... 5 tests covering the 6 OpenClaw daily pains: spawn storms, agent stall, forgotten dispatches, cascade cancel, deep tree fan-in with grandchild completions. Every pain has a test that fails if the primitive regresses.

- **1066 unit + 105 E2E = 1171 tests passing** before this ship. The parity layer isn't just planned, it's pinned down.

## [0.10.2] - 2026-04-17

### Security — Wave 3 (9 vulnerabilities closed)

This wave closes a high-severity arbitrary-file-read in `file_upload`, fixes a fake trust boundary that let any cwd-local recipe execute arbitrary commands, and lays down real SSRF defense for HTTP health checks. If you ran `gbrain` in a directory where someone could drop a `recipes/` folder, this matters.

- **Arbitrary file read via `file_upload` is closed.** Remote (MCP) callers were able to read `/etc/passwd` or any other host file. Path validation now uses `realpathSync` + `path.relative` to catch symlinked-parent traversal, plus an allowlist regex for slugs and filenames (control chars, backslashes, RTL-override Unicode all rejected). Local CLI users still upload from anywhere — only remote callers are confined. Fixes Issue #139, contributed by @Hybirdss; original fix #105 by @garagon.
- **Recipe trust boundary is real now.** `loadAllRecipes()` previously marked every recipe as `embedded=true`, including ones from `./recipes/` in your cwd or `$GBRAIN_RECIPES_DIR`. Anyone who could drop a recipe in cwd could bypass every health-check gate. Now only package-bundled recipes (source install + global install) are trusted. Original fixes #106, #108 by @garagon.
- **String health_checks blocked for untrusted recipes.** Even with the recipe trust fix, the string health_check path ran `execSync` before reaching the typed-DSL switch — a malicious "embedded" recipe could `curl http://169.254.169.254/metadata` and exfiltrate cloud credentials. Non-embedded recipes are now hard-blocked from string health_checks; embedded recipes still get the `isUnsafeHealthCheck` defense-in-depth guard.
- **SSRF defense for HTTP health_checks.** New `isInternalUrl()` blocks loopback, RFC1918, link-local (incl. AWS metadata 169.254.169.254), CGNAT, IPv6 loopback, and IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` canonicalized to hex hextets — both forms blocked). Bypass encodings handled: hex IPs (`0x7f000001`), octal (`0177.0.0.1`), single decimal (`2130706433`). Scheme allowlist rejects `file:`, `data:`, `blob:`, `ftp:`, `javascript:`. `fetch` runs with `redirect: 'manual'` and re-validates every Location header up to 3 hops. Original fix #108 by @garagon.
- **Prompt injection hardening for query expansion.** Restructured the LLM prompt with a system instruction that declares the query as untrusted data, plus an XML-tagged `<user_query>` boundary. Layered with regex sanitization (strips code fences, tags, injection prefixes) and output-side validation on the model's `alternative_queries` array (cap length, strip control chars, dedup, drop empties). The `console.warn` on stripped content never logs the query text itself. Original fix #107 by @garagon.
- **`list_pages` and `get_ingest_log` actually cap now.** Wave 3 found that `clampSearchLimit(limit, default)` was always allowing up to 100 — the second arg was the default, not the cap. Added a third `cap` parameter so `list_pages` caps at 100 and `get_ingest_log` caps at 50. Internal bulk commands (embed --all, export, migrate-engine) bypass the operation layer entirely and remain uncapped. Original fix #109 by @garagon.

### Added

- `OperationContext.remote` flag distinguishes trusted local CLI callers from untrusted MCP callers. Security-sensitive operations (currently `file_upload`) tighten their behavior when `remote=true`. Defaults to strict (treat as remote) when unset.
- Exported security helpers for testing and reuse: `validateUploadPath`, `validatePageSlug`, `validateFilename`, `parseOctet`, `hostnameToOctets`, `isPrivateIpv4`, `isInternalUrl`, `getRecipeDirs`, `sanitizeQueryForPrompt`, `sanitizeExpansionOutput`.
- 49 new tests covering symlink traversal, scheme allowlist, IPv4 bypass forms, IPv6 mapped addresses, prompt injection patterns, and recipe trust boundaries. Plus an E2E regression proving remote callers can't escape cwd.

### Contributors

Wave 3 fixes were contributed by **@garagon** (PRs #105-#109) and **@Hybirdss** (Issue #139). The collector branch re-implemented each fix with additional hardening for the residuals Codex caught during outside-voice review (parent-symlink traversal, fake `isEmbedded` boundary, redirect-following SSRF, scheme bypasses, `clampSearchLimit` semantics).

## [0.10.1] - 2026-04-15

### Fixed

- **`gbrain sync --watch` actually works now.** The watch loop existed but was never called because the CLI routed sync through the operation layer (single-pass only). Now sync routes through the CLI path that knows about `--watch` and `--interval`. Your cron workaround is no longer needed.

- **Sync auto-embeds your pages.** After syncing, gbrain now embeds the changed pages automatically. No more "I synced but search can't find my new page." Opt out with `--no-embed`. Large syncs (100+ pages) defer embedding to `gbrain embed --stale`.

- **First sync no longer repeats forever.** `performFullSync` wasn't saving its checkpoint. Fixed: sync state persists after full import so the next sync is incremental.

- **`dead_links` metric is consistent across engines.** Postgres was counting empty-content chunks instead of dangling links. Now both engines count the same thing: links pointing to non-existent pages.

- **Doctor recommends the right embed command.** Was suggesting `gbrain embed refresh` (doesn't exist). Now correctly says `gbrain embed --stale`.

### Added

- **`gbrain extract links|timeline|all`** builds your link graph and structured timeline from existing markdown. Scans for markdown links, frontmatter fields (company, investors, attendees), and See Also sections. Infers link types from directory structure. Parses both bullet (`- **YYYY-MM-DD** | Source — Summary`) and header (`### YYYY-MM-DD — Title`) timeline formats. Runs automatically after every sync.

- **`gbrain features --json --auto-fix`** scans your brain and tells you what you're not using, with your own numbers. Priority 1 (data quality): missing embeddings, dead links. Priority 2 (unused features): zero links, zero timeline, low coverage, unconfigured integrations. Agents run `--auto-fix` to handle everything automatically.

- **`gbrain autopilot --install`** sets up a persistent daemon that runs sync, extract, and embed in a continuous loop. Health-based scheduling: brain score >= 90 slows down, < 70 speeds up. Installs as a launchd service (macOS) or crontab entry (Linux). One command, brain maintains itself forever.

- **Brain health score (0-100)** in `gbrain health` and `gbrain doctor`. Weighted composite of embed coverage, link density, timeline coverage, orphan pages, and dead links. Agents use it as a health gate.

- **`gbrain embed --slugs`** embeds specific pages by slug. Used internally by sync auto-embed to target just the changed pages.

- **Instruction layer for agents.** RESOLVER.md routing entries, maintain skill sections, and setup skill phase for extract, features, and autopilot. Without these, agents would never discover the new commands.

## [0.10.0] - 2026-04-14

### Added

- **Background jobs that don't die.** Minions is a BullMQ-inspired job queue built directly into GBrain. No Redis. No external dependencies. Submit `gbrain jobs submit embed --follow` and it runs with automatic retry, exponential backoff, and stall detection. Kill the process mid-job? Stall detection catches it and requeues. Run `gbrain jobs work` to start a persistent worker daemon that processes jobs from the queue. Jobs are first-class: submit, list, cancel, retry, prune, stats, all from the CLI or MCP. Your agent can now run long operations (14K+ page embeds, bulk enrichment) as durable background jobs instead of fragile inline commands.

- **Your agent now has 24 skills, not 8.** 16 new brain skills generalized from a production deployment with 14,700+ pages. Signal detection, brain-first lookup, content ingestion (articles, video, meetings), entity enrichment, task management, cron scheduling, reports, and cross-modal review. All shipped as fat markdown files your agent reads on demand.

- **Signal detector fires on every message.** A cheap sub-agent spawns in parallel to capture original thinking and entity mentions. Ideas get preserved with exact phrasing. Entities get brain pages. The brain compounds on autopilot.

- **RESOLVER.md routes your agent to the right skill.** Modeled on a 215-line production dispatcher. Categorized routing table: always-on, brain ops, ingestion, thinking, operational. Your agent reads it, matches the user's intent, loads the skill. No slash commands needed.

- **Soul-audit builds your agent's identity.** 6-phase interactive interview generates SOUL.md (who the agent is), USER.md (who you are), ACCESS_POLICY.md (who sees what), and HEARTBEAT.md (operational cadence). Re-runnable anytime. Ships with minimal defaults so first boot is instant.

- **Access control out of the box.** 4-tier privacy policy (Full/Work/Family/None) enforced by skill instructions before every response. Template-based, configurable per user.

- **Conventions directory codifies operational discipline.** Brain-first lookup protocol, citation quality standards, model routing table, test-before-bulk rule, and cross-modal review pairs. These are the hard-won patterns that prevent bad bulk runs and silent failures.

- **`gbrain init` detects GStack and reports mod status.** After brain setup, init now shows how many skills are loaded, whether GStack is installed, and where to get it. GStack detection uses `gstack-global-discover` with fallback to known host paths.

- **Conformance standard for all skills.** Every skill now has YAML frontmatter (name, version, description, triggers, tools, mutating) plus Contract, Anti-Patterns, and Output Format sections. Two new test files validate conformance across all 25 skills.

- **Existing 8 skills migrated to conformance format.** Frontmatter added, Workflow renamed to Phases, Contract and Anti-Patterns sections added. Ingest becomes a thin router delegating to specialized ingestion skills.

### The 16 new skills

| Skill | What it does | Why it matters |
|-------|-------------|----------------|
| **signal-detector** | Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions. | Your brain compounds on autopilot. Every conversation is an ingest event. Miss a signal and the brain never learns it. |
| **brain-ops** | Brain-first lookup before any external API. The read-enrich-write loop that makes every response smarter. | Without this, your agent reaches for Google when the answer is already in the brain. Wastes tokens, misses context. |
| **idea-ingest** | Links, articles, tweets go into the brain with analysis, author people pages, and cross-linking. | Every article worth reading is worth remembering. The author gets a people page. The ideas get cross-linked to what you already know. |
| **media-ingest** | Video, audio, PDF, books, screenshots, GitHub repos. Transcripts, entity extraction, backlink propagation. | One skill handles every media format. Absorbs what used to be 3 separate skills (video-ingest, youtube-ingest, book-ingest). |
| **meeting-ingestion** | Transcripts become brain pages. Every attendee gets enriched. Every company discussed gets a timeline entry. | A meeting is NOT fully ingested until every entity is propagated. This is the skill that turns a transcript into 10 updated brain pages. |
| **citation-fixer** | Scans brain pages for missing or malformed `[Source: ...]` citations. Fixes formatting to match the standard. | Without citations, you can't trace facts back to where they came from. Six months later, "who said this?" has an answer. |
| **repo-architecture** | Where new brain files go. Decision protocol: primary subject determines directory, not format or source. | Prevents the #1 misfiling pattern: dumping everything in `sources/` because it came from a URL. |
| **skill-creator** | Create new skills following the conformance standard. MECE check against existing skills. Updates manifest and resolver. | Users who need a capability GBrain doesn't have can create it themselves. The skill teaches the agent how to extend itself. |
| **daily-task-manager** | Add, complete, defer, remove, review tasks with priority levels (P0-P3). Stored as a searchable brain page. | Your tasks live in the brain, not a separate app. The agent can cross-reference tasks with meeting notes and people pages. |
| **daily-task-prep** | Morning preparation. Calendar lookahead with brain context per attendee, open threads from yesterday, active task review. | Walk into every meeting with full context on every person in the room, automatically. |
| **cross-modal-review** | Spawn a different AI model to review the agent's work before committing. Refusal routing: if one model refuses, silently switch. | Two models agreeing is stronger signal than one model being thorough. Refusal routing means the user never sees "I can't do that." |
| **cron-scheduler** | Schedule staggering (5-min offsets), quiet hours (timezone-aware with wake-up override), thin job prompts. | 21 cron jobs at :00 is a thundering herd. Staggering prevents it. Quiet hours mean no 3 AM notifications. Wake-up override releases the backlog. |
| **reports** | Timestamped reports with keyword routing. "What's the latest briefing?" maps to the right report directory. | Cheap replacement for vector search on frequent queries. Don't embed. Load the file. |
| **testing** | Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage. The CI for your skill system. | 3 skills and you need validation. 24 skills and you need it yesterday. Catches dead references, missing sections, MECE violations. |
| **soul-audit** | 6-phase interview that generates SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md. Your agent's identity, built from your answers. | What makes your OpenClaw feel like yours. Without personality and access control, every agent feels the same. |
| **webhook-transforms** | External events (SMS, meetings, social mentions) converted into brain pages with entity extraction. Dead-letter queue for failures. | Your brain ingests signals from everywhere. Not just conversations, but every webhook, every notification, every external event. |

### Infrastructure (new in v0.10.0)

- **Your brain now self-validates its own skill routing.** `checkResolvable()` verifies every skill is reachable from RESOLVER.md, detects MECE overlaps, flags missing triggers, and catches DRY violations. Runs from `bun test`, `gbrain doctor`, and the skill-creator skill. Every issue comes with a machine-readable fix object the agent can act on.

- **`gbrain doctor` got serious.** 8 health checks now (up from 5), plus a composite health score (0-100). Filesystem checks (resolver, conformance) run even without a database. `--fast` skips DB checks. `--json` output includes structured `issues` array with action strings so agents can parse and auto-fix.

- **Batch operations won't melt your machine anymore.** Adaptive load-aware throttling checks CPU and memory before each batch item. Exponential backoff with a 20-attempt safety cap. Active hours multiplier slows batch work during the day. Two concurrent batch process limit.

- **Your agent's classifiers get smarter automatically.** Fail-improve loop: try deterministic code first, fall back to LLM, log every fallback. Over time, the logs reveal which regex patterns are missing. Auto-generates test cases from successful LLM results. Tracks deterministic hit rate in `gbrain doctor` output.

- **Voice notes just work.** Groq Whisper transcription (with OpenAI fallback) via `transcribe_audio` operation. Files over 25MB get ffmpeg-segmented automatically. Transcripts flow through the standard import pipeline, entities get extracted, back-links get created.

- **Enrichment is now a global service, not a per-skill skill.** Every ingest pathway can call `extractAndEnrich()` to detect entities and create/update their brain pages. Tier auto-escalation: entities start at Tier 3, auto-promote to Tier 1 based on mention frequency across sources.

- **Data research: one skill for any email-to-tracker pipeline.** New `data-research` skill with parameterized YAML recipes. Extract investor updates (MRR, ARR, runway, headcount), expense receipts, company metrics from email. Battle-tested regex patterns, extraction integrity rule (save first, report second), dedup with configurable tolerance, canonical tracker pages with running totals.

### For contributors

- `test/skills-conformance.test.ts` validates every skill has valid frontmatter and required sections
- `test/resolver.test.ts` validates RESOLVER.md coverage and routing consistency
- `skills/manifest.json` now has `conformance_version` field and lists all 24 skills
- Identity templates in `templates/` (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
## [0.9.3] - 2026-04-12

### Added

- **Search understands what you're asking. +21% page coverage, +29% signal, 100% source accuracy.** A zero-latency intent classifier reads your query and picks the right search mode. "Who is Alice?" surfaces your compiled truth assessment. "When did we last meet?" surfaces timeline entries with dates. No LLM call, just pattern matching. Your agent sees 8.7 relevant pages per query instead of 7.2, and two thirds of returned chunks are now distilled assessments instead of half. Entity lookups always lead with compiled truth. Temporal queries always find the dates. Benchmarked against 29 pages, 20 queries with graded relevance (run `bun run test/benchmark-search-quality.ts` to reproduce). Inspired by Ramp Labs' "Latent Briefing" paper (April 2026).
- **`gbrain query --detail low/medium/high`.** Agents can control how deep search goes. `low` returns compiled truth only. `medium` (default) returns everything with dedup. `high` returns all chunks uncapped. Auto-escalates from low to high if no results found. MCP picks it up automatically.
- **`gbrain eval` measures search quality.** Full retrieval evaluation harness with P@k, R@k, MRR, nDCG@k metrics. A/B comparison mode for parameter tuning: `gbrain eval --qrels queries.json --config-a baseline.json --config-b boosted.json`. Contributed by @4shut0sh.
- **CJK queries expand correctly.** Chinese, Japanese, and Korean text was silently skipping query expansion because word count used space-delimited splitting. Now counts characters for CJK. Contributed by @YIING99.
- **Health checks speak a typed language now.** Recipe `health_checks` use a typed DSL (`http`, `env_exists`, `command`, `any_of`) instead of raw shell strings. No more `execSync(untrustedYAML)`. Your agent runs `gbrain integrations doctor` and gets structured results, not shell injection risk. All 7 first-party recipes migrated. String health checks still work (with deprecation warning) for backward compat.

### Fixed

- **Your storage backend can't be tricked into reading `/etc/passwd`.** `LocalStorage` now validates every path stays within the storage root. `../../etc/passwd` gets "Path traversal blocked" instead of your system files. All 6 methods covered (upload, download, delete, exists, list, getUrl).
- **MCP callers can't read arbitrary files via `file_url`.** `resolveFile()` now validates the requested path stays within the brain root before touching the filesystem. Previously, `../../etc/passwd` would read any file the process could access.
- **`.supabase` marker files can't escape their scope.** Marker prefix validation now rejects `../`, absolute paths, and bare `..`. A crafted `.supabase` file in a shared brain repo can't make storage requests outside the intended prefix.
- **File queries can't blow up memory.** The slug-filtered `file_list` MCP operation now has the same `LIMIT 100` as the unfiltered branch. Also fixed the CLI `gbrain files list` and `gbrain files verify` commands.
- **Symlinks in brain directories can't exfiltrate files.** All 4 file walkers in `files.ts` plus the `init.ts` size counter now use `lstatSync` and skip symlinks. Broken symlinks and `node_modules` directories are also skipped.
- **Recipe health checks can't inject shell commands.** Non-embedded (user-created) recipes with shell metacharacters in health_check strings are blocked. First-party recipes are trusted but migrated to the typed DSL.

## [0.9.2] - 2026-04-12

### Fixed

- **Fresh local installs initialize cleanly again.** `gbrain init` now creates the local PGLite data directory before taking its advisory lock, so first-run setup no longer misreports a missing directory as a lock timeout.

## [0.9.1] - 2026-04-11

### Fixed

- **Your brain can't be poisoned by rogue frontmatter anymore.** Slug authority is now path-derived. A file at `notes/random.md` can't declare `slug: people/admin` and silently overwrite someone else's page. Mismatches are rejected with a clear error telling you exactly what to fix.
- **Symlinks in your notes directory can't exfiltrate files.** The import walker now uses `lstatSync` and refuses to follow symlinks, blocking the attack where a contributor plants a link to `~/.zshrc` in the brain directory. Defense-in-depth: `importFromFile` itself also checks.
- **Giant payloads through MCP can't rack up your OpenAI bill.** `importFromContent` now checks `Buffer.byteLength` before any processing. 10 MB of emoji through `put_page`? Rejected before chunking starts.
- **Search can't be weaponized into a DoS.** `limit` is clamped to 100 across all search paths (keyword, vector, hybrid). `statement_timeout: 8s` on the Postgres connection as defense-in-depth. Requesting `limit: 10000000` now gets you 100 results and a warning.
- **PGLite stops crashing when two processes touch the same brain.** File-based advisory lock using atomic `mkdir` with PID tracking and 5-minute stale detection. Clear error messages tell you which process holds the lock and how to recover.
- **12 data integrity fixes landed.** Orphan chunks cleaned up on empty pages. Write operations (`addLink`, `addTag`, `addTimelineEntry`, `putRawData`, `createVersion`) now throw when the target page doesn't exist instead of silently no-opping. Health metrics (`stale_pages`, `dead_links`, `orphan_pages`) now measure real problems instead of always returning 0. Keyword search moved from JS-side sort-and-splice to a SQL CTE with `LIMIT`. MCP server validates params before dispatch.
- **Stale embeddings can't lie to you anymore.** When chunk text changes but embedding fails, the old vector is now NULL'd out instead of preserved. Previously, search could return results based on outdated vectors attached to new text.
- **Embedding failures are no longer silent.** The `catch { /* non-fatal */ }` is gone. You now get `[gbrain] embedding failed for slug (N chunks): error message` in stderr. Still non-fatal, but you know what happened.
- **O(n^2) chunk lookup in `embedPage` is gone.** Replaced `find() + indexOf()` with a single `Map` lookup. Matches the pattern `embedAll` already uses.
- **Stdin bombs blocked.** `parseOpArgs` now caps stdin at 5 MB before the full buffer is consumed.

### Added

- **`gbrain embed --all` is 30x faster.** Sliding worker pool with 20 concurrent workers (tunable via `GBRAIN_EMBED_CONCURRENCY`). A 20,000-chunk corpus that took 2.5 hours now finishes in ~8 minutes.
- **Search pagination.** Both `search` and `query` now accept `--offset` for paginating through results. Combined with the 100-result ceiling, you can now page through large result sets.
- **`gbrain ask` is an alias for `gbrain query`.** CLI-only, doesn't appear in MCP tools-json.
- **Content hash now covers all page fields.** Title, type, and frontmatter changes trigger re-import. First sync after upgrade will re-import all pages (one-time, expected).
- **Migration file for v0.9.1.** Auto-update agent knows to expect the full re-import and will run `gbrain embed --all` afterward.
- **`pgcrypto` extension added to schema.** Fallback for `gen_random_uuid()` on Postgres < 13.

### Changed

- **Search type and exclude_slugs filters now work.** These were advertised in the API but never implemented. Both `searchKeyword` and `searchVector` now respect `type` and `exclude_slugs` params.
- **Hybrid search no longer double-embeds the query.** `expandQuery` already includes the original, so we use it directly instead of prepending.

## [0.9.0] - 2026-04-11

### Added

- **Large files don't bloat your git repo anymore.** `gbrain files upload-raw`
  auto-routes by size: text and PDFs under 100 MB stay in git, everything larger
  (or any media file) goes to Supabase Storage with a `.redirect.yaml` pointer
  left in the repo. Files over 100 MB use TUS resumable upload (6 MB chunks with
  retry and backoff) so a flaky connection doesn't lose a 2 GB video upload.
  `gbrain files signed-url` generates 1-hour access links for private buckets.

- **The full file migration lifecycle works end to end.** `mirror` uploads to
  cloud and keeps local copies. `redirect` replaces local files with
  `.redirect.yaml` pointers (verifies remote exists first, won't delete data).
  `restore` downloads back from cloud. `clean` removes pointers when you're sure.
  `status` shows where you are. Three states, zero data loss risk.

- **Your brain now enforces its own graph integrity.** The Iron Law of Back-Linking
  is mandatory across all skills. Every mention of a person or company creates
  a bidirectional link. This transforms your brain from a flat file store into a
  traversable knowledge graph.

- **Filing rules prevent the #1 brain mistake.** New `skills/_brain-filing-rules.md`
  stops the most common error: dumping everything into `sources/`. File by primary
  subject, not format. Includes notability gate and citation requirements.

- **Enrichment protocol that actually works.** Rewritten from a 46-line API list to
  a 7-step pipeline with 3-tier system, person/company page templates, pluggable
  data sources, validation rules, and bulk enrichment safety.

- **Ingest handles everything.** Articles, videos, podcasts, PDFs, screenshots,
  meeting transcripts, social media. Each with a workflow that uses real gbrain
  commands (`upload-raw`, `signed-url`) instead of theoretical patterns.

- **Citation requirements across all skills.** Every fact needs inline
  `[Source: ...]` citations. Three formats, source precedence hierarchy.

- **Maintain skill catches what you missed.** Back-link enforcement, citation audit,
  filing violations, file storage health checks, benchmark testing.

- **Voice calls don't crash on em dashes anymore.** Unicode sanitization for Twilio
  WebSocket, PII scrub, identity-first prompt, DIY STT+LLM+TTS pipeline option,
  Smart VAD default, auto-upload call audio via `gbrain files upload-raw`.

- **X-to-Brain gets eyes.** Image OCR, Filtered Stream real-time monitoring,
  6-dimension tweet rating rubric, outbound tweet monitoring, cron staggering.

- **Share brain pages without exposing the brain.** `gbrain publish` generates
  beautiful, self-contained HTML from any brain page. Strips private data
  (frontmatter, citations, confirmations, brain links, timeline) automatically.
  Optional AES-256-GCM password gate with client-side decryption, no server
  needed. Dark/light mode, mobile-optimized typography. This is the first
  code+skill pair: deterministic code does the work, the skill tells the agent
  when and how. See the [Thin Harness, Fat Skills](https://x.com/garrytan/status/2042925773300908103)
  thread for the architecture philosophy.

### Changed

- **Supabase Storage** now auto-selects upload method by file size: standard POST
  for < 100 MB, TUS resumable for >= 100 MB. Signed URL generation for private
  bucket access (1-hour expiry).
- **File resolver** supports both `.redirect.yaml` (v0.9+) and legacy `.redirect`
  (v0.8) formats for backward compatibility.
- **Redirect format** upgraded from `.redirect` (5 fields) to `.redirect.yaml`
  (10 fields: target, bucket, storage_path, size, size_human, hash, mime,
  uploaded, source_url, type).
- **All skills** updated to reference actual `gbrain files` commands instead of
  theoretical patterns.
- **Back-link enforcer closes the loop.** `gbrain check-backlinks check` scans your
  brain for entity mentions without back-links. `gbrain check-backlinks fix` creates
  them. The Iron Law of Back-Linking is in every skill, now the code enforces it.

- **Page linter catches LLM slop.** `gbrain lint` flags "Of course! Here is..."
  preambles, wrapping code fences, placeholder dates, missing frontmatter, broken
  citations, and empty sections. `gbrain lint --fix` auto-strips the fixable ones.
  Every brain that uses AI for ingestion accumulates this. Now it's one command.

- **Audit trail for everything.** `gbrain report --type enrichment-sweep` saves
  timestamped reports to `brain/reports/{type}/YYYY-MM-DD-HHMM.md`. The maintain
  skill references this for enrichment sweeps, meeting syncs, and maintenance runs.

- **Publish skill** added to manifest (8th skill). First code+skill pair.
- Skills version bumped to 0.9.0.
- 67 new unit tests across publish, backlinks, lint, and report. Total: 409 pass.

## [0.8.0] - 2026-04-11

### Added

- **Your AI can answer the phone now.** Voice-to-brain v0.8.0 ships 25 production patterns from a real deployment. WebRTC works in a browser tab with just an OpenAI key, phone number via Twilio is optional. Your agent picks its own name and personality. Pre-computed engagement bids mean it greets you with something specific ("dude, your social radar caught something wild today"), not "how can I help you?" Context-first prompts, proactive advisor mode, caller routing, dynamic noise suppression, stuck watchdog, thinking sounds during tool calls. This is the "Her" experience, out of the box.
- **Upgrade = feature discovery.** When you upgrade to v0.8.0, the CLI tells you what's new and your agent offers to set up voice immediately. WebRTC-first (zero setup), then asks about a phone number. Migration files now have YAML frontmatter with `feature_pitch` so every future version can pitch its headline feature through the upgrade flow.
- **Remote MCP simplified.** The Supabase Edge Function deployment is gone. Remote MCP now uses a self-hosted server + ngrok tunnel. Simpler, more reliable, works with any AI client. All `docs/mcp/` guides updated to reflect the actual production architecture.

### Changed

- **Voice recipe is now 25 production patterns deep.** Identity separation, pre-computed bid system, context-first prompts, proactive advisor mode, conversation timing (the #1 fix), no-repetition rule, radical prompt compression (13K to 4.7K tokens), OpenAI Realtime Prompting Guide structure, auth-before-speech, brain escalation, stuck watchdog, never-hang-up rule, thinking sounds, fallback TwiML, tool set architecture, trusted user auth, caller routing, dynamic VAD, on-screen debug UI, live moment capture, belt-and-suspenders post-call, mandatory 3-step post-call, WebRTC parity, dual API event handling, report-aware query routing.
- **WebRTC session pseudocode updated.** Native FormData, `tools` in session config, `type: 'realtime'` on all session.update calls. WebRTC transcription NOT supported over data channel (use Whisper post-call).
- **MCP docs rewritten.** All per-client guides (Claude Code, Claude Desktop, Cowork, Perplexity) updated from Edge Function URLs to self-hosted + ngrok pattern.

### Removed

- **Supabase Edge Function MCP deployment.** `scripts/deploy-remote.sh`, `supabase/functions/gbrain-mcp/`, `src/edge-entry.ts`, `.env.production.example`, `docs/mcp/CHATGPT.md` all removed. The Edge Function never worked reliably. Self-hosted + ngrok is the path.

## [0.7.0] - 2026-04-11

### Added

- **Your brain now runs locally with zero infrastructure.** PGLite (Postgres 17.5 compiled to WASM) gives you the exact same search quality as Supabase, same pgvector HNSW, same pg_trgm fuzzy matching, same tsvector full-text search. No server, no subscription, no API keys needed for keyword search. `gbrain init` and you're running in 2 seconds.
- **Smart init defaults to local.** `gbrain init` now creates a PGLite brain by default. If your repo has 1000+ markdown files, it suggests Supabase for scale. `--supabase` and `--pglite` flags let you choose explicitly.
- **Migrate between engines anytime.** `gbrain migrate --to supabase` transfers your entire brain (pages, chunks, embeddings, tags, links, timeline) to remote Postgres with manifest-based resume. `gbrain migrate --to pglite` goes the other way. Embeddings copy directly, no re-embedding needed.
- **Pluggable engine factory.** `createEngine()` dynamically loads the right engine from config. PGLite WASM is never loaded for Postgres users.
- **Search works without OpenAI.** `hybridSearch` now checks for `OPENAI_API_KEY` before attempting embeddings. No key = keyword-only search. No more crashes when you just want to search your local brain.
- **Your brain gets new senses automatically.** Integration recipes teach your agent how to wire up voice calls, email, Twitter, and calendar into your brain. Run `gbrain integrations` to see what's available. Your agent reads the recipe, asks for API keys, validates each one, and sets everything up. Markdown is code -- the recipe IS the installer.
- **Voice-to-brain: phone calls create brain pages.** The first recipe: Twilio + OpenAI Realtime voice agent. Call a number, talk, and a structured brain page appears with entity detection, cross-references, and a summary posted to your messaging app. Opinionated defaults: caller screening, brain-first lookup, quiet hours, thinking sounds. The smoke test calls YOU (outbound) so you experience the magic immediately.
- **`gbrain integrations` command.** Six subcommands for managing integration recipes: `list` (dashboard of senses + reflexes), `show` (recipe details), `status` (credential checks with direct links to get missing keys), `doctor` (health checks), `stats` (signal analytics), `test` (recipe validation). `--json` on every subcommand for agent-parseable output. No database connection needed.
- **Health heartbeat.** Integrations log events to `~/.gbrain/integrations/<id>/heartbeat.jsonl`. Status checks detect stale integrations and include diagnostic steps.
- **17 individually linkable SKILLPACK guides.** The 1,281-line monolith is now broken into standalone guides at `docs/guides/`, organized by category. Each guide is individually searchable and linkable. The SKILLPACK index stays at the same URL (backward compatible).
- **"Getting Data In" documentation.** New `docs/integrations/` with a landing page, recipe format documentation, credential gateway guide, and meeting webhook guide. Explains the deterministic collector pattern: code for data, LLMs for judgment.
- **Architecture and philosophy docs.** `docs/architecture/infra-layer.md` documents the shared foundation (import, chunk, embed, search). `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` is Garry's essay on the architecture philosophy with an agent decision guide. `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` maps the 10-star vision.

### Changed

- **Engine interface expanded.** Added `runMigration()` (replaces internal driver access for schema migrations) and `getChunksWithEmbeddings()` (loads embedding data for cross-engine migration).
- **Shared utilities extracted.** `validateSlug`, `contentHash`, and row mappers moved from `postgres-engine.ts` to `src/core/utils.ts`. Both engines share them.
- **Config infers engine type.** If `database_path` is set but `engine` is missing, config now infers `pglite` instead of defaulting to `postgres`.
- **Import serializes on PGLite.** Parallel workers are Postgres-only. PGLite uses sequential import (single-connection architecture).

## [0.6.1] - 2026-04-10

### Fixed

- **Import no longer silently drops files with "..." in the name.** The path traversal check rejected any filename containing two consecutive dots, killing 1.2% of files in real-world corpora (YouTube transcripts, TED talks, podcast titles). Now only rejects actual traversal patterns like `../`. Community fix wave, 8 contributors.
- **Import no longer crashes on JavaScript/TypeScript projects.** The file walker crashed on `node_modules` directories and broken symlinks. Now skips `node_modules` and handles broken symlinks gracefully with a warning.
- **`gbrain init` exits cleanly after setup.** Previously hung forever because stdin stayed open. Now pauses stdin after reading input.
- **pgvector extension auto-created during init.** No more copy-pasting SQL into the Supabase editor. `gbrain init` now runs `CREATE EXTENSION IF NOT EXISTS vector` automatically, with a clear fallback message if it can't.
- **Supabase connection string hint matches current dashboard UI.** Updated navigation path to match the 2026 Supabase dashboard layout.
- **Hermes Agent link fixed in README.** Pointed to the correct NousResearch GitHub repo.

### Changed

- **Search is faster.** Keyword search now runs in parallel with the embedding pipeline instead of waiting for it. Saves ~200-500ms per hybrid search call.
- **.mdx files are now importable.** The import walker, sync filter, and slug generator all recognize `.mdx` alongside `.md`.

### Added

- **Community PR wave process** documented in CLAUDE.md for future contributor batches.

### Contributors

Thank you to everyone who reported bugs, submitted fixes, and helped make GBrain better:

- **@orendi84** — slug validator ellipsis fix (PR #31)
- **@mattbratos** — import walker resilience + MDX support (PRs #26, #27)
- **@changergosum** — init exit fix + auto pgvector (PRs #17, #18)
- **@eric-hth** — Supabase UI hint update (PR #30)
- **@irresi** — parallel hybrid search (PR #8)
- **@howardpen9** — Hermes Agent link fix (PR #34)
- **@cktang88** — the thorough 12-bug report that drove v0.6.0 (Issue #22)
- **@mvanhorn** — MCP schema handler fix (PR #25)

## [0.6.0] - 2026-04-10

### Added

- **Access your brain from any AI client.** Deploy GBrain as a serverless remote MCP endpoint on your existing Supabase instance. Works with Claude Desktop, Claude Code, Cowork, and Perplexity Computer. One URL, bearer token auth, zero new infrastructure. Clone the repo, fill in 3 env vars, run `scripts/deploy-remote.sh`, done.
- **Per-client setup guides** in `docs/mcp/` for Claude Code, Claude Desktop, Cowork, Perplexity, and ChatGPT (coming soon, requires OAuth 2.1). Also documents Tailscale Funnel and ngrok as self-hosted alternatives.
- **Token management** via standalone `src/commands/auth.ts`. Create, list, revoke per-client bearer tokens. Includes smoke test: `auth.ts test <url> --token <token>` verifies the full pipeline (initialize + tools/list + get_stats) in 3 seconds.
- **Usage logging** via `mcp_request_log` table. Every remote tool call logs token name, operation, latency, and status for debugging and security auditing.
- **Hardened health endpoint** at `/health`. Unauthenticated: 200/503 only (no info disclosure). Authenticated: checks postgres, pgvector, and OpenAI API key status.

### Fixed

- **MCP server actually connects now.** Handler registration used string literals (`'tools/list' as any`) instead of SDK typed schemas. Replaced with `ListToolsRequestSchema` and `CallToolRequestSchema`. Without this fix, `gbrain serve` silently failed to register handlers. (Issue #9)
- **Search results no longer flooded by one large page.** Keyword search returned ALL chunks from matching pages. Now returns one best chunk per page via `DISTINCT ON`. (Issue #22)
- **Search dedup no longer collapses to one chunk per page.** Layer 1 kept only the single highest-scoring chunk per slug. Now keeps top 3, letting later dedup layers (text similarity, cap per page) do their job. (Issue #22)
- **Transactions no longer corrupt shared state.** Both `PostgresEngine.transaction()` and `db.withTransaction()` swapped the shared connection reference, breaking under concurrent use. Now uses scoped engine via `Object.create` with no shared state mutation. (Issue #22)
- **embed --stale no longer wipes valid embeddings.** `upsertChunks()` deleted all chunks then re-inserted, writing NULL for chunks without new embeddings. Now uses UPSERT (INSERT ON CONFLICT UPDATE) with COALESCE to preserve existing embeddings. (Issue #22)
- **Slug normalization is consistent.** `pathToSlug()` preserved case while `inferSlug()` lowercased. Now `validateSlug()` enforces lowercase at the validation layer, covering all entry points. (Issue #22)
- **initSchema no longer reads from disk at runtime.** Both schema loaders used `readFileSync` with `import.meta.url`, which broke in compiled binaries and Deno Edge Functions. Schema is now embedded at build time via `scripts/build-schema.sh`. (Issue #22)
- **file_upload actually uploads content.** The operation wrote DB metadata but never called the storage backend. Fixed in all 3 paths (operation, CLI upload, CLI sync) with rollback semantics. (Issue #22)
- **S3 storage backend authenticates requests.** `signedFetch()` was just unsigned `fetch()`. Replaced with `@aws-sdk/client-s3` for proper SigV4 signing. Supports R2/MinIO via `forcePathStyle`. (Issue #22)
- **Parallel import uses thread-safe queue.** `queue.shift()` had race conditions under parallel workers. Now uses an atomic index counter. Checkpoint preserved on errors for safe resume. (Issue #22)
- **redirect verifies remote existence before deleting local files.** Previously deleted local files unconditionally. Now checks storage backend before removing. (Issue #22)
- **`gbrain call` respects dry_run.** `handleToolCall()` hardcoded `dryRun: false`. Now reads from params. (Issue #22)

### Changed

- Added `@aws-sdk/client-s3` as a dependency for authenticated S3 operations.
- Schema migration v2: unique index on `content_chunks(page_id, chunk_index)` for UPSERT support.
- Schema migration v3: `access_tokens` and `mcp_request_log` tables for remote MCP auth.

## [0.5.1] - 2026-04-10

### Fixed

- **Apple Notes and files with spaces just work.** Paths like `Apple Notes/2017-05-03 ohmygreen.md` now auto-slugify to clean slugs (`apple-notes/2017-05-03-ohmygreen`). Spaces become hyphens, parens and special characters are stripped, accented characters normalize to ASCII. All 5,861+ Apple Notes files import cleanly without manual renaming.
- **Existing brains auto-migrate.** On first run after upgrade, a one-time migration renames all existing slugs with spaces or special characters to their clean form. Links are rewritten automatically. No manual cleanup needed.
- **Import and sync produce identical slugs.** Both pipelines now use the same `slugifyPath()` function, eliminating the mismatch where sync preserved case but import lowercased.

## [0.5.0] - 2026-04-10

### Added

- **Your brain never falls behind.** Live sync keeps the vector DB current with your brain repo automatically. Set up a cron, use `--watch`, hook into GitHub webhooks, or use git hooks. Your agent picks whatever fits its environment. Edit a markdown file, push, and within minutes it's searchable. No more stale embeddings serving wrong answers.
- **Know your install actually works.** New verification runbook (`docs/GBRAIN_VERIFY.md`) catches the silent failures that used to go unnoticed: the pooler bug that skips pages, missing embeddings, stale sync. The real test: push a correction, wait, search for it. If the old text comes back, sync is broken and the runbook tells you exactly why.
- **New installs set up live sync automatically.** The setup skill now includes live sync (Phase H) and full verification (Phase I) as mandatory steps. Agents that install GBrain will configure automatic sync and verify it works before declaring setup complete.
- **Fixes the silent page-skip bug.** If your Supabase connection uses the Transaction mode pooler, sync silently skips most pages. The new docs call this out as a hard prerequisite with a clear fix (switch to Session mode). The verification runbook catches it by comparing page count against file count.

## [0.4.2] - 2026-04-10

### Changed

- All GitHub Actions pinned to commit SHAs across test, e2e, and release workflows. Prevents supply chain attacks via mutable version tags.
- Workflow permissions hardened: `contents: read` on test and e2e workflows limits GITHUB_TOKEN blast radius.
- OpenClaw CI install pinned to v2026.4.9 instead of pulling latest.

### Added

- Gitleaks secret scanning CI job runs on every push and PR. Catches accidentally committed API keys, tokens, and credentials.
- `.gitleaks.toml` config with allowlists for test fixtures and example files.
- GitHub Actions SHA maintenance rule in CLAUDE.md so pins stay fresh on every `/ship` and `/review`.
- S3 Sig V4 TODO for future implementation when S3 storage becomes a deployment path.

## [0.4.1] - 2026-04-09

### Added

- `gbrain check-update` command with `--json` output. Checks GitHub Releases for new versions, compares semver (minor+ only, skips patches), fetches and parses changelog diffs. Fail-silent on network errors.
- SKILLPACK Section 17: Auto-Update Notifications. Full agent playbook for the update lifecycle: check, notify, consent, upgrade, skills refresh, schema sync, report. Never auto-upgrades without user permission.
- Standalone SKILLPACK self-update for users who load the skillpack directly without the gbrain CLI. Version markers in SKILLPACK and RECOMMENDED_SCHEMA headers, with raw GitHub URL fetching.
- Step 7 in the OpenClaw install paste: daily update checks, default-on. User opts into being notified about updates, not into automatic installs.
- Setup skill Phase G: conditional auto-update offer for manual install users.
- Schema state tracking via `~/.gbrain/update-state.json`. Tracks which recommended schema directories the user adopted, declined, or added custom. Future upgrades suggest new additions without re-suggesting declined items.
- `skills/migrations/` directory convention for version-specific post-upgrade agent directives.
- 20 unit tests and 5 E2E tests for the check-update command, covering version comparison, changelog extraction, CLI wiring, and real GitHub API interaction.
- E2E test DB lifecycle documentation in CLAUDE.md: spin up, run tests, tear down. No orphaned containers.

### Changed

- `detectInstallMethod()` exported from `upgrade.ts` for reuse by `check-update`.

### Fixed

- Semver comparison in changelog extraction was missing major-version guard, causing incorrect changelog entries to appear when crossing major version boundaries.

## [0.4.0] - 2026-04-09

### Added

- `gbrain doctor` command with `--json` output. Checks pgvector extension, RLS policies, schema version, embedding coverage, and connection health. Agents can self-diagnose issues.
- Pluggable storage backends: S3, Supabase Storage, and local filesystem. Choose where binary files live independently of the database. Configured via `gbrain init` or environment variables.
- Parallel import with per-worker engine instances. Large brain imports now use multiple database connections concurrently instead of a single serial pipeline.
- Import resume checkpoints. If `gbrain import` is interrupted, it picks up where it left off instead of re-importing everything.
- Automatic schema migration runner. On connect, gbrain detects the current schema version and applies any pending migrations without manual intervention.
- Row-Level Security (RLS) enabled on all tables with `BYPASSRLS` safety check. Every query goes through RLS policies.
- `--json` flag on `gbrain init` and `gbrain import` for machine-readable output. Agents can parse structured results instead of scraping CLI text.
- File migration CLI (`gbrain files migrate`) for moving files between storage backends. Two-way-door: test with `--dry-run`, migrate incrementally.
- Bulk chunk INSERT for faster page writes. Chunks are inserted in a single statement instead of one-at-a-time.
- Supabase smart URL parsing: automatically detects and converts IPv6-only pooler URLs to the correct connection format.
- 56 new unit tests covering doctor, storage backends, file migration, import resume, slug validation, setup branching, Supabase admin, and YAML parsing. Test suite grew from 9 to 19 test files.
- E2E tests for parallel import concurrency and all new features.

### Fixed

- `validateSlug` now accepts any filename characters (spaces, unicode, special chars) instead of rejecting non-alphanumeric slugs. Apple Notes and other real-world filenames import cleanly.
- Import resilience: files over 5MB are skipped with a warning instead of crashing the pipeline. Errors in individual files no longer abort the entire import.
- `gbrain init` detects IPv6-only Supabase URLs and adds the required `pgvector` check during setup.
- E2E test fixture counts, CLI argument parsing, and doctor exit codes cleaned up.

### Changed

- Setup skill and README rewritten for agent-first developer experience.
- Maintain skill updated with RLS verification, schema health checks, and `nohup` hints for large embedding jobs.

## [0.3.0] - 2026-04-08

### Added

- Contract-first architecture: single `operations.ts` defines ~30 shared operations. CLI, MCP, and tools-json all generated from the same source. Zero drift.
- `OperationError` type with structured error codes (`page_not_found`, `invalid_params`, `embedding_failed`, etc.). Agents can self-correct.
- `dry_run` parameter on all mutating operations. Agents preview before committing.
- `importFromContent()` split from `importFile()`. Both share the same chunk+embed+tag pipeline, but `importFromContent` works from strings (used by `put_page`). Wrapped in `engine.transaction()`.
- Idempotency hash now includes ALL fields (title, type, frontmatter, tags), not just compiled_truth + timeline. Metadata-only edits no longer silently skipped.
- `get_page` now supports optional `fuzzy: true` for slug resolution. Returns `resolved_slug` so callers know what happened.
- `query` operation now supports `expand` toggle (default true). Both CLI and MCP get the same control.
- 10 new operations wired up: `put_raw_data`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`, `get_ingest_log`, `file_list`, `file_upload`, `file_url`.
- OpenClaw bundle plugin manifest (`openclaw.plugin.json`) with config schema, MCP server config, and skill listing.
- GitHub Actions CI: test on push/PR, multi-platform release builds (macOS arm64 + Linux x64) on version tags.
- `gbrain init --non-interactive` flag for plugin mode (accepts config via flags/env vars, no TTY required).
- Post-upgrade version verification in `gbrain upgrade`.
- Parity test (`test/parity.test.ts`) verifies structural contract between operations, CLI, and MCP.
- New `setup` skill replacing `install`: auto-provision Supabase via CLI, AGENTS.md injection, target TTHW < 2 min.
- E2E test suite against real Postgres+pgvector. 13 realistic fixtures (miniature brain with people, companies, deals, meetings, concepts), 14 test suites covering all operations, search quality benchmarks, idempotency stress tests, schema validation, and full setup journey verification.
- GitHub Actions E2E workflow: Tier 1 (mechanical) on every PR, Tier 2 (LLM skills via OpenClaw) nightly.
- `docker-compose.test.yml` and `.env.testing.example` for local E2E development.

### Fixed

- Schema loader in `db.ts` broke on PL/pgSQL trigger functions containing semicolons inside `$$` blocks. Replaced per-statement execution with single `conn.unsafe()` call.
- `traverseGraph` query failed with "could not identify equality operator for type json" when using `SELECT DISTINCT` with `json_agg`. Changed to `jsonb_agg`.

### Changed

- `src/mcp/server.ts` rewritten from ~233 to ~80 lines. Tool definitions and dispatch generated from operations[].
- `src/cli.ts` rewritten. Shared operations auto-registered from operations[]. CLI-only commands (init, upgrade, import, export, files, embed) kept as manual registrations.
- `tools-json` output now generated FROM operations[]. Third contract surface eliminated.
- All 7 skills rewritten with tool-agnostic language. Works with both CLI and MCP plugin contexts.
- File schema: `storage_url` column dropped, `storage_path` is the only identifier. URLs generated on demand via `file_url` operation.
- Config loading: env vars (`GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`) override config file values. Plugin config injected via env vars.

### Removed

- 12 command files migrated to operations.ts: get.ts, put.ts, delete.ts, list.ts, search.ts, query.ts, health.ts, stats.ts, tags.ts, link.ts, timeline.ts, version.ts.
- `storage_url` column from files table.

## [0.2.0.2] - 2026-04-07

### Changed

- Rewrote recommended brain schema doc with expanded architecture: database layer (entity registry, event ledger, fact store, relationship graph) presented as the core architecture, entity identity and deduplication, enrichment source ordering, epistemic discipline rules, worked examples showing full ingestion chains, concurrency guidance, and browser budget. Smoothed language for open-source readability.

## [0.2.0.1] - 2026-04-07

### Added

- Recommended brain schema doc (`docs/GBRAIN_RECOMMENDED_SCHEMA.md`): full MECE directory structure, compiled truth + timeline pages, enrichment pipeline, resolver decision tree, skill architecture, and cron job recommendations. The OpenClaw paste now links to this as step 5.

### Changed

- First-time experience rewritten. "Try it" section shows your own data, not fictional PG essays. OpenClaw paste references the GitHub repo, includes bun install fallback, and has the agent pick a dynamic query based on what it imported.
- Removed all references to `data/kindling/` (a demo corpus directory that never existed).

## [0.2.0] - 2026-04-05

### Added

- You can now keep your brain current with `gbrain sync`, which uses git's own diff machinery to process only what changed. No more 30-second full directory walks when 3 files changed.
- Watch mode (`gbrain sync --watch`) polls for changes and syncs automatically. Set it and forget it.
- Binary file management with `gbrain files` commands (list, upload, sync, verify). Store images, PDFs, and audio in Supabase Storage instead of clogging your git repo.
- Install skill (`skills/install/SKILL.md`) that walks you through setup from scratch, including Supabase CLI magic path for zero-copy-paste onboarding.
- Import and sync now share a checkpoint. Run `gbrain import`, then `gbrain sync`, and it picks up right where import left off. Zero gap.
- Tag reconciliation on reimport. If you remove a tag from your markdown, it actually gets removed from the database now.
- `gbrain config show` redacts database passwords so you can safely share your config.
- `updateSlug` engine method preserves page identity (page_id, chunks, embeddings) across renames. Zero re-embedding cost.
- `sync_brain` MCP tool returns structured results so agents know exactly what changed.
- 20 new sync tests (39 total across 3 test files)

## [0.1.0] - 2026-04-05

### Added

- Pluggable engine interface (`BrainEngine`) with full Postgres + pgvector implementation
- 25+ CLI commands: init, get, put, delete, list, search, query, import, export, embed, stats, health, link/unlink/backlinks/graph, tag/untag/tags, timeline/timeline-add, history/revert, config, upgrade, serve, call
- MCP stdio server with 20 tools mirroring all CLI operations
- 3-tier chunking: recursive (delimiter-aware), semantic (Savitzky-Golay boundary detection), LLM-guided (Claude Haiku topic shifts)
- Hybrid search with Reciprocal Rank Fusion merging vector + keyword results
- Multi-query expansion via Claude Haiku (2 alternative phrasings per query)
- 4-layer dedup pipeline: by source, cosine similarity, type diversity, per-page cap
- OpenAI embedding service (text-embedding-3-large, 1536 dims) with batch support and exponential backoff
- Postgres schema with pgvector HNSW, tsvector (trigger-based, spans timeline_entries), pg_trgm fuzzy slug matching
- Smart slug resolution for reads (fuzzy match via pg_trgm)
- Page version control with snapshot, history, and revert
- Typed links with recursive CTE graph traversal (max depth configurable)
- Brain health dashboard (embed coverage, stale pages, orphans, dead links)
- Stale alert annotations in search results
- Supabase init wizard with CLI auto-provision fallback
- Slug validation to prevent path traversal on export
- 6 fat markdown skills: ingest, query, maintain, enrich, briefing, migrate
- ClawHub manifest for skill distribution
- Full design docs: GBRAIN_V0 spec, pluggable engine architecture, SQLite engine plan
