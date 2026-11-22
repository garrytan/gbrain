//! Typed reads that CLI paths ran through `executeRaw` (docs/research/rust-cli-executeraw-map.md).
//! Each file mirrors one CLI path or TypeScript domain of `src/core/engine-sql/` and answers the
//! same rows the PGLite and Postgres engines answer, so each lane edits only its own file.

pub(crate) mod pg_text;
pub mod search_reads_pages;
