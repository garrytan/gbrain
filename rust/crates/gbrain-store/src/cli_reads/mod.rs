//! Typed reads that replace raw SQL in CLI paths. Each file mirrors one TypeScript domain of
//! `src/core/engine-sql/` and answers the same rows the PGLite and Postgres engines answer.

pub mod sources;
