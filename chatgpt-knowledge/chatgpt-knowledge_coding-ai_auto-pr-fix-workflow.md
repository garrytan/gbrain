---
title: "Auto PR Fix Workflow"
type: essay
created: 2026-01-09
updated: 2026-01-09
source: chatgpt-export
topic: coding-ai
message_count: 10
tags: [chatgpt, knowledge, coding-ai]
---
# Auto PR Fix Workflow

> **Source:** ChatGPT conversation
> **Date:** 2026-01-09T20:39:15Z
> **Messages:** 10
> **Topic:** coding-ai

## Question

Yo dawgs, so occasionally Codewrite comes in and blocks the PR because it has an issue and it'll comment one, two, three comments with an issue. The issues are usually relatively easy to solve. If I lay a comment onto the PR and tag Claude or Codex, it'll go in automatically off of the GitHub integration and fix it for me, and then without any human intervention, that will then automatically get rechecked by CodeRabbit, pass the check, and then automatically merge. Is there a way that I can have it so that anytime a PR gets blocked by CodeRabbit and the review is read and merging is blocked, that it automatically tags Claude or Codex to fix, and then only after Codex has fixed it or failed to fix it and it's still blocking do we actually have a human intervention moment?

## Answer

Yes — you can automate this with a GitHub Actions “orchestrator” workflow that:

1) **detects a failed CodeRabbit check** (or “changes requested” review, depending on how you gate merges),  
2) **posts a PR comment that triggers @claude or @codex**,  
3) **waits for the agent to push commits**, then **lets CodeRabbit re-run**,  
4) **escalates to humans only if it’s still failing after N tries**.

CodeRabbit also has **native agent integrations (Claude/Codex)** on their side, which may reduce how much custom glue you need. citeturn0search1turn0search11

---

## The simplest robust pattern (GitHub Actions “triage bot”)

### What you rely on
- GitHub emits **`check_run` completed** events for third-party checks. citeturn0search10  
- Claude Code can be triggered by a **`@claude` mention** (and there’s an official action/app). citeturn0search2turn0search15  
- Codex can be triggered from GitHub comments and/or via the Codex GitHub Action. citeturn0search9turn0search16  

### Key design points (so it doesn’t go infinite-loop)
- Only trigger when the **check name matches CodeRabbit** and **conclusion != success**
- Only trigger once per **PR + head SHA** (store this via a label, a PR comment marker, or a check)
- Cap retries (e.g., **2 attempts**) then label **`needs-human`** and stop

---

## Example workflow: on CodeRabbit check failure → comment “@claude fix”
This version **doesn’t require writing code to run Claude**; it just posts a comment that your existing Claude/Codex GitHub integration will react to.

> Put this in `.github/workflows/coderabbit-autofix.yml`

```yaml
name: CodeRabbit Auto-Fix Orchestrator

on:
  check_run:
    types: [completed]

permissions:
  checks: read
  pull-requests: write
  issues: write
  contents: read

jobs:
  trigger-agent:
    if: >
      github.event.check_run.conclusion != 'success' &&
      contains(toLower(github.event.check_run.name), 'coderabbit')
    runs-on: ubuntu-latest

    steps:
      - name: Find PR for this check_run
        uses: actions/github-script@v7
        id: pr
        with:
          script: |
            const { owner, repo } = context.repo;
            const checkRun = context.payload.check_run;

            // check_run can be associated with multiple PRs; we’ll pick the first
            const prs = checkRun.pull_requests || [];
            if (prs.length === 0) {
              core.setOutput("found", "false");
              return;
            }

            const prNumber = prs[0].number;
            core.setOutput("found", "true");
            core.setOutput("number", String(prNumber));
            core.setOutput("head_sha", checkRun.head_sha);

      - name: Stop if no PR
        if: steps.pr.outputs.found != 'true'
        run: echo "No PR associated with this CodeRabbit check_run."

      - name: Guard against re-trigger for same SHA (marker comment)
        if: steps.pr.outputs.found == 'true'
        uses: actions/github-script@v7
        id: guard
        with:

*(Answer truncated — 6530 chars total)*

## Question

It's an approving review from CodeRabbit that gets triggered. And it's part of a number of status checks, but it's the actual review that's blocking. And what do you mean by run the agent inside actions? Because the agent has to run after CodeRabbit has put its review down. Because it's responding to the review. So is there a way to do that and make it more deterministic? Ideally, the most deterministic version of this is what we want.

## Answer

Yes, you can make this **deterministic** even when the *review* (not the check) is what blocks merge.

### What “run the agent inside Actions” means
Instead of “post a comment that pings @claude/@codex and hope the GitHub App picks it up,” you **invoke the agent as a step in a GitHub Actions workflow**, right after CodeRabbit submits its review. The workflow:

1) detects the CodeRabbit **review submitted** event  
2) fetches the review body + inline comments via GitHub API  
3) runs Claude/Codex in the workflow with that feedback as input  
4) commits + pushes fixes to the PR branch  
5) exits (then checks + CodeRabbit will re-run automatically)

That’s deterministic because **the same workflow run** that detects CodeRabbit also triggers the agent, with controlled retries and clear logs.

---

## The right trigger for your situation
Since “the actual review is blocking,” use:

- `on: pull_request_review` with `types: [submitted]`
- filter for:
  - reviewer user == CodeRabbit bot (exact login varies)
  - review state == `changes_requested` (or whatever state CodeRabbit uses to block)
  - PR is not draft
  - guard against re-running on same head SHA

This is more accurate than relying only on `check_run`.

---

## Deterministic architecture (recommended)
### Workflow A: CodeRabbit Review → Auto-fix attempt
**Event:** `pull_request_review.submitted`

**Steps:**
1) Verify it’s a CodeRabbit review and it’s blocking.
2) Pull down:
   - review text
   - inline review comments (file/line + message)
3) Run the agent (Claude or Codex) with a structured instruction:
   - “Fix these review comments; minimal diff; run tests”
4) Commit + push to the PR branch (same branch)
5) Add a marker (label or hidden PR comment) indicating “attempted for SHA X”.

### Workflow B: Still blocked after agent → escalate
**Event:** another `pull_request_review.submitted` (or on `check_suite` completion)
- If CodeRabbit *still* requests changes **after N attempts** → apply label `needs-human` and request reviewers.

---

## Security + permissions (this is the part that matters)
To push commits to the PR branch, the workflow needs write credentials. You have two main options:

### Option 1 (Best for determinism + safety): **GitHub App token**
- Create a GitHub App with **Contents: write**, **Pull requests: read/write** on the repo.
- In Actions, mint an installation token (short-lived).
- Use that token to push commits.

This avoids the nasty edge cases of `pull_request_target` and keeps control scoped.

### Option 2 (Common, but requires discipline): `pull_request_target`
- Gives access to secrets even for PRs, but can be risky if you checkout untrusted code.
- If you do this, you must:
  - avoid running PR code
  - only operate on **trusted PRs** (same repo, trusted actors)
  - use strict guards

If most PRs are from your own team inside the repo, this can be acceptable with the right guards.

---

## Concrete implementation sketch (Claude/Codex as an Actions step)
Here’s the s

*(Answer truncated — 5411 chars total)*

## Question

Cool. This is good. How do we also ensure that it has access to Biome, to make sure to run linting after it changes, and also run typecheck after it changes, so that it doesn't come back with lint errors, or fail the typecheck?

## Answer

Mr. White — you make this deterministic by **making lint + typecheck part of the same “autofix” workflow run**, and by **requiring those checks for merge**. Concretely:

1) **Install deps in Actions** (Node + package manager)  
2) After the agent edits code, run:
   - **Biome** (format + lint or “check”)
   - **Typecheck** (tsc / your script)
3) If either fails, **don’t push** (or push and let the agent do a second pass), and after N tries **escalate to humans**.

Below is the most reliable pattern.

---

## Add Biome + typecheck as gates inside the autofix workflow

### A. Ensure Biome is available
Biome should be a devDependency (best) so the CI uses the repo’s pinned version:

```json
// package.json
{
  "devDependencies": {
    "@biomejs/biome": "^1.9.0"
  },
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check . --write",
    "format": "biome format .",
    "format:fix": "biome format . --write",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

If you already have scripts, just call your existing ones.

### B. In the workflow, run these after the agent step
(Example assumes pnpm; swap to npm/yarn/bun as needed.)

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: 'pnpm'

- uses: pnpm/action-setup@v4
  with:
    version: 9

- name: Install dependencies
  run: pnpm install --frozen-lockfile

# ... agent runs and edits files here ...

- name: Biome (fix then verify)
  run: |
    pnpm run lint:fix
    pnpm run lint

- name: Typecheck
  run: pnpm run typecheck
```

**Why “fix then verify”?**  
Because the agent may produce a correct change that’s just not formatted to your Biome rules. This forces deterministic formatting, then confirms there are no remaining lint errors.

### C. Only commit/push if both pass
```yaml
- name: Commit + push if clean
  run: |
    git status --porcelain
    git add -A
    git diff --cached --quiet && exit 0
    git commit -m "chore: fix CodeRabbit feedback"
    git push
```

If Biome/typecheck fails, the job fails and you can either:
- let the *next* run re-attempt (triggered by another CodeRabbit review), or
- do a **second attempt in the same workflow** (more deterministic).

---

## Even more deterministic: 2-pass loop in one workflow run
This pattern is great:

**Attempt 1**
- Agent edits
- Run `biome --write`
- Run typecheck
- If fails: feed the error output back into agent and do **Attempt 2**
- If still fails: label `needs-human`

Pseudo-structure:

```yaml
- name: Attempt 1 (agent)
  run: ./run-agent.sh "$FEEDBACK"

- name: Biome + typecheck
  id: verify1
  continue-on-error: true
  run: |
    pnpm run lint:fix
    pnpm run lint
    pnpm run typecheck

- name: Attempt 2 (agent with errors)
  if: steps.verify1.outcome != 'success'
  run: ./run-agent.sh "$FEEDBACK" "$(cat verify-errors.txt)"

- name: Verify again
  if: steps.verify1.outcome != 'success'
  run: |
    pnpm run lint:fix
    pnpm run lint
    pnpm run typecheck
```

Key trick: capture the fa

*(Answer truncated — 4178 chars total)*

## Question

Write a prompt for me to give to ai to make this

## Answer

Here’s a **clean, deterministic, production-grade prompt** you can give directly to an AI agent (Claude/Codex) to **design and implement this system end-to-end**.

You can paste this verbatim.

---

### **Prompt**

You are a senior DevOps + Platform engineer.

Your task is to **design and implement a deterministic GitHub Actions automation** that automatically fixes CodeRabbit-blocking PR reviews using an AI agent, then enforces Biome linting and TypeScript typechecking before allowing merge.

#### **System goals**
- Zero human intervention for routine CodeRabbit feedback.
- Fully deterministic execution (no “hope a comment triggers something”).
- Human escalation only after repeated automated failure.
- Safe, minimal diffs.

---

### **Behavioral requirements**
1. Trigger **only** when:
   - A `pull_request_review` is submitted
   - The reviewer is **CodeRabbit**
   - The review state is **blocking** (e.g. `changes_requested`)
   - The PR is not a draft

2. The workflow must:
   - Read the **review body**
   - Read **all inline review comments** (file, line, message)
   - Treat these as the **single source of truth** for what to fix

3. The system must:
   - Run an AI agent **inside the GitHub Actions workflow**
   - NOT rely on comment-based triggers
   - Apply fixes directly to the PR branch
   - Be idempotent and loop-safe

---

### **Agent execution requirements**
- The agent must:
  - Make **minimal changes** needed to satisfy CodeRabbit
  - Preserve existing style and architecture
  - Never reformat unrelated files
  - Never introduce unused code or dead imports

- After changes, the workflow must run:
  - `biome check . --write`
  - `biome check .`
  - `tsc --noEmit` (or `pnpm run typecheck`)

- If linting or typecheck fails:
  - Capture the error output
  - Feed it back into the agent
  - Allow **one retry** in the same workflow run

---

### **Retry + escalation logic**
- Allow **max 2 automated attempts** per PR head SHA
- Track attempts via:
  - a label OR
  - a hidden PR comment marker tied to the SHA
- If still failing after retries:
  - Add label: `needs-human`
  - Stop all automation

---

### **Security & permissions**
- Use **safe write access**:
  - Prefer GitHub App token OR tightly scoped `GITHUB_TOKEN`
- Do NOT run untrusted PR code
- Do NOT leak secrets into agent prompts

---

### **Implementation deliverables**
Produce:
1. A complete `.github/workflows/coderabbit-autofix.yml`
2. Any helper scripts used by the workflow
3. A clearly structured agent prompt that includes:
   - CodeRabbit review text
   - Inline comment context
   - CI failure output (if any)
4. Inline comments explaining:
   - Guards against infinite loops
   - Retry logic
   - Where determinism is enforced

---

### **Success criteria**
- A PR with CodeRabbit “changes requested”:
  - Automatically fixed
  - Passes Biome + typecheck
  - Re-reviewed by CodeRabbit
  - Auto-merges without human input
- A PR that cannot be auto-fixed:
  - Clearly labeled
  - Cle

*(Answer truncated — 3301 chars total)*

## Question

Claude optimized

## Answer

Here is a **Claude-optimized version** of the prompt.  
It is tighter, more explicit about reasoning steps, and structured to push Claude toward **careful, deterministic system design rather than creative exploration**.

You can paste this directly into Claude.

---

## **Claude Prompt — Deterministic CodeRabbit Auto-Fix System**

You are a **staff-level DevOps / Platform engineer** designing a production automation system.

Your task is to **design and implement a deterministic GitHub Actions workflow** that automatically fixes PRs blocked by **CodeRabbit review feedback**, validates the fixes with **Biome and TypeScript typechecking**, and escalates to humans only when automation fails.

This is an engineering problem, not a brainstorming exercise.

---

## **High-level objective**
Eliminate human intervention for routine CodeRabbit feedback while maintaining safety, correctness, and merge determinism.

---

## **Trigger conditions (strict)**
Trigger **only** when ALL are true:
- Event: `pull_request_review` → `submitted`
- Reviewer is **CodeRabbit** (bot account)
- Review state is **blocking** (e.g. `changes_requested`)
- PR is **not draft**
- This PR head SHA has **not already exhausted retries**

---

## **System flow (must be followed exactly)**
1. Receive CodeRabbit review event
2. Fetch:
   - Review body
   - All inline review comments (file, line, message)
3. Assemble a **single structured instruction** for the agent:
   - “Fix only the issues described below”
4. Run the AI agent **inside the GitHub Actions workflow**
   - Do NOT rely on comment-triggered GitHub apps
5. Apply fixes to the PR branch
6. Run validation:
   - `biome check . --write`
   - `biome check .`
   - `tsc --noEmit` (or repo’s `typecheck` script)
7. If validation passes:
   - Commit and push changes
   - Exit workflow
8. If validation fails:
   - Capture full error output
   - Re-invoke the agent **once** with error context
9. If validation fails again:
   - Label PR `needs-human`
   - Stop automation

---

## **Agent constraints (non-negotiable)**
The agent must:
- Make the **smallest possible diff**
- Modify **only files referenced by CodeRabbit or required by the fix**
- Preserve existing formatting and architecture
- Never introduce:
  - unused imports
  - dead code
  - speculative refactors
- Never reformat unrelated files
- Never silence lint/type errors incorrectly

---

## **Determinism & loop safety**
You MUST implement:
- A per-SHA retry guard (label or hidden marker comment)
- Maximum **2 attempts per head SHA**
- No infinite loops
- Clear exit paths

---

## **Security requirements**
- Use least-privilege credentials
- Prefer GitHub App token if write access is required
- Do NOT execute untrusted PR code
- Do NOT expose secrets to the agent

---

## **Deliverables**
Produce:
1. A complete `.github/workflows/coderabbit-autofix.yml`
2. Any helper scripts (shell or JS) used by the workflow
3. The exact agent prompt template, including:
   - CodeRabbit review 

*(Answer truncated — 3736 chars total)*
