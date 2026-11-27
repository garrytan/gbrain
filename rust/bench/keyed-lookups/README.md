# Keyed-lookups bench

`bench.ts` (corpus and stats in `corpus.ts`, checked by `bench.test.ts`) times one Rust addon on a fresh brain, stage by stage, so two addons (and their TypeScript) can be compared
on the same machine and the same synthetic corpus. Nothing leaves the machine: embeddings come from a deterministic
local function, the reranker and autocut are off, and the brain lives in a temp directory with its own `GBRAIN_HOME`.

Each run imports N pages one at a time (`importFromContent`), runs `extract links --source db`, then 5 warm-up and
2 x Q timed queries through the `query` operation. It prints the machine, the code and addon it ran, the data size, N
and the median of each stage over the runs; `--out` writes every run as JSON. The members the keyed lookups replaced
are timed through a proxy, and when the addon exports `commitProfile` each write stage reports its commits, mean commit
time and mean time in redb's commit call.

```bash
bun run rust:build
bun rust/bench/keyed-lookups/bench.ts --addon rust/target/addon/gbrain_engine.linux-x64-glibc.node \
  --label after --pages 10000 --runs 3 --queries 60 --out /var/tmp/after.json
# The "before" arm: an older checkout's code and addon.
GBRAIN_BENCH_ROOT=/path/to/old/checkout bun rust/bench/keyed-lookups/bench.ts \
  --addon /path/to/old/checkout/rust/target/addon/gbrain_engine.linux-x64-glibc.node --label before ...
```

For sync counts and bytes written per commit, run the same command under
`strace -f -T -e trace=fdatasync,fsync,pwrite64` (timings under strace are not comparable).
