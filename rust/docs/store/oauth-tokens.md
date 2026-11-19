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
| `brain.deleteExpiredOauthTokens(now)` | how many tokens of any type it deleted: those whose `expires_at` is before `now` (epoch seconds). A NULL `expires_at` stays. One write |

`current_grant` is the client row as JSON (`to_jsonb`), without `client_secret_hash`; `budget_usd_per_day` is a JSON number
and times are `+00:00` text, as PostgreSQL gives them in a UTC session. `source_active` is whether the client's source
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
insert through `insertOauthToken`. `OAuthGrants.issue` (`src/core/oauth-grants.ts`) still writes the token with the same
statement text through the grant transaction's SqlQuery: it runs under the client row's `FOR UPDATE` lock, and an engine
write on another pooled connection would wait for that lock on the foreign key and deadlock on PostgreSQL. The sweep of
expired credentials calls `deleteExpiredOauthTokens`.

Differences from PGLite and PostgreSQL:

- Not kept: the secondary indexes, and the `oauth_codes` table.
- An expired row stays until the sweep runs or its client is deleted; the bearer check refuses it either way.
- `active_read_sources` is sorted by id; PostgreSQL's order is unspecified.
- The `current_grant` timestamp text assumes a UTC session.
- Still raw SQL, so a Rust brain refuses them: `revokeToken` and `revokeClient` in `oauth-grants.ts`, `grants/lifecycle.ts`,
  `grants/service.ts`, and the two counts in `serve-http-admin-api.ts`.
