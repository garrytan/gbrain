//! The meetings connector's page lookup and link extraction's attendance lookup (`meeting_pages.rs`). The three-arm
//! cases are test/engine-parity/meeting-pages.test.ts and attendance-pages.test.ts; these pin the lowest-id pick, the
//! live-page filter, the type filter and the `lower()` title and alias match.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(store: &Store, slug: &str, page_type: &str, title: &str, frontmatter: Value) {
    let input = json!({ "type": page_type, "title": title, "compiled_truth": format!("{title} body."), "timeline": "", "frontmatter": frontmatter });
    let options: PutPageOptions = args(json!({ "sourceId": "default" }));
    store
        .put_page(slug, &args::<PageInput>(input), &options)
        .unwrap();
}

#[test]
fn a_meeting_reads_its_lowest_id_live_page() {
    let dir = TempDir::new("meeting-pages-read");
    let store = open(&dir);
    page(
        &store,
        "meetings/b",
        "meeting",
        "B",
        json!({ "meeting_id": "m-1" }),
    );
    page(
        &store,
        "meetings/a",
        "meeting",
        "A",
        json!({ "meeting_id": "m-1" }),
    );
    page(
        &store,
        "meetings/n",
        "meeting",
        "N",
        json!({ "meeting_id": 42 }),
    );
    assert_eq!(
        store.read_meeting_page("default", "m-1").unwrap(),
        json!({ "slug": "meetings/b", "source_path": null })
    );
    assert_eq!(
        store.read_meeting_page("default", "42").unwrap()["slug"],
        json!("meetings/n")
    );
    assert_eq!(
        store.read_meeting_page("default", "m-2").unwrap(),
        Value::Null
    );
    assert_eq!(
        store.read_meeting_page("other", "m-1").unwrap(),
        Value::Null
    );
}

#[test]
fn attendance_matches_person_pages_by_slug_title_or_alias_ignoring_case() {
    let dir = TempDir::new("meeting-pages-attendance");
    let store = open(&dir);
    page(&store, "people/alice", "person", "Alice Example", json!({}));
    page(
        &store,
        "people/bob",
        "person",
        "Robert",
        json!({ "aliases": ["Bobby", 7] }),
    );
    page(&store, "people/sam-a", "person", "Sam", json!({}));
    page(&store, "people/sam-b", "person", "SAM", json!({}));
    page(&store, "people/sam-c", "person", "sam", json!({}));
    page(&store, "notes/erin", "note", "Erin", json!({}));
    let slugs = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let m = |s: &[&str], name: &str| {
        store
            .list_attendance_matches("default", &slugs(s), name)
            .unwrap()
    };
    assert_eq!(m(&["people/alice"], "nobody"), vec!["people/alice"]);
    assert_eq!(m(&[], "ALICE example"), vec!["people/alice"]);
    assert_eq!(m(&[], "bobby"), vec!["people/bob"]);
    assert_eq!(m(&[], "7"), vec!["people/bob"]);
    assert_eq!(m(&[], "sam"), vec!["people/sam-a", "people/sam-b"]);
    assert!(m(&[], "Erin").is_empty());
    assert!(
        store
            .list_attendance_matches("other", &slugs(&["people/alice"]), "Alice Example")
            .unwrap()
            .is_empty()
    );
}
