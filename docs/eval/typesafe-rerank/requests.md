# TypeSafe free-account pilot: individual HTTP measurements

Captured: 2026-09-17T17:08:27.791Z. One execution per provider/profile. Voyage chunking and quota scheduling are evaluation-only; see the [protocol](README.md).

Every row is a measured native request; no aggregate values were divided to
invent individual durations, tokens or costs. Both providers use the same frozen
evidence. Provider-specific packing, concurrency and quota preparation follow
the [frozen benchmark protocol](README.md).

## Reading the measurements

- Request IDs are global start order; JSONL audit lines are completion order.
- Document ranges are one-based shortlist positions; JSON offsets are zero-based.
- Start ms is relative to the first HTTP call of the same profile/provider/sample.
- Quota wait is the wait before that request, including initial profile setup. It can overlap another active call; do not sum it as operation idle time.
- HTTP ms measures client transport through cloned JSON reading; excludes planning, admission and final merge.
- Active operation ms counts the union of gateway calls plus planning/merge; wall includes between-chunk idle quota gaps. Initial setup is excluded from both.
- Costs use native reported input tokens and list prices, excluding free credits. Sum costs/tokens; overlapping request durations are not elapsed time.
- The CSV includes payload sizes, hashes, estimates, timestamps, header timings, native result counts and observed in-flight count.

| Profile | Provider | Calls | Peak in-flight | Active ms | Wall ms | Idle quota/dispatch ms | Native input tokens | Total USD | Gold first |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| profile-10x1000 | Voyage rerank-3 | 1 | 1 | 768.01 | 768.12 | 0.11 | 1,739 | 0.000086950 | 1 |
| profile-10x1000 | Jev 1.13.0 | 1 | 1 | 977.02 | 977.05 | 0.00 | 3,074 | 0.000129108 | 1 |
| profile-5x6000 | Voyage rerank-3 | 1 | 1 | 388.17 | 388.20 | 0.03 | 5,003 | 0.000250150 | 1 |
| profile-5x6000 | Jev 1.13.0 | 1 | 1 | 585.94 | 585.98 | 0.00 | 6,208 | 0.000260736 | 1 |
| profile-50x1000 | Voyage rerank-3 | 3 | 1 | 1420.67 | 1421.50 | 0.83 | 8,699 | 0.000434950 | 1 |
| profile-50x1000 | Jev 1.13.0 | 1 | 1 | 1069.64 | 1069.65 | 0.00 | 14,274 | 0.000599508 | 1 |
| profile-50x6000 | Voyage rerank-3 | 21 | 2 | 7438.43 | 367340.25 | 359901.82 | 50,048 | 0.002502400 | 1 |
| profile-50x6000 | Jev 1.13.0 | 2 | 2 | 1582.17 | 1582.17 | 0.00 | 59,898 | 0.002515716 | 1 |

## profile-10x1000

| Request ID | Provider | Documents (count) | Start ms | Before-call quota wait ms | HTTP ms | In-flight at start | Input tokens | Individual USD | HTTP |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Voyage rerank-3 | 1–10 (10) | 0.00 | 0.11 | 760.91 | 1 | 1,739 | 0.000086950 | 200 |
| 2 | Jev 1.13.0 | 1–10 (10) | 0.00 | 0.00 | 969.82 | 1 | 3,074 | 0.000129108 | 200 |

## profile-5x6000

| Request ID | Provider | Documents (count) | Start ms | Before-call quota wait ms | HTTP ms | In-flight at start | Input tokens | Individual USD | HTTP |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | Jev 1.13.0 | 1–5 (5) | 0.00 | 0.01 | 574.98 | 1 | 6,208 | 0.000260736 | 200 |
| 4 | Voyage rerank-3 | 1–5 (5) | 0.00 | 58672.70 | 371.06 | 1 | 5,003 | 0.000250150 | 200 |

## profile-50x1000

| Request ID | Provider | Documents (count) | Start ms | Before-call quota wait ms | HTTP ms | In-flight at start | Input tokens | Individual USD | HTTP |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | Voyage rerank-3 | 1–28 (28) | 0.00 | 60627.10 | 467.91 | 1 | 4,872 | 0.000243600 | 200 |
| 6 | Voyage rerank-3 | 29–44 (16) | 469.11 | 468.57 | 555.02 | 1 | 2,784 | 0.000139200 | 200 |
| 7 | Voyage rerank-3 | 45–50 (6) | 1030.98 | 558.02 | 364.62 | 1 | 1,043 | 0.000052150 | 200 |
| 8 | Jev 1.13.0 | 1–50 (50) | 0.00 | 0.00 | 1054.88 | 1 | 14,274 | 0.000599508 | 200 |

## profile-50x6000

| Request ID | Provider | Documents (count) | Start ms | Before-call quota wait ms | HTTP ms | In-flight at start | Input tokens | Individual USD | HTTP |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9 | Jev 1.13.0 | 1–28 (28) | 0.00 | 0.00 | 931.68 | 1 | 33,511 | 0.001407462 | 200 |
| 10 | Jev 1.13.0 | 29–50 (22) | 0.25 | 0.00 | 1548.74 | 2 | 26,387 | 0.001108254 | 200 |
| 11 | Voyage rerank-3 | 1–4 (4) | 0.00 | 57977.01 | 332.87 | 1 | 4,004 | 0.000200200 | 200 |
| 12 | Voyage rerank-3 | 5–7 (3) | 336.40 | 335.47 | 414.54 | 1 | 3,003 | 0.000150150 | 200 |
| 13 | Voyage rerank-3 | 8–8 (1) | 753.48 | 416.13 | 319.36 | 1 | 1,001 | 0.000050050 | 200 |
| 14 | Voyage rerank-3 | 9–11 (3) | 61001.67 | 60246.78 | 419.45 | 1 | 3,003 | 0.000150150 | 200 |
| 15 | Voyage rerank-3 | 12–14 (3) | 61422.80 | 420.37 | 327.91 | 1 | 3,003 | 0.000150150 | 200 |
| 16 | Voyage rerank-3 | 15–16 (2) | 61753.76 | 329.95 | 339.79 | 1 | 2,002 | 0.000100100 | 200 |
| 17 | Voyage rerank-3 | 17–18 (2) | 122004.08 | 60248.08 | 327.16 | 1 | 2,002 | 0.000100100 | 200 |
| 18 | Voyage rerank-3 | 19–21 (3) | 122423.85 | 419.22 | 360.22 | 1 | 3,003 | 0.000150150 | 200 |
| 19 | Voyage rerank-3 | 22–23 (2) | 122785.29 | 360.92 | 276.52 | 1 | 2,002 | 0.000100100 | 200 |
| 20 | Voyage rerank-3 | 24–25 (2) | 183005.36 | 60218.16 | 442.98 | 1 | 2,002 | 0.000100100 | 200 |
| 21 | Voyage rerank-3 | 26–28 (3) | 183449.14 | 443.23 | 353.03 | 1 | 3,003 | 0.000150150 | 200 |
| 22 | Voyage rerank-3 | 29–30 (2) | 183804.12 | 354.31 | 345.42 | 1 | 2,002 | 0.000100100 | 200 |
| 23 | Voyage rerank-3 | 31–32 (2) | 244006.78 | 60200.60 | 331.50 | 1 | 2,002 | 0.000100100 | 200 |
| 24 | Voyage rerank-3 | 33–35 (3) | 244450.89 | 442.57 | 351.51 | 1 | 3,003 | 0.000150150 | 200 |
| 25 | Voyage rerank-3 | 36–37 (2) | 244804.44 | 353.01 | 305.47 | 1 | 2,002 | 0.000100100 | 200 |
| 26 | Voyage rerank-3 | 38–39 (2) | 305007.70 | 60201.58 | 306.10 | 1 | 2,002 | 0.000100100 | 200 |
| 27 | Voyage rerank-3 | 40–42 (3) | 305451.61 | 442.74 | 345.83 | 1 | 3,003 | 0.000150150 | 200 |
| 28 | Voyage rerank-3 | 43–44 (2) | 305805.34 | 353.05 | 310.76 | 1 | 2,002 | 0.000100100 | 200 |
| 29 | Voyage rerank-3 | 45–46 (2) | 366009.13 | 60201.90 | 293.03 | 1 | 2,002 | 0.000100100 | 200 |
| 30 | Voyage rerank-3 | 47–49 (3) | 366452.06 | 442.30 | 418.47 | 1 | 3,003 | 0.000150150 | 200 |
| 31 | Voyage rerank-3 | 50–50 (1) | 366805.57 | 353.04 | 446.87 | 2 | 999 | 0.000049950 | 200 |

## Audited provenance

All 31 records reconcile with each arm/profile and whole-run counts, native tokens and costs. Every document is covered exactly once; native result counts equal chunk size. Both arms rank gold first on all four related synthetic profiles. General quality equivalence and maximum throughput remain unproved.

- [Unaltered final receipt](receipt.json).
- [Principal report](README.md).
- Receipt SHA-256: `fc8480cac21d27b313047221d489e979a2714713e99a3823a5992fc3abf62c64`.
- Frozen pool SHA-256: `942d24c8eec1b5a70f17a9a0e80a0e5e602e5e7ae4b019e59e6bfc0a968f30a8`.
- Final Jev adapter SHA-256: `e14da5195c7265bbf31a95b543cc55773ebdb16baa9ec3395e2b213f641b22e2`.

Source: [unaltered completed receipt](receipt.json). Costs are totals or individual values as labeled.
