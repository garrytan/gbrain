---
title: "Dev Server Testing Optimization"
type: guide
created: 2026-03-01
updated: 2026-03-01
source: chatgpt-export
topic: coding-general
message_count: 6
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# Dev Server Testing Optimization

> **Source:** ChatGPT conversation
> **Date:** 2026-03-01T02:29:15Z
> **Messages:** 6
> **Topic:** coding-general

## Question

run a dev server and hit every rooute that is a public page or a user faceing dashbaord or admin dashboard.

check for console errors - fix
run e2e smoke - fix erors. do not skip test because of any issue
run chaos testing against public profiles and golden path. - fix
loop til all green.

improve this prompt and optimzie for gemini 3.1 pro high thinking

## Answer

I’ll tighten the request into a single, execution-focused prompt and align it for a high-reasoning model. I’m also verifying the model naming so I do not optimize around a misnamed target.

## Answer

Gemini 3.1 Pro is a valid target, and Google describes it as a strong fit for complex reasoning, software engineering, and agentic multi-step execution. Google also says Gemini 3 Pro Preview is deprecated in favor of Gemini 3.1 Pro Preview. citeturn0search0turn0search2turn0search3

Use this revised prompt:

You are acting as a senior QA + full-stack debugging agent. Execute the entire validation and repair loop until the app is fully green.

Objective:
Start the local dev environment, systematically test every public route, every user-facing dashboard route, and every admin dashboard route, then fix all issues found. Continue until all checks pass with zero known failures.

Execution rules:
1. Start the dev server and confirm it is healthy.
2. Discover all routes that are:
   - public pages
   - authenticated user dashboard pages
   - admin dashboard pages
3. Visit every eligible route in a browser.
4. For each route:
   - capture console errors, network failures, runtime exceptions, hydration issues, auth/redirect issues, and obvious broken UI states
   - fix the root cause, not the symptom
   - rerun that route after each fix
5. Run end-to-end smoke tests.
6. Fix every failure. Do not skip, delete, weaken, or bypass tests for any reason.
7. Run chaos testing focused on:
   - public profile pages
   - the primary golden path user journey
8. Fix every issue exposed by chaos testing.
9. Repeat the full cycle until all of the following are true:
   - all target routes load successfully
   - no browser console errors remain on any tested route
   - e2e smoke tests pass completely
   - chaos tests pass completely
   - no regressions were introduced

Constraints:
- Do not ask for permission before acting.
- Do not stop at the first pass.
- Do not skip routes because they are flaky, slow, or hard to access.
- Do not mark failures as acceptable.
- Do not disable assertions, mock away real failures, or change tests just to force green.
- Fix underlying defects in application code, config, data flow, selectors, timing, and test stability as needed.
- If auth is required, create or use valid test users/admins and continue.
- If a route is unreachable due to a bug, fix the bug and retry.
- Keep iterating until everything is green.

Working method:
- Think through the task in phases: route discovery, route validation, error triage, repair, regression check, final verification.
- Maintain a running defect list with:
  - issue
  - affected route/test
  - root cause
  - fix applied
  - verification result
- After each fix, rerun the smallest relevant validation first, then rerun broader regression coverage.
- Prefer deterministic fixes over retries.
- Treat flaky behavior as a bug to diagnose and eliminate.

Success criteria:
The task is complete only when:
- every relevant route has been exercised
- every detected console error has been resolved
- e2e smoke is fully passing
- chaos testing on public profiles and the golden path is fully passing
- the fina

*(Answer truncated — 4646 chars total)*

## Question

claude code with agent teams

## Answer

I’m tailoring it to Claude Code’s workflow and checking the current Anthropic terminology so the prompt matches how the tool actually frames subagents/parallel work.

## Answer

For Claude Code, this is stronger when it explicitly tells the coordinator to use **agent teams** for parallel work across separate sessions, which is how Anthropic distinguishes them from subagents. Anthropic also recommends **Opus** for complex reasoning tasks. citeturn0search0turn0search6

Paste this into Claude Code:

:::writing{id="51231" variant="standard"}
You are the lead coordinator in Claude Code. Use **agent teams** to execute this as a parallel, end-to-end validation and repair loop. Continue until the application is fully green with zero known failures.

<objective>
Start the local dev environment, discover and exercise every:
- public page
- authenticated user-facing dashboard page
- admin dashboard page

Then fix all issues found, rerun validation, and keep looping until every required check passes cleanly.
</objective>

<team_structure>
Create and manage an agent team with these roles:

1. Route Discovery Agent
- Identify every public route, user dashboard route, and admin route from the codebase, router config, nav structures, tests, and known entry points.
- Produce a definitive route inventory.
- Mark auth requirements and expected data dependencies for each route.

2. Route Sweep Agent
- Start the dev server and confirm it is healthy.
- Visit every route in a browser.
- Record page-load failures, redirects, 404s, auth issues, broken rendering, hydration issues, runtime exceptions, and obvious UI breakage.

3. Console + Network Agent
- For each visited route, inspect:
  - browser console errors
  - warnings that indicate real defects
  - failed network requests
  - CORS issues
  - asset load failures
  - unhandled promise rejections
- Trace each issue to root cause.

4. E2E Smoke Agent
- Run the full smoke suite.
- Diagnose and fix every failure.
- Do not skip, delete, weaken, quarantine, or bypass any test.

5. Chaos Agent
- Run chaos testing against:
  - public profile pages
  - the primary golden-path user journey
- Introduce realistic instability where appropriate: delayed responses, partial failures, retries, missing optional data, race conditions, and transient backend issues.
- Expose fragile assumptions and report failures.

6. Repair Agent
- Fix root causes in application code, config, auth, fixtures, selectors, waits, state handling, error boundaries, API integration, and test setup.
- Prefer deterministic fixes over retries.

7. Regression Agent
- After each fix, rerun the smallest relevant check first.
- Then rerun broader regression coverage to ensure no regressions were introduced.

8. Verification Agent
- Run the final full pass only after all known issues are resolved.
- Confirm the whole system is green.
</team_structure>

<execution_rules>
- Work in parallel where possible, but keep one shared source of truth for defects and status.
- Do not stop after one pass.
- Do not ask for permission before acting.
- Do not skip hard-to-reach routes.
- If auth is required, create or use valid test users and admins.
-

*(Answer truncated — 5813 chars total)*
