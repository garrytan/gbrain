# Subagent Routing Convention

How your agent decides between native subagents and GBrain Minions for
background work.

## Rule: read the user's mode first

Every time you're about to spawn a subagent or submit a Minion, check the
user's preference:

```bash
cat ~/.gbrain/preferences.json 2>/dev/null
```

The file has `minion_mode` set to one of three values. If the file doesn't
exist, default to `pain_triggered`.

Then branch on mode:

### Mode A: `always`

All background agent work goes through Minions. `submit_job` is the default.
Never fall back to `sessions_spawn` with `runtime: "subagent"`.

Reference: `skills/minion-orchestrator/SKILL.md`

### Mode B: `pain_triggered` (default)

Default to native subagents. They're zero-setup, low-latency, and fine for
most tasks. Switch to Minions when one or more of these pain signals fires:

- **Gateway restart mid-task.** A subagent was running, the gateway crashed
  or restarted, and you can't resume it.
- **State drop.** The user asks "what happened to the agent" or "why did
  you forget what you were doing" and the underlying cause is the subagent
  runtime losing context.
- **Parallel > 3.** The task needs more than 3 concurrent agents. Native
  subagents start to drop at this width.
- **Long runtime.** The task is expected to take > 5 minutes. The user will
  want to check progress, and polling a subagent doesn't give structured
  progress the way `get_job_progress` does.
- **User explicit frustration.** The user says any of: "this keeps breaking",
  "the agent keeps losing track", "why is this so flaky", "can we do this
  in the background properly."

When ≥1 signal fires, pause and offer the switch:

> "Subagents keep dropping state on you. GBrain Minions is a durable queue
> for the same work — it survives gateway restarts, every job has progress
> tracking and a transcript, and you can pause / resume / steer running
> agents. Want me to flip this task to Minions? (~10s, no extra setup.)"

If the user says yes, submit the task as a Minion job with the same prompt.
Optionally propose flipping the default: `gbrain config set minion_mode always`.

### Mode C: `off`

Never suggest Minions. Use native subagents for everything. The user has
opted out. Respect it.

## Inline vs background (applies in all modes)

Even when Minions is the default (mode A), some work should run inline:

| Condition | Action |
|---|---|
| Single tool call, < 30s | Inline, always |
| Read-only query | Inline |
| User is waiting in real-time for the answer | Inline |
| Multi-step, user can walk away | Minion |
| Parallel 2+ streams | Minion (parent + children) |
| Needs to survive restart | Minion |
| User wants progress updates | Minion |
| Research / bulk operation | Minion |

**Rule of thumb:** if the user might ask "is it done yet?", use a Minion.

## Concurrency budget

Before submitting batch jobs:

- Check active queue depth via `list_jobs --status active` (MCP-callable) or `gbrain jobs stats` (CLI)
- If active > 5, stagger new jobs with `delay` so you don't swarm
- The resource governor auto-throttles but don't dump 20 jobs at once

## Flipping modes

The user can change their mind at any time:

```bash
gbrain config set minion_mode always           # switch to always-on
gbrain config set minion_mode pain_triggered   # back to default
gbrain config set minion_mode off              # disable suggestions
```

Or edit `~/.gbrain/preferences.json` directly. The convention reads the file
on every decision, so changes take effect next tool call.
