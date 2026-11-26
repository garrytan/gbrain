# The brain store: the `access_tokens` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [oauth-clients.md](oauth-clients.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

The store keeps only the `access_tokens` columns the legacy-token mint, the read-floor command, the write grant read, the requester-scope read and the write-attribution name read
touch. The SQL for the PGLite and PostgreSQL engines is in `src/core/engine-sql/access-tokens.ts` (mint, floor) and
`src/core/engine-sql/access-credentials.ts` (list, grant read, liveness, revokes, the bearer check); the store serves the
same members. Only `readLiveAccessToken` (the member-key setup compares it to the key file) and doctor's
`listActiveAccessTokenRows` (the whole `SELECT *` row, cli-reads-doctor-acc.md) return a token hash; the
store never logs one. The member binding columns (`member_id`, `may_act_for`, the four attest columns and
`reads_unscoped`) are read and written by the credential binding members below. The grant edits of `gbrain auth rescope
--token` (`--sources`, `--operations`, `--takes-holders`, `--private-*`), `--attest-sources` and `--migrate-legacy` use the grant write and binding members
below, so `gbrain auth rescope --token` marks the source on a Rust brain as on PGLite and Postgres (the bare-name form still stops on raw SQL in `resolveRescopeTarget`).

| Member | Returns |
| --- | --- |
| `brain.insertAccessToken(row)` | `{ id }`, the generated UUID. `row` has `name`, `token_hash`, `scopes` (null is a full-access token), `permissions` (an object), the five grant columns (`source_grant`, `source_id`, `federated_read`, `allowed_operations`, `takes_holders`, each null for NULL) and, optionally, `min_trust`, `revoked_at`, `member_id`, `may_act_for`, `read_shared` (true is born with the read-shared switch on: `read_shared_revision` 1, the birth revision; absent or false leaves it off) and `created_at` (ISO text; left out, the store clock). The row is born at `grant_revision` 1 |

| `brain.findActiveAccessTokens(target)` | `[{ id, name, min_trust }]`: the tokens with no `revoked_at` whose id (as text) or name is `target`, by id. Names are not unique, so there may be several |
| `brain.readAccessTokenNames(ids)` | `[{ id, name }]` of the tokens with those ids, revoked ones included, by id; an unknown id is left out. The names `readWriteAttributionNames` shows ([write_attribution.md](write_attribution.md)) |
| `brain.readAccessTokenWriteGrant(id)` | `{ id, scopes, permissions, private_pages, private_facts, source_grant, source_id, federated_read, allowed_operations, takes_holders, grant_revision, revoked_at }` of the token, revoked ones included (`revoked_at` as ISO text, or null), or null for an id no token has. The grant `authorizeWrite` re-checks for a write a legacy token owns ([journal.md](journal.md)) |
| `brain.readLiveAccessTokenScope(id)` | `{ reads_unscoped, created_at }` of the token when it is not revoked (`created_at` as ISO text; `reads_unscoped` as the stored opt-out time in ISO text, or null), or null for a revoked token or an id no token has |
| `brain.setAccessTokenMinTrust(id, tier)` | null. Sets the token's read floor, or clears it with null. An id no token has changes nothing |
| `brain.listAccessTokens()` | every token, revoked ones too, newest first (`ORDER BY created_at DESC`; a tie by id): `{ id, name, scopes, created_at, last_used_at, revoked_at, private_pages, private_facts, member_id, source_grant, source_id, federated_read, grant_revision, read_shared_revision }`, the columns `gbrain auth list` prints, including the grant columns its `write: ... reads: ... (+ shared)` line needs. `last_used_at` is the stored last-use time as ISO text, or null until stamped |
| `brain.readActiveAccessTokenGrant(id)` | `{ permissions, private_pages }` of the token not revoked with this id, or null; the TypeScript member returns the field the caller asked for |
| `brain.readAccessToken(id)` | the whole row of the token with this id (a UUID, so any case), revoked or not, or null: the same columns as `readActiveAccessTokenByHash` below, without `token_hash`. It serves the legacy-token read of `readJobPrincipal` (`SELECT * FROM access_tokens WHERE id = $1`); the TypeScript member makes the three times Dates. An id that is not a UUID finds nothing, where PostgreSQL refuses it with 22P02 |
| `brain.accessTokenLive(id)` | whether a token not revoked has this id, compared as text (`id::text = $1`) |
| `brain.revokeAccessTokensNamed(name)` | the ids it revoked, by id: stamps `revoked_at` on every token not revoked with exactly this name, in one write |
| `brain.revokeAccessToken(id)` | the name of the token not revoked with this id after stamping its `revoked_at`, or null |
| `brain.readActiveAccessTokenByHash(hash)` | the whole row (`SELECT *`) of the token not revoked with this hash, or null: the kept columns, `created_at` as ISO text, and `last_used_at` as ISO text (null until a check stamps it). It leaves out `token_hash`; the TypeScript member adds back the hash the caller passed and makes `created_at` a Date, as PGLite and PostgreSQL return them. A record that does not parse is skipped, so one damaged record does not refuse every sign-in, unless it could be the token asked for. That is a JSON record whose `token_hash` is this hash, or a record that is not JSON at all and whose bytes hold this hash, and then the read fails closed. The skip is silent (no log or counter) |
| `brain.listUnboundTokenNames()` | the distinct names of the tokens not revoked and bound to no member, in byte order (`SELECT DISTINCT name COLLATE "C" ... ORDER BY name`) |
| `brain.readLiveAccessToken(name)` | `{ member_id, token_hash, source_grant, source_id, federated_read, permissions }` of the token not revoked with exactly this name, or null. When several share the name, the oldest (then the lowest id) answers |
| `brain.recordTokenSetupReads(name, reads)` | null. Sets `setup_reads` to `reads` in the `permissions` object of every token not revoked with this name, keeping the other fields, in one write; a token whose `permissions` is not an object is left alone |
| `brain.listKeysReadingSource(sourceId)` | `[{ name, member_id, federated_read }]` of the tokens not revoked, bound to a member, on the `federated` grant, written to another source and reading `sourceId`, by name in byte order |
| `brain.lockActiveAccessTokens(id, name)` | the whole rows, without `token_hash`, of the tokens not revoked whose id (a UUID, so any case) is `id`, or whose name is exactly `name`, oldest first (a tie by id). Exactly one of the two is given; both or neither is `invalid_argument`. It serves `lockActiveAccessTokens({ id } \| { name })`, the read `gbrain auth rescope` runs before it writes (`SELECT * ... FOR UPDATE`); the store runs one write transaction at a time, so the lock holds nothing off. The TypeScript member refuses a non-UUID id as PostgreSQL does (22P02) and makes the times Dates |
| `brain.writeAccessTokenGrant(id, columns, scopes, permissions)` | the new `grant_revision`, or null when no token has this id (a UUID, so any case). It serves `writeAccessTokenGrant(id, { columns, scopes, permissions })`, the grant write of `gbrain auth rescope --token`: the five grant columns, the scopes when given (null keeps them), the `permissions` mirror and one more revision, in one write. Like the statement, it has no revoked filter |
| `brain.writeAccessTokenPrivateGrant(id, axis, value)` | null. Sets `private_pages` or `private_facts` (`axis`) of the token with this id to `value` (`none` or `granted_sources`); an id no token has changes nothing. Another axis is `invalid_argument` |
| `brain.setAccessTokenReadSharedRevision(id, revision)` | null. Sets `read_shared_revision` of the token with this id (a UUID, so any case) to `revision`, or clears it with null (the read-shared switch, GST-2898); an id no token has changes nothing. `gbrain auth rescope` re-stamps a switched token at its new grant revision. The whole rows `lockActiveAccessTokens` and `readActiveAccessTokenByHash` return carry `read_shared_revision`, as `SELECT *` does |
| `brain.lockLegacyAccessTokens()` | the whole rows, without `token_hash`, of the tokens not revoked and with no `source_grant`, oldest first (a tie by id). It serves `lockLegacyAccessTokens()`, the read `gbrain auth rescope --migrate-legacy` runs before it converts each token (`SELECT * ... FOR UPDATE`); the TypeScript member makes the times Dates |
| `brain.readLiveAccessTokenRows()` | the same row shape (`last_used_at` and the binding columns as stored) for every token not revoked, by id, without `token_hash` (the grant checks that read every credential's source grant use no hash) |
| `brain.listAccessTokenRows()` | the same row shape for every token, revoked ones too, newest first (`ORDER BY created_at DESC, id`): the admin key list (`GET /admin/api/api-keys`) |

## Callers

`insertUnifiedToken` (`src/core/token-mint.ts`, behind `mintLegacyToken` and `gbrain auth create`) calls
`insertAccessToken`. A grant that reads a named source checks the source and inserts in one transaction
(`assertScopeSourceGrant`, through `readScopeSourceConfigs`). `setMinTrust` and `setTokenMinTrust`
(`src/core/trust/min-trust.ts`, behind `gbrain auth set-min-trust`, `auth create --min-trust` and `auth-mint`) call
`findActiveAccessTokens` and `setAccessTokenMinTrust`; their `migrations_pending` answer for a brain without the
`min_trust` column still comes from the undefined-column error the SQL engines raise. `gbrain auth list` (`src/commands/auth.ts`) calls `listAccessTokens`; `auth revoke` and
`auth revoke --id` (and `revokeLegacyTokenById` in `token-mint.ts`) call the two revokes, then `forgetWakePrincipal` ends
the token's wake watches. `readActiveTokenPrivatePages` and `readActiveTokenPermissions` (`token-mint.ts`) call
`readActiveAccessTokenGrant`, and the Wakeshift drain's `principalLive` (`src/core/wakeshift/drain.ts`) calls
`accessTokenLive`. The bearer check `serve --http` runs (`verifyAccessToken` in `src/core/oauth-provider.ts`, given the
engine by `src/commands/serve-http.ts`) and `validateToken` in `src/mcp/http-transport.ts` call
`readActiveAccessTokenByHash` and `touchAccessTokenLastUsed`; the OAuth token read before it
(`readOauthAccessTokenRows`) reads the OAuth tokens the store keeps ([oauth-tokens.md](oauth-tokens.md)), and
`touchAccessTokenLastUsed` stamps `last_used_at` (below). The remote job principal check
(`assertCurrentRemoteJobPrincipal` in `src/core/minions/submission-authority.ts`) reads a legacy token through
`readJobPrincipal`, which calls `readAccessToken`. `rescopeInTransaction` (`src/core/grants/legacy-token.ts`, behind
`gbrain auth rescope --token`) calls `lockActiveAccessTokens` and the grant-write members. For binding flags,
`runRescope` (`src/commands/auth.ts`) awaits `rescopeLegacyToken`, then separately calls `bindCredential` for `--member`
and `--attest-*`. The active-source check uses `filterUnarchivedSourceIds`; the scope-source check reads the token's own
`attest_sources` through `readCredentialBindingForUpdate`. `migrateLegacyTokens` (`auth rescope --migrate-legacy`) calls `lockLegacyAccessTokens`.

## Member binding

The members of `src/core/engine-sql/access-members.ts`, `access-control.ts` and `persistence-journal.ts` that read and
write a token's binding are served from these records (gbrain-store `jobs::credential_binding`; the client half is in
[oauth-clients.md](oauth-clients.md)):

| Member | Store call |
| --- | --- |
| `insertAccessMember({ bindTokenId })` | binds the token whose id text is exactly `bindTokenId` in the member's write; no token has it: nothing is bound ([access-members.md](access-members.md)) |
| `readCredentialBindingForUpdate(target, { readsUnscoped })` | `brain.readCredentialBinding(kind, id, readsUnscoped)`: `{ member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read }`, with `reads_unscoped` when asked; undefined for no row |
| `writeCredentialBinding(target, binding)` | `brain.writeCredentialBinding`: the six columns in one write; no row: nothing changes |
| `writeCredentialReadsUnscoped(target, on)` | `brain.writeCredentialReadsUnscoped`: the transaction's time, or NULL |
| `readLiveMember('legacy_token', id)`, `readMayActFor('legacy_token', id)` | `brain.readLiveCredential`: the member and may_act_for of the token not revoked whose id text is exactly `id`, or null |
| `readAccessTokenAttest(id)`, `readOauthClientAttest(clientId, { lock? })` | `brain.readCredentialAttest(kind, id)`: the attest columns and `member_id` of the token whose id text is exactly `id` with its `revoked_at`, or of the client with its `client_id`, `deleted_at`, `grant_types` and `confidential` (a secret hash is stored); a revoked token and a deleted client are read too, and `null` for no row | `attestRightOf` (access/actor.ts) reads a stored principal's right with them and leaves out a revoked or deleted row itself. The lock has nothing to wait for: the store runs one write at a time. |
| `readAccessCredentials({ tokenName })`, `readAccessCredentials({ memberId })` | `brain.readAccessCredentials`: the active tokens with that name, oldest first (a tie by id); or the active tokens bound to the member by name in byte order (a tie by id), then the live clients by client id in byte order. The SQL sorts with `COLLATE "C"` and the same tie-break, so an `en_US` Postgres gives the same order |
| `listOwnerCredentialRows(memberId)` | `brain.listOwnerCredentialRows`: `[{ kind, id, name, row }]`, the tokens not revoked and the clients not deleted bound to the member, a token's row its grant columns and `min_trust` (as `jsonb_build_object` builds them), a client's row the whole row less `client_secret_hash` (as `to_jsonb(c) - 'client_secret_hash'` prints it), by kind, name and id in byte order (`COLLATE "C"` in the SQL) |
| `readAccessTokenWriteGrant(id)` | `brain.readAccessTokenWriteGrant`: the grant columns and `revoked_at` of the token with this id, revoked or not, or null; the write re-check refuses a revoked token with PGLite's text ([journal.md](journal.md)) |

`assertScopeSourceGrant` reads marked source configs through `readScopeSourceConfigs` and a token's own `attest_sources`
through `readCredentialBindingForUpdate`; both reads are served on Rust.

`authorizeWrite` (`src/core/persistence/authority.ts`) calls `readAccessTokenWriteGrant` when it re-checks a write a legacy
token owns. It rejects a missing or revoked token and checks the current grant; the grant read itself is served on Rust.
`credentialScopeFor` (`src/core/access/requester-scope.ts`) calls `readLiveAccessTokenScope` for an agent job's legacy token,
so the requester-scope gate compares its real creation time with the time the brain began to serve several people.

## Constraints

A write that breaks one is `constraint_violation` in the store, with the Postgres message. The TypeScript store member
(`src/core/rust-engine/store-members/jobs-access-tokens.ts`, through `constraint-errors.ts`) gives the error the SQLSTATE
and constraint name a caller reads on PGLite and PostgreSQL.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| a token hash already taken | 23505 | `access_tokens_token_hash_key` |
| `source_grant` outside default, scalar, federated, none | 23514 | `access_tokens_source_grant_check` |
| `min_trust` outside the six tiers | 23514 | `access_tokens_min_trust_check` |
| `private_facts` outside none, granted_sources | 23514 | `access_tokens_private_facts_check` |
| `private_pages` outside none, granted_sources | 23514 | `access_tokens_private_pages_check` |

A refused write leaves the row as it was (no row on an insert).

`brain.touchAccessTokenLastUsed(id, unified)` stamps `last_used_at` with the store clock, at most once a minute: it skips a
token stamped in the last 60 seconds, a token that is not there, and (when `unified` is true) a token with no `source_grant`,
which is the legacy-shape row `resolveTokenGrant` converts first. With `unified` false it stamps any row. The id is
compared lower-cased. It reads first and opens a write only when a stamp is due, and the write checks again. A caller does
not wait for it (`touchTokenLastUsed` ignores the result).

`brain.convertLegacyAccessTokenGrant(id, columns)` is the first-read conversion `resolveTokenGrant`
(`src/core/grants/legacy-token.ts`, given the engine by both bearer checks and `gbrain access`) runs on a token with no
`source_grant`: it writes the five grant columns (`source_grant`, `source_id`, `federated_read`, `allowed_operations`,
`takes_holders`, arrays as arrays), one more `grant_revision` and `last_used_at` at the store clock, in one write, and
returns the whole row without the hash. It returns null for an id no token has and for a token that already has a
`source_grant`, so a second conversion changes nothing. Like the statement, it has no revoked filter. A `source_grant`
outside the list is `constraint_violation` and the row is unchanged. The id is compared lower-cased.

Keys: `m 0x2B id -> record` (the kept columns as JSON; times in microseconds). The unique token hash is checked by scanning
the table.

Differences from PGLite and PostgreSQL:

- A record written before the store kept `private_pages` and `private_facts` reads `none` for both, the column default.
- Not kept: the `trust_generation_update` trigger and the secondary indexes.
- `lockActiveAccessTokens` and `lockLegacyAccessTokens` take no row lock: the store runs one write transaction at a time.
- `setAccessTokenMinTrust` with an id that is not a UUID changes nothing here; Postgres refuses it (22P02). The callers
  pass the id `findActiveAccessTokens` returned.
- The error's `detail` (`Failing row contains ...`) is not produced; the message, code and constraint name are.
