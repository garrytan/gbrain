//! `slug_reads.rs`: the slug reads that order by byte.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};

fn source(b: &Brain, id: &str) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        ..SourceInput::default()
    })
    .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str, source_path: Option<&str>) {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: slug.into(),
        source_path: source_path.map(str::to_string),
        ..PageInput::default()
    };
    b.put_page(
        slug,
        &input,
        &PutPageOptions {
            source_id: Some(source_id.into()),
            ..PutPageOptions::default()
        },
    )
    .unwrap();
}

#[test]
fn live_slug_by_path_picks_the_lowest_source_by_byte() {
    let b = brain("slug-reads-live-path");
    for id in ["ab", "a0", "a-z"] {
        source(&b, id);
        page(&b, id, &format!("s{id}"), Some("shared.md"));
    }
    // en_US would pick `a0`; the byte order picks `a-z`.
    assert_eq!(
        b.resolve_live_slug_by_path("shared.md").unwrap(),
        Some("sa-z".into())
    );
}

#[test]
fn live_slug_by_path_skips_deleted_pages_and_other_paths() {
    let b = brain("slug-reads-live-path-deleted");
    source(&b, "other");
    page(&b, "default", "kept", Some("kept.md"));
    page(&b, "other", "gone", Some("gone.md"));
    b.soft_delete_page("gone", Some("other")).unwrap();
    assert_eq!(b.resolve_live_slug_by_path("gone.md").unwrap(), None);
    assert_eq!(b.resolve_live_slug_by_path("missing.md").unwrap(), None);
    assert_eq!(
        b.resolve_live_slug_by_path("kept.md").unwrap(),
        Some("kept".into())
    );
    assert!(b.resolve_live_slug_by_path("a\0b").is_err());
}

fn typed(b: &Brain, source_id: &str, slug: &str, page_type: &str) {
    let input = PageInput {
        page_type: page_type.into(),
        title: slug.into(),
        compiled_truth: slug.into(),
        ..PageInput::default()
    };
    b.put_page(
        slug,
        &input,
        &PutPageOptions {
            source_id: Some(source_id.into()),
            ..PutPageOptions::default()
        },
    )
    .unwrap();
}

#[test]
fn unarchived_slug_sources_list_live_holders_by_byte() {
    let b = brain("slug-reads-unarchived-sources");
    for id in ["ab", "a0", "a-z", "gone", "dead"] {
        source(&b, id);
        page(&b, id, "notes/shared", None);
    }
    b.set_source_archived("gone", true).unwrap();
    b.soft_delete_page("notes/shared", Some("dead")).unwrap();
    assert_eq!(
        b.list_unarchived_slug_sources("notes/shared").unwrap(),
        vec!["a-z", "a0", "ab"]
    );
    assert!(b.list_unarchived_slug_sources("missing").unwrap().is_empty());
}

#[test]
fn type_counts_and_orphans_follow_the_scope_and_byte_order() {
    let b = brain("slug-reads-type-orphans");
    for id in ["ab", "a-z"] {
        source(&b, id);
        typed(&b, id, "b/two", "");
        typed(&b, id, "a-z", "legacy");
        typed(&b, id, "a/z", "");
        typed(&b, id, "kept", "note");
    }
    b.soft_delete_page("kept", Some("ab")).unwrap();
    let scope: gbrain_store::slug_reads::TypeScope =
        serde_json::from_value(serde_json::json!({ "sourceIds": ["ab", "a-z"] })).unwrap();
    let counts = b.count_live_page_types(&scope).unwrap();
    assert_eq!(
        serde_json::json!(counts),
        serde_json::json!([
            { "type": "", "n": "4" },
            { "type": "legacy", "n": "2" },
            { "type": "note", "n": "1" },
        ])
    );
    let query: gbrain_store::slug_reads::TypeOrphanQuery = serde_json::from_value(
        serde_json::json!({ "scope": { "sourceIds": ["ab", "a-z"] }, "types": ["legacy"], "limit": 4 }),
    )
    .unwrap();
    let rows = b.list_type_orphan_pages(&query).unwrap();
    let pairs: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r["source_id"].as_str().unwrap().into(), r["slug"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("a-z".to_string(), "a-z".to_string()),
            ("a-z".to_string(), "a/z".to_string()),
            ("a-z".to_string(), "b/two".to_string()),
            ("ab".to_string(), "a-z".to_string()),
        ]
    );
    let one_source: gbrain_store::slug_reads::TypeScope =
        serde_json::from_value(serde_json::json!({ "sourceId": "ab" })).unwrap();
    assert_eq!(b.count_live_page_types(&one_source).unwrap().len(), 2);
}

#[test]
fn export_page_rows_carry_live_pages_with_byte_ordered_tags() {
    let b = brain("slug-reads-export-rows");
    let id_of = |slug: &str| {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: slug.into(),
            ..PageInput::default()
        };
        b.put_page(slug, &input, &PutPageOptions::default()).unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    let (tagged, gone) = (id_of("tagged"), id_of("gone"));
    for tag in ["ab", "a/z", "a-z"] {
        b.add_tag("tagged", tag, None).unwrap();
    }
    b.soft_delete_page("gone", None).unwrap();
    let rows = b.read_export_page_rows(&[tagged, tagged, gone, 999_999]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["page"]["slug"], "tagged");
    assert_eq!(rows[0]["tags"], serde_json::json!(["a-z", "a/z", "ab"]));
}
