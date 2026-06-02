---
title: "Parallel UX Audit Plan"
type: note
created: 2026-04-25
updated: 2026-04-25
source: chatgpt-export
conversation_id: 69ec2570-d0a8-83e8-a437-972fce2ca63e
message_count: 2
tags: [chatgpt, import]
---
# Parallel UX Audit Plan

> Conversation ID: 69ec2570-d0a8-83e8-a437-972fce2ca63e
> Created: 2026-04-25T02:22:44Z
> Updated: 2026-04-25T02:23:02Z
> Messages: 2

---

## User

i have 2 hours to burn through usage on claude code and its ton so i want to use this as op to work thorugh ux inconsitencies in the code base. give me a prompt to use max paralell agent teams and churn through this in paralell owrk tress with max permissions All right, okay.If any of the sub-agents fail, then you should fix permissions before continuing. It should generate a large task list ahead of time. You should start by using max pro all sub-agents to do discovery on every single UI surface, all admin services, all user dashboard services. Don't touch public services, only work after auth, so our internal app services, and you're looking for all inconsistencies, change, etc., anything that's hard coded and moving it down to the design system when you're shipping small VIP PRs consistently and running them all through the g-stack workflows that are appropriate, at minimum /review and /ship. A separate agent will be merging them, and this needs to run fully autonomously. They can use the /loop and do a 5-minute interval or something and just keep churning out PRs, and then someone else would be working on getting merged.

---

## Assistant

Use a single orchestrator prompt that spins up parallel agents, enforces permissions, and runs autonomous loops with clear scopes and outputs. Paste the following into Claude Code:

---

**PROMPT: Parallel UX Consistency Audit + Auto-PR System**

You are the **Orchestrator Agent**. Your objective is to identify and fix UX inconsistencies across the authenticated product surfaces and continuously ship small, safe PRs in parallel.

## Global Rules
- Scope: **Authenticated/internal app only** (admin services, user dashboards, internal tools). Exclude all public/marketing surfaces.
- Output: Many **small, atomic PRs** (VIP PRs), each addressing a single inconsistency or tightly related set.
- All PRs must pass: `/review` then `/ship`.
- A separate Merge Agent will merge; do not block on merges.
- Run **fully autonomously** with looping.
- If any sub-agent fails due to permissions or access, **fix permissions immediately and retry** before continuing.
- Prefer moving hardcoded UI into the **design system** (tokens, components, variants).

---

## Phase 1: Massive Parallel Discovery

Spawn sub-agents with **max parallelization**:

### Agent Groups
1. **UI Surface Crawlers**
   - Enumerate every authenticated UI surface:
     - Admin panels
     - User dashboards
     - Internal tools
   - Map routes, components, entry points.

2. **Design System Auditors**
   - Identify:
     - Hardcoded colors, spacing, typography
     - Inline styles bypassing design system
     - Duplicate components instead of shared primitives
     - Variant inconsistencies

3. **UX Consistency Checkers**
   - Compare patterns across surfaces:
     - Buttons, forms, modals, tables, nav
     - Loading states, error states
     - Spacing, alignment, hierarchy
   - Flag mismatches and deviations

4. **Code Pattern Scanners**
   - Detect:
     - Hardcoded values
     - Repeated logic/components
     - Missing abstraction layers

---

## Phase 2: Central Task Graph

Aggregate all findings into a **global task list**:

- Deduplicate issues
- Cluster into atomic fixes
- Prioritize by:
  - Reuse impact
  - Visual inconsistency severity
  - Ease of migration

Each task must include:
- File(s)
- Issue description
- Target design system mapping
- Expected diff size (must be small)

---

## Phase 3: Parallel Fix Agents

Spawn fix agents (max parallel):

Each agent:
- Takes 1 task at a time
- Refactors to design system
- Removes hardcoded values
- Ensures no regression

Then:
1. Run `/review`
2. Fix issues
3. Run `/ship`
4. Submit PR

---

## Phase 4: Continuous Loop Execution

All agents operate in a loop:

- Interval: ~5 minutes
- Pull next task
- Execute fix → PR
- Repeat indefinitely

Use `/loop` to maintain continuous operation.

---

## Phase 5: Permission Self-Healing

If any agent encounters:
- Access errors
- Missing permissions
- Blocked files/services

Then:
1. Escalate permissions automatically
2. Retry task
3. Continue execution

Do not skip tasks due to permission issues.

---

## Phase 6: PR Standards

Each PR must:
- Be minimal and isolated
- Reference the inconsistency fixed
- Use design system primitives
- Avoid scope creep

---

## Phase 7: Monitoring + Throughput Optimization

Spawn a lightweight **Coordinator Agent**:
- Tracks:
  - Tasks completed
  - PR throughput
  - Failure rates
- Rebalances agent allocation dynamically

---

## Execution Directive

- Start immediately with **max parallel discovery**
- Build full task graph before fixes begin
- Then switch to **continuous parallel PR generation**
- Maintain high throughput for full session duration

---

**End of Prompt**

---

If you want, this can be tightened further to match your exact stack (React, Tailwind, tokens, Storybook, etc.) for even higher-quality output.


## See Also
- [[chatgpt/chatgpt_audit-plan-review]]
- [[chatgpt/chatgpt_design-system-audit-plan]]
- [[chatgpt/chatgpt_10k-mrr-plan]]
- [[chatgpt/chatgpt_ai-code-quality-audit]]
- [[chatgpt/chatgpt_ai-coding-plan-comparison]]
