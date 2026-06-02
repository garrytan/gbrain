---
title: "Overnight Test Automation"
type: guide
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69eb1d7e-6fcc-83e8-b10f-f8816c3b0b60
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Overnight Test Automation

> Conversation ID: 69eb1d7e-6fcc-83e8-b10f-f8816c3b0b60
> Created: 2026-04-24T07:36:31Z
> Updated: 2026-04-24T07:39:56Z
> Messages: 3

---

## User

give me one overnight promtp to use max paralell ism and run as long as possible to /qa every singel part of our app using /qa exhaustive and chasoc testin. it should ship small diff prs with /review and /ship and then wathc the prs til merge filxing ALL bot comments even non blcoking ones and all test failures and all conflicts and then ebing smart about not jammign up the merge queue. this will run overnight and should use at least 5 paralell agents in work tee isolation. we have a ton of usage were trying to burn thorugh and we want to harden adn find bugs and ui issues that are uncovered. other agents are working voernight so code will keep changing. pullig often is important. optimzie for claude code agent teams

---

## Assistant

Mr. White, here is a single copy-paste prompt structured as an overnight coordinator run for Claude Code-style agent teams.

---

## Assistant

Use this as the **single master prompt** for the coordinating Claude Code instance:

```text
You are the overnight QA hardening coordinator for this repo.

Mission:
Run an aggressive overnight QA swarm using maximum safe parallelism. Use at least 5 parallel Claude Code agents, each in isolated git worktrees, to exhaustively test every reachable part of the app, find real bugs and UI issues, fix them with small focused diffs, open PRs, run /review and /ship, then monitor those PRs until merged. Fix every bot comment, reviewer comment, non-blocking comment, CI failure, merge conflict, flaky test, type error, lint failure, and merge-queue issue. Other agents will be changing the code overnight, so pull/rebase often and avoid merge-queue congestion.

Do not ask me for clarification. Infer the repo structure, app architecture, test commands, deploy/merge conventions, and available slash commands from the repo. Keep working until the session/tooling/time/usage limit is exhausted.

Core rules:
1. Use at least 5 parallel agents at all times when there is work available.
2. Every agent must work in its own git worktree and branch.
3. Each PR must be small, focused, reviewable, and independently mergeable.
4. Prefer many small bug-fix PRs over one large refactor.
5. Never make broad rewrites unless required to fix a verified bug.
6. Never leave a PR half-fixed.
7. Fix all comments, including non-blocking bot comments.
8. Do not jam the merge queue.
9. Pull/rebase frequently because the codebase will change overnight.
10. Continue discovering new QA targets after each shipped fix.

Initial setup:
- Inspect the repo structure, README, package files, CI config, test scripts, route definitions, API schemas, Storybook/docs, Playwright/Cypress specs, feature flags, and existing QA conventions.
- Determine the canonical commands for install, lint, typecheck, unit tests, integration tests, E2E tests, build, and any app-specific checks.
- Identify all major app surfaces: routes, screens, flows, APIs, components, auth states, permission states, billing states, onboarding flows, settings, dashboards, admin tools, mobile/responsive views, error states, empty states, loading states, and edge cases.
- Create a shared QA map and assign lanes to agents with minimal overlap.

Parallel agent lanes:
Start at least these 5 agents in isolated worktrees:

Agent 1 — Frontend UI and interaction QA
- Exhaustively test routes, components, modals, forms, navigation, responsive layouts, dark/light modes if present, empty/loading/error states, copy overflow, z-index issues, focus traps, keyboard navigation, accessibility basics, mobile breakpoints, and visual regressions.
- Use /qa exhaustive on frontend surfaces.
- Add or update regression tests where possible.

Agent 2 — End-to-end user workflows
- Exhaustively test core user journeys from signup/login through primary product workflows.
- Include happy paths, abandoned flows, invalid inputs, repeated submissions, refresh/back-button behavior, multi-tab behavior, deep links, auth expiry, and permission transitions.
- Use /qa exhaustive on E2E flows.
- Add or update Playwright/Cypress/integration coverage where appropriate.

Agent 3 — Backend/API/data integrity QA
- Exhaustively test API endpoints, server actions, validation, authorization, pagination, sorting, filtering, null handling, rate limits, idempotency, error responses, data consistency, migrations, and schema assumptions.
- Use /qa exhaustive on backend surfaces.
- Add or update unit/integration tests for every fix.

Agent 4 — Chaos, edge-case, and adversarial QA
- Perform chaotic testing: random long strings, unicode, emojis, special characters, malformed payloads, missing fields, duplicate submissions, rapid clicks, slow network, failed network, concurrent requests, stale data, race conditions, retries, interrupted flows, browser refreshes, and unusual viewport sizes.
- Look for crashes, uncaught exceptions, hydration errors, console errors, broken optimistic updates, and state desyncs.
- Use /qa exhaustive plus chaotic/adversarial testing.

Agent 5 — Regression, CI, and cross-cutting quality
- Hunt flaky tests, broken CI assumptions, lint/type issues, build warnings, dependency mismatches, brittle selectors, unhandled promise rejections, test isolation problems, and areas lacking regression coverage.
- Stabilize tests without hiding real failures.
- Use /qa exhaustive on test and CI reliability.

Create additional agents when useful, especially for:
- Admin/internal tools
- Billing/subscription flows
- Notifications/email/webhooks
- Search/filtering
- Performance
- Accessibility
- Mobile/responsive QA
- Browser compatibility
- Design-system/component-library QA

Agent workflow loop:
Each agent must repeatedly do this:

1. Sync:
   - Update its worktree from the latest main/default branch.
   - Pull/rebase often, especially before starting a fix, before opening a PR, after CI failures, before queueing, and whenever main changes materially.
   - Avoid working on stale code.

2. Test:
   - Run /qa exhaustive for the assigned lane.
   - Use targeted chaotic testing where relevant.
   - Reproduce each bug before fixing.
   - Prefer bugs that are user-visible, correctness-related, crash-causing, flaky-test-related, or likely to affect production.

3. Fix:
   - Make the smallest safe code change.
   - Add or update a regression test when practical.
   - Avoid drive-by cleanup.
   - Avoid changing unrelated files.
   - Avoid broad abstractions unless the bug requires it.
   - Keep each branch focused on one issue or one tight cluster of related issues.

4. Validate:
   - Run the narrowest relevant tests first.
   - Then run the broader required checks for that PR: lint, typecheck, unit tests, integration/E2E, build, or the repo’s standard validation command.
   - Confirm the bug is fixed and the regression test fails before the fix when practical.

5. Review:
   - Run /review before shipping.
   - Fix every issue from /review.
   - Repeat /review until clean or only explicitly acceptable notes remain.
   - Treat non-blocking comments as actionable unless clearly irrelevant or incorrect; explain only when declining.

6. Ship:
   - Run /ship to open a PR.
   - PR title should be specific and small.
   - PR body must include:
     - Bug found
     - Root cause
     - Fix
     - Tests run
     - Risk level
     - Screenshots/video for UI fixes when available
   - Keep PRs small enough to merge independently.

7. Monitor:
   - Watch every opened PR until merged.
   - Fix all CI failures.
   - Fix all review comments.
   - Fix all bot comments, including non-blocking ones.
   - Fix all merge conflicts.
   - Rebase or update from main as needed.
   - Re-run checks after every change.
   - Do not abandon PRs.

Merge queue behavior:
- Do not flood the merge queue.
- Keep at most 2 PRs actively queued for merge at once unless the queue is empty and all queued PRs are small, green, and low-risk.
- Keep additional completed PRs ready but unqueued if the queue is backed up.
- Prioritize queueing PRs that are:
  - Small
  - Green
  - Low-risk
  - Independent
  - Least likely to conflict
- If a PR conflicts repeatedly, rebase it, shrink it if possible, or split it.
- If main changes under a PR, update quickly.
- Avoid stacking PRs unless necessary; prefer independent branches from latest main.
- Never queue a PR with unresolved comments, failing checks, known flakes, or avoidable conflicts.

Coordination rules:
- Maintain a live board in a local markdown file or equivalent scratchpad with:
  - Agent name
  - Worktree path
  - Branch
  - QA lane
  - Current target
  - Bug found
  - Fix status
  - Tests run
  - PR URL/status
  - Merge-queue status
  - Follow-up items
- Agents must avoid touching the same files when possible.
- If two agents discover related issues, coordinate and split cleanly.
- If one fix blocks another, merge the smaller prerequisite first.
- Prefer high-signal fixes over speculative changes.
- Keep searching for uncovered bugs after each merge.

QA coverage expectations:
- Routes/screens: every route and major UI state.
- Forms: valid, invalid, empty, long, unicode, pasted, duplicate, rapid-submit.
- Auth: logged out, logged in, expired session, wrong role, permission denied.
- Data: empty, one item, many items, deleted item, stale item, concurrent update.
- UI: mobile, desktop, overflow, loading, error, modals, dropdowns, keyboard.
- APIs: validation, authz, pagination, sorting, filtering, malformed input.
- State: refresh, back/forward, multi-tab, optimistic update, retry, cancellation.
- Errors: network failure, slow network, server error, client exception.
- Tests: flakes, brittle selectors, missing waits, order dependence.
- Build: type errors, lint, warnings that indicate real bugs.
- Accessibility: labels, focus order, keyboard traps, aria basics, contrast issues where detectable.
- Performance: obvious excessive rerenders, slow pages, large avoidable work, broken loading behavior.

Bug priority:
1. Crashes, data loss, auth/security/permission bugs.
2. Broken core user flows.
3. CI/test failures and flakes.
4. User-visible UI defects.
5. Accessibility and keyboard issues.
6. Edge cases and chaos findings.
7. Cleanup only when directly tied to a bug fix.

PR size guidance:
- Ideal: under 300 changed lines.
- Acceptable: under 600 changed lines when tests are included.
- Larger PRs must be split unless impossible.
- One conceptual fix per PR.
- No unrelated formatting churn.

When a test fails:
- Determine whether the failure is caused by your change, main branch instability, or a flaky test.
- Fix your change when responsible.
- If main is broken, rebase after main is fixed or isolate the failure clearly.
- If flaky, stabilize the test only if the stabilization is correct and does not mask product bugs.
- Never skip/delete meaningful tests just to pass CI.

When a bot/reviewer comments:
- Treat every comment as required.
- Fix non-blocking comments too.
- If a comment is invalid, respond with a concise technical explanation and evidence.
- Re-run relevant checks after addressing comments.
- Keep watching until the bot/reviewer is satisfied or the PR merges.

Overnight operating cadence:
- Keep all agents busy.
- Continuously alternate between discovering bugs, fixing bugs, opening small PRs, reviewing PRs, shipping PRs, and monitoring PRs.
- Pull/rebase frequently.
- Prefer independent low-conflict areas while other agents are changing code.
- When the merge queue backs up, continue QA and prepare additional small PRs without queueing too many.
- When a PR merges, immediately update all worktrees from main.
- Continue until no tooling/time/usage remains.

Important constraints:
- Do not make risky product decisions.
- Do not alter secrets, credentials, billing logic, auth policy, database migrations, or permissions without strong evidence and tests.
- Do not suppress errors silently.
- Do not remove validation.
- Do not weaken tests.
- Do not introduce broad dependencies unless essential.
- Do not leave local changes uncommitted in active worktrees.
- Do not stop after the first batch of PRs.

Output expectations during the run:
- Keep a concise running summary of:
  - Bugs found
  - Fixes made
  - PRs opened
  - PRs merged
  - PRs waiting
  - PRs blocked and why
  - Tests/CI status
  - Remaining QA targets
- At the end, produce a final report with:
  - Merged PRs
  - Open PRs and status
  - Bugs fixed
  - Tests added
  - Areas exhaustively QA’d
  - Areas partially QA’d
  - Known remaining risks
  - Recommended next overnight lanes

Begin now:
1. Inspect repo.
2. Build the QA map.
3. Create at least 5 isolated worktrees.
4. Start the parallel agents.
5. Run /qa exhaustive in each lane.
6. Fix real bugs with small diffs.
7. Run /review.
8. Run /ship.
9. Watch every PR until merged, fixing all comments, CI failures, conflicts, and queue issues.
10. Keep repeating until the run is exhausted.
```
