---
title: "Sentry Alert Prioritization"
type: note
created: 2026-03-08
updated: 2026-03-08
source: chatgpt-export
conversation_id: 69ade803-ddc4-832a-ac8b-85096b28bd73
message_count: 2
tags: [chatgpt, import, long-form]
---
# Sentry Alert Prioritization

> Conversation ID: 69ade803-ddc4-832a-ac8b-85096b28bd73
> Created: 2026-03-08T21:20:06Z
> Updated: 2026-03-08T21:21:58Z
> Messages: 2

---

## User

Prioritize these Sentry alerts: Failed query SELECT set_config('app.clerk_user_id'...), tableExists timeout, circuit breaker opened. Give root‑cause hypotheses, immediate triage steps, rollback/playbook, and CI/DB checks.

---

## Assistant

Mr. White,

From the inbox snippets, the highest-signal alert cluster is:

1. **Failed query: `SELECT set_config('app.clerk_user_id', $1, true)`**
2. **`tableExists timeout after 5000ms`**
3. **Circuit breaker opened**
4. Secondary fallout: `GET /app`, `/app/releases`, `/api/dashboard/analytics`, `/monitoring`, chat routes, avatar/profile failures, temporary server errors

This pattern points to a likely **database connectivity / transaction / migration-state issue**, with the circuit breaker opening as a downstream protection response.

## Priority order

### P0 — `SELECT set_config('app.clerk_user_id', $1, true)` failures
Why this is first:
- It appears across multiple endpoints.
- It is early in request handling, likely in auth/session/DB context setup.
- If this fails, large portions of the app fail before business logic runs.

### P0 — `tableExists timeout after 5000ms`
Why this is tied for first:
- Strong indicator of DB latency, lock contention, bad connection state, broken migration check, or unhealthy replica/primary routing.
- Explains broad query failures and degraded app availability.

### P1 — circuit breaker opened
Why this is next:
- Usually symptomatic, not primary.
- Important because it can amplify outage scope by cutting off dependent paths.

---

## Root-cause hypotheses

### 1) DB connection / pool / transaction state regression
Most likely.

Evidence from snippets:
- Repeated failed queries across unrelated endpoints
- `tableExists timeout`
- `SET LOCAL app.clerk_user_id = $1` and `SELECT set_config(...)` both failing
- Broad app surface affected

Specific possibilities:
- Pool exhaustion
- Stuck or zombie connections
- DB server CPU / IOPS saturation
- Long-running transaction or lock contention
- Connection wrapper no longer opening a transaction before `SET LOCAL`
- Read replica receiving session-setting statements it does not handle in current query path
- Query middleware changed connection lifecycle or transaction scope

### 2) Recent deploy changed auth-to-DB session propagation
Very plausible.

Specific possibilities:
- Clerk user ID injection moved earlier/later in request lifecycle
- Code now calls `set_config` on a connection that is not valid yet
- New DB client / ORM / proxy behavior broke session variable setting
- Server action / edge runtime mismatch with DB adapter

### 3) Migration drift or schema introspection path blocking
Supported by `tableExists timeout`.

Specific possibilities:
- Startup/request path checks schema on live traffic
- Migration partially applied
- Migration added lock-heavy DDL
- App boot is waiting on metadata query against a slow system catalog

### 4) Dependency failure causing circuit breaker, then cascading DB pressure
Possible but less likely as root cause.

Example:
- Third-party service degraded
- Retry storm increased DB load
- Circuit breaker opened after latency spike

---

## Immediate triage steps

### First 15 minutes
**Goal:** confirm whether this is DB health, deploy regression, or migration/lock issue.

1. **Freeze deploys**
   - Stop new deploys, migrations, backfills, cron jobs, queue workers if they hit the same DB.

2. **Compare alert start time to deploys / infra changes**
   - Match first Sentry timestamps against:
     - last app deploy
     - last migration
     - DB config change
     - proxy / pooler change
     - auth middleware change

3. **Check DB health immediately**
   - Connection count
   - Pool saturation
   - CPU / memory / disk / IOPS
   - query latency p95/p99
   - lock waits
   - long-running transactions
   - replica lag if applicable

4. **Identify whether failures happen before or after transaction begin**
   - Search logs around:
     - `BEGIN`
     - connection acquisition
     - auth middleware
     - request-scoped DB client creation
     - any wrapper around `set_config` / `SET LOCAL`

5. **Temporarily disable or bypass session-setting query if safe**
   - For example, fall back to app-level user context instead of DB session var for non-critical paths.
   - This can restore service quickly if RLS or auditing is not fully dependent on it.

6. **Open the circuit breaker only after dependency health is verified**
   - Otherwise traffic surge can worsen the incident.

---

## Triage by alert

### A. Failed query `SELECT set_config('app.clerk_user_id', $1, true)`
Check:
- Is this called on every request?
- Is it executed inside a transaction?
- Did code switch between `SET LOCAL` and `set_config(..., true)` recently?
- Is the DB role permitted to run it?
- Is the connection already dead / timed out when called?
- Is middleware trying to set it on read-only or pooled connections in an invalid state?

Immediate mitigation:
- Wrap this in a fail-open path for non-critical endpoints.
- Skip session var injection for health checks, read-only pages, and low-risk endpoints.
- Reduce retries around failed connection setup.

### B. `tableExists timeout after 5000ms`
Check:
- Which table?
- Is this a migration framework introspection query?
- Are there locks on system catalogs or target tables?
- Is app code doing schema checks during requests?

Immediate mitigation:
- Increase timeout only if DB is healthy and query is legitimate.
- Better fix: remove runtime schema checks from request path.
- Halt any active migrations or DDL until root cause is known.

### C. Circuit breaker opened
Check:
- Which dependency?
- Open threshold reason: timeout, 5xx, connection failure?
- Which routes depend on it?

Immediate mitigation:
- Keep breaker open for the unhealthy dependency.
- Serve degraded experience where possible.
- Cut retries and concurrency to prevent retry storms.

---

## Rollback / incident playbook

### Fastest rollback path
Use this if alert onset matches the last deploy.

1. Roll back to last known good app version.
2. Recycle app instances to clear poisoned pools/connections.
3. Disable the code path that injects DB session user context.
4. Pause workers/background jobs.
5. Recheck:
   - error rate
   - DB connection count
   - route latency
   - Sentry new issue volume

### If rollback does not fix it
Treat as infra/DB incident.

1. Fail over or restart pooler if you use one.
2. Kill long-running blocking sessions.
3. Pause DDL/migration jobs.
4. Scale app down slightly if it is stampeding the DB.
5. Scale DB or remove noisy workloads.
6. Put high-cost endpoints behind a temporary feature flag.

### Degraded-mode plan
- Disable analytics/release/dashboard pages first
- Disable avatar/profile uploads
- Keep core authenticated app routes available if possible
- Return cached/fallback data instead of live DB-heavy queries

---

## CI / DB checks to run

### CI checks
1. **Verify last merged changes touching:**
   - auth middleware
   - Clerk integration
   - DB client wrapper
   - transaction helper
   - RLS/session variable helpers
   - migrations

2. **Add tests for request-scoped DB session context**
   - connection acquired
   - transaction started
   - `set_config` succeeds
   - query runs under expected context
   - cleanup after request

3. **Regression tests**
   - no schema introspection on hot request path
   - app boots with empty pool and under pool pressure
   - breaker behavior under dependency latency
   - rollback smoke test

4. **Deploy diff review**
   - ORM version bump
   - pool config change
   - server runtime change
   - env var changes for DB URL / pooler / SSL / prepared statements

### DB checks
Run these immediately in your DB console:

- Active sessions by app/user/state
- Waiting queries and blockers
- Long-running transactions
- Lock tree
- Slow queries last hour
- Connection saturation vs max connections
- Deadlocks / timeout count
- Replication lag
- Recent DDL / migration history
- Pooler health if using PgBouncer or equivalent

### Specific DB questions to answer
- Are `set_config` failures actual SQL errors, or timeout/connection wrapper errors?
- Are they failing on primary only, replica only, or both?
- Did a migration touch auth/RLS-related tables or policies?
- Did prepared statements or transaction pooling mode change?

---

## Likely diagnosis

Most likely sequence:

1. A deploy or DB state change introduced connection/transaction instability.
2. Request middleware began failing while setting `app.clerk_user_id`.
3. Schema/introspection checks also started timing out.
4. Latency and failures triggered the circuit breaker.
5. Secondary endpoints failed across app, analytics, releases, chat, monitoring, and uploads.

---

## What I would do next, in order

1. Correlate first alert with latest deploy/migration.
2. Inspect DB locks, active sessions, pool saturation.
3. Roll back latest app deploy if timing matches.
4. Temporarily disable request-time `set_config` injection behind a flag.
5. Pause migrations/workers.
6. Keep breaker open on unhealthy dependencies and reduce retries.
7. Confirm recovery with error-rate and latency graphs over 15 minutes.

If you want, I can turn this into a one-page incident commander runbook you can paste into Slack or Linear.
