---
title: "Dev Server Testing Optimization"
type: note
created: 2026-03-01
updated: 2026-03-01
source: chatgpt-export
conversation_id: 69a3a473-647c-8331-975e-a661a0c009e5
message_count: 6
tags: [chatgpt, import, long-form]
---
# Dev Server Testing Optimization

> Conversation ID: 69a3a473-647c-8331-975e-a661a0c009e5
> Created: 2026-03-01T02:29:15Z
> Updated: 2026-03-01T03:17:36Z
> Messages: 6

---

## User

run a dev server and hit every rooute that is a public page or a user faceing dashbaord or admin dashboard.

check for console errors - fix
run e2e smoke - fix erors. do not skip test because of any issue
run chaos testing against public profiles and golden path. - fix
loop til all green.

improve this prompt and optimzie for gemini 3.1 pro high thinking

---

## Assistant

I’ll tighten the request into a single, execution-focused prompt and align it for a high-reasoning model. I’m also verifying the model naming so I do not optimize around a misnamed target.

---

## Assistant

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
- the final verification run is clean

Output format:
Provide concise progress updates as you work. At the end, report:
1. routes covered
2. issues found
3. fixes made
4. tests executed
5. final pass/fail status for:
   - route sweep
   - console
   - e2e smoke
   - chaos testing
6. any remaining blockers

Completion rule:
Do not end with blockers unless they are truly unavoidable. Continue debugging until there are none.

A tighter version, if you want it even more forceful:

Run the app to green. Start the dev server, discover and test every public route, every user-facing dashboard route, and every admin dashboard route. Visit each route in a browser, detect all console/runtime/network/UI issues, fix root causes, and retest. Then run e2e smoke and fix every failure without skipping, weakening, or bypassing tests. Then run chaos testing against public profiles and the golden path, fix every exposed issue, and rerun. Continue looping through route sweep, console validation, e2e smoke, and chaos testing until all are fully passing with zero known failures and zero remaining console errors. Treat flakiness as a defect. Use real fixes, not workarounds. End only after a final clean verification pass and report routes covered, issues fixed, and final status.

For Gemini 3.1 Pro specifically, this version works better because it gives:
- explicit success criteria
- a strict loop condition
- hard constraints against test dodging
- ordered phases for multi-step reasoning
- a required reporting structure for agentic execution

**If you want, I can also make this more specific for Cursor, Claude Code, Codex CLI, or a browser-use agent.**

---

## User

claude code with agent teams

---

## Assistant

I’m tailoring it to Claude Code’s workflow and checking the current Anthropic terminology so the prompt matches how the tool actually frames subagents/parallel work.

---

## Assistant

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
- If seeded data is required, create it.
- If a route is broken or unreachable, fix the blocking defect and retry.
- Treat flaky behavior as a real bug and eliminate it.
- Fix underlying causes. Do not apply cosmetic workarounds that leave the defect intact.
- Do not force green by changing assertions to be weaker, mocking away failures, disabling checks, or marking failures as expected.
</execution_rules>

<validation_scope>
For every eligible route:
1. Load the route in a browser.
2. Confirm it renders successfully.
3. Check console and network health.
4. Check core interactions needed for the page to be considered viable.
5. Fix issues immediately.
6. Revisit the route after the fix.

For smoke testing:
1. Run the complete e2e smoke suite.
2. Fix every failure.
3. Rerun until the suite passes cleanly.

For chaos testing:
1. Stress public profiles.
2. Stress the golden path.
3. Fix every issue exposed.
4. Rerun until chaos scenarios pass cleanly.
</validation_scope>

<loop_condition>
Repeat this cycle until all of the following are true:
- every target route has been discovered and exercised
- every target route loads successfully
- no browser console errors remain on any tested route
- no critical network failures remain on any tested route
- e2e smoke passes completely
- chaos testing for public profiles passes completely
- chaos testing for the golden path passes completely
- no regressions were introduced
- no known defects remain open
</loop_condition>

<tracking>
Maintain a live defect log with:
- issue ID
- affected route or test
- reproduction
- root cause
- fix applied
- verification status

Maintain a live coverage log with:
- route inventory
- routes completed
- routes still unverified
- smoke suite status
- chaos suite status
</tracking>

<output_style>
Provide concise progress updates as work proceeds.
At the end, report:
1. total routes discovered
2. routes covered
3. issues found
4. fixes applied
5. tests executed
6. final status for:
   - route sweep
   - console health
   - network health
   - e2e smoke
   - chaos: public profiles
   - chaos: golden path
7. any remaining blocker

Do not conclude successfully unless the final verification pass is clean.
If something fails, keep debugging until it is resolved.
</output_style>
:::

Two small upgrades for Claude Code:
- Run it on **Opus** for this task class, since Anthropic positions Opus as the alias for complex reasoning. citeturn0search6
- If you have reusable team roles, store them as **subagents/skills** so Claude can delegate consistently across sessions and projects. citeturn0search0turn0search8

If you want, I can also turn this into:
- a **shorter “paste into terminal” version**
- a **`.claude/skills/` setup**
- a **multi-agent role pack** with custom subagent prompts for each role.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_accessing-localhost-server]]
- [[chatgpt/chatgpt_bartender-server-cover-letter]]
- [[chatgpt/chatgpt_clerk-mcp-server]]
- [[chatgpt/chatgpt_mcp-server-for-iap]]
- [[chatgpt/chatgpt_neon-mcp-server-url]]
