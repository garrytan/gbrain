# The brain store: the spend ledger and the client budgets

Part of the Minion jobs family ([jobs.md](jobs.md), next to [jobs-spend.md](jobs-spend.md)); the rules in
[rust/README.md](../../README.md) ("The brain store") apply.

`mcp_spend_log` is the ledger: one row per settled or recorded paid call. The spend columns of `oauth_clients` hold a
client's daily cap and say whether it is an agent client. The SQL for both engines is in `src/core/engine-sql/spend-log.ts`;
the store serves the same members. The call sites are `budget-meter.ts` (`reserve`, `reserveGroup`, `readGroupSpend`,
`settle`, `getClientDailyCapCents`), `src/core/spend-log.ts` (`getTodaySpendCents`, `recordSpend`) and the admin spend view
(`queryAgentClientSpend` in `src/commands/serve-http-admin-api.ts`).

| Member | Returns |
| --- | --- |
| `brain.reserveClientSpend(spec)` | `{ outcome: 'reserved' }`, `{ outcome: 'refused', committed_cents, pending_cents, cap_cents }`, `{ outcome: 'invalid_cap', cap_cents }` or `{ outcome: 'invalid_total', label }` |
| `brain.reserveGroupSpend(spec)` | `{ outcome: 'reserved', estimated_cents }`, `{ outcome: 'refused', kind: 'exhausted' or 'pressure', committed_cents, overdue_cents, live_cents }` or `{ outcome: 'invalid_total', label }` |
| `brain.readGroupSpendTotals(key)` | `{ committed_cents, overdue_cents, live_cents }` |
| `brain.settleSpendWithLog(id, actualCents, operation, tokenName)` | `{ outcome: 'settled' }`, `{ outcome: 'already_settled' }` or `{ outcome: 'missing' }` |
| `brain.insertSpendLog(row)` | null. `row` is `{ client_id, token_name, operation, spend_cents, provider, model }` |
| `brain.sumClientSpendSince(clientId, since)` | the client's ledger sum from `since` on, in cents (0 with no row) |
| `brain.insertOauthClient(row)` | null. `row` is any of the table's columns; `client_id` and `client_name` are required (see [oauth-clients.md](oauth-clients.md)) |
| `brain.updateOauthClientBudget(clientId, usd)` | whether the client exists; `usd` null clears the cap |
| `brain.readClientBudgetUsd(clientId)` | the cap as Postgres prints it (`"5.00"`), null for no cap or no such client |
| `brain.readAgentClientSpend()` | `[{ client_id, client_name, cap_usd_per_day, spent_cents_today, pending_cents, unknown_count, inflight_count }]` |

Two diagnostic readers, `Store::spend_log_rows` and `Store::spend_reservation_row`, return rows as `SELECT *` would; the
tests use them and they are not engine members. The ledger's `operation`, `token_name`, `provider` and `model` columns are
visible only through them, so `tests/spend_log.rs` covers those and the parity file does not.

Rules each member keeps from the SQL:

- A client admission is one write: the client's configured cap (`budget_usd_per_day` in cents, rounded), the cap as the
  lower of the caller's and the configured one, the sweep of that client's overdue holds, the day's ledger sum from
  `day_start`, the open holds (`pending` and `expired`, across days) and the insert. A cap that is not finite or is negative
  is `invalid_cap`, reported before the sweep. A cap refuses when the estimate is unknown, when an open hold of unknown
  usage exists, or when committed + pending + estimated is over it. No cap admits everything.
- A group admission sweeps that key's holds, then (only with a cap) takes `remaining = cap - committed - overdue` over the
  key's whole ledger. No room is `exhausted` (a free, known estimate is still admitted at exactly zero). The estimate is
  bounded by `remaining`. Live holds that leave no room for it are `pressure`.
- A settle moves the hold to `settled` and appends the ledger row (client or budget key, token name, operation, the
  actual amount, the hold's provider and model) in the same write; a second settle writes nothing.
- Amounts are `NUMERIC(12,4)` on the ledger, rounded half away from zero at four decimals (10^8 or more is
  `constraint_violation`). A budget is `NUMERIC(10,2)` dollars: rounded half away from zero at two decimals on the shortest
  decimal text of the number, 10^8 or more is `constraint_violation`.
- The agent view lists live clients whose `scope` has the token `agent` (split on spaces) or whose `bound_tools` is not
  null, with the UTC day's ledger sum, the open holds, the unknown ones and the open `subagent` jobs the client owns.
- `insertOauthClient` with a client id already taken is `constraint_violation`. The row and its constraints are in
  [oauth-clients.md](oauth-clients.md).

Keys (tag `m`): `0x28 id -> record` (the ledger; sequence `mcp_spend_log`), `0x29 kind owner \0 created_at id -> amount` (the
ledger by owner in time order: `kind` is `c` for a client, `b` for a budget key; a day's sum is a reverse scan that stops
at the day), `0x2A client_id -> record` (the client, every column). jobs-spend.md's `0x27 kind owner \0 reservation_id` is the index of
open holds that the admissions sum, kept by every write of a hold.

Differences from PGLite and PostgreSQL:

- Atomicity: a member is one store write. A refusal is an outcome, not an error, so the sweep it ran stays unless the
  caller throws inside `engine.transaction`, which `budget-meter.ts` does; on PGLite and PostgreSQL the same throw rolls
  the sweep back, and now so it does here. An error (a job that does not exist, an amount that overflows) leaves nothing.
- No advisory lock: the store has one writer at a time, so two admissions cannot both see the same headroom.
- The open-hold index (`0x27`) is kept from the build that adds it. A hold written by an older build is not in it and is
  not counted by an admission until it settles; there is no backfill.
- The agent view sorts by client name bytewise, then client id; PostgreSQL sorts names by the database collation (the id
  tiebreak is added on both).
- The store keeps the whole `oauth_clients` row and enforces its constraints, `oauth_clients_complete_agent_grant`
  among them ([oauth-clients.md](oauth-clients.md)). The agent view qualifies a client by the `agent` scope token or by
  `bound_tools`; a client with the token always has tools, as the constraint requires.
- A delegated reservation (`validateAdmission` in `delegated-spend.ts`) reads the client's grant with `readOauthClient`
  and the active sources with `listAllSources`, so it is admitted or denied on a Rust brain as on PGLite
  (`test/engine-parity/delegated-grant.test.ts`). The archived-source denial is not exercised on Rust: no served member
  archives a source.

The OAuth client, token and code contracts are documented in [oauth-clients.md](oauth-clients.md),
[oauth-tokens.md](oauth-tokens.md) and [oauth-codes.md](oauth-codes.md). Engine-backed OAuth client grant persistence uses
`persistOauthClientGrant`, and client/token read-shared stamps use `setOauthClientReadSharedRevision` and
`setAccessTokenReadSharedRevision`. Engine-backed scope-source checks use `readScopeSourceConfigs`. Callers that still
issue raw SQL refuse on Rust at that statement. The existing `lockOAuthClient` on a Rust brain resolves without locking:
the store admits one write transaction at a time.
