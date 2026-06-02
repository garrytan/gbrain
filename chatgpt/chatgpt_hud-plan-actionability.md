---
title: "HUD Plan Actionability"
type: note
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fe2f5f-eed4-83e8-a343-336ef325c21b
message_count: 2
tags: [chatgpt, import, long-form]
---
# HUD Plan Actionability

> Conversation ID: 69fe2f5f-eed4-83e8-a343-336ef325c21b
> Created: 2026-05-08T18:45:52Z
> Updated: 2026-05-08T18:53:25Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_0000000001c871f5914acc75ae8dc435', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 854405, 'width': 2048}
This is what is available for the HUD, which obviously is in GSC, but all that's going to trigger it to be a plan that turns into something that's more just more actionable and sits within the actual app. 

---

## Assistant

Mr. White, turn the HUD into an **in-app Ops Cockpit** by making every tile emit an actionable item.

The current HUD is good as a **status wallboard**. The next version should live inside the app shell as a **decision queue**.

## Product shape

Keep:

`/hud` = passive wallboard / kiosk / phone view

Add or upgrade:

`/app/admin/ops` or Conductor = actionable cockpit

Core layout:

1. **Top summary**
   - MRR
   - subscribers
   - runway
   - deploy state
   - reliability
   - active blockers

2. **Attention queue**
   - each alert, deploy, failed check, blocker, stale PR, missing env var, or agent task becomes a row
   - sorted by severity and business impact

3. **Detail drawer**
   - what happened
   - why it matters
   - owner
   - suggested next action
   - linked PR / issue / runbook / deployment

4. **Chief of Staff panel**
   - Hermes summarizes the state
   - proposes the next 3 actions
   - flags what requires human approval

5. **Approval gates**
   - auth
   - billing
   - migrations
   - production deploys
   - outbound messaging
   - spend

## Convert each HUD tile into actions

| HUD area | Current state | In-app action |
|---|---:|---|
| MRR / subscribers | `$0.00`, `0 subscribers` | Show billing source, Stripe sync state, last successful revenue pull, and “verify launch monetization path.” |
| Runway | Cash/burn shown as `$0.00` | Add source/provenance. Treat the operating cash truth as `$400` until CFO verification replaces it. |
| Operations | Healthy, DB latency `304ms` | Create reliability action when latency crosses threshold or source data is stale. |
| Reliability | `0.00%`, p95 `311ms` | Fix metric definition. Reliability cannot use a placeholder-like value beside a valid p95. |
| Deployments | Deploy not configured | First actionable blocker: configure repo/deploy env linkage. |
| Hermes control plane | Not configured | Turn into agent PR queue once GitHub/Vercel envs are present. |
| Blockers | Missing repo env config | Promote blocker into top queue item with exact env vars and owner. |
| QR phone view | Useful kiosk link | Keep passive; no need to make this a core workflow. |

## Immediate blocker

The HUD already tells you the first step:

`HUD_GITHUB_OWNER/HUD_GITHUB_REPO` or `VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG` must be configured.

That unlocks:

- deploy history
- recent runs
- PR queue
- blocked worker runs
- stale PR detection
- failed deploy visibility
- Hermes dispatch state

## Implementation plan as small PRs

### PR 1 — Wire repo/deploy config

Goal: remove “Deploy not configured.”

Add config resolution order:

1. `HUD_GITHUB_OWNER`
2. `HUD_GITHUB_REPO`
3. fallback to `VERCEL_GIT_REPO_OWNER`
4. fallback to `VERCEL_GIT_REPO_SLUG`

Acceptance:

- HUD shows repo identity
- deploy panel shows recent runs or a clear “no runs found”
- Hermes control plane no longer says `not_configured` when envs exist

### PR 2 — Create normalized Ops Action model

Every HUD signal should produce an action object:

- `id`
- `severity`
- `source`
- `title`
- `summary`
- `status`
- `owner`
- `recommended_action`
- `requires_approval`
- `linked_pr`
- `linked_deploy`
- `linked_issue`
- `created_at`
- `updated_at`

Statuses:

- queued
- investigating
- fixing
- verifying
- ready-for-pr
- blocked
- shipped
- dismissed

### PR 3 — Add in-app Ops Cockpit

Route:

`/app/admin/ops`

Use existing app shell primitives.

Sections:

- Attention Queue
- Deployments
- Reliability
- Revenue
- Hermes Agents
- Blockers
- Approvals

Acceptance:

- status tiles remain at top
- clicking a tile filters the queue
- clicking a queue item opens detail drawer
- no wallboard-only dead ends

### PR 4 — Add action detail drawer

Each row should answer:

- What happened?
- Why does it matter?
- What should happen next?
- Who owns it?
- Is approval required?
- What artifact will prove completion?

For example:

**Deploy not configured**

Recommended action:

“Set `HUD_GITHUB_OWNER` and `HUD_GITHUB_REPO`, then verify `/api/hud/metrics` returns deploy metadata.”

Proof:

“Deployments panel shows latest Vercel/GitHub run.”

### PR 5 — Add Hermes summary layer

Hermes should read the normalized action queue and produce:

- top 3 risks
- top 3 next actions
- blocked work
- stale work
- human approvals needed
- estimated business impact

Keep Hermes as router/chief-of-staff. Codex or specific workers execute repo changes.

### PR 6 — Add approval gates

Hard rules:

- production deploys require human approval
- billing changes require human approval
- auth changes require human approval
- DB migrations require human approval
- outbound messages require human approval
- spend requires human approval

In the UI, these should show as explicit approval chips, not hidden policy.

### PR 7 — Add event source

Local-first event source:

- `.hermes/events.jsonl`, or
- SQLite-backed event table

Minimum event types:

- `deploy.started`
- `deploy.succeeded`
- `deploy.failed`
- `pr.opened`
- `pr.stale`
- `agent.started`
- `agent.blocked`
- `agent.completed`
- `metric.threshold_crossed`
- `approval.required`
- `approval.granted`
- `approval.denied`

## The actual app version

The app should feel like this:

**“What needs my attention right now?”**

Then:

1. Show the top blocker.
2. Explain why it matters.
3. Recommend the next action.
4. Link to the artifact.
5. Track whether it shipped.

For the screenshot shown, the top action would be:

**Configure deployment/repo linkage**

Severity: High  
Source: HUD / Hermes Dispatch  
Reason: Deployments and agent PR tracking are unavailable.  
Action: Set GitHub or Vercel repo env vars.  
Approval: No approval needed.  
Proof: Deployments panel shows recent runs and Hermes control plane exits `not_configured`.

## V1 success criteria

The HUD becomes useful when it can answer:

- What is broken?
- What is blocked?
- What changed since last check?
- What needs founder approval?
- What should Hermes/Codex do next?
- What shipped?
- What is stale?
- What threatens launch readiness?

For pre-launch hardening, the priority order is:

1. repo/deploy wiring
2. action queue
3. blockers
4. reliability
5. approvals
6. PR/deploy linkage
7. Hermes summary

That gets the HUD out of passive status mode and into the actual Jovie operating system.


## See Also
- [[chatgpt/chatgpt_10k-mrr-plan]]
- [[chatgpt/chatgpt_ai-coding-plan-comparison]]
- [[chatgpt/chatgpt_ai-lead-plan-for-linktree]]
- [[chatgpt/chatgpt_ai-plan-for-ios-refactor]]
- [[chatgpt/chatgpt_ai-task-automation-plan]]
