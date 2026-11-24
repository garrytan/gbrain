//! The mention pass's records (mention_state.rs): status rows, page state, saved entries, the due tests the reads use,
//! the plain-mention link deletes, and the cascades of a page and a source delete.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::entities::MentionDueQuery;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::mention_state::{EntryKeyRow, MentionStatusPatch, PageRevisionInput};
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, page_type: &str, body: &str) -> (i64, String) {
    let input: PageInput = serde_json::from_value(
        json!({"type": page_type, "title": slug, "compiled_truth": body, "frontmatter": {}}),
    )
    .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    let rows = store
        .read_page_stamp_times(&[slug.to_owned()], &["default".to_owned()])
        .unwrap();
    assert_eq!(rows.len(), 1);
    let rev = store.read_page_revision_for_share("default", slug).unwrap();
    let revision = rev[0]["revision"].as_str().unwrap().to_owned();
    let due = store.list_mention_due_pages("default", 7, 0, 100).unwrap();
    let id = due
        .iter()
        .find(|p| p.slug == slug)
        .map(|p| p.id as i64)
        .unwrap();
    (id, revision)
}

fn patch(
    state: &str,
    pending: Option<i64>,
    bump: bool,
    fingerprint: Option<&str>,
    set: bool,
) -> MentionStatusPatch {
    serde_json::from_value(json!({
        "state": state, "pending": pending, "bumpGeneration": bump, "fingerprint": fingerprint, "setFingerprint": set,
    }))
    .unwrap()
}

fn due(store: &Store) -> u64 {
    let q: MentionDueQuery =
        serde_json::from_value(json!({ "sourceId": "default", "mentionVersion": 7 })).unwrap();
    store.count_pages_due_for_mentions(&q).unwrap()
}

#[test]
fn status_rows_bump_generations_keep_fingerprints_and_refuse_bad_states() {
    let dir = TempDir::new("mention-status");
    let store = open(&dir);
    let ids = vec!["default".to_owned()];
    assert_eq!(
        store.read_mention_generations(&ids).unwrap(),
        Vec::<Value>::new()
    );
    store
        .write_mention_index_status(
            "default",
            &patch("pending", Some(3), true, Some("fp;1"), true),
        )
        .unwrap();
    store
        .write_mention_index_status("default", &patch("complete", None, true, None, false))
        .unwrap();
    assert_eq!(
        store.read_mention_generations(&ids).unwrap(),
        vec![json!({ "source_id": "default", "generation": "2" })]
    );
    assert_eq!(
        store.read_mention_status_states(&ids).unwrap(),
        vec![json!({ "source_id": "default", "state": "complete" })]
    );
    assert_eq!(
        store.read_mention_policy_fingerprints(&ids).unwrap(),
        vec![json!({ "source_id": "default", "policy_fingerprint": "fp;1" })]
    );
    assert!(
        store
            .write_mention_index_status("default", &patch("bogus", None, false, None, false))
            .is_err()
    );
    assert!(
        store
            .write_mention_index_status("missing", &patch("pending", None, false, None, false))
            .is_err()
    );
    assert_eq!(store.read_mention_last_pass(Some("default")).unwrap(), None);
}

#[test]
fn a_tail_reset_marks_the_pages_after_an_id_and_the_listed_pages_due() {
    let dir = TempDir::new("mention-tail-reset");
    let store = open(&dir);
    let (a, rev_a) = put(&store, "notes/a", "note", "Alpha");
    let (b, rev_b) = put(&store, "notes/b", "note", "Beta");
    let (c, rev_c) = put(&store, "notes/c", "note", "Gamma");
    let pages = vec![
        PageRevisionInput {
            id: a,
            revision: rev_a,
        },
        PageRevisionInput {
            id: b,
            revision: rev_b,
        },
        PageRevisionInput {
            id: c,
            revision: rev_c,
        },
    ];
    store
        .upsert_page_mention_state("default", &pages, 7, "4")
        .unwrap();
    assert_eq!(due(&store), 0);
    // Pages after b: only c. The source rows before it stay current.
    store
        .reset_mention_revisions(Some(&["default".to_string()]), Some(&[]), Some(b))
        .unwrap();
    assert_eq!(due(&store), 1);
    // The listed pages join the tail.
    store
        .upsert_page_mention_state("default", &pages, 7, "4")
        .unwrap();
    store
        .reset_mention_revisions(Some(&["default".to_string()]), Some(&[a]), Some(b))
        .unwrap();
    assert_eq!(due(&store), 2);
    // Another source's pages are not in the tail.
    store
        .upsert_page_mention_state("default", &pages, 7, "4")
        .unwrap();
    store
        .reset_mention_revisions(Some(&["other".to_string()]), Some(&[]), Some(0))
        .unwrap();
    assert_eq!(due(&store), 0);
}

#[test]
fn page_state_makes_a_page_current_until_its_content_or_a_reset_moves_it() {
    let dir = TempDir::new("mention-page-state");
    let store = open(&dir);
    let (a, rev_a) = put(&store, "notes/a", "note", "Alpha");
    let (b, rev_b) = put(&store, "notes/b", "note", "Beta");
    assert_eq!(due(&store), 2);
    let pages = vec![
        PageRevisionInput {
            id: a,
            revision: rev_a.clone(),
        },
        PageRevisionInput {
            id: b,
            revision: rev_b,
        },
    ];
    store
        .upsert_page_mention_state("default", &pages, 7, "4")
        .unwrap();
    assert_eq!(due(&store), 0);
    store
        .reset_mention_revisions(None, Some(&[b]), None)
        .unwrap();
    assert_eq!(due(&store), 1);
    put(&store, "notes/a", "note", "Alpha changed");
    assert_eq!(due(&store), 2);
    store
        .reset_source_mention_index_revisions("default")
        .unwrap();
    store.delete_page("notes/a", None).unwrap();
    assert_eq!(due(&store), 1);
    assert!(
        store
            .upsert_page_mention_state(
                "default",
                &[PageRevisionInput {
                    id: a,
                    revision: rev_a
                }],
                7,
                "0"
            )
            .is_err()
    );
}

#[test]
fn entries_and_plain_mention_links_are_kept_and_removed_per_source() {
    let dir = TempDir::new("mention-entries");
    let store = open(&dir);
    put(&store, "people/alice", "person", "Alice");
    put(&store, "notes/n", "note", "Alice wrote this");
    let entry = |n: &str, t: &str| EntryKeyRow {
        source_id: "default".into(),
        name_norm: n.into(),
        target_slug: t.into(),
        case_sensitive: false,
    };
    store
        .apply_gazetteer_entry_changes(
            "default",
            &[],
            &[entry("alice", "people/alice"), entry("al", "people/alice")],
        )
        .unwrap();
    store
        .apply_gazetteer_entry_changes("default", &[entry("al", "people/alice")], &[])
        .unwrap();
    assert_eq!(
        store.list_gazetteer_entry_keys("default").unwrap(),
        vec![entry("alice", "people/alice")]
    );
    let link = |source: &str| AddLinkOptions {
        link_type: Some("mentions".into()),
        link_source: Some(source.into()),
        ..Default::default()
    };
    store
        .add_link("notes/n", "people/alice", &link("mentions"))
        .unwrap();
    assert_eq!(
        store.list_mention_link_origins("default").unwrap(),
        vec![json!({ "slug": "notes/n" })]
    );
    assert_eq!(
        store
            .delete_source_mention_links("default", None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.list_mention_link_origins("default").unwrap(),
        Vec::<Value>::new()
    );
    store
        .add_link("notes/n", "people/alice", &link("manual"))
        .unwrap();
    assert_eq!(
        store
            .delete_source_mention_links("default", None)
            .unwrap()
            .len(),
        0
    );
    store.clear_mention_source_index("default").unwrap();
    assert_eq!(
        store.list_gazetteer_entry_keys("default").unwrap(),
        Vec::<EntryKeyRow>::new()
    );
}
