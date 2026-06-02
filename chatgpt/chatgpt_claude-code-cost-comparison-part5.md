
Mr. White, proceed, but **do not approve the plan exactly as written**. The Ruflo init succeeded and looks safe enough to use, but the plan needs a final delta patch before Hermes implements.

Your audit shows Ruflo was initialized with `ruflo init --full --force`, added `.claude-flow/`, `.mcp.json`, hooks, agents, skills, and daemon config, and did **not** start autonomous background loops. The daemon has `autoStart: false`, which is good. The main concern is that Ruflo overwrote `.claude/`, installed Claude-oriented defaults, and set model preferences to Claude identifiers. fileciteturn2file0 Ruflo’s own README frames init as a Claude Code integration where hooks can automatically route tasks and coordinate agents, so we should treat those hooks as useful but potentially dangerous until provider policy is enforced. citeturn731224search0

## Decision

Use this architecture:

```text
Hermes Kanban = source of truth
Ruflo = hooks / workflow helper / optional MCP helper
GBrain = durable project memory
Codex OAuth = orchestrator + reviewer + merge judge
DeepSeek direct = implementer once key is configured
Codex OAuth fallback = temporary implementer only
OpenRouter free = triage/status summaries only
Claude/Ruflo Claude defaults = disabled or made inert
```

Hermes Kanban should stay the backbone because Hermes documents it as a durable board shared across profiles, backed by `~/.hermes/kanban.db`, with each worker running as a full OS process. citeturn731224search1

## Final corrections before implementation

The hardening plan still has a few contradictions:

1. **Section 11 is stale.** It still says Ruflo is not initialized. Replace it with the new audit result: Ruflo is initialized, but used only as hooks/MCP/workflow glue. fileciteturn2file1

2. **Do not create `.jovie/AI_AUTOMATION_DISABLED` as the active file.** The plan says to create the real kill-switch file. That would start the system disabled. Create `.jovie/AI_AUTOMATION_DISABLED.example` instead. fileciteturn2file1

3. **Do not store metadata by editing Kanban board JSON directly.** Use Hermes Kanban APIs/CLI where possible. Store overflow metadata in `.jovie/kanban-task-metadata/<task-id>.json`.

4. **Fix Ruflo Claude defaults.** The audit shows Ruflo model preferences point to Claude. Leave them inert or override them so Ruflo cannot route to Claude/Anthropic. fileciteturn2file0

5. **Keep free OpenRouter away from review/merge.** The older plan routed reviewer to free NVIDIA, which is unsafe and superseded. fileciteturn2file2 OpenRouter free models have request/day limits and availability constraints, so they are unsuitable as merge authority. citeturn731224search6

6. **Codex must stay OAuth-only.** Codex is included with ChatGPT plans, but API-key usage is billed through OpenAI Platform pricing, so the provider check must fail if `OPENAI_API_KEY` is visible to automation. citeturn731224search3turn731224search7

## Send Hermes this final approval prompt

```text
Approved to proceed, but first apply this final hardening delta.

Use the latest Ruflo audit as authoritative:
- Ruflo has now been initialized with ruflo init --full --force.
- .claude-flow/ exists.
- .mcp.json exists.
- Ruflo hooks, agents, skills, and MCP config exist.
- Ruflo daemon autoStart is false.
- Ruflo did not create cron jobs or autonomous loops.
- Existing .claude/ was overwritten, with .claude.backup preserved.
- Ruflo model preferences currently point to Claude identifiers.

Update the plan before implementation:

1. Replace the stale Ruflo section.
   Ruflo is initialized now.
   Do not say Ruflo is absent or uninitialized.
   Hermes Kanban remains the source of truth.
   Ruflo may only be used for:
   - hooks
   - MCP helper functionality
   - workflow glue
   - task lifecycle checks
   - memory/context helper flows
   - security/test/diff-risk helpers

   Ruflo must not own:
   - durable queue state
   - Linear issue mapping
   - merge authority
   - provider routing
   - recurring worker loops

2. Neutralize unsafe Ruflo Claude defaults.
   Inspect:
   - .claude/settings.json
   - .mcp.json
   - .claude-flow/
   - .claude/agents/
   - .claude/hooks/
   - .claude/helpers/

   Ensure no active automation routes through:
   - Claude
   - Claude Code
   - Anthropic
   - ANTHROPIC_API_KEY
   - ANTHROPIC_AUTH_TOKEN
   - ANTHROPIC_BASE_URL

   If Ruflo model preferences point to Claude, either:
   - leave them inert and document they are unused by Hermes automation, or
   - override them to non-Claude placeholders compatible with our provider policy.

   Do not delete credentials.
   Do not disconnect providers.
   Just ensure the automation cannot dispatch through Claude/Anthropic.

3. Keep Ruflo daemon disabled.
   Do not run:
   - ruflo daemon start
   - claude-flow daemon start
   - any Ruflo background worker loop

   unless explicitly approved later.

   Document:
   - daemon autoStart=false
   - no active Ruflo daemon
   - how to verify daemon status
   - how to disable Ruflo MCP/hooks if needed

4. Fix the emergency stop file behavior.
   Do NOT create .jovie/AI_AUTOMATION_DISABLED as an active file during setup.

   Create:
   - .jovie/AI_AUTOMATION_DISABLED.example

   Document:
   - creating .jovie/AI_AUTOMATION_DISABLED disables automation
   - deleting it re-enables automation only after provider policy checks pass

5. Do not edit Hermes Kanban SQLite or board JSON directly.
   Use official Hermes Kanban CLI/tool APIs wherever possible.

   If metadata cannot fit in native Kanban fields, store overflow metadata in:
   - .jovie/kanban-task-metadata/<kanban-task-id>.json

6. Keep existing Kanban board:
   - jovie-product

   Do not create a duplicate board unless jovie-product is unusable.

7. Rewrite or disable the old Claude Code dispatcher before enabling new recurring automation.
   The existing dispatch-kanban.sh still points to Claude Code CLI.
   This must be fixed first.

   Verification must include:
   - Hermes cron list
   - system crontab
   - launch agents if applicable
   - grep for claude, anthropic, ANTHROPIC, Claude Code, dispatch-kanban

   There must be exactly one active dispatcher after setup.
   The active dispatcher must call Hermes profiles, not Claude Code.

8. Provider routing rules:
   - jovie-orchestrator = Codex OAuth only
   - jovie-reviewer = Codex OAuth only
   - jovie-merger = Codex OAuth only
   - jovie-implementer = DeepSeek direct if DEEPSEEK_API_KEY is present
   - jovie-implementer = Codex OAuth fallback only if DeepSeek is missing

   Free OpenRouter/NVIDIA may only be used for:
   - status summaries
   - stale task detection
   - obvious CI failure classification
   - queue digests

   Free OpenRouter/NVIDIA must never:
   - review code
   - approve code
   - merge code
   - decide architecture
   - override CI
   - handle security-sensitive decisions

9. Strengthen scripts/ai/assert-provider-policy.sh.
   It must fail if:
   - OPENAI_API_KEY is visible to automation
   - ANTHROPIC_API_KEY is visible
   - ANTHROPIC_AUTH_TOKEN is visible
   - ANTHROPIC_BASE_URL is visible
   - reviewer provider is OpenRouter/free
   - merger provider is OpenRouter/free
   - implementer provider is OpenRouter/free
   - orchestrator/reviewer/merger are not Codex OAuth
   - implementer is neither DeepSeek direct nor explicitly approved Codex OAuth fallback
   - Ruflo daemon is running
   - old Claude Code dispatcher is active
   - .jovie/AI_AUTOMATION_DISABLED exists

10. Codex billing guardrail:
   Codex must use ChatGPT/Codex OAuth only.
   Do not use OpenAI API billing.
   Do not use OPENAI_API_KEY.
   Do not enable auto top-up or extra credits.
   If Codex hits subscription limits, pause tasks instead of switching to API billing.

11. GBrain lifecycle:
   At task start:
   - retrieve relevant memory
   - redact secrets
   - write concise ai_task_start memory
   - record memory ID in task metadata

   At task end:
   - redact secrets
   - write concise ai_task_end memory
   - update existing deterministic memory if present
   - avoid raw logs
   - avoid duplicate memory spam

12. Worktrees:
   Every implementation task must:
   - create isolated git worktree
   - use branch ai/<linear-key>-<slug>
   - run repo setup/bootstrap script
   - verify clean worktree before and after
   - avoid main
   - avoid dirty workspace reuse
   - record setup/test status in metadata

13. GitHub/merge gate:
   Auto-merge remains disabled until branch protection is verified.

   Required gates:
   - branch is ai/*
   - latest commit has passing required checks
   - branch is mergeable
   - no secret scan failure
   - PR has Linear mapping
   - PR has Kanban task mapping
   - reviewer approval exists
   - merge gate script passes
   - branch protection/ruleset verified

   During dry-run, report merge readiness but do not merge unless all protections are verified.

14. Proceed in this order:
   1. Neutralize/verify Ruflo Claude defaults and daemon status.
   2. Rewrite/disable old Claude Code dispatcher.
   3. Create provider policy script.
   4. Create/update Hermes profiles.
   5. Verify Codex OAuth and DeepSeek status.
   6. Configure Kanban lanes on jovie-product.
   7. Add overflow metadata storage.
   8. Add GBrain start/end hooks.
   9. Add worktree scripts using repo setup script.
   10. Add no-agent cron jobs with lockfiles.
   11. Run dry-run docs-only PR.
   12. Report results and stop before auto-merge unless branch protection is verified.

Proceed without asking further questions unless blocked by a missing credential, missing permission, unavailable command, or destructive action.
```

Bottom line: **approve implementation after this delta**. Ruflo is now initialized and useful, but it must remain a helper layer. Hermes Kanban owns work, Codex judges, DeepSeek implements, GitHub Actions gates, and Ruflo hooks support the lifecycle.


**Topic:** [[chatgpt-clusters/coding_ai]]
