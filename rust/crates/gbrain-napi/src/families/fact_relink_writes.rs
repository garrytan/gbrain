//! Group 5 facts members, relink writes: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::relink_writes`, the guarded `UPDATE facts` statements of facts relink
//! (src/core/engine-sql/fact-relink-writes.ts), and the conversation relink's page pick.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::relink_writes::{
    ConversationFactLink, ConversationRelinkPagesQuery, RelinkPlacement,
};

#[napi]
impl Brain {
    /// `placeRelinkedFact(sourceId, placement)`: resolves true when the row moved.
    #[napi]
    pub fn place_relinked_fact<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        placement: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let placement: RelinkPlacement = required(placement, "placeRelinkedFact placement")?;
            s.place_relinked_fact(&source_id, &placement)
        })
    }

    /// `linkConversationFact(sourceId, link)`: resolves true when the row was linked.
    #[napi]
    pub fn link_conversation_fact<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        link: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let link: ConversationFactLink = required(link, "linkConversationFact link")?;
            s.link_conversation_fact(&source_id, &link)
        })
    }

    /// `listConversationRelinkPages(sourceId, q)`: resolves the picked page slugs.
    #[napi]
    pub fn list_conversation_relink_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        q: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ConversationRelinkPagesQuery = required(q, "listConversationRelinkPages query")?;
            s.list_conversation_relink_pages(&source_id, &q)
        })
    }
}
