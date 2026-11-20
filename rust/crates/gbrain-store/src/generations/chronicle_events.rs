//! The page and ledger reads of the Life Chronicle event adapter
//! (`src/core/generations/adapters/chronicle-events.ts`), its slug assignment
//! (`chronicle/event-identity.ts`) and its publication (`chronicle/publish.ts`), over the rows of
//! the parent module and the page records (`pages.rs`).
//!
//! Members: readChronicleDepthRow, listRetiredGenerationItemKeys, listPageContentHashes,
//! listLiveGenerationItems, pageSlugExists, listOrphanedChronicleOwners and
//! listChronicleEventSlotRows (the read statements of `engine-sql/chronicle-events.ts`). The
//! projection row members of the same file are `timeline_queries/event_rows.rs`. The two chronicle
//! ledger reads (`chronicle_page_state`) answer empty in TypeScript, as the store keeps no
//! chronicle ledger. These are internal reads of derived pages and ledger rows, not caller page
//! reads, so they take no page read policy. They add no keys.
//!
//! Pages are found by their exact `(source_id, slug)` key or their id, deleted or not, as the SQL
//! reads of `pages` do; a member that reads live pages only skips a soft-deleted record. A
//! `(source_id, slug)` key names one page, so the depth row read (`ORDER BY deleted_at NULLS
//! FIRST, id DESC LIMIT 1`) is that page.
//!
//! Order: no statement orders text. The id, hash and slot reads answer in key order and the
//! ledger reads in item key order, where Postgres answers in no set order (the adapters read each
//! result as a set or a map). The orphaned owner read orders by `(updated_at, id)` as the SQL does.

use super::page_rows::text_of;
use super::{
    GenerationKey, GenerationRecord, ItemRecord, check_key, int8, item_key, item_prefix,
    pointed_record, source_records,
};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `readChronicleDepthRow(sourceId, slug)` and `pageSlugExists(sourceId, slug)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSlugSpec {
    pub source_id: String,
    pub slug: String,
}

/// `listRetiredGenerationItemKeys(sourceId, kind, itemKeys)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredItemKeysSpec {
    pub source_id: String,
    pub kind: String,
    pub item_keys: Vec<String>,
}

/// `listPageContentHashes(query)`: by id (deleted pages included) or by slug (live pages only).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "match", rename_all = "snake_case")]
pub enum PageContentHashQuery {
    Ids {
        #[serde(rename = "sourceId")]
        source_id: String,
        ids: Vec<f64>,
    },
    LiveSlugs {
        #[serde(rename = "sourceId")]
        source_id: String,
        slugs: Vec<String>,
    },
}

/// `listOrphanedChronicleOwners(sourceId, kind, limit)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanedOwnersSpec {
    pub source_id: String,
    pub kind: String,
    pub limit: f64,
}

/// `listChronicleEventSlotRows(sourceId, slugs)` and `deleteEventProjections(sourceId, slugs)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSlugsSpec {
    pub source_id: String,
    pub slugs: Vec<String>,
}

/// The ids of `ids` as `bigint`s; a fraction or an out of range number is refused, as the
/// `$n::bigint[]` cast refuses it.
fn bigint_ids(op: &str, ids: &[f64]) -> Result<BTreeSet<i64>> {
    ids.iter().map(|id| int8(op, "id", *id)).collect()
}

/// The text of `frontmatter -> 'event' ->> key`: NULL unless `event` is an object holding `key`.
fn event_text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    frontmatter
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| text_of(event, key))
}

/// Whether `source_id` has a live page at `slug`.
fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    Ok(read_page(read, source_id, slug)?.is_some_and(|page| page.deleted_at_us.is_none()))
}

/// The items of generation `id` that are not retired, in item key order.
fn held_items(read: &dyn KvRead, id: u64) -> Result<Vec<(String, ItemRecord)>> {
    let prefix = item_prefix(id);
    let mut items = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match serde_json::from_slice::<ItemRecord>(v) {
            Ok(item) if item.action != "retired" => {
                items.push((
                    String::from_utf8_lossy(&k[prefix.len()..]).into_owned(),
                    item,
                ));
            }
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(items),
    }
}

impl Store {
    /// `readChronicleDepthRow(sourceId, slug)`: `{ id, live }` of the page at `slug`, deleted or
    /// not, or null.
    pub fn read_chronicle_depth_row(&self, spec: &ChronicleSlugSpec) -> Result<Value> {
        no_nul(
            "readChronicleDepthRow",
            &[("sourceId", &spec.source_id), ("slug", &spec.slug)],
        )?;
        let read = self.read()?;
        Ok(match read_page(&*read, &spec.source_id, &spec.slug)? {
            Some(page) => json!({ "id": page.id, "live": page.deleted_at_us.is_none() }),
            None => Value::Null,
        })
    }

    /// `pageSlugExists(sourceId, slug)`: whether a page has the key, a soft-deleted one included.
    pub fn page_slug_exists(&self, spec: &ChronicleSlugSpec) -> Result<bool> {
        no_nul(
            "pageSlugExists",
            &[("sourceId", &spec.source_id), ("slug", &spec.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &spec.source_id, &spec.slug)?.is_some())
    }

    /// `listRetiredGenerationItemKeys(sourceId, kind, itemKeys)`: the keys of `itemKeys` that a
    /// generation of `kind` in `sourceId`, in any state, recorded as retired, distinct.
    pub fn list_retired_generation_item_keys(
        &self,
        spec: &RetiredItemKeysSpec,
    ) -> Result<Vec<String>> {
        const OP: &str = "listRetiredGenerationItemKeys";
        no_nul(OP, &[("sourceId", &spec.source_id), ("kind", &spec.kind)])?;
        for key in &spec.item_keys {
            no_nul(OP, &[("itemKeys", key)])?;
        }
        let wanted: BTreeSet<&str> = spec.item_keys.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut found = BTreeSet::new();
        for record in source_records(&*read, &spec.source_id)? {
            if record.kind != spec.kind {
                continue;
            }
            for wanted_key in &wanted {
                if let Some(bytes) = read.get(&item_key(record.id, wanted_key))? {
                    let item: ItemRecord = serde_json::from_slice(&bytes)?;
                    if item.action == "retired" {
                        found.insert(wanted_key.to_string());
                    }
                }
            }
        }
        Ok(found.into_iter().collect())
    }

    /// `listLiveGenerationItems(key)`: `{ item_key, identity_hash }` of each item the live
    /// generation of `key` holds without retiring it, in item key order.
    pub fn list_live_generation_items(&self, key: &GenerationKey) -> Result<Vec<Value>> {
        check_key("listLiveGenerationItems", key)?;
        let read = self.read()?;
        let Some(record) = pointed_record(&*read, key, "live")? else {
            return Ok(Vec::new());
        };
        Ok(held_items(&*read, record.id)?
            .into_iter()
            .map(|(item_key, item)| json!({ "item_key": item_key, "identity_hash": item.identity_hash }))
            .collect())
    }

    /// `listPageContentHashes(query)`: `{ slug, content_hash }` of the pages of `sourceId` with an
    /// id of `ids` (deleted or not), or at a slug of `slugs` and live, in id or slug order.
    pub fn list_page_content_hashes(&self, query: &PageContentHashQuery) -> Result<Vec<Value>> {
        const OP: &str = "listPageContentHashes";
        let read = self.read()?;
        let row = |slug: &str, hash: &Option<String>| json!({ "slug": slug, "content_hash": hash });
        match query {
            PageContentHashQuery::Ids { source_id, ids } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                let mut rows = Vec::new();
                for id in bigint_ids(OP, ids)? {
                    let Ok(id) = u64::try_from(id) else { continue };
                    if let Some(page) = read_page_by_id(&*read, id)?
                        && page.source_id == *source_id
                    {
                        rows.push(row(&page.slug, &page.content_hash));
                    }
                }
                Ok(rows)
            }
            PageContentHashQuery::LiveSlugs { source_id, slugs } => {
                no_nul(OP, &[("sourceId", source_id)])?;
                let mut wanted = BTreeSet::new();
                for slug in slugs {
                    no_nul(OP, &[("slugs", slug)])?;
                    wanted.insert(slug.as_str());
                }
                let mut rows = Vec::new();
                for slug in wanted {
                    if let Some(page) = read_page(&*read, source_id, slug)?
                        && page.deleted_at_us.is_none()
                    {
                        rows.push(row(&page.slug, &page.content_hash));
                    }
                }
                Ok(rows)
            }
        }
    }

    /// `listOrphanedChronicleOwners(sourceId, kind, limit)`: the owner keys of the live
    /// generations of `kind` in `sourceId` that hold an unretired item whose page is live, and
    /// whose depth page (`substr(owner_key, 7)`: the key after its first six characters,
    /// `depth:`) is not, by `(updated_at, id)`, at most `limit`.
    pub fn list_orphaned_chronicle_owners(&self, spec: &OrphanedOwnersSpec) -> Result<Vec<String>> {
        const OP: &str = "listOrphanedChronicleOwners";
        no_nul(OP, &[("sourceId", &spec.source_id), ("kind", &spec.kind)])?;
        let limit = int8(OP, "limit", spec.limit)?;
        if limit < 0 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: LIMIT must not be negative"),
            ));
        }
        let read = self.read()?;
        let mut owners: Vec<GenerationRecord> = Vec::new();
        for record in source_records(&*read, &spec.source_id)? {
            if record.kind != spec.kind || record.state != "live" {
                continue;
            }
            let depth: String = record.owner_key.chars().skip(6).collect();
            if live_page(&*read, &spec.source_id, &depth)? {
                continue;
            }
            let mut holds_live = false;
            for (item, _) in held_items(&*read, record.id)? {
                if live_page(&*read, &spec.source_id, &item)? {
                    holds_live = true;
                    break;
                }
            }
            if holds_live {
                owners.push(record);
            }
        }
        owners.sort_by_key(|record| (record.updated_at_us, record.id));
        owners.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(owners.into_iter().map(|record| record.owner_key).collect())
    }

    /// `listChronicleEventSlotRows(sourceId, slugs)`: `{ slug, when, where, kind }` (the text of
    /// `frontmatter -> 'event' ->> field`) of each page at a slug of `slugs`, deleted or not, in
    /// slug order.
    pub fn list_chronicle_event_slot_rows(&self, spec: &ChronicleSlugsSpec) -> Result<Vec<Value>> {
        const OP: &str = "listChronicleEventSlotRows";
        no_nul(OP, &[("sourceId", &spec.source_id)])?;
        let mut wanted = BTreeSet::new();
        for slug in &spec.slugs {
            no_nul(OP, &[("slugs", slug)])?;
            wanted.insert(slug.as_str());
        }
        let read = self.read()?;
        let mut rows = Vec::new();
        for slug in wanted {
            if let Some(page) = read_page(&*read, &spec.source_id, slug)? {
                rows.push(json!({
                    "slug": page.slug,
                    "when": event_text(&page.frontmatter, "when"),
                    "where": event_text(&page.frontmatter, "where"),
                    "kind": event_text(&page.frontmatter, "kind"),
                }));
            }
        }
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations::{ActivationInput, LedgerItemInput};
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn key(owner: &str) -> GenerationKey {
        GenerationKey {
            source_id: "default".into(),
            kind: "chronicle_event".into(),
            owner_key: owner.into(),
        }
    }

    fn item(item_key: &str, action: &str) -> LedgerItemInput {
        LedgerItemInput {
            item_key: item_key.into(),
            identity_hash: format!("id-{item_key}"),
            action: action.into(),
            preimage: None,
            preimage_bytes: None,
            pending: false,
        }
    }

    fn activate(store: &Store, owner: &str, live: Option<f64>, items: &[LedgerItemInput]) -> f64 {
        store
            .activate_generation_rows(
                &key(owner),
                live,
                &ActivationInput {
                    generation: if live.is_some() { 2.0 } else { 1.0 },
                    run_id: None,
                    operation_id: format!("op-{owner}-{live:?}"),
                    input_pin: None,
                    input_size: None,
                    completeness: "{}".into(),
                    set_hash: "h".into(),
                    restore_of: None,
                    activation_id: None,
                    locator: None,
                },
                items,
            )
            .unwrap() as f64
    }

    fn page(store: &Store, slug: &str, frontmatter: Value) -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "event", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn slug_spec(slug: &str) -> ChronicleSlugSpec {
        ChronicleSlugSpec {
            source_id: "default".into(),
            slug: slug.into(),
        }
    }

    #[test]
    fn depth_row_and_slug_exists_count_a_soft_deleted_page() {
        let store = store();
        let id = page(&store, "people/a", json!({}));
        assert_eq!(
            store
                .read_chronicle_depth_row(&slug_spec("people/a"))
                .unwrap(),
            json!({ "id": id, "live": true })
        );
        store.soft_delete_page("people/a", None).unwrap();
        assert_eq!(
            store
                .read_chronicle_depth_row(&slug_spec("people/a"))
                .unwrap(),
            json!({ "id": id, "live": false })
        );
        assert!(store.page_slug_exists(&slug_spec("people/a")).unwrap());
        assert!(!store.page_slug_exists(&slug_spec("people/b")).unwrap());
        assert_eq!(
            store
                .read_chronicle_depth_row(&slug_spec("people/b"))
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            store
                .read_chronicle_depth_row(&slug_spec("a\0b"))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn retired_keys_read_every_generation_of_the_kind() {
        let store = store();
        let first = activate(
            &store,
            "depth:a",
            None,
            &[item("e1", "published"), item("e2", "published")],
        );
        activate(
            &store,
            "depth:a",
            Some(first),
            &[item("e1", "retired"), item("e2", "kept")],
        );
        activate(&store, "depth:b", None, &[item("e3", "retired")]);
        let spec = |kind: &str, keys: &[&str]| RetiredItemKeysSpec {
            source_id: "default".into(),
            kind: kind.into(),
            item_keys: keys.iter().map(|k| k.to_string()).collect(),
        };
        assert_eq!(
            store
                .list_retired_generation_item_keys(&spec(
                    "chronicle_event",
                    &["e3", "e2", "e1", "e1", "e9"]
                ))
                .unwrap(),
            vec!["e1".to_string(), "e3".to_string()]
        );
        assert!(
            store
                .list_retired_generation_item_keys(&spec("fact_fence", &["e1"]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn live_items_skip_retired_items_and_superseded_rows() {
        let store = store();
        let first = activate(
            &store,
            "depth:a",
            None,
            &[item("e1", "published"), item("e0", "published")],
        );
        activate(
            &store,
            "depth:a",
            Some(first),
            &[item("e2", "published"), item("e1", "retired")],
        );
        assert_eq!(
            store.list_live_generation_items(&key("depth:a")).unwrap(),
            vec![json!({ "item_key": "e2", "identity_hash": "id-e2" })]
        );
        assert!(
            store
                .list_live_generation_items(&key("depth:z"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn content_hashes_read_ids_with_deleted_pages_and_live_slugs_without() {
        let store = store();
        let a = page(&store, "events/a", json!({}));
        let b = page(&store, "events/b", json!({}));
        store.soft_delete_page("events/b", None).unwrap();
        let hash = |slug: &str| {
            read_page(&*store.read().unwrap(), "default", slug)
                .unwrap()
                .unwrap()
                .content_hash
        };
        let by_id = store
            .list_page_content_hashes(&PageContentHashQuery::Ids {
                source_id: "default".into(),
                ids: vec![b as f64, a as f64, 999.0, -1.0],
            })
            .unwrap();
        assert_eq!(
            by_id,
            vec![
                json!({ "slug": "events/a", "content_hash": hash("events/a") }),
                json!({ "slug": "events/b", "content_hash": hash("events/b") }),
            ]
        );
        let other = store
            .list_page_content_hashes(&PageContentHashQuery::Ids {
                source_id: "alt".into(),
                ids: vec![a as f64],
            })
            .unwrap();
        assert!(other.is_empty());
        let live = store
            .list_page_content_hashes(&PageContentHashQuery::LiveSlugs {
                source_id: "default".into(),
                slugs: vec!["events/b".into(), "events/a".into(), "events/z".into()],
            })
            .unwrap();
        assert_eq!(
            live,
            vec![json!({ "slug": "events/a", "content_hash": hash("events/a") })]
        );
        assert_eq!(
            store
                .list_page_content_hashes(&PageContentHashQuery::Ids {
                    source_id: "default".into(),
                    ids: vec![1.5],
                })
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn orphaned_owners_need_a_gone_depth_page_and_a_live_item() {
        let store = store();
        page(&store, "events/a1", json!({}));
        page(&store, "events/b1", json!({}));
        page(&store, "events/c1", json!({}));
        page(&store, "people/c", json!({}));
        page(&store, "events/d1", json!({}));
        store.soft_delete_page("events/d1", None).unwrap();
        // a: depth never existed, holds a live event.
        activate(
            &store,
            "depth:people/a",
            None,
            &[item("events/a1", "published")],
        );
        // b: depth soft-deleted, holds a live event.
        page(&store, "people/b", json!({}));
        store.soft_delete_page("people/b", None).unwrap();
        activate(&store, "depth:people/b", None, &[item("events/b1", "kept")]);
        // c: depth live.
        activate(
            &store,
            "depth:people/c",
            None,
            &[item("events/c1", "published")],
        );
        // d: its only event is deleted, and a retired item does not count.
        activate(
            &store,
            "depth:people/d",
            None,
            &[item("events/d1", "published"), item("events/a1", "retired")],
        );
        let spec = |limit: f64| OrphanedOwnersSpec {
            source_id: "default".into(),
            kind: "chronicle_event".into(),
            limit,
        };
        assert_eq!(
            store.list_orphaned_chronicle_owners(&spec(10.0)).unwrap(),
            vec!["depth:people/a".to_string(), "depth:people/b".to_string()]
        );
        assert_eq!(
            store.list_orphaned_chronicle_owners(&spec(1.0)).unwrap(),
            vec!["depth:people/a".to_string()]
        );
        assert!(
            store
                .list_orphaned_chronicle_owners(&spec(0.0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_orphaned_chronicle_owners(&spec(-1.0))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn slot_rows_read_the_event_fields_as_text() {
        let store = store();
        page(
            &store,
            "events/a",
            json!({ "event": { "when": "2026-01-01", "where": "home", "kind": 3 } }),
        );
        page(&store, "events/b", json!({ "event": ["when"] }));
        page(&store, "events/c", json!({ "event": { "when": null } }));
        store.soft_delete_page("events/c", None).unwrap();
        let rows = store
            .list_chronicle_event_slot_rows(&ChronicleSlugsSpec {
                source_id: "default".into(),
                slugs: vec![
                    "events/c".into(),
                    "events/a".into(),
                    "events/b".into(),
                    "events/z".into(),
                ],
            })
            .unwrap();
        assert_eq!(
            rows,
            vec![
                json!({ "slug": "events/a", "when": "2026-01-01", "where": "home", "kind": "3" }),
                json!({ "slug": "events/b", "when": null, "where": null, "kind": null }),
                json!({ "slug": "events/c", "when": null, "where": null, "kind": null }),
            ]
        );
    }
}
