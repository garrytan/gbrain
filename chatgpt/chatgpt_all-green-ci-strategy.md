---
title: "All-green CI Strategy"
type: note
created: 2026-03-04
updated: 2026-03-04
source: chatgpt-export
conversation_id: 69a78147-5e1c-8329-a601-6d9db6ef67fd
message_count: 4
tags: [chatgpt, import]
---
# All-green CI Strategy

> Conversation ID: 69a78147-5e1c-8329-a601-6d9db6ef67fd
> Created: 2026-03-04T00:48:10Z
> Updated: 2026-03-04T00:50:57Z
> Messages: 4

---

## User

What is the all-green CI strategy?

---

## Assistant

Mr. White,

The **all-green CI strategy** is a continuous integration practice where the **main branch (often `main` or `master`) is always kept in a passing state**. Every commit in the primary branch must pass the full CI pipeline (build, tests, checks). The branch is never allowed to remain red.

## Core Principle
The repository’s primary branch is treated as **deployable at all times**. CI failures block integration until they are fixed.

## Key Rules
1. **No broken builds on the main branch**  
   If CI fails after a merge, the highest priority task becomes restoring green status.

2. **Merge only when CI passes**  
   Pull requests must pass automated tests before merging.

3. **Fix immediately when red occurs**  
   If a failing commit lands, the team either:
   - Fixes it immediately
   - Reverts it immediately

4. **Short-lived branches**  
   Developers integrate frequently to avoid large risky merges.

## Typical Workflow
1. Developer creates a feature branch.
2. Code is pushed and CI runs tests.
3. Pull request opened.
4. CI must pass before merge.
5. After merge, CI runs again on the main branch.
6. If CI fails, the team fixes or reverts immediately.

## Enforcement Mechanisms
Common safeguards include:

- **Required status checks** before merge
- **Branch protection rules**
- **Merge queues**
- **Pre-merge CI pipelines**
- **Automatic revert bots**

## Benefits
- The main branch is always deployable.
- Failures are detected quickly.
- Integration problems stay small.
- Deployment pipelines remain reliable.

## Tradeoffs
- Requires strong test coverage.
- Teams must treat CI failures as urgent.
- Slow test suites can delay merges.

## Companies Known for This Approach
Many high-velocity engineering teams use this model, including teams practicing **trunk-based development** at companies like Google and Facebook.

## Related Practices
- **Trunk-Based Development**
- **Continuous Deployment**
- **Merge Queues**
- **Pre-submit CI checks**

If useful, I can also explain the **Google-style implementation of all-green CI**, which adds **submit queues and automatic rollback**, making the system scale to thousands of engineers.

---

## User

I have a merge queue, and I'm just, my merge queue is all green, which means for every check. My rules set. Switching from all green to none would make the queue only wait for required checks. I'm just trying to understand what the difference is there. In our rules set, we have our PR ready thing, which does some checks. And then we have some other checks that are not required, I guess. Is it saying that, like, every single check, even like SonarCloud, which we have non-blocking and stuff, has to pass? I'm confused.

---

## Assistant

Mr. White,

Yes: in GitHub merge queue/rulesets, **“All green” means every status/check that reports on the merge-queue commit has to be green**, not just the ones you marked as “required.”

So the difference is:

## “All green”
- The queue waits until **all checks that appear in the Checks/Statuses list** for the queued commit are in a passing state.
- That includes **non-required** checks (example: SonarCloud, optional lint, “informational” checks) if they still report a status.
- If SonarCloud is configured as “non-blocking” only by *not marking it required*, it can still block the queue under “All green” if it reports **failure**.

## “None” (your description)
- The queue only waits for **required checks** defined by your ruleset/branch protection.
- Non-required checks can fail and the merge queue can still proceed (they’ll still show in the PR UI, they just don’t gate merging).

GitHub’s docs describe merge queue as waiting for **required checks** to be reported to proceed with merging. citeturn1search0  
Rulesets also describe the merge-queue behavior in terms of **required checks** and when they must pass. citeturn1search13

## How this maps to your setup
- Your “PR ready” check sounds like a **single gating check** (good pattern).
- Your “other checks” (SonarCloud, etc.) are currently **non-required**.
- With “All green,” those “other checks” become effectively blocking anyway, because they must be green for the overall state to be “all green.”

## Practical recommendations
1. **If you truly want only “PR ready” to gate merges:** set merge queue to the mode that gates on **required checks only**, and make **only “PR ready” required**.
2. **If you want SonarCloud informational:** keep it **non-required** and avoid “All green,” or configure SonarCloud to report **neutral** when you don’t want it to block (neutral/skip can count as acceptable for required checks, depending on configuration). citeturn2search5
3. **If you want SonarCloud to block sometimes:** make it **required** explicitly (clearer than relying on “All green”).

If you tell me whether you’re using GitHub **Rulesets** or classic **Branch protection**, and where exactly you see the “All green / None” dropdown, I can map it to the exact setting name and what it considers “a check” in that context.
