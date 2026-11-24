//! The preview reads of `gbrain repair conversation-labels` (`facts/label_repair.rs`): the candidate list with its
//! classification evidence, the segmented-page census and the active audit-marker check.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::label_repair::{AuditMarkerArgs, LabelFactArgs};
use gbrain_store::page_body::SegmentedPageMeta;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU32, Ordering};

/// Each fact takes its own fence row; a taken `(slug, row_num)` slot is skipped.
fn next_row() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

const SEG: &str = "cli:extract-conversation-facts";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = args(json!({ "id": "other", "name": "other", "config": {} }));
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn page(store: &Store, source: &str, slug: &str, body: &str) {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": body, "timeline": "", "frontmatter": {} }),
    );
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    store.put_page(slug, &input, &options).unwrap();
}

fn fact(store: &Store, source_id: &str, slug: &str, text: &str, extra: Value) -> u64 {
    let mut row = json!({
        "fact": text, "visibility": "private", "source": SEG, "valid_from": "2026-01-01T00:00:00.000Z",
        "source_markdown_slug": slug, "row_num": next_row(), "context": "segment 1970-01-01",
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    let out = store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [row], "sourceId": source_id }),
        ))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn query(sources: &[&str], slug: Option<&str>) -> LabelFactArgs {
    args(json!({
        "sourceIds": sources, "slug": slug, "segmentSource": SEG, "labels": ["date", "attendees"],
        "terminalSource": "audit:t", "nonExtractableSource": "audit:n",
    }))
}

#[test]
fn candidates_carry_their_evidence_in_source_page_id_order() {
    let (_d, store) = brain("label-candidates");
    page(
        &store,
        "default",
        "meetings/b",
        "**Date:** 2026-09-28\nNotes.",
    );
    page(
        &store,
        "default",
        "meetings/a",
        "intro\n**ATTENDEES :** Alice Example",
    );
    page(&store, "default", "meetings/mid", "see **Date:** inline");
    page(&store, "default", "meetings/decided", "**Date:** done");
    page(&store, "other", "meetings/a", "**Date:** elsewhere");
    let b = fact(
        &store,
        "default",
        "meetings/b",
        "Date said Monday",
        json!({}),
    );
    let a1 = fact(
        &store,
        "default",
        "meetings/a",
        "Attendees said hiring",
        json!({ "entity_slug": "people/alice-example" }),
    );
    let a2 = fact(
        &store,
        "default",
        "meetings/a",
        "Launch moved",
        json!({ "context": "from the notes" }),
    );
    fact(
        &store,
        "default",
        "meetings/mid",
        "mid-line label",
        json!({}),
    );
    let decided = fact(&store, "default", "meetings/decided", "decided", json!({}));
    fact(
        &store,
        "default",
        "meetings/decided",
        "audit",
        json!({ "source": "audit:n", "context": "scanned extractor_version=2" }),
    );
    let other = fact(&store, "other", "meetings/a", "other source", json!({}));
    fact(
        &store,
        "default",
        "meetings/b",
        "another lane",
        json!({ "source": "mcp:remember" }),
    );
    assert!(
        store
            .insert_fact_withdrawal(
                "default",
                "private",
                "Attendees said hiring",
                "people/alice-example",
                None
            )
            .unwrap()
    );

    let rows = store
        .list_label_fact_candidates(&query(&["other", "default"], None))
        .unwrap();
    let seen: Vec<(String, String, u64)> = rows
        .iter()
        .map(|r| (r.source_id.clone(), r.slug.clone(), r.id))
        .collect();
    assert_eq!(
        seen,
        vec![
            ("default".into(), "meetings/a".into(), a1),
            ("default".into(), "meetings/a".into(), a2),
            ("default".into(), "meetings/b".into(), b),
            ("default".into(), "meetings/decided".into(), decided),
            ("other".into(), "meetings/a".into(), other),
        ]
    );
    let flags = |id: u64| {
        let r = rows.iter().find(|r| r.id == id).unwrap();
        (
            r.withdrawn,
            r.outcome_stamped,
            r.superseded,
            r.referenced,
            r.open_loop,
        )
    };
    assert_eq!(flags(a1), (true, false, false, false, false));
    assert_eq!(flags(a2), (false, false, false, false, false));
    assert_eq!(flags(decided), (false, true, false, false, false));
    assert_eq!(
        rows.iter().find(|r| r.id == a2).unwrap().context.as_deref(),
        Some("from the notes")
    );

    let one = store
        .list_label_fact_candidates(&query(&["default"], Some("meetings/b")))
        .unwrap();
    assert_eq!(one.iter().map(|r| r.id).collect::<Vec<_>>(), vec![b]);
    assert!(
        store
            .list_label_fact_candidates(&query(&[], None))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn segmented_pages_and_audit_markers() {
    let (_d, store) = brain("label-segmented");
    page(&store, "default", "meetings/inline", "**Date:** 2026-09-28");
    let meta: SegmentedPageMeta = args(json!({ "type": "note", "title": "seg" }));
    store
        .create_segmented_page_shell(
            "meetings/seg",
            &meta,
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    store
        .create_segmented_page_shell(
            "meetings/seg-decided",
            &meta,
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    fact(&store, "default", "meetings/inline", "inline", json!({}));
    fact(&store, "default", "meetings/seg", "one", json!({}));
    fact(&store, "default", "meetings/seg", "two", json!({}));
    fact(
        &store,
        "default",
        "meetings/seg-decided",
        "decided",
        json!({}),
    );
    fact(
        &store,
        "default",
        "meetings/seg-decided",
        "audit",
        json!({ "source": "audit:t", "context": "extractor_version=3" }),
    );

    let pages = store
        .list_segmented_label_pages(&query(&["default"], None))
        .unwrap();
    let seen: Vec<(String, u64)> = pages.iter().map(|p| (p.slug.clone(), p.n)).collect();
    assert_eq!(seen, vec![("meetings/seg".into(), 2)]);
    assert!(
        store
            .list_segmented_label_pages(&query(&["other"], None))
            .unwrap()
            .is_empty()
    );

    let marker = |slug: &str, sources: &[&str]| {
        store
            .has_active_audit_marker(&args::<AuditMarkerArgs>(
                json!({ "sourceId": "default", "slug": slug, "sources": sources }),
            ))
            .unwrap()
    };
    assert!(marker("meetings/seg-decided", &["audit:t", "audit:legacy"]));
    assert!(!marker("meetings/seg-decided", &["audit:legacy"]));
    assert!(!marker("meetings/seg", &["audit:t"]));
    let nul: AuditMarkerArgs =
        args(json!({ "sourceId": "default", "slug": "a\u{0}b", "sources": [] }));
    assert!(store.has_active_audit_marker(&nul).is_err());
}
