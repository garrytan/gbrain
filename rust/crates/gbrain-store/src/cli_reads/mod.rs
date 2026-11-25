//! Typed reads that CLI paths ran through `executeRaw` (docs/research/rust-cli-executeraw-map.md).
//! Each file mirrors one CLI path or TypeScript domain of `src/core/engine-sql/` and answers the
//! same rows the PGLite and Postgres engines answer, so each lane edits only its own file.

pub mod admin_reads;
pub mod brief_reads;
pub mod doctor;
pub mod doctor_acc;
pub mod doctor_brain;
pub mod doctor_checkpoints;
pub mod doctor_derived;
pub mod doctor_derived_health;
pub mod doctor_derived_ledgers;
pub mod doctor_drift;
pub mod doctor_facts_trust;
pub mod doctor_fence;
pub mod doctor_join;
pub mod doctor_pages;
pub mod doctor_persistence;
pub mod doctor_search;
pub mod doctor_sources;
pub mod doctor_tallies;
pub mod doctor_terminal;
pub mod entities;
pub mod export;
pub mod import;
pub mod mention_reads;
mod pg_case;
pub(crate) mod pg_jsonb;
pub(crate) mod pg_text;
pub mod reads;
pub mod reflex_reads;
pub mod remote_reads;
pub mod rename_identity;
pub mod resolve_reads;
pub mod search_reads_pages;
pub mod sources;
pub mod sweep_reads;
