# Cron via Minions Convention

How cron-scheduled agent work is dispatched in a GBrain-backed install.

## Rule: scheduled work runs as Minion jobs, not `agentTurn`

When a cron fires, it should submit a Minion job. Not call OpenClaw's
native `agentTurn` (300s timeout, no durability, no transcript). Not
start an isolated session that races the gateway for resources.

```
# Bad: agentTurn with a fixed timeout, no durability.
{ "schedule": "*/30 * * * *", "kind": "agentTurn", "skill": "ea-inbox-sweep" }

# Good (Postgres): fire-and-forget submit with an idempotency key per
# cycle slot. The queue dedupes long-running overlaps at the DB layer.
{
  "schedule": "*/30 * * * *",
  "kind": "shell",
  "cmd": "gbrain jobs submit ea-inbox-sweep --params '{\"slot\":\"$(date -u +%Y-%m-%dT%H:%M)\"}' --idempotency-key ea-inbox-sweep:$(date -u +%Y-%m-%dT%H:%M)"
}

# Good (PGLite): inline execution with --follow. PGLite's exclusive file
# lock blocks a separate worker daemon, so the cron runs the job directly.
{
  "schedule": "*/30 * * * *",
  "kind": "shell",
  "cmd": "gbrain jobs submit ea-inbox-sweep --params '{}' --follow"
}
```

## Why

- **Durability.** Gateway restart mid-task? Worker picks the job up on
  boot. No lost state.
- **Observability.** `gbrain jobs list` + `gbrain jobs get <id>` show
  every run, its duration, its transcript, its token accounting.
- **Steering.** Running jobs accept inbox messages. "Skip the
  newsletter thread, focus on the urgent DMs" lands as context on the
  next iteration.
- **Concurrency safety.** Idempotency-key on the cycle slot means a cron
  that fires during a still-running previous invocation produces a noop
  at the queue layer. Without this, a 5-min cron running 8-min jobs
  stacks 4 overlapping copies at steady state.

## Who registers the handler?

**GBrain only rewrites cron entries whose handler name matches a
gbrain builtin** (`sync`, `embed`, `lint`, `import`, `extract`,
`backlinks`, `autopilot-cycle`). For host-specific handlers
(`ea-inbox-sweep`, `morning-briefing`, whatever your deployment runs
on cron), the host platform ships the handler as code.

See `docs/guides/plugin-handlers.md` for the plugin contract. In short:

```ts
import { MinionQueue, MinionWorker } from 'gbrain/minions';

const worker = new MinionWorker(engine, { queue: 'default' });
worker.register('ea-inbox-sweep', async (ctx) => {
  // Host-specific agent turn. Call whatever LLM + tools the host has.
  // ctx.data contains the cron slot payload; return a result object.
});
await worker.start();
```

Ship the bootstrap in the host repo. Autopilot spawns the worker as a
child; the host's custom worker binary (or a side-effect module the
stock worker auto-loads on startup) registers handlers before `start()`.

## Off mode

Users who set `minion_mode: off` in `~/.gbrain/preferences.json` keep
using `agentTurn`. Respect that. No auto-rewrite.

## Forward note (v0.12.0)

GBrain v0.12.0 ships `gbrain cron`: a scheduler loop inside
`gbrain jobs work` that owns cron expressions natively — no more
handing off to host schedulers. Until v0.12.0 lands, the host
scheduler keeps firing on schedule; v0.11.1 only replaces the execution
layer (what the cron trigger *does*), not the scheduling layer.

## Related

- `skills/conventions/subagent-routing.md` — native subagents vs
  Minions for ad-hoc (not cron-scheduled) work.
- `skills/minion-orchestrator/SKILL.md` — patterns for managing jobs
  once they're in the queue.
- `skills/cron-scheduler/SKILL.md` — scheduling guidance (quiet hours,
  staggering, idempotency). Now references this convention.
- `skills/migrations/v0.11.0.md` — how GBrain migrates an existing host
  cron manifest to this convention.
