# Research records

Completed experiments and decisions, including negative and inconclusive results.
These are historical evidence, not promises about current GBrain behavior.

| Date | Research | Decision |
|---|---|---|
| 2026-09-29 | [PGLite managed-persistence write throughput](pglite-persistence-throughput-2026-09-29.md) | Shipped. PGLite soak 8.9 → 31.7 writes/s in matched 1,000-write runs on `standard-30`; the 10,000-write gate soak drops from 1,417 s to 277–308 s; Postgres 11.2 → 13.5 writes/s; all crash boundaries and full gates pass. |
| 2026-09-24 | [T-Mem validation for GBrain](t-mem-2026-09-24/postmortem.md) | Feature [#5374](https://github.com/garrytan/gbrain/pull/5374) is mothballed, not merged. Preserve the research and evaluator separately: no completed custom feature-on score; a released-code pilot found a small descriptive-trigger retrieval signal but no demonstrated answer-quality gain. |
