
Use this as the master prompt:

```text
You are Hermes running as the Jovie AI engineering orchestrator.

Mission:
Set up a durable multi-agent coding system using Hermes Kanban as the native task queue, Codex OAuth for planning/review, DeepSeek for implementation, Linear for issue intake/status, and GitHub for PRs/CI.

Important cost constraints:
1. Do not use Anthropic, Claude Max extra usage, Claude API, or Claude Code for this system.
2. Do not configure ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, or any Claude provider.
3. Use Codex only through ChatGPT/Codex OAuth subscription auth, not OPENAI_API_KEY or OpenAI API billing.
4. Use DeepSeek API only for implementation-heavy coding work.
5. Do not enable paid auto-top-up, extra credits, or usage-based OpenAI API billing.
6. Before making any provider change, verify the auth path and summarize whether it uses subscription allowance or API billing.

High-level architecture to implement:

Hermes Kanban:
- Durable task queue
- Shared board across profiles
- SQLite-backed task state
- Native Hermes dashboard if available
- Worktree-based coding tasks where possible

Profiles:
1. jovie-orchestrator
   - Provider: Codex via ChatGPT/Codex OAuth
   - Purpose: intake, issue decomposition, planning, routing, Linear/GitHub coordination
   - Should not directly implement code except tiny config/glue work

2. jovie-implementer
   - Provider: DeepSeek
   - Model: best available DeepSeek coding model, preferably deepseek-v4-pro or equivalent
   - Purpose: implementation, tests, lint/type fixes, migrations, scaffolding
   - Should work from explicit specs/plans only

3. jovie-reviewer
   - Provider: Codex via ChatGPT/Codex OAuth
   - Purpose: review diffs, verify test coverage, catch architecture/security/scope issues, approve/block PRs

Queue flow:
Linear issue assigned/labeled for AI
→ Hermes intake detects it
→ jovie-orchestrator creates/updates a Kanban task
→ orchestrator writes plan + acceptance criteria
→ implementer codes in isolated workspace/worktree
→ implementer runs tests/lint/typecheck
→ reviewer reviews diff
→ implementer fixes reviewer findings
→ PR opened/updated in GitHub
→ Linear issue updated with status, PR link, test results, and remaining risks

Do not use raw synchronous subagents as the main durable execution system.
Use raw subagents only for short helper tasks like file inspection, approach comparison, or quick review.
Use Hermes Kanban/profiles for real coding tickets.

First steps:
1. Inspect the installed Hermes version and available commands.
2. Run help/list commands as needed. Do not hallucinate CLI flags.
3. Inspect whether these are available:
   - Hermes Kanban
   - Kanban dashboard plugin
   - Hermes profiles
   - Hermes cron/scheduler
   - Linear integration or skill
   - GitHub integration or skill
   - Codex OAuth provider
   - DeepSeek provider
4. If an expected feature is missing, choose the lightest workaround and document it.

Provider setup:
1. Configure Codex provider using ChatGPT/Codex OAuth only.
2. Verify it does not use OPENAI_API_KEY or usage-based API billing.
3. Configure DeepSeek provider using DEEPSEEK_API_KEY.
4. Confirm the implementer profile routes to DeepSeek.
5. Confirm orchestrator and reviewer route to Codex OAuth.
6. Add explicit guardrails so implementation tasks never accidentally use Codex unless manually overridden.
7. Add explicit guardrails so planning/review tasks never accidentally use DeepSeek for final judgment unless manually overridden.

Create or update these Hermes profiles:

Profile: jovie-orchestrator
Role:
- Owns Linear intake
- Converts Linear issues into Kanban tasks
- Writes concise implementation plans
- Creates acceptance criteria
- Assigns tasks to implementer/reviewer
- Tracks status
- Updates Linear and GitHub
- Avoids direct code implementation

Profile: jovie-implementer
Role:
- Implements only scoped Kanban tasks
- Reads the plan before coding
- Works in isolated worktree/workspace
- Does not change unrelated files
- Adds/updates tests
- Runs relevant tests before completion
- Reports changed files, tests run, failures, uncertainty
- Blocks the task instead of guessing when requirements are unclear

Profile: jovie-reviewer
Role:
- Reviews diffs against main
- Checks correctness, architecture, security, test coverage, performance, and scope creep
- Blocks with exact actionable fixes when issues exist
- Approves only when implementation satisfies the plan and tests pass
- Updates Kanban/Linear with review summary

Kanban setup:
1. Enable Hermes Kanban.
2. Enable the Kanban dashboard plugin if available.
3. Start or configure the Hermes gateway/dashboard if required.
4. Create a board/tenant/project named “jovie”.
5. Create lanes/statuses for:
   - Intake
   - Planning
   - Ready for Implementation
   - Implementing
   - Ready for Review
   - Fixes Required
   - Ready for PR
   - Done
   - Blocked
6. Configure worker lanes so:
   - Planning tasks go to jovie-orchestrator
   - Implementation tasks go to jovie-implementer
   - Review tasks go to jovie-reviewer
7. Use isolated git worktrees/workspaces for coding tasks where possible.
8. Ensure every task records:
   - Linear issue ID
   - Git branch
   - Workspace path
   - Assigned profile
   - Current model/provider
   - Test commands run
   - PR URL
   - Final status

Linear integration:
Implement the simplest reliable Linear intake method available.

Preferred:
- Use Linear webhooks/agent integration if Hermes supports it cleanly.

Fallback:
- Use Hermes cron to poll Linear every 5–10 minutes.

Behavior:
1. Find Linear issues assigned to the AI agent or labeled with an agreed AI label, for example:
   - ai
   - ai-ready
   - hermes
   - jovie-agent
2. For each new Linear issue, create exactly one root Kanban task.
3. Use idempotency keys so repeated polling does not duplicate tasks.
4. Store the mapping:
   - Linear issue ID
   - Linear issue identifier
   - Kanban task ID
   - Git branch
   - PR URL
5. Update Linear comments/status when:
   - Planning starts
   - Plan is ready
   - Implementation starts
   - Tests pass/fail
   - Review blocks/approves
   - PR is opened
   - Work is done or blocked

GitHub integration:
1. Detect the repo and default branch.
2. For each implementation task:
   - Fetch latest main
   - Create branch like ai/<linear-issue-key>-<slug>
   - Use isolated worktree/workspace
   - Commit changes with clear message
   - Push branch
   - Open PR
3. PR title format:
   [<LINEAR_KEY>] <issue title>
4. PR body must include:
   - Linear issue link
   - Plan summary
   - Files changed
   - Tests run
   - Reviewer findings
   - Remaining risks
5. Do not merge automatically unless explicitly configured later.
6. Leave PR ready for human review unless the issue is explicitly marked safe-for-auto-merge and all checks pass.

Cron/scheduler:
Set up these scheduled jobs if Hermes cron is available:

1. Linear intake poller
   - Every 10 minutes
   - Finds AI-ready Linear issues
   - Creates/updates Kanban tasks
   - Idempotent

2. Stale task checker
   - Every 30 minutes
   - Finds stuck/blocked/running tasks
   - Comments status
   - Retries only when safe

3. Nightly PR/CI review
   - Every night around 2am local time
   - Checks AI-created PRs
   - Summarizes failed CI
   - Creates follow-up Kanban tasks if needed

4. Morning summary
   - Weekdays around 9am local time
   - Summarizes:
     - Completed AI work
     - Open PRs
     - Blocked tasks
     - Failed tests
     - Required human decisions

Implementation guardrails:
1. No destructive shell commands without explicit safety checks.
2. No deleting branches, dropping databases, resetting main, force-pushing, or modifying production secrets.
3. Never commit secrets.
4. Scan diffs for secrets before PR.
5. Do not modify unrelated files.
6. Do not expand scope beyond the Linear issue and approved plan.
7. Block the task when product ambiguity affects implementation.
8. Prefer small PRs.
9. Every coding task must run relevant tests or explain exactly why tests were not run.
10. Reviewer must verify the diff, not merely read the implementer summary.

Repository conventions:
1. Detect package manager automatically.
2. Detect test/lint/typecheck commands from package.json, Makefile, pyproject, or repo docs.
3. Save detected commands in a local AI runner config file.
4. Use those commands consistently.
5. If commands are missing, create a suggested config and ask for approval before enforcing it.

Files/docs to create:
Create documentation in the repo or Hermes config area, whichever is more appropriate:

1. docs/ai-engineering-system.md
   Include:
   - Architecture
   - Provider routing
   - Cost guardrails
   - Profile roles
   - Kanban flow
   - Linear labels/assignment rules
   - GitHub PR workflow
   - Cron jobs
   - Troubleshooting

2. docs/ai-agent-runbook.md
   Include:
   - How to start Hermes gateway/dashboard
   - How to inspect Kanban board
   - How to manually enqueue a Linear issue
   - How to stop/pause workers
   - How to rotate DeepSeek key
   - How to verify Codex OAuth
   - How to audit model/provider usage
   - How to disable automation

3. A local config file if needed, for example:
   .jovie/ai-agent-config.yaml
   Include:
   - Provider names
   - Profile names
   - Linear label filters
   - Branch naming
   - Test commands
   - Dashboard URL
   - Poll intervals

Validation:
After setup, run a dry-run test.

Dry-run test:
1. Create or identify a harmless test Linear issue or local mock issue.
2. Create a Kanban task from it.
3. Have orchestrator write a plan.
4. Have implementer make either:
   - no code changes, or
   - a tiny harmless docs-only change
5. Have reviewer review it.
6. Confirm all status updates work.
7. Confirm provider routing:
   - Orchestrator = Codex OAuth
   - Implementer = DeepSeek
   - Reviewer = Codex OAuth
8. Confirm no Anthropic/Claude provider is configured or used.
9. Confirm no OpenAI API key billing path is used.
10. Report exact commands used and exact files changed.

Deliverables:
At the end, provide:
1. What you configured
2. Exact profiles created
3. Exact provider routing
4. Exact cron jobs created
5. Dashboard URL or how to open it
6. Linear intake rule
7. GitHub PR workflow
8. Dry-run result
9. Any missing Hermes features or workarounds
10. Any remaining manual steps

Work style:
- Be autonomous.
- Inspect before assuming.
- Prefer native Hermes features over custom infrastructure.
- Prefer simple durable systems over fragile clever ones.
- Keep implementation small and reversible.
- Document everything.
- Do not ask me for clarification unless blocked by a missing credential or destructive decision.
- When blocked, state the exact missing credential, permission, command, or decision needed.
```

For the first run, add this short prefix above it:

```text
Start in audit/setup mode. Do not enable recurring cron jobs or make code changes until you have verified provider routing and shown me the planned configuration. After the plan is approved, implement it.
```

After the setup looks right, run it again without that prefix to let Hermes implement.


should each agent handle landing the pr they created or should one agent land all open prs? which is going to use less tokens


Mr. White, a **single dedicated merge/review agent** will usually use fewer tokens overall and produce more consistent outcomes.

Best architecture:

```text
Implementer agents:
- code
- test
- open/update PR
- stop

Single reviewer/merge agent:
- reviews all open PRs
- decides approve/block
- requests fixes
- merges when clean
```

## Why this uses fewer tokens

If every implementer also lands its own PR:

```text
Implementer:
- reads issue
- plans
- codes
- tests
- rereads diff
- reviews itself
- inspects CI
- merges
```

That duplicates expensive reasoning context per worker.

With a centralized reviewer:

```text
Implementer:
- issue context only
- local diff only
- task-scoped tests only

Reviewer:
- loads PR diff only
- standardized merge checklist
- standardized CI inspection
```

The expensive “should this merge?” reasoning becomes amortized across all PRs.

## Biggest token saver

The real token win is:

```text
Workers never load the full repo.
Reviewer never loads the full issue history.
```

Each role gets minimal context.

## Recommended split

### Implementer agent (DeepSeek)

Cheap.

Responsibilities:

```text
- implement scoped task
- run targeted tests
- open/update PR
- summarize changes
- stop
```

Never let it:

```text
- decide merge readiness globally
- inspect unrelated PRs
- resolve merge queue conflicts
- do architectural judgment
```

DeepSeek is cheap enough that extra implementation retries are fine.

## Reviewer/Merge agent (Codex)

Expensive/high-quality.

Responsibilities:

```text
- review diffs
- inspect CI
- check architecture/security/scope
- request fixes
- merge approved PRs
```

This agent can run periodically:

```text
every 15 min:
  inspect all open AI PRs
```

That is vastly cheaper than having every implementer repeatedly poll CI and self-review.

## Even cheaper architecture

Cheapest serious setup:

```text
DeepSeek implementers
→ GitHub PR

GitHub Actions
→ run lint/test/typecheck

Codex reviewer
→ ONLY wakes up if CI passes
```

Now Codex never wastes tokens reviewing obviously broken PRs.

Flow:

```text
1. DeepSeek implements
2. Push PR
3. CI runs
4. If CI fails:
      DeepSeek fixes
5. If CI passes:
      Codex reviewer wakes up
6. Codex approves/block
7. Merge agent merges
```

That is probably your optimal cost/performance architecture.

## One merge agent vs one reviewer + one merger

Use:

```text
reviewer == merger
```

No reason to split unless scale becomes enormous.

Separate merge-only agents are useful when:

```text
- multiple repos
- merge queues
- branch protection complexity
- batching
- release trains
```

You are not there yet.

## Kanban structure

Recommended lanes:

```text
Intake
Planning
Implementing
CI Failed
Ready for Review
Fixes Required
Ready to Merge
Merged
Blocked
```

The reviewer/merge agent owns:

```text
Ready for Review
Ready to Merge
Merged
Fixes Required
```

Implementers own:

```text
Implementing
CI Failed
```

## Token optimization rules

### HUGE savings

Do these:

```text
1. Reviewer only reads diff, not full files.
2. Implementers only get scoped issue context.
3. Use GitHub Actions for tests, not LLM reasoning.
4. Use shallow PR summaries.
5. Use worktrees to isolate context.
6. Reuse concise system prompts.
7. Disable repo-wide semantic search unless needed.
```

### Avoid

Avoid these:

```text
- “analyze the whole repo”
- “understand the entire architecture”
- loading massive markdown docs repeatedly
- multi-agent debate loops
- recursive self-review
```

That burns tokens insanely fast.

## Best practical setup for Jovie

```text
Hermes Orchestrator (Codex)
- decomposes work
- routes tasks

DeepSeek Implementers
- code
- fix CI
- open PRs

GitHub Actions
- tests
- lint
- typecheck

Codex Reviewer/Merger
- reviews passing PRs only
- merges approved PRs
```

That gives you:

```text
High quality judgment
+
Cheap implementation
+
Minimal duplicated reasoning
+
Durable queue
+
Low token burn
```

That is likely the best ROI architecture for where Jovie is right now.


give me the implementation prompt


```text
You are Hermes operating as Jovie’s autonomous AI engineering system.

Mission:
Implement a durable multi-agent coding pipeline optimized for:
- minimum token cost
- maximum throughput
- high merge quality
- low duplicated reasoning
- strong isolation between tasks
- durable execution using Hermes Kanban

Core architecture (MANDATORY)

DO NOT use:
- Anthropic
- Claude API
- Claude Max extra usage
- Claude Code
- OpenAI API billing
- OPENAI_API_KEY billing paths
- any paid auto-topup or extra credit system

USE ONLY:
1. Hermes Kanban as the durable task queue
2. Codex OAuth via ChatGPT Pro subscription for:
   - orchestration
   - planning
   - review
   - merge decisions
3. DeepSeek API for:
   - implementation
   - CI fixes
   - repetitive coding
   - tests
   - scaffolding
4. GitHub Actions for:
   - lint
   - typecheck
   - tests
5. Linear as external issue source
6. GitHub PRs as execution artifacts

Critical architecture constraints

Implementers NEVER:
- merge PRs
- globally review architecture
- inspect unrelated PRs
- repeatedly poll CI
- load the full repo unnecessarily

Reviewer/Merge agent ONLY:
- reviews PRs with passing CI
- loads minimal diff context
- merges approved PRs
- blocks unsafe PRs
- requests exact fixes

Use GitHub Actions as the first validation layer so expensive reviewer tokens are only spent on passing PRs.

High-level flow

Linear Issue
→ Hermes intake
→ Kanban task
→ Orchestrator writes plan
→ DeepSeek implementer codes
→ GitHub Actions run
→ if CI fails:
     implementer fixes
→ if CI passes:
     reviewer/merge agent wakes up
→ reviewer approves or blocks
→ merge agent merges approved PR
→ Linear updated

Durable execution rules

Do NOT use synchronous subagents as the primary execution mechanism.

Use:
- Hermes Kanban
- Hermes profiles
- worktrees/workspaces
- durable task records
- scheduled polling/review

Subagents may ONLY be used for:
- quick inspection
- summarization
- short research tasks

Profiles to create

1. jovie-orchestrator
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- Linear intake
- issue decomposition
- planning
- acceptance criteria
- routing tasks
- Kanban management
- PR coordination
- status updates

Must NOT:
- implement large code changes
- merge PRs directly

2. jovie-implementer
Provider:
- DeepSeek

Purpose:
- implementation
- CI fixes
- tests
- lint/typecheck fixes
- migrations
- scaffolding

Rules:
- use scoped issue context only
- do not read unrelated files
- do not modify unrelated files
- always run relevant tests
- stop when blocked
- report uncertainty explicitly

3. jovie-reviewer
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- review diffs
- inspect passing CI
- verify architecture/security/scope
- approve/block PRs
- merge approved PRs

Rules:
- only wake up for passing CI
- load minimal diff context
- avoid loading full repo
- request exact actionable fixes
- merge only when safe

Provider setup requirements

Verify all provider routing before implementation.

Codex:
- MUST use ChatGPT/Codex OAuth
- MUST NOT use OPENAI_API_KEY
- MUST NOT use API billing
- MUST use subscription allowance only

DeepSeek:
- MUST use DEEPSEEK_API_KEY
- MUST route implementer tasks to DeepSeek only

Verify:
- orchestrator → Codex OAuth
- reviewer → Codex OAuth
- implementer → DeepSeek

Add explicit safeguards preventing:
- DeepSeek from handling final merge/review decisions
- Codex from being used for implementation-heavy coding unless manually overridden

Kanban requirements

Enable Hermes Kanban.

Enable Kanban dashboard plugin if available.

Create a board/tenant/project:
- jovie

Statuses/lanes:
1. Intake
2. Planning
3. Ready for Implementation
4. Implementing
5. CI Failed
6. Ready for Review
7. Fixes Required
8. Ready to Merge
9. Merged
10. Blocked

Worker ownership:
- orchestrator owns Intake + Planning
- implementers own Implementing + CI Failed
- reviewer owns Ready for Review + Ready to Merge + Merged + Fixes Required

Task metadata requirements:
Every task must store:
- Linear issue ID
- Linear identifier
- branch name
- workspace/worktree path
- assigned profile
- provider/model
- test commands run
- PR URL
- CI status
- final status

Workspace/worktree rules

Use isolated git worktrees/workspaces for implementation tasks whenever possible.

Branch naming:
ai/<linear-key>-<slug>

Never:
- work directly on main
- force push main
- delete branches automatically
- run destructive git commands without confirmation

GitHub Actions integration

Detect existing CI.

If missing, create lightweight CI for:
- install
- lint
- typecheck
- tests

Keep CI fast and minimal.

Reviewer MUST NOT wake up unless CI passes.

If CI fails:
- route task back to implementer automatically

Reviewer should inspect:
- diff
- CI results
- changed files
- PR description

Reviewer should NOT:
- reread entire repo
- reload massive docs unnecessarily

Linear integration

Implement the simplest reliable intake method.

Preferred:
- Linear webhooks/agent integration

Fallback:
- Hermes cron polling every 10 minutes

AI issue intake rules:
Process issues:
- assigned to AI agent
OR
- labeled:
    ai
    ai-ready
    hermes
    jovie-agent

Use idempotency protection so issues do not duplicate.

Store mapping:
- Linear issue ID
- Kanban task ID
- Git branch
- PR URL

Update Linear automatically when:
- planning starts
- plan completed
- implementation starts
- CI fails/passes
- review blocks/approves
- PR opens
- PR merges
- task blocked

GitHub PR workflow

Implementers:
- create/update PRs
- stop after CI passes

Reviewer:
- reviews passing PRs
- merges approved PRs

PR title:
[<LINEAR_KEY>] <issue title>

PR body template:
- issue link
- implementation summary
- files changed
- tests run
- CI status
- reviewer findings
- remaining risks

Do not auto-merge unless:
- explicitly configured safe
- CI passes
- reviewer approves

Cron/scheduler jobs

Implement:

1. Linear intake poller
Every 10 min:
- discover AI-ready issues
- enqueue/update Kanban tasks
- idempotent

2. CI recovery watcher
Every 15 min:
- inspect failed AI PRs
- route back to implementer if fixable

3. Reviewer queue watcher
Every 15 min:
- discover PRs with passing CI
- enqueue reviewer tasks

4. Nightly maintenance
Nightly:
- summarize blocked tasks
- summarize stale PRs
- summarize failed CI
- summarize open reviewer queue

5. Morning summary
Weekdays:
- completed work
- blocked work
- open PRs
- merge status
- required human decisions

Cost optimization rules

MANDATORY:
1. Implementers get minimal scoped context only.
2. Reviewer loads diffs only.
3. Avoid repo-wide scans unless required.
4. Prefer GitHub Actions over LLM reasoning for validation.
5. Avoid recursive review loops.
6. Avoid multi-agent debates.
7. Avoid rereading large markdown docs repeatedly.
8. Prefer concise prompts and summaries.
9. Prefer small PRs.
10. Avoid loading the entire repo into context.

Implementation quality rules

1. No secrets in commits.
2. Scan diffs for secrets.
3. No unrelated file modifications.
4. No scope creep.
5. Block instead of guessing.
6. Tests required unless impossible.
7. Reviewer verifies actual diff.
8. Document assumptions explicitly.
9. Prefer reversible changes.
10. Prefer native Hermes features over custom infrastructure.

Docs to create

1. docs/ai-engineering-system.md
Include:
- architecture
- provider routing
- Kanban flow
- merge flow
- Linear integration
- GitHub workflow
- CI workflow
- cost optimization strategy
- profile responsibilities

2. docs/ai-agent-runbook.md
Include:
- starting Hermes
- dashboard usage
- Kanban usage
- Linear intake
- provider verification
- disabling automation
- troubleshooting
- inspecting stuck tasks
- rotating DeepSeek keys
- verifying Codex OAuth

3. Local config file
Example:
.jovie/ai-agent-config.yaml

Include:
- providers
- profiles
- branch naming
- poll intervals
- CI commands
- labels
- dashboard URL
- workflow settings

Validation requirements

After implementation:
Run a dry-run test using a harmless issue.

Dry-run must verify:
1. Linear intake works
2. Kanban task created
3. Orchestrator writes plan
4. Implementer creates tiny harmless change
5. GitHub Actions run
6. Reviewer wakes up only after CI passes
7. Reviewer reviews diff
8. Reviewer merges or blocks correctly
9. Linear updates work
10. Correct provider routing verified

Explicitly confirm:
- No Anthropic configured
- No Claude configured
- No API billing path used for Codex
- Implementer uses DeepSeek only
- Reviewer uses Codex only

Final deliverables

At completion provide:
1. Exact providers configured
2. Exact profiles created
3. Exact Kanban setup
4. Exact cron jobs
5. Dashboard URL/how to open
6. Linear intake rules
7. GitHub workflow
8. CI workflow
9. Dry-run results
10. Remaining manual steps
11. Missing Hermes features/workarounds
12. Estimated operational token/cost savings from centralized review architecture

Execution mode

Operate autonomously.
Inspect before assuming.
Prefer native Hermes functionality.
Keep systems simple and durable.
Document all changes.
Do not ask for clarification unless blocked by:
- missing credentials
- missing permissions
- destructive decision
- unavailable Hermes feature

If blocked:
state the exact command, credential, permission, or decision needed.
```


make sure it use ruflo where possible and worktrees with our setup script from the repo and also make sure its using gbrain properly at the satart and end of tasks etc


```text id="0szshg"
You are Hermes operating as Jovie’s autonomous AI engineering system.

Mission:
Implement a durable multi-agent coding pipeline optimized for:
- minimum token cost
- maximum throughput
- high merge quality
- low duplicated reasoning
- strong task isolation
- durable execution using Hermes Kanban
- maximum reuse of existing Jovie tooling/infrastructure

Core architecture (MANDATORY)

DO NOT use:
- Anthropic
- Claude API
- Claude Max extra usage
- Claude Code
- OpenAI API billing
- OPENAI_API_KEY billing paths
- any paid auto-topup or extra credit system

USE ONLY:
1. Hermes Kanban as the durable task queue
2. Codex OAuth via ChatGPT Pro subscription for:
   - orchestration
   - planning
   - review
   - merge decisions
3. DeepSeek API for:
   - implementation
   - CI fixes
   - repetitive coding
   - tests
   - scaffolding
4. GitHub Actions for:
   - lint
   - typecheck
   - tests
5. Linear as external issue source
6. GitHub PRs as execution artifacts
7. Ruflo wherever it provides leverage or existing functionality
8. Existing Jovie setup/bootstrap scripts
9. GBrain for memory/context continuity and task lifecycle memory

Critical architecture constraints

Implementers NEVER:
- merge PRs
- globally review architecture
- inspect unrelated PRs
- repeatedly poll CI
- load the full repo unnecessarily

Reviewer/Merge agent ONLY:
- reviews PRs with passing CI
- loads minimal diff context
- merges approved PRs
- blocks unsafe PRs
- requests exact fixes

Use GitHub Actions as the first validation layer so expensive reviewer tokens are only spent on passing PRs.

High-level flow

Linear Issue
→ Hermes intake
→ Kanban task
→ Orchestrator writes plan
→ DeepSeek implementer codes
→ GitHub Actions run
→ if CI fails:
     implementer fixes
→ if CI passes:
     reviewer/merge agent wakes up
→ reviewer approves or blocks
→ merge agent merges approved PR
→ Linear updated

Durable execution rules

Do NOT use synchronous subagents as the primary execution mechanism.

Use:
- Hermes Kanban
- Hermes profiles
- git worktrees
- durable task records
- scheduled polling/review
- Ruflo orchestration/hooks where beneficial

Subagents may ONLY be used for:
- quick inspection
- summarization
- short research tasks

RUFLO INTEGRATION REQUIREMENTS

Inspect the repo and current environment for:
- Ruflo installation
- existing Ruflo configs
- hooks
- orchestration flows
- slash commands
- routing
- existing automations

Reuse Ruflo wherever possible instead of rebuilding equivalent orchestration manually.

Preferred Ruflo responsibilities:
- orchestration glue
- routing
- hooks
- workflow coordination
- automation helpers
- task/event pipelines
- model/provider abstraction
- memory integration if already wired

Do NOT duplicate existing Ruflo functionality if already available.

If Ruflo already supports:
- swarms
- queues
- hooks
- workflows
- orchestration
- task dispatch
then integrate Hermes Kanban with Ruflo instead of replacing Ruflo entirely.

Document exactly:
- what Ruflo handles
- what Hermes handles
- what overlap exists
- what was intentionally NOT duplicated

WORKTREE REQUIREMENTS

MANDATORY:
Every implementation task must run in an isolated git worktree/workspace.

Do NOT:
- code directly on main
- reuse dirty workspaces
- allow multiple implementers in same workspace

Inspect the repo for:
- existing worktree setup scripts
- repo bootstrap scripts
- environment setup scripts
- dev shell setup
- package manager setup
- existing automation

Reuse the existing Jovie setup/bootstrap script wherever possible.

The implementation workflow should be:

1. Fetch latest main
2. Create isolated worktree:
   ai/<linear-key>-<slug>
3. Run the existing repo setup/bootstrap script automatically
4. Validate dependencies/environment
5. Run implementation
6. Run tests
7. Commit
8. Push
9. Open/update PR

Workspace metadata must include:
- branch
- worktree path
- setup status
- dependency install status
- test status
- assigned task
- provider/model used

GBRAIN REQUIREMENTS

Inspect current GBrain integration/setup.

Reuse existing GBrain integration if available.

MANDATORY TASK LIFECYCLE MEMORY FLOW

At task START:
1. Pull relevant context from GBrain:
   - issue history
   - related PRs
   - architecture notes
   - previous agent learnings
   - coding conventions
   - known pitfalls
   - related repo memory

2. Save:
   - task start event
   - assigned profile
   - provider/model
   - worktree path
   - branch
   - implementation plan

At task END:
1. Push structured memory back into GBrain:
   - outcome
   - files changed
   - bugs discovered
   - architectural learnings
   - reviewer findings
   - CI failures
   - fixes applied
   - unresolved risks
   - implementation notes
   - useful commands
   - repo discoveries

2. Store:
   - PR URL
   - merge/block result
   - test outcomes
   - final status

3. Ensure future agents can retrieve:
   - prior implementation pitfalls
   - recurring CI failures
   - architecture decisions
   - repo conventions

IMPORTANT:
Do NOT spam GBrain with low-value noise.

Prefer:
- concise structured memory
- durable learnings
- implementation patterns
- debugging insights
- architectural decisions

Avoid:
- giant raw logs
- repetitive summaries
- low-signal chatter

Profiles to create

1. jovie-orchestrator
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- Linear intake
- issue decomposition
- planning
- acceptance criteria
- routing tasks
- Kanban management
- PR coordination
- status updates
- GBrain orchestration memory
- Ruflo workflow coordination

Must NOT:
- implement large code changes
- merge PRs directly

2. jovie-implementer
Provider:
- DeepSeek

Purpose:
- implementation
- CI fixes
- tests
- lint/typecheck fixes
- migrations
- scaffolding

Rules:
- use scoped issue context only
- do not read unrelated files
- do not modify unrelated files
- always run relevant tests
- stop when blocked
- report uncertainty explicitly
- always operate in isolated worktree
- pull/push task memory from GBrain

3. jovie-reviewer
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- review diffs
- inspect passing CI
- verify architecture/security/scope
- approve/block PRs
- merge approved PRs
- write reviewer learnings to GBrain

Rules:
- only wake up for passing CI
- load minimal diff context
- avoid loading full repo
- request exact actionable fixes
- merge only when safe

Provider setup requirements

Verify all provider routing before implementation.

Codex:
- MUST use ChatGPT/Codex OAuth
- MUST NOT use OPENAI_API_KEY
- MUST NOT use API billing
- MUST use subscription allowance only

DeepSeek:
- MUST use DEEPSEEK_API_KEY
- MUST route implementer tasks to DeepSeek only

Verify:
- orchestrator → Codex OAuth
- reviewer → Codex OAuth
- implementer → DeepSeek

Add explicit safeguards preventing:
- DeepSeek from handling final merge/review decisions
- Codex from being used for implementation-heavy coding unless manually overridden

Kanban requirements

Enable Hermes Kanban.

Enable Kanban dashboard plugin if available.

Create a board/tenant/project:
- jovie

Statuses/lanes:
1. Intake
2. Planning
3. Ready for Implementation
4. Implementing
5. CI Failed
6. Ready for Review
7. Fixes Required
8. Ready to Merge
9. Merged
10. Blocked

Worker ownership:
- orchestrator owns Intake + Planning
- implementers own Implementing + CI Failed
- reviewer owns Ready for Review + Ready to Merge + Merged + Fixes Required

Task metadata requirements:
Every task must store:
- Linear issue ID
- Linear identifier
- branch name
- workspace/worktree path
- assigned profile
- provider/model
- setup/bootstrap status
- test commands run
- PR URL
- CI status
- final status

Workspace/worktree rules

Use isolated git worktrees/workspaces for implementation tasks whenever possible.

Branch naming:
ai/<linear-key>-<slug>

Never:
- work directly on main
- force push main
- delete branches automatically
- run destructive git commands without confirmation

GitHub Actions integration

Detect existing CI.

If missing, create lightweight CI for:
- install
- lint
- typecheck
- tests

Keep CI fast and minimal.

Reviewer MUST NOT wake up unless CI passes.

If CI fails:
- route task back to implementer automatically

Reviewer should inspect:
- diff
- CI results
- changed files
- PR description

Reviewer should NOT:
- reread entire repo
- reload massive docs unnecessarily

Linear integration

Implement the simplest reliable intake method.

Preferred:
- Linear webhooks/agent integration

Fallback:
- Hermes cron polling every 10 minutes

AI issue intake rules:
Process issues:
- assigned to AI agent
OR
- labeled:
    ai
    ai-ready
    hermes
    jovie-agent

Use idempotency protection so issues do not duplicate.

Store mapping:
- Linear issue ID
- Kanban task ID
- Git branch
- PR URL

Update Linear automatically when:
- planning starts
- plan completed
- implementation starts
- CI fails/passes
- review blocks/approves
- PR opens
- PR merges
- task blocked

GitHub PR workflow

Implementers:
- create/update PRs
- stop after CI passes

Reviewer:
- reviews passing PRs
- merges approved PRs

PR title:
[<LINEAR_KEY>] <issue title>

PR body template:
- issue link
- implementation summary
- files changed
- tests run
- CI status
- reviewer findings
- remaining risks

Do not auto-merge unless:
- explicitly configured safe
- CI passes
- reviewer approves

Cron/scheduler jobs

Implement:

1. Linear intake poller
Every 10 min:
- discover AI-ready issues
- enqueue/update Kanban tasks
- idempotent

2. CI recovery watcher
Every 15 min:
- inspect failed AI PRs
- route back to implementer if fixable

3. Reviewer queue watcher
Every 15 min:
- discover PRs with passing CI
- enqueue reviewer tasks

4. Nightly maintenance
Nightly:
- summarize blocked tasks
- summarize stale PRs
- summarize failed CI
- summarize open reviewer queue

5. Morning summary
Weekdays:
- completed work
- blocked work
- open PRs
- merge status
- required human decisions

Cost optimization rules

MANDATORY:
1. Implementers get minimal scoped context only.
2. Reviewer loads diffs only.
3. Avoid repo-wide scans unless required.
4. Prefer GitHub Actions over LLM reasoning for validation.
5. Avoid recursive review loops.
6. Avoid multi-agent debates.
7. Avoid rereading large markdown docs repeatedly.
8. Prefer concise prompts and summaries.
9. Prefer small PRs.
10. Avoid loading the entire repo into context.

Implementation quality rules

1. No secrets in commits.
2. Scan diffs for secrets.
3. No unrelated file modifications.
4. No scope creep.
5. Block instead of guessing.
6. Tests required unless impossible.
7. Reviewer verifies actual diff.
8. Document assumptions explicitly.
9. Prefer reversible changes.
10. Prefer native Hermes/Ruflo functionality over custom infrastructure.

Docs to create

1. docs/ai-engineering-system.md
Include:
- architecture
- provider routing
- Kanban flow
- Ruflo integration
- GBrain lifecycle
- worktree lifecycle
- merge flow
- Linear integration
- GitHub workflow
- CI workflow
- cost optimization strategy
- profile responsibilities

2. docs/ai-agent-runbook.md
Include:
- starting Hermes
- dashboard usage
- Kanban usage
- Ruflo usage
- GBrain inspection
- worktree inspection
- Linear intake
- provider verification
- disabling automation
- troubleshooting
- inspecting stuck tasks
- rotating DeepSeek keys
- verifying Codex OAuth

3. Local config file
Example:
.jovie/ai-agent-config.yaml

Include:
- providers
- profiles
- branch naming
- poll intervals
- CI commands
- labels
- dashboard URL
- workflow settings
- worktree setup commands
- GBrain integration settings

Validation requirements

After implementation:
Run a dry-run test using a harmless issue.

Dry-run must verify:
1. Linear intake works
2. Kanban task created
3. Orchestrator writes plan
4. Implementer creates tiny harmless change
5. Worktree setup script runs correctly
6. GBrain task-start memory recorded
7. GitHub Actions run
8. Reviewer wakes up only after CI passes
9. Reviewer reviews diff
10. Reviewer merges or blocks correctly
11. GBrain task-end memory recorded
12. Correct provider routing verified

Explicitly confirm:
- No Anthropic configured
- No Claude configured
- No API billing path used for Codex
- Implementer uses DeepSeek only
- Reviewer uses Codex only

Final deliverables

At completion provide:
1. Exact providers configured
2. Exact profiles created
3. Exact Kanban setup
4. Exact Ruflo integrations
5. Exact GBrain lifecycle integration
6. Exact worktree lifecycle
7. Exact cron jobs
8. Dashboard URL/how to open
9. Linear intake rules
10. GitHub workflow
11. CI workflow
12. Dry-run results
13. Remaining manual steps
14. Missing Hermes/Ruflo features/workarounds
15. Estimated operational token/cost savings from centralized review architecture

Execution mode

Operate autonomously.
Inspect before assuming.
Prefer native Hermes + Ruflo functionality.
Keep systems simple and durable.
Document all changes.
Do not ask for clarification unless blocked by:
- missing credentials
- missing permissions
- destructive decision
- unavailable Hermes/Ruflo feature

If blocked:
state the exact command, credential, permission, or decision needed.
```


{'asset_pointer': 'sediment://file_00000000e31871fd98ebfd6e41496c80', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 13200243, 'width': 2048}
it seems like claude code does use your subscription.....


**Topic:** [[chatgpt-clusters/coding_ai]]
