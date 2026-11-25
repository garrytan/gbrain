# Keyed-lookups bench: results (2026-11-24)

- Machine: Intel Xeon 6975P-C, 8 vCPU, 30.8 GB, Linux 7.0.0-1014-aws (Vorflux VM, network disk, about 2-3 ms per
  `fdatasync`). Both arms ran on the same machine, one at a time.
- Before: rust-engine/main 3e79ea5896 plus only the `commitProfile` timing counters (no behavior change).
- After: rust-engine/keyed-lookups 007885041c (this change merged with rust-engine/main a59ee3ca58, so the after arm
  also carries 306 trunk commits; the before arm is the change's base).
- Data: the bench's synthetic corpus (companies, people with typed relation lines and dated timelines, notes with
  wikilinks), 300 and 10,000 pages; deterministic local embeddings, reranker and autocut off.
- N = 3 runs per arm and size; each number is the median of the 3 runs. Queries: 120 timed per run, after 5 warm-ups.

| Stage | 300 before | 300 after | 10k before | 10k after |
|---|---|---|---|---|
| Query p50 (ms) | 15.7 | 12.3 | 336.8 | 195.4 |
| Query p95 (ms) | 18.5 | 15.0 | 366.1 | 234.3 |
| The 5 helpers per query (ms) | 6.9 | 1.7 | 186.6 | 2.6 |
| Import, page p50 (ms) | 19.7 | 20.6 | 45.3 | 47.0 |
| Import, page p95 (ms) | 26.0 | 26.8 | 58.7 | 60.7 |
| `findDuplicatePage` per page (ms) | 0.53 | 0.07 | 12.2 | 0.08 |
| Import commit per page (ms) | 11.5 | 12.3 | 26.7 | 40.5 |
| Link extraction per 10k pages (s) | 73.6 | 8.7 | 133.1 | 9.4 |
| Link extraction commits | 738 | 3 | 24,600 | 100 |

The 5 helpers are `cosinesByChunkIds`, `findPagesByTitles`, `listPagesTitledIn`, `readProjectionReadiness` and
`hasSupersedeEdges`. Row counts were equal in both arms (300: 435 chunks, 997 links; 10k: 14,500 chunks, 33,250
links; 1,200 query hits per run).

## Durable syncs (strace, 300-page import plus link extraction, one run)

| | fdatasync | fsync | pwrite64 bytes |
|---|---|---|---|
| Before | 1,060 | 2 | 128.2 MB |
| After | 325 | 2 | 105.7 MB |

Every acknowledged write is still synced before its call returns: the batch commits once, with one `fdatasync`,
before `replaceDerivedLinksBatch` resolves.

## The import commit

All of the commit time is redb's own commit call (`commitProfile.redb_commit_ns`; the sequence bump around it is under
0.01 ms). Under strace on the 10k import, the bytes written per commit grow with the brain (before: 284 KB per commit
for pages 1-1,000, 838 KB for pages 4,500-5,500, in about 76 and 200 `pwrite64` calls), and so does the time of the one
`fdatasync` per commit. The keyed lookups add about 4% bytes per commit but 13.8 ms to the median commit at 10k; why the
sync time grows faster than the bytes is not explained by these numbers, so the commit is reported, not changed.

A format-8 brain of 10,000 pages (14,500 chunks, 33,250 links) upgrades to format 9 on its first open in 169 ms; the
next open takes 3 ms.

## Store format 12: `listPages` by update time (2026-11-25)

Engine-bench `--dev` at 10,000 pages on the same Linux machine, one run per arm (300 samples per core op), PGLite
against the Rust engine. Before: 3e149c4d29ec (format 9). After: 378649209d, which has the same `listPages` walk as
the format-12 head.

| `list_pages` (limit 50) | PGLite | Rust before | Rust after |
|---|---|---|---|
| p50 / p95 | 1.7 / 1.9 ms | 34.6 / 37.4 ms | 1.4 / 1.7 ms |

A format-9 brain of 10,000 pages (14,500 chunks, 33,250 links) made by the 3e149c4d29ec build upgrades to format 12
on its first writable open in 285 ms; the next open takes 3 ms. The 3e149c4d29ec addon then refuses the brain:
"store format 12, newer than the formats this build opens".
