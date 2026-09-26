---
name: oss-loop
description: |
  Run a focused open-source contribution loop: inspect the target repository,
  implement one independently reviewable change, validate it, and prepare an
  upstream pull request only after the target and CI policy are verified. Use
  for OSS fixes, candidate waves, PR follow-up, or requests to keep iterating
  until checks are green. Shared by Claude Code and Codex; it never assumes a
  personal fork is the publication target.
triggers:
  - "OSS loop"
  - "OSS contribution"
  - "open source PR"
  - "prepare an upstream PR"
  - "check OSS candidates"
  - "iterate until CI is green"
tools:
  - exec
mutating: true
brain_first: exempt
---

# OSS Contribution Loop

This is the shared contribution workflow for Claude Code and Codex. The
repository's `skills/` copy is canonical; generated plugin trees carry the
same skill to both harnesses.

## Non-negotiable target check

Before pushing or creating a PR, run the bundled target check from the current
repository:

```bash
bash skills/oss-loop/scripts/verify-target.sh --target garrytan/gbrain
```

When creating a Draft PR, use the bundled wrapper so the publication target and
fully qualified source branch cannot be selected implicitly by the checkout:

```bash
bash skills/oss-loop/scripts/create-upstream-draft.sh \
  --target garrytan/gbrain \
  --head YOUR_GITHUB_OWNER:YOUR_BRANCH \
  --title "<current release> <kind>: <summary>" \
  --body-file /path/to/pr-body.md
```

Do not call `gh pr create` directly for this workflow. The wrapper requires an
explicit canonical target, a fully qualified `OWNER:BRANCH` head, and creates a
Draft PR only after rerunning the target check.

Use the repository's documented canonical target when working on another OSS
project. If the target is not explicit or the check fails, stop before any
push or PR creation. A personal fork may be used for local validation, but it
is never the publication target unless the user explicitly asks for a fork PR.

The check must establish all of the following:

- the requested target is the canonical upstream repository;
- the current source repository is shown separately from that target;
- the GitHub CLI is authenticated for that target;
- the current branch and working tree are visible before mutation.

## Independent review gates

Before creating a Draft PR for `garrytan/gbrain`, run two separate reviews at
the exact candidate HEAD. Do not combine these prompts or treat CI as a
substitute for either review:

1. **Code-quality review** — inspect correctness, regression risk, test
   discrimination, and unsupported claims. Resolve Critical and Warning
   findings and rerun this review after changes.
2. **Maintainer-lens review** — review independently against the
   `新規 PR 提出前チェックリスト` section of
   `project_gbrain_upstream_maintainer_policy.md` (the Claude-side policy
   source is normally under `~/.claude/projects/.../memory/`). Check in
   particular: fix-only/minimal scope, no frozen new doctor or warn-only
   feature surface, no destructive or high-blast-radius expansion, no bundled
   unrelated feature, and the required discrimination test. Also check that
   the PR presentation contains no AI-review verdicts or other review-theater
   material.

The maintainer-lens result must be exactly one of:

- `SAFE`: the candidate may proceed to Draft, subject to the remaining gates;
- `RISKY` or `WOULD-CLOSE`: invalidate approval, stop, and return to candidate
  replanning. Do not “fix until SAFE” on the same candidate without a new
  scope decision. An explicit maintainer invitation for the category is the
  only exception and must be recorded with its evidence.

Record the verdict outside the PR body, bound to the exact head SHA. A verdict
for an older SHA is invalid after any push. The record may be local to the
harness (Claude uses `~/.claude/state/oss-maintainer-lens-verdicts.json`), but
the workflow must report its location and SHA. Never invent a `SAFE` result
when the policy source or independent review is unavailable.

For an existing Draft or Ready PR with no valid SHA-bound `SAFE` record, run
the maintainer-lens review before treating it as complete. If it returns
`RISKY`/`WOULD-CLOSE`, do not silently close or rewrite the PR; surface the
reason and keep it from Ready/merge until the disposition is explicit.

## Contract

- Keep the canonical upstream target explicit for every push and pull request.
- Keep each candidate isolated and independently reviewable.
- Treat CI as incomplete until every required check is Green; skipped or pending
  checks remain separate from passed checks.
- Preserve the user's worktree and report any blocked or unavailable step
  without silently treating it as success.

## Loop

1. Read `AGENTS.md`, `CLAUDE.md`, the relevant reference docs, and the
   repository's release/contribution rules before editing.
2. Inspect the target repository's current issues and PRs, then select one
   narrow candidate. Keep independent candidates in separate worktrees and
   branches.
3. Implement the smallest complete change with a regression test. Do not
   broaden a candidate merely because another candidate is available.
4. Run the two independent review gates above, then the focused checks and the
   repository's required CI-equivalent gate when feasible. Report skipped or
   unavailable checks separately from passed checks.
5. Run the target check again immediately before pushing or creating the PR.
   Create the PR against the canonical upstream repository explicitly, normally
   as Draft. From a fork checkout, pass both `--repo garrytan/gbrain` and a
   fully qualified `--head OWNER:branch`; never let the current `origin` pick
   the publication repository implicitly.
6. Keep the PR Draft until all required checks are green **and** the current
   HEAD has a `SAFE` maintainer-lens verdict. `pending`, `skipped`, or a stale
   result is not Green. Only then mark it ready when the user has authorized
   publication.
7. For a fork PR superseded by an upstream PR, close the fork PR with a clear
   supersession note; do not delete branches or force-push without a separate
   authorization.

## Anti-Patterns

- Do not let the current `origin` or checkout decide the publication target.
- Do not publish to a personal fork when the requested target is upstream.
- Do not mark a Draft ready because local tests pass while required CI is
  pending, skipped, stale, or failed.
- Do not combine unrelated candidate fixes into one PR or hide missing evidence
  behind a generic "passed" summary.

## Output Format

Report one candidate at a time with:

1. target repository and source branch;
2. change summary and focused validation;
3. CI counts split into passed, skipped, pending, and failed;
4. PR state and the next action.

Use `blocked` or `incomplete` when evidence is missing. Never claim Green until
all required checks are complete and successful.

## Reporting

For every candidate, report: target repository, branch, PR state, passed,
skipped, pending, and failed checks, plus the next action. Never claim Green
when any required check is pending or unavailable.
