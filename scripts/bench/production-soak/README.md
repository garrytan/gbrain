# Production-shaped scale soak

Opt-in harness that runs gbrain the way a large personal brain runs in
production, for hours, and writes a pass/fail scoreboard. It exists because
50k-300k clean synthetic pages never show the bugs a brain with years of
history, connectors, private pages, held items and concurrent writers shows.
Weekly (and on dispatch) in `.github/workflows/production-soak.yml`; never in the PR tier.

## Pieces

| File | Does |
|---|---|
| `fixture.ts` | Deterministic brain: three git sources built with `git fast-import` (52% / 43% / 5% of `--pages`). The `default` source has years of daily history with bulk imports, edits, moves, culls into `archive/<year>/`, plain deletes and merge commits whose side branches move and delete files; private pages (`visibility: private`, `access:` and `confidentiality:` aliases) with canary tokens; connector pages with facts fences; long meetings; timeline pages with hundreds of entries; megabyte chat archives, two over the 24 MB page limit. Its last `--backlog-days` come after the `import-base` tag and include files gbrain must hold. `source-b` is mostly static with cross-source twins; `source-c` is connector pages rewritten daily. `drift.jsonl` lists database-only pages (never committed) and pages history deleted that the database kept. |
| `load.ts` | Imports each source with gbrain's own classic sync (the default source at `import-base`), writes the drift through the importer, activates managed persistence, runs the first managed sync, settles links and embeds through the loopback mock provider, then fast-forwards the default source so the soak starts with a backlog. |
| `lib.ts` | Topology: Postgres, a session-mode PgBouncer capped at 25 clients (the 26th is refused, the EMAXCONNSESSION shape), a transaction-mode PgBouncer, and toxiproxy latency in front of both. `database_url` is the transaction lane and `GBRAIN_DIRECT_DATABASE_URL` the session lane. |
| `soak.ts` | The production topology for `--hours`: one resident `gbrain serve --http` that owns sync (`sync.on_commit=true`), one `gbrain jobs work`, MCP stdio readers (warm, remote callers), CLI readers (cold), an external writer committing named paths every few minutes, put/remember through CLI and MCP, `extract --stale` and `embed --stale`, and samplers. |
| `scoreboard.ts` | Turns `events.jsonl` into `scoreboard.json` and `scoreboard.md`; `--combine <dir>` merges cells. |
| `stage-probe.ts` | On a loaded brain (`--work` with `ready.json`): one warm stdio `gbrain serve` behind the topology at `--rtt-ms`, the mock embedder and reranker, and `--n` search calls whose `_meta.retrieval.timings` (stage and part medians) are written to `<out>/calls.jsonl` and summarized; `--trace` also records every statement (`GBRAIN_SQL_TRACE`). Where the server stage of a warm search spends its time at scale. |
| `run.sh`, `vm-setup.sh`, `ubicloud.sh` | One cell end to end; VM bootstrap; one Ubicloud VM per latency with an expiring name. |

## Scoreboard

Freshness (commit to keyword-searchable, p50/p95, unresolved commits, the
longest watermark stall and whether holds froze it), search and query p50/p95
cold (CLI) and warm (MCP), put and remember latency and pending writes,
session-lane peak and refusals, holds over time by code, managed import-record
coverage, managed sync jobs that stopped without applying anything and who
owned the commit notifier, doctor red checks, version skew, resident memory,
and the privacy invariant: every remote (MCP) response is scanned for any
private page's canary or search token.

Every gate is `record` mode: computed, printed, never failing a run. Moving a
gate to `block` is a reviewed edit of `GATES` in `scoreboard.ts` after the
captain has seen two consecutive clean weekly soaks on that gate.

## Run it

```bash
# One machine (Docker required), small: about 20 minutes
bash scripts/bench/production-soak/run.sh --pages 20000 --rtt-ms 65 --hours 0.5 --out /tmp/soak-out

# Ubicloud, 600k pages, both latencies in parallel, VMs expire after 14 h
scripts/ubicloud/ubi-runner.sh usage
UBI_OWNER=<thread> scripts/bench/production-soak/ubicloud.sh start --pages 600000 --hours 3 --rtts 65,2
scripts/bench/production-soak/ubicloud.sh status    # tail of each cell's log
scripts/bench/production-soak/ubicloud.sh collect   # copy finished cells back, destroy their VMs, combine
```

`start` launches each cell detached on its VM, so the soak survives this
machine sleeping; `collect` tears a VM down only after its cell finished, and
the expiring VM name lets the reaper clean up a cell nobody collects.
A 600k fixture builds in about 14 minutes on a standard-16 VM.
Everything is keyless: embeddings and rerank go to a loopback mock provider.
A fixture loads once; regenerate it for another load.
