//! The guest source rows and the notes in them (rust/docs/store/guest_sources.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `upsertGuestSource(sourceId, writers, trustCeiling)`: writes the source's guest row, or
    /// merges the writers into the row it has, and resolves the row.
    #[napi]
    pub fn upsert_guest_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        writers: Vec<String>,
        trust_ceiling: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_guest_source(&source_id, &writers, &trust_ceiling)
        })
    }

    /// `listGuestNotes(slug, guestSource)`: resolves `{ id, source_id }` of the live page at the
    /// slug in each guest source, by source id in byte order. `guestSource` is a source id or null.
    #[napi]
    pub fn list_guest_notes<'env>(
        &self,
        env: &'env Env,
        slug: String,
        guest_source: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_guest_notes(&slug, guest_source.as_deref())
        })
    }
}
