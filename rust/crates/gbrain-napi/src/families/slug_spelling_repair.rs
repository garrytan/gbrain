//! The legacy_slug_spellings doctor check's and the slug-spelling repair preview's page and source reads
//! served from the store (`gbrain-store` `slug_spelling_repair`). The TypeScript members
//! (`src/core/rust-engine/store-members/slug-spelling-repair.ts`) answer the row-security and server-encoding
//! reads without a call.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSlugSpellingCandidates(afterId, limit)`: resolves `[{ id, source_id, slug }]` in id order.
    #[napi]
    pub fn list_slug_spelling_candidates<'env>(
        &self,
        env: &'env Env,
        after_id: f64,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_slug_spelling_candidates(id_arg(after_id, "afterId")?, limit as usize)
        })
    }

    /// `listSourceSlugSpellingCandidates(sourceId, afterId, limit)`: resolves
    /// `[{ id, slug, revision, source_path, deleted }]` in id order.
    #[napi]
    pub fn list_source_slug_spelling_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after_id: f64,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_slug_spelling_candidates(
                &source_id,
                id_arg(after_id, "afterId")?,
                limit as usize,
            )
        })
    }

    /// `readSpellingKeyPages(sourceId, keys, scanKey, excludeId)`: resolves `[{ id, slug }]` in id order.
    #[napi]
    pub fn read_spelling_key_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        keys: Option<Vec<String>>,
        scan_key: String,
        exclude_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_spelling_key_pages(
                &source_id,
                keys.as_deref(),
                &scan_key,
                id_arg(exclude_id, "excludeId")?,
            )
        })
    }

    /// `readSlugRepairSource(sourceId)`: resolves `{ local_path, incarnation, slug_root_mode } | null`.
    #[napi]
    pub fn read_slug_repair_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_slug_repair_source(&source_id))
    }

    /// `readPageSlugInSource(pageId, sourceId)`: resolves the slug or null.
    #[napi]
    pub fn read_page_slug_in_source<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_slug_in_source(id_arg(page_id, "pageId")?, &source_id)
        })
    }

    /// `readSlugRepairPage(pageId, sourceId)`: resolves `{ id, slug, revision, source_path, deleted } | null`.
    #[napi]
    pub fn read_slug_repair_page<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_slug_repair_page(id_arg(page_id, "pageId")?, &source_id)
        })
    }
}

/// A JavaScript number that must be a non-negative integer id.
fn id_arg(value: f64, name: &str) -> gbrain_store::error::Result<u64> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Ok(value as u64)
    } else {
        Err(gbrain_store::error::StoreError::invalid(format!(
            "slug spelling {name} must be a non-negative integer, got {value}"
        )))
    }
}
