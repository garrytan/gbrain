# Plugin handlers — registering host-specific Minion handlers

GBrain's Minion worker ships with seven built-in handlers: `sync`,
`embed`, `lint`, `import`, `extract`, `backlinks`, `autopilot-cycle`.
These cover every background operation the gbrain CLI itself performs.

Host platforms (OpenClaw deployments, future hosts) register their own
handlers via a plugin bootstrap that imports
`gbrain/minions`. No `handlers.json`-style data file — handlers are
code, loaded by the worker, with the same trust model as any other
code in the host's repo.

## Why code, not data

An earlier design draft shipped `~/.claude/gbrain-handlers.json` where
each entry was a shell command the worker would exec on job claim.
Codex flagged this as a durable RCE surface: an agent-writable data
file that spawns arbitrary shell. We dropped the data-file approach;
handlers are code that the host imports explicitly and ships through
code review.

## The plugin contract

A host worker bootstrap looks like this (TypeScript):

```ts
import { MinionQueue, MinionWorker } from 'gbrain/minions';
import type { BrainEngine } from 'gbrain/engine';

async function main() {
  const engine: BrainEngine = /* your engine setup */;
  await engine.connect({});

  const worker = new MinionWorker(engine, { queue: 'default' });

  // Register every host-specific handler the host's cron manifest references.
  // Each handler returns a plain object (serialized as the job result).
  // Throw on failure — the worker catches and retries per max_attempts.

  worker.register('ea-inbox-sweep', async (ctx) => {
    const slot = ctx.data.slot ?? new Date().toISOString();
    // Host-specific agent turn: call your LLM, scan the inbox, write
    // brain pages, return a summary. ctx.signal.aborted indicates the
    // worker wants you to cooperate with shutdown — honor it.
    return { swept: true, slot };
  });

  worker.register('morning-briefing', async (ctx) => {
    /* host logic */
    return { briefed: true };
  });

  // Call start() AFTER every handler is registered. The worker's
  // stall-detector ignores jobs whose name is not in the registered set.
  await worker.start();
}

main().catch(err => { console.error(err); process.exit(1); });
```

Ship this as a separate binary in the host repo (e.g. `your-openclaw-worker`)
or as a side-effect module that the stock `gbrain jobs work` command
auto-loads on startup (configurable via a host-provided entry point).

## Handler contract

Every handler receives a `MinionJobContext`:

```ts
interface MinionJobContext {
  data: Record<string, unknown>;   // job params (whatever the cron submit passed)
  job: MinionJob;                   // full job row (id, queue, attempts, etc.)
  signal: AbortSignal;              // set to aborted when the worker is shutting down
  inbox: MinionInbox;               // read messages sent to this job while it runs
}
```

Return a serializable object on success. Throw on failure (the worker
will log + retry per `max_attempts`).

**Abort cooperation.** When `ctx.signal.aborted` becomes true, finish
gracefully. The worker will wait 30s for you to return before SIGKILL.
Long-running LLM calls should pass the signal through to whatever
network library they use.

**Idempotency.** The queue enforces unique `idempotency_key` at the DB
layer, so you don't need to worry about double-submits from a cron that
fires while the previous invocation is still running.

## Gbrain's migration flow

The v0.11.0 migration orchestrator (run by `gbrain apply-migrations`)
detects cron entries whose handler name is NOT in GBrain's builtin set
and emits a structured TODO to `~/.gbrain/migrations/pending-host-work.jsonl`.
Each TODO has shape:

```json
{
  "type": "cron-handler-needs-host-registration",
  "handler": "ea-inbox-sweep",
  "cron_schedule": "0 */30 * * *",
  "manifest_path": "/path/to/cron/jobs.json",
  "current_cmd": "agentTurn ea-inbox-sweep",
  "recommendation": "Add a handler registration for `ea-inbox-sweep` in your host worker bootstrap per docs/guides/plugin-handlers.md. Once registered, re-run `gbrain apply-migrations` to auto-rewrite this entry.",
  "status": "pending"
}
```

The host agent walks these entries using `skills/migrations/v0.11.0.md`:

1. Read `~/.gbrain/migrations/pending-host-work.jsonl`.
2. For each `cron-handler-needs-host-registration` row, ship a handler
   registration in the host's worker bootstrap following the pattern
   above.
3. Deploy the updated worker.
4. Re-run `gbrain apply-migrations --yes`. The orchestrator now
   recognizes the newly-registerable handler (worker writes the
   registered names to a discovery file on startup) and rewrites the
   cron entry to use `gbrain jobs submit`. The JSONL row is marked
   `status: "complete"`.

## Trust boundary

Handler code runs inside the worker process with the same privileges
as the rest of the host binary. There is no elevation. But there is
also no runtime sandbox — handlers can read + write anywhere the
worker user can. Review handler PRs the same way you review any other
code that touches production data.

## Related

- `skills/conventions/cron-via-minions.md` — the rewrite convention
  for cron manifests.
- `skills/migrations/v0.11.0.md` — how the migration orchestrator
  drives the host agent through this work.
- `skills/minion-orchestrator/SKILL.md` — patterns for submitting,
  monitoring, steering, and replaying jobs once the handler is live.
