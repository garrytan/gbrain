# The brain store: the `access_tokens` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-clients.md](oauth-clients.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

The store keeps only the `access_tokens` columns the legacy-token mint, the read-floor command and the write-attribution name read touch. The SQL for the
PGLite and PostgreSQL engines is in `src/core/engine-sql/access-tokens.ts`; the store serves the same members. Every other
reader and writer of the table (verify, list, revoke, rescope, rotate, the grant reads) is still raw SQL and stops on a Rust
brain.

| Member | Returns |
| --- | --- |
| `brain.insertAccessToken(row)` | `{ id }`, the generated UUID. `row` has `name`, `token_hash`, `scopes` (null is a full-access token), `permissions` (an object), the five grant columns (`source_grant`, `source_id`, `federated_read`, `allowed_operations`, `takes_holders`, each null for NULL) and, optionally, `min_trust`, `revoked_at` and `read_shared` (true is born with the read-shared switch on: `read_shared_revision` 1, the birth revision; absent or false leaves it off). The row is born at `grant_revision` 1 |
| `brain.findActiveAccessTokens(target)` | `[{ id, name, min_trust }]`: the tokens with no `revoked_at` whose id (as text) or name is `target`, by id. Names are not unique, so there may be several |
| `brain.readAccessTokenNames(ids)` | `[{ id, name }]` of the tokens with those ids, revoked ones included, by id; an unknown id is left out. The names `readWriteAttributionNames` shows ([write_attribution.md](write_attribution.md)) |
| `brain.setAccessTokenMinTrust(id, tier)` | null. Sets the token's read floor, or clears it with null. An id no token has changes nothing |

## Callers

`insertUnifiedToken` (`src/core/token-mint.ts`, behind `mintLegacyToken` and `gbrain auth create`) calls
`insertAccessToken`. A grant that reads a named source still checks the source and inserts in one transaction
(`assertScopeSourceGrant`, raw SQL), so that branch keeps stopping on a Rust brain. `setMinTrust` and `setTokenMinTrust`
(`src/core/trust/min-trust.ts`, behind `gbrain auth set-min-trust`, `auth create --min-trust` and `auth-mint`) call
`findActiveAccessTokens` and `setAccessTokenMinTrust`; their `migrations_pending` answer for a brain without the
`min_trust` column still comes from the undefined-column error the SQL engines raise.

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

- Not kept: `last_used_at`, the member, attest and private columns, the `private_*` checks, the `trust_generation_update`
  trigger and the secondary indexes.
- `setAccessTokenMinTrust` with an id that is not a UUID changes nothing here; Postgres refuses it (22P02). The callers
  pass the id `findActiveAccessTokens` returned.
- The error's `detail` (`Failing row contains ...`) is not produced; the message, code and constraint name are.
