---
title: "Ideal repo settings"
type: guide
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
topic: music-production
message_count: 10
tags: [chatgpt, knowledge, music-production]
---
# Ideal repo settings

> **Source:** ChatGPT conversation
> **Date:** 2025-08-30T16:42:49Z
> **Messages:** 10
> **Topic:** music-production

## Question

{'asset_pointer': 'file-service://file-7DXFnwbtkNBWCbzQh6hPZQ', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 771, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 352425, 'width': 963}
What is the ideal settings for us?

## Answer

Mr. White — here’s what I’d set for your repo with many small AI-agent PRs and Vercel/Neon hooks:

- **Require merge queue:** ON  
- **Merge method:** **Squash** (keeps history clean; one commit per PR)
- **Build concurrency:** **2** (bump to 3 only if runners aren’t a bottleneck)
- **Minimum group size:** **1**
- **Maximum group size:** **1** (avoid coupled failures; add to 2 later if needed)
- **Wait time to meet min group size:** **0–2 min** (I’d use **0**)
- **Require all queue entries to pass required checks:** **ON**

**Required checks (gate the queue on these):**
- Biome format/lint
- Type check (`tsc`)
- Unit tests
- Smoke E2E (fast)
- Next.js production build (fail on console errors)
- Preview deploy success (Vercel)
- DB migration dry-run (Neon/Drizzle) + “no outstanding migrations” check

**Branch protection extras:**
- Require **1 approval** (CODEOWNERS for sensitive areas)
- Dismiss stale reviews on new commits
- Block force-push; allow squash merges only

This gives safe, serial merges with minimal CI thrash and clean history. If queue length grows and CI is stable, raise **build concurrency to 3** and **max group size to 2**.

## Question

Should we ever merge QON production if we're only ever merging from preview?

## Answer

Short answer: **No.** Protect **production** so it only ever gets the auto-promotion from **preview**.

Only exceptions:
1) **Emergency hotfix:** branch from `production`, PR into `production` through the same checks, then immediately **back-merge/cherry-pick** that commit into `preview` to re-align.
2) **Revert:** revert on `production` (via PR), then apply the same revert on `preview`.

Policy:
- Target all normal PRs → `preview`.
- Bot/queue promotes `preview` → `production` after checks.
- **Disallow** other bases into `production` (no feature→prod PRs, no direct pushes).
- After any exceptional prod change, **sync preview** so histories don’t drift.

That keeps a single promotion path, clean history, and predictable rollbacks.

## Question

So Merge Queue is enabled now, and when I go to, like, there's, like, 8 DependBot PRs right now, and when I go to them, I have a Merge When Ready button. Um, is there any way that that can just be on by default, instead of me having to go through and turn those on? I'm just, anytime a DependBot opens up a Merge PR, it just goes to the Merge Queue and merges after it passes checks.

## Answer

Mr. White — yes. Make Dependabot PRs **auto-enqueue + merge** as soon as checks pass.

## How to do it (clean + native)
1) **Ruleset just for Dependabot PRs**
- Create a repo/organization **Ruleset** targeting `pull_request`.
- **Conditions:** author = `dependabot[bot]` OR label = `dependencies`.
- **Require status checks** (your CI list), **do not require reviews** (or set = 0), **require merge queue**.
Result: no human approval needed, but all checks + queue still apply.

2) **Workflow to turn on Auto-merge by default**
Add this file:

```yaml
# .github/workflows/dependabot-auto-merge.yml
name: Enable auto-merge for Dependabot

on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize]

permissions:
  pull-requests: write
  contents: write

jobs:
  enable:
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Fetch metadata
        id: meta
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      # Optional: only auto-merge patch/minor bumps
      - name: Enable auto-merge (squash)
        if: contains(fromJson('["version-update:semver-patch","version-update:semver-minor"]'), steps.meta.outputs.update-type)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: gh pr merge --auto --squash "$PR_URL"
```

> With merge queue required, **Auto-merge ⇒ auto-enqueue**. When checks go green, the PR is added to the queue and merged by the queue.

### Optional refinements
- In `.github/dependabot.yml`, **group** related updates and restrict to **security + patch/minor** to keep the queue smooth.
- If you must keep CODEOWNERS reviews for deps, add a second workflow to **auto-approve** (bot review) or keep a ruleset that **exempts** Dependabot PRs from CODEOWNERS while still requiring checks.

This setup removes the “Merge when ready” click—Dependabot PRs will flow into the queue and merge themselves once CI passes.

## Question

For our ruleset that applies to everything merging into Preview, I already have RequiredApproval set to 0. And then under that I have DismissStale, PullRequest true, RequireReviewFromCodeReviewers false, RequireApprovalOfTheMostRecentReviewablePush false, RequireConversationResolutionBeforeMerging false, AutomaticallyRequestCopilotCodeReview true. BlockForcePush is true. RequireBranchesToBeUpToDate true. And then we have our checks, but I don't see anything else that's true related to reviews. I have RestrictDeletions true, RequireLinearHistory true, but that's it. Is there anything else that would be blocking it?

## Answer

Mr. White — nothing in that ruleset screams “blocking.” The blocker is usually that **GitHub won’t auto-enable Auto-merge for new PRs** by itself. You must (a) allow auto-merge at the repo level and (b) flip it on per-PR (manually or via workflow/API).

Quick checklist to make Dependabot PRs auto-enqueue:

1) **Repo setting:** Settings → General → **Allow auto-merge** = ON.  
2) **Merge method:** enable **Squash** (what the queue will use).  
3) **No other rulesets/legacy protections** forcing reviews (org-level rulesets or classic branch protections with “Require review from Code Owners”).  
4) **Auto-enable auto-merge** for bot PRs via workflow (recommended):
   - Use the `pull_request_target` + `gh pr merge --auto --squash` job gated on `github.actor == 'dependabot[bot]'` (as I sent). That’s what turns “Merge when ready” on automatically.
5) Optional blockers to look for if it still won’t queue:
   - PR is **Draft**.
   - A required check isn’t reported (or names don’t match exactly).
   - **Require signed commits** is ON but Dependabot’s commits aren’t signed.
   - Another ruleset enforces **code owner reviews** or **required reviewers**.
   - Repo disallows the chosen merge method (e.g., squash disabled).

Bottom line: with approvals=0, reviews aren’t blocking you; **the missing piece is auto-enabling Auto-merge** for Dependabot PRs (via repo setting + tiny workflow).

## Question

So I have to make a custom workflow to enable it, basically.

## Answer

Yes, Mr. White — GitHub won’t auto-toggle **Auto-merge** per PR. Add a tiny workflow to do it for Dependabot.

```yaml
# .github/workflows/dependabot-auto-merge.yml
name: Dependabot auto-merge
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize]
permissions:
  pull-requests: write
  contents: write
jobs:
  enable:
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: dependabot/fetch-metadata@v2
        id: meta
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
      # optional: limit to patch/minor
      - if: contains(fromJson('["version-update:semver-patch","version-update:semver-minor"]'), steps.meta.outputs.update-type)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh pr merge --auto --squash "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/pull/${{ github.event.number }}"
```

Prereqs:
- Repo setting **Allow auto-merge** = ON.
- Squash merges enabled.
- Your ruleset requires merge queue + checks (no approvals needed).
