# The brain store: the `oauth_tokens` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-clients.md](oauth-clients.md) and
[access-tokens.md](access-tokens.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

The store keeps the `oauth_tokens` table the bearer check `serve --http` reads: one access or refresh token per hash. The
SQL for the PGLite and PostgreSQL engines is in `src/core/engine-sql/access-credentials.ts` (`BEARER_SQL` for the read,
`OAUTH_TOKEN_SQL` for the insert); the store serves the same members. No store call returns a token hash, and the store
never logs one.

| Member | Returns |
| --- | --- |
| `brain.insertOauthToken(row)` | nothing. Writes `{ token_hash, token_type, client_id, scopes, expires_at, resource, created_at, grant_type }`; `expires_at` and `created_at` are epoch seconds, `created_at` falls back to the store clock, and a missing `grant_type` is NULL |
| `brain.readOauthAccessTokenRows(hash, rung)` | `[row]` or `[]`: the access token with this hash whose client exists and is not soft-deleted, with the client's grant. `rung` 0 is the full row; each higher rung drops the columns an older schema lacks, as the TypeScript degrade ladder expects. Row keys at rung 0: `client_id, scopes, expires_at, resource, client_name, current_scopes, token_grant, current_grant, source_active, active_read_sources, source_id, federated_read, bound_slug_prefixes, surface, surface_set_by` |
| `brain.issueOauthTokens(rows)` | nothing. Writes each row as `insertOauthToken` does, in order, in **one** write: a refusal on any row (23505, 23503) leaves none of them. |
| `brain.deleteExpiredOauthTokens(now)` | how many tokens of any type it deleted: those whose `expires_at` is before `now` (epoch seconds). A NULL `expires_at` stays. One write |

`current_grant` is the client row as JSON (`to_jsonb`), without `client_secret_hash`; `budget_usd_per_day` is a JSON number
and times (`created_at`, `deleted_at`, `reads_unscoped`) are `+00:00` text, as PostgreSQL gives them in a UTC session.
The PostgreSQL and PGLite reader moves the same three fields to that UTC text whatever the session TimeZone
(`utcCurrentGrant` in `src/core/engine-sql/access-credentials.ts`), so all engines return one text. `source_active` is whether the client's source
exists and is not archived. `active_read_sources` lists the non-archived sources in the client's `federated_read`, sorted
and without repeats.

## Constraints

A write that breaks one is `constraint_violation`, with the Postgres message. The TypeScript member
(`src/core/rust-engine/store-members/jobs-access-tokens.ts`) gives the error the SQLSTATE and constraint name PGLite and
PostgreSQL raise. A repeated hash is checked first, as Postgres does.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| a token hash already taken | 23505 | `oauth_tokens_pkey` |
| a client with no row (a soft-deleted client has one) | 23503 | `oauth_tokens_client_id_fkey` |

A refused write leaves the table as it was.

Keys: `m 0x2C token_hash -> record` (times in microseconds, except `expires_at`). Deleting a client
(`deleteOauthClient`) removes its tokens, by scanning the table, as `ON DELETE CASCADE` does.

## Callers

The bearer check (`verifyAccessToken`, `src/core/oauth-provider.ts`) calls `readOauthAccessTokenRows`. Tests and tools
insert through `insertOauthToken`. `OAuthGrants.issue` (`src/core/oauth-grants.ts`) writes the tokens of a grant through `issueOauthTokens`
on the grant transaction's engine handle, after `readOauthClientForUpdate` took the client row: on PostgreSQL and PGLite the
handle is the transaction's executor, never the pool (a write on another pooled connection would wait for the client row
lock on the foreign key and deadlock), and on the store both reads and writes are one `Store::write`. A grant built
without the handle keeps the same statements through the SqlQuery. The sweep of
expired credentials calls `deleteExpiredOauthCredentials` (tokens and codes, [oauth-codes.md](oauth-codes.md)).

`OAuthGrants.refresh` reads the presented refresh token through `readOauthRefreshTokenForUpdate(hash, clientId)`
(`read_oauth_refresh_token_for_update`: the row only when it is a `refresh` token of that client, else null; the lock is a
no-op on the store, one writer) and deletes it through `deleteOauthRefreshToken(hash, clientId)`
(`delete_oauth_refresh_token`: only that client's refresh row), both on the grant transaction's handle. A grant built
without the handle keeps the same statements through the SqlQuery. With `getClient` reading through `readOauthClient`,
/authorize, /token (code and refresh) and the owner consent serve on a Rust brain.

Differences from PGLite and PostgreSQL:

- Not kept: the secondary indexes. The `oauth_codes` table is kept, see [oauth-codes.md](oauth-codes.md).
- An expired row stays until the sweep runs or its client is deleted; the bearer check refuses it either way.
- `active_read_sources` is sorted by id; PostgreSQL's order is unspecified.
- Still raw SQL, so a Rust brain refuses them: the SqlQuery fallbacks of `grants/service.ts` and the two
  `persistence_requests` counts in `serve-http-admin-api.ts`.

## Revoke members

`OAuthGrants.revokeToken` and `revokeClient` (`src/core/oauth-grants.ts`) run these members of
`src/core/engine-sql/oauth-revocation.ts` when the grant transaction hands out its engine handle (`serve --http` does:
`transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx))`); without the handle they send the same
statements through the SqlQuery. The client lock is `readOauthClientForUpdate`, a no-op lock on the Rust store (one writer).
All of them run in the store's write transaction, so a revoke is one write.

- `deleteOauthTokenByHash(hash, clientId)`: `DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`
  (`delete_oauth_token_by_hash`). A hash another client owns, or none, deletes nothing.
- `deleteOauthClientTokens(clientId)`: every token of the client (`delete_oauth_client_tokens`).
- `softDeleteOauthClient(clientId)`: `deleted_at = now()` on the client row, whatever it held (`soft_delete_oauth_client`).
- `deleteOauthClientCodes(clientId)`: `DELETE FROM oauth_codes WHERE client_id = $1` (`delete_oauth_client_codes`), so a
  revoked client keeps no code it could still exchange.

## Client lifecycle members

`mutateClientLifecycle` (`src/core/grants/lifecycle.ts`: `invalidate-tokens`, `revoke`, `delete`) runs in one engine
transaction on `readOauthClientForUpdate`, `deleteOauthClientTokens`, `deleteOauthClientCodes` and three more members of
`engine-sql/oauth-revocation.ts`:

- `deleteOauthClientRow(clientId)`: `DELETE FROM oauth_clients WHERE client_id = $1`. The Rust half is `delete_oauth_client`
  (the row and its tokens); the returned row is dropped.
- `setOauthClientRevision(clientId, revision, revoke)`: `grant_revision = $1`, and with `revoke` also
  `deleted_at = COALESCE(deleted_at, now())` (`set_oauth_client_revision`): a second revoke keeps the first time.
- `setOauthClientReadSharedRevision(clientId, revision)`: `read_shared_revision = $2 WHERE client_id = $1`
  (`set_oauth_client_read_shared_revision`); a null revision clears the read-shared switch. Its callers are the grant
  writers (`stampReadShared`) and `invalidate-tokens`, which keeps a switched client switched at its new revision.
- `insertOauthGrantAudit(row)`: one `oauth_grant_audit` row whose documents are JSON text (`insert_oauth_grant_audit`,
  the audit key space of `client_grants.rs`). It works for a client that is gone: a `delete` writes its tombstone after the row.
- `countOauthAccessTokens(from, to)`: the number of `access` tokens whose `expires_at` is between `from` and `to` inclusive, or after
  `from` (exclusive) when `to` is null (`count_oauth_access_tokens`). A refresh token and a token with no expiry never count. The
  admin dashboard's "expiring soon" and "active tokens".
