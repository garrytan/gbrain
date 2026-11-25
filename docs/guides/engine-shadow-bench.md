# Engine shadow speed receipt (criterion 8)

How `gbrain engine shadow bench --import` loads an engine-bench speed receipt and how its numbers are counted. This page holds the whole Speed item of [Rust engine shadow mode](../ENGINES.md); it lives here so `llms-full.txt`, which inlines the engines page, stays under its size cap.

The command, as it was listed with the other `gbrain engine shadow` commands:

```
gbrain engine shadow bench --import <receipt.json> [--json]   # load an engine-bench speed receipt as criterion 8's evidence
```

- **Speed (criterion 8, reported and never gating).** `bench --import <receipt.json>` reads the engine-bench speed
  receipt (gbrain-evals `eval/runner/engine-bench/perf.ts`: `benchmark: "engine-bench"`, `stage: "speed"`,
  `schema_version: 1`, Rust against PGLite and Postgres; the published receipt has 10,000 pages, and the page count is
  shown, not checked) into `evidence/bench/engine-bench-speed.json` and
  fills `bench.pairs`, `bench.rust_no_worse` and `bench.losses` in `status --json`. The file must be a regular file of at
  most 256 MiB (a pipe, socket, directory, device or symbolic link is refused without being read). The import never
  starts a shadow and never opens the brain: with no shadow for this brain it refuses and writes nothing. A receipt with
  other margins, a Rust arm that refused, no Rust pair against either engine, a metric that names another engine than its pair, a recorded sample count that is not a
  non-negative integer, a pair that names more than 64 operations or carries more than 256 metrics (`perf.ts` writes 13 operations and 35 metrics per pair), a reduced summary over 8 MiB, or a malformed number is refused and the earlier evidence stays. The rule is the evals' own:
  for each of the 13 operation classes, at p50 and p99, against each TypeScript engine, Rust is **worse** when the 95%
  interval of the Rust over other ratio lies above 1, **better** below 1, and **not shown** otherwise; a class with
  fewer than 100 pairs (or no interval), one Rust refused, or one the receipt leaves out is **not measured** and never
  passes. The 9 other metrics (read and write throughput at 1, 4 and 16 clients, cold start, corpus import and peak RSS)
  follow the same direction rule, and import and peak RSS, which are single points, compare the ratio itself with 1; one
  the receipt marks missing, leaves out or records with zero samples is **not measured** too. Every loss and every
  not-measured row is named in `losses` (each starts with "bench corpus:") and `rust_no_worse` is true only when
  everything was measured against both engines and nothing is worse.
  Readiness row 8 says "Rust slower" only when a measured loss exists; when every open row is not measured it says "Rust not
  shown to be no worse (rows not measured)".
  The build in the receipt is compared with the evidence epoch's build (same, differs or unknown, reported and not gating).
  These are numbers from the benchmark corpus, not from this brain: replaying your own reads on both engines
  (`gbrain engine shadow bench` with no `--import`) is not built, so that source reads "not measured". The D14 margin for
  filtered vector search is not set, so `filtered_vector_margin_met` is absent and the report says "D14 margin not set".
  `report` holds the same block as `bench` in `reports/provisional.json` and a "Speed" section in `provisional.md`.
