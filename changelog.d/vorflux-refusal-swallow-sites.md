**The code call-graph walk, structural code search and the paid reindex cost estimate now work on a Rust brain, as they do on Postgres and PGLite.**

### Fixed
- The `code_blast` and `code_flow` call-graph walks (`gbrain code-blast`, `gbrain code-flow`) on a Rust brain stopped with a refusal at the language check, because the check read chunk languages with raw SQL the Rust engine refuses. The check and the mixed-language caller filter are now typed reads (`listSymbolLanguages`, `listSupportedChunkIds`) that the Rust store answers from its chunk records. A symbol defined only in an unsupported language still reports `unsupported_language`, and a symbol with an unsupported namesake still walks only the supported callers.
- Structural code search (`gbrain query --near-symbol` and the two-pass walk) on a Rust brain stopped with a refusal when it looked up the chunks that define a symbol. The near-symbol anchors and the targets of unresolved call edges now come from the typed read `listSymbolChunkIds`, which the Rust store answers from its chunk records. Postgres and PGLite run the same statements as before. When more than 50 chunks match, the Rust store keeps the 50 with the lowest ids, while Postgres and PGLite keep whichever 50 their query plan returns, as before.
- `gbrain reindex --markdown` on a Rust brain could not price the run before it asked for consent. The page count and text length it prices now come from the typed read `readReindexSpendInputs`, which the Rust store answers from its page records.
- Postgres and PGLite send the same statements as before (the language read now returns rows in byte order).

### Changed
- A remediation step's impact history row on a Rust brain is refused by name (`insertImpactLogRow`), because the Rust store keeps no impact log yet. The run reports the step `impact_log: not_recorded` and keeps the job status, as before; the row is never dropped without a report.
