---
title: "Merge Queue Throughput Explanation"
type: note
created: 2026-03-07
updated: 2026-03-07
source: chatgpt-export
conversation_id: 69ab8e45-5c10-832f-8904-ed7c7aeab2d6
message_count: 2
tags: [chatgpt, import]
---
# Merge Queue Throughput Explanation

> Conversation ID: 69ab8e45-5c10-832f-8904-ed7c7aeab2d6
> Created: 2026-03-07T02:33:13Z
> Updated: 2026-03-07T02:34:04Z
> Messages: 2

---

## User

Um, so I have 23 items in the merge queue right now, and it says 15 minutes, 35 seconds to merge, with the first item being 3 minutes, and the second item being 4:20, then 4:15, then 5:20, then 5:15, then 6:30, then 7. So I guess it's estimating 30 seconds per PR. Why, what exactly is happening and how is the merging? Like, so if I check what merged, it seems it's only merging like two things an hour.

---

## Assistant

Mr. White,

What you’re seeing is consistent with how GitHub merge queue works.

GitHub does **not** simply merge one queued PR every 30 seconds. When a PR enters the queue, GitHub creates a temporary `merge_group` branch that includes the latest base branch plus that PR and any PRs ahead of it, then it waits for the required CI checks on that temporary branch to pass before merging. GitHub explicitly says merge queue throughput is gated by required checks, `merge_group` builds, and the repo’s configured **build concurrency**. citeturn1view0turn2view1

So the “15m 35s” estimate is almost certainly an **ETA model**, not “23 PRs × 30 seconds of actual merge work.” GitHub’s docs do not describe a fixed per-PR merge rate. The queue can dispatch only up to the configured number of concurrent `merge_group` builds, and that setting directly affects merge velocity. citeturn2view0turn2view1

What is probably happening in your case:

1. **A few merge-group builds are running**
   Each queued PR is being revalidated against the latest base branch and earlier queued PRs. That means CI gets rerun on queue-specific temporary branches, not just on the original PR branch. citeturn1view0

2. **The queue is bottlenecked by CI, not by the merge action**
   If your required checks take 20–30 minutes, and build concurrency is low, the queue may only complete a small number of merges per hour even if the UI shows short incremental ETAs. GitHub states build concurrency throttles the number of `merge_group` webhooks and affects merge velocity. citeturn2view0turn2view1

3. **Earlier failures or reordering can cause rebuilds**
   If a PR ahead of yours fails, is removed, or someone jumps the queue, GitHub can recreate temporary branches for later entries. GitHub documents that failed checks remove PRs from the queue, and reordering can trigger a full rebuild of in-progress PRs. That can make observed throughput much lower than the optimistic ETA. citeturn1view0

4. **Multiple PRs may merge together, but only after checks pass**
   GitHub supports merge limits with minimum/maximum pull requests to merge at the same time, but those limits **do not combine merge-group builds**. They only affect how many already-validated PRs are merged to the base branch together. citeturn2view1turn2view2

Why you might only see “two things an hour”:

- required checks are slow
- build concurrency is set low, possibly 1
- failed or flaky checks are causing requeues
- queue reordering or removals are forcing rebuilds
- the queue is validating combinations of PRs, which is more expensive than plain FIFO merging citeturn2view0turn1view0

The key point is this:

**The queue time is dominated by CI validation on temporary merge-group branches.** The actual final merge commit is fast. The slow part is proving that the queued PR still passes after being combined with the base branch and earlier queued work. citeturn1view0turn2view1

To verify this in your repo, check these settings on the protected branch:

- **Build concurrency**
- **Status check timeout**
- **Merge limits**
- whether `merge_group` workflows are running long or flaking citeturn2view1

If you want, I can help you translate your observed numbers into a likely effective CI/concurrency model for the queue.
