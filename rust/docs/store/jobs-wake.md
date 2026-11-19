# The brain store: the Wakeshift report-back tables

Part of the store contract in [rust/README.md](../../README.md) and of the jobs family ([jobs.md](jobs.md)): the rules
there apply to every method here.

When Wakeshift reporting is on, an agent asks to be woken when a job, a write request or a cron run finishes, and the
brain delivers that wake from a background drainer. Five tables hold the state: `wake_subscriptions` (the watches),
`wake_crons` and `wake_cron_runs` (the cron names an owner registers and the runs they report), `wake_terms_acceptances`
(who accepted the operator's terms) and `wake_forgets` (users to forget at Wakeshift). The SQL engines run the
statements in `src/core/engine-sql/jobs-wake.ts`; this store runs the same rules on its own records
(`rust/crates/gbrain-store/src/jobs/wake.rs`). The members are in `src/core/rust-engine/store-members/jobs-wake.ts`,
which turns the ISO strings into `Date`s as PGLite returns them. The cases are in
`test/engine-parity/jobs-wake.test.ts` (all three arms) and `tests/jobs_wake.rs` (the clock, the lease windows and the
write request journal, which a parity case cannot move or write).

## Members

| Member | Answer |
| --- | --- |
| `openWakeWatch(watch)` | the new watch's id. A second open watch of one (`wakeUser`, `wsSubscriptionId`) keeps its row, takes the new expiry and returns the old id. The id sequence moves in both cases |
| `listWakeWatches(filter)` | one principal's watches (kind, id, and a bound member; a NULL member matches only a NULL member), newest first, at most 50. Scope `open` is the open ones, `open_or_recent` adds any updated in the last day. `id`, or `event` with `target`, narrows it |
| `endWakeWatches(spec)` | the rows that ended. `disabled` ends every open watch, `expired` the open ones past `expires_at`, `unwatched` the open watch `id`. `last_error` becomes the reason; `disabled` and `unwatched` also drop the lease, `expired` keeps it |
| `countWakeWatches()` | every watch counted by (`state`, `last_error`), in byte order with a NULL error last |
| `readWakeDoctor()` | `{ watches, unregistered, stale_forgets, dead_forgets }`: open and 7-day watches by state and whether the error was `id_reused`, cron names that ran in the last 7 days without being registered, pending forgets older than a day, dead forgets updated in the last 30 days |
| `countPendingWakeForgets()` | the pending forgets |
| `listWakeCrons()` | the registered names in byte order, each with its last run's status and time (latest time, then highest id) |
| `addWakeCron(name)`, `removeWakeCron(name)`, `hasWakeCron(name)` | register, unregister (ending the open watches on that cron with `cron_removed`, and returning them) and test a name |
| `recordWakeCronRun({ name, status, finishedAt })` | `{ registered }`. A run with a time is skipped when the same name, status and time exist. Runs of that name older than 30 days are deleted in the same call |
| `hasWakeTermsAcceptance(key, version)`, `recordWakeTermsAcceptance(key, version)` | one acceptance per principal key and terms version |
| `listDueWakeWatches({ ids? })` | the open, unleased watches due now whose target settled, at most 20 by due time then id, each joined to what it watches (see below) |
| `claimWakeWatch(id, leaseSeconds)` | `{ lease, attempts }` or null. The lease is the lease instant in epoch microseconds as text |
| `settleWakeWatch(settle)` | true only while the watch is open and still holds that lease. A null `marker` or `attempts` keeps the column, `error` always replaces `last_error`, `delayS` moves the next attempt |
| `queueWakeForget(user, memberId)` | queues one pending forget per user |
| `claimWakeForgets({ leaseSeconds, limit })` | leases the due pending forgets, oldest due first |
| `settleWakeForget(settle)` | true only while the forget is pending and holds that lease |

Due watches. A job watch is due when its job is `completed`, `failed`, `dead` or `cancelled`, or is gone (a target that is
not 1 to 18 digits counts as gone). A write watch is due when its request is `failed`, `conflict` or `cancelled`, or
`committed` with no recovery record still to run, or is gone; the reference must be a lower-case UUID. A cron watch is
due when its cron has a run at or after the watch began (the first one by time, then id). The row carries the job,
request or run columns the drainer reads (`job_*`, `req_*`, `run_*`).

## Keys

Under the jobs tag `keys::JOBS` (`m`). Integers are big-endian, signed ones with the sign bit flipped.

| Key | Holds |
| --- | --- |
| `m 0x00 wake_sub`, `wake_forget`, `wake_cron_run` | the id sequences of the three tables that have one |
| `m 0x10 <id>` | one watch (every `wake_subscriptions` column) |
| `m 0x11 <wake_user> 0x00 <ws_subscription_id>` | the id of the open watch of that pair: the partial unique index, and the list of all open watches |
| `m 0x13 <id>` | one forget |
| `m 0x14 <wake_user>` | the id of the pending forget of that user: the partial unique index |
| `m 0x15 <principal_key> <terms_version>` | one acceptance (the version is 16 bytes) |
| `m 0x16 <name>` | one registered cron |
| `m 0x17 <name> 0x00 <finished_at> <id>` | one cron run, so a name's runs are in time order |

`0x12` is unused. There is no index by principal, so `listWakeWatches` reads every watch.

## What differs from the SQL engines

- A refused insert gives back its sequence value here (the write rolls back); Postgres keeps it spent. A conflicting
  `openWakeWatch` and a `queueWakeForget` that finds a forget pending spend a value on both.
- The wake tables have no foreign keys: deleting a job, a write request or a member changes nothing here, and a watch
  whose job is gone is due ("gone").
- `queueWakeForget` with a member id: the SQL queues it only when that member is not live in `access_members`. This
  store keeps no access members, so the test is true and the forget queues.
- Three reads had no `ORDER BY` and gained one so the engines agree: the cron list by name, the doctor's `unregistered`
  names and the counts by state and error, all in byte order (`COLLATE "C"` on Postgres, a small change there).
  `claimWakeForgets` does not specify the order of its rows on SQL; this store returns them by id.
- `settleWakeForget` gained `RETURNING id` so the engines can say whether a row settled.
- Times cross the binding as strict ISO UTC text ending in `Z`. The TypeScript members normalize `expiresAt` and a
  spooled run's `finishedAt` first; text that is no time is refused with `invalid_argument`, as Postgres refuses a bad
  `timestamptz`. Text with a NUL byte is refused too.
- The `committed` write request with a recovery record is not reachable through a typed member (no member writes that
  column), so only `tests/jobs_wake.rs` covers it.

Left on `executeRaw`, which the Rust engine refuses: `src/core/wakeshift/forget.ts` (it runs inside the OAuth and
access-token transactions) and `principalLive` in `src/core/wakeshift/drain.ts` (it reads `oauth_clients`,
`access_tokens` and the member identity). On a Rust brain a watch from the local stdio principal with no member works end
to end; any other principal refuses loudly where it reads those tables.
