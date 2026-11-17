# 08 Concurrency, persistence ownership and process model

Line numbers refer to gbrain 36bd05806a.

Reference: garrytan/gbrain v0.60.733.0 (read-only). All paths below are relative to that repo unless marked otherwise.

Evidence tags: **[V]** verified by reading the code or spec named. **[D]** stated in a design or guide doc, not checked against code. **[I]** my inference.

Path correction: the brief names `src/mcp/local-client.ts`. That file does not exist. The engine-free CLI router is `src/core/persistence/local-client.ts`, and the owner socket is `src/core/persistence/ipc.ts`. `src/mcp/` holds only server and transport code. [V]

## 1. Why the persistence layer is so large

The layer is not mainly about Postgres locking. It defends against a structural problem: **agent memory has two copies of record (Markdown files in a Git checkout and database rows), and many uncoordinated writers touch both.** [D] `docs/designs/DATABASE_CANONICAL_MEMORY.md` ("Why it matters") says each incident got a local fix (a guard, a hold kind, a provenance selector, a repair verb). The result was a hold vocabulary of 66 decision-table rows (`docs/guides/sync-unblock-runbook.md:121-189`), a writer census of about 300 rows (`docs/architecture/canonical-writers.tsv`, 306 lines [V]), and a managed sync that grew from 29 files and about 9,000 lines to 65 files and about 18,400 lines in one week in October. The Git-canonical design (`docs/designs/GIT_CANONICAL_MEMORY.md`, "Decision") chose git as the parent: the file is written, committed under the checkout's writer lock, and only then does the row commit. [D]

The concrete failure modes the code defends against (each cited in the docs and mostly traceable in code):

| Failure mode | Defense | Where |
| --- | --- | --- |
| A write meets a refresh and is lost or refused | Refresh write barrier: writes admitted during a refresh wait as `deferred` and replay after release | `src/core/persistence/refresh-barrier.ts:1-12`, `journal.ts:648-650`, `docs/designs/REFRESH_WRITE_BARRIER.md:14-18` [V/D] |
| Process killed mid-write leaves a head claim that blocks the queue | Claim lease with `claim_expires_at`, `execution_token`, owner-death checks; head clears by itself | `claim-lease.ts`, `claim-phase.ts`, `docs/guides/troubleshooting.md:128` [V/D] |
| Crash between file rename and DB commit | Durable file recovery record written before the rename; `recovering` state | `coordinator.ts:440-470` (`pageRecoveryRecord`), `coordinator.ts:486` (`publishMutation`) [V] |
| Two processes drain the same source | Drain lease with fencing token; every fenced transaction checks the token | `sync-lease.ts:46-50`, `sync-lease.ts:88`, `db-lock.ts:225` [V] |
| Owner host moved or restarted with a new identity | Writes queue for the owner; stale-owner diagnostic | `docs/guides/troubleshooting.md:219` [D] |
| Stale grants replayed after waiting | Authority re-checked at publication and replay | `authority.ts`, `docs/architecture/key-files/core-persistence.md` [D/V] |
| Admin or migration while writers run | Brain-level writer admin lock and activation flow | `admin-lock.ts`, `activation.ts`, `deactivation.ts` [D] |
| Non-managed writers (cron, hooks, humans) bypass the writer lock | Trigger guard on ten tables when managed mode is on; `commit-push` takes the same lock | `schema.sql` (`gbrain_require_managed_writer`, around line 2620-2640) [V]; `src/commands/git.ts:36-41` [V] |

Size by file family (line counts of `src/core/persistence/*.ts`, 353 files, 83,826 lines [V]):

| Family | Files | Lines |
| --- | --- | --- |
| `sync-*` (managed sync passes, drain, holds, discovery, status) | 67 | 19,588 |
| `graduation*` (engine graduation, migration custody) | 13 | 5,023 |
| `effect*` (post-commit effect journal and runner) | 13 | 4,016 |
| `git*` plus `effect-git.ts` (Git door, durability, push holds) | 9 | 3,961 |
| `topology*` plus `worktree*` | 13 | 3,044 |
| `connector*` | 13 | 2,620 |

## 2. Process model

There is one brain, many possible processes. The rules:

- **Process kinds.** `src/core/direct-pool-profile.ts:3-7` defines three roles: `resident` (serve, jobs, autopilot, sync --watch keep the full pool), `short_lived` (a command that owns a consumer or takes a lease gets one connection), and `one_shot` (takes no lease). [V]
- **One full consumer per host.** `src/core/persistence/consumer-election.ts:1-20` describes the election. A resident process checks whether a live full consumer already runs on this host. If so it becomes `waiter_only`: it claims nothing, writes no heartbeat, and its writes are published by the owner and reach it through receipt polls. Modes: `probing` to `full` or `waiter_only`, then `promoted`. Constants: `DRAIN_BACK_HEALTHY_TICKS = 3` (line 55), `PROBE_TIMEOUT_MISSES = 3` (line 57). The class is `WaiterOnlyConsumer` (line 107); the real consumer is `PersistenceConsumer` (`consumer.ts:166`). [V]
- **Heartbeat table.** `persistence_consumers` (`src/schema.sql:2500`) has primary key `(host_id, pid, nonce)` and records `mode`, `pid_ns`, `boot_id`, `process_start`, `restart_required`, and the pool stats. Timings from `consumer-heartbeat.ts:41-49`: live within 30 s, lapsed at 60 s, purged at 90 s, renewed every 10 s, 5 s renewal deadline. A renewal also deletes this host's rows lapsed longer than 90 s. PGLite admits one process, so the probe reports "no owner" and nothing is written there. [V]
- **Owner IPC socket.** `src/core/context/resolve-ipc.ts:402-408`: on PGLite the socket is `<dataDir>/.gbrain-persistence.sock`. On Postgres it is `<configDir>/run/persistence-<sha256(database_url)[0:12]>.sock`, so the URL's credentials never appear in the path. [V] The protocol (`ipc.ts`) is version 1, with a 32 MiB frame cap (`PERSISTENCE_IPC_MAX_BYTES`, line 20) and at most 8 connections (line 21). The operation set has 46 names (lines 22-37): puts, deletes, edits, capture, remember, forget, takes, skills, tags, links, and `get_write_request`/`list_write_requests`/`cancel_write_request`. Three owner-only operations (`purge_fact`, `list_page_purges`, `unpurge_page`, `LOCAL_CLI_OWNER_OPERATIONS`, line 39) run only for the verified local CLI registration. [V]
- **CLI routing.** `local-client.ts` runs without an engine. It inspects the lock holder with `inspectLockHolder` (from `pglite-lock.ts`) and, if the holder publishes no persistence socket, refuses `owner_unavailable` and names the process. Nothing is sent to it (`local-client.ts:25`, `noDiscoveryPath`). [V]
- **Exit codes.** `PENDING_WRITE_EXIT_CODE = 10` (`src/core/exit-codes.ts:42`) means "admitted, not yet committed; here is the request id". The CLI waits: `AGENT_WRITE_WAIT_MS = 5_000`, `CLI_WRITE_WAIT_MS = 30_000`, `MAX_WRITE_WAIT_MS = 600_000` (`write-wait.ts:17-20`), and the wire cap is `WIRE_WRITE_WAIT_MAX_MS = 30_000` (`params.ts:51`). [V]

## 3. PGLite single-writer lock

File: `src/core/pglite-lock.ts` (422 lines). PGLite is a single-connection embedded database; this file is the only thing stopping two processes from opening the same data directory. [V]

- **Kernel lock.** `getPgliteKernelLockPath` (line 123) returns `<dataDir>.gbrain-owner.lock`, a stable sibling file that must never be unlinked. It is taken with `tryAcquireNativeLock` (native `flock`, see section 4). The kernel releases it when the process dies. [V]
- **Metadata is diagnostic only.** The code says the legacy `.gbrain-lock/` directory "is never the ownership authority" (`pglite-lock.ts:58`). Its `lock` file records `pid`, `owner_token`, `protocol`, `pid_ns`, `boot_id`, `argv`, and a `refreshed_at` that a heartbeat rewrites every 30 s (`HEARTBEAT_INTERVAL_MS`, line 12). [V]
- **Acquire loop.** `acquireLock` (line 319) defaults to a 30 s timeout and polls every 25 ms (`Math.min(25, ...)`, line 378). If a legacy directory exists and the owner cannot be proven dead (no PID, no matching `pid_ns` and `boot_id`, or an unreadable file), it raises `LegacyOwnerUnverifiedError`, which is not retryable. It is tolerated for 1 s (`LEGACY_UNVERIFIED_GRACE_MS`) to cover a legacy writer between `mkdir` and its metadata write. A live PID in the legacy directory raises `busy`. [V]
- **Error classes.** `PgliteBusyError` (code `pglite_busy`, retryable), with subclasses `LiveServeLockError` and `LegacyOwnerUnverifiedError` (lines 19-55). [V]

## 4. Native locks (`native/locks/`)

- **What it is.** `locks.c` is a first-party C Node-API v3 addon. POSIX uses `flock`, Windows uses `LockFileEx`. The API is `openLock`, a nonblocking `tryLock`, and an idempotent `close`. The kernel releases ownership on process death. [V, `native/locks/README.md:1-9`]
- **Rules the README sets.** Never unlink, rotate, copy over, or infer ownership from age or metadata of a lock file. Replacing a locked inode can allow two owners. Leaf symlinks, reparse points and nonregular files are refused. There is no TTL, PID or timestamp fallback. A close failure must stop publication. An unavailable addon or OS error yields `writer_lock_unavailable`. [V]
- **Distribution.** Eight prebuilt addons are checked in, pinned to Zig 0.14.1 with a hash manifest. [V, README]
- **Wrapper.** `src/core/persistence/native-lock.ts` (`acquireNativeLock` line 160, `tryAcquireNativeLock` line 250). Default deadline 5 s, polling 25 ms, cancellable with an `AbortSignal`. The addon loads only when a caller needs lock capability. [V]
- **Call sites.** 23 files in `src/core` and `src/commands` call `acquire`/`tryAcquire` [V]. The persistence ones that matter most: per-worktree `binding.coordination_path` (`ownership.ts:218-219`, `:342`, `:402`, `:437`); `topology-locks.ts:48`; `head-blocker.ts:180` (refresh lock); `reconcile-backup.ts:62` (`.capacity.lock`); `identity.ts:221` (registration lock); `commit-push.ts:268-271` (commit and legacy lock). Git commit and push locks are `brain-commit.lock` and a separate push lock under the git dir. [V/D: `behavior-change-notice.ts:495`]
- **Shell variant.** `src/core/brain-repo-durability.ts:341-343` generates a shell hook that uses `flock -w` on fd 8 and 9, with `GBRAIN_COMMIT_LOCK_WAIT_SECONDS` defaulting to 60 s. So there are two lock implementations for the same commit lock: the native one in TypeScript and the shell one in the installed hook. [V]

## 5. Row locks and the `gbrain_cycle_locks` lease

Table: `src/schema.sql:1516-1528`. Columns: `id TEXT PK`, `holder_pid`, `holder_host`, `acquired_at`, `ttl_expires_at`, `last_refreshed_at`, plus `acquisition_token` added by the lease schema (v152). Index `idx_cycle_locks_ttl`. [V]

- **Generic lock.** `src/core/db-lock.ts` (1,131 lines). `tryAcquireDbLock` (line 229) inserts or takes over. Takeover needs an expired TTL and a `last_refreshed_at` older than the steal grace (`DEFAULT_STEAL_GRACE_SECONDS = 600`, line 95). A same-host dead PID is taken over after `HOLDER_TAKEOVER_GRACE_MS = 60_000` (line 82). Default TTL is 30 minutes (line 73). `withRefreshingLock` (line 972) renews the row. Every acquisition mints a fresh UUID token; refresh, release and cleanup match on `(id, holder_pid, acquisition_token)`. [V]
- **Lock ids.** `syncLockId(sourceId)` (line 883) and `SYNC_LOCK_ID = syncLockId('default')` (line 891). `buildTenantLockId` (line 1119). The cycle lock is a separate id so the sync write window can nest under it. [V]
- **Fence.** `fenceLockRow` (line 225) runs `SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2 AND ttl_expires_at > now() FOR KEY SHARE`. `FOR KEY SHARE` conflicts only with key writes and `DELETE`, so a renewal (which writes no key) still lands while a fenced transaction is open. The TLA+ README documents why `FOR SHARE` was wrong (#7442). [V]
- **Drain lease for sync.** `src/core/persistence/sync-lease.ts`. `DRAIN_LEASE_TTL_MINUTES = 2` (line 46), `DRAIN_LEASE_REFRESH_MS = 20_000` (line 47), `FOLLOW_POLL_MS = 2_000` (line 49), `LEASE_RETRY_AFTER_MS = 60_000` (line 50), `HOLDER_STALL_MS = 5 min` (line 56), `FENCED_SLICE_MS = 5_000` (line 98). `withDrainLease` (line 270). `assertDrainLease` (line 88) runs inside every transaction that admits sync work or swaps the cursor. [V]

## 6. Postgres advisory locks and row-lock clauses

Counts over `src/**/*.ts` excluding generated files [V]:

| Primitive | Call sites | Use |
| --- | --- | --- |
| `pg_advisory_xact_lock` | 37 | per-key serialization inside one transaction |
| `pg_advisory_lock` (session) | 5 | schema init, `db.ts:600` and `init-schema-lock.ts` |
| `pg_advisory_unlock` | 2 | pairs with the above |
| `pg_advisory_xact_lock_shared` | 1 | derivation scope read lock (`page-body/schema.ts:279`) |

Files: 27. Notable keys:

- Schema init: `INIT_SCHEMA_LOCK_KEY = 42` (`src/core/postgres-engine/init-schema-lock.ts:29`). It is a session lock with a fallback when the pool has one connection (line 220). `db.ts:600` uses the same key as a session lock with a comment saying it is brain-global. [V]
- Minion admission and quota: `queue.ts:385, 431, 460-488` (keys hashed from `minion_admission`, `minion_quota`, `minion_maxwaiting`). Budget meter: `budget-meter.ts:99, 255`. These belong to the jobs topic (r07). [V]
- Facts per entity: `engine-sql/facts.ts:122, 151` (`hashtextextended(source_id||':'||entity)`). Page body chunks: `engine-sql/page-body.ts:197`. Generations: `generations/fence.ts:128`, `generations/publish.ts:71`. Chronicle reservation: `chronicle/ledger.ts:97`. Mentions: `mentions/pass.ts:481`. Writeback settings: `facts/writeback-settings.ts:122`. [V]
- PGLite opt-out: `engine-sql/executor.ts:63-68` has a capability flag `transactionAdvisoryLocks`. PGLite "is a single-connection embedded database and never needed one". [V]

Row-lock clauses: about 385 source lines match `FOR UPDATE`, `FOR KEY SHARE`, `FOR SHARE`, `FOR NO KEY UPDATE`, or `SKIP LOCKED` across `src` (including comments). In the persistence layer, `SKIP LOCKED` is used for the claim queue: `journal.ts:856` (`claimNextWrite`, `LIMIT 1 FOR UPDATE OF r SKIP LOCKED`), `journal.ts:909`, `consumer.ts:719` (100-row batch), `effect-journal.ts:167, 237, 276` (effect claims), `embedding-noop-settle.ts:77`, and `consumer-heartbeat.ts:297` (worktree sweep). [V]

A comment in `src/core/db-lock.ts:8-9` says `pg_advisory_xact_lock` "is session-scoped" and that this is why the row lock is used. That is imprecise. Transaction-level advisory locks end with their transaction and do survive transaction-mode poolers; it is session-level `pg_advisory_lock` (used for schema init) that does not. [I]

## 7. The write path: journal, claim, publish, effects

Key tables (`src/schema.sql`, 14 `persistence_*` tables plus `op_checkpoints`, `gbrain_cycle_locks`, `page_generation_clock`) [V]:

| Table (schema.sql line) | Role |
| --- | --- |
| `persistence_brain` (2402) | singleton: `enabled`, `brain_id`, `activated_at` |
| `persistence_worktrees` (2409) | checkout: `owner_host_id`, `owner_epoch`, `topology_generation`, `state` (active, draining, recovering), `heartbeat_at` |
| `persistence_source_bindings` (2419) | `source_id` to worktree and `relative_path` |
| `persistence_host_bindings` (2426) | per host: `local_path`, `coordination_path`, `git_durability` |
| `persistence_local_writers` (2434) | CLI and stdio credentials with `grant_ceiling` |
| `persistence_counters` (2442) | outstanding counts and byte budgets, locked `FOR UPDATE` at `journal.ts:243` |
| `persistence_requests` (2450) | the journal: `principal`, `request_id`, `sequence bigserial`, `state`, `execution_token`, `claim_expires_at`, `recovery`, `outcome`, `intent jsonb`, `UNIQUE(principal_kind, principal_id, request_id)` |
| `persistence_effects` (2489) | post-commit effects: `kind`, `state` (queued, running, committed, failed), `UNIQUE(request_id, kind)` |
| `persistence_consumers` (2500) | heartbeat rows |
| `persistence_topology_changes` (2771), `persistence_worktree_refreshes` (2795), `persistence_writer_protocols` (2943) | topology, refresh barrier, protocol version |

Request states: `queued, running, recovering, committed, conflict, failed, cancelled` (`schema.sql:2466`). [V]

Admission: `admitWrite` (`journal.ts:289`) and `admitWriteInTransaction` (303). It locks the counters, checks caps, and inserts the row. Default caps (`src/core/persistence/model.ts:203-210`): 100 outstanding per principal, 1,000 per brain, 64 MiB intent bytes per principal, 256 MiB per brain, 1 GiB recovery bytes per brain, 256 MiB per worktree. Lifetime and terminal caps are off (`Infinity`) until configured. [V]

Claim: `claimableWriteSql` (`journal.ts:751`) is a predicate: the row is `queued` or released from a refresh barrier, and its worktree is owned by this host and `active`. Ordering is `CLAIM_ORDER` (line 770): foreground priority first, then `sequence`. A claim sets `execution_token` and `claim_expires_at` (default lease 30 s, `claimNextWrite` line 840). Renewal is `claim-lease.ts:49` (`startClaimLease`). [V]

Transient retries (`transient-retry.ts:33-35, 43`): statement cancel (57014), stale plan (0A000), or publication ceiling reached. Backoff 1 s, 2 s, 4 s, 8 s, then 15 s. Default maximum 5 retries (`persistence.max_transient_retries`). The retry does not count as a preparation attempt. [V/D]

Preparation budgets (`preparation-budget.ts`, `DEFAULT_PREPARATION_POLICY`): sync 120 s, maintenance 120 s, ceiling 600 s, 2 attempts. [V]

Publication (`coordinator.ts:486`, `publishMutation`): (1) a durable recovery record with the before and after hashes, (2) the file is staged and renamed into place, (3) one database transaction writes the row and the receipt, (4) effects are queued. `publishGroup` (`group-publish.ts:251`) does the same for batches. Every publication transaction opens with `declareDurablePersistence` (`protocol.ts:39`): `lock_timeout = 1s`, `statement_timeout = 5s` as transaction-local `set_config`, and `synchronous_commit = on`. A publication also sets `idle_in_transaction_session_timeout` to the publication ceiling (`publication-deadline.ts:27-31`: default 5 min, grace 30 s). [V]

Git door: when `config.canonical = "git"`, `git-door.ts` commits the published files with plumbing (`hash-object -w`, `commit-tree`, `update-ref <branch> <new> <old>`), and the branch moves only if it still names the HEAD the commit was built on. [V]

Effects: `EffectKind = 'git' | 'embedding' | 'withdrawal-mirror' | 'facts-backstop' | 'links'` (`effect-model.ts:6`). `PARK_AFTER_FAILURES = 5` (line 70). The runner is `runPersistenceEffects` (`effects.ts:813`). Git effects only push: they read the remote tip, scan `<tip>..HEAD`, and push fast-forward with a lease (`effect-git.ts`, `pushGitRoot`). [V]

Database-side guards: when managed mode is on, `gbrain_require_managed_writer()` is a `BEFORE INSERT OR UPDATE OR DELETE` trigger on `pages`, `tags`, `slug_aliases`, `page_aliases`, `facts`, `takes`, `timeline_entries`, `sources`, `page_segment_texts`, `page_body_manifest` (`schema.sql` around 2620-2640). Missing state rows are treated as "unreadable", never as unmanaged. Protocol triggers: `gbrain_request_protocol` (2997), `gbrain_effect_protocol` (3009), `gbrain_protocol_activation` (3036). The file has 26 `CREATE TRIGGER` statements and 32 `ENABLE ROW LEVEL` or `CREATE POLICY` lines. [V]

## 8. Thin client

`docs/architecture/thin-client.md` [D, verified in parts]: a thin install (`gbrain init --mcp-only`) never opens a local PGLite file. All operations route to a remote `gbrain serve --http` through `src/core/mcp-client.ts` (`callRemoteTool`). The routing seam is `runThinClientRouted` in `src/cli.ts`, which runs before `connectEngine`. Local-only commands refuse with a hint table (`THIN_CLIENT_REFUSE_HINTS`). [V on names; D on behavior]

A thin-client write is an ordinary remote journal request. For a `canonical: git` source, the owner commits to Git before the row. While the owner is down the call ends `write_pending` (exit 10) with its request id, and `gbrain write-request <id>` follows it. Nothing is written to the database first. [D]

## 9. Postgres connection policy, PgBouncer, pools

- **Prepared statements.** `resolvePrepare` (`src/core/db.ts:91-110`): `GBRAIN_PREPARE` env wins, then `?prepare=` on the URL, then auto-detect: port 6543 means `prepare: false`. Otherwise postgres.js default. [V]
- **Pool size.** `resolvePoolSize` (`db.ts:246`) reads an explicit value, then `GBRAIN_POOL_SIZE`, then a fallback of 10. [V]
- **Timeouts.** `statement_timeout` default `5min` (`GBRAIN_STATEMENT_TIMEOUT`), `idle_in_transaction_session_timeout` default `5min` (`GBRAIN_IDLE_TX_TIMEOUT`), both sent as connection startup parameters (`db.ts:346-347, 453-454`). [V]
- **Transaction-mode poolers drop startup parameters.** The comment at `db.ts:319-340` and `troubleshooting.md:197` say PgBouncer and Supavisor drop them, so an autocommit statement has no server-side bound. Persistence works around this by setting transaction-local `set_config` values inside each transaction (`protocol.ts:39-46`), and the managed write preparation runs under a transaction-local `statement_timeout` (troubleshooting.md:197, #6278). [V/D]
- **Dual pool.** `src/core/connection-manager.ts:1-40` (header comment): a read pool on the pooler URL and a direct pool for DDL and bulk work, with sizes and timeouts given in the comment. The direct URL is `GBRAIN_DIRECT_DATABASE_URL` or derived from a known Supabase pooler; `GBRAIN_DISABLE_DIRECT_POOL=1` is the kill switch. [D: the header comment, not re-checked in code]
- **LISTEN/NOTIFY.** Used only by `src/core/minions/sync-queue-wake.ts`: `LISTEN` on the `minion_jobs` channel, and only on a detected direct session. Behind a transaction pooler it polls every 1 s instead. The persistence consumer does not use LISTEN; it uses heartbeat rows and short polls. [V]

## 10. Brains, sources, mounts, and the shared checkout

From `docs/architecture/brains-and-sources.md` [D] and code [V]:

- **Brain** = one database (PGLite file or Postgres). Its lock is one data directory (PGLite) or one database URL (Postgres socket hash). Brains are enumerated by host config and `~/.gbrain/mounts.json` (`src/core/brain-registry.ts`, `mountsPath` line 48). `persistenceConfigForBrain` (`local-client.ts:33-52`) resolves `--brain` to a mounted engine before any host lock or socket is inspected. [V]
- **Source** = a named repo (checkout) inside one brain. Rows: `sources`, `persistence_source_bindings`, `persistence_worktrees`. Slugs are unique per source. [V/D]
- **Owner.** Each managed worktree has an owner host (`persistence_worktrees.owner_host_id`, `owner_epoch`). Host identity is `host.json` (`identity.ts`, `hostIdFor`). Only the owner publishes. A copy of the brain on another machine gets a new identity and its writes queue (`owner_unavailable`). [V/D]
- **Git rules for a shared checkout.** `gbrain git commit-push` takes a short commit lock and a separate push lock per checkout. It does not rebase, stash or reset the working tree. Remote commits merge in memory. Push is fast-forward only (`src/commands/git.ts:36-41`). Writers outside gbrain (cron, scripts) must use this command or they become drift holds. [V/D]

## 11. TLA+ models (`spec/tla/`)

Two specs, checked with TLC, run by `bun run test:tla` (`spec/tla/README.md:1-30`). [V]

| Spec | Files | What it models | Mutants |
| --- | --- | --- | --- |
| `drain-lease/DrainLease.tla` (344 lines) | 4 `.cfg` (main, safety with all adverse assumptions, stamp fence, nightly lanes) | one drainer per source; fencing token; renewal; crash; sleep | 14 (README table) |
| `refresh-barrier/RefreshBarrier.tla` (884 lines) | 11 `.cfg` | one worktree, one page, writes, one refresh at a time, a foreign commit, a crash at any step, Postgres row-lock modes | about 22 entries in `mutants.json` (approximate: counted by key) |

Safety properties include: `FencedTxnsMatchRow`, `OneDrainer`, `CursorMonotone`, `NoSpuriousLapse` (drain lease); `NoDeadlock`, `AppliedAtMostOnce`, `EveryEndNamed`, `DeferredWaitsForRelease`, `RefreshChangeNeverOverwritten`, `RecoveryOnlyByPolicy`, `NoApplyAfterRevoke`, `CommitsInAdmissionOrder` (refresh barrier). Liveness: `DeferredLeaves`, `EveryWriteEnds`. [V]

Bugs the models found and the code fixed: #7442 (fenced transactions unbounded under the renewal timeout; fixed by `FOR KEY SHARE`), and GST-1853 (writes held behind an aborted refresh; fixed by running the owed managed sync on the way out). [D: README, verified in code by the cited symbols]

Not modeled: PGLite (one connection), side effects outside the database, multiple worktrees or pages at once, older binaries that take no lock. [V/D]

Crash robot: `scripts/persistence/README.md` describes a gate with 1,000 seeded schedules, eight SIGKILL boundaries, and 10,000 logical writes from four producer processes, on both engines. [V]

## Rust engine implications

**Must preserve exactly**

- Single owner per brain data directory, with kernel-released ownership and no TTL takeover of the lock file itself. The lock file is never unlinked. Metadata is diagnostic only.
- A durable journal row per write, with `(principal_kind, principal_id, request_id)` as the idempotency key and a monotone `sequence` (bigserial) that orders claims. Replays return the same outcome.
- Recovery record written before any file rename; committed state reachable after SIGKILL at any boundary.
- Fencing for any long-running work that could overlap a takeover: every commit checks token and expiry in the same transaction that writes.
- Git ref updates are compare-and-swap on the old HEAD. A moved branch means re-read and rebuild, never force.
- The exit-10 contract: an admitted write that has not committed returns a request id, and the request can be followed later.
- Authority is rechecked at publication and at replay, not only at admission.
- The refresh barrier semantics (defer, do not refuse; never overwrite a file the refresh changed). The TLA+ properties should be kept as tests.

**Can be simplified**

- In a single-process embedded Rust brain, the whole consumer election, waiter-only mode, heartbeat table, promotion and drain-back logic is needed only for multiple processes on one host. If the design is one owner process plus a local socket for CLI callers, most of `consumer-election.ts`, `consumer-heartbeat.ts`, `consumer-lane.ts`, and the `persistence_consumers` table go away.
- The PGLite-versus-Postgres split disappears. One lock mechanism (`flock` or `LockFileEx`) covers the brain. The legacy `.gbrain-lock/` handling (`pglite-lock.ts`, 422 lines, plus `pglite-legacy-lock.ts` and the `pglite-repair` path) is not needed for a new format.
- Advisory locks (42 call sites) become in-process mutexes or single-writer transactions. `FOR KEY SHARE` fencing is not needed if there is one writer. `SKIP LOCKED` queues become a single claim loop.
- PgBouncer, dual pools, prepared-statement detection, `set_config` transaction-local timeouts, and LISTEN fallbacks all go away.
- Statement and idle-transaction timeouts become per-operation deadlines in the process (the publication ceiling of 5 min, the preparation budgets of 120 s and 600 s, the 5 s renewal deadline).
- The ten-table managed-writer trigger becomes a type-level or API-level rule: only the owner's write API can mutate page state.

**Postgres feature each piece depends on (what Rust replaces it with)**

| Piece | Postgres feature today | Rust substitute |
| --- | --- | --- |
| Write queue claim | `FOR UPDATE SKIP LOCKED`, `claim_expires_at` | single claim loop over an ordered table or log; lease in memory plus a durable claim record |
| Counters and caps | `FOR UPDATE` on `persistence_counters` | in-process counters rebuilt from the journal at open |
| Drain or sync lease | `gbrain_cycle_locks`, `FOR KEY SHARE`, `ON CONFLICT ... WHERE` | `flock` on the data directory plus a fenced write token if multi-process is kept |
| Schema init lock | `pg_advisory_lock(42)` | file lock during open |
| Per-key serialization | `pg_advisory_xact_lock(hashtext(...))` | per-key mutex map |
| Post-commit effects | `persistence_effects` with `UNIQUE(request_id, kind)` | same table in the embedded store, same unique key |
| Notifications | `LISTEN/NOTIFY` (minion queue only) | channel or condvar |
| Timeouts | `set_config(..., true)`, `idle_in_transaction_session_timeout` | per-operation deadline objects |
| Trigger guard | `gbrain_require_managed_writer` | Rust API visibility (only the owner module can call the mutating functions) |
| Recovery records | JSON in `persistence_requests.recovery` | same, in the embedded store |

**Risks**

- Multi-process access is a real requirement today: `serve`, `jobs`, `sync --watch`, and CLI calls run at the same time against one brain. If the Rust engine keeps that, it needs the socket protocol and the owner election. Dropping it changes the operator model.
- Network filesystems and `flock`: the native lock README says cross-process semantics are a host prerequisite. A Rust `fs2` or `flock` binding has the same limit; Windows `LockFileEx` behaves differently on abandoned handles.
- PID reuse and stale-owner detection: the TypeScript code uses `pid_ns`, `boot_id`, and process start time. Rust needs the same, or accepts that a dead owner is found only by the kernel lock.
- Git interop: external writers (cron, hooks, humans) still commit to the checkout. The Rust design must keep the commit-lock contract, or it reproduces drift holds.
- Two copies of record: if the design is git-canonical, the file and row coordination (recovery records, git door, holds) remains the bulk of the code. If it is database-canonical, much of it goes away, but the export and import lanes take its place.
- Compatibility: `write_pending` exit code 10, `owner_unavailable`, and the receipt schema are visible to agents and scripts. Changing them needs a mapping.

## Open questions

1. Does the Rust engine need several processes to write the same brain (CLI plus server), or is one owner process with a local socket enough? This decides whether sections 2, 5 and 7 shrink by most of their code.
2. Is the Rust target git-canonical (files are truth, the database is an index) or database-canonical? The persistence layer's size mostly follows from this choice.
3. Which of the 14 `persistence_*` tables and the 26 triggers are kept, and which become in-memory state rebuilt on open?
4. Are the TLA+ specs ported as-is for the Rust protocol? They are language-neutral, and they are the best record of the race conditions.
5. Is the thin-client remote MCP path in scope for the first Rust release? It is the largest source of the `write_pending` contract.
6. Target platforms: does Windows need `LockFileEx` parity in v1, or is POSIX `flock` enough for the first milestone?
7. Should `gbrain git commit-push` and the shell hook lock be replaced by one Rust implementation, and who owns the installed hook after migration?
8. How many held-state kinds (the 66-row decision table) must the Rust engine reproduce, and which can be dropped because the single-owner model cannot produce them?
