//! The Git-gap census reads (lane 17): the live page count and batches, the --newest pages, and the
//! source-wide link and hold counts in byte order of their keys.

mod common;

use common::{TempDir, open};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &gbrain_store::Store, slug: &str) {
    let input = PageInput {
        compiled_truth: format!("{slug} body"),
        ..PageInput::default()
    };
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

#[test]
fn census_counts_links_and_holds_by_byte_key() {
    let dir = TempDir::new("git-gap-census-counts");
    let store = open(&dir);
    put(&store, "notes/a");
    put(&store, "notes/b");
    let source = store.read_git_gap_source_row("default").unwrap().unwrap();
    let incarnation = source["incarnation"].as_str().unwrap().to_string();
    assert!(store.read_git_gap_source_row("missing").unwrap().is_none());
    for key in ["ab", "a0", "a-z", "frontmatter"] {
        let options = AddLinkOptions {
            link_type: Some(format!("t-{key}")),
            link_source: Some(key.into()),
            ..AddLinkOptions::default()
        };
        store.add_link("notes/a", "notes/b", &options).unwrap();
    }
    for key in ["ab", "a0", "a-z"] {
        let record = json!([{ "source_id": "default", "incarnation": incarnation, "path": format!("notes/{key}.md"), "code": key }]);
        store
            .put_op_checkpoint_row(
                "sync-hold",
                &format!("default:{incarnation}:notes/{key}.md"),
                record,
            )
            .unwrap();
    }
    // A hold of another incarnation does not count.
    store
        .put_op_checkpoint_row(
            "sync-hold",
            "default:old:notes/x.md",
            json!([{ "source_id": "default", "incarnation": "old", "code": "zz" }]),
        )
        .unwrap();
    let rows = store
        .read_git_gap_source_rows("default", &["frontmatter".into()], "sync-hold")
        .unwrap();
    assert_eq!(
        rows["links"],
        json!([{ "link_source": "a-z", "n": 1 }, { "link_source": "a0", "n": 1 }, { "link_source": "ab", "n": 1 }])
    );
    assert_eq!(
        rows["holds"],
        json!([{ "code": "a-z", "n": 1 }, { "code": "a0", "n": 1 }, { "code": "ab", "n": 1 }])
    );
    assert_eq!(rows["parked"], json!([]));
    assert_eq!(rows["unfenced"], json!(0));
    assert_eq!(rows["fencePageMissing"], json!(0));
}

#[test]
fn census_batches_and_newest_pages_read_live_pages_by_id() {
    let dir = TempDir::new("git-gap-census-batches");
    let store = open(&dir);
    for slug in ["c", "a", "b"] {
        put(&store, slug);
    }
    assert_eq!(store.count_git_gap_live_pages("default").unwrap(), 3);
    let batch = store
        .read_git_gap_page_batch("default", Some("0"), None, false)
        .unwrap();
    let slugs: Vec<&str> = batch.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["c", "a", "b"]);
    let first = batch[0]["id"].as_str().unwrap().to_string();
    let after = store
        .read_git_gap_page_batch("default", Some(&first), None, false)
        .unwrap();
    assert_eq!(after.len(), 2);
    let ids = [batch[2]["id"].as_str().unwrap().to_string()];
    let named = store
        .read_git_gap_page_batch("default", None, Some(&ids), false)
        .unwrap();
    assert_eq!(named.len(), 1);
    assert_eq!(named[0]["slug"], json!("b"));
    assert_eq!(named[0]["lineage_private"], json!(false));
    let newest = store.list_git_gap_newest_pages("default", 2).unwrap();
    assert_eq!(newest.len(), 2);
    let stamp = newest[0]["updated_at"].as_str().unwrap();
    assert_eq!(stamp.len(), 20);
    assert!(stamp.ends_with('Z'));
    assert!(
        store
            .read_git_gap_page_batch("default", Some("x"), None, false)
            .is_err()
    );
    assert_eq!(
        store.count_git_gap_timeline_on_pages(&[1, 1, -1]).unwrap(),
        0
    );
    assert_eq!(
        store
            .count_git_gap_facts_on_pages("default", &["a".into()])
            .unwrap(),
        0
    );
    assert_eq!(store.count_git_gap_unread_facts("default", &[]).unwrap(), 0);
}
