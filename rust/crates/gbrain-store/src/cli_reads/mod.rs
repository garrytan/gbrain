//! Typed reads that CLI paths ran through `executeRaw` (docs/research/rust-cli-executeraw-map.md).
//! Each file mirrors one CLI path or TypeScript domain of `src/core/engine-sql/` and answers the
//! same rows the PGLite and Postgres engines answer, so each lane edits only its own file.

pub mod doctor;
pub mod doctor_acc;
pub mod doctor_checkpoints;
pub mod doctor_derived;
pub mod doctor_health;
pub mod doctor_pages;
pub mod doctor_persistence;
pub mod doctor_sources;
pub mod entities;
pub mod export;
pub mod import;
mod pg_case;
pub(crate) mod pg_text;
pub mod reads;
pub mod remote_reads;
pub mod search_reads_pages;
pub mod sources;
