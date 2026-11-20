# The brain store: spend reservations and the lease-pressure log

Part of the Minion jobs family ([jobs.md](jobs.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

Two tables of the minion queue live here. `mcp_spend_reservations` holds the hold a paid call places before it runs and what
it settled at; `minion_lease_pressure_log` holds one row per rate-lease bounce. The SQL for both engines is in
`src/core/engine-sql/jobs-spend.ts`; the store serves the same members. The call sites are `describeJobs`
(`src/core/minions/job-insight.ts`), `budget-meter.ts`, `spend-authorization.ts`, `delegated-spend.ts`,
`lease-pressure-audit.ts`, `gbrain jobs stats` and the `subagent_health` doctor check.

| Member | Returns |
| --- | --- |
| `brain.readJobSpendTree({ jobIds, owner })` | `[{ root, self, settled_cents, priced, unsettled }]` |
| `brain.insertSpendReservation(row)` | null. `row` is `{ reservation_id, client_id, budget_key, job_id, estimated_cents, model, provider, expires_at, estimate_known, usage_unknown_reason }`; the store sets `status` to `pending` |
| `brain.expireSpendReservations({ clientId, budgetKey })` | how many `pending` holds past their expiry were marked `expired`; each field given narrows the sweep |
| `brain.settleSpendReservation(id, actualCents)` | `{ outcome: 'settled', client_id, budget_key, model, provider }`, `{ outcome: 'already_settled' }` or `{ outcome: 'missing' }` |
| `brain.markSpendUsageUnknown(id, reason)` | true when a `pending` or `expired` hold took the reason |
| `brain.insertLeasePressure(row)` | null. `row` is `{ job_id, lease_key, active_at_bounce, max_concurrent, queue_name, job_name, model, provider, root_owner_id }` |
| `brain.countLeasePressure({ windowMs, jobId, leaseKey })` | the bounces that match every field given |
| `brain.listRecentLeasePressure(windowMs, limit)` | the bounces of the window, newest first (then highest id), at most `limit` |

A diagnostic reader, `Store::spend_reservation_row`, returns one reservation as `SELECT *` would; the tests use it and it is
not an engine member.

Rules each member keeps from the SQL:

- A settle turns a `pending` or `expired` hold into `settled` with the actual cents and the settle time, and clears any
  unknown-usage reason. A settled hold is left alone, so a second settle reports `already_settled`.
- The sweep marks a hold expired only while `expires_at < now` (strict) and only from `pending`; a settled hold stays settled.
- `readJobSpendTree` counts, per described job that exists, the holds of the job itself (`self: true`) and of its descendants
  to depth 20 (`self: false`). `settled_cents` sums the settled holds that carry an actual amount (null with none),
  `priced` counts them and `unsettled` counts the rest. An owner-fenced caller counts only the descendants whose
  `__owner_client_id` is the owner; the job itself always counts. A part with no hold has no row. The result is by job id,
  descendants before the job itself.
- Amounts are `NUMERIC(12,4)`: rounded half away from zero at four decimals, an amount of 10^8 or more is
  `constraint_violation`.
- An insert needs exactly one of `client_id` and `budget_key`, a job that exists when `job_id` is given, and a reservation id
  that is not taken; each failure is `constraint_violation`. An id that is not a UUID, or an `expires_at` that is not ISO
  text, is `invalid_argument`. A bounce count outside `INTEGER` is `invalid_argument`.
- `countLeasePressure` and `listRecentLeasePressure` take a window as `bounced_at > now - windowMs` (strict). A negative
  `limit` is `invalid_argument`.
- Deleting a job keeps its holds and its bounces and sets their `job_id` to NULL (`ON DELETE SET NULL`).

Keys (tag `m`, sub-tags 0x20 to 0x27): `0x27 kind owner \0 reservation_id` indexes the holds that are not settled (kept by every write of a hold; the admissions in spend-log.md sum it); `0x20 reservation_id -> record`; `0x21 job id reservation_id` (the holds of a job);
`0x22 expires_at reservation_id` (pending holds only, for the sweep); `0x24 id -> record`, `0x25 bounced_at id` and
`0x26 job id` (the bounce log, newest first and by job). Sequence: `lease_pressure`.

Differences from PGLite and PostgreSQL:

- `mcp_spend_log` and the spend columns of `oauth_clients` are in [spend-log.md](spend-log.md): the per-client and the
  capped group admission, the settle with its ledger row, the day's sum and the admin spend view.
- An amount that is NaN or infinite is `invalid_argument`; PostgreSQL's `numeric` accepts NaN.
- A refused bounce does not use up an id here; PostgreSQL spends a sequence value on an insert its foreign key refuses.
- Timestamps are ISO text across the binding; the TypeScript members turn `expires_at` into text and `bounced_at` back into a `Date`.
