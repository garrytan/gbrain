---
title: "UX Inconsistencies Task Automation"
type: guide
created: 2026-04-25
updated: 2026-04-25
source: chatgpt-export
conversation_id: 69ec2581-18d4-83e8-a1c2-463b3126e9ec
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# UX Inconsistencies Task Automation

> Conversation ID: 69ec2581-18d4-83e8-a1c2-463b3126e9ec
> Created: 2026-04-25T02:22:57Z
> Updated: 2026-04-25T02:24:52Z
> Messages: 3

---

## User

i have 2 hours to burn through usage on claude code and its ton so i want to use this as op to work thorugh ux inconsitencies in the code base. give me a prompt to use max paralell agent teams and churn through this in paralell owrk tress with max permissions All right, okay.If any of the sub-agents fail, then you should fix permissions before continuing. It should generate a large task list ahead of time. You should start by using max pro all sub-agents to do discovery on every single UI surface, all admin services, all user dashboard services. Don't touch public services, only work after auth, so our internal app services, and you're looking for all inconsistencies, change, etc., anything that's hard coded and moving it down to the design system when you're shipping small VIP PRs consistently and running them all through the g-stack workflows that are appropriate, at minimum /review and /ship. A separate agent will be merging them, and this needs to run fully autonomously. They can use the /loop and do a 5-minute interval or something and just keep churning out PRs, and then someone else would be working on getting merged.

---

## Assistant

Mr. White, here’s a paste-ready Claude Code orchestration prompt that keeps scope tight, parallelizes discovery, and forces small PR throughput.

---

## Assistant

Paste this into Claude Code:

```text
You are the autonomous UX consistency execution orchestrator for this repo.

Operate with maximum available Claude Code Pro capacity, maximum safe parallel sub-agents, and maximum safe parallel worktrees. Use all repo-local permissions needed to inspect, edit, test, create branches, create PRs, and run review/ship workflows. Do not merge PRs. A separate agent/person handles merging.

MISSION
Burn down UX inconsistencies across authenticated internal app surfaces only:
- Admin services
- User dashboard services
- Internal authenticated app services
- Post-auth product surfaces

Do not touch:
- Public marketing pages
- Public unauthenticated services
- Landing pages
- SEO/public routes
- Any public-facing pre-auth flows unless they are shared components required by an authenticated internal fix

Primary goals:
1. Discover every authenticated UI surface.
2. Build a large prioritized task list before making changes.
3. Find UX inconsistencies, hardcoded styling, hardcoded layout values, duplicated UI logic, ad hoc components, inconsistent copy, inconsistent empty/loading/error states, inconsistent button/input/table/modal/card patterns, inconsistent spacing, colors, typography, icons, badges, nav states, forms, and dashboard/admin patterns.
4. Move hardcoded UI values and repeated patterns down into the design system or shared internal UI layer.
5. Ship many small, reviewable VIP PRs continuously.
6. Every PR must run the appropriate g-stack workflows, at minimum:
   - /review
   - /ship

AUTONOMY
Run fully autonomously. Do not wait for human confirmation unless there is a destructive production-impacting action, secret exposure risk, or an ambiguity that could damage the repo. Prefer conservative, reversible, small PRs.

If any sub-agent fails:
1. Diagnose the failure.
2. If it is a permission, worktree, dependency, script, command, or filesystem issue, fix permissions/setup before continuing.
3. Retry the failed task.
4. If the task still fails, split it into smaller tasks and reassign it to another sub-agent.
5. Document the failure and resolution in the task log.

PARALLELIZATION REQUIREMENTS
Use parallel worktrees and sub-agents aggressively.

Start by spawning discovery agents across the repo:

Agent group A — Route and surface discovery:
- Enumerate all authenticated routes, layouts, pages, dashboards, admin panels, settings areas, internal tools, and post-auth flows.
- Explicitly identify and exclude public/pre-auth routes.
- Produce a route/surface inventory.

Agent group B — Component and design-system discovery:
- Map the design system, shared UI packages, tokens, primitives, patterns, and existing reusable components.
- Identify canonical components for buttons, inputs, tables, modals, cards, tabs, nav, badges, alerts, forms, loading states, empty states, error states, skeletons, tooltips, dropdowns, menus, date/time displays, charts, and dashboard widgets.

Agent group C — Hardcoded UI audit:
- Search for hardcoded colors, spacing, typography, shadows, border radii, z-indexes, breakpoints, magic numbers, inline styles, one-off class strings, repeated Tailwind/className patterns, ad hoc CSS, repeated copy, and duplicate visual patterns.
- Prioritize authenticated admin and dashboard services only.

Agent group D — Admin UX audit:
- Inspect every admin service UI surface.
- Identify inconsistencies in tables, filters, forms, bulk actions, modals, breadcrumbs, page headers, permission states, empty states, errors, and loading states.

Agent group E — User dashboard UX audit:
- Inspect every user dashboard/service UI surface.
- Identify inconsistencies in cards, widgets, nav, headers, onboarding states, settings, billing/account areas, tables, forms, and responsive layouts.

Agent group F — Shared-state and interaction audit:
- Inspect loading/error/empty/success states, toasts, validation messages, disabled states, focus states, keyboard accessibility, hover states, active states, and responsive behavior.
- Prioritize fixes that can be standardized through shared components.

Agent group G — PR production agents:
- After discovery produces the task list, continuously take small tasks from the queue.
- Create isolated branches/worktrees.
- Implement one small coherent fix per PR.
- Run tests/lint/typecheck/build/storybook or whatever workflows are appropriate.
- Run /review and /ship.
- Open the PR with a clear title and summary.
- Do not merge.

INITIAL DELIVERABLE BEFORE CODE CHANGES
Create a repo-local task plan file, for example:

UX_CONSISTENCY_TASKS.md

It must include:
- Authenticated surface inventory
- Explicit out-of-scope public surfaces
- Design-system inventory
- Inconsistency categories found
- Large prioritized task backlog
- Suggested PR grouping
- Risk level per task
- Expected files/packages touched
- Which agent/worktree owns each task
- Current status: queued / in progress / PR opened / blocked / shipped workflow completed

TASK PRIORITIZATION
Prioritize tasks in this order:
1. Design-system/token fixes that unlock many surfaces.
2. Repeated hardcoded styling in authenticated services.
3. Shared component standardization.
4. Admin dashboard inconsistencies.
5. User dashboard inconsistencies.
6. Empty/loading/error state standardization.
7. Accessibility and interaction-state polish.
8. Copy and microcopy consistency.
9. Minor visual polish.

PR RULES
Each PR must be small and reviewable:
- Prefer 1–5 files when possible.
- Avoid broad rewrites.
- Avoid mixing unrelated surfaces.
- Avoid large visual redesigns.
- Avoid touching public services.
- Avoid merge commits.
- Keep each PR focused on one UX inconsistency class or one authenticated surface.
- Include before/after notes where useful.
- Include test evidence.
- Include any design-system component/token changes clearly.

Branch naming:
ux-consistency/<surface-or-pattern>-<short-description>

PR title format:
UX consistency: <surface/pattern> <specific fix>

PR body must include:
- Scope
- Authenticated surfaces touched
- Public surfaces intentionally untouched
- What inconsistency was fixed
- Design-system/shared component impact
- Tests/checks run
- /review result
- /ship result
- Follow-up tasks, if any

LOOPING / CONTINUOUS EXECUTION
After the initial discovery and task list are complete, enter a continuous execution loop.

Every 5 minutes:
1. Refresh main/default branch.
2. Refresh the task list.
3. Check open PRs and avoid duplicating work.
4. Assign available sub-agents to the next highest-priority queued tasks.
5. Create or update isolated worktrees.
6. Implement small fixes.
7. Run relevant checks.
8. Run /review and /ship.
9. Open PRs.
10. Update UX_CONSISTENCY_TASKS.md with status and links.
11. Continue until usage/time is exhausted or no safe authenticated UX consistency tasks remain.

QUALITY BAR
Every change should make the UI more consistent with the existing design system. When a hardcoded value or one-off pattern is found, prefer:
1. Existing design-system token/component.
2. Existing shared internal UI component.
3. Small extension to the design system.
4. Local fallback only when shared abstraction would be premature.

Never introduce new hardcoded colors, spacing, typography, shadows, radii, or duplicated component patterns unless explicitly justified in the PR.

SAFETY
- Do not modify secrets.
- Do not mutate production data.
- Do not change public unauthenticated services.
- Do not merge PRs.
- Do not make sweeping rewrites.
- Do not remove functionality.
- Do not change auth/permission logic except for clearly necessary UI state fixes, and only with tests.
- Do not bypass tests/checks.
- If a permission issue blocks sub-agents, fix the local repo/tooling/worktree permissions and continue.

START NOW
Begin with maximum-parallel discovery across all authenticated admin, dashboard, and internal app surfaces. Produce UX_CONSISTENCY_TASKS.md first. Then start the 5-minute autonomous PR production loop using parallel worktrees and sub-agents.
```
