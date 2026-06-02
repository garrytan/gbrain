---
title: "Windsurf Copilot planning loop"
type: guide
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
# Windsurf Copilot planning loop

> **Source:** ChatGPT conversation
> **Date:** 2025-08-09T20:39:26Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

So, Windsurf is doing a good job of taking the plan.md file, when I asked it to. It's taking the plan.md file, and it's breaking up all the tasks into small copilot-friendly tasks, and it's opening up GitHub issues, and it's assigning copilots to tackle them. Copilot is automatically jumping in and tackling those issues. This is great. And then it's opening up pull requests. And then when I ask Windsurf to review those pull requests, it can review them. It can merge them and everything. I'd like to tell Copilot, basically, to do this. I want to say, I basically want to have a way that I can keep giving it new ideas for features and things to fix. It's kind of like an input thing, and I don't know what the best way to do that is. I could just copy and paste this right into the chat, or I could create a markdoc file and just keep updating the markdoc file and have it recursively check that. But what I would like it to do is, basically, you have a situation where you have a plan.md file. 

## Answer

Mr. White — here’s the clean way to run your “Windsurf plans, Copilot codes, steward auto-merges” loop:

- Use **one inbox file** for ideas (`/ops/inbox.markdoc`) and **one normalized plan** (`/ops/plan.md`).  
- Let a **GitHub Action (every 15 min)** do the boring parts: promote inbox → plan, open/link issues, and steward PRs (enable auto-merge when checks pass; relabel + comment when they fail).  
- Keep Windsurf strictly as **Planner & PR Steward** via a fixed prompt: review PRs, label/request changes, mark “ready-to-merge,” open/split issues, and top up `plan.md` from the inbox when idle. No coding.

I dropped a ready-to-paste kit (files, labels, workflow, and the Windsurf prompt) in the canvas: **“Windsurf–Copilot PR Loop Kit.”**  
Add those files, enable Auto-merge, and start dumping ideas into `/ops/inbox.markdoc`. The loop handles the rest.

Want me to tailor the parser to your current `plan.md` format next?

## Question

Okay, so it seems to be seems to be working-ish. Can you take a look at our GitHub repo and take a look at the issues and the pull requests? It doesn't seem like it's merging pull requests. It's definitely creating issues, but it seems like it's stopping and not continuing to go.

## Answer

Mr. White — I checked your repo. Here’s why it’s “stopping” and not merging:

1) Most Copilot PRs are **Drafts**, so the steward refuses to merge them. Example: #201 and #202 are draft PRs. Drafts never auto-merge. citeturn2view0turn2view1  
2) Copilot hit a **git-hook error** on #201 (“configured Git hook”), which stalled its follow-up steps. citeturn2view0  
3) The environment PR **#190 (develop → preview)** is open with conflicts/needs-changes, so the loop can’t promote that branch. citeturn9view0  
4) Your workflows **are** firing (AI Loop + Plan → Issues → Copilot), which explains why issues keep getting created. citeturn4view0turn6view0

What to change (fast path)
- Instruct Windsurf/Copilot to **undraft** PRs when done and add `ai:ready-for-review`; after Windsurf is satisfied, have it add `ai:ready-to-merge`. Your current steward merges only when **not draft** + `ai:ready-to-merge` + checks passing. citeturn5view0  
- **Enable Auto-merge** in repo settings (if not already). Without it, the steward’s `enablePullRequestAutoMerge` call is a no-op. citeturn5view0  
- **Resolve conflicts on #190** (or recreate it) so the promote path isn’t blocking. citeturn9view0  
- **Tame the git hooks** for Copilot: either skip Husky in CI (`HUSKY=0` in Copilot’s env) or guard your hooks to early-exit on CI. That removes the “configured Git hook” failure Copilot hit on #201. citeturn2view0

Optional steward tweak (if you want fewer labels):
- In `.github/workflows/ai-loop.yml`, relax the merge gate: allow auto-merge when PR is **Approved** + checks pass, even if the `ai:ready-to-merge` label is missing. (Right now it requires that label AND not a draft.) citeturn5view0

If you want, I can draft the tiny changes: a one-liner Husky guard, an update to your Windsurf prompt to enforce undrafting/labels, and a small steward rule to permit “Approved” PRs to auto-merge.

## Question

Copilot is leaving most of the PRs as drops and asking me to review them. Is there a way I can skip that entirely and just get them all merged if the checks pass?

## Answer

Yes. Two switches + one tiny workflow and you’re hands-off:

1) Repo settings (per protected branch: `develop`/`preview`/`main`)
- Enable **Require status checks to pass** (pick your CI checks).
- **Disable required reviews** (no approvals, no CODEOWNERS requirement).
- Optional: turn on **Allow auto-merge** (not required for the workflow below).

2) Add this workflow to auto-undraft and auto-merge when checks pass (and skip anything with `blocked`):

```yaml
# .github/workflows/auto-merge-ai.yml
name: Auto-merge AI PRs
on:
  workflow_run:
    workflows: ["CI"]   # ← exact name of your test/build workflow
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  merge:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const owner = context.repo.owner;
            const repo  = context.repo.repo;
            const sha   = context.payload.workflow_run.head_sha;

            // find the PR for this CI run
            const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
            const pr  = prs.find(p => p.head.sha === sha);
            if (!pr) return;

            // skip if human said "don't"
            const labels = new Set(pr.labels.map(l => l.name));
            if (labels.has('blocked') || labels.has('human-review')) return;

            // only fast-path AI work (optional: comment this line to merge everything)
            if (!labels.has('ai-task')) return;

            // drafts can't merge — mark ready
            if (pr.draft) {
              await github.graphql(
                `mutation($id:ID!){ markPullRequestReadyForReview(input:{ pullRequestId:$id }){ clientMutationId } }`,
                { id: pr.node_id }
              );
            }

            // re-check checks + statuses
            const checks = await github.rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 });
            const failing = checks.data.check_runs.some(c => c.status !== 'completed' || !['success','neutral','skipped'].includes(c.conclusion||''));
            const statuses = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
            const ok = !failing && statuses.data.state === 'success';
            if (!ok) return;

            // merge + cleanup
            await github.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: 'squash' });
            try {
              if (pr.head.repo.full_name === `${owner}/${repo}`) {
                await github.rest.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` });
              }
            } catch (e) {}
```

That’s it. Copilot can keep opening PRs as drafts; this job flips them to “ready” and merges as soon as CI is green—no manual review.  
If you want literally **everything** merged on green, remove the `ai-

*(Answer truncated — 3018 chars total)*
