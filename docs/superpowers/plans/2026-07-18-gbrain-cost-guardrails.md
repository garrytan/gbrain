# GBrain Cost Guardrails Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep GBrain autopilot to one maintenance cycle every two hours or less, stop automatic retry amplification, and enforce a persistent $1.50/day ceiling for gateway-routed paid AI calls.

**Architecture:** Treat cost control as three independent, fail-safe layers. The scheduler gets a hard interval floor and fail-stop service definitions; the AI gateway gets a database-backed reserve/settle daily governor shared by every process; and both SDK-level retries and autopilot job retries default to one attempt. Existing `mcp_spend_reservations` and `mcp_spend_log` tables provide the cross-process ledger, with transactions and pessimistic accounting for crashes.

**Tech Stack:** TypeScript, Bun, Vercel AI SDK, BrainEngine/Postgres/PGLite, launchd/systemd/cron.

---

## Task 1: Contain the running installation

**Files:**
- Modify: `/Users/harry/Library/LaunchAgents/com.gbrain.autopilot.plist`
- Modify: `/Users/harry/.gbrain/autopilot-run.sh`
- Inspect: GBrain DB-backed config and minion queue through the CLI

- [ ] Resolve the exact launchd label and current GBrain worker processes without printing credentials.
- [ ] Stop `com.gbrain.autopilot` and its managed worker before changing configuration.
- [ ] Confirm no billable GBrain worker remains and inspect waiting/active job counts.
- [ ] Do not delete user data; leave queued jobs paused until the new budget guard is installed and verified.

Expected result: no new autonomous API calls occur during implementation.

## Task 2: Enforce a two-hour scheduler floor and fail-stop supervisors

**Files:**
- Modify: `src/commands/autopilot.ts`
- Modify: `test/autopilot-reconnect-classifier.test.ts`
- Create: `test/autopilot-interval.test.ts`

- [ ] Add a pure `resolveAutopilotInterval(baseSeconds, brainScore, minimumSeconds)` function.
- [ ] Parse `--min-interval`; default it to the base interval so adaptive scheduling can slow down but never run faster than the operator-supplied cadence.
- [ ] Generate the installed wrapper with `--interval 7200 --min-interval 7200` by default.
- [ ] Change launchd from `KeepAlive=true` to `KeepAlive=false`; retain `RunAtLoad=true` so it starts at login but remains stopped after a fatal exit.
- [ ] Change systemd from unconditional restart to `Restart=on-failure` with a bounded restart policy, and change cron fallback from five minutes to two hours.
- [ ] Add tests proving a low brain score cannot reduce a 7,200-second floor, a healthy score may only lengthen it, launchd cannot respawn-loop, and cron/systemd outputs are bounded.

Expected focused test:

```bash
bun test test/autopilot-interval.test.ts test/autopilot-reconnect-classifier.test.ts
```

Expected result: all tests pass; generated launchd output contains `<key>KeepAlive</key><false/>` and no secret environment block.

## Task 3: Make the persistent spend ledger atomic and pessimistic

**Files:**
- Modify: `src/core/minions/budget-meter.ts`
- Modify: `test/minions/budget-meter.test.ts`

- [ ] Wrap reserve, settle, and expiration changes in `BrainEngine.transaction()`.
- [ ] Acquire `pg_advisory_xact_lock(clientLockKey(clientId))` inside Postgres reserve transactions.
- [ ] Count expired/crashed reservations at their estimate instead of zero, so a process crash cannot restore budget headroom.
- [ ] Insert the settled spend log in the same transaction as the reservation status update.
- [ ] Add tests for pessimistic expiry, idempotent settlement, committed spend, and concurrent reserve refusal.

Expected focused test:

```bash
bun test test/minions/budget-meter.test.ts
```

Expected result: the ledger never authorizes projected daily spend above the cap, including concurrent or crashed calls.

## Task 4: Add a database-backed daily gateway governor

**Files:**
- Create: `src/core/budget/daily-budget.ts`
- Modify: `src/core/budget/budget-tracker.ts`
- Modify: `src/core/ai/gateway.ts`
- Create: `test/ai/gateway-daily-budget.serial.test.ts`

- [ ] Export cost-estimation helpers from `budget-tracker.ts` so the persistent governor uses the same provider pricing maps as phase budgets.
- [ ] Configure the governor after engine connection from `ai.daily_budget_usd`; absent/zero means disabled for backward compatibility, while this installation will be set to `1.50`.
- [ ] Reserve estimated cents before every gateway chat, embedding, and rerank request; fail closed on missing pricing or ledger errors when the cap is enabled.
- [ ] Settle actual usage after success and pessimistic estimated usage after provider failure.
- [ ] Raise the existing budget-exhausted error type before the provider transport is called when the daily ceiling lacks headroom.
- [ ] Add a test seam to reset/configure the governor and transport-stub tests proving preflight refusal happens without an API call.

Expected focused test:

```bash
bun test test/ai/gateway-daily-budget.serial.test.ts test/ai/gateway-chat.test.ts test/embed-input-type-wire.serial.test.ts
```

Expected result: calls from separate gateway scopes share one database-backed daily limit.

## Task 5: Remove retry multiplication

**Files:**
- Modify: `src/core/ai/gateway.ts`
- Modify: `src/commands/autopilot.ts`
- Modify: `src/commands/autopilot-fanout.ts`
- Modify: relevant gateway and autopilot tests

- [ ] Add `maxRetries?: number` to chat options and pass `maxRetries ?? 0` to `generateText`.
- [ ] Pass `maxRetries ?? 0` to `embedMany`; explicit callers retain the ability to opt in.
- [ ] Change autopilot-generated AI-capable minion jobs from `max_attempts: 2` to `max_attempts: 1`.
- [ ] Increase source failure cooldown defaults to at least two hours, capped at one day, while successful work still clears cooldown state.
- [ ] Test that gateway transports get zero retries by default and autonomous jobs get one attempt.

Expected result: one scheduled action can cause at most one provider attempt per gateway call and one autonomous job attempt.

## Task 6: Install, configure, and verify the repaired service

**Files:**
- Modify via generated installer: `/Users/harry/.gbrain/autopilot-run.sh`
- Modify via generated installer: `/Users/harry/Library/LaunchAgents/com.gbrain.autopilot.plist`

- [ ] Run focused tests, TypeScript checks, then the repository’s local diff CI command.
- [ ] Install the verified worktree build into the user’s active GBrain CLI.
- [ ] Set DB config `ai.daily_budget_usd=1.50`, disable optional nightly probes, cap autonomous fanout, and set conservative failure cooldowns.
- [ ] Reinstall launchd from the patched CLI so no API key is stored in the plist.
- [ ] Load the service once, verify the effective command includes both 7,200-second values, and verify launchd reports `KeepAlive=false`.
- [ ] Confirm a second immediate scheduler decision cannot run early, the daily governor can read its cap, and doctor/status remain healthy.
- [ ] Record the remaining manual security action: rotate any provider key that was previously embedded in the old plist.

Final verification:

```bash
bun run typecheck
bun run ci:local:diff
gbrain autopilot --status --json
gbrain doctor --json
```

Expected result: autopilot is loaded with a hard two-hour minimum, fails stopped, makes no automatic retries, and refuses paid AI calls after $1.50 of reserved/settled daily spend.
