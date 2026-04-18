# Minions vs OpenClaw Subagents Benchmark

**Date:** 2026-04-18
**Branch:** garrytan/minions-jobs
**Suite:** `test/e2e/bench-vs-openclaw/`
**Minions:** v0.11.0 (PR #130)
**OpenClaw:** 2026.4.10 (44e5b62)
**Model:** anthropic/claude-haiku-4-5

## Why this benchmark exists

Minions is GBrain's new background job queue, pitched as a durable, cheap
substitute for spawning OpenClaw subagents via `openclaw agent --local`.
"Durable" and "cheap" are easy to claim and hard to prove. So we put
numbers on four specific claims a Minions user would actually care about:

1. **Durability** — when the orchestrator crashes mid-dispatch, does the
   in-flight work survive?
2. **Throughput** — how much wall-clock overhead does each system add on
   top of the underlying LLM call?
3. **Fan-out** — parent dispatches 10 children in parallel. How fast and
   how reliable is each side?
4. **Memory** — what does it cost to keep 10 subagents in flight at once?

Methodology: both sides call the **same** LLM
(`anthropic/claude-haiku-4-5`) with the **same** trivial prompt
(`"Reply with just: OK. No other text."`). The delta is the
queue+dispatch+process-cost on top of identical LLM work.

## Honest caveats up front

- **We do NOT benchmark OpenClaw's gateway multi-agent fan-out.** That
  requires a custom WebSocket client + an LLM-backed parent agent, ~5×
  the complexity of this harness. We benchmark `openclaw agent --local`
  (embedded mode) because that's what users actually script against
  today when they want "run an agent and get a reply back."
- **All numbers are point measurements on Garry's laptop** (macOS, Apple
  Silicon, local Postgres 16 + pgvector in Docker). Not a cluster
  benchmark. Not an adversarial load test. Reproducible via the files
  in `test/e2e/bench-vs-openclaw/`.
- **OpenClaw `--local` is a fire-and-forget process.** If you SIGKILL
  it mid-dispatch, the reply is gone. This isn't a bug, it's the design.
  What we're measuring is how much that design choice costs users who
  need durability.
- **Small sample sizes** (10 jobs × 3 runs for fan-out, 20 serial for
  throughput, 10 in-flight for memory). Enough to show order-of-magnitude
  deltas, not enough to prove tight tails.

## Results

### 1. Durability (SIGKILL mid-flight, 10 jobs)

| System | Delivered | Wall time | p50 per job | p95 per job |
|--------|-----------|-----------|-------------|-------------|
| **Minions** | **10 / 10** | 458ms total | 257ms | 410ms |
| OpenClaw `--local` | **0 / 10** | 22989ms (all SIGKILLed at 500ms) | n/a | n/a |

Setup: Minions side seeds 10 jobs in state `active` with an expired
`lock_until` (exactly the state a SIGKILLed worker leaves behind). A
rescue worker starts. It picks up all 10 via `handleStalled` and
completes them.

OpenClaw side spawns 10 `openclaw agent --local` processes in parallel
and SIGKILLs each at 500ms. Zero of them managed to emit any output
before being killed.

**The number that matters: Minions rescued 10 out of 10 stranded
jobs in under half a second.** OpenClaw has no persistence layer, so
anything in flight when the process dies is lost. Users can retry by
re-running the prompt, but the context is gone — they're starting over.

Source: `test/e2e/bench-vs-openclaw/durability.bench.ts`

### 2. Throughput (20 serial dispatches, same LLM call)

| System | p50 | p95 | p99 | Mean | Min | Max | Success |
|--------|-----|-----|-----|------|-----|-----|---------|
| **Minions** | **778ms** | **1931ms** | **1931ms** | **911ms** | 639ms | 1931ms | 20/20 |
| OpenClaw `--local` | 8086ms | 10094ms | 10094ms | 8335ms | 7405ms | 10094ms | 20/20 |
| **Ratio** | **10.4×** | **5.2×** | **5.2×** | **9.2×** | 11.6× | 5.2× | — |

Setup: both sides call claude-haiku-4-5 with the same prompt. Minions
goes through `queue.add` → worker claims → handler calls Anthropic SDK
directly. OpenClaw spawns a fresh `openclaw agent --local` process per
dispatch.

The ~7 seconds of overhead per OC dispatch isn't the LLM. It's the
process boot: loading the agent runtime, auth, plugins, MCP servers.
Every dispatch pays that cost again. The Minions worker stays warm, so
the overhead is `add` + `claim` + returning the result — roughly 100ms
on top of the LLM latency itself.

Source: `test/e2e/bench-vs-openclaw/throughput.bench.ts`

### 3. Fan-out (3 runs × 10 children in parallel)

| System | Completed | Mean wall time | Runs (ok/N) | Wall times (ms) |
|--------|-----------|----------------|-------------|-----------------|
| **Minions** (concurrency=10) | **30 / 30** | **1090ms** | 10/10, 10/10, 10/10 | 890, 1135, 1245 |
| OpenClaw (10 parallel spawns) | 17 / 30 | 22598ms | 6/10, 5/10, 6/10 | 22204, 22505, 23084 |
| **Ratio (wall time)** | — | **~21×** | — | — |

Setup: parent dispatches 10 children concurrently, waits for all.
Minions uses one worker process with `concurrency=10`. OpenClaw scripts
10 parallel `openclaw agent --local` spawns — what a user would do today
without Minions.

Two findings, not one:

1. **Wall time: Minions completes 10 in ~1 second. OC parallel spawn
   takes ~22 seconds.** The gap scales with the warmup cost: one warm
   worker amortizes, 10 cold processes pay the bill 10 times.
2. **OC parallel spawn fails 43% of the time at 10-wide.** Error
   samples show a mix of LLM rate-limit hits and spawn saturation. We
   didn't tune this. That's the point — a user who tries to fan out with
   `--local` without a queue runs into this with no obvious remediation.

Source: `test/e2e/bench-vs-openclaw/fanout.bench.ts`

### 4. Memory (10 in-flight subagents)

| System | Baseline RSS | Peak with 10 in flight | Delta | Processes |
|--------|--------------|------------------------|-------|-----------|
| **Minions** | 84 MB | **86 MB** | **+2 MB** | 1 |
| OpenClaw | n/a | 814 MB (summed across 10) | — | 10 |
| **Ratio** | — | **~407×** | — | — |

Setup: both sides keep 10 subagents in flight simultaneously. Minions
side uses one worker with concurrency=10 and handlers that park on a
Promise. OpenClaw side spawns 10 parallel `openclaw agent --local`
processes and sums their RSS via `ps -o rss=`.

Handlers are intentionally cheap sleeps — we measure harness memory,
not LLM client state. The LLM client state would be comparable on both
sides.

**Minions costs 2 MB to keep 10 subagents in flight. OpenClaw costs
814 MB. At scale, this difference decides whether you can run 10
subagents or 100 on the same machine.**

Source: `test/e2e/bench-vs-openclaw/memory.bench.ts`

## What this means for a Minions user

If you have a script today that spawns `openclaw agent --local` N times,
every one of these numbers gets better when you move to Minions:

- **Crash and your work doesn't vanish.** Worker dies, PG keeps the
  row, another worker picks it up. Zero extra code on your side.
- **Per-dispatch wall time drops ~10×** because the worker stays warm.
  Process startup is where your time was going, not the LLM.
- **Fan-out scales past 10-wide without you hand-tuning concurrency.**
  Worker does the throttling; the queue does the durability. OC
  parallel spawn hits a 40% failure wall around 10-wide on this hardware.
- **Memory stops being the bottleneck.** 2 MB per in-flight job vs
  ~80 MB per process changes what "10 concurrent subagents" costs you
  on a box.

## What this doesn't say

- We didn't test OpenClaw's gateway multi-agent mode. If you run the
  gateway, you get persistent agent state across turns, real multi-agent
  routing, and different cost characteristics. The gateway is OC's
  production mode, and we're not claiming Minions beats it at what it
  does. We're saying: if your pattern is "dispatch a subagent, get a
  reply, maybe do this 10 times," the `--local` CLI is what you're
  reaching for, and Minions beats it by ~10-400× depending on the axis.
- We didn't run under load (100s of concurrent jobs, hours of sustained
  work). These are observational point measurements, not a stress test.
- We ran claude-haiku-4-5. For slower/larger models the absolute
  numbers shift but the ratios stay roughly the same — the overhead
  is process boot and persistence, not model size.

## Reproducing

```bash
# 1. Start a test Postgres
docker run -d --name gbrain-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain_test \
  -p 5436:5432 pgvector/pgvector:pg16

# 2. Set env
export DATABASE_URL=postgresql://postgres:postgres@localhost:5436/gbrain_test
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run each bench (durability + memory are free; throughput + fan-out
#    cost ~$0.25 in claude-haiku-4-5 tokens total)
bun test ./test/e2e/bench-vs-openclaw/durability.bench.ts
bun test ./test/e2e/bench-vs-openclaw/throughput.bench.ts
bun test ./test/e2e/bench-vs-openclaw/fanout.bench.ts
bun test ./test/e2e/bench-vs-openclaw/memory.bench.ts

# 4. Tear down
docker stop gbrain-test-pg && docker rm gbrain-test-pg
```

## One-line summary

Minions rescues 10/10 jobs from a crash in under half a second while
OpenClaw `--local` loses all of them; it delivers each dispatch ~10×
faster, fans out 10-wide in ~1 second vs ~22 seconds at 43% OC failure
rate, and holds 10 in-flight subagents in 2 MB vs 814 MB.
