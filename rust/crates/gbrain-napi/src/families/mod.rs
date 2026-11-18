//! The `Brain` addon methods, one file per family. Each file adds its own `#[napi] impl Brain`
//! block; napi-rs merges the blocks into one JavaScript class. Every family is listed once, here,
//! so building a family never edits this list.

mod chunks;
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
