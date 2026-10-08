# Automatic facts drain (PGLite)

**Say to your agent:** *"Are my notes being turned into facts automatically?"*

**Say to your agent:** *"Turn off automatic fact extraction."*

**Say to your agent:** *"Why are pages waiting for fact extraction?"*

Every eligible page write (`put_page`, capture, sync) queues one `facts-absorb`
job that extracts the page's facts with a chat model. A Postgres brain runs
those jobs on its job worker (`gbrain jobs supervisor`). A PGLite brain has no
background worker, so gbrain runs them inside the processes that already own
the brain:

- a resident `gbrain serve` (stdio, the recommended PGLite lifecycle);
- `gbrain serve --http`;
- the dream/autopilot cycle, as the `facts_drain` phase.

No command is needed. This is **on by default**. Each extracted page is one
paid chat call to the configured facts model (`facts.extraction_model`). Unset,
that is `anthropic:claude-haiku-5-5` when the reasoning tier resolves through
Anthropic, and the reasoning tier's default otherwise (`gbrain models` shows
which); `gbrain config set facts.extraction_model <provider:model>` picks
another.

To turn it off:

```bash
gbrain config set facts.extraction_enabled false
```

That key is the brain-wide facts-extraction switch, so it also stops the
write-time extraction that queues the jobs.

## When it runs

`gbrain serve` (stdio and `--http`) checks every 10 minutes on its own timer.
Stdio serve runs a drain on a check that saw no MCP traffic since the previous
one, and at least every 30 minutes under sustained traffic, so a page written
to a quiet serve is extracted within about 20 minutes. `serve --http` runs a
drain on every check. A check that falls while a delegated sync owns the
serve is skipped, so the 30-minute bound does not hold during an uninterrupted
delegated sync. The cycle phase runs once per cycle. Each run takes one job at
a time with a short pause between jobs, so foreground MCP calls interleave
with it.

On shutdown the in-flight job is stopped and returned to the queue without
counting an attempt.

## Spend caps

| Key | Default | Bounds |
|---|---|---|
| `facts.drain_budget_usd` | `1.00` | priced spend of one run |
| `facts.drain_daily_budget_usd` | `5.00` | priced spend of all runs in the last 24 hours |
| `facts.drain_max_jobs` | `50` | jobs one run takes |

Before each job the drain checks that the job's worst case (the page text, at
most 8,000 characters, plus the output-token cap) fits the remaining run and
daily budget; it stops the run otherwise. The first run on a brain prints the
queued page count, the estimated spend, the caps and the opt-out command, on
stderr and as a `facts_drain_first_run` notice on the next MCP call:

```
[gbrain notice facts_drain] Automatic fact extraction is on: 12 queued page(s), about $0.01 with anthropic:claude-haiku-5-5, at most $1.00 per run and $5.00 per day. To opt out: gbrain config set facts.extraction_enabled false
```

A model with no known price runs under the default caps with a warning. Once
you set either spend cap, an unpriced model refuses instead, and the fix tells
the agent to look up the model's rate and register it with `gbrain pricing set`.

## Deferrals

The drain never drops work. Every stop other than an empty queue leaves the
remaining jobs queued with no attempt counted, records the reason, and raises
one `facts_drain_deferred` notice per reason per process:

| Reason | Meaning | Next step |
|---|---|---|
| `no_key` | No chat provider key (OpenAI or Anthropic) | The user adds a key; `gbrain providers list` shows what each provider needs |
| `extraction_unavailable` | The facts model's provider is not configured | Point `facts.extraction_model` at a model with a key |
| `budget_exhausted` | The per-run cap was reached | Nothing (the next run continues), or raise `facts.drain_budget_usd` after asking the user |
| `daily_budget_exhausted` | The 24-hour cap was reached | Nothing (budget frees as the window moves), or raise `facts.drain_daily_budget_usd` |
| `job_over_budget` | One job's worst case is above the per-run cap | Raise `facts.drain_budget_usd` |
| `no_pricing` | Unpriced model under a cap you set | Register the rate with `gbrain pricing set` |
| `provider_halted` | The provider refused calls (auth, billing, rate limit) | Wait for the cooldown, or fix the key |

A keyless brain stays silent while nothing is queued. A worker that runs a
`facts-absorb` job without a key (for example a keyless `gbrain jobs work` on
Postgres) also returns it to the queue for 30 minutes instead of completing it
empty, so the backlog is extracted once a key exists.

## Status

```bash
gbrain doctor --only facts_drain --json
```

The `facts_drain` check reports whether extraction is on, the queued backlog,
the last run (owner, outcome, pages extracted, spend), the 24-hour spend, and
the last deferral with its fix. It warns when jobs wait on a deferral, or when
jobs are queued and no drain ran in the last 45 minutes (no serve or cycle owns
the brain); the fix then is `gbrain dream --phase facts_drain`. The same status
is the `facts_drain` entry of the MCP readiness resource
(`gbrain://capabilities`).
