
Yes, Mr. White — your screenshot confirms Hermes is successfully reading your Claude Code subscription credentials from `~/.claude/.credentials.json`, and Anthropic officially states Claude Code works with unified Pro/Max subscriptions. citeturn0search3turn0search15

But the important nuance is:

```text
Claude Code CLI itself:
  Uses your Pro/Max subscription allowance.

Hermes calling Anthropic directly through OAuth:
  Often routes into "extra usage" behavior.
```

That distinction is exactly what all the Hermes GitHub issues are about. Multiple users with healthy Max subscriptions are getting:

```text
"You're out of extra usage"
```

inside Hermes specifically, even while normal Claude Code works fine. citeturn0search2turn0search5turn0search7

So your screenshot proves:

```text
Hermes CAN see and reuse your Claude credentials.
```

It does NOT prove:

```text
Hermes orchestration traffic reliably stays inside included Max allowance.
```

In fact, the current evidence strongly suggests the opposite for many Hermes-native Anthropic flows. citeturn0search2turn0search5turn0search10

The critical distinction is:

| Path | Included subscription? | Stable? |
|---|---|---|
| Running `claude` CLI directly | Yes | Yes |
| Hermes using Claude Code CLI as external tool | Usually yes | Mostly |
| Hermes native Anthropic provider OAuth | Unclear / often extra usage | Buggy currently |

That is why your architecture should become:

```text
Hermes = orchestrator + Kanban + memory + workflows
Codex OAuth = orchestration/review intelligence
DeepSeek = implementation
Claude Code = OPTIONAL specialized worker only
```

NOT:

```text
Hermes native anthropic provider for everything
```

unless you are okay with extra-usage weirdness.

Your screenshot actually reinforces the strategy we landed on:

```text
Avoid Anthropic-native Hermes routing entirely.
```

because the ecosystem around it is currently unstable.

The best setup for you now is probably:

```text
Hermes Kanban
+ Codex OAuth (subscription)
+ DeepSeek implementers
+ GitHub Actions CI
+ optional Claude Code worker skill for specific hard problems only
```

and only invoke Claude Code selectively for:

```text
- architectural deadlocks
- hard debugging
- refactors
- security-sensitive review
- difficult merge conflicts
```

because Claude Code CLI itself is officially included in Max. citeturn0search15turn0search11

The good news is your screenshot also confirms:

```text
OpenAI Codex (ChatGPT) OAuth is connected.
```

That is the important one for your orchestration layer.


harden the plan


Mr. White, I would **not approve the pasted plan as-is**. It is close, but it needs three hardening changes:

1. **Stop or rewrite the existing Claude Code dispatcher first.** Your audit says `dispatch-kanban.sh` currently runs every 10 minutes and sends Kanban tasks to Claude Code CLI. That conflicts with the “no Claude/Anthropic” goal unless you explicitly want Claude Code as a fallback. fileciteturn0file0

2. **Do not use the free NVIDIA/OpenRouter model as the merge authority.** OpenRouter free models are rate-limited, availability is not guaranteed, and model-provider terms/data practices can vary by provider. Use free models only for queue triage or cheap summaries. The actual reviewer/merge judge should be **Codex OAuth**. citeturn705980view3turn705980view4

3. **Make implementation routing explicit.** If no DeepSeek key exists, use **Codex OAuth** as a temporary implementer fallback. Once DeepSeek is configured, route implementation to DeepSeek. Never silently route implementation through a random free OpenRouter model.

Codex OAuth is the right paid-subscription path here because OpenAI says Codex is included with ChatGPT Plus/Pro/Business/Enterprise/Edu plans, while API-key Codex usage is billed separately through the OpenAI Platform. Also disable credits/auto-top-up so Codex stops at included usage rather than buying more after limits. citeturn705980view1turn705980view0turn705980view2

## Hardened architecture

```text
Hermes Kanban = durable queue / source of truth

Linear = issue intake / human-visible task record

Ruflo = hooks/workflow glue only where already present and verified

GBrain = durable task memory at start/end

Git worktrees = isolated implementation workspace

GitHub Actions = first validation gate

Codex OAuth = orchestrator + reviewer/merge judge

DeepSeek = implementation once direct key is configured

Codex OAuth fallback = implementation only while DeepSeek is missing

Free OpenRouter/NVIDIA = queue triage only, never merge authority
```

Hermes Kanban is the correct backbone because it is a native durable board shared across profiles; every task is stored in `~/.hermes/kanban.db`, handoffs are durable, and engineering pipelines with worktrees/review/PR are explicitly listed as a target pattern. citeturn810522view6

Hermes profiles are also the right separation boundary for roles because each profile has its own config, `.env`, memory, sessions, cron jobs, and state database. Profiles do **not** sandbox filesystem access, so worktree isolation and explicit `terminal.cwd` still matter. citeturn705980view7

## Hardened role routing

| Role | Primary model path | Fallback | Merge authority? |
|---|---|---|---|
| Orchestrator | Codex OAuth | none | no |
| Implementer | DeepSeek direct API | Codex OAuth | no |
| CI fixer | DeepSeek direct API | Codex OAuth | no |
| Reviewer | Codex OAuth | pause | yes |
| Merger | Codex OAuth | pause | yes |
| Triage/summarizer | Free OpenRouter/NVIDIA | skip | no |

The main correction is reviewer quality. A cheap/free reviewer is false economy because it controls the riskiest action: landing code.

## Hardened implementation prompt

Paste this to Hermes as the next instruction:

```text
HARDEN THE EXISTING AI ENGINEERING PLAN BEFORE IMPLEMENTATION.

Current audit summary:
- Hermes v0.13.0 is installed.
- Kanban board jovie-product already exists.
- Existing dispatch-kanban.sh runs every 10 minutes and currently dispatches Kanban work to Claude Code CLI.
- Codex OAuth is authenticated.
- DeepSeek direct API key is not set in ~/.hermes/.env.
- Linear API key is set.
- GitHub is authenticated.
- Ruflo and GBrain still need inspection.
- Goal remains: durable Hermes Kanban pipeline with Linear intake, worktrees, setup script, CI gating, GBrain memory, Ruflo where useful, and no unintended paid API billing.

MANDATORY HARDENING CHANGES

1. Disable or rewrite the existing Claude Code dispatcher first.

Before creating new workers, inspect:
- dispatch-kanban.sh
- existing cron entries
- Hermes cron jobs
- system cron jobs
- launch agents
- any scripts that call claude, Claude Code, Anthropic, or dispatch to Claude

If dispatch-kanban.sh currently calls Claude Code:
- do not leave it active
- either disable it or rewrite it to dispatch to Hermes profiles
- document the exact change
- verify there is only one active dispatcher after setup

Do not delete credentials.
Do not disconnect Claude manually.
Just ensure this automation does not route through Claude/Anthropic unless explicitly approved later.

2. Provider authority rules.

Allowed:
- Codex OAuth via ChatGPT subscription for orchestrator/reviewer/merge decisions
- DeepSeek direct API for implementation once DEEPSEEK_API_KEY is configured
- Codex OAuth as temporary implementation fallback while DeepSeek is missing
- Free OpenRouter/NVIDIA only for triage/summaries

Forbidden:
- Anthropic provider
- Claude provider
- Claude Code dispatch
- Claude Max extra usage
- OpenAI API key billing
- OPENAI_API_KEY billing path
- Codex credits/auto-top-up
- free OpenRouter/NVIDIA as final reviewer or merger

3. Reviewer/merger hardening.

Replace the prior reviewer plan.

Do NOT use free NVIDIA/OpenRouter as reviewer/merge authority.

Use:
- jovie-reviewer = Codex OAuth
- jovie-merger = same profile or same Codex OAuth path

Free NVIDIA/OpenRouter may only:
- summarize PR queues
- classify obvious CI failures
- detect stale tasks
- produce low-risk status digests

It must never:
- approve code
- merge code
- decide architecture
- override tests
- handle security-sensitive review

4. Implementer routing hardening.

If DEEPSEEK_API_KEY is present:
- jovie-implementer uses DeepSeek direct API
- implementation-heavy tasks route to DeepSeek

If DEEPSEEK_API_KEY is missing:
- jovie-implementer temporarily uses Codex OAuth
- mark this as fallback mode
- create a visible warning in docs and dashboard/status:
  “DeepSeek not configured; implementer using Codex OAuth fallback.”

Do NOT silently use OpenRouter free models for implementation.

If OpenRouter DeepSeek is considered:
- require explicit budget cap
- require model allowlist
- require confirmation that source code may be sent to that provider route
- never use it automatically because the OpenRouter balance is limited

5. Codex billing guardrails.

Before running Codex tasks, verify:
- Codex auth is OAuth / ChatGPT sign-in
- OPENAI_API_KEY is unset or ignored for this automation
- no OpenAI API billing path is active
- auto-top-up / extra credits are disabled or at least documented as disabled
- if Codex limit is hit, tasks pause instead of buying credits or switching to API billing

Create a provider sanity check script:
scripts/ai/assert-provider-policy.sh

It should fail fast if:
- OPENAI_API_KEY is present in the automation environment
- ANTHROPIC_API_KEY is present
- ANTHROPIC_AUTH_TOKEN is present
- ANTHROPIC_BASE_URL is present
- active Hermes model/provider for orchestrator/reviewer is not Codex OAuth
- active implementer provider is neither DeepSeek nor approved Codex fallback
- reviewer provider is free OpenRouter/NVIDIA

Do not guess Hermes CLI flags. Inspect help output before implementing checks.

6. Kanban remains source of truth.

Use the existing board:
- jovie-product

Do not create a duplicate board unless the existing board is unusable.

Create or enforce statuses:
- Intake
- Planning
- Ready for Implementation
- Implementing
- CI Failed
- Ready for Review
- Fixes Required
- Ready to Merge
- Merged
- Blocked

Task metadata must include:
- Linear issue ID
- Linear identifier
- Kanban task ID
- branch name
- worktree path
- setup/bootstrap status
- assigned profile
- provider/model actually used
- Ruflo hook status
- GBrain start memory ID
- GBrain end memory ID
- test commands run
- CI status
- PR URL
- final status
- blocker reason if blocked

7. Cron hardening.

Use no-agent/script cron for polling and routing where possible.

Cron jobs should enqueue or update Kanban tasks only.
Cron jobs should not perform expensive LLM reasoning unless explicitly necessary.

Every cron job must:
- be idempotent
- log start/end
- produce a heartbeat
- report errors
- avoid silent success with empty output
- use lockfiles to prevent overlapping runs
- have a max runtime
- have retry limits
- never recursively create new cron jobs

Required jobs:
- Linear intake poller every 10m
- CI recovery watcher every 15m
- reviewer queue watcher every 15m
- stale worktree cleanup/report job
- nightly maintenance summary
- weekday morning summary

8. Linear intake hardening.

Preferred:
- Linear Agent Session webhooks

Fallback:
- polling every 10m

If using webhooks:
- respond quickly
- enqueue work instead of doing long processing in the webhook handler
- store Linear session/issue/task mapping

If using polling:
- process issues with labels:
  ai
  ai-ready
  hermes
  jovie-agent
- or issues assigned to the AI agent
- use idempotency keys
- never duplicate Kanban tasks for the same Linear issue

9. GitHub/CI hardening.

GitHub Actions is the first validation gate.

Reviewer wakes only when:
- PR exists
- branch is up to date or mergeable
- required checks pass on latest commit
- no obvious secret scan failure
- PR belongs to ai/* branch
- PR has Linear mapping
- PR has implementation summary

If CI fails:
- route back to implementer
- do not wake reviewer
- summarize failure concisely
- cap retry loops

Required branch protections:
- required status checks
- require latest commit SHA checks
- require PR review if available
- no direct push to main by agents
- no force-push to main

If branch protection cannot be configured automatically:
- document exact manual steps
- block auto-merge until configured

10. Worktree hardening.

Every implementation task must use an isolated git worktree.

Workflow:
1. git fetch origin
2. create branch ai/<linear-key>-<slug>
3. create isolated worktree
4. run provider sanity check
5. run existing repo setup/bootstrap script
6. validate dependencies
7. pull GBrain task-start context
8. implement
9. run tests/lint/typecheck
10. commit
11. push
12. open/update PR
13. wait for CI
14. route to reviewer only after CI passes

Inspect repo for setup scripts:
- setup.sh
- scripts/setup*
- scripts/bootstrap*
- bin/setup
- Makefile
- package manager scripts
- devcontainer
- mise/asdf/nix/direnv config

Use the repo’s existing setup script. Do not invent a new bootstrap unless no existing one is found.

If setup fails:
- block the task
- record failure
- do not proceed to implementation

11. Ruflo hardening.

Inspect Ruflo before using it.

Run:
- which ruflo
- npx ruflo --help
- inspect repo configs/hooks
- inspect existing Ruflo state/configs

Use Ruflo only for:
- verified hooks
- workflow glue
- orchestration helpers
- memory or event pipeline integration if already wired
- validation hooks around task start/end

Do NOT:
- make Ruflo the durable task source of truth
- duplicate Hermes Kanban queueing
- enable broad swarms blindly
- install a large MCP/tool surface without a dry run
- route through Claude Code because Ruflo is Claude-centric

Hermes Kanban remains the queue.
Ruflo is glue/hooks only unless explicitly proven otherwise.

Document:
- Ruflo version
- Ruflo commands used
- hooks enabled
- hooks skipped
- why skipped

12. GBrain hardening.

At task start:
- query GBrain for relevant context
- fetch related issue/PR/convention/pitfall notes
- store task-start record

At task end:
- store structured task-end record
- store only durable learnings, not raw logs

GBrain start record schema:
{
  "type": "ai_task_start",
  "linear_key": "...",
  "kanban_task_id": "...",
  "branch": "...",
  "worktree": "...",
  "profile": "...",
  "provider": "...",
  "plan_summary": "...",
  "relevant_memory_refs": [...]
}

GBrain end record schema:
{
  "type": "ai_task_end",
  "linear_key": "...",
  "kanban_task_id": "...",
  "branch": "...",
  "pr_url": "...",
  "outcome": "merged|blocked|ci_failed|review_failed|abandoned",
  "files_changed": [...],
  "tests_run": [...],
  "ci_result": "...",
  "reviewer_findings": "...",
  "bugs_discovered": [...],
  "repo_conventions_learned": [...],
  "future_pitfalls": [...],
  "unresolved_risks": [...]
}

Do not spam GBrain.
Do not write giant logs.
Do not store ephemeral status chatter.
Use agent memory for operational preferences/config.
Use GBrain for durable world/project knowledge and learnings.

13. Secret and safety hardening.

Before commit:
- run git diff
- check for secrets
- check for unrelated file changes
- check for destructive changes
- check package lockfile changes
- verify branch is ai/*
- verify not on main
- verify worktree path is correct

Never:
- delete databases
- run destructive migrations
- force-push main
- modify production secrets
- change billing settings
- enable paid auto-top-up
- merge without CI
- merge from a dirty worktree
- merge if provider sanity check failed

14. Retry limits.

Implementation retries:
- max 2 automatic CI-fix attempts per PR
- after 2 failed attempts, move to Blocked or Fixes Required

Review retries:
- max 2 review/fix loops
- after 2 loops, request human decision

Cron retries:
- exponential backoff
- no overlapping runs
- alert on repeated failures

15. Observability.

Create:
- docs/ai-engineering-system.md
- docs/ai-agent-runbook.md
- .jovie/ai-agent-config.yaml
- scripts/ai/assert-provider-policy.sh
- scripts/ai/create-worktree-for-task.sh
- scripts/ai/run-worktree-setup.sh
- scripts/ai/gbrain-task-start.sh
- scripts/ai/gbrain-task-end.sh
- scripts/ai/check-pr-ready-for-review.sh
- scripts/ai/check-pr-ready-to-merge.sh

Docs must include:
- provider routing
- billing guardrails
- active cron jobs
- disabled old dispatchers
- Kanban board URL/dashboard
- Linear intake labels
- GBrain lifecycle
- Ruflo usage
- worktree lifecycle
- setup script used
- CI/merge rules
- emergency stop procedure

16. Emergency stop.

Implement a kill switch:
- .jovie/AI_AUTOMATION_DISABLED

If present:
- intake poller stops creating tasks
- dispatcher stops assigning tasks
- implementer stops starting work
- reviewer stops merging
- existing running jobs finish current safe step then stop

17. Dry-run validation.

Run dry-run only after provider policy and old dispatcher are fixed.

Dry-run should:
1. create or use harmless Linear issue
2. create Kanban task
3. pull GBrain start context
4. create isolated worktree
5. run repo setup script
6. make tiny docs-only change
7. commit/push/open PR
8. run CI
9. wait for passing CI
10. route to Codex reviewer
11. reviewer either blocks or approves
12. do not merge unless branch protection and all merge gates are verified
13. write GBrain end memory
14. update Linear
15. produce final report

Final report must include:
- old dispatcher status
- exact active cron jobs
- exact profiles
- exact provider routing
- Codex OAuth verification
- DeepSeek status
- OpenRouter free-model usage restrictions
- Ruflo status
- GBrain status
- worktree setup script found/used
- dry-run PR URL
- CI result
- merge gate result
- remaining manual steps

Proceed in audit/setup mode first.
Do not enable recurring automation until the old Claude Code dispatcher is disabled or rewritten and provider routing is verified.
```

## The biggest changes versus the uploaded plan

Your uploaded plan had:

```text
Implementer = Codex
Reviewer = free NVIDIA/OpenRouter
Existing dispatch = Claude Code CLI
```

The hardened version should be:

```text
Existing Claude Code dispatcher = disabled or rewritten first
Implementer = DeepSeek once configured, Codex OAuth fallback until then
Reviewer/Merger = Codex OAuth
Free NVIDIA/OpenRouter = triage only
```

That gives you the low-token architecture without letting the cheapest or most fragile model make merge decisions.


Mr. White, this plan is now close enough to approve **with a few mandatory edits**. The latest hardening plan correctly pauses the old Claude Code dispatcher, routes reviewer/merger to Codex OAuth, limits free OpenRouter/NVIDIA to triage, keeps `jovie-product`, and treats Ruflo as optional because it is present but not initialized. fileciteturn0file0 The earlier audit version still had the bad reviewer routing to free NVIDIA; treat that as superseded. fileciteturn0file1

Codex OAuth is the right planner/reviewer path because OpenAI says Codex is included with ChatGPT Plus/Pro/Business/Enterprise/Edu plans. The caveat is that after included usage is exhausted, Codex can draw from a credit balance, and eligible Plus/Pro users can enable auto top-up, so the plan needs an explicit “pause at subscription limit” policy and a manual check that auto top-up is off. citeturn142273view0turn142273view1

Hermes Kanban is the right queue. Hermes describes it as a durable board shared across profiles, backed by `~/.hermes/kanban.db`, with workers as full OS processes; it explicitly supports engineering pipelines like “decompose → implement in parallel worktrees → review → iterate → PR.” citeturn142273view2

## Required edits before approval

1. **Do not create `.jovie/AI_AUTOMATION_DISABLED` by default.**  
   Create `.jovie/AI_AUTOMATION_DISABLED.example` and document that creating the real file disables automation. If Hermes creates the real file during setup, the system starts in disabled mode.

2. **Do not edit Kanban JSON/SQLite directly.**  
   The plan says task metadata is stored in “board JSON fields.” Change that to: use official Hermes Kanban CLI/tool APIs wherever supported; store overflow metadata in `.jovie/kanban-task-metadata/<task-id>.json`.

3. **Free OpenRouter stays non-authoritative.**  
   OpenRouter free models have request limits and variable availability/latency; free variants are capped by requests per minute/day, and the free router may choose models dynamically. Use it only for summaries, stale-task detection, and queue triage. citeturn142273view3turn907288view0

4. **Auto-merge stays blocked until GitHub branch protection is verified.**  
   GitHub required status checks force checks to be successful, skipped, or neutral before merging, and branch rules can require approving reviews and passing checks. The dry run should report “merge ready,” then stop unless protections are confirmed. citeturn142273view4turn142273view5

5. **DeepSeek direct should be configured before serious implementation.**  
   Codex fallback is fine for the dry run. For real implementation throughput, add `DEEPSEEK_API_KEY` and make implementer use DeepSeek. Codex fallback burns your Codex subscription capacity.

6. **GBrain needs redaction/dedupe limits.**  
   Add: redact secrets before writes, max payload size, no raw logs, deterministic memory key per task, and update existing task memory rather than creating duplicates.

7. **Provider check cannot rely only on env vars.**  
   `assert-provider-policy.sh` should check both environment and Hermes profile config. It should fail if reviewer is OpenRouter/free, if implementer is OpenRouter/free, or if `OPENAI_API_KEY`/Anthropic vars are visible to automation.

## Send Hermes this approval

```text
Approved, with the following mandatory edits before implementation.

1. Treat the newer HARDENING PLAN as authoritative. The older audit plan is superseded, especially the part that routed reviewer/merger to free NVIDIA/OpenRouter.

2. Reviewer and merger must use Codex OAuth only.
   Free OpenRouter/NVIDIA may be used only for:
   - queue summaries
   - stale task detection
   - obvious CI failure classification
   - low-risk status digests

   Free OpenRouter/NVIDIA must never:
   - approve code
   - merge code
   - make architecture decisions
   - override CI
   - review security-sensitive changes

3. Do not create .jovie/AI_AUTOMATION_DISABLED as an active file during setup.
   Instead create:
   - .jovie/AI_AUTOMATION_DISABLED.example

   Document:
   - creating .jovie/AI_AUTOMATION_DISABLED disables automation
   - deleting it re-enables automation after provider checks pass

4. Do not edit Hermes Kanban SQLite or board JSON directly.
   Use official Hermes Kanban CLI/tool APIs wherever possible.
   If task metadata cannot fit in native Kanban fields, store overflow metadata in:
   - .jovie/kanban-task-metadata/<kanban-task-id>.json

5. Keep existing Kanban board:
   - jovie-product

6. Disable or rewrite the existing Claude Code dispatcher before enabling new recurring automation.
   Verification must include:
   - Hermes cron list
   - system crontab
   - launch agents if applicable
   - grep for claude, anthropic, ANTHROPIC, Claude Code, and dispatch-kanban

   There must be exactly one active dispatcher after setup.

7. Codex OAuth guardrail:
   - Codex must use ChatGPT/Codex OAuth only.
   - OPENAI_API_KEY must not be visible to automation.
   - Do not use OpenAI API billing.
   - Do not use Codex credits or auto top-up.
   - If Codex hits subscription limit, pause tasks instead of buying credits or switching to API billing.

   Add a manual verification step in the runbook:
   - check Codex Settings > Usage
   - verify auto top-up is off
   - verify no unwanted credit spending policy is active

8. Implementer routing:
   - If DEEPSEEK_API_KEY is present, jovie-implementer uses DeepSeek direct API.
   - If DEEPSEEK_API_KEY is missing, jovie-implementer may use Codex OAuth fallback only for dry-run and low-volume setup work.
   - Show a visible warning whenever Codex fallback is active:
     “DeepSeek not configured; implementer using Codex OAuth fallback.”

   Do not use OpenRouter free models for implementation.

9. Strengthen scripts/ai/assert-provider-policy.sh.
   It must fail if:
   - OPENAI_API_KEY is visible
   - ANTHROPIC_API_KEY is visible
   - ANTHROPIC_AUTH_TOKEN is visible
   - ANTHROPIC_BASE_URL is visible
   - reviewer provider is OpenRouter/free
   - merger provider is OpenRouter/free
   - implementer provider is OpenRouter/free
   - orchestrator/reviewer are not Codex OAuth
   - implementer is neither DeepSeek direct nor explicitly approved Codex fallback
   - .jovie/AI_AUTOMATION_DISABLED exists

10. GBrain hardening:
   Add redaction and dedupe.
   At task start/end:
   - redact secrets
   - cap payload size
   - avoid raw logs
   - use deterministic key: linear_key + kanban_task_id + phase
   - update existing memory if present
   - store only durable learnings and task metadata

11. GitHub merge hardening:
   Auto-merge must stay disabled until branch protection is verified.
   Required gates:
   - PR branch matches ai/*
   - latest commit has passing required checks
   - branch is mergeable
   - no secret scan failure
   - PR has Linear mapping
   - PR has Kanban task mapping
   - reviewer approval exists
   - branch protection/ruleset is verified

   During dry-run, report merge readiness but do not merge unless all protections are verified.

12. Worktree hardening:
   Every implementation task must:
   - create an isolated worktree
   - run the repo’s existing setup/bootstrap script
   - verify clean worktree before/after
   - avoid main
   - avoid dirty workspace reuse
   - record setup/test status in metadata

13. Ruflo:
   Since Ruflo is installed but not initialized in this repo, do not introduce it as a new durable queue.
   Use Ruflo only if inspection finds existing useful hooks/configs.
   Hermes Kanban remains source of truth.

14. Proceed in this order:
   1. Rewrite/disable old Claude Code dispatcher.
   2. Create provider policy script.
   3. Create/update profiles.
   4. Verify Codex OAuth and DeepSeek status.
   5. Configure Kanban lanes on jovie-product.
   6. Add metadata storage.
   7. Add GBrain start/end hooks.
   8. Add worktree scripts using repo setup script.
   9. Add no-agent cron jobs with lockfiles.
   10. Run dry-run docs-only PR.
   11. Report results and stop before auto-merge unless branch protection is verified.

Proceed without asking further questions unless blocked by a missing credential, missing permission, or destructive action.
```

Bottom line: approve the current hardening plan **after these edits**. The main principles are correct: Hermes Kanban as queue, Codex OAuth for judgment, DeepSeek for implementation when configured, GitHub Actions as the validation gate, and no free model in the merge path.


shouldnt we jjust intialize riuflo


Yes, Mr. White — **initialize Ruflo**, but do it in **controlled mode** and keep Hermes Kanban as the durable queue.

Your audit already says Ruflo is installed but not initialized in the repo, and the current plan says Hermes would skip it unless useful. That is too conservative. We should initialize it, inspect what it adds, then wire only the useful parts. fileciteturn2file0

## Correct decision

```text
Initialize Ruflo
Do not make Ruflo the source of truth
Do not let Ruflo auto-wire Claude Code
Do not let Ruflo run autonomous background loops until inspected
Use Ruflo for hooks/workflows/memory/glue
Use Hermes Kanban for durable queue/dispatcher/task state
```

Why: Ruflo is specifically built for agent orchestration, swarms, memory, hooks, workflows, testing, security audit, docs, cost tracking, and background workers. Its README says the full init path installs a large surface: agents, commands, skills, MCP server, hooks, and daemon. That means it is useful, but also too broad to blindly activate in production. citeturn359016view0

Hermes Kanban should still remain the backbone because it is already a durable SQLite-backed queue across Hermes profiles, with task state, handoffs, comments, idempotency keys, dispatcher support, dashboard/CLI access, and engineering workflows like “decompose → implement in parallel worktrees → review → iterate → PR.” citeturn823243view1

## The hardened stance

Ruflo becomes:

```text
Ruflo = orchestration enhancement layer
Hermes Kanban = durable task queue
GBrain = durable project memory
GitHub Actions = validation gate
Codex OAuth = planner/reviewer
DeepSeek = implementer
```

Ruflo should help with:

```text
- task hooks
- workflow templates
- test generation
- security scanning
- docs generation
- cost tracking
- memory/RAG support
- diff/risk analysis
- agent coordination helpers
```

Ruflo should not own:

```text
- Kanban state
- Linear issue mapping
- final merge authority
- Claude Code dispatch
- recurring autonomous loops
- billing/provider routing
```

## Important risk

The Ruflo README distinguishes a light Claude Code plugin path from a full CLI install. The full Ruflo path includes hooks and an MCP server; the plugin-only path gives slash commands and agent definitions without registering the Ruflo MCP server. citeturn359016view1

So the setup should **inspect before activating**. The danger is accidentally installing hooks that route through Claude Code or create duplicate worker loops.

## Revised instruction to Hermes

Use this:

```text
Update the hardening plan: initialize Ruflo in controlled audit mode.

Ruflo is installed but not initialized in this repo. Initialize it, but do not let it replace Hermes Kanban or create uncontrolled Claude Code/background automation.

MANDATORY ORDER:

1. Pause active AI automation first.
   - Pause old Claude Code dispatcher.
   - Pause Kanban auto-dispatch cron.
   - Ensure no recurring worker loop is active while Ruflo initializes.

2. Snapshot current state.
   Record:
   - git status
   - existing .claude files
   - existing .ruflo / .claude-flow / Ruflo files if any
   - Hermes cron list
   - system crontab
   - current dispatch-kanban.sh
   - current Hermes profiles
   - current Kanban board state

3. Inspect Ruflo CLI before running init.
   Run:
   - which ruflo
   - ruflo --version
   - ruflo --help
   - ruflo init --help
   - npx ruflo@latest init --help if needed

   Do not guess flags.

4. Initialize Ruflo in the least destructive full mode that exposes hooks/workflows/memory.
   Prefer local repo initialization.
   Avoid enabling autonomous background loops during init if prompted.
   Avoid registering Claude Code MCP unless explicitly required and approved.
   Avoid any Anthropic/Claude provider setup.

5. After init, inspect all changed files.
   Report:
   - files created
   - files modified
   - hooks installed
   - MCP servers registered
   - daemons/background workers configured
   - provider/model settings
   - any Claude Code integration
   - any billing/API-key paths
   - any recurring loops

6. Disable or remove any Ruflo feature that:
   - dispatches to Claude Code
   - uses Anthropic
   - uses OPENAI_API_KEY billing
   - starts autonomous loops without Hermes Kanban control
   - duplicates Hermes Kanban as the source of truth
   - bypasses provider-policy checks

7. Keep Hermes Kanban as source of truth.
   Ruflo may only be used for:
   - hooks
   - workflow helpers
   - test generation
   - security audit
   - docs generation
   - diff/risk scoring
   - memory/RAG glue
   - task lifecycle hooks

8. Wire Ruflo into the task lifecycle.

   At task start:
   - run provider policy check
   - run GBrain start context
   - optionally run Ruflo memory/context retrieval
   - optionally run Ruflo planning/workflow helper
   - record Ruflo hook status in Kanban metadata

   Before commit:
   - optionally run Ruflo security/test/diff-risk hooks
   - keep GitHub Actions as the hard validation gate

   At task end:
   - run GBrain end memory write
   - optionally run Ruflo docs/memory update
   - record durable learnings only

9. Do not let Ruflo control merges.
   Merge authority remains:
   - Codex OAuth reviewer/merger
   - GitHub branch protection
   - passing CI
   - merge-gate script

10. Update docs:
   - docs/ai-engineering-system.md
   - docs/ai-agent-runbook.md
   - .jovie/ai-agent-config.yaml

   Include:
   - Ruflo initialization result
   - Ruflo enabled hooks
   - Ruflo disabled hooks
   - why Hermes Kanban remains source of truth
   - how to disable Ruflo integration
   - how to audit Ruflo provider routing

11. Only after Ruflo init is audited and safe:
   - rewrite dispatcher
   - enable Hermes profile workers
   - enable no-agent cron jobs
   - run dry-run docs-only PR

Proceed with Ruflo initialization in audit mode first. Stop after reporting changed files, hooks, daemons, MCP settings, provider settings, and any automation it attempted to install.
```

## Bottom line

Yes — initialize Ruflo now.

The corrected architecture is:

```text
Hermes Kanban owns work
Ruflo enhances workflow
GBrain owns durable memory
Codex judges
DeepSeek implements
GitHub Actions gates
Linear tracks
```

That is better than leaving Ruflo unused, and safer than letting Ruflo become another uncontrolled dispatcher.
