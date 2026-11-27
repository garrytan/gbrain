//! The `guest_promotions` table of the SQL engines (src/core/guests/schema.ts): the brain owner kept a guest page as an
//! owner page, and where. The TypeScript statements are in src/core/engine-sql/guest-notes.ts.
//!
//! Members: linkGuestPromotion and readGuestPromotionKept (guests/promote.ts), readGuestDeleteCheck (a remote delete,
//! guests/admission.ts refuseRemoteGuestDelete) and readGuestRefPages (which pages a guest stamp may ride on,
//! guests/stamp-readable.ts). `promoted` of readGuestMarks and the `guest_promotions` kind of the concept rebuild read
//! these rows too ([`page_promoted`]).
//!
//! Key: `~p <guest page id BE8> <target source> 0x00 <target slug>` (`keys::GUEST_PROMOTION`, a two-byte family tag) ->
//! the row (JSON, [`PromotionRecord`]). One row per guest page and target, as the unique index
//! `guest_promotions_link_key`. The `id` column is kept in the row from the counter `next_guest_promotion_id`. The rows
//! go with the guest page when it is deleted for good ([`remove_page_rows`], from `cascade::remove_page_rows`), as the
//! foreign key's `ON DELETE CASCADE` drops them; the target is text, so a purge of the target page keeps the row (and
//! readGuestPromotionKept then answers false, as the SQL's `EXISTS` on pages does).

use crate::error::{CONSTRAINT_VIOLATION, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::{Result, Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The counter the `id` column comes from (the table's `BIGSERIAL`).
pub(crate) const NEXT_GUEST_PROMOTION_ID: &str = "next_guest_promotion_id";

/// One row: the table's columns but the key's three. `promoted_at` in microseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct PromotionRecord {
    pub id: u64,
    pub promoted_by_kind: String,
    pub promoted_by_id: String,
    pub promoted_at_us: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// `linkGuestPromotion(link)`'s input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestPromotionLink {
    pub guest_page_id: u64,
    pub target_source: String,
    pub target_slug: String,
    pub by_kind: String,
    pub by_id: String,
    pub request_id: Option<String>,
}

/// `readGuestRefPages(query)`'s input: page ids, `(source_id, slug)` keys and the page policy of `excludePrivate`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GuestRefPagesQuery {
    pub ids: Vec<i64>,
    pub keys: Vec<GuestRefKey>,
    pub exclude_private: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuestRefKey {
    pub source_id: String,
    pub slug: String,
}

/// Text holding a NUL byte names no row (no stored key holds one).
fn has_nul(parts: &[&str]) -> bool {
    parts.iter().any(|p| p.contains('\0'))
}

fn page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = keys::GUEST_PROMOTION.to_vec();
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

pub(crate) fn promotion_key(page_id: u64, target_source: &str, target_slug: &str) -> Vec<u8> {
    let mut key = page_prefix(page_id);
    key.extend_from_slice(target_source.as_bytes());
    key.push(0);
    key.extend_from_slice(target_slug.as_bytes());
    key
}

/// Whether guest page `page_id` has any promotion row (the `EXISTS (SELECT 1 FROM guest_promotions g WHERE
/// g.guest_page_id = ...)` of the guest stamp, the remote delete check and the concept rebuild).
pub(crate) fn page_promoted(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &page_prefix(page_id), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// A guest page deleted for good takes its promotion rows with it (the foreign key's `ON DELETE CASCADE`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let mut found = Vec::new();
    scan_prefix(&*tx, &page_prefix(page.id), false, &mut |key, _| {
        found.push(key.to_vec());
        true
    })?;
    for key in found {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The seed's copy of a primary's row (seed/privacy.rs): false when the store already holds the same row.
pub(crate) fn seed_promotion(
    tx: &mut dyn KvWrite,
    page_id: u64,
    target_source: &str,
    target_slug: &str,
    row: PromotionRecord,
) -> Result<bool> {
    let key = promotion_key(page_id, target_source, target_slug);
    if get_json::<PromotionRecord>(&*tx, &key)?.is_some_and(|stored| stored == row) {
        return Ok(false);
    }
    put_json(tx, &key, &row)?;
    Ok(true)
}

/// The shadow follower's removal of the row the primary deleted, found by its `id`; false when the store holds none.
pub(crate) fn remove_promotion(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let mut found = None;
    let mut failure = None;
    scan_prefix(
        &*tx,
        &keys::GUEST_PROMOTION,
        false,
        &mut |key, value| match serde_json::from_slice::<PromotionRecord>(value) {
            Ok(row) if row.id == id => {
                found = Some(key.to_vec());
                false
            }
            Ok(_) => true,
            Err(e) => {
                failure = Some(StoreError::from(e));
                false
            }
        },
    )?;
    if let Some(e) = failure {
        return Err(e);
    }
    let Some(key) = found else {
        return Ok(false);
    };
    tx.delete(&key)?;
    Ok(true)
}

fn page_ref_row(page: &PageRecord) -> Value {
    json!({
        "id": page.id,
        "source_id": page.source_id,
        "slug": page.slug,
        "type": page.page_type,
        "frontmatter": Value::Object(page.frontmatter.clone()),
    })
}

impl Store {
    /// `linkGuestPromotion(link)`: the row of this guest page and target gets the new promoter, time and request, or is
    /// written with the next id when there is none. The guest page must exist (the foreign key), else
    /// `constraint_violation` and nothing is written. Text holding a NUL byte is `invalid_argument`.
    pub fn link_guest_promotion(&self, link: &GuestPromotionLink) -> Result<()> {
        let mut texts = vec![
            ("targetSource", link.target_source.as_str()),
            ("targetSlug", link.target_slug.as_str()),
            ("byKind", link.by_kind.as_str()),
            ("byId", link.by_id.as_str()),
        ];
        if let Some(request) = &link.request_id {
            texts.push(("requestId", request.as_str()));
        }
        no_nul("linkGuestPromotion", &texts)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = promotion_key(link.guest_page_id, &link.target_source, &link.target_slug);
            let id = match get_json::<PromotionRecord>(&*tx, &key)? {
                Some(stored) => stored.id,
                None => {
                    if read_page_by_id(&*tx, link.guest_page_id)?.is_none() {
                        return Err(StoreError::new(
                            CONSTRAINT_VIOLATION,
                            "insert or update on table \"guest_promotions\" violates foreign key constraint \"guest_promotions_guest_page_id_fkey\"",
                        ));
                    }
                    crate::pages::next_id(tx, NEXT_GUEST_PROMOTION_ID)?
                }
            };
            put_json(
                tx,
                &key,
                &PromotionRecord {
                    id,
                    promoted_by_kind: link.by_kind.clone(),
                    promoted_by_id: link.by_id.clone(),
                    promoted_at_us: now,
                    request_id: link.request_id.clone(),
                },
            )
        })
    }

    /// `readGuestPromotionKept(guestPageId, targetSource, targetSlug)`: the row of this guest page and target exists
    /// and a page (live or soft-deleted) is at the target.
    pub fn read_guest_promotion_kept(
        &self,
        guest_page_id: u64,
        target_source: &str,
        target_slug: &str,
    ) -> Result<bool> {
        if has_nul(&[target_source, target_slug]) {
            return Ok(false);
        }
        let read = self.read()?;
        let key = promotion_key(guest_page_id, target_source, target_slug);
        if get_json::<PromotionRecord>(&*read, &key)?.is_none() {
            return Ok(false);
        }
        Ok(read_page(&*read, target_source, target_slug)?.is_some())
    }

    /// `readGuestDeleteCheck(sourceId, slug)`: the page at `(sourceId, slug)`, live or soft-deleted, as
    /// `{hidden: false, guest, kept, writer}`: whether its source has a guest record, whether the owner kept it, and its
    /// mark's `kind:id`. Null when no page is there. `hidden` is false: the store has no row-level security.
    pub fn read_guest_delete_check(&self, source_id: &str, slug: &str) -> Result<Value> {
        if has_nul(&[source_id, slug]) {
            return Ok(Value::Null);
        }
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(Value::Null);
        };
        let guest = crate::guest_sources::read_guest_row(&*read, &page.source_id)?.is_some();
        let kept = page_promoted(&*read, page.id)?;
        let writer = crate::guest_marks::read_mark(&*read, page.id)?
            .map(|m| format!("{}:{}", m.writer_kind, m.writer_id));
        Ok(json!({"hidden": false, "guest": guest, "kept": kept, "writer": writer}))
    }

    /// `readGuestRefPages(query)`: each page, live or soft-deleted, with an id in `ids` or a `(source_id, slug)` in
    /// `keys`, once, by page id, as `{id, source_id, slug, type, frontmatter}`; under `exclude_private` only a page the
    /// page policy admits (`facts/privacy.rs` `page_hidden`). The SQL sets no order.
    pub fn read_guest_ref_pages(&self, query: &GuestRefPagesQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages: BTreeMap<u64, PageRecord> = BTreeMap::new();
        for id in query.ids.iter().filter_map(|id| u64::try_from(*id).ok()) {
            if let Some(page) = read_page_by_id(&*read, id)? {
                pages.insert(page.id, page);
            }
        }
        for key in &query.keys {
            if has_nul(&[key.source_id.as_str(), key.slug.as_str()]) {
                continue;
            }
            if let Some(page) = read_page(&*read, &key.source_id, &key.slug)? {
                pages.insert(page.id, page);
            }
        }
        let mut owner_only = OwnerOnlyCache::default();
        let mut out = Vec::new();
        for page in pages.values() {
            if let Some(policy) = &query.exclude_private
                && owner_only.page_hidden(&*read, page, policy)?
            {
                continue;
            }
            out.push(page_ref_row(page));
        }
        Ok(out)
    }
}
