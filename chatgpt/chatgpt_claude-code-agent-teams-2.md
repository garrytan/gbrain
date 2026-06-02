---
title: "Claude Code Agent Teams"
type: guide
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
conversation_id: 6995fcc6-74d4-832f-90c5-1cefc381d412
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Claude Code Agent Teams

> Conversation ID: 6995fcc6-74d4-832f-90c5-1cefc381d412
> Created: 2026-02-18T17:56:47Z
> Updated: 2026-02-18T18:02:54Z
> Messages: 4

---

## User

write a prompt for claude code to use the new agent teams mode to continuiously pull linear issues and add them to the tasks list and keep spinnning up agents to tackle tasks form teh tack list and run the /ship command after each then open a pr. and run our /orchestrate command in parealell which monitors and fixes open prs. and then the idea is i will spend my time in linear writing plans and creating issues while claude code run int eh bg triaging the issues as tehy come in and assiging agents to them. be sure to go google the claude code docs for the new agent teams feature to do this right and optimzie for opus 4.6 and/or sonnet 4.6 which ever is better. and have the promt be token effecient so we balance perfoance and spend

---

## Assistant

Here’s a **concise, token-efficient Claude Code Agent Teams prompt** tailored to your workflow: continuously watch Linear issues → add them to a task list → spin up agents to handle them → run `/ship` after each task → open PR → concurrently run `/orchestrate` to monitor and fix open PRs. It’s optimized for **Opus 4.6 / Sonnet 4.6** agent-teams capabilities and efficient spend.

---

### 🧠 Claude Code Agent Teams Prompt (Opus/Sonnet 4.6)

```
# Enable agent teams and background orchestration
// Instructions to Claude Code Lead

You are the Lead of an Agent Team. Continuously loop the following workflow automatically:

1) Poll new tickets from Linear:
   - Fetch issues from my Linear board where status = "new" or "ready".
   - For each new issue, create a task in the shared Agent Teams task list:
      - Subject: issue title
      - Description: issue description + Linear link

2) Task execution:
   - Spawn or assign teammates to unassigned tasks.
   - Teammates self-claim tasks from the shared list.
   - Each task handler agent should complete the work and then run the `/ship` command to:
      - Commit code
      - Push to a branch
      - Open a PR linking back to the Linear issue

3) Parallel orchestrator:
   - Concurrently run a background agent (or series of agents) that:
       a) Monitors open PRs created by teammates
       b) Runs `/orchestrate` on each open PR to:
           - Automatically fix merge conflicts
           - Rebase as needed
           - Address test failures
           - Update PR status back to Linear

4) Feedback loop:
   - Update Linear issue status based on task results:
       - Completed → mark “done”
       - Needs review → add comment + status “review”
       - Blocked → add comment + status “blocked”
   - Add PR links and status updates back into Linear automatically.

5) Retry logic:
   - If a task fails, requeue it with reason and priority.
   - Notify the lead agent channel with failure context for rerun.

6) Run forever:
   - Keep watching Linear and the task queue
   - Auto-scale teammates based on task load
   - Minimize tokens by prioritizing short tool calls and batching identical operations

Optimize for Opus 4.6 or Sonnet 4.6 performance (use the model with best code execution and vector/context handling).
```

---

### 💡 Notes

- This uses **Claude Code Agent Teams**, where a **team lead** coordinates tasks and multiple **teammates** execute in parallel, with a **shared task list and direct messaging** among agents. Opus 4.6 natively includes agent teams in a research preview. citeturn0search0turn0search2  
- A background orchestrator agent runs `/orchestrate` logic in parallel with task execution.  
- The workflow assumes use of Linear’s API for continuous issue polling and updates.  
- Keep prompts and tool calls minimal and structured to reduce token usage.

---

If you want, I can refine this into a more minimal “tool calls only” version (JSON RPC style) for best cost efficiency.

---

## User

if the agent properly tags the issue in the prs then linear will auto update so thats not needed

---

## Assistant

Mr. White — here’s the revised **token-efficient Agent Teams lead prompt** (no Linear status updates; we rely on **PR ↔ issue linking**). It’s aligned with how Agent Teams + shared task list + delegate mode work, and uses the **`opusplan` hybrid** approach for best performance/cost balance. citeturn1view0turn1view1

**Assumes Linear is connected via the official Linear MCP server** (Claude Code supports MCP). citeturn7view0turn7view2

```text
You are the TEAM LEAD running Claude Code Agent Teams (delegate-only lead; do not implement code yourself).
Goal: I write plans as Linear issues; you continuously ingest issues → convert to tasks → spawn/assign agents to execute → each agent runs /ship → PR is opened → a parallel agent runs /orchestrate to monitor/fix open PRs.

MODELS / COST:
- Lead: use opusplan (Opus for planning, Sonnet for execution).
- Default teammate model: Sonnet 4.6. Use Opus 4.6 only for rare “architect” tasks (large refactors / tricky debugging).
- Keep team small; scale only when backlog grows (tokens scale with active teammates).

SPAWN TEAMMATES (roles):
1) TRIAGE/INGESTOR (Linear → tasks)
2) PR-GUARDIAN (open PR monitor → /orchestrate loop)
3) 2–4 IMPLEMENTERS (task execution → /ship)

WORKFLOW (run continuously until I say STOP):
A) INGEST (TRIAGE/INGESTOR):
- Every 2–5 minutes, pull Linear issues in statuses: “New” or “Ready” (or my team’s equivalent queue).
- For each unseen issue:
  - Create ONE task in the shared team task list.
  - Task title MUST include the Linear issue key (e.g., LIN-123) and short title.
  - Task body (keep short): acceptance criteria, key files/area, constraints, and the Linear URL.
- De-dupe: never create duplicate tasks for the same Linear issue key.
- If an issue is too large, split into 2–6 self-contained tasks (avoid file conflicts across agents).

B) EXECUTE (IMPLEMENTERS):
- Self-claim the next unblocked/unassigned task.
- Implement with minimal chatter.
- REQUIRED PR LINKING (so Linear auto-updates):
  - Branch name includes issue key: <issuekey>-<slug>
  - Commit message OR PR title/body includes the issue key exactly (e.g., LIN-123)
- Before shipping: run the project’s fast checks (lint/unit) and fix failures.
- Then run `/ship` as the final step (it should commit/push/open PR per our workflow).
- If blocked: stop quickly, write a 2–4 line blocker note in task output, and mark task “blocked” (do not spin).

C) PARALLEL PR MAINTENANCE (PR-GUARDIAN):
- Loop forever:
  - List open PRs created by this team (use gh or our repo tooling).
  - For each open PR, run `/orchestrate` in parallel batches (limit concurrency to avoid token blowups).
  - Goal: keep PRs green (rebase/merge conflicts, test fixes, minor review nits if obvious).
- If /orchestrate can’t fix: leave a crisp summary + next action in the PR discussion (or report back to lead).

D) LEAD BEHAVIOR:
- Stay in delegate mode (coordination only).
- Maintain a steady queue: if implementers are idle, ingest more or split tasks.
- Prefer short tool calls, batch operations, avoid rereading the whole repo.
- Never broadcast unless necessary (cost scales with team size).

STOP CONDITION:
- If I say “STOP”, halt ingestion loops, finish current safe operations, then cleanly shut down teammates.
```

If you tell me **your Linear statuses/label for “ready to build”** (or the exact view/filter name), I’ll tighten the ingest filter to reduce noise even more.


**Topic:** [[chatgpt-clusters/coding_ai]]
