---
title: "PR Automation Workflow"
type: essay
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
conversation_id: 69e7de47-2fb4-83e8-b625-9143344ddca2
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# PR Automation Workflow

> Conversation ID: 69e7de47-2fb4-83e8-b625-9143344ddca2
> Created: 2026-04-21T20:30:00Z
> Updated: 2026-04-21T21:21:27Z
> Messages: 3

---

## User

In a world-class skill-created repo we have a training command that takes the /train. What it does is it runs against our repo and it takes everything that is an open PR. It pulls all those open PRs and if it looks like it's not too crazy, just merge it and then the next thing you should do is go through and look at everything. You should do all this in an efficient order. My order is not necessarily correct; you can improve the ordering but for every open PR we should look: are there merge conflicts that can be resolved? If there are, resolve them. If anything needs to be updated or rebased against main, do so. If anything has a comment from Code Rabbit or G Reptile Sonar Cloud or any of our other bot-driven reviews, those should be addressed also. If there's a human review, that should be addressed and then pushed back. Everything should attempt to be done with parallelization if possible in isolated worktrees so that it can move as fast as possible.

When we ship things if needed we can do a /review with the g-stack/review command so that we avoid shipping it back to CI only for it to get flagged with another issue. Only if needed. If the environment has access to a Code Rabbit plugin locally, it could also run that. Once you ship things to production, we'll ship the PRs. Any PR that has gone through all that, if there are failing tests from CI, we want to address failing tests. We want to work through all the quick wins so we can push everything through this on clock CI as fast as possible. It should also be monitoring main deploys so if things are not deploying to production for whatever reason, we should address those issues so that we don't ship 100 PRs that are going through gates but then never actually getting deployed to production. Those issues should be fixed quickly. This is going to run on a cron too so this is going to run pretty frequently.

If you think it's better to split these into multiple jobs, I'm cool with it; otherwise just a single train command that would run in the cron and then the cursor bots of poisea. If anything is seriously fucked and needs more work than that, it can be left aside for the next cron when the worker has less stuff to do but it should eventually then be tackled. We don't want to be in a situation where we ship like 200-300 PRs in a 24-48 hour period and then something is sitting at the bottom of the queue. That is now 250 PRs behind and we're wasting minutes and stuff repeatedly updating this thing and rebasing and rebasing and rebasing it, only first never gets shipped because it's got a bunch of work that needs to be done on it.

This should also handle duplication cursor ship, something that fixes an issue that was already fixed or something like that, and it's obvious; then you can just duplicate the open PRs. There's no need to waste tokens by doing deep searches against the repo for things like that. If there's something obvious, like two PRs in a row that obviously step on each other, we should either merge them or make the most intelligent decision on how to avoid the duplication. The whole KPI on here is time to an empty queue. Ideally this is running frequently enough that we never have a bunch of PRs sitting there but basically no human is ever going to interact with these until we hire so this needs to be entirely automated.

Layout all of those and then figure out if it's a single skill that runs as a cron or if it's multiple skills that run on separate crons or are triggered in some way or whatever. It could be like an optional step or whatever. Rewrite this in a world-class way and then once you're done writing it, do a simplification pass to see if there's any redundancy in the job that can be compacted on or something. Keeping in mind this is going to run on an reorder cron so the longer it is the more tokens it's going to burn through. It shouldn't be any longer than it needs to be but it should be as long as it needs to be. 

---

## Assistant

Mr. White, I’ll turn this into an operator-grade `/train` spec, then compress it into a cron-friendly version with the right split between orchestration and worker jobs.

---

## Assistant

Mr. White, I’d split this into **one primary `/train` skill** plus **small internal phases**. Keep one cron entry for simplicity, but let the command fan out into parallel isolated worktrees. Add one lightweight deploy-health watchdog that runs before and during the train. That avoids separate crons fighting each other while still giving you parallelism.

Below is the rewritten world-class version, followed by a simplification pass.

---

# `/train` — Autonomous PR Train Skill

## Mission

Drive the repository toward an empty PR queue with minimal human involvement.

Primary KPI: **time to empty queue**.

The train should continuously triage, repair, validate, merge, and monitor open PRs. It should prioritize quick safe merges, prevent starvation of hard PRs, avoid duplicate work, and keep production deploys healthy.

---

## Operating Model

`/train` runs on a frequent cron and may also be invoked manually.

It acts as an orchestrator with parallel workers. Each worker operates in an isolated git worktree so multiple PRs can be processed safely at the same time.

The command should:

1. Check main branch and production deploy health.
2. Load all open PRs.
3. Classify PRs by risk, age, status, CI state, conflicts, reviews, and duplication.
4. Process safe PRs first.
5. Repair PRs that need simple updates.
6. Address bot and human review comments.
7. Run local review/test commands only when useful.
8. Merge PRs that are ready.
9. Monitor post-merge CI and production deploys.
10. Prevent old or complex PRs from being endlessly rebased without progress.

---

## Recommended Architecture

Use **one cron command**:

```bash
/train
```

Internally, `/train` should run these phases:

```text
preflight
triage
dedupe
parallel-repair
validate
merge
deploy-watch
queue-health
```

Optional internal subcommands may exist for debugging or manual use:

```bash
/train --phase triage
/train --phase repair --pr <number>
/train --phase deploy-watch
/train --max-workers 8
/train --dry-run
```

The cron should call only `/train`.

---

# Skill Instructions

## 1. Preflight

Before touching PRs, verify repo and production health.

Check:

- Main branch builds.
- Required CI systems are reachable.
- Deployment pipeline is healthy.
- There is no active production incident.
- The local environment has required tools installed.
- Git auth, GitHub auth, package manager auth, and deployment auth are valid.

If main is broken or production deploys are failing, pause normal merging and prioritize fixing the main/deploy blocker.

Do not merge a large batch of PRs into a blocked deploy pipeline.

---

## 2. Load Open PRs

Fetch all open PRs and collect:

- PR number, title, author, branch, base branch.
- Age and last update time.
- CI status.
- Mergeability.
- Conflicts.
- Review state.
- Bot comments.
- Human review comments.
- Changed files.
- Diff size.
- Test failures.
- Labels.
- Whether it appears generated by Cursor or another automation.
- Whether it overlaps with other open PRs.

Update local main before processing:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
```

Each PR must be processed in its own isolated worktree.

---

## 3. Classify PRs

Assign every PR a category.

### Ready to merge

A PR is ready when:

- It has no conflicts.
- Required CI passes.
- Required reviews are satisfied.
- No unresolved blocking bot comments remain.
- No unresolved human review comments remain.
- It is not duplicative.
- It is low or acceptable risk.

Merge these first.

### Quick repair

A PR is a quick repair when it likely needs only:

- Rebase or merge from main.
- Simple conflict resolution.
- Formatting fix.
- Typecheck fix.
- Test update.
- Small response to CodeRabbit, SonarCloud, or other bot review.
- Small response to human review.
- Simple CI failure fix.

Process these next.

### Needs review

A PR needs review when:

- It changes risky code paths.
- It has medium/large diff size.
- It has unclear behavior.
- It touches auth, billing, security, migrations, infra, production deploy config, or data deletion.
- Bot or human comments imply architectural concern.
- Tests are missing for meaningful behavior changes.

Run `/review` or `g-stack/review` before merging when the PR risk justifies it.

### Parked

A PR may be temporarily parked when:

- It requires product judgment.
- It has broad architectural implications.
- It needs significant implementation work.
- It has repeated CI failures with unclear cause.
- It conflicts heavily with active changes.
- It appears unsafe to auto-merge.

Parked PRs must receive a label or status note explaining why they were skipped.

Parked PRs must not be starved. Their priority should increase with age and repeated skips.

---

## 4. Deduplicate PRs

Before doing expensive repo analysis, look for obvious duplication.

A PR may be duplicate or superseded when:

- Two PRs have nearly identical titles.
- Two PRs modify the same narrow file set for the same issue.
- One PR clearly implements a fix already present in another PR.
- One PR is a generated Cursor PR that repeats an already merged or open change.
- Two adjacent PRs obviously step on each other.

When duplication is obvious:

- Prefer the cleaner, newer, smaller, or already-passing PR.
- Close or label the duplicate.
- Leave a concise comment explaining the duplicate relationship.
- Avoid wasting tokens on deep repo-wide analysis unless the duplicate status is unclear.

When two PRs should be combined:

- Merge the dependency first if it is safe.
- Rebase/update the dependent PR afterward.
- If appropriate, fold the smaller PR into the stronger one.

---

## 5. Parallel Processing

Process PRs in parallel using isolated worktrees.

Each worker should:

1. Create or reuse a clean worktree for the PR.
2. Fetch the PR branch.
3. Update against latest main.
4. Resolve simple conflicts.
5. Address review comments.
6. Run targeted validation.
7. Push updates.
8. Mark PR state.

Workers must avoid touching the same PR or dependent file set at the same time when doing so would cause churn.

Use locks for:

- PR number.
- Branch name.
- Shared generated files.
- Package lockfiles.
- Database migrations.
- Deployment config.
- Any file known to cause broad conflicts.

---

## 6. Update and Conflict Resolution

For each processable PR:

1. Rebase or merge against latest main according to repo convention.
2. Resolve simple merge conflicts.
3. Prefer preserving the PR intent.
4. Avoid broad rewrites.
5. Run formatting after conflict resolution.
6. Run targeted tests for changed areas.
7. Push the updated branch.

If conflicts are large or semantically unclear, park the PR with a clear reason.

---

## 7. Review Comment Handling

Address review comments in this order:

1. Blocking human reviews.
2. Blocking security or correctness bot comments.
3. Failing CI feedback.
4. Non-blocking bot comments.
5. Style nits.

For CodeRabbit, SonarCloud, G Reptile, or other bot-driven reviews:

- Fix concrete correctness, security, type, test, lint, and maintainability comments.
- Ignore or mark as non-blocking comments that are clearly noisy.
- Avoid broad rewrites for speculative suggestions.

For human reviews:

- Treat explicit requested changes as blocking.
- Make the smallest reasonable change that satisfies the review.
- Push updates back to the PR.
- Leave a concise reply when the fix is non-obvious.

---

## 8. Local Validation

Run the cheapest useful validation first.

Suggested order:

1. Format/lint for changed files.
2. Typecheck for affected package.
3. Targeted unit tests.
4. Targeted integration tests.
5. Full test suite only when risk justifies it.
6. `/review` or `g-stack/review` only when useful.

Use `/review` or `g-stack/review` before shipping when:

- The PR is medium or high risk.
- There were meaningful conflict resolutions.
- Bot comments raised correctness/security concerns.
- Tests were modified substantially.
- The PR touches production-critical areas.
- The PR was generated by an automation and has not had strong validation.

If a local CodeRabbit plugin exists, run it only for PRs where it is likely to catch issues before CI.

---

## 9. CI Failure Handling

For PRs with failing CI:

1. Read the failing job output.
2. Classify the failure as flaky, environmental, test failure, lint/type failure, build failure, or integration failure.
3. Retry only when the failure is likely flaky.
4. Fix deterministic failures directly.
5. Push fixes.
6. Re-run CI.
7. Park only when the failure needs substantial investigation.

Prefer quick wins that unblock many PRs:

- Shared type errors.
- Broken generated files.
- Lockfile mismatches.
- Formatting failures.
- Test fixture drift.
- Main branch regression affecting many PRs.

If many PRs fail for the same reason, fix the root cause once instead of patching every branch separately.

---

## 10. Merge Policy

Merge PRs when they are ready and safe.

Before merging:

- Confirm latest CI state.
- Confirm no unresolved required reviews.
- Confirm no merge conflicts.
- Confirm the PR is not superseded.
- Confirm main/deploy health is acceptable.
- Confirm the PR has been updated recently enough against main.

Merge order:

1. Production/deploy fixes.
2. Main CI fixes.
3. Oldest ready PRs.
4. Low-risk quick wins.
5. Dependency PRs before dependent PRs.
6. PRs that unblock many others.
7. Higher-risk PRs after validation.

After merging a PR:

- Watch CI on main.
- Watch deploy status.
- Stop or slow merging if main breaks.
- Prioritize fixing the break before continuing the train.

---

## 11. Deploy Monitoring

`/train` must monitor production deploy health throughout the run.

If production deploys are blocked:

- Pause normal merge flow.
- Identify the first bad merge or failing deploy step.
- Fix forward when possible.
- Revert only when fix-forward is unsafe or slow.
- Resume merging after production is healthy.

Do not continue merging a large queue into a broken deploy pipeline.

The train should leave the system in one of these states:

- Queue empty.
- Queue reduced and deploy healthy.
- Queue reduced with clear parked PR reasons.
- Main/deploy blocked with the blocker actively identified or fixed.

---

## 12. Starvation Prevention

The train must avoid endlessly rebasing hard PRs without moving them forward.

Track for each PR:

- Number of times seen.
- Number of times rebased.
- Number of times skipped.
- Last meaningful progress.
- Current blocker.
- Age.
- Risk score.

Priority should increase when a PR has been skipped repeatedly.

A PR should move from “parked” back into active processing when:

- The queue is smaller.
- Its blocker is resolved.
- It is old enough to require attention.
- It blocks other PRs.
- It has been repeatedly rebased without progress.

Do not let a hard PR sit beneath hundreds of later PRs forever.

---

## 13. Token and Time Efficiency

Optimize for fast queue reduction.

Rules:

- Avoid deep repo-wide searches unless needed.
- Prefer targeted diffs and changed-file analysis.
- Skip expensive review commands on trivial PRs.
- Batch GitHub/API calls where possible.
- Cache PR metadata during the run.
- Reuse worktrees when safe.
- Prioritize PRs that can be merged with minimal work.
- Avoid repeated rebases on PRs unlikely to merge soon.
- Detect obvious duplicates cheaply.
- Fix shared root causes once.

---

## 14. Output

At the end of each run, produce a concise summary:

```text
Train summary:
- Open PRs at start:
- Merged:
- Updated and pushed:
- Duplicates closed/labeled:
- Parked:
- CI failures fixed:
- Main/deploy status:
- Oldest remaining PR:
- Next priority:
```

For each parked PR, include:

```text
PR #:
Reason:
Next action:
Last attempted:
```

---

# Simplified Final Command Contract

This is the compact version I would put directly into the skill.

```md
# /train

You are the autonomous PR train operator for this repo.

Goal: minimize time to an empty PR queue while keeping main and production healthy.

Run on a frequent cron. Process open PRs using parallel isolated git worktrees. Prefer safe quick wins, but prevent old/hard PRs from starving.

## Flow

1. Preflight:
   - Update local main.
   - Check main CI and production deploy health.
   - If main or deploy is broken, pause normal merges and fix that first.

2. Triage all open PRs:
   - Collect CI state, mergeability, conflicts, reviews, bot comments, changed files, age, risk, and overlap with other PRs.
   - Classify as ready, quick-repair, needs-review, duplicate/superseded, or parked.

3. Deduplicate:
   - Cheaply detect obvious duplicate Cursor/automation PRs.
   - Prefer the cleaner/passing/smaller/newer PR.
   - Close or label duplicates with a short explanation.
   - Avoid expensive repo-wide analysis unless duplication is unclear.

4. Process in parallel:
   - Use isolated worktrees and locks per PR/branch/shared file set.
   - Rebase or merge against main per repo convention.
   - Resolve simple conflicts.
   - Address blocking human reviews first, then concrete bot comments from CodeRabbit, SonarCloud, G Reptile, or similar tools.
   - Fix deterministic CI failures.
   - Push updates.

5. Validate:
   - Run the cheapest useful checks first: format/lint, typecheck, targeted tests, then broader tests only when needed.
   - Use `/review`, `g-stack/review`, or local CodeRabbit only for medium/high-risk PRs, meaningful conflict resolutions, production-critical changes, or automation-generated changes that need extra review.

6. Merge:
   - Merge only when CI passes, required reviews are satisfied, conflicts are gone, the PR is not duplicate, and main/deploy health is acceptable.
   - Merge deploy/main fixes first, then oldest ready PRs, then quick wins, then dependency PRs before dependents.
   - After each merge batch, monitor main CI and production deploys.
   - If main or deploy breaks, stop merging and fix forward or revert.

7. Starvation control:
   - Track skips, rebases, age, blocker, and last meaningful progress.
   - Increase priority for repeatedly skipped or old PRs.
   - Avoid rebasing the same hard PR forever without moving it toward merge.
   - Park only with a clear reason and next action.

8. End-of-run summary:
   - Report start count, merged PRs, updated PRs, duplicates handled, parked PRs, CI fixes, deploy status, oldest remaining PR, and next priority.

## Merge bias

Merge safe PRs fast. Fix shared root causes once. Spend tokens only where they materially reduce queue time or protect production. Keep production deployable at all times.
```
