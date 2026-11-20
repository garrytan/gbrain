**A Postgres brain now reads white space in fact repair checks the way PGLite and the Rust engine do, on every server locale.**

### Fixed
- `gbrain repair` counts of conversation label facts and of facts from purged pages no longer depend on the Postgres server's locale. A label line or a page slug that holds U+0085 (next line) or U+1680 (ogham space mark) now gets the same answer on Postgres, PGLite and the Rust engine. These checks use the explicit whitespace class (`FACT_SPACE_CLASS`) instead of `[[:space:]]`.

### Changed
- New `src/core/pg-fold.ts` spells PGLite's lower-case and upper-case map in SQL, so later fixes can fold text the same way on every Postgres locale.
- Tests: `test/pg-fold.test.ts` (every code point on both SQL engines, and the Rust store's table) and two new cases in `test/engine-parity/facts-repair.test.ts`. On the Rust arm one of the new cases stops on a typed refusal, as pinned in `test/engine-parity/rust-tally.tsv`.
