//! The CLI import reads (cli_reads/import.rs): what each answers from the store's records.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::import::{PageAtRevisionRef, PageTrustKey, PageTrustLookup};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use serde_json::{Value, json};

fn source(store: &Store, id: &str, config: Value) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            config: config.as_object().cloned(),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, frontmatter: Value) -> Value {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.to_uppercase(),
        compiled_truth: format!("body of {slug}"),
        frontmatter: frontmatter.as_object().cloned(),
        ..PageInput::default()
    };
    let options = PutPageOptions {
        source_id: Some(source_id.into()),
        ..PutPageOptions::default()
    };
    store.put_page(slug, &input, &options).unwrap()
}

#[test]
fn source_records_list_default_first_with_archived_and_no_commit_columns() {
    let dir = TempDir::new("cli-reads-sources");
    let store = open(&dir);
    source(&store, "zeta", json!({ "keep": 1 }));
    source(&store, "alpha", json!({}));
    store.set_source_archived("zeta", true).unwrap();
    let rows = store.list_source_records().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["default", "alpha", "zeta"]);
    let zeta = &rows[2];
    assert!(zeta.archived);
    assert_eq!(zeta.last_commit, None);
    assert_eq!(zeta.newest_content_at, None);
    assert_eq!(Value::Object(zeta.config.clone()), json!({ "keep": 1 }));

    let found = store.read_source_incarnation("alpha").unwrap().unwrap();
    assert_eq!(found.incarnation.len(), 36);
    assert!(store.read_source_incarnation("nope").unwrap().is_none());
    assert!(!store.has_company_brain_receipt("alpha").unwrap());
}

#[test]
fn a_guest_source_is_one_whose_config_says_guest() {
    let dir = TempDir::new("cli-reads-guests");
    let store = open(&dir);
    assert!(!store.has_guest_source().unwrap());
    source(&store, "visitors", json!({ "guest": true }));
    source(&store, "texty", json!({ "guest": "true" }));
    source(&store, "plain", json!({ "guest": false }));
    assert!(store.has_guest_source().unwrap());
    let ids = ["plain", "visitors", "texty", "visitors", "missing"].map(String::from);
    assert_eq!(
        store.list_guest_source_ids(&ids).unwrap(),
        ["texty", "visitors"]
    );
    assert!(store.list_guest_source_ids(&[]).unwrap().is_empty());
    let row = store.read_guest_source_row("visitors").unwrap();
    assert!(!row.hidden);
    assert_eq!(row.source_id, None);
}

#[test]
fn page_reads_answer_trust_metadata_and_revisions() {
    let dir = TempDir::new("cli-reads-pages");
    let store = open(&dir);
    source(&store, "visitors", json!({ "guest": true }));
    let a = page(&store, "default", "a", json!({ "aliases": ["Alpha"] }));
    let b = page(&store, "visitors", "b", json!({}));
    page(&store, "default", "gone", json!({}));
    store.soft_delete_page("gone", Some("default")).unwrap();

    let trust = store
        .read_page_trust_rows(&PageTrustLookup {
            ids: vec![a["id"].as_u64().unwrap()],
            keys: vec![
                PageTrustKey {
                    source_id: "visitors".into(),
                    slug: "b".into(),
                },
                PageTrustKey {
                    source_id: "default".into(),
                    slug: "gone".into(),
                },
            ],
            include_deleted: false,
        })
        .unwrap();
    assert_eq!(trust.len(), 2);
    assert!(trust[0].by_id && !trust[0].guest && trust[0].trust_tier == "unknown");
    assert!(!trust[1].by_id && trust[1].guest && trust[1].slug == "b");
    let with_deleted = store
        .read_page_trust_rows(&PageTrustLookup {
            keys: vec![PageTrustKey {
                source_id: "default".into(),
                slug: "gone".into(),
            }],
            include_deleted: true,
            ..PageTrustLookup::default()
        })
        .unwrap();
    assert_eq!(with_deleted.len(), 1);

    let all = store.list_link_page_metadata(None).unwrap();
    let keys: Vec<(&str, &str)> = all
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str()))
        .collect();
    assert_eq!(keys, [("default", "a"), ("visitors", "b")]);
    assert_eq!(all[0].aliases, json!(["Alpha"]));
    assert_eq!(all[1].aliases, Value::Null);
    assert_eq!(
        store
            .list_link_page_metadata(Some("visitors"))
            .unwrap()
            .len(),
        1
    );

    let revision = b["knowledge_revision"].as_str().unwrap().to_string();
    let at = store
        .filter_pages_at_revision(&[
            PageAtRevisionRef {
                source_id: "visitors".into(),
                slug: "b".into(),
                revision,
            },
            PageAtRevisionRef {
                source_id: "default".into(),
                slug: "a".into(),
                revision: "stale".into(),
            },
        ])
        .unwrap();
    assert_eq!(at.len(), 1);
    assert_eq!(at[0].slug, "b");
}

#[test]
fn stored_timeline_rows_are_the_page_rows_by_id_and_the_clock_is_iso() {
    let dir = TempDir::new("cli-reads-timeline");
    let store = open(&dir);
    page(&store, "default", "a", json!({}));
    for (date, summary) in [("2026-02-01", "second"), ("2026-01-01", "first")] {
        let entry = TimelineInput {
            date: Some(date.into()),
            summary: Some(summary.into()),
            ..TimelineInput::default()
        };
        store
            .add_timeline_entry("a", &entry, &AddTimelineOptions::default())
            .unwrap();
    }
    let rows = store.list_stored_timeline_rows("default", "a").unwrap();
    let summaries: Vec<&str> = rows.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(summaries, ["second", "first"]);
    assert!(rows[0].id < rows[1].id);
    assert!(
        store
            .list_stored_timeline_rows("default", "missing")
            .unwrap()
            .is_empty()
    );

    let clock = store.read_database_clock().unwrap();
    assert_eq!(clock.len(), "2026-01-01T00:00:00.000000Z".len());
    assert!(clock.ends_with('Z'));
}
