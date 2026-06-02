---
title: "CI Unit Test Strategy"
type: note
created: 2026-03-07
updated: 2026-03-07
source: chatgpt-export
conversation_id: 69aca0fa-9150-8333-9b78-480944d631b0
message_count: 4
tags: [chatgpt, import]
---
# CI Unit Test Strategy

> Conversation ID: 69aca0fa-9150-8333-9b78-480944d631b0
> Created: 2026-03-07T22:04:43Z
> Updated: 2026-03-07T22:23:18Z
> Messages: 4

---

## User

In our ci in Jovie having a lot of things get stuck in Maine because Un tests are failing and then that blocks deploy. I’m thinking about adding unit tests but just changed files to block on PR’s good or bad idea. Does that go against our ethos for how we set up our CI.

---

## Assistant

Mr. White,

This is a reasonable idea, with one condition: keep it narrow.

Based on your current CI setup, the repo’s ethos is clear:

- PRs are meant to stay fast and deterministic.
- Heavy validation is pushed to post-merge or opt-in via the `testing` label.
- Path-based gating is already part of the design. The workflow has a centralized `ci-path-changes` job and already computes `run_test` from changed paths. fileciteturn10file0L1-L28 fileciteturn10file0L48-L66
- The docs explicitly say PRs run only the fast merge gate, while full verification happens after merge to `main` or when `testing` is added. fileciteturn10file0L1-L7 fileciteturn10file0L603-L610

So:

Adding blocking unit tests on PRs does shift the ethos somewhat.
Adding only fast, affected, changed-scope unit tests fits the ethos.

Why it fits:
Your CI already believes in selective execution. It skips work based on changed paths for build, test, E2E, and Drizzle. fileciteturn10file0L17-L28 fileciteturn10file0L67-L86
So “run only affected unit tests on PRs” is consistent with the existing philosophy of fast gates and scoped checks.

Why it can still go wrong:
Changed-file tests are weaker than true confidence gates. They miss:
- regressions from shared utilities
- transitive breakage in untouched modules
- integration issues that unit tests won’t catch anyway

My recommendation:

Make PR unit tests:
- affected-only
- fast
- deterministic
- limited to code-changing PRs
- required only after they prove stable

Do not make the whole PR gate depend on flaky or long-running unit coverage. That would fight your current system.

Best structure for Jovie:
- Keep `ci-fast` as the required merge gate.
- Add a second PR unit lane for affected tests only.
- Start it as non-blocking for a week or two.
- Promote it to required once failure rate is mostly real regressions rather than noise.
- Keep full unit suite on `main`.
- Keep full E2E and heavier checks label-gated or post-merge.

Net:
- Full blocking unit tests on every PR: bad fit.
- Blocking affected-only unit tests on PRs: good fit.
- It does not go against your CI ethos if the goal is “catch obvious regressions earlier without slowing the merge gate.”

The clean framing is:
“Fast deterministic PR gate, scoped risk checks before merge, full confidence checks after merge.”

That matches the repo better than either extreme.

I can map this into a concrete change to `ci.yml` if you want.

---

## User

Open an issue

---

## Assistant

Mr. White,

I can’t create it directly from here. The connected Linear/GitHub tools in this session are read-only.

Paste this into Linear under JOV:

**Title**  
PR CI: add affected-only unit test gate so main stops getting blocked by post-merge test failures

**Description**  
## Problem

`main` is getting stuck because unit test failures are being discovered after merge. That blocks deploys, slows recovery, and turns small regressions into production-path incidents.

Our current CI model is optimized for a fast PR gate and heavier verification after merge. That keeps review velocity high, but it also means some unit regressions are reaching `main` and blocking deploy.

## Goal

Catch the highest-signal unit regressions before merge without breaking the current CI philosophy of:

- fast deterministic PR checks
- scoped validation based on changed paths
- heavier verification after merge or via opt-in label

## Proposed change

Add a **PR unit-test lane** that is:

- **affected-only**
- **path-gated**
- **fast**
- **deterministic**
- **limited to unit tests only**

### Intended behavior

For PRs to `main`:

- run unit tests only when relevant app/package/test paths changed
- run only affected tests or the smallest reliable subset tied to changed files
- keep the lane separate from full post-merge validation
- keep full suite / heavier validation on `main`
- keep E2E and other expensive checks opt-in or post-merge

## Why this is worth doing

- prevents bad merges from blocking deploy
- catches obvious regressions earlier
- preserves current fast-PR ethos better than running the full suite on every PR
- fits the existing path-based CI architecture

## Non-goals

- do **not** make PR CI run the full unit suite for every change
- do **not** add flaky or slow tests to the required merge gate
- do **not** collapse the current trunk-based model into a heavyweight pre-merge pipeline

## Suggested implementation direction

- add a PR-only unit job gated by relevant changed paths
- start as **non-blocking**
- measure:
  - runtime
  - flake rate
  - real regressions caught before merge
- promote to **required** once stable
- keep full unit coverage on `main`

## Acceptance criteria

- [ ] PRs with relevant code changes run a scoped unit-test lane before merge
- [ ] Docs-only and non-relevant PRs do not run the lane
- [ ] Runtime stays fast enough to preserve current PR velocity
- [ ] The lane is deterministic and low-flake
- [ ] `main` sees fewer deploy-blocking post-merge unit failures
- [ ] Full unit coverage still runs on `main`

**Suggested priority:** P2

If you want, I’ll turn this into a tighter “founder voice” issue title/body.
