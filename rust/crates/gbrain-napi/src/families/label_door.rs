//! The reads and the one write `delete_page` and the label door make: `readPrivacyOrigin`, `listOriginDependents`,
//! `listCheckoutFiles`, `readPageLabelRow` and `writePageLabelGuard`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::label_door` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/label-door.ts)
//! pass the process's alias-honoring setting.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::label_door::OriginRef;

#[napi]
impl Brain {
    /// `readPrivacyOrigin(sourceId, slug)`: resolves `{ id, deleted }` when the page is an origin, else `null`.
    #[napi]
    pub fn read_privacy_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_privacy_origin(&source_id, &slug, honor_aliases)
        })
    }

    /// `listOriginDependents(origins)`: resolves the dependents the removal of `origins` would expose.
    #[napi]
    pub fn list_origin_dependents<'env>(
        &self,
        env: &'env Env,
        origins: Value,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let origins: Vec<OriginRef> = required(origins, "listOriginDependents origins")?;
            s.list_origin_dependents(&origins, honor_aliases)
        })
    }

    /// `listCheckoutFiles(pageIds)`: resolves each page's recorded file and its source's checkout.
    #[napi]
    pub fn list_checkout_files<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_checkout_files(&page_ids))
    }

    /// `readPageLabelRow(sourceId, slug)`: resolves `{ id, frontmatter }`, soft-deleted or not, else `null`.
    #[napi]
    pub fn read_page_label_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_label_row(&source_id, &slug))
    }

    /// `readLabelGuardTiers(pageId)`: resolves `{ owner_set, priors }`, the tiers a label guard over the page raises to.
    #[napi]
    pub fn read_label_guard_tiers<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_label_guard_tiers(page_id))
    }

    /// `writePageLabelGuard(pageId, tier)`: `null` deletes the page's label guard; a tier sets it.
    #[napi]
    pub fn write_page_label_guard<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        tier: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_page_label_guard(page_id, tier.as_deref())
        })
    }
}
