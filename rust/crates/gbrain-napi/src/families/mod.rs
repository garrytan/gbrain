//! The `Brain` addon methods, one file per family. Each file adds its own `#[napi] impl Brain`
//! block; napi-rs merges the blocks into one JavaScript class. Every family is listed once, here,
//! so building a family never edits this list.

mod chunks;
mod cli_entities;
mod cli_reads_import;
mod cli_reads_ops;
mod cli_reads_search_pages;
mod cli_sources;
mod config;
mod graph;
mod journal;
mod links;
mod pages;
mod search;
mod sources;
mod tags;
mod timeline;
mod versions;
mod write_guards;

// Planned families: no methods yet (docs/designs/RUST_ENGINE_INTERFACES.md).
mod aliases;
mod chunk_queries;
mod code_edges;
mod contradictions;
mod dream;
mod embeddings;
mod eval_capture;
mod extraction;
mod facts;
mod facts_cycle;
mod facts_doctor;
mod facts_purge;
mod facts_repair;
mod facts_trust;
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
mod timeline_queries;
mod transactions;
mod vectors;
mod wanted_links;
