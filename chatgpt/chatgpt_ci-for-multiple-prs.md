---
title: "CI for Multiple PRs"
type: note
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
conversation_id: 699ce513-f37c-8329-87f0-918a0e859f0b
message_count: 2
tags: [chatgpt, import]
---
# CI for Multiple PRs

> Conversation ID: 699ce513-f37c-8329-87f0-918a0e859f0b
> Created: 2026-02-23T23:39:50Z
> Updated: 2026-02-23T23:40:32Z
> Messages: 2

---

## User

Yo, if I have like 50 PRs open and all of them are like minimal diff, would it be better to push them through um push them through CI individually or like squash them all together locally and then push them? Or is there a way I can do that in CI? And if so, can we automate that and how does that affect the merge queue?

---

## Assistant

Mr. White — usually **don’t squash 50 PRs locally into one mega-push** unless you truly want them to land as a single atomic change. You’ll save CI runs, but you pay for it in lost signal (which PR broke?), harder review/revert, and uglier history.

Here’s the practical breakdown and the “do it in CI” options.

## Option A: Run CI per PR (best signal, most CI cost)
**Pros**
- Cleanest blame/revert
- CI points to the exact PR that broke
- Merge queue stays happy (each PR is independently validated)

**Cons**
- 50 PRs ⇒ lots of CI minutes + queue time

Use this if failures are likely or changes touch risky code.

## Option B: Batch them *in CI* (best of both worlds when changes are low-risk)
You can **test a batch together** without permanently squashing them locally.

### If you’re on GitHub: use **Merge Queue batching**
- GitHub merge queue can run CI on a **merge-group** (a synthetic commit that includes multiple queued PRs).
- CI runs once per batch, then merges PRs in the validated order.

**Key effect on merge queue**
- If a batch fails, the queue will typically **split/retry** (or at least you’ll need to remove the offender), because the batch doesn’t tell you which PR is bad without extra work.
- Good for “many tiny safe diffs” but you need a plan for isolating the culprit.

**Implementation detail**
- In GitHub Actions, support the `merge_group` trigger so the same workflow runs for merge-queue batches.

### General CI pattern (works anywhere): “test a temporary integration branch”
Automation idea:
1. Select N PRs (e.g., 5–10) that are approved + green individually (or trusted).
2. Create a temporary branch that merges their heads (or cherry-picks).
3. Run the full CI suite once on that branch.
4. If green: merge those PRs normally (or let merge queue merge them).
5. If red: bisect/split the batch.

This preserves individual PRs while reducing heavy CI runs.

## Option C: “Stacked PRs” (only run heavy CI on the tip)
If the PRs are logically related and minimal:
- Put them in a **stack** (PR2 based on PR1, PR3 based on PR2, etc.)
- Run the expensive CI only on the **top** (plus lighter checks per PR).

**Pros**
- Massive CI reduction
- Keeps PR granularity

**Cons**
- Review/merge order matters
- The merge queue may be less useful unless your tooling understands stacked PRs

Tools: `ghstack`, Graphite, or a disciplined rebase workflow.

## What I’d do with “50 minimal diffs”
- Keep PRs separate.
- Turn on/lean on **merge queue batching** (or integration-branch batching).
- Use batch size like **5–10** (enough savings without making failures impossible to debug).
- Add a fallback automation: if a batch fails, automatically split into halves until the bad PR is found (binary split).

## How this affects the merge queue (behaviorally)
- **Individual CI per PR:** merge queue is straightforward; failures isolate naturally.
- **Batch CI:** merge queue throughput improves, but failures become “someone in this group broke it,” so you need **auto-splitting** or a quick manual process.
- **Local squash of all 50:** merge queue sees *one change* (fast), but you lose independent revertability and ownership, and review becomes painful.

## Automating it (what to build)
If you want automation, the cleanest is:
- A bot (GitHub App or Action) that:
  - Watches PRs with labels like `batchable`, `approved`, `ci:light`
  - Groups them into batches
  - Triggers a **merge-group** run (if using GitHub merge queue) or creates a **temporary batch branch** and runs CI
  - On failure: splits batch and retries automatically

If you tell me what you’re using (GitHub merge queue vs something else, and what CI provider), I’ll give you:
- the exact GitHub Actions triggers (`pull_request`, `merge_group`) setup, or
- a concrete batching script outline using the GitHub API (which endpoints, what data to pull, and the batching/splitting logic).


## See Also
- [[chatgpt/chatgpt_emitting-multiple-values]]
- [[chatgpt/chatgpt_gui-for-multiple-terminals]]
- [[chatgpt/chatgpt_handling-multiple-agents-locally]]
- [[chatgpt/chatgpt_multiple-units-at-station-7]]
- [[chatgpt/chatgpt_running-multiple-codex-agents]]
