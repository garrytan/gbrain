# The brain store: the `access_tokens` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-clients.md](oauth-clients.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

The store keeps every `access_tokens` column, so `listAccessTokens` (`gbrain auth list`, and the member keys of the
open-page count) returns each row as `SELECT *` does. The bearer check stamps `last_used_at`
(`touchAccessTokenLastUsed`), and `private_pages` and `private_facts` stay `'none'` (no store member changes them yet). The SQL for the PGLite
and PostgreSQL engines is in `src/core/engine-sql/access-tokens.ts`, `write-misc.ts` (the list) and `access-setup.ts`
(the member-key setup of `gbrain access serves several`); the store serves the same members. The other readers and
writers of the table (verify, revoke by name, rescope, rotate, the grant reads) are still raw SQL and stop on a Rust
brain.

| Member | Returns |
| --- | --- |
| `brain.insertAccessToken(row)` | `{ id }`, the generated UUID. `row` has `name`, `token_hash`, `scopes` (null is a full-access token), `permissions` (an object), the five grant columns (`source_grant`, `source_id`, `federated_read`, `allowed_operations`, `takes_holders`, each null for NULL) and, optionally, `min_trust`, `revoked_at` and `read_shared` (true is born with the read-shared switch on: `read_shared_revision` 1, the birth revision; absent or false leaves it off). The row is born at `grant_revision` 1 |
| `brain.findActiveAccessTokens(target)` | `[{ id, name, min_trust }]`: the tokens with no `revoked_at` whose id (as text) or name is `target`, by id. Names are not unique, so there may be several |
| `brain.setAccessTokenMinTrust(id, tier)` | null. Sets the token's read floor, or clears it with null. An id no token has changes nothing |
| `brain.listAccessTokens()` | every token, revoked ones too, newest first (a tie by id), each with every column; times as ISO text, which the TypeScript member turns into `Date`s |
| `brain.listUnboundTokenNames()` | the distinct names of the live tokens bound to no member, in byte order |
| `brain.readLiveAccessToken(name)` | `{ member_id, token_hash, source_grant, source_id, federated_read, permissions }` of the live token with this name (the oldest when several), or null; the setup compares the key file's hash to it |
| `brain.recordTokenSetupReads(name, reads)` | null. Sets `setup_reads` in the `permissions` object of each live token with this name; a token whose `permissions` is not an object is left alone |
| `brain.listKeysReadingSource(sourceId)` | `[{ name, member_id, federated_read }]` of the live member-bound `federated` keys whose write source is another source and whose read list holds `sourceId`, by name in byte order |
| `brain.readActiveAccessTokenByHash(hash)` | the whole row of the live token with this hash, or null: the bearer checks' read (`readActiveAccessTokenByHash`; `gbrain serve --http` sign-in) |
| `brain.touchAccessTokenLastUsed(id, unified)` | null. Stamps `last_used_at` with the store clock once per token per 60 seconds; with `unified`, only a row whose `source_grant` is set |
| `brain.revokeAccessToken(id)` | the name of the live token with this id it revoked, or null (`revokeAccessTokenById`) |

## Callers

`insertUnifiedToken` (`src/core/token-mint.ts`, behind `mintLegacyToken` and `gbrain auth create`) calls
`insertAccessToken`. A grant that reads a named source checks the source and inserts in one transaction
(`assertScopeSourceGrant`); on this engine the check reads each source through `getSource`, and the store write
transaction is the row lock the SQL engines take with `FOR SHARE`. `gbrain access serves several`
(`src/commands/access-serves.ts`) mints its member keys this way and reads them back through the setup members above. `setMinTrust` and `setTokenMinTrust`
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
| `private_pages` or `private_facts` outside none, granted_sources | 23514 | `access_tokens_private_pages_check`, `access_tokens_private_facts_check` |

A refused write leaves the row as it was (no row on an insert).

Keys: `m 0x2B id -> record` (the kept columns as JSON; times in microseconds). The unique token hash is checked by scanning
the table.

Differences from PGLite and PostgreSQL:

- `private_pages` and `private_facts` are kept at `'none'`, which no store member changes yet.
- The store keeps no OAuth tokens (row 32d-2), so the bearer check's OAuth read (`readOauthAccessTokenRows`) finds none
  here and the check reads the legacy token.
- Not kept: the `trust_generation_update` trigger and the secondary indexes.
- `setAccessTokenMinTrust` with an id that is not a UUID changes nothing here; Postgres refuses it (22P02). The callers
  pass the id `findActiveAccessTokens` returned.
- The error's `detail` (`Failing row contains ...`) is not produced; the message, code and constraint name are.
