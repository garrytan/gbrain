# The brain store: the `access_tokens` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-clients.md](oauth-clients.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

The store keeps only the `access_tokens` columns the legacy-token mint, the read-floor command, the list and the revokes
touch. The SQL for the PGLite and PostgreSQL engines is in `src/core/engine-sql/access-tokens.ts` (mint, floor) and
`src/core/engine-sql/access-credentials.ts` (list, grant read, liveness, revokes); the store serves the same members. No
member returns a token hash, and the store never logs one. The other readers and writers of the table (the MCP bearer check
in `src/mcp/http-transport.ts`, rescope, rotate, the OAuth provider's token reads) are still raw SQL and stop on a Rust
brain.

| Member | Returns |
| --- | --- |
| `brain.insertAccessToken(row)` | `{ id }`, the generated UUID. `row` has `name`, `token_hash`, `scopes` (null is a full-access token), `permissions` (an object), the five grant columns (`source_grant`, `source_id`, `federated_read`, `allowed_operations`, `takes_holders`, each null for NULL) and, optionally, `min_trust` and `revoked_at`. The row is born at `grant_revision` 1 |
| `brain.findActiveAccessTokens(target)` | `[{ id, name, min_trust }]`: the tokens with no `revoked_at` whose id (as text) or name is `target`, by id. Names are not unique, so there may be several |
| `brain.setAccessTokenMinTrust(id, tier)` | null. Sets the token's read floor, or clears it with null. An id no token has changes nothing |
| `brain.listAccessTokens()` | every token, revoked ones too, newest first (`ORDER BY created_at DESC`; a tie by id): `{ id, name, scopes, created_at, last_used_at, revoked_at }` plus the grant columns `gbrain auth list` prints. `last_used_at` is always null (not kept) |
| `brain.readActiveAccessTokenGrant(id)` | `{ permissions, private_pages }` of the token not revoked with this id, or null. `private_pages` is not kept, so it reads as the column default `none`; the TypeScript member returns the field the caller asked for |
| `brain.accessTokenLive(id)` | whether a token not revoked has this id, compared as text (`id::text = $1`) |
| `brain.revokeAccessTokensNamed(name)` | the ids it revoked, by id: stamps `revoked_at` on every token not revoked with exactly this name, in one write |
| `brain.revokeAccessToken(id)` | the name of the token not revoked with this id after stamping its `revoked_at`, or null |

## Callers

`insertUnifiedToken` (`src/core/token-mint.ts`, behind `mintLegacyToken` and `gbrain auth create`) calls
`insertAccessToken`. A grant that reads a named source still checks the source and inserts in one transaction
(`assertScopeSourceGrant`, raw SQL), so that branch keeps stopping on a Rust brain. `setMinTrust` and `setTokenMinTrust`
(`src/core/trust/min-trust.ts`, behind `gbrain auth set-min-trust`, `auth create --min-trust` and `auth-mint`) call
`findActiveAccessTokens` and `setAccessTokenMinTrust`; their `migrations_pending` answer for a brain without the
`min_trust` column still comes from the undefined-column error the SQL engines raise. `gbrain auth list` (`src/commands/auth.ts`) calls `listAccessTokens`; `auth revoke` and
`auth revoke --id` (and `revokeLegacyTokenById` in `token-mint.ts`) call the two revokes, then `forgetWakePrincipal` ends
the token's wake watches. `readActiveTokenPrivatePages` and `readActiveTokenPermissions` (`token-mint.ts`) call
`readActiveAccessTokenGrant`, and the Wakeshift drain's `principalLive` (`src/core/wakeshift/drain.ts`) calls
`accessTokenLive`.

## Constraints

A write that breaks one is `constraint_violation` in the store, with the Postgres message. The TypeScript store member
(`src/core/rust-engine/store-members/jobs-access-tokens.ts`, through `constraint-errors.ts`) gives the error the SQLSTATE
and constraint name a caller reads on PGLite and PostgreSQL.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| a token hash already taken | 23505 | `access_tokens_token_hash_key` |
| `source_grant` outside default, scalar, federated, none | 23514 | `access_tokens_source_grant_check` |
| `min_trust` outside the six tiers | 23514 | `access_tokens_min_trust_check` |

A refused write leaves the row as it was (no row on an insert).

Keys: `m 0x2B id -> record` (the kept columns as JSON; times in microseconds). The unique token hash is checked by scanning
the table.

Differences from PGLite and PostgreSQL:

- `private_pages` reads as `none` for every token: a token minted with private pages loses that grant here.
- Not kept: `last_used_at`, the member, attest and private columns, the `private_*` checks, the `trust_generation_update`
  trigger and the secondary indexes.
- `setAccessTokenMinTrust` with an id that is not a UUID changes nothing here; Postgres refuses it (22P02). The callers
  pass the id `findActiveAccessTokens` returned.
- The error's `detail` (`Failing row contains ...`) is not produced; the message, code and constraint name are.
