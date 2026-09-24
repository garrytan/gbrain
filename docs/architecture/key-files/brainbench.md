# BrainBench — in a sibling repo

[Subsystem index](../KEY_FILES.md).

The retrieval-quality BrainBench — the public benchmark for personal-knowledge
agent stacks (P@5/R@5/MRR/nDCG corpus + harness) — lives in
[github.com/garrytan/gbrain-evals](https://github.com/garrytan/gbrain-evals). It
depends on gbrain as a consumer; gbrain never pulls in the ~5MB eval corpus or
the pdf-parse dev dep at install time. The name "BrainBench" primarily
refers to the in-repo cross-harness memory conformance suite
(`gbrain eval brainbench` — see the `src/eval/brainbench/` and
`evals/brainbench/` entries above and `docs/eval/BRAINBENCH.md`); this section
covers the separate retrieval benchmark.

gbrain's public API surface (the exports map in `package.json`) is what
gbrain-evals consumes: `gbrain/engine`, `gbrain/types`, `gbrain/operations`,
`gbrain/pglite-engine`, `gbrain/link-extraction`, `gbrain/import-file`,
`gbrain/transcription`, `gbrain/embedding`, `gbrain/config`, `gbrain/markdown`,
`gbrain/backoff`, `gbrain/search/hybrid`, `gbrain/search/expansion`,
`gbrain/extract`. Removing any of these is a breaking change for the
gbrain-evals consumer.
