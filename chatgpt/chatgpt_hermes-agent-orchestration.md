---
title: "Hermes Agent Orchestration"
type: guide
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1b2324-72d8-83e8-850e-9c890878d2c5
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Hermes Agent Orchestration

> Conversation ID: 6a1b2324-72d8-83e8-850e-9c890878d2c5
> Created: 2026-05-30T17:49:26Z
> Updated: 2026-05-30T17:55:12Z
> Messages: 3

---

## User

should the mbp run hermes in a terminal and orchestrate all coding tasks and have on ehermes agent as the lead profile orchestrator.

or should the air run all hermes agent tasks and asign to the mbp.
and how should we use hermes directly to code or have hermes use opencode or claude code with openrouter end point etc

---

## Assistant

Mr. White, I’ll frame this as a two-Mac local-agent architecture: MBP as the stronger machine, Air as secondary, with Hermes as orchestration. I’ll verify Claude Code, opencode, and OpenRouter assumptions before recommending the topology and coding workflow.

---

## Assistant

Mr. White, the clean setup is:

## Recommendation

**Run the lead Hermes orchestrator on the MacBook Air. Use the MBP as a heavy coding executor and review machine.**

Do **one Hermes lead profile** on the Air, then have it delegate implementation to **OpenCode** or **Claude Code** running in isolated repo worktrees. Hermes should be the **planner / memory / router / reviewer**, not the primary multi-file coding engine for every task.

Hermes is well-suited to this because it supports profiles, persistent memory, scheduled automations, subagents, terminal backends including local/Docker/SSH, and recent Kanban/orchestration features such as task decomposition, worktree-per-task, and per-task model overrides. citeturn158038view0turn104275view1turn158038view3

---

## Device roles

| Device | Role | What runs there |
|---|---:|---|
| **MacBook Air** | Control plane | `hermes-lead`, gateway, cron/scheduled jobs, task queue, memory, task decomposition, issue/PR routing |
| **MBP** | Execution node | Claude Code, OpenCode, local builds, tests, browser/UI checks, final human review |
| **Air fallback** | Light execution | Small patches, docs, scripts, non-heavy tests, simple OpenCode jobs |

The Air should stay responsible for **continuity**. The MBP should stay responsible for **compute-heavy coding and judgment**. Do not make the MBP the single source of Hermes memory/orchestration if it sleeps, travels, reboots, or gets used interactively.

---

## Hermes direct vs Hermes delegating

### Use Hermes directly for

- Task intake and decomposition.
- Reading docs, issues, logs, Linear/GitHub state.
- Creating task specs.
- Small one-file patches.
- Shell glue, migrations, scripts.
- Reviewing diffs.
- Running test commands.
- Summarizing status.
- Maintaining memory and reusable skills.

### Use Hermes → OpenCode for

- Routine implementation.
- Tests.
- Refactors with clear scope.
- Fast/cheap coding passes.
- Multi-model routing through OpenRouter.

OpenCode is an open-source coding agent available in terminal, desktop, and IDE contexts. OpenRouter documents OpenCode as supporting OpenRouter directly through `/connect`, then model selection through `/models`. citeturn711135view0turn804012view3

### Use Hermes → Claude Code for

- Hard multi-file changes.
- Architecture-sensitive work.
- Debugging complex code paths.
- Final implementation pass on important features.
- High-confidence diff review.

Claude Code is designed to run locally in the terminal/IDE, understand codebases, edit files, run tests, and work with existing command-line tools. Anthropic states it runs locally and asks before changing files or running commands. citeturn711135view2

---

## OpenRouter usage

Use **OpenRouter for Hermes and OpenCode**, especially for cheap/default model routing.

Use **Claude Code directly with Anthropic/Claude credentials** for critical tasks. I would not make Claude Code depend on an OpenRouter shim unless you intentionally accept fragility. Official Claude Code positioning is Claude-native, while OpenCode has documented OpenRouter support. citeturn711135view2turn804012view3

For OpenRouter-compatible tools, the current OpenRouter API base is:

```bash
https://openrouter.ai/api/v1
```

OpenRouter’s docs show `/api/v1/chat/completions` and OpenAI SDK usage with `baseURL: "https://openrouter.ai/api/v1"`. citeturn804012view2turn804012view1

---

## Concrete setup

### 1. Air: create the lead profile

```bash
hermes profile create lead --description "Jovie engineering orchestrator: decomposes tasks, assigns workers, manages branches, reviews diffs, and reports status."
lead setup
lead profile use lead
```

Hermes profiles each get separate config, API keys, SOUL.md, memory, sessions, skills, cron jobs, and state. A profile also gets its own command alias, so `lead chat`, `lead setup`, and `lead gateway start` target that profile. citeturn104275view1

### 2. Air: run Hermes as the persistent control plane

Use the Air for:

```bash
lead gateway install
lead gateway start
```

Hermes supports per-profile gateways and persistent services. citeturn104275view1

### 3. Air: keep lead execution sandboxed

For the lead profile, prefer Docker for risky automation:

```bash
lead config set terminal.backend docker
```

Hermes warns that the local backend gives the agent the same filesystem access as the user account, while Docker gives stronger isolation. citeturn700297view0

### 4. MBP: create a coding worker profile

On the MBP:

```bash
hermes profile create coder-mbp --description "Heavy coding executor for Jovie: uses worktrees, OpenCode, Claude Code, tests, and PR prep."
coder-mbp setup
coder-mbp config set terminal.cwd /absolute/path/to/jovie
```

Use local execution on MBP only inside clean repo worktrees.

### 5. Optional: Air controls MBP over SSH

If you want Air Hermes to assign commands to MBP directly, create an Air-side worker profile that uses Hermes’ SSH terminal backend:

```bash
hermes profile create mbp-worker --description "Remote MBP executor for heavy builds and coding sessions."
mbp-worker config set terminal.backend ssh
```

Then set SSH env vars in the worker profile’s `.env`:

```bash
TERMINAL_SSH_HOST=<mbp-host-or-tailscale-name>
TERMINAL_SSH_USER=<mac-username>
```

Hermes documents SSH as a terminal backend for running commands on a remote machine with a persistent shell. citeturn700297view0

---

## OpenCode with OpenRouter

Inside the repo:

```bash
cd /path/to/jovie
opencode
/connect
/models
```

Select **OpenRouter** in `/connect`, then pick models in `/models`. OpenRouter’s OpenCode guide documents this path directly. citeturn804012view3

Config-file version:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "models": {
        "~anthropic/claude-sonnet-latest": {},
        "~google/gemini-flash-latest": {}
      }
    }
  }
}
```

OpenRouter’s docs also support provider routing controls and fallback behavior for OpenCode. citeturn804012view3

---

## Best operating flow

Use this flow for most Jovie coding tasks:

1. **You message Air Hermes lead.**
2. Lead turns the request into a tight task spec.
3. Lead creates or selects a git worktree/branch.
4. Lead chooses executor:
   - **Hermes direct** for small patch/docs/script.
   - **OpenCode via OpenRouter** for normal implementation.
   - **Claude Code direct** for complex repo-wide work.
5. Executor edits code in the worktree.
6. Lead runs tests/lint/typecheck.
7. Lead reviews the diff.
8. Optional verifier profile or Claude Code does final review.
9. Lead prepares PR summary and merge notes.
10. You approve/merge from MBP.

Hermes already has `--worktree` support at the CLI level, and current Hermes releases emphasize worktree-per-task orchestration. citeturn158038view2turn158038view3

---

## Model policy

Use a tiered policy:

| Layer | Default |
|---|---|
| Hermes lead | Cheap/fast explicit model through OpenRouter |
| Hermes auxiliary compression/web extract/title | Very cheap flash model |
| OpenCode | OpenRouter model chosen per task |
| Claude Code | Direct Claude Sonnet/Opus for difficult changes |
| Final architecture review | Strongest model only when needed |

Avoid using an auto-router as the main long-running Hermes brain. Use explicit models and explicit escalation rules so the agent does not burn tokens on repeated large prompts.

---

## Bottom line

**Air runs Hermes lead. MBP runs heavy coding. Hermes delegates real coding to OpenCode or Claude Code.**

Use Hermes as the durable operating system for engineering work. Use OpenCode and Claude Code as specialist executors. This gives you persistent memory, task routing, lower cost, safer worktrees, and better coding output than making one Hermes terminal session on the MBP do everything.
