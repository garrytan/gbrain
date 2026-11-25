//! The publication journal: the request-row reads and writes of a bound (worktree) publication
//! (`publicationJournalStore()`, rust/docs/store/persistence.md, "Publication journal").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::leases::LeaseToken;
use gbrain_store::persistence::PublicationWrite;
use serde::Deserialize;

use crate::store_binding::{Brain, required};

/// A `PublicationWrite` with the caller's host fence beside it: `{ kind, ...args, fence? }`.
#[derive(Deserialize)]
struct FencedWrite {
    #[serde(default)]
    fence: Option<LeaseToken>,
    #[serde(flatten)]
    what: PublicationWrite,
}

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
            let FencedWrite { fence, what } = required(what, "publicationJournalWrite input")?;
            s.publication_journal_write_fenced(&what, fence.as_ref())
        })
    }
}
