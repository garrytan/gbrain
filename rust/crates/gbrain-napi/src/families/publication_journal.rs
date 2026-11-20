//! The publication journal: the request-row reads and writes of a bound (worktree) publication
//! (`publicationJournalStore()`, rust/docs/store/persistence.md, "Publication journal").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `publicationJournalStore()` read: `{ kind, ...args }` (gbrain-store `PublicationRead`).
    #[napi]
    pub fn publication_journal_rows<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.publication_journal_rows(&required(what, "publicationJournalRows input")?)
        })
    }

    /// One `publicationJournalStore()` write: `{ kind, ...args }` (gbrain-store `PublicationWrite`).
    #[napi]
    pub fn publication_journal_write<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.publication_journal_write(&required(what, "publicationJournalWrite input")?)
        })
    }
}
