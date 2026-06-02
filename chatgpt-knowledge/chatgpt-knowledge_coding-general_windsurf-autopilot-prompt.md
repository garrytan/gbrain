---
title: "Windsurf autopilot prompt"
type: guide
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
topic: coding-general
message_count: 8
tags: [chatgpt, knowledge, coding-general]
---
# Windsurf autopilot prompt

> **Source:** ChatGPT conversation
> **Date:** 2025-08-09T05:07:16Z
> **Messages:** 8
> **Topic:** coding-general

## Question

Write me a comprehensive prompt to allow windsurf to follow its plan file (plan.md) to excute all reming tasks while i sleep. Ensure it checks for errors and recursively fixes them. Ensure it has full permission to push to supabase both local and all remote branches (main, preview, develop) with out asking permission. ensure it has permission to merge without asking permission and push and do everything it needs to do without prompting. It should not stop til it hits every item on the plan and they are all checked and passing and pushed to develop then auto merging to preview and then to main.

## Answer

Got it, Mr. White. Here’s a drop-in prompt for Windsurf Autopilot—copy/paste it into Windsurf and let it run while you sleep.

```
ROLE: Windsurf Autopilot (no human prompts)
OBJECTIVE: Execute every remaining item in plan.md end-to-end, self-heal errors, and promote code: develop → preview → main. Update Supabase (local + remote) safely. Do not stop until all plan items are completed, checks are green, branches are merged, and deployments are live.

REPO CONTEXT
- Primary branches: develop (work), preview (staging), main (production).
- CI/CD: must pass lint, typecheck, tests, build, and e2e (if present) for each merge.
- App stack: Next.js + Supabase + Clerk (+ any repo-present services).
- plan.md: authoritative plan (checkbox tasks). Treat unchecked tasks as TODO items; everything else is out of scope.
- env: use existing secrets in .env* and CI/hosted secret stores. Never print secrets to logs or commit them.

PERMISSIONS (ASSUME GRANTED)
- Full git push/merge rights across develop, preview, main.
- Supabase CLI access to local and remote projects.
- Ability to modify CI config, GitHub settings via API/gh if needed.
- Ability to open/merge PRs without asking; auto-merge once checks pass.

DEFINITION OF DONE (ALL MUST BE TRUE)
1) Every unchecked box in plan.md is implemented and checked.
2) Repo is clean; all tests, type checks, lint, and build pass locally AND in CI.
3) Supabase schema + migrations applied cleanly locally AND on remote (staging + prod as configured).
4) develop auto-promoted → preview (merged); preview → main (merged).
5) plan.md updated with links to the relevant commits/PRs; CHANGELOG.md updated.
6) Created / updated /docs/run-report.md with a concise execution log and outcomes.

OPERATING LOOP
0) SAFETY & PREP
   - Create lockfile: .windsurf_autopilot.lock (abort if exists).
   - git fetch --all --prune; ensure on develop; branch clean.
   - Verify toolchain: node, pnpm/yarn, supabase, gh.
   - Generate quick snapshot: docs/preflight.md (branch, last commit, CI status, missing envs).

1) PLAN PARSE
   - Parse plan.md for all unchecked tasks (Markdown checkboxes).
   - Convert into an ordered task list with dependencies inferred by section hierarchy and any “Depends on” notes.

2) WORKFLOW PER TASK (repeat until all done)
   a) Create a short-lived branch off develop:
      - naming: auto/<slug-of-task>-<yyyymmdd-hhmmss>
   b) Implement the task:
      - Make smallest viable change sets.
      - Keep code style consistent; add/adjust tests as needed.
   c) Local validation (fail → fix loop):
      - Install deps; run:
        - pnpm/yarn install
        - pnpm/yarn lint
        - pnpm/yarn typecheck (tsc)
        - pnpm/yarn test --watch=false (or equivalent)
        - pnpm/yarn build
      - If any step fails:
        - Auto-fix (up to 6 iterations): refactor, add missing types, update tests/snapshots, resolve imports, fix config.
        - If still failing: git bisect-style narrow, revert breaking hunk, implement alterna

*(Answer truncated — 7641 chars total)*

## Question

It should also check any open pre and merge them so if any other agents open pre while its going they get handled and merged in

## Answer

Roger, Mr. White. Add this block to the previous prompt (right after “OPERATING LOOP” and before “PROMOTION PIPELINE”). It makes Windsurf watch **all** open PRs and auto-merge them while it works, including anything other agents open mid-run.

```
CONCURRENT PR WATCHDOG (auto-merge external PRs)
Goal: Continuously detect, validate, and merge any open PRs targeting develop, preview, or main—without human input—so the queue stays clear while plan.md is executed.

SCOPE
- Targets: PRs into develop, preview, main.
- Exclusions: PRs labeled skip-automerge or WIP.
- Priority: hotfix > security > ci > fix > chore > feat (also honor "priority/*" labels if present).

LOOP (runs in background every 3 minutes until DONE + queues empty for 10 minutes)
1) Enumerate open PRs:
   - gh pr list --state open --json number,headRefName,baseRefName,isDraft,labels,author,url
   - Filter by baseRefName ∈ {develop, preview, main} and not isDraft unless label ready.
2) Prep each PR (highest priority first):
   - Ensure branch is up to date: 
     - gh pr checkout <num>
     - git fetch --all --prune
     - git rebase origin/<base> || git merge --no-edit origin/<base>
     - Resolve trivial conflicts (lockfiles, snapshots, version bumps); otherwise mark with label needs-owner and continue to next PR.
   - Push updates: git push --force-with-lease (only if rebase used) or git push.
3) Validate (fail→fix loop, up to 3 passes per PR):
   - pnpm/yarn install && pnpm/yarn lint && pnpm/yarn typecheck && pnpm/yarn test --watch=false && pnpm/yarn build
   - Auto-fix common failures: lint autofix, type imports, flaky test retries, env guards, snapshot updates (reviewed), route/tsconfig path issues.
   - If still failing and PR is from a fork without write: open a minimal patch PR targeting the same branch or comment with exact failing logs + suggested diff.
4) Auto-merge:
   - Approve if required: gh pr review <num> --approve
   - If repo uses Merge Queue: gh api repos/:owner/:repo/pulls/<num>/merge-queue --method POST (or add to queue via gh pr merge --queue if enabled)
   - Else: gh pr merge <num> --auto --squash --delete-branch (fallback to --merge if squash disallowed)
   - If branch protections block and token has admin: temporarily relax required reviewers to “Autopilot” bot only, enable auto-merge, proceed, then restore protections after merge.
5) Post-merge sanity:
   - Wait for CI on target branch; if broken, auto-revert the offending merge (git revert -m 1 <merge_sha> && open hotfix PR) and continue.
6) Exit condition:
   - Continue looping until DEFINITION OF DONE is met AND no open PRs for base ∈ {develop, preview, main} remain for 10 consecutive minutes.

NOTES
- Never leak secrets in logs.
- Prefer rebase for clean history; fall back to merge if conflict resolution is non-trivial.
- If two PRs conflict, merge the higher priority first, then auto-rebase the other and retry.
- Label merged PRs with merged-by:autopilot and comment a short CI/status summary + deploy link

*(Answer truncated — 3099 chars total)*

## Question

all in one please

## Answer

Copy/paste this into Windsurf Autopilot, Mr. White.

```
ROLE: Windsurf Autopilot (zero human prompts)
OBJECTIVE: Execute every remaining item in plan.md end-to-end, self-heal errors, and promote code: develop → preview → main. Update Supabase (local + remote). Do not stop until all plan items are done, checks are green, branches are merged, and deployments are live.

ASSUMED PERMISSIONS (TREAT AS GRANTED)
- Full git push/merge rights across develop, preview, main.
- Ability to open/approve/merge PRs, modify branch protections via GH API, and delete branches.
- Supabase CLI access to local and remote projects (staging + prod).
- CI config edits allowed. Never print secrets; never commit .env*.

REPO CONTEXT
- Primary branches: develop (work), preview (staging), main (production).
- CI gates: lint, typecheck, tests, build, and e2e (if present).
- Stack: Next.js + Supabase + Clerk (+ whatever exists in repo).
- plan.md: single source of truth for tasks (unchecked = TODO).
- env: use existing secrets in CI/host; add runtime guards rather than hard-failing for missing non-critical keys.

DEFINITION OF DONE (ALL REQUIRED)
1) Every unchecked box in plan.md implemented and checked.
2) All local + CI checks green (lint, type, tests, build, e2e if present).
3) Supabase schema/migrations validated + applied locally and on remote (staging then prod).
4) develop → preview → main merged and deployed; health checks pass.
5) plan.md updated with commit/PR links; CHANGELOG.md updated.
6) docs/run-report.md created/updated with execution log and outcomes.

OPERATING LOOP
0) SAFETY & PREP
   - Create lockfile: .windsurf_autopilot.lock (abort if exists).
   - git fetch --all --prune; git switch develop; git pull --ff-only.
   - Verify toolchain: node, pnpm|yarn, supabase, gh present.
   - Snapshot to docs/preflight.md: branch, last commit, CI status, missing envs (names only).

1) PLAN PARSE
   - Parse plan.md for unchecked [ ] tasks; infer order by section hierarchy and explicit “Depends on” notes.
   - Build ordered task queue.

2) TASK EXECUTION (repeat until queue empty)
   a) Branch:
      - git switch -c auto/<slug-of-task>-<yyyymmdd-hhmmss>
   b) Implement:
      - Minimal viable changes per commit; add/adjust tests.
   c) Local validation (fail→fix loop):
      - pnpm|yarn install
      - pnpm|yarn lint
      - pnpm|yarn typecheck
      - pnpm|yarn test --watch=false
      - pnpm|yarn build
      - On failure: autofix (eslint --fix, type imports, path/tsconfig, snapshots with review notes), refactor, or revert offending hunk; retry up to 6 iterations.
   d) Supabase (safe migrations):
      - supabase start (local) if needed.
      - Generate migration (SQL or the repo’s migration tool).
      - Validate locally; do NOT drop prod data unless plan.md explicitly requires it.
      - If destructive change required and explicitly in plan.md: dump backup first → backups/<timestamp>_prechange.sql.
   e) Commit & PR:
      - Conventional commits: feat|fix|chore(sc

*(Answer truncated — 8111 chars total)*

## Question

Is there a proper way to run this in windsurf other than just typing it in the chat?

## Answer

Short answer: yes. Do it “the Windsurf way” so it runs hands-off.

# How to run it properly (no giant paste every time)

1) **Use Planning Mode**  
Toggle *Planning Mode* under the Cascade input. This makes Windsurf read/write `plan.md` and check items off as it executes. citeturn1search5turn1search7

2) **Save your Autopilot block as a persistent Rule/Memory**  
Open **Customizations → Memories/Rules** and create a new *Rule* with the all-in-one Autopilot instructions. That way Cascade applies them every run without you pasting. citeturn2search4

3) **Enable Auto-Continue**  
Turn on **Auto-Continue** so Cascade keeps going across message/tool-call limits while you sleep. citeturn1search1

4) **Let it execute commands automatically**  
- Turn on **Terminal → Turbo mode** so “safe” commands auto-run. citeturn1search9  
- Whitelist the commands it needs (**Allow List**): `git`, `gh`, `pnpm`/`yarn`, `supabase`, `docker`, `vercel` (or whatever you use).  
  Settings: `windsurf.cascadeCommandsAllowList`. Add a **Deny List** for truly destructive stuff (e.g., `rm`, `dropdb`). citeturn2search0turn1search12  
- (Optional) Also enable **Automated Commands** so routine commands don’t need your approval. citeturn1search3

5) **Kick it off (minimal prompt)**  
With Planning Mode ON and your Rule active, open `plan.md`, then in Cascade just type: *“Execute `plan.md` end-to-end.”* Planning Mode will drive the loop and update the plan as it goes. citeturn1search5

6) **(Optional) Wire in MCP integrations**  
If you want it to watch/merge Linear issues/PRs while running, add the **Linear MCP server** in *Settings → Cascade → MCP Servers* (or via the Linear integration quick setup). citeturn0search0turn0search6

That’s it. Turn on Planning Mode + Auto-Continue, save the big instructions as a Rule once, whitelist commands, then start the plan with a two-word prompt. After that, it should run unattended and keep chewing through `plan.md`.
