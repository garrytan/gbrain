# Refactor wave 1: new-guard wall times and verify growth (O15 / C27)

Measured 2026-09-30 on a 4-vCPU Capy cloud machine (Ubuntu 24.04, Bun 1.3.14),
`GBRAIN_VERIFY_MAX_PARALLEL` unset (pool = 4, the CI runner size). Base is the
wave's merge-base with master, `f8d1e3936` (the plan baseline). Branch is
`refactor/wave-1-w7` at `fdee810`: the collector at `98c1558` (every lane
except W1-extended) plus the W7 docs, porting kit and retired-phrase guard.
Rerun after W1-extended lands; its domains add engine-sql files but no new
guard.

Budgets from the plan: each new guard under 15 s, and `bun run verify` grows by
less than 20%.

## Method

- **Standalone:** `bun run <check>` three times back to back on a warm tree;
  milliseconds from `date +%s%N`, reported as min / median / max.
- **Under the verify pool:** `GBRAIN_VERIFY_LOG_DIR=<dir> bash
  scripts/run-verify-parallel.sh`, three runs per side, alternating base and
  branch. A check's wall time is its log file's birth time (the runner opens
  the log when the check starts) to the mtime of its `.exit` sentinel (written
  when it ends), in whole seconds. This is contended time, so it includes
  waiting for CPU next to `typecheck`.
- **Total:** the runner's own `[verify-parallel] elapsed=` line, which starts
  after the PGLite snapshot check and ends when the last check finishes.

## New guards

| Guard (`bun run ...`) | Standalone ms (min / median / max) | In verify pool, s (runs 1-3) | Under 15 s |
|---|---|---|---|
| `check:function-size` | 2171 / 2221 / 2224 | 3 / 3 / 3 | yes |
| `check:engine-sql-ratchet` | 308 / 311 / 382 | 0 / 0 / 0 | yes |
| `check:engine-sql-dynamic` | 259 / 266 / 293 | 0 / 0 / 0 | yes |
| `check:engine-sql-brands` | 630 / 651 / 680 | 1 / 1 / 1 | yes |
| `check:layering` | 266 / 272 / 286 | 1 / 0 / 0 | yes |
| `check:schema-migrations` | 280 / 286 / 288 | 0 / 0 / 1 | yes |
| `check:schema-fresh` | 116 / 118 / 121 | 0 / 0 / 0 | yes |
| `check:schema-migration-order` | 300 / 324 / 395 | 0 / 0 / 0 | yes |
| `check:sync-run-state` | 276 / 286 / 293 | 1 / 1 / 0 | yes |
| `check:retired-phrases` | 271 / 317 / 323 | 0 / 0 / 0 | yes |

Together the ten new checks cost about 5 s of standalone time, 2.2 s of it the
function-size ratchet, which parses every `src/**/*.ts` with the TypeScript
compiler API.

## Existing checks the wave made heavier

| Check | Base standalone | Branch standalone (median) | Base / branch in pool, s |
|---|---|---|---|
| `check:guard-self-test` | 1.36 s (8 self-tested guards) | 10.08 s (21 self-tested guards) | 1 / 10 |
| `check:module-size` | 6.8 s | 8.3 s | 4 / 6 |

The self-test harness grew because every new or re-pointed scanner now proves
it can fail: the six TypeScript guards run one Bun process per fixture tree
(`check-engine-sql-brands.ts` alone has six bad trees plus a good one), and the
path-consumer re-points added `bad-<dir>` trees for the new module directories
to seven shell guards. The retired-phrase guard's seven trees take 0.28 s. The
harness enforces its own 30 s budget and prints its time on every run.

## Total `bun run verify`

| Side | Checks | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| Base `f8d1e3936` | 56 | 44 s (cold `tsc`) | 24 s | 23 s |
| Branch `fdee810` | 66 | 26 s | 25 s | 26 s |

Warm to warm, verify goes from about 24 s to about 26 s, roughly +8%, inside the
20% budget. The first branch run in a fresh checkout took 47 s for the same
cold-`tsc` reason as base run 1. The makespan stays close to base because the
pool is bound by `typecheck` (11 to 12 s contended) and the heavy block; the
new guards are sub-second except the function-size ratchet, and the larger
self-test runs in parallel with `typecheck`.

## Reproduce

```bash
for c in check:function-size check:engine-sql-ratchet check:engine-sql-dynamic check:engine-sql-brands \
         check:layering check:schema-migrations check:schema-fresh check:schema-migration-order \
         check:sync-run-state check:retired-phrases check:guard-self-test check:module-size; do
  for i in 1 2 3; do s=$(date +%s%N); bun run "$c" >/dev/null 2>&1; e=$(date +%s%N); echo "$c $(( (e-s)/1000000 ))ms"; done
done
GBRAIN_VERIFY_LOG_DIR=/tmp/vlog bash scripts/run-verify-parallel.sh
for f in /tmp/vlog/*.log; do echo "$(( $(stat -c %Y "${f%.log}.exit") - $(stat -c %W "$f") ))s $(basename "${f%.log}")"; done | sort -rn
```

Base side: `git worktree add <dir> f8d1e3936 && (cd <dir> && bun install)`, then
the same `run-verify-parallel.sh` command there.
