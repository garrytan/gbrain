# Rust outside the storage engine: measured results (prototype branch, 2026-11-25)

Research only. Nothing here changes master. Base: master `897e1120d1`. Branch:
`rust-outside-engine/mention-scanner`.

## TL;DR

We learned that no hot path outside the engine is big enough to be worth Rust today. The Rust
mention scanner is 4.1 times faster than TypeScript, gives byte-identical output and adds 241 KB
to the addon. But the scanner is only 4.1% of gbrain's CPU in the mention pass on Postgres and 1.3%
on PGLite, so it would save about 3% of the pass on Postgres and about 1% on PGLite. The two
biggest wins we found are plain TypeScript fixes: `maskRanges` in link extraction (14 times
faster, identical output) and a one-pass `tokenizeForScan` (1.6 times faster, identical tokens).

You should make those two TypeScript fixes, keep the Rust scanner on this branch, and port it only
if shadow mode shows the mention pass is slow on a real brain (ruling A1 still holds). Leave sync
preparation for the Rust write path when Rust supports managed mode. Drop markdown parse,
chunking, hashing and embedding preparation as Rust candidates.

The case not on the table yet: the Rust addon reaches only Rust-engine users. Installs never
download it (plan decision D4), so any Rust function outside the engine needs a TypeScript twin
for every PGLite and Postgres user, kept in parity forever, or it helps only Rust brains.

## Ranked candidates (measured share of gbrain-process CPU)

| # | Candidate | Postgres share | PGLite share | Prototyped | Recommendation |
|---|---|---:|---:|---|---|
| 1 | Link and timeline extraction (`link-extraction.ts`) | 12.6% of the mention pass; 4.4% of a 1,000-file sync | 2.4%; 0.8% | no: its largest piece is a TypeScript fix | TypeScript fix now (`maskRanges`); drop Rust |
| 2 | Sync preparation (`src/core/persistence/`) | 19.1% of a 1,000-file sync | 5.9% | no: no single hot function | wait: fold into the Rust write path with managed mode |
| 3 | Mention scanner (`findMentionedEntities`) | 4.1% of the mention pass; 0.2% of a sync | 1.3%; 0.1% | yes | wait (A1): TypeScript tokenizer fix first |
| 4 | Markdown and frontmatter parse | 3.9% of a sync (`parseMarkdown`, 492 ms) | 1.1% | no | drop |
| 5 | Chunking and token estimate | 3.4% of a sync (tiktoken WASM plus a memo) | 0.9% | no | drop |
| 6 | Write digests (`digest.ts`: canonical JSON plus SHA-256) | 1.9% of a sync (239 ms) | under 1% | no | drop: SHA-256 is already native, and the JSON must be built from JS objects either way |
| 7 | Embedding preparation | not measurable on a keyless brain; 0.17 ms per page cached (Vega) | | no | drop: the real cost is the provider network call |

Share is the share of sampled CPU in the gbrain process (Bun `--cpu-prof`, each sample charged to
the nearest gbrain or package frame). On PGLite the PGLite package itself was 87% of the mention pass
and 79% of the sync. On Postgres the database server used more CPU than gbrain: 36.0 s against
18.1 s in the mention pass, 16.6 s against 15.4 s in the sync.

## Prototype: Rust mention scanner

`rust/crates/gbrain-text` (pure Rust, 611 lines with tests), exposed as `MentionScanner` in
`gbrain-napi` (63 lines). It scans UTF-16 code units so offsets match JavaScript. TypeScript still
runs `stripCodeBlocks` (25 ms of the total) and rebuilds the `Mention` objects; both are counted in
the Rust numbers below.

Corpus: 10,000 pages (2,000 people, 1,000 companies, 7,000 notes), 21.5 million characters, a
3,000-name gazetteer, plain-name mentions, about 6% CJK names and 4% Korean or Japanese notes
(`bench/gen-corpus.ts`, seed 1). 134,223 mentions. Median of 5 runs on one 8-vCPU sandbox (Xeon
6975P-C), Bun 1.4.5, Rust 1.100, release build.

| Path | 10k pages total | per page p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| TypeScript `findMentionedEntities` | 1,054 ms | 103.6 us | 179.4 us | 201.6 us |
| Rust, one call per page | 386 ms | 36.4 us | 58.7 us | 100.8 us |
| Rust, 100 pages per call | 259 ms | 29.7 us | 32.7 us | 37.5 us |
| Rust, one call for all pages | 282 ms | 28.5 us (batch average) | | |
| Rust scan alone, no TypeScript work | 223 ms | | | |
| TypeScript one-pass tokenizer (tokenizer only, old 794 ms) | 496 ms | | | |

- Speed: 4.1 times faster at 100 pages per call, 2.7 times at one call per page. Each call costs
  about 13 us of crossing overhead, so calls must be batched.
- Byte-identical: the TypeScript and Rust outputs for all 10,000 pages are the same file (SHA-256
  `3939cea7afaaa7546cbb3a95455070e54660694b056250793da20d017bed1801`). A fuzz of 40,000 random
  texts against a gazetteer that uses every entry flag (case-sensitive aliases, `@handle`
  entries, shared sibling names, connector stubs, cross-source twins, Hangul names with any
  spacing, Katakana names, combining marks, lone surrogates, code fences, HTML comments), with
  the cross-source switch off and on: 0 mismatches.
- Not ported: the per-page `ignoreNames` list (`mention_ignore` frontmatter). The batch call passes
  no ignore list; the scanner supports one internally.
- Cost: the addon grows from 52,895,856 to 53,142,296 bytes (+241 KB, +0.5%). Two new crates
  (`unicode-normalization`, `unicode-general-category`). Unicode tables in Rust and in Bun's
  JavaScript engine can differ by Unicode version, so a real port needs a parity test that runs
  on every Bun upgrade.
- What it buys in the whole pass: about 0.8 s of 28.2 s wall on Postgres (about 3%) and of
  78.6 s on PGLite (about 1%).

## Mention pass and sync numbers

`gbrain extract --stale --catch-up --source-id notes` after a fresh sync (9,000 pages to
re-extract, then the mention pass over 10,000 pages; 134,144 mention links written). Each run
started from the same database copy.

| Brain | Wall | gbrain CPU | DB server CPU | Peak RSS |
|---|---:|---:|---:|---:|
| Postgres 17 (two runs) | 30.5 s, 28.2 s | 18.1 s, 18.1 s | 34.4 s, 36.0 s | 0.25 GB |
| PGLite | 78.6 s | 78.6 s | in process | 1.60 GB |

Sync of 1,000 changed files (one line appended to the same 1,000 notes each round, then
`gbrain sync --source notes --no-pull --no-embed`): Postgres 12.2 s, 12.5 s wall (gbrain CPU
14.3-14.8 s, server 16.6-19.9 s); PGLite 43.1 s wall, 49.9 s CPU.

Sync preparation on Postgres (2.4 s, 19.1%) is spread over more than 40 files. The top function
is 171 ms (1.3%). The time goes to `JSON.stringify`, `realpath`, git subprocesses and native
SHA-256, not to a pure function a Rust call could replace. It is a crash-safety protocol, so it
should move as one piece inside the Rust write path, not function by function.

## TypeScript fixes found (not Rust, not part of this branch)

- `maskRanges` (`src/core/link-extraction.ts`) splits the whole page into an array of single
  characters and joins it back on every call. It was 0.96 s of self time in the Postgres mention
  pass (3.4% of gbrain CPU). A slice-based version: 153 ms to 11 ms over 10,000 pages, the same
  output on all 10,000 (`bench/bench-mask.ts`).
- `tokenizeForScan` (`src/core/by-mention.ts`) runs a regular expression, then walks every
  character with a slice. A single pass with an ASCII fast path: 794 ms to 496 ms, the same tokens
  on all 10,000 pages (`bench/bench-tok.ts`). Estimated scanner gain about 1.4 times (not measured
  end to end).

## Losses (not worth it, with the reason)

- Markdown and frontmatter parse: 3.9% of a Postgres sync, 0.09 ms per page (Vega, Nov 24). A port
  wins at most a few percent and touches `content_hash`, YAML edge cases and held files.
- Chunking: 0.03 ms per page (Vega); its token estimate already runs tiktoken in WASM with a memo.
- Content hash and write digests: SHA-256 is already native in Bun; canonical JSON has to be built
  from JS objects, which is the cost a Rust call would also pay.
- Embedding preparation: bound by the provider network call.
- Link extraction in Rust: after the `maskRanges` fix, the rest is about 9% of the Postgres mention
  pass spread over verb rules and regular expressions with many edge cases. Not worth the parity
  surface.

## Reproduce

Scripts are in `bench/` (absolute scratch paths under `/var/tmp/rx`). Local Postgres 17.10,
`en_US.UTF-8`, `shared_buffers` 1 GB; isolated `HOME` and `GBRAIN_HOME`;
`GBRAIN_SELF_UPGRADE_MODE=off`, `GBRAIN_SWEEP=0`, `DATABASE_URL` unset. Postgres server CPU is the
postmaster's own plus reaped and live children CPU from `/proc`. Paid API spend: $0.
