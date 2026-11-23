# The brain store: the `oauth_codes` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-tokens.md](oauth-tokens.md) and
[oauth-clients.md](oauth-clients.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

The store keeps the `oauth_codes` table the authorization-code flow of `serve --http` writes: one single-use code per
SHA-256 hash, tied to a client, a PKCE challenge, a redirect URI and an expiry. The SQL for the PGLite and PostgreSQL
engines is in `src/core/engine-sql/access-credentials.ts` (`OAUTH_CODE_SQL`, byte for byte as `OAuthGrants` sent it
before it moved behind members); the store serves the same members. No store call returns a code hash, and the store
never logs one.

| Member | Returns |
| --- | --- |
| `brain.insertOauthCode(row)` | nothing. Writes `{ code_hash, client_id, scopes, code_challenge, code_challenge_method, redirect_uri, state, resource, expires_at }`; `expires_at` is epoch seconds, the method left out is `S256`, `created_at` is now. |
| `brain.readOauthCodeForUpdate(hash, clientId)` | the row of this hash **and** client, or null. Another client's code reads null. Expiry is the caller's check (`exchangeCode`). On PostgreSQL the read is `FOR UPDATE`; the store has one writer and takes no lock. |
| `brain.deleteOauthCode(hash, clientId)` | nothing. The exchange deletes the code before it issues the tokens: a code is single use. |
| `brain.readOauthCodeChallenge(hash, clientId, now)` | the PKCE challenge of an unexpired code (`expires_at` after `now`, epoch seconds) of this client whose client exists and is not soft-deleted, or null. |
| `brain.issueOauthTokens(rows)` | nothing. Writes the access token and the refresh token of one grant in **one** write: both or neither (see [oauth-tokens.md](oauth-tokens.md)). |
| `brain.deleteExpiredOauthCredentials(now)` | how many expired tokens and codes the startup sweep deleted, in one write. |
| `brain.clientHoldsOauthCode(clientId)` | whether any code row names this client (the store fn `client_holds_oauth_code`; first consent asks `oauthClientHoldsAuthorization`, which reads it with the token half). |

The grant's client lock (`readOauthClientForUpdate`) is the client row read through the same transaction: PostgreSQL takes
`FOR UPDATE`, the store reads inside its write.

## Constraints

A write that breaks one is `constraint_violation`, with the Postgres message. The TypeScript member
(`src/core/rust-engine/store-members/jobs-access-tokens.ts`) gives the error the SQLSTATE and constraint name PGLite and
PostgreSQL raise. A repeated hash is checked first, as Postgres does.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| a code hash already taken | 23505 | `oauth_codes_pkey` |
| a client with no row (a soft-deleted client has one) | 23503 | `oauth_codes_client_id_fkey` |

A refused write leaves the table as it was.

Keys: `m 0x2D code_hash -> record` (times in microseconds, except `expires_at`). Deleting a client
(`deleteOauthClient`) removes its codes, by scanning the table, as `ON DELETE CASCADE` does.

## Callers

`OAuthGrants` (`src/core/oauth-grants.ts`) runs `decide` (`insertOauthCode`) and `exchangeCode`
(`readOauthCodeForUpdate`, `deleteOauthCode`, then `issueOauthTokens`) on the grant transaction's engine handle: the
second argument `serve --http` passes to the transaction callback. The provider's `challengeForAuthorizationCode` calls
`readOauthCodeChallenge`, and `sweepExpiredTokens` calls `deleteExpiredOauthCredentials`. A grant built without the
handle (`mcp-provision`, `commands/auth.ts`) keeps the same statements through the SqlQuery.

Differences from PGLite and PostgreSQL:

- Not kept: the secondary indexes and the row-level security.
- An expired code stays until the sweep runs or its client is deleted; the exchange and the challenge read refuse it either way.
- Still raw SQL, so a Rust brain refuses them: `revokeClient` and `grants/lifecycle.ts` (they delete a client's codes),
  `shared-skills/restore.ts` (it expires them), and the refresh-token read of `OAuthGrants.refresh`.
