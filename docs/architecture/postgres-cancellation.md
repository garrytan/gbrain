# PostgreSQL cancellation ownership

GBrain ships the exact `postgres` 3.4.9 source with `patches/postgres@3.4.9.patch` already applied under `vendor/postgres`. The package-private `#postgres` import resolves directly to those bytes, so global installs do not depend on Bun applying transitive `patchedDependencies`. The patch covers the ESM, CommonJS and workerd entrypoints and their shared types. Keep the implementations equivalent, run `bash vendor/update-postgres.sh --check`, and verify isolated package and compiled installations after changing the patch. See [driver provenance and update instructions](../../vendor/README.md). An edited `node_modules` directory is not a distributable fix.

## Dispatch and settlement

`PostgresEngine.runUnsafe` uses an abortable exclusive reservation for signaled SQL outside a transaction. Inside an existing transaction or reserved callback, it uses that owner. The driver's `cancelFence` option drains predecessors before dispatch and prevents successor dispatch until both the marked query and its cancellation transport settle. This includes tagged queries and savepoints sharing the transaction, not just calls to `executeRaw`. Unmarked work can still pipeline.

The fence prevents two different failures: a late CancelRequest hitting a successor, and an inactive canceled query being skipped while its protocol responses are incorrectly delivered to another query. Cancellation is not a statement retry. A failed cancellation transport discards only the connection still owned by that lease; a stale release or discard cannot affect its replacement.

A transaction installs its owner while sending `BEGIN`, but does not expose the scoped SQL handle until `BEGIN` settles. Its synchronous ReadyForQuery handler runs before the awaiting continuation. Preserve that ordering: the fence's idle state must mean no active or sent predecessor remains.

Reservation grant parks and assigns the connection before resolving the waiter. Grant, rejection and abort share idempotent queue/listener cleanup. An abort observed after grant releases that exact lease. Saved query and savepoint handles reject after ownership changes rather than borrowing the replacement owner.

The engine's abort listener stays attached across reservation acquisition and query execution. Removing the last listener from `AbortSignal.timeout()` during that handoff disables its timer on Bun 1.3.13 and 1.3.14, even if another listener is attached afterward; the same control works on 1.3.11. This protects a single engine call, not reuse of that timeout signal across completed calls. Production phase and renewal budgets use explicit `AbortController` timers. Pool shutdown rejects queued work and cannot reconnect or grant a released slot to a new owner.

## Deadline and transport limits

A phase deadline requests cancellation; it is not a promise that PostgreSQL has stopped at that instant. The owner remains accounted for until actual settlement. Cancellation-channel completion is bounded by the driver's connection timeout, which defaults to ten seconds, and can outlast a five-second phase budget. A blocked or failed transport must not be reported as a successful cancellation.

The phase's `deadline_exceeded` observation records an elapsed budget even when shutdown requested cancellation first and settlement is still pending. It does not replace that first abort reason: recognized stop-owned cancellation is not reported as a storage error, while deadline-first cancellation and unrelated errors remain visible.

An abort before dispatch can produce `AbortError`; a PostgreSQL cancellation can produce SQLSTATE `57014`. Callers must honor their aborted signal rather than interpreting every `57014` as permission to retry. The raw engine methods do not retry statements.

Direct PostgreSQL closes the cancellation connection after handling the request. Through a transaction pooler, safe reuse also depends on the pooler's cancellation routing and backend quarantine. Tests against one pooler version do not establish safety for every proxy or deployment. Direct TLS negotiation and PostgreSQL STARTTLS are separate transport cases; coverage of one is not evidence for the other.

## Regression evidence

`test/e2e/persistence-chaos.test.ts` exercises active, queued, delayed and failed cancellation; transaction siblings; stale ownership; atomic reservation settlement; reconnects; completed cursors; and real socket backpressure in both module formats. Its optional PgBouncer case requires `GBRAIN_PGBOUNCER_URL` and `GBRAIN_PGBOUNCER_DIRECT_URL`, uses a dedicated test database, and verifies another client can reuse the same server backend without receiving a late cancellation.

Keep the response-mapping, actual-settlement and unchanged persistence latency checks alongside these protocol tests. Global `max_pipeline: 1`, serializer fallbacks and blind retries are not substitutes for ownership isolation.

## Worker admission and configuration shutdown

Workers check the actual driver lanes and selected child executable before admitting jobs. Final database/schema checks precede the worker's `ready` event. A supervised worker must publish readiness through its current owner channel; a missing or unwritable channel does not authorize claims. An unconfirmed startup remains subject to the owner's bounded startup timeout and existing transient crash budget, rather than disabling its watchdog indefinitely.

A typed local configuration fault stops admission and starts one bounded drain. The queue releases only active claims whose lock token still matches and whose execution is confirmed stopped, without incrementing attempts or stalls. A completed handler outcome is not process-stop evidence: normal completion can still be recorded, but a failed completion write cannot authorize configuration release while descendants remain live.

For isolated jobs, stop evidence comes from a confirmed no-execution spawn failure or direct-child exit plus supported Linux process-group checks. The bounded `/proc` snapshots cover known owned groups and observed descendants. Failed or unsupported scans, surviving members, unknown tini child groups and observed escapes remain unconfirmed. These checks do not contain arbitrary historical descendants that escaped before observation; other platforms retain lease-expiry fallback rather than claiming equivalent process-tree proof. See [release-unconfirmed recovery](../guides/minions-fix.md#release-unconfirmed).
