---
title: "Windsurf Linear integration"
type: guide
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
conversation_id: 68969a26-941c-832d-9cda-6673cd9df3e9
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Windsurf Linear integration

> Conversation ID: 68969a26-941c-832d-9cda-6673cd9df3e9
> Created: 2025-08-09T00:45:39Z
> Updated: 2025-08-09T00:48:50Z
> Messages: 6

---

## User

can i have windsurf open linear issues and assign copilot to work on them?

---

## Assistant

Yes — Windsurf can open Linear issues and assign GitHub Copilot (or Claude/other AI agents) to work on them, but it’s not “native” out of the box.  

You’d need to set up the pieces like this:  

1. **Connect Windsurf to Linear**  
   - Windsurf can pull from APIs, so you’d use the [Linear API](https://developers.linear.app/docs/graphql/get-started) to:
     - Fetch open issues (query by team/project/status).
     - Create new issues if needed.
     - Update issues (assign, change status, add comments).
   - You’ll need a Linear API key stored in Windsurf’s env.

2. **Map Linear issues to dev tasks in Windsurf**  
   - Windsurf plan files can reference external issues as tasks.
   - The plan step could include “claim issue #123” → Windsurf will then work on that branch/code.

3. **Assign AI (like Copilot) to the issue**  
   - This isn’t “assign” in Linear in the human sense — Copilot doesn’t live in Linear.
   - What you can do:
     - In Windsurf’s plan, add a `prompt` that includes the issue description + acceptance criteria from Linear.
     - Windsurf then calls Copilot CLI (or API) in your IDE to work on it.
     - Optionally update the Linear issue status to “In Progress” automatically.

4. **Automation flow**  
   Example:
   - Create a Linear view for “Ready for AI” issues.
   - Windsurf fetches them daily/hourly.
   - It creates a new branch per issue.
   - Sends the task prompt to Copilot (or Claude) in the local repo context.
   - Pushes changes and updates the Linear issue when done.

If you want, I can write you a **ready-to-run Windsurf plan file** that:  
- Pulls from Linear  
- Assigns to “Copilot”  
- Generates branches  
- Pushes back and closes issues when the PR is merged.  

Do you want me to go ahead and make that plan?

---

## User

well i have linear mcp setup in windsurf. and linear can sync to githup issues and i think if you tag @copilot you can assign copilot yes?

---

## Assistant

Short answer: **yes**, Mr. White—with two caveats.

1) **Assigning Copilot happens on GitHub, not Linear.**  
GitHub’s new Copilot *coding agent* lets you **assign an issue to Copilot** exactly like a human. Copilot then plans, opens a PR, pushes commits, and asks for review. You assign it via the issue’s *Assignees* → **Copilot** (the bot login is `copilot-swe-agent`). Mentioning `@copilot` in PR comments is for follow-ups, **not** assignment. citeturn1view0turn0search15turn0search9

2) **Your Linear → GitHub flow is fine, but the “assign” must land in GitHub.**  
Linear can sync issues with GitHub and keep PRs/status in lockstep. Use that to create/track work from Linear, but make sure the GitHub-side issue ends up with **Copilot as the assignee** so the agent actually runs. citeturn0search11

### Minimal setup that works
- Keep **Linear MCP** in Windsurf for issue discovery/creation. citeturn0search8turn0search2  
- Ensure **Linear⇄GitHub Issues sync** is on for the repo. citeturn0search11  
- In the synced **GitHub** issue: set **Assignees → Copilot** (or via API/CLI using the `copilot-swe-agent` ID). citeturn1view0

If you want, I can add a tiny Windsurf/Cascade step that: finds “Ready for AI” Linear tickets → ensures a matching GH issue exists → assigns **Copilot** automatically → posts the PR link back to Linear.

---

## User

i can skup linear if thats better. i just want windsurf to trigger background agents for jobs and then check the prs and merge them back in so the plan can windsurf made can be tactled concurrently

---

## Assistant

Yes, Mr. White. Skipping Linear makes this cleaner. Do it “headless” with Windsurf → GitHub only.

# What to wire up
1) **Prereqs**
- Copilot Agent enabled on the repo (Copilot Business/Enterprise).
- Repo setting “Allow auto-merge” ON.
- Branch protection: require checks `build`, `test`, `lint`.
- `GH_TOKEN` (repo + issues + workflows) in repo + your local Windsurf env.

2) **Windsurf → GitHub Issue → Copilot**
Have Windsurf spawn a GH issue per task and assign Copilot. Minimal script (call from a Windsurf plan step):

```ts
// scripts/assign-to-copilot.ts
import { Octokit } from "octokit";
const [owner, repo, title, body] = process.argv.slice(2);
const octo = new Octokit({ auth: process.env.GH_TOKEN });

(async () => {
  const { data: issue } = await octo.rest.issues.create({ owner, repo, title, body, labels: ["ai:copilot","ready"] });
  // Copilot agent user usually: "copilot-swe-agent" (org-wide); fallback if your org differs
  await octo.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: ["copilot-swe-agent"] });
  console.log(issue.html_url);
})();
```

Windsurf plan step (pseudo):
```
- name: Queue AI job
  run: node scripts/assign-to-copilot.js <owner> <repo> "$ISSUE_TITLE" "$ISSUE_BODY_WITH_AC"
```

3) **Auto-merge when green**
Drop this workflow in `.github/workflows/auto-merge.yml`:

```yaml
name: Auto-merge when green
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
  check_suite:
    types: [completed]
permissions:
  pull-requests: write
  contents: write
  checks: read
jobs:
  merge:
    runs-on: ubuntu-latest
    if: github.event_name == 'check_suite' || contains(join(github.event.pull_request.labels.*.name, ','), 'ai:copilot')
    steps:
      - uses: actions/checkout@v4
      - name: Enable automerge if all required checks passed
        uses: actions/github-script@v7
        with:
          script: |
            const pr = context.payload.pull_request ?? (
              await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: context.issue.number
              })
            ).data;
            // gate: only merge if required checks successful
            const { data: combined } = await github.rest.repos.getCombinedStatusForRef({
              owner: context.repo.owner, repo: context.repo.repo, ref: pr.head.sha
            });
            if (combined.state !== 'success') return;
            // turn on automerge (squash) – requires repo setting "Allow auto-merge"
            await github.graphql(`
              mutation($repoId:ID!, $prId:ID!){
                enablePullRequestAutoMerge(input:{pullRequestId:$prId, mergeMethod:SQUASH}){ clientMutationId }
              }`, {
              repoId: pr.base.repo.node_id,
              prId: pr.node_id
            });
```

4) **PR hygiene + review routing (optional but good)**
Add a labeler + reviewer workflow to keep humans in the loop but not in the way:

```yaml
# .github/workflows/label-and-review.yml
name: Label & request review
on: pull_request
permissions: pull-requests: write
jobs:
  tag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const files = await github.paginate(
              github.rest.pulls.listFiles, { owner: context.repo.owner, repo: context.repo.repo, pull_number: context.payload.number }
            );
            const touchesCode = files.some(f => f.filename.match(/\.(ts|tsx|js|py|go|rb|java|kt|swift)$/));
            const add = [];
            if (touchesCode) add.push('ai:code-change');
            if (add.length) {
              await github.rest.issues.addLabels({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.payload.number, labels: add });
            }
            await github.rest.pulls.requestReviewers({
              owner: context.repo.owner, repo: context.repo.repo, pull_number: context.payload.number,
              reviewers: ['itstimwhite'] // or CODEOWNERS
            });
```

5) **Concurrency (lots of tickets at once)**
- Windsurf spawns multiple issues (one per task).  
- Each issue gets `ai:copilot` label + Copilot assignee.  
- GitHub will run them in parallel; your CI handles build/test per PR.

6) **Close the loop back to Windsurf**
Have Windsurf poll PRs (or listen via a webhook) and mark the plan step “done” when:
- PR merged → mark task complete.  
- PR fails checks → reopen the issue and re-queue with a stricter prompt (Windsurf can auto-post a comment to the issue with failure logs).

# TL;DR
- Yes, skip Linear.  
- Windsurf creates GH issues → assign `copilot-swe-agent` → Copilot opens PRs → CI runs → workflow auto-merges when green → Windsurf marks tasks complete.  

Want me to drop these files into your repo with your owner/repo wired and a Windsurf plan stub that batches a list of tasks?


## See Also
- [[chatgpt/chatgpt_chatgpt-linear-integration]]
- [[chatgpt/chatgpt_claude-in-linear-integration]]
- [[chatgpt/chatgpt_github-linear-integration-setup]]
- [[chatgpt/chatgpt_linear-github-integration]]
- [[chatgpt/chatgpt_sentry-linear-integration-issues]]
