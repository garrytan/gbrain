# Hundred-document reranking extension

Captured 2026-09-17T19:21:32.745Z; one execution per provider/profile. Uncommitted adapter on base `d13aa742fd68b71bfd6c98be3dda5813791f1d6c`.

Same Atlas query and filler grammar as the earlier pilot. Each provider sees identical candidates within each profile. The short profile repeats nine background texts, with unique IDs; the long profile numbers 99 background notes. The expected policy is last before reranking.

This is a separate completed capture using the current Jev gateway lifecycle. Original pilot receipts and sources remain unchanged. Voyage rerank-3, splitting, concurrency up to three, rolling 3 RPM / 10,000 TPM admission and `truncation:false` are evaluation-only free-account controls. Jev uses the proposed production planner and executor. Conservative estimates do not establish minimum native request counts, optimal scheduling, unconstrained throughput or held-out quality equivalence.

Costs total native reported input across all calls at published list prices (Voyage USD 0.05/M; Jev USD 0.042/M, free output). Free credits and actual invoices are excluded. Active time counts the union of gateway intervals plus planning/merge; wall additionally includes between-call quota/dispatch waits. Initial profile isolation is excluded. Request durations can overlap.

| Documents × characters | Calls Voyage / Jev | Native input Voyage / Jev | Total nominal USD Voyage / Jev | Jev cost difference | Active ms Voyage / Jev | Wall ms Voyage / Jev |
| --- | --- | --- | --- | --- | --- | --- |
| 100 × 1,000 | 7 / 1 | 17,399 / 28,274 | 0.000869950 / 0.001187508 | +36.50% | 2485.95 / 1919.68 | 122403.73 / 1919.78 |
| 100 × 6,000 | 42 / 4 | 100,098 / 119,798 | 0.005004900 / 0.005031516 | +0.53% | 14401.02 / 1899.14 | 794633.99 / 1899.18 |

Increasing the pool did not make Jev cheaper than Voyage. Its nominal total was 36.50% higher on the short profile and 0.53% higher on the long profile. Compared with the separate 50-document capture, Jev cost per document fell about 0.96% for short text and stayed effectively constant for long text. On the 100-long profile Jev active elapsed time was 86.81% lower in this single execution. These are account-constrained observations, not a general provider ranking.

## Cost per document: 50 versus 100 candidates

These are separate measurements at different times, not extra repetitions of the same pool. The 100-document short pool extends the repeated backgrounds; the long pool adds numbered notes. Provider tokenization and per-call instruction overhead both affect cost.

| Characters | Provider | USD/document at 50 | USD/document at 100 | Change |
| ---: | --- | ---: | ---: | ---: |
| 1,000 | Voyage rerank-3 | 0.000008699000 | 0.000008699500 | +0.0057% |
| 1,000 | Jev 1.13.0 | 0.000011990160 | 0.000011875080 | -0.9598% |
| 6,000 | Voyage rerank-3 | 0.000050048000 | 0.000050049000 | +0.0020% |
| 6,000 | Jev 1.13.0 | 0.000050314320 | 0.000050315160 | +0.0017% |

## Individual HTTP measurements

Document ranges are one-based. Start is relative to the first HTTP call of that provider/profile. Before-call waits include profile preparation and can overlap another call. HTTP duration includes cloned response JSON reading, excludes planning/merge and quota admission, and cannot be summed as elapsed time.

| Profile | Request | Provider | Documents (count) | Start ms | Before-call quota wait ms | HTTP ms | In-flight at start | Native input tokens | Individual USD | HTTP |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| profile-100x1000 | 1 | Voyage rerank-3 | 1–28 (28) | 0.00 | 0.11 | 561.12 | 1 | 4,872 | 0.000243600 | 200 |
| profile-100x1000 | 2 | Voyage rerank-3 | 29–44 (16) | 562.63 | 559.63 | 333.72 | 1 | 2,784 | 0.000139200 | 200 |
| profile-100x1000 | 3 | Voyage rerank-3 | 45–51 (7) | 897.66 | 334.39 | 257.18 | 1 | 1,218 | 0.000060900 | 200 |
| profile-100x1000 | 4 | Voyage rerank-3 | 52–69 (18) | 61001.72 | 60102.26 | 286.82 | 1 | 3,132 | 0.000156600 | 200 |
| profile-100x1000 | 5 | Voyage rerank-3 | 70–86 (17) | 61562.78 | 559.12 | 341.17 | 1 | 2,958 | 0.000147900 | 200 |
| profile-100x1000 | 6 | Voyage rerank-3 | 87–98 (12) | 61904.57 | 341.43 | 296.17 | 1 | 2,088 | 0.000104400 | 200 |
| profile-100x1000 | 7 | Voyage rerank-3 | 99–100 (2) | 122005.65 | 60097.84 | 362.14 | 1 | 347 | 0.000017350 | 200 |
| profile-100x1000 | 8 | Jev 1.13.0 | 1–100 (100) | 0.00 | 0.00 | 1877.66 | 1 | 28,274 | 0.001187508 | 200 |
| profile-100x6000 | 9 | Jev 1.13.0 | 1–28 (28) | 0.00 | 0.00 | 929.03 | 1 | 33,511 | 0.001407462 | 200 |
| profile-100x6000 | 10 | Jev 1.13.0 | 29–56 (28) | 0.39 | 0.00 | 1784.01 | 2 | 33,511 | 0.001407462 | 200 |
| profile-100x6000 | 11 | Jev 1.13.0 | 57–84 (28) | 0.73 | 0.00 | 1702.91 | 3 | 33,511 | 0.001407462 | 200 |
| profile-100x6000 | 12 | Jev 1.13.0 | 85–100 (16) | 0.96 | 0.00 | 1460.78 | 4 | 19,265 | 0.000809130 | 200 |
| profile-100x6000 | 13 | Voyage rerank-3 | 1–4 (4) | 0.00 | 56807.14 | 308.34 | 1 | 4,004 | 0.000200200 | 200 |
| profile-100x6000 | 14 | Voyage rerank-3 | 5–7 (3) | 309.52 | 309.11 | 308.73 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 15 | Voyage rerank-3 | 8–8 (1) | 618.96 | 309.03 | 329.05 | 1 | 1,001 | 0.000050050 | 200 |
| profile-100x6000 | 16 | Voyage rerank-3 | 9–11 (3) | 61002.37 | 60381.36 | 358.86 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 17 | Voyage rerank-3 | 12–14 (3) | 61362.24 | 359.33 | 363.87 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 18 | Voyage rerank-3 | 15–16 (2) | 61727.24 | 364.49 | 313.13 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 19 | Voyage rerank-3 | 17–18 (2) | 122005.11 | 60275.79 | 297.12 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 20 | Voyage rerank-3 | 19–21 (3) | 122363.43 | 356.68 | 290.93 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 21 | Voyage rerank-3 | 22–23 (2) | 122729.01 | 364.36 | 287.36 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 22 | Voyage rerank-3 | 24–25 (2) | 183005.61 | 60274.70 | 329.05 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 23 | Voyage rerank-3 | 26–28 (3) | 183364.14 | 357.85 | 383.80 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 24 | Voyage rerank-3 | 29–30 (2) | 183750.59 | 385.46 | 340.67 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 25 | Voyage rerank-3 | 31–32 (2) | 244008.31 | 60254.63 | 362.38 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 26 | Voyage rerank-3 | 33–35 (3) | 244372.40 | 363.32 | 352.49 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 27 | Voyage rerank-3 | 36–37 (2) | 244752.85 | 378.79 | 324.59 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 28 | Voyage rerank-3 | 38–39 (2) | 305009.14 | 60253.76 | 303.37 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 29 | Voyage rerank-3 | 40–42 (3) | 305374.25 | 363.55 | 286.67 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 30 | Voyage rerank-3 | 43–44 (2) | 305753.23 | 377.77 | 282.33 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 31 | Voyage rerank-3 | 45–46 (2) | 366015.27 | 60257.66 | 654.51 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 32 | Voyage rerank-3 | 47–49 (3) | 366671.73 | 655.02 | 430.35 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 33 | Voyage rerank-3 | 50–51 (2) | 367103.55 | 431.14 | 301.64 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 34 | Voyage rerank-3 | 52–53 (2) | 427012.76 | 59907.24 | 275.41 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 35 | Voyage rerank-3 | 54–56 (3) | 427673.01 | 659.02 | 358.86 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 36 | Voyage rerank-3 | 57–58 (2) | 428104.56 | 430.71 | 391.10 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 37 | Voyage rerank-3 | 59–60 (2) | 488015.11 | 59907.83 | 274.76 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 38 | Voyage rerank-3 | 61–63 (3) | 488673.46 | 656.51 | 310.10 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 39 | Voyage rerank-3 | 64–65 (2) | 489105.51 | 431.29 | 432.71 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 40 | Voyage rerank-3 | 66–67 (2) | 549015.55 | 59908.28 | 314.96 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 41 | Voyage rerank-3 | 68–70 (3) | 549673.78 | 656.91 | 294.00 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 42 | Voyage rerank-3 | 71–72 (2) | 550107.54 | 432.27 | 299.96 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 43 | Voyage rerank-3 | 73–74 (2) | 610019.45 | 59908.16 | 263.15 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 44 | Voyage rerank-3 | 75–77 (3) | 610675.02 | 653.42 | 306.50 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 45 | Voyage rerank-3 | 78–79 (2) | 611108.22 | 431.71 | 273.60 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 46 | Voyage rerank-3 | 80–81 (2) | 671020.08 | 59909.07 | 265.10 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 47 | Voyage rerank-3 | 82–84 (3) | 671674.55 | 653.45 | 294.27 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 48 | Voyage rerank-3 | 85–86 (2) | 672107.96 | 432.94 | 384.70 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 49 | Voyage rerank-3 | 87–88 (2) | 732023.33 | 59911.95 | 288.65 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 50 | Voyage rerank-3 | 89–91 (3) | 732675.24 | 650.55 | 373.60 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 51 | Voyage rerank-3 | 92–93 (2) | 733110.22 | 433.61 | 350.87 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 52 | Voyage rerank-3 | 94–95 (2) | 793022.32 | 59910.37 | 445.95 | 1 | 2,002 | 0.000100100 | 200 |
| profile-100x6000 | 53 | Voyage rerank-3 | 96–98 (3) | 793676.45 | 653.11 | 372.40 | 1 | 3,003 | 0.000150150 | 200 |
| profile-100x6000 | 54 | Voyage rerank-3 | 99–100 (2) | 794110.76 | 433.34 | 379.83 | 1 | 2,000 | 0.000100000 | 200 |

## Audit

All 54 native records reconcile with the completion audit, per-profile arms and whole-run summaries. Each provider covers all 100 documents exactly once in each profile; native result counts match request sizes. Both rank the expected policy first. This is one synthetic query at two lengths, not independent accuracy evidence.

- Receipt SHA-256: `a9b3a1804d97fb675fc49c9bc844dedb329ebe0999cd3030d0c227983ba4735b`.
- Capped-pool SHA-256: `7716c3d4d7219dfbd2b0719993ff49ed95f255f4ea4752e69bc52605158d37e2`.
- [Unaltered raw receipt](hundred-document-receipt.json).
- [Unaltered capture sources/protocol](hundred-document-source-manifest.json).
- [Original capture generator](hundred-document-capture-generator.py), byte-identical to the local Python source in the manifest.
- [Portable Bun generator](../../../scripts/fixtures/jev-rerank-hundred-workloads.ts), independently checked against every captured candidate and all five native Jev request hashes.
- [Full per-request CSV](hundred-document-requests.csv).

Pricing documentation refreshed via curl on 2026-09-17: [TypeSafe models](https://docs.typesafe.ai/models), [Voyage pricing](https://docs.voyageai.com/docs/pricing).

## Reproduce

The receipt and manifest retain original ignored local filenames. From the repository root, the portable generator reconstructs the same canonical pools:

```bash
bun scripts/fixtures/jev-rerank-hundred-workloads.ts .context/jev-hundred-workloads.jsonl
bun scripts/typesafe-rerank-ab.ts \
  --pools .context/jev-hundred-workloads.jsonl \
  --baseline voyage:rerank-3 --candidate typesafe:jev-1.13.0 \
  --baseline-rpm 3 --baseline-tpm 10000 --baseline-concurrency 3 \
  --baseline-token-margin 1.8 --baseline-max-input-tokens 9040 \
  --baseline-isolate-profiles --repeats 1 --timeout-ms 5000 --max-usd 0.03 \
  --out .context/jev-hundred-ab.json
```

Both existing provider environment keys are required for live execution. Add `--dry-run` for zero-provider-call planning. Use the appropriate account limits. No other provider probes or repository checks ran during this capture. See the [initial pilot and protocol](README.md) for the extension boundaries.
