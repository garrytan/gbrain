//! Typed reads of stamped trust tiers: `listCorePageRows`, `listTrustScanRows`,
//! `countUnscannedTrustRows`, `listVersionTrustTiers`, `listVersionReasonWriters`, and the valid-time
//! reads `listValidTimeIdentities`, `pickValidTimeEdition` and `listAmendmentsNotApplied`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::trust::tier_reads` (or
//! `trust::valid_time`) call on
//! the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/trust-tier-reads.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::trust::tier_reads::{
    CorePageRowQuery, PageIdsQuery, PageKeyRef, PageQuoteTierQuery, TrustScanQuery, VersionIdsQuery,
};
use gbrain_store::trust::valid_time::{
    AmendmentsQuery, CursorEditionQuery, ValidTimeIdentityQuery, ValidTimePickQuery,
    VersionEditionQuery,
};

#[napi]
impl Brain {
    /// `listCorePageRows(spec)`: resolves the live `always_load` pages core memory lists.
    #[napi]
    pub fn list_core_page_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CorePageRowQuery = required(spec, "listCorePageRows spec")?;
            s.list_core_page_rows(&a)
        })
    }

    /// `listTrustScanRows(spec)`: resolves the scanned page or fact rows above a cursor.
    #[napi]
    pub fn list_trust_scan_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TrustScanQuery = required(spec, "listTrustScanRows spec")?;
            s.list_trust_scan_rows(&a)
        })
    }

    /// `countUnscannedTrustRows(spec)`: resolves the count of rows the scan has not read.
    #[napi]
    pub fn count_unscanned_trust_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TrustScanQuery = required(spec, "countUnscannedTrustRows spec")?;
            s.count_unscanned_trust_rows(&a)
        })
    }

    /// `listVersionTrustTiers({ ids })`: resolves the snapshot tier of each listed version.
    #[napi]
    pub fn list_version_trust_tiers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VersionIdsQuery = required(args, "listVersionTrustTiers args")?;
            s.list_version_trust_tiers(&a)
        })
    }

    /// `listVersionReasonWriters({ ids })`: resolves the writer that replaced each listed version.
    #[napi]
    pub fn list_version_reason_writers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VersionIdsQuery = required(args, "listVersionReasonWriters args")?;
            s.list_version_reason_writers(&a)
        })
    }

    /// `listPageRefsByIds({ ids })`: resolves the source, slug and type of each listed page.
    #[napi]
    pub fn list_page_refs_by_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageIdsQuery = required(args, "listPageRefsByIds args")?;
            s.list_page_refs_by_ids(&a)
        })
    }

    /// `listPageQuoteTiers(spec)`: resolves the type and tier of the listed pages, or of the live
    /// pages with a slug in the listed sources.
    #[napi]
    pub fn list_page_quote_tiers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageQuoteTierQuery = required(args, "listPageQuoteTiers args")?;
            s.list_page_quote_tiers(&a)
        })
    }

    /// `listPageTrustTiersByKey(refs)`: the id and stored tier of each named page, deleted or not.
    #[napi]
    pub fn list_page_trust_tiers_by_key<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let refs: Vec<PageKeyRef> = required(refs, "listPageTrustTiersByKey refs")?;
            s.list_page_trust_tiers_by_key(&refs)
        })
    }

    /// `lockLivePagesByKey(refs)`: the named pages that are live.
    #[napi]
    pub fn lock_live_pages_by_key<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let refs: Vec<PageKeyRef> = required(refs, "lockLivePagesByKey refs")?;
            s.lock_live_pages_by_key(&refs)
        })
    }

    /// `listValidTimeIdentities(spec)`: resolves the live pages with a slug a valid-time read may follow.
    #[napi]
    pub fn list_valid_time_identities<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ValidTimeIdentityQuery = required(spec, "listValidTimeIdentities spec")?;
            s.list_valid_time_identities(&a)
        })
    }

    /// `pickValidTimeEdition(spec)`: resolves `{ row }` for one page.
    #[napi]
    pub fn pick_valid_time_edition<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ValidTimePickQuery = required(spec, "pickValidTimeEdition spec")?;
            s.pick_valid_time_edition(&a)
        })
    }

    /// `listAmendmentsNotApplied(spec)`: resolves the amendment records an as-of edition does not fold in.
    #[napi]
    pub fn list_amendments_not_applied<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AmendmentsQuery = required(spec, "listAmendmentsNotApplied spec")?;
            s.list_amendments_not_applied(&a)
        })
    }

    /// `readPageVersionEdition(spec)`: resolves one version of the page as an edition, or null.
    #[napi]
    pub fn read_page_version_edition<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VersionEditionQuery = required(spec, "readPageVersionEdition spec")?;
            s.read_page_version_edition(&a)
        })
    }

    /// `readCursorEdition(spec)`: resolves where a window cursor's revision stands, or null.
    #[napi]
    pub fn read_cursor_edition<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CursorEditionQuery = required(spec, "readCursorEdition spec")?;
            s.read_cursor_edition(&a)
        })
    }
}
