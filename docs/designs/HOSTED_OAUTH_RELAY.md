# Hosted OAuth Relay — Design for the gbrain.io Team

**Status:** Approved direction (D2-B, 2026-08-25). CLI-side seams ship in the gbrain
`gmail-open-loop-engine` wave; the server side specified here is gbrain.io's build.
**Companion:** the Gmail open-loop engine plan in the gbrain repo (Phase 1 credential
vault, Phase 1.5 relay client stub).

## 1. Context and goal

gbrain is shipping native Gmail/Calendar/Contacts ingestion with a BYO Google OAuth
flow: the user creates their own Google Cloud OAuth client, and tokens live in a local
credential vault (`~/.gbrain/credentials.json`, 0600). BYO is the default because the
user owns the app, the quota, and the tokens.

The BYO path has an irreducible ~6–8 minutes of Google Cloud console work (create
project, enable APIs, consent screen, client, download JSON). Hosted OAuth brokers
(Composio, Arcade, Pipedream Connect) get "connect Gmail" to ~30 seconds, but they
custody user tokens server-side. The relay described here gets gbrain to the ~30-second
setup **without becoming a token custodian**: gbrain.io operates one verified Google
OAuth client and relays consent; tokens are claimed once by the user's local CLI and
stored only in their local vault.

The same infrastructure serves three needs:

1. **Fast-path setup** for CLI/self-host users (`gbrain google connect --via gbrain.io`).
2. **The hosted product's own Google connections** (hosted gbrain.io runs the identical
   `src/core/creds` + `src/core/google` code with a DB-backed vault).
3. **Credential transfer on upgrade** (a user moving from local to hosted opts in to
   transferring their connections).

## 2. Requirements

- Fewest possible user interactions: one click on a consent URL, nothing else.
- gbrain.io never persists user refresh tokens for CLI users beyond a short claim window.
- The CLI works fully without gbrain.io (BYO remains first-class; the relay is additive).
- Code reuse: the relay client, vault, and Google provider are shared between CLI and
  hosted (already structured that way in the gbrain repo: `src/core/creds/` has no CLI
  imports).
- Generalizes beyond Google: the same session/claim pattern should work for Dropbox
  OAuth and any future provider the vault registry grows.

## 3. Client architecture: the one decision that shapes everything

Google offers two viable shapes for "gbrain.io's OAuth client." We evaluated both:

**Option A — embedded Desktop (public) client.** Ship gbrain.io's Desktop-app client ID
+ secret inside the gbrain binary (Google treats installed-app secrets as
non-confidential per RFC 8252). No server needed at all: the CLI runs the normal
loopback flow against the shared client.

- Pros: zero server work; zero runtime dependency on gbrain.io; refresh works locally.
- Cons: this is exactly rclone's shared-client model, and its failure mode is on the
  record — the embedded secret gets scraped and reused by third parties, all users share
  one quota pool, abuse is unrevocable without breaking every install, and Google is
  retiring rclone's shared client in 2026. Verification posture for a public client with
  restricted scopes is murkier, and there is no way to rotate the secret without a
  release.

**Option B — Web (confidential) client + zero-retention relay (RECOMMENDED).**
gbrain.io registers a Web application client whose secret never leaves the server. The
relay brokers consent and token exchange, hands tokens to the CLI exactly once, and
deletes them.

- Pros: secret rotatable server-side; abuse controllable (rate limits, session revoke);
  quota still shared but enforceable; the same client later powers Gmail Pub/Sub push
  and the hosted product's own connections; CASA verification is done once for one
  well-controlled client.
- Cons: real server work (this doc); relay-minted refresh tokens require the client
  secret to refresh, so CLI refreshes route through a relay endpoint (see §5) — a
  runtime dependency on gbrain.io *for relay-connected accounts only*. BYO accounts
  never touch it.

**Recommendation: Option B.** The rclone precedent is a decade-long natural experiment
in Option A's failure mode.

## 4. Relay protocol (Option B spec)

All endpoints under `https://gbrain.io/api/oauth/relay/`. All responses JSON. All
sessions single-use, short-TTL, PKCE-bound.

### 4.1 Session lifecycle

```
CLI                                relay (gbrain.io)                     Google
 │ POST /sessions                        │                                  │
 │  {provider:"google", scopes:[...],    │                                  │
 │   client_kind:"cli"}                  │                                  │
 │◄── 201 {session_id, claim_secret,     │ generates state + PKCE pair,     │
 │     consent_url, expires_in:600}      │ stores {session, verifier}       │
 │                                       │                                  │
 │ (user opens consent_url — the ONLY    │                                  │
 │  user interaction)                    │                                  │
 │                                       │◄─ GET /callback?code&state ──────│
 │                                       │ validates state, exchanges code  │
 │                                       │ (client secret + PKCE verifier), │
 │                                       │ encrypts tokens under a          │
 │                                       │ session-scoped key, TTL 10 min   │
 │                                       │ renders "Connected — return to   │
 │                                       │  your agent" page                │
 │ GET /sessions/:id/claim               │                                  │
 │  Authorization: Bearer <claim_secret> │                                  │
 │◄── 200 {access_token, refresh_token,  │ DELETES tokens on first          │
 │     expiry, scopes, email}            │ successful claim (one-time)      │
```

- `consent_url` is the Google authorization URL built by the relay: gbrain.io's
  client_id, `redirect_uri=https://gbrain.io/api/oauth/relay/callback`,
  `access_type=offline&prompt=consent`, relay-held PKCE (S256), `state=session_id.nonce`.
- The CLI polls `claim` (backoff 2s → 10s) until 200, `410 claim_already_used`,
  or `404 session_expired`.
- On claim, the CLI writes the vault entry with `client_ref: "hosted-relay"` and the
  account email from the response (relay fetches userinfo during exchange).

### 4.2 Zero-retention custody rules

- Tokens exist server-side only between callback and claim, ≤10 minutes, encrypted
  under a per-session key derived from `claim_secret` (the relay stores the ciphertext
  and a hash of the claim secret — it cannot decrypt after discarding the plaintext
  secret it returned at session create).
- One-time claim: first successful claim deletes the row; replays get `410`.
- Unclaimed sessions are hard-deleted at TTL.
- Audit log: session created / consent completed / claimed / expired, with coarse
  metadata only (no tokens, no email in logs — hash the email).

### 4.3 Abuse controls

- Rate limit session creation per IP and per fingerprint; cap open sessions.
- `client_kind` distinguishes CLI vs hosted-web sessions for monitoring.
- The consent callback validates `state` strictly; mismatches burn the session.
- Quota watch: alert on approach to the Google client's per-client quota; the CLI's
  error catalog already maps 429/403-rate to a "shared fast path is busy — BYO always
  works" message.

## 5. Refresh routing for relay-minted tokens

Refresh tokens minted under the confidential client cannot be refreshed locally
(requires the client secret). The gbrain vault marks provenance with `client_ref`:

- `client_ref: "byo"` → the google provider refreshes directly against
  `oauth2.googleapis.com/token` with the user's own client credentials (all local).
- `client_ref: "hosted-relay"` → the provider calls
  `POST /api/oauth/relay/refresh {refresh_token}` and receives a fresh access token.
  The relay performs the upstream refresh and returns the result **without storing
  either token**. If Google rotates the refresh token, the new one is returned and
  persisted locally.

Availability note for the CLI UX: a relay outage degrades only relay-connected
accounts, only at access-token expiry (~1 h granularity), and the error message names
the fallback (`gbrain google connect` BYO). This is documented in the CLI's error
catalog as `relay_unreachable`.

## 6. Credential transfer on hosted upgrade (approved D3-A)

When a local user upgrades to hosted gbrain.io, they may opt in to transferring
connections instead of re-consenting:

- `POST https://gbrain.io/api/creds/import` over the authenticated upgrade channel
  (the user's hosted account auth), body = per-credential consented export from
  `gbrain creds export` (scrypt + AES-GCM bundle; also usable offline/manually).
- Per-credential confirmation in the CLI; local copies retained unless `--move`.
- BYO credentials transfer client_id + client_secret + refresh_token together (refresh
  tokens are client-bound). The import endpoint warns/refuses when the source consent
  screen is inferred to be Testing-mode (its 7-day expiry would silently break hosted
  ingestion — the exact failure the local product works hard to prevent).
- Relay-minted credentials don't need transfer at all: hosted already owns the client;
  the hosted product re-consents in ~30 seconds or accepts the refresh token directly.
- Once the relay is live, re-consent is the *preferred* upgrade path and transfer is
  the fallback for BYO holdouts.

## 7. Hosted product internal use

Hosted gbrain.io runs the same `src/core/creds` + `src/core/google` code:

- `EngineVaultBackend` implements the `CredentialVault` interface against a DB table
  (per-user rows, encryption-at-rest hook for KMS). The interface is frozen in the
  gbrain repo this wave; the backend is hosted-side work.
- `RedirectStrategy: 'hosted-callback'` — the hosted web app's connect button uses the
  same provider code with the relay's callback, skipping sessions/claims (tokens land
  directly in the user's server-side vault; hosted IS the custodian for hosted users,
  by definition and with their knowledge).
- The `open_loops` op ships with fail-closed evidence redaction for remote callers
  (approved D4-A), so hosted can serve the "who's waiting on you" output over HTTP to
  the authenticated owner from day one; verbatim email quotes stay local-only until a
  finer-grained remote-auth predicate exists.

## 8. Shared-code contract (what the gbrain repo freezes this wave)

| Seam | Shape | Where |
|---|---|---|
| `CredentialVault` | get/put/list/delete over `CredentialEntry {id, provider, kind, secret, meta}` | `src/core/creds/vault.ts` |
| `client_ref` | `'byo' \| 'hosted-relay'` on google vault entries; routes refresh | `src/core/creds/providers/google.ts` |
| `RedirectStrategy` | `'loopback' \| 'paste' \| 'hosted-callback'` | `src/core/creds/redirect.ts` |
| Relay client | `createSession / pollClaim / refreshViaRelay`, gated by `GBRAIN_OAUTH_RELAY_URL` | `src/core/creds/relay-client.ts` |
| Export bundle | versioned scrypt+AES-GCM JSON, per-credential | `src/core/creds/export.ts` |
| Error codes | `relay_unreachable`, `relay_session_expired`, `claim_already_used`, `relay_disabled` + the full Google credential catalog | `src/core/creds/errors.ts` |

Server implementations must round-trip the relay client's fake-server test suite
(`test/creds-relay-client.test.ts`) — treat it as the conformance spec.

## 9. Verification track (start immediately — this is the long pole)

`gmail.readonly` is a **restricted** scope; `calendar.readonly` and
`contacts.readonly` are sensitive. Verifying gbrain.io's client requires:

1. Brand verification: domain ownership (Search Console), app name, logo, homepage.
2. Public privacy policy URL covering Google user data handling + Limited Use
   compliance statement.
3. Scope justification write-up + demo video of the consent-to-feature flow.
4. **CASA security assessment (Tier 2)** for the restricted Gmail scope — third-party
   assessor, annual recertification, historically weeks-to-months end-to-end.
5. Limited Use attestation renewals.

Until verification completes, the relay can run in Testing mode for team dogfood
(≤100 test users, 7-day refresh expiry — acceptable for dogfood only). Do not launch
the fast path publicly on an unverified client: users would hit the unverified-app
interstitial and restricted-scope blocks, which is the exact experience this relay
exists to remove.

## 10. Open questions for the gbrain.io team

1. Session store: Redis with TTL vs Postgres row + sweeper? (Design assumes either;
   one-time-claim semantics must be transactional.)
2. Should `refreshViaRelay` require a lightweight device registration (bearer minted at
   claim time) instead of raw refresh-token-in-body? Recommended: yes — a
   `relay_device_token` returned at claim, so the refresh endpoint never sees Google
   refresh tokens at all. CLI seam supports either; decide before freezing the refresh
   endpoint.
3. Multi-provider: the session/claim protocol is provider-generic — confirm Dropbox is
   the second provider so the endpoint shapes (`provider` field) don't get
   Google-specific.
4. Quota strategy at scale: one Google client for all relay users vs per-shard clients
   (Google policy constraints apply — needs a policy read before assuming shards are
   allowed).
5. Who owns the CASA engagement and what's the realistic calendar? Everything else in
   this doc can be built in parallel with it.
