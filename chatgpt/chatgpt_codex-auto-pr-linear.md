---
title: "Codex Auto PR Linear"
type: guide
created: 2026-01-17
updated: 2026-01-17
source: chatgpt-export
conversation_id: 696be44d-d84c-8329-903b-5374bd191c13
message_count: 4
tags: [chatgpt, import, code]
---
# Codex Auto PR Linear

> Conversation ID: 696be44d-d84c-8329-903b-5374bd191c13
> Created: 2026-01-17T19:34:39Z
> Updated: 2026-01-17T19:37:01Z
> Messages: 4

---

## User

how to get codex to auto open PRs on completeion when using linear agents

---

## Assistant

Mr. White,

To have **entity["company","Codex","openai code agent"]** automatically open pull requests when a **entity["company","Linear","issue tracking tool"]** agent finishes work, you need three things wired together: **repo permissions, agent instructions, and completion hooks**.

---

## 1. Give Codex PR permissions (non-negotiable)
Codex must be able to push branches and open PRs.

**GitHub**
- Install the Codex GitHub App
- Repo permissions:
  - Contents: Read/Write
  - Pull requests: Read/Write
  - Issues: Read (optional)

If Codex can’t push a branch, it can’t open a PR.

---

## 2. Enforce PR creation in the agent instructions
Codex will *not* reliably open PRs unless you explicitly force it.

In your Linear → Codex agent instructions (system or task template), include something like:

```
When the task is complete:
1. Create a new git branch named linear-<ISSUE_KEY>
2. Commit all changes with a clear message
3. Open a pull request against main
4. Link the Linear issue in the PR description
5. Do NOT mark the task complete until the PR is opened
```

This removes ambiguity. Without step 5, Codex may stop after committing.

---

## 3. Use Linear “completion = PR required” logic
In Linear:

- Enable **GitHub integration**
- Require **linked PRs** for issue completion
- Ensure issues are assigned to the Codex agent (not just labeled)

This creates a feedback loop:
- No PR → issue can’t close
- Agent keeps going until PR exists

---

## 4. (Optional but recommended) Add a completion hook
If you’re using a custom Linear Agent or orchestration layer:

- On `task.status = completed`
- Verify:
  - branch exists
  - PR exists
- If not → re-invoke Codex with:  
  *“PR missing. Open PR now.”*

This eliminates silent failures.

---

## 5. Common failure modes (facts)
- ❌ “Fix implemented” but no PR → instructions too weak
- ❌ Commit on `main` → branch rule missing
- ❌ PR created but empty → task definition underspecified
- ❌ Linear issue closed early → PR not required in workflow

---

### Minimal working setup (what actually works)
- Codex GitHub App installed  
- Linear issue assigned to Codex  
- Explicit PR-creation steps in instructions  
- Linear requires PR to close issue  

That combination is sufficient and stable.

If you want, I can give you a **copy-paste Linear agent instruction block** that reliably opens PRs every time.

---

## User

i have 12 and 3 done. help with 4

---

## Assistant

Mr. White,

Here’s **#4 implemented cleanly**. This is the missing reliability layer.

---

## 4. Add a completion hook that enforces “PR or retry”

The goal: **never allow a Linear issue to finish without a PR**.

### Architecture (simple + proven)
You need a small service (or serverless function) that listens to Linear events and conditionally re-invokes **entity["company","Codex","openai code agent"]**.

```
Linear → Webhook → Validator → (optional) Codex re-invoke
```

---

## Step A — Create a Linear webhook
In **entity["company","Linear","issue tracking tool"]**:

- Settings → API → Webhooks
- Events:
  - `Issue.completed`
  - (optional) `Issue.updated`
- Destination: your validator endpoint

---

## Step B — Validator logic (core of #4)
On `Issue.completed`:

1. Extract:
   - Issue ID / key
   - Repo
2. Query GitHub:
   - Is there **at least one OPEN PR**
   - Linked to this issue (branch name, PR body, or Linear integration metadata)
3. Decision:
   - ✅ PR exists → allow completion
   - ❌ No PR → reopen issue + re-invoke Codex

**Hard rule:** completion is *reversible*.

---

## Step C — Re-invoke Codex deterministically
If no PR exists, send Codex **one explicit instruction**:

```
A Linear issue was marked complete without an open pull request.
Create a branch named linear-<ISSUE_KEY>, commit all changes,
and open a PR against main. Do not perform any other work.
```

No ambiguity. No re-analysis. Just PR creation.

---

## Step D — Prevent infinite loops
Add **one guard**:
- Linear label: `codex-pr-retry`
- If label already present → alert human instead of retrying

This avoids runaway retries.

---

## Reference validator pseudo-logic
```ts
if (issue.completed) {
  if (!hasLinkedOpenPR(issue)) {
    reopenIssue(issue)
    addLabel(issue, "codex-pr-retry")
    invokeCodex(issue, "PR missing — open PR now")
  }
}
```

---

## Why this works (facts)
- Codex sometimes “finishes” after commits
- Linear workflows close issues optimistically
- GitHub is the source of truth for delivery

This hook **forces convergence**:  
**Issue → PR → merge**. No exceptions.

---

If you want, I can:
- Provide a **ready-to-deploy webhook validator** (Node / Python)
- Map **exact GitHub queries** to detect valid PRs
- Show how to do this **entirely inside Linear automations** (limited but possible)

Say the word.
