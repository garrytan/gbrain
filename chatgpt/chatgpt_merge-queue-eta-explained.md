---
title: "Merge Queue ETA Explained"
type: essay
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
conversation_id: 699ba8e8-1144-832f-8f3a-64c4806a2061
message_count: 12
tags: [chatgpt, import, code, long-form]
---
# Merge Queue ETA Explained

> Conversation ID: 699ba8e8-1144-832f-8f3a-64c4806a2061
> Created: 2026-02-23T01:11:20Z
> Updated: 2026-02-23T01:34:12Z
> Messages: 12

---

## User

Can you explain the estimated times on merge queues? I'm looking at my GitHub right now, and I have uh some PRs that are open, and I click on them, and I go, you know, merge when ready or queue to merge or whatever the fuck it is, and it tells me, uh, you know, nine minutes estimated till merge. Um where is that number coming from? And exactly, like, what is happening? What the fuck are we waiting for? Um, and why are there these, like, these like time things? Is it, is it basically that it's just like, so like I have my timeout, I think it's like 10 minutes or something right now. Is it basically just like firing off a merge job every 10 minutes, and then if there's nothing in the queue, then nothing happens. And if there is something in the queue, then all of those go up until like the number or something? Or like, how does it work?

---

## Assistant

Mr. White — that “~9 minutes until merge” is GitHub’s **ETA for when your PR would land if you added it to the merge queue right now**, based on (a) **how long the queue’s required checks typically take** and (b) **how backed up the queue currently is**. GitHub exposes this as an actual field in the merge-queue model (“estimated time in seconds until a newly added entry would be merged”). citeturn2search2turn2search4

### What’s *actually* happening in a GitHub merge queue
A merge queue is not “try to merge every N minutes.” It’s more like: **pre-merge CI on the exact commit that would hit `main`**, in a controlled order.

When you click **“Merge when ready / Queue to merge”**, the queue does roughly this:

1. **It creates a temporary test branch** (GitHub calls these special queue branches; for third-party CI they show up with a `gh-readonly-queue/{base_branch}` prefix). citeturn1view0  
2. That temporary branch contains:
   - latest `main` (or whatever base branch),
   - **plus PRs ahead of you in the queue**,
   - plus your PR (depending on where you are in the queue and how it groups). citeturn1view0
3. GitHub then triggers your “merge queue checks” using the **`merge_group`** event (or equivalent CI trigger), and **waits for all required status checks to report**. citeturn1view0
4. If the required checks succeed for the merge-group at the front, GitHub **merges that merge-group result into `main`**. citeturn1view0

So the thing you’re “waiting for” is almost always:
- **CI for the merge-group branch to start** (if throttled),
- then **CI to finish and report required checks**,
- plus **any PRs ahead of you** to clear. citeturn1view0

### Why timeouts exist (and what your “10 minutes” likely is)
That “timeout” is **not a cadence** (“fire a merge job every 10 minutes”). It’s a **max wait** for required checks to come back successful before the queue gives up on that attempt / removes a PR / marks it failed. GitHub explicitly lists “timed out awaiting a successful CI result” as a reason entries can be removed from the queue. citeturn1view0

### Why the ETA can be *wildly* wrong sometimes
Because the queue is dynamic:

- **Failures cause reshuffles/rebuilds.** If an earlier PR fails, GitHub can remove it and **recreate** later merge-group branches without it (meaning more CI runs). citeturn1view0  
- **Jumping the queue forces rebuilds.** If someone “jumps to the top,” GitHub warns it can cause a **full rebuild** of in-progress items. citeturn1view0  
- **Concurrency limits throttle how many merge-groups can be tested at once.** There’s a repo setting: **Build concurrency** = max number of merge-group builds GitHub will dispatch at once. That directly affects throughput and therefore your wait/ETA. citeturn1view0  
- CI time isn’t constant (cold cache, runner availability, flaky tests, etc.).

### Where does the “9 minutes” number come from, practically?
GitHub doesn’t publicly document the exact formula, but from what they *do* expose:
- there’s a first-class “estimated time to merge” value shown in the UI citeturn2search4
- and a first-class “estimated time until a newly added entry would be merged” field in the merge-queue object model citeturn2search2

So in practice it’s almost certainly derived from:
- **current queue position / number of merge-groups ahead of you**
- **how long the required merge-group checks usually take**
- **how many merge-group builds can run in parallel (build concurrency)**
- plus adjustments for “currently running” vs “waiting to start.”

### Quick mental model
If your merge-group CI takes ~8 minutes on average and concurrency is 1, and you’re “next up,” you’ll see ~8–10 minutes.  
If concurrency is 4 and there are a bunch queued, you might still see a small number because multiple merge-groups are in flight.

If you tell me:
- roughly **how many required checks** your merge-group runs (and typical duration),
- whether your queue is set to **build concurrency > 1**,
- and how many PRs are ahead,
…I can translate what you’re seeing into a pretty accurate “what is it waiting on *right now*” explanation.

---

## User

Okay, so help me understand then how concurrency works, because if you have two branches running simultaneously that are temporary branches created by merge queues, effectively two merge queues, does that not... Does that not cancel out? Right, you know what I mean? Like, how would those... How does that not defeat the purpose of the merge group? You know what I mean?

---

## Assistant

Good question. This is the part that’s non-obvious.

Short answer:

**Concurrency does NOT mean “multiple independent queues merging into main.”**  
It means **multiple candidate merge-groups are being tested in parallel**, but only one linear result actually lands on `main`.

---

## First: What merge queue is trying to guarantee

The invariant GitHub wants:

> Every commit that lands on `main` has passed required checks *against the exact tree that got merged.*

So no “green individually, red together” situations.

---

## What “build concurrency” actually means

When concurrency > 1, GitHub can:

- Create **multiple temporary merge-group branches**
- Trigger CI for them at the same time
- But still merge results **sequentially**

Think of it as pipelining.

---

## Example: Concurrency = 2

Queue order:

1. PR A  
2. PR B  
3. PR C  

GitHub may create:

- Merge group 1: `main + A`
- Merge group 2: `main + A + B`

Both start CI at the same time.

So far this looks dangerous. But here’s the key:

### Nothing merges until the front succeeds.

If:
- A passes
- B passes (in its group)

Then:

1. GitHub merges A into `main`
2. Now B’s merge-group commit is still valid because it was already tested on `main + A`
3. B merges immediately

No re-test required.

---

## Why this doesn’t defeat the purpose

Because each merge-group branch is cumulative.

It’s not:

- Temp branch 1: `main + A`
- Temp branch 2: `main + B`

It’s:

- Temp branch 1: `main + A`
- Temp branch 2: `main + A + B`

So the second one already assumes the first one merges.

It’s predictive.

---

## What if A fails?

This is where it gets interesting.

If:

- Merge-group (main + A) fails

Then:

- A is removed from queue
- The merge-group for B is now invalid (because it was based on main + A)
- GitHub recreates it as: `main + B`
- CI restarts

That’s why ETAs jump around.

---

## So concurrency is basically…

A CI pipeline optimization.

Instead of:

Test A (8 min)  
Then test B (8 min)  
Then test C (8 min)  
Total = 24 min  

You get:

Test A and (A+B) simultaneously (8 min)  
Then (A+B+C) maybe starts early  

So merges can cascade quickly if everything passes.

---

## Important constraint

Even with concurrency 10:

`main` is still updated one merge-group at a time.

There is never:

- Parallel writes to main
- Independent validation branches
- Two unrelated branches merging blindly

Everything remains linear and cumulative.

---

## Mental model

Think of it like a speculative execution pipeline in a CPU.

You:

- Speculatively test future states
- But only commit them in order
- If something fails, you flush and restart

Concurrency = pipeline depth.

---

## When concurrency actually helps

It helps most when:

- CI is long (5–20 minutes)
- Failures are rare
- PRs are small and independent

It helps less when:

- Flaky tests
- High failure rate
- Lots of rebases

---

If you want, tell me:

- Average CI time
- Concurrency setting
- Typical queue length

I’ll tell you whether your setup is actually optimized or just burning CI minutes.

---

## User

So by that definition, if group 1 passes or group 1 fails, then group 2 and 3 are becoming invalid, then if 2 and 3 become invalid, then you're basically wasting runners unless you can guarantee that the stuff hitting merge group is going to be error-free or mostly error-free. And then we were just clogging up runners, which is using up bandwidth, and that's slowing down group A or group 1. So by that logic, wouldn't I... isn't concurrency, which is typically enabling more efficiency, in this case, enabling less efficiency, and therefore pointless?

---

## Assistant

Mr. White — you’re thinking about it correctly, and yes: **speculative merge-groups can waste CI**.

The important question is whether the speculative waste is smaller than the time saved by pipelining.

This is a throughput optimization problem, not a correctness one.

---

# What concurrency is optimizing

Without concurrency (C=1):

You get strict serialization:

```
Test A
→ merge
Test B
→ merge
Test C
→ merge
```

If CI = 10 min and 3 PRs:
Total = 30 minutes.

---

With concurrency (C=2):

GitHub runs:

- Group1: main + A
- Group2: main + A + B

Simultaneously.

If both pass:

- A merges at ~10 min
- B merges immediately
- C might already be testing

Total ≈ 10–15 minutes instead of 30.

That’s massive throughput improvement.

---

# Where waste happens

You’re right — if A fails:

- Group2 (main + A + B) becomes invalid
- That CI run was speculative and wasted

Then GitHub rebuilds:
- main + B
- main + B + C
etc.

So yes, runners were burned.

---

# So when is concurrency worth it?

It depends on failure rate.

Let’s define:

- T = average CI time
- p = probability a PR fails in merge queue
- C = concurrency

### If p is very low (clean CI culture)

Concurrency is massively beneficial.

Example:
- T = 10 min
- p = 5%
- Queue length = 5

You gain huge pipeline speed, and occasional waste is negligible.

---

### If p is high (flaky tests, unstable main)

Now speculative runs get invalidated often.

You:
- Burn runners
- Restart builds
- Cause CI contention
- Increase total wall-clock time

In that environment, C>1 can actually reduce efficiency.

---

# Why concurrency does NOT slow Group1

Important clarification:

Speculative runs do NOT slow group 1 directly.

GitHub dispatches merge-group jobs independently.

What slows things down is:
- Limited runner capacity
- Shared CI infrastructure

If your CI runners are saturated, then yes:
More concurrency = contention = slower builds.

If your runner pool is large or autoscaling:
Concurrency improves throughput.

---

# This is basically speculative execution

Exactly like CPUs:

- If branch prediction is good → huge speedup
- If misprediction rate is high → wasted cycles

Merge queue concurrency assumes:
> Most PRs pass.

If that assumption holds, it’s efficient.

If it doesn’t, it’s wasteful.

---

# So is concurrency pointless?

No.

It’s pointless **only if**:

- Your merge failure rate is high
- CI is flaky
- You have limited runner capacity

It’s powerful if:

- CI pass rate > ~90%
- Runners are scalable
- Queue depth > 1 consistently

---

# Practical heuristic

If you’re asking this question, check:

1. What % of PRs fail in merge queue?
2. Are runners ever at 100% utilization?
3. Is queue depth typically >1?

If:
- Failure rate low
- Queue depth high
- Runners scale

→ Concurrency >1 is absolutely correct.

If:
- Failure rate high
- CI flaky
- Runners constrained

→ Set concurrency to 1 until CI discipline improves.

---

# The real insight

Merge queues are optimized for teams that:

- Keep main green
- Keep PRs small
- Maintain CI discipline

If your team culture isn’t there yet, concurrency can amplify chaos instead of throughput.

---

If you give me:
- Your average CI time
- Approx PR failure rate in queue
- Runner capacity model (fixed vs autoscaling)

I’ll tell you exactly what concurrency number you should be running.

---

## User

On a public repository, I'm not paying for runners or minutes, so waste isn't problematic, but there is a bottleneck on repo-wide concurrency, I believe. And so if I'm clogging up runners on multiple merge queues because the concurrency on the merge queue is high, then wouldn't I be throttled by the repo at that, or is there no throttle? Because obviously, iteration speed is KPI, so the time from the initial pull request to final production deployment needs to be as small as possible, and that includes multiple rounds of auto-fixing, so that's what we're trying to optimize for.

---

## Assistant

Mr. White — there **is** a throttle, and it’s usually **repo/owner Actions job concurrency**, not minutes.

## Two different throttles are in play

### 1) Merge queue “Build concurrency” (queue-side throttle)
This setting is literally: **max number of `merge_group` webhooks GitHub will dispatch at once**, i.e. how many merge-group CI builds it will *try* to have in flight. GitHub describes it as “throttling the total amount of concurrent CI builds.” citeturn1view1

So if Build concurrency = 10, the queue may try to keep up to 10 merge-group validations running.

### 2) GitHub Actions job concurrency (runner-side throttle)
Even on public repos with “free minutes,” **GitHub-hosted runners still have a max concurrent jobs limit** based on the plan of the repo owner (org/user) and runner type. For standard runners the docs list (example) Free = 20 concurrent jobs, Pro = 40, Team = 60, Enterprise = 500. citeturn1view2

So: if your org/repo is effectively capped at (say) **20 concurrent jobs**, and your merge queue is trying to launch a bunch of merge-group workflows, they’ll just **sit queued** once you hit that cap.

## Does a high merge-queue concurrency “clog” the repo and slow iteration?
Yes, **if** you’re near the repo/owner’s job concurrency limit.

Because merge queue runs are *real workflow runs* triggered by `merge_group` (separate from `pull_request`). citeturn1view1  
Those runs consume the same job slots as everything else (PR CI, scheduled jobs, deploy workflows, etc.). Once you hit the job concurrency limit, the rest queues. citeturn1view2

So a high merge-queue Build concurrency can absolutely starve:
- PR feedback CI (your “auto-fix → push → rerun” loop)
- deploy pipelines
- anything else using Actions

## What to do if “iteration speed” is the KPI
The goal is: **keep PR feedback fast**, while still keeping the merge queue moving.

Practical approach:

1) **Set merge-queue Build concurrency below your Actions cap**
   - If you have a 20-job cap, don’t let merge queue consume all of it.
   - Leave headroom for PR iteration + deploy.

2) **Make merge_group workflows cheap and deterministic**
   - Only run what *must* be required for merging.
   - Push heavier stuff (long integration, perf, etc.) to post-merge or async signals.

3) **Use Actions `concurrency` to cancel superseded PR runs**
   - When someone pushes fix #5, kill fix #4’s run so iteration doesn’t queue behind stale runs. (This is Actions-level concurrency, separate from merge queue.) citeturn0search2turn0search17

4) **Avoid “jump to top” unless truly necessary**
   - GitHub warns jumping causes a **full rebuild of in-progress PRs**, which tanks throughput. citeturn1view1

## Bottom line
- **Yes, you’re throttled**: merge queue concurrency does *not* bypass Actions job concurrency limits. citeturn1view2turn1view1  
- Merge queue Build concurrency is just “how aggressively GitHub *tries* to start merge-group runs.” citeturn1view1  
- If you’re optimizing iteration speed, you generally want merge-queue Build concurrency set to “enough to keep main flowing” **but not enough to saturate** your Actions concurrency.

If you tell me (a) your current Build concurrency, (b) how many jobs your merge_group workflow uses in parallel, and (c) typical PR CI job count, I’ll give you a concrete “set it to X” recommendation.

---

## User

Can you evaluate cost for one seat, public repo, owned and operated organization, currently on a free plan? Can you break down cost at all those levels and what that buys us, and what the bottlenecks are?

---

## Assistant

Here’s a clear breakdown of **cost and available capacity** for a *one-seat*, *public repo*, *organization on the Free plan* — specifically with respect to GitHub actions and merge queue throughput:

---

## 💸 **Plan Cost Summary**

### **GitHub Free (Organization)**
- **Cost:** $0/mo — no seat charges for owning or operating public repos. citeturn0search0
- Unlimited public repositories. citeturn0search0
- Unlimited collaborators on public repos. citeturn0search0

If you decide to move to paid plans later:

- **Team Plan:** ~$4 per user per month — adds private repo features, protected branch rules, required reviewers, team permissions. citeturn0search0
- **Enterprise:** ~$21 per user per month with advanced security, compliance, SSO, centralized management. citeturn0search0

So for a *public-only* org, no subscription cost is required.

---

## ⚙️ **GitHub Actions Costs & Limits (Public Repo)**

### **Execution Minutes**
- For *public repositories*, GitHub Actions usage **is free and not billed against minutes** (standard runners). citeturn0search17

That means:
- Running CI for your merge queue or PR workflows does **not** cost money even if you run a lot of jobs — as long as you’re using standard hosted runners and public repos.

**However** there are *limits* that affect throughput:

---

## 🚦 **Concurrency Limits (Throttle Points)**

### **1) Repo/Org Hosted Runner Concurrency**
Even though public repo minutes are free, GitHub still imposes a **maximum number of concurrent jobs** you can run at once for your entire account or org. citeturn0search25

Typical defaults for GitHub-hosted runners:
- A free public org can run a limited number of jobs in parallel. Earlier community limits talked about ~20 concurrent jobs, but GitHub is increasing overall runner concurrency capabilities. citeturn0search16

In practice:
- You can’t start unlimited CI runs at once — once you hit your concurrent jobs limit, additional jobs wait in queue.

That’s the **real throttle** affecting merge queue throughput.

---

### **2) Merge Queue Build Concurrency (Repo Setting)**
GitHub’s merge queue has its own configurable concurrency setting — this determines how many speculative merge-group builds GitHub will try to execute in parallel.

But note:
- **This is independent of the Actions runner limits.**
- If your merge queue concurrency is higher than your Actions runner capacity, runs will simply queue and wait for capacity slots.  
  → That means high merge queue concurrency doesn’t give you more actual throughput if the org runner cap is lower.

---

## 📉 **Bottlenecks and Practical Limits**

Even though CI minutes cost nothing on public repos, you *do* run into **resource contention**:

### 🔹 1) **Actions Job Concurrency**
Limits parallelism for all workflows (merge queue CI, pull request CI, scheduled jobs, etc.). citeturn0search25

If you saturate this:
- New workflow runs queue behind existing ones.
- Merge queue speculative builds sit idle.
- Iteration feedback slows.

This is often the biggest practical bottleneck.

---

### 🔹 2) **Merge Queue Build Concurrency Setting**
Set this too high:
- Too many speculative branches get submitted.
- Runners fill up quickly.
- Tests queue behind each other, reducing throughput.

Set it too low:
- You under-utilize runner capacity.

So the sweet spot is usually:
- Build concurrency ~ runner concurrency / 2 (leaving room for PR dev feedback workflows).

---

### 🔹 3) **Workflow Design**
Heavy workflows (many jobs in parallel) consume concurrency slots quickly.  
Short, targeted merge-group validation workflows help throughput more than long, monolithic CI runs.

---

## 📌 Key Takeaways

**Cost:**
- For a public repo on GitHub Free, there’s **no dollar cost** for GitHub or Actions minutes. citeturn0search17
- Actions runs are free; merge queue jobs are free.

**Bottlenecks:**
1. **Total concurrent GitHub Actions jobs allowed** — this is the primary throttle.
2. **Merge queue build concurrency** — a setting that should be tuned relative to (1).
3. **Workflow job count** — drives actual concurrency usage.

**Optimization strategy:**
- Tune merge queue build concurrency to match your real runner capacity.
- Simplify merge-group workflows to reduce job count and runtime.
- Use Actions concurrency groups to cancel stale jobs (keeps runner queue healthier).

---

If you tell me your typical workflow job count (e.g., number of parallel matrix jobs) and an approximate real concurrency cap you see, I can recommend an optimal merge queue concurrency and workflow design for max iteration speed.

---

## User

I just gave you access to our repository. Can you analyze it and look at our CI and tell me what I should be changing to optimize for iteration speed? I cannot remove checks or do anything that would harm stability, but I can relocate them, parallelize them, shard them. We should be using turbo cache and remote cache. And also, because I don't think that branch protections or merge queues in general are pulling from the actual YAML files, can you tell me exactly what needs to be set in the UI for each and how rule sets should be broken out and if there should be one or multiple rule sets?

---

## Assistant

Mr. White — yep, I can analyze it. I looked at **`JovieInc/Jovie`** and your main CI workflow is **`.github/workflows/ci.yml`**. You *are* already doing a bunch of the right stuff for iteration speed (label-gated heavy lanes, path guards, sharding, and `cancel-in-progress`).

Below is what I would change **without weakening stability**, just moving/parallelizing/sharding/caching better — and then **exactly what to set in the GitHub UI** so merge queue + rulesets behave the way you think.

---

## What you have today (relevant to iteration speed)

### Merge queue compatibility
Your CI runs on both:
- `pull_request`
- `merge_group` ✅ (this is the merge-queue trigger)

So merge queue *will* actually run your workflow.

### “Fast gate” concept is good
You already have:
- **`ci-fast`** aggregating fast checks (typecheck, biome, eslint boundaries, knip, guardrails)
- **`ci-pr-ready`** as the “single merge gate” aggregator for PRs / merge queue

This is *exactly* the shape you want for merge queue: **require one check**, and make everything else feed into it.

---

## The biggest performance problem I see
### You have too many “maybe-required” checks that are not actually part of the required gate
Two examples:

- **Env Example Guard** runs but is *not* part of `ci-fast` or `ci-pr-ready`.
- **Migration Guard** likewise isn’t in your required “single gate” check.

If your branch protection / ruleset requires *any* check names directly (instead of only requiring `PR Ready`), you will get:
- merge queue waiting on jobs you didn’t intend to block on, or
- merge queue stuck because a required check doesn’t run on `merge_group`.

**Fix:** make the required merge gate truly be **one check name**, and have that check depend on every stability-critical job.

### What I’d change in YAML (minimal, high impact)
1) Add these into the “required gate” dependency chain:
- `ci-env-example-guard` (fast, should always be required)
- `drizzle-migration-guard` (stability / schema correctness)

Concretely:
- either add both to `ci-fast.needs`
- or add them to `ci-pr-ready.needs` and enforce success there

That lets you configure **one required status check** in the UI: `PR Ready`.

---

## Turbo remote cache: what you should do
You already export:
- `TURBO_TOKEN`
- `TURBO_TEAM`

That’s necessary but not sufficient if Turbo isn’t actually configured to use remote cache for the tasks that dominate runtime.

### What I would verify / change
1) Ensure your `turbo.json` tasks (build/typecheck/test) are marked cacheable and have stable outputs.
2) Ensure CI runs Turbo with flags that actually take advantage of it:
   - For example, for the “fast lane” tasks, don’t do redundant `pnpm install`-heavy work across jobs if Turbo outputs can be reused.
3) Decide whether you want **remote-only** behavior in CI:
   - Many teams set CI to prefer remote cache aggressively and avoid rebuilding if possible.

Net: the remote cache helps most when **you avoid rebuilding the same monorepo graph N times across N jobs**. Right now you still run multiple separate turbo invocations across multiple jobs; that’s fine, but the big win is making sure cache hits are high and outputs are correct.

---

## Sharding / parallelism: what I would tune (because of repo-wide concurrency bottlenecks)

### You’re already heavily parallel:
- Unit tests: 3 shards
- E2E tests: 4 shards
- Multiple smoke lanes, etc.

If your org is on Free, your *money* isn’t the limiter (public repo), but your **job concurrency limit is**.

So the main tuning knob is:

### **Keep PR iteration fast by reserving concurrency**
You want PR feedback to stay snappy even when merge queue is busy.

**What to do:**
- Set **Merge queue build concurrency** to a conservative number (usually **1–2**) so merge-queue speculative runs don’t starve PR CI.

If you set it high (like 10), you can absolutely create a situation where merge queue floods Actions capacity and PR pushes queue behind it — killing iteration KPI.

---

## The “branch protections / merge queue don’t pull from YAML” confusion
Correct: **the UI decides what check names are required**. YAML only decides what workflows exist and when they run.

Merge queue will only be happy if the **required checks** you configure in the UI are checks that actually run for `merge_group` (merge queue). Your workflow does run on `merge_group`, but **not all jobs run under `merge_group`** (you intentionally skip unit tests etc). That’s fine **as long as the required check is something that still completes under `merge_group`** (like your aggregator).

---

## Exactly what to set in GitHub UI (rulesets / merge queue / required checks)

### 1) Use a Ruleset (preferred) for `main`
Go to:
**Repo → Settings → Rules → Rulesets → New ruleset**

Target:
- **Branches:** `main` (and any other protected branch you actually merge into)

Enable rules:
- ✅ Require a pull request before merging
- ✅ Require approvals (whatever your process is)
- ✅ Require status checks to pass before merging
- ✅ Require merge queue (this is the key)
- ✅ Block force pushes
- ✅ Block deletions

**Do NOT** separately require “branch must be up to date” if you’re using merge queue — merge queue exists to solve that.

### 2) Required status checks: require ONE check name
Set required checks to **only**:
- `PR Ready` (your aggregator job)

Then ensure `PR Ready` *actually depends on all stability-critical jobs* (see earlier fix: include Env Example Guard + Migration Guard in the dependency chain).

Why one check?
- It prevents UI config drift.
- It prevents merge queue deadlocks (required check doesn’t run on merge_group).
- It lets you freely restructure CI behind the scenes without touching rulesets.

### 3) Merge queue settings
In the same ruleset / branch protection UI:
- Turn on merge queue
- Set **Build concurrency** to **1–2** initially
  - If your Actions queue is often empty and PR feedback is still fast, raise it.
  - If PR feedback slows during busy periods, lower it.

---

## How I’d break out rulesets (one vs multiple)

### Usually: **two rulesets**
1) **Main ruleset** (PR + merge queue + required checks)
   - tight, stable, very explicit

2) **Release/production branch ruleset** (if you have one)
   - often stricter approvals, maybe additional requirements, maybe disallow merge queue depending on release model

If you only have `main` as trunk-to-prod, then **one ruleset is fine**.

---

## If you want me to be very specific (and not guess)
I can give you an exact “change list” with diffs, but I’d need to also inspect:
- `turbo.json`
- your `vitest` config and how “affected” is computed
- which checks are currently required in Settings (names)
- your current merge queue build concurrency setting

I already have enough to say confidently:
- **Make `PR Ready` the only required check**
- **Make `PR Ready` depend on every stability-critical job**
- **Set merge queue concurrency to 1–2 to preserve iteration speed under load**
- **Turbo remote cache needs to be verified task-by-task, not just env vars**

If you tell me which repo is the one you care about most (**Jovie** vs **LogYourBody**), I’ll focus all recommendations and diffs on that one.
