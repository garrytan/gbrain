//! The `Brain` addon methods, one file per family. Each file adds its own `#[napi] impl Brain`
//! block; napi-rs merges the blocks into one JavaScript class. Every family is listed once, here,
//! so building a family never edits this list.

mod chunks;
mod cli_reads_search_pages;
mod config;
mod fact_relink;
mod fact_relink_writes;
mod field_usage;
mod graph;
mod journal;
mod links;
mod pages;
mod search;
mod sources;
mod tags;
mod timeline;
mod trust;
mod trust_fence;
mod trust_proposals;
mod versions;
mod write_guards;
mod write_trust;

// Planned families: no methods yet (docs/designs/RUST_ENGINE_INTERFACES.md).
mod aliases;
mod calibration_profiles;
mod chunk_queries;
mod code_edges;
mod contradictions;
mod decide_store;
mod dream;
mod embeddings;
mod eval_capture;
mod extraction;
mod facts;
mod facts_cycle;
mod facts_doctor;
mod facts_loops;
mod facts_purge;
mod facts_repair;
mod facts_trust;
mod facts_trust_reads;
mod jobs;
mod keyword;
mod link_queries;
mod ontology;
mod page_body;
mod page_ops;
mod raw_files;
mod relations;
mod salience;
mod stats;
mod takes;
mod telemetry;
mod timeline_queries;
mod transactions;
mod trust_tier_reads;
mod vectors;
mod wanted_links;
// Group C: decide proposals and review proposals (rust/docs/store/decide-proposals.md).
mod decide_proposals;
