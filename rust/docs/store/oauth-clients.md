# The brain store: the `oauth_clients` row

Part of the Minion jobs family ([jobs.md](jobs.md), next to [spend-log.md](spend-log.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

The store keeps a client as its whole row: the 41 columns the table has after every migration, in the table's own order.
The SQL for the PGLite and PostgreSQL engines is in `src/core/engine-sql/oauth-clients.ts` (`insertOauthClient`,
`readOauthClient`) and `src/core/engine-sql/spend-log.ts` (`updateOauthClientBudget`, `readClientBudgetUsd`); the store
serves the same members, and the spend ledger reads the same record ([spend-log.md](spend-log.md)).

| Member | Returns |
| --- | --- |
| `brain.insertOauthClient(row)` | null. `row` is any of the table's columns; `client_id` and `client_name` are required. A column left out takes the table's default |
| `brain.readOauthClient(clientId)` | the row as `SELECT * FROM oauth_clients WHERE client_id = $1` returns it, or null |
| `brain.readOauthClientNames(ids)` | `[{ id, name }]` (`client_id`, `client_name`) of the clients with those ids, by id; an unknown id is left out. The names `readWriteAttributionNames` shows ([write_attribution.md](write_attribution.md)) |
| `brain.listOauthClients()` | every client's whole row, as `SELECT * FROM oauth_clients ORDER BY client_name COLLATE "C", client_id COLLATE "C"` returns them (byte order on every engine; the store sorts the bytes of the name, then of the id) |
| `listAdminClientRows()` | served from `brain.listOauthClients()`: every client, deleted ones included, as its inspection columns, newest `created_at` first (the stored text, so microseconds break a tie inside one millisecond), then client id in byte order, as `ORDER BY created_at DESC, client_id COLLATE "C"` |
| `brain.listSourceOAuthClients(sourceId)` | `{ client_id, client_name, deleted }[]`, the clients whose `source_id` is the source, revoked ones included (`deleted` when `deleted_at` is set), by client id in byte order on every engine (`client_id COLLATE "C"`) |
| `brain.patchOauthClient(clientId, patch, guard)` | `{ row, before }` or null. `patch.set` names the columns to set (`client_secret_hash`, `token_ttl`, `min_trust`, `surface`, `surface_set_by`) and the field of that name is the value, absent meaning NULL; `row` is the whole row after (checked again), `before` the five columns before. Null when the client is missing or the guard excludes it: `live` skips a deleted client, `unless_surface_set_by` skips a client with that pin (a NULL pin is not equal to it), `client_secret_hash_is` skips a client whose secret hash is not that value (compare-and-set, so of two callers that read the same hash exactly one writes). The write is one store write, so on this store it is the lock |
| `brain.updateOauthClientBudget(clientId, usd)` | whether the client exists; `usd` null clears the cap. The rewritten row is checked again |
| `brain.deleteOauthClient(clientId)` | `{ client_id, client_name }` of the row it removed in one write, or null (the engine member is `deleteOAuthClient`). It also removes the client's authorization codes ([oauth-codes.md](oauth-codes.md)) and its OAuth tokens in the same write ([oauth-tokens.md](oauth-tokens.md)), as the foreign key does on PostgreSQL |
| `brain.oauthClientLive(clientId)` | whether a client not deleted (`deleted_at IS NULL`) has this id |
| `brain.listUnboundClientIds()` | the ids of the clients not deleted and bound to no member (`member_id` NULL), in byte order (`ORDER BY client_id COLLATE "C"`); `gbrain access serves --owner` offers to bind each |
| `brain.setOauthClientTokenTtl(clientId, ttl)` | whether the client exists after setting its `token_ttl`; the row is checked again |

TypeScript-only members (`src/core/rust-engine/store-members/jobs-oauth-clients.ts`): `readOauthClientColumns(probe)`
names every column of the probe (the store keeps every column); `insertOauthClientGrant(row)` writes the client row through
`insertOauthClient` and the register audit row in one write (`brain.insertOauthClientGrant(row, audit)`);
`readTokenLifetimeClampedClients()` is `[]` (the store runs no migrations, so none clamped a client).

Grant members (`src/jobs/client_grants.rs`, NAPI `families/jobs/grants.rs`; the grant audit is `oauth_grant_audit`):

| Member | What it does |
| --- | --- |
| `brain.persistOauthClientGrant(grant)` | one write: the client row's grant columns (every constraint above applies), the `__delegation_grant` of this client's open subagent jobs that have none, the audit row, and the private-pages and private-facts follow-ups. False, writing nothing, for no client or a revision other than the expected one |
| `brain.listOauthGrantAudit(clientId)` | the client's audit rows by id, with the documents in `jsonb` key order |
| `brain.readLatestCatalogProvenanceAudit(clientId)` | the newest audit row's `after_grant` that has a `catalogProvenance` key (a JSON null counts as present) |
| `brain.readLiveOauthClients()` | every client not deleted, by id |
| `brain.readSourceGrantState(id)` / `brain.replaceSourceConfig(id, config)` | a source's `{archived, config}` and a whole-config replace (the engine members `readSourceAttestState` and `replaceSourceConfig` are these two, for the `--attest-sources` check and mark) |
| `brain.oauthClientHoldsAuthorization(clientId)` | whether the client holds an OAuth token or an authorization code, expired ones included (first consent's check, the `EXISTS` pair of `CLIENT_GRANT_SQL.holds_authorization`) |

The member binding of a client (`member_id`, `may_act_for`, the four attest columns and `reads_unscoped`, columns of the
whole row) is read and written by the credential binding members (gbrain-store `jobs::credential_binding`), as for a
token ([access-tokens.md](access-tokens.md) "Member binding"): `readCredentialBindingForUpdate` also returns
`grant_types` and `confidential` (a secret hash is stored); `readLiveMember('oauth_client', id)` and
`readMayActFor('oauth_client', id)` read the client not deleted with this id; `readAccessCredentials({ memberId })`
lists the live clients bound to the member after its tokens. Every write goes through `put_client`, so the row is
checked again. `readOAuthClientWriteGrant(clientId)` (`brain.readOauthClientWriteGrant`) returns the columns the write
re-check reads and `deleted_at`, deleted or not, or null ([journal.md](journal.md)).

Defaults when a column is left out: `grant_types` `{client_credentials}` (an explicit null stays null), `federated_read`
and `grant_repair_reasons` `{}`, `bound_max_concurrent` 1, `delegated_namespace` `prefixes`, `grant_revision` 0,
`private_pages` and `private_facts` `none`, `created_at` the store clock, every other column null. `created_at`,
`deleted_at` and `reads_unscoped` come back as `Date` on the TypeScript side and travel as ISO text.

## Callers

`readOauthClient` serves the by-client-id reads of `access.ts` (`access check --client`), `harness/client-setup.ts`,
`agent-register.ts` (reissue), `minions/submission-authority.ts` (two reads), `shared-skills/policy.ts`,
`access/requester-scope.ts`, `persistence/effect-facts.ts`, `persistence/authority.ts` (the takes-holders read),
`persistence/page-visibility.ts` (`defaultSourceMemberWriter`, the client's `member_id`) and the Rust store member
`readOAuthClientWriteGrant` (the grant `authorizeWrite` re-checks, [journal.md](journal.md)).
`listOauthClients` serves `listClientRows` (`commands/auth-client-rows.ts`, behind `gbrain auth clients`), which picks the
columns it shows out of each row, and the duplicate-name check of `src/commands/agent-register.ts`, which filters the rows by
`client_name` and `deleted_at`; a brain from before a column returns rows without it, so the old six-step projection
ladder is gone and the surface and source columns read as null there, as before. The listing's order is now byte order
(`COLLATE "C"`) where it followed the database's collation on PostgreSQL. `readOauthClient` also
returns every column, so a caller that named columns checks the ones it needs with `requireOauthClientColumns`, which
raises the undefined-column error (42703) a SELECT of a missing column raises. `patchOauthClient` serves the writers
`min-trust.ts` (`setMinTrust`), `request-tools.ts` (the surface persist) and `agent-register.ts` (`rotateClientSecret`).
`rotateClientSecret` names the hash it read in `client_secret_hash_is`, so it needs no advisory lock (rotation changes no
name) and two concurrent reissues end with one winner and one `reissue_conflict` on every engine. `setMinTrust` on a
token target goes through the `access_tokens` members ([access-tokens.md](access-tokens.md)). A function that also runs a
raw statement keeps refusing on a Rust brain at that statement. `gbrain auth register-client` registers through `planManualClient` (`oauth-provider.ts`) and
`insertOauthClientGrant` when the engine has every grant column (`registerScopedClient` in `src/commands/auth.ts`), then
`setOauthClientTokenTtl`; a grant that reads a named source runs `assertScopeSourceGrant` through the engine's typed
`readScopeSourceConfigs`, so that check is served on Rust. `auth revoke-client` calls `deleteOAuthClient`, and the Wakeshift drain calls `oauthClientLive`.

## Constraints

A write that breaks one is `constraint_violation` in the store, with the Postgres message. The TypeScript store member
(`src/core/rust-engine/store-members/jobs-oauth-clients.ts`) gives the error the SQLSTATE and constraint name a caller
reads on PGLite and PostgreSQL: `code` and `constraint` / `constraint_name` / `table` / `table_name`.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| an `agent` scope word without a complete grant | 23514 | `oauth_clients_complete_agent_grant` |
| `min_trust`, `private_pages`, `private_facts`, `registered_via`, `source_grant` outside their lists | 23514 | `oauth_clients_min_trust_check`, `oauth_clients_private_pages_check`, `oauth_clients_private_facts_check`, `oauth_clients_registered_via_check`, `oauth_clients_source_grant_check` |
| a client id already taken | 23505 | `oauth_clients_pkey` |
| a `source_id` the store has no source for | 23503 | `oauth_clients_source_id_fkey` |

A complete agent grant (src/core/grants/schema.ts, `GRANT_CONSTRAINTS_SQL`) has bound tools (not null, not empty), a
`source_id` that equals `bound_source_id` and is in `federated_read`, a delegated namespace that fits its slug prefixes
(`job` with none, `prefixes` with at least one) and `bound_max_concurrent` above 0. The scope word is matched as
Postgres matches `(^|[[:space:]])agent([[:space:]]|$)`: a space, tab, newline, vertical tab, form feed or carriage
return around it, or any other character in PGLite's `[[:space:]]` (U+0085, U+2000 to U+2006, U+2008 to U+200A, U+2028,
U+2029, U+205F and U+3000, but not U+00A0), so `read<U+3000>agent` holds the word. A refused write leaves no row.

Keys: `m 0x2A client_id -> record` (the whole row as JSON; times in microseconds, the cap in hundredths of a dollar);
`m 0x2E id -> audit row` (the sequence `oauth_grant_audit`).

Differences from PGLite and PostgreSQL:

- The error's `detail` (`Failing row contains ...`) is not produced; the message, code and constraint name are.
- Not kept: the `trust_generation_update` trigger and the two secondary indexes (`idx_oauth_clients_source_id`,
  `idx_oauth_clients_federated_read`). The `ON DELETE RESTRICT` of `source_id` and the `ON DELETE SET NULL` of
  `bound_source_id` are kept by the store's source delete ([sources.md](sources.md)); the TypeScript member maps the
  refusal to SQLSTATE 23503 with `oauth_clients_source_id_fkey`.
- The audit table has no foreign key to the client: a client's audit rows stay when the client is deleted, as on SQL.
- Not kept: the `trust_generation_update` trigger, the two secondary indexes (`idx_oauth_clients_source_id`,
  `idx_oauth_clients_federated_read`) and the `ON DELETE RESTRICT` of `sources` (the foreign key is checked on a client write
  only, so removing a source a client names is not refused here).
