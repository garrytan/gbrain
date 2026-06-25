# Fork And Upstream Policy

This checkout should track upstream GBrain and carry downstream patches on the
fork as a small, reviewed patch queue.

## Decision

- Runtime installs may pin to `origin` so local patches are controlled.
- `upstream` stays the moving base for GBrain code.
- Downstream patches should stay narrow, named, and reviewed against upstream.
- Do not turn the fork into an independent distribution unless upstream
  repeatedly breaks the local runtime after the checks below pass.

## Required Remote Shape

Expected remotes:

```text
origin   downstream fork, fetch and push allowed
upstream https://github.com/garrytan/gbrain.git, fetch allowed, push disabled
```

The upstream push URL should be disabled. A checkout that can push to upstream is
the wrong shape for local runtime work.

## Tracking Loop

Use the propagation-compliance loop when deciding whether to keep, update, or
drop a local patch:

```text
Goal predicate: fork stays close to upstream while preserving proved local fixes.
Progress signal: upstream ahead/behind count, named local commits, PR/CI state.
Budget: one focused branch or patch family per pass.
Stop path: stop at a readback when branch role, PR state, or tests are unclear.
```

The proof gate is:

1. Refresh refs with `git fetch --all --prune`.
2. Run `bun run check:upstream -- --fetch`.
3. For each candidate local patch, inspect `upstream/master...<branch>` and
   `origin/master...<branch>`.
4. Check PR state and CI before landing or deleting anything.
5. Use patch-equivalence only after the branch role is clear.
6. Run targeted tests for the touched code before calling a patch keeper-ready.

Ancestry alone is not enough. Squash merges and backports can make useful
patches look stale, or make stale patches look unique.

## When To Pin The Fork

Pin runtime to the fork when:

- a local patch protects runtime safety, spend, privacy, or data correctness;
- the installed binary has passed the local proof gate;
- the receipt is labeled as fork-installed truth.

## When To Track Upstream More Closely

Prefer upstream when:

- the upstream fix covers the same behavior;
- the local patch is only a temporary backport;
- the patch-equivalence readback says the fork copy is now redundant;
- the local branch has no current PR, CI, or targeted-test proof.

## Commands

```bash
bun run check:upstream -- --fetch
bun run check:upstream-watch -- --fetch
git log --oneline upstream/master..HEAD
git log --oneline HEAD..upstream/master
git diff --stat upstream/master...HEAD
```

## Scheduled Readback

The repo's scheduled watch lives in [`.github/workflows/upstream-watch.yml`](../../.github/workflows/upstream-watch.yml).
It runs twice a week on a fresh `master` checkout, adds `upstream` in
fetch-only shape, runs the same readback, and keeps one tracking issue open
while `upstream/master` is ahead of the fork. The automation is intentionally
read-only: it does not merge, rebase, or change an active developer checkout.

When the watch opens or updates the issue, do the actual adoption manually on a
clean branch and run the targeted tests for whatever upstream fix you carry
over.

For release or PR readiness, use the repo's normal review and ship path. This
policy is a readback and triage surface, not merge permission.
