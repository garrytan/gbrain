//! Page write guards: the observable behaviour of `readPageOrigin`, `listOriginClaims`,
//! `bindPageOrigin`, `stampPageIngest`, `sealImportedPage`, `readLivePageBody`,
//! `readInlinePageRegions` and `readStoredPageTier`, matched to the
//! PGLite engine (`engine-sql/write-guards.ts`).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::ORIGIN_CLAIMED;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::write_guards::{
    ImportedPageSeal, OriginClaimOptions, PageIngestStamp, PageOriginBind, PageOriginTarget,
};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, source_path: Option<&str>) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "Body.", "timeline": "", "source_path": source_path}),
    )
    .unwrap();
    let page = store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    page["id"].as_u64().unwrap()
}

fn page(store: &Store, slug: &str) -> Value {
    let scope: ReadScope = serde_json::from_value(json!({"includeDeleted": true})).unwrap();
    store.read_page_snapshot(slug, &scope).unwrap().unwrap()["page"].clone()
}

fn target(slug: Option<&str>, page_id: Option<u64>) -> PageOriginTarget {
    PageOriginTarget {
        source_id: "default".into(),
        page_id,
        slug: slug.map(String::from),
    }
}

fn bind(slug: &str, path: &str, only_if_unset: bool, live_only: bool) -> PageOriginBind {
    PageOriginBind {
        target: target(Some(slug), None),
        source_path: path.into(),
        only_if_unset,
        live_only,
    }
}

#[test]
fn read_page_origin_reads_by_id_or_slug_and_keeps_tombstones() {
    let dir = TempDir::new("wg-read-origin");
    let store = open(&dir);
    let id = put(&store, "notes/a", Some("notes/a.md"));
    let by_slug = store
        .read_page_origin(&target(Some("notes/a"), None))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            by_slug.id,
            by_slug.source_path.as_deref(),
            by_slug.deleted_at.is_none()
        ),
        (id, Some("notes/a.md"), true)
    );
    assert_eq!(
        store.read_page_origin(&target(None, Some(id))).unwrap(),
        Some(by_slug)
    );
    let elsewhere = PageOriginTarget {
        source_id: "other".into(),
        page_id: Some(id),
        slug: None,
    };
    assert_eq!(store.read_page_origin(&elsewhere).unwrap(), None);
    assert_eq!(store.read_page_origin(&target(None, None)).unwrap(), None);
    store.soft_delete_page("notes/a", Some("default")).unwrap();
    assert!(
        store
            .read_page_origin(&target(Some("notes/a"), None))
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some()
    );
}

#[test]
fn list_origin_claims_lists_live_holders_of_any_spelling_in_slug_order() {
    let dir = TempDir::new("wg-claims");
    let store = open(&dir);
    let b = put(&store, "notes/b", Some("shared.md"));
    put(&store, "notes/a", Some("legacy/shared.md"));
    put(&store, "notes/gone", Some("gone.md"));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let spellings = ["shared.md", "legacy/shared.md", "gone.md", ""].map(String::from);
    let slugs = |exclude: Option<i64>| -> Vec<String> {
        let opts = OriginClaimOptions {
            lock_keys: vec![],
            exclude_page_id: exclude,
        };
        store
            .list_origin_claims("default", &spellings, &opts)
            .unwrap()
            .into_iter()
            .map(|c| c.slug)
            .collect()
    };
    assert_eq!(slugs(None), ["notes/a", "notes/b"]);
    assert_eq!(slugs(Some(b as i64)), ["notes/a"]);
    assert_eq!(slugs(Some(-1)), ["notes/a", "notes/b"]);
}

#[test]
fn bind_page_origin_changes_only_what_it_is_told_and_refuses_a_claimed_origin() {
    let dir = TempDir::new("wg-bind");
    let store = open(&dir);
    put(&store, "notes/bind", None);
    put(&store, "notes/holder", Some("held.md"));
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/bind", "bind.md", true, false))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/bind", "other.md", true, false))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/bind", "bind.md", false, false))
            .unwrap(),
        0
    );
    assert_eq!(page(&store, "notes/bind")["source_path"], "bind.md");
    let refused = store
        .bind_page_origin(&bind("notes/bind", "held.md", false, false))
        .unwrap_err();
    assert_eq!(refused.code, ORIGIN_CLAIMED);
    assert_eq!(page(&store, "notes/bind")["source_path"], "bind.md");
    store
        .soft_delete_page("notes/bind", Some("default"))
        .unwrap();
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/bind", "moved.md", false, true))
            .unwrap(),
        0
    );
    // A tombstone claims nothing, so it may record an origin a live page holds.
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/bind", "held.md", false, false))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/missing", "x.md", false, false))
            .unwrap(),
        0
    );
}

#[test]
fn stamp_page_ingest_sets_the_provenance_and_refuses_a_time_that_is_not_iso() {
    let dir = TempDir::new("wg-stamp");
    let store = open(&dir);
    put(&store, "notes/stamped", None);
    let stamp = |at: &str| PageIngestStamp {
        source_id: "default".into(),
        source_kind: Some("import".into()),
        ingested_via: Some("parity".into()),
        ingested_at: Some(at.into()),
    };
    store
        .stamp_page_ingest("notes/stamped", &stamp("2026-01-02T03:04:05.678Z"))
        .unwrap();
    let stamped = page(&store, "notes/stamped");
    assert_eq!(
        (&stamped["source_kind"], &stamped["ingested_via"]),
        (&json!("import"), &json!("parity"))
    );
    // The store keeps microseconds; the TS member hands it millisecond ISO.
    assert_eq!(stamped["ingested_at"], "2026-01-02T03:04:05.678000Z");
    assert!(
        store
            .stamp_page_ingest("notes/stamped", &stamp("yesterday"))
            .is_err()
    );
    store
        .stamp_page_ingest("notes/missing", &stamp("2026-01-02T03:04:05.678Z"))
        .unwrap();
}

#[test]
fn seal_imported_page_returns_the_id_and_seals_only_the_current_revision() {
    let dir = TempDir::new("wg-seal");
    let store = open(&dir);
    let id = put(&store, "notes/sealed", None);
    let revision = page(&store, "notes/sealed")["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = page(&store, "notes/sealed")["text_projection_revision"].clone();
    let seal = |revision: Option<&str>| ImportedPageSeal {
        source_id: "default".into(),
        revision: revision.map(String::from),
        timeline_text: String::new(),
        chunker_version: 3,
    };
    assert_eq!(
        store
            .seal_imported_page("notes/sealed", &seal(None))
            .unwrap()
            .map(|s| s.id),
        Some(id)
    );
    assert_eq!(
        page(&store, "notes/sealed")["text_projection_revision"],
        before
    );
    store
        .seal_imported_page("notes/sealed", &seal(Some(&revision)))
        .unwrap();
    assert_eq!(
        page(&store, "notes/sealed")["text_projection_revision"],
        revision.as_str()
    );
    assert_eq!(
        store
            .seal_imported_page("notes/missing", &seal(None))
            .unwrap(),
        None
    );
}

#[test]
fn read_live_page_body_reads_an_inline_page_and_skips_tombstones() {
    let dir = TempDir::new("wg-body");
    let store = open(&dir);
    put(&store, "notes/body", None);
    let body = store
        .read_live_page_body("notes/body", "default")
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            body.compiled_truth.as_deref(),
            body.timeline.as_deref(),
            body.body_storage
        ),
        (Some("Body."), Some(""), "inline")
    );
    assert_eq!(
        body.content_hash.as_ref().map(|h| json!(h)),
        Some(page(&store, "notes/body")["content_hash"].clone())
    );
    assert_eq!(
        store.read_live_page_body("notes/body", "other").unwrap(),
        None
    );
    store
        .soft_delete_page("notes/body", Some("default"))
        .unwrap();
    assert_eq!(
        store.read_live_page_body("notes/body", "default").unwrap(),
        None
    );
}

#[test]
fn read_inline_page_regions_reads_a_page_by_id_a_tombstone_included() {
    let dir = TempDir::new("wg-regions");
    let store = open(&dir);
    let id = put(&store, "notes/regions", None);
    let regions = store.read_inline_page_regions(id).unwrap().unwrap();
    assert_eq!(
        (
            regions.compiled_truth.as_deref(),
            regions.timeline.as_deref()
        ),
        (Some("Body."), Some(""))
    );
    store
        .soft_delete_page("notes/regions", Some("default"))
        .unwrap();
    assert_eq!(store.read_inline_page_regions(id).unwrap(), Some(regions));
    assert_eq!(store.read_inline_page_regions(id + 1000).unwrap(), None);
}

#[test]
fn read_stored_page_tier_reads_the_stamped_tier_a_tombstone_included() {
    let dir = TempDir::new("wg-tier");
    let store = open(&dir);
    put(&store, "notes/tier", None);
    let stamped = page(&store, "notes/tier")["trust_tier"]
        .as_str()
        .unwrap_or("unknown")
        .to_owned();
    assert_eq!(
        store
            .read_stored_page_tier("default", "notes/tier")
            .unwrap(),
        Some(stamped)
    );
    store
        .soft_delete_page("notes/tier", Some("default"))
        .unwrap();
    assert!(
        store
            .read_stored_page_tier("default", "notes/tier")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store.read_stored_page_tier("other", "notes/tier").unwrap(),
        None
    );
    assert_eq!(
        store
            .read_stored_page_tier("default", "notes/none")
            .unwrap(),
        None
    );
}

fn revision(store: &Store, slug: &str) -> String {
    page(store, slug)["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn detach_records_the_marker_and_put_page_or_bind_drop_it() {
    let dir = TempDir::new("wg-detach");
    let store = open(&dir);
    let id = put(&store, "notes/a", Some("notes/a.md"));
    let before = revision(&store, "notes/a");
    store.detach_page_origin(id, "origin_twin").unwrap();
    assert_eq!(page(&store, "notes/a")["source_path"], Value::Null);
    assert_eq!(revision(&store, "notes/a"), before);
    let reason = |s: &Store| {
        s.read_page_database_only_reason("default", "notes/a")
            .unwrap()
    };
    assert_eq!(reason(&store).as_deref(), Some("origin_twin"));
    // A put without a file keeps the marker.
    put(&store, "notes/a", None);
    assert_eq!(reason(&store).as_deref(), Some("origin_twin"));
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/a", "notes/a.md", false, false))
            .unwrap(),
        1
    );
    assert_eq!(reason(&store), None);
    store.detach_page_origin(id, "detached").unwrap();
    assert_eq!(
        store
            .bind_page_origin(&bind("notes/a", "notes/a.md", false, false))
            .unwrap(),
        1
    );
    assert_eq!(reason(&store).as_deref(), Some("detached"));
    put(&store, "notes/a", Some("notes/a.md"));
    assert_eq!(reason(&store), None);
    assert_eq!(
        store
            .read_page_database_only_reason("default", "notes/none")
            .unwrap(),
        None
    );
}

#[test]
fn revision_bump_key_removal_and_type_change_follow_the_revision_trigger() {
    let dir = TempDir::new("wg-repair-writes");
    let store = open(&dir);
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "k", "compiled_truth": "Body.",
        "timeline": "", "frontmatter": {"retired_by": "notes/b", "kept": "yes"}}),
    )
    .unwrap();
    let id = store
        .put_page("notes/k", &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap();
    let r0 = revision(&store, "notes/k");
    store.bump_page_knowledge_revision(id).unwrap();
    let r1 = revision(&store, "notes/k");
    assert_ne!(r0, r1);
    let keys = vec!["retired_by".to_owned(), "retired_at".to_owned()];
    store
        .remove_page_frontmatter_keys("other", id, &keys)
        .unwrap();
    assert_eq!(revision(&store, "notes/k"), r1);
    store
        .remove_page_frontmatter_keys("default", id, &keys)
        .unwrap();
    let r2 = revision(&store, "notes/k");
    assert_ne!(r1, r2);
    assert_eq!(
        page(&store, "notes/k")["frontmatter"],
        json!({"kept": "yes"})
    );
    store
        .remove_page_frontmatter_keys("default", id, &keys)
        .unwrap();
    assert_eq!(revision(&store, "notes/k"), r2);
    store.set_page_type("default", "notes/k", "note").unwrap();
    assert_eq!(revision(&store, "notes/k"), r2);
    store
        .set_page_type("default", "notes/k", "concept")
        .unwrap();
    assert_ne!(revision(&store, "notes/k"), r2);
    assert_eq!(page(&store, "notes/k")["type"], "concept");
}
