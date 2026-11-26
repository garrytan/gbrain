# gbrain-concurrency-bench: many writers on one Rust brain

This crate measures what happens when N writers (1, 4, 16, 64 threads) write one brain at the same
time. It reports throughput, p50/p99 latency, and the error and conflict counts. The write-up and
the measured numbers are in `docs/research/rust-concurrency.md`.

It is its own Cargo workspace (see the `[workspace]` table in `Cargo.toml`), like `../bench`, and
is not part of `rust/Cargo.toml`.

## Two binaries

- `store-bench` (`src/main.rs`) drives the real `gbrain-store` crate. One operation is one
  put-shaped write as an agent makes it: `submit_page_mutation` (about 2 KB of page body, one
  principal per writer, a unique request id), then `upsert_chunks` (4 chunks of about 1 KB), then
  `add_links_batch` (3 links). That is three store commits per operation. Two workloads:
  `disjoint` (each writer has its own 16 pages and link targets) and `hot` (every writer writes
  the same page). All pages are seeded before the clock starts.
- `rawkv-bench` (`src/rawkv.rs`, feature `raw`) drives the key-value stores directly through the
  bake-off crate (`../bench`). One transaction reads a page and a counter and writes the page, a
  version, the counter, a journal entry, 4 chunks and 3 links (about 10 KB). It compares a
  serialized writer, sharded redb files and the bake-off's optimistic layer, on redb, LMDB and
  fjall.

## Run

```bash
cargo build --release --features raw
# Today's store (one writer at a time) and the optimistic store (concurrent_writes on):
./target/release/store-bench --secs 5 > store-today.jsonl
./target/release/store-bench --concurrent --secs 5 > store-proto.jsonl
./target/release/rawkv-bench --secs 3 > raw.jsonl
```

Flags: `--writers 1,4,16,64`, `--secs N`, `--workloads disjoint,hot`, `--dir DIR` (default
`/var/tmp/gbrain-cbench` for `store-bench` and `/var/tmp/gbrain-rawkv` for `rawkv-bench`; the
bench deletes and recreates its own subdirectories there), and for `rawkv-bench`
`--modes serial/redb,occ/fjall,...`. Each line of output is one JSON result.

`--fjall` (build with `--features fjall`) keeps the brain's records in a fjall database instead
of the redb file, under the same store code; with `--concurrent` the optimistic layer runs on it.

`--concurrent` opens each brain with `concurrent_writes` and adds the conflict counters
(`Store::occ_stats`) to the output. Numbers depend on the disk's fsync latency, so compare runs from
the same machine only.
