# RP re-cut inputs (scratch, not for landing)

Scratch inputs for the helper session that cuts `rust-engine/land-rp1` .. `land-rp8`. Delete this branch after the cut.

- `lt3j-closure.json`: the RP closure (keys `closure`, `ns`, `seed`, `cfiles`). Computed by `git diff` of `origin/master` against `rust-engine/main` when main was `b66e407760877426fa2786cfa233ffd1ad23d17e` (master `1d77261c76`). Seeds: `src/core/rust-engine/store-members/transactions.ts`, `src/core/rust-engine/store-capabilities.ts`, `src/core/rust-engine/owner-ipc/whole-op.ts`, plus the src files of commits bf72f8062c, ed84648428, 8133529074, d9d7a3f563, e80474be10, abf9ede6ac and `src/core/persistence/provider.ts`. Method: follow relative imports through files that differ between master and main; drop files an earlier landing carries; add back the six commits' own files and provider.ts. Result then: 661 src files, 27,583 shared TS lines, 11,933 Rust-engine lines, 2.38 MB.
- `rp-parts-8.json`: the 8-part split (`parts[i].name`, `src`, `ts` = shared TS lines, `re` = Rust-engine lines, `files`). `key` maps the P files to their part; `rp` is the full closure list. P's parts (RP1-RP5 carry transactions.ts, store-capabilities.ts, whole-op.ts and their closure) land first; RP6 (local-client.ts, resolve-ipc-binding.ts) is swap-critical; RP7-RP8 the rest.
- `landing-table-nov22-v3.md`: landing table v3.9 (section with the RP part table: sizes, dates, roles).

## Sizing rule (GBrain Minder, https://github.com/garrytan/gbrain/pull/9992#issuecomment-7082307675)

Per landing: at most 110 src files, 6K shared TypeScript lines, 40K Rust-engine lines, and under /ship's 2 MB review diff. Strict bundles in flight are stacked (comment 7082497110).

## What changed since the closure was computed

- rust-engine/main moved: b7b18e5ab3 (batch 10), then sync 13 (master through 1c313c2c5d or newer, and 96 typed Postgres writes moved to the read-only-retry executor). Recompute the closure and part sizes against the then-current main and master; keep the part roles and P-first order, re-split by the rule above if sizes moved.
- Master gained R1 (#9971), RA1 (#10089), R2 (#9992 with #9991, #9989: engine-sql moves, abort-aware seam, loops/decide/timeline typed members) and more; files master now has the same as main drop out of RP.
- The Rust store crates land separately as one snapshot (rust-engine/land-rust-store); RP carries TS only (plus the few Rust lines a part needs).
