**The in-tree LongMemEval and BrainBench harnesses now accept any storage engine, not only PGLite, so a future engine can run the same evals.**

### Changed
- `src/eval/**` and `gbrain eval longmemeval` take a `BrainEngine` wherever they took a `PGLiteEngine`. The benchmark brain they build is still an in-memory PGLite brain, so eval results and commands are unchanged. Groundwork for the optional Rust engine (https://github.com/garrytan/gbrain/pull/9593, "PR sequence" step 4).
