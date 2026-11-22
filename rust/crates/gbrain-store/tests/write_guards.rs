//! Page write guards: the observable behaviour of `readPageOrigin`, `listOriginClaims`,
//! `bindPageOrigin`, `stampPageIngest`, `sealImportedPage` and `readLivePageBody`, matched to the
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
