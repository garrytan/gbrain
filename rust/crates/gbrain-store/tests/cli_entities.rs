//! Entity and mention reads the CLI made through `executeRaw`: what the store answers with no
//! mention state, and the PGLite rules for sibling titles, retired pages and privacy labels.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::entities::{MentionDueQuery, SiblingCandidateQuery};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, page: Value) {
    let input: PageInput = serde_json::from_value(page).unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    let page = |t: &str, title: &str, fm: Value| json!({"type": t, "title": title, "compiled_truth": "body", "frontmatter": fm});
    put(
        &store,
        "default",
        "people/ada",
        page("person", "Ada", json!({"identity": "ada-1"})),
    );
    put(
        &store,
        "default",
        "people/ada-2",
        page(
            "person",
            "Founder: ada",
            json!({"identity": {"b": 1, "a": [true]}}),
        ),
    );
    put(
        &store,
        "default",
        "people/ada-q",
        page("person", "Ada", json!({"quarantine": true})),
    );
    put(
        &store,
        "default",
        "companies/ada",
        page("company", "Ada", json!({})),
    );
    put(
        &store,
        "default",
        "people/old",
        page("person", "Old", json!({"status": "Redirect"})),
    );
    put(
        &store,
        "default",
        "people/merged",
        page("person", "M", json!({"merged_into": "people/ada"})),
    );
    put(
        &store,
        "default",
        "people/blank",
        page(
            "person",
            "B",
            json!({"merged_into": "  ", "canonical": true}),
        ),
    );
    put(
        &store,
        "default",
        "people/nc",
        page("person", "N", json!({"canonical": false})),
    );
    put(
        &store,
        "default",
        "people/aliases",
        page("person", "A", json!({"status": "aliases"})),
    );
    put(
        &store,
        "default",
        "notes/label",
        page("note", "L", json!({"access": "team-only"})),
    );
    put(
        &store,
        "default",
        "notes/readers",
        page("note", "R", json!({"access": "x", "readable_by": ["a"]})),
    );
    put(
        &store,
        "default",
        "notes/plain",
        page("note", "P", json!({})),
    );
    put(
        &store,
        "other",
        "people/ada",
        page("person", "Ada", json!({})),
    );
    store
        .soft_delete_page("people/nc", Some("default"))
        .unwrap();
    store
}

#[test]
fn mention_state_is_absent_so_every_live_page_is_due() {
    let dir = TempDir::new("cli-mentions");
    let store = seeded(&dir);
    assert_eq!(store.read_mention_last_pass(None).unwrap(), None);
    assert_eq!(store.read_mention_last_pass(Some("default")).unwrap(), None);
    let due = |source: Option<&str>| {
        store
            .count_pages_due_for_mentions(&MentionDueQuery {
                source_id: source.map(String::from),
            })
            .unwrap()
    };
    assert_eq!(due(Some("default")), 11);
    assert_eq!(due(Some("other")), 1);
    assert_eq!(due(Some("ghost")), 0);
    assert_eq!(due(None), 12);
}

#[test]
fn sibling_candidates_match_the_title_or_its_suffix_by_slug() {
    let dir = TempDir::new("cli-siblings");
    let store = seeded(&dir);
    let read = |limit: u64, exclude_quarantined: bool| {
        store
            .read_identity_sibling_candidates(
                "default",
                &SiblingCandidateQuery {
                    types: vec!["person".into()],
                    subject: "ada".into(),
                    limit,
                    exclude_quarantined,
                },
            )
            .unwrap()
    };
    let rows = read(10, false);
    let slugs: Vec<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, ["people/ada", "people/ada-2", "people/ada-q"]);
    assert_eq!(rows[0].identity.as_deref(), Some("ada-1"));
    assert_eq!(
        rows[1].identity.as_deref(),
        Some(r#"{"a": [true], "b": 1}"#)
    );
    assert_eq!(rows[2].identity, None);
    assert_eq!(read(10, true).len(), 2);
    assert_eq!(read(1, false).len(), 1);
}

#[test]
fn exact_slug_splits_live_and_retired_pages() {
    let dir = TempDir::new("cli-exact");
    let store = seeded(&dir);
    let find = |slug: &str, retired: bool| {
        store
            .find_exact_slug("default", &[slug.to_string()], Some(retired))
            .unwrap()
    };
    assert_eq!(find("people/ada", false).as_deref(), Some("people/ada"));
    assert_eq!(find("people/ada", true), None);
    for retired in ["people/old", "people/merged"] {
        assert_eq!(find(retired, true).as_deref(), Some(retired));
        assert_eq!(find(retired, false), None);
    }
    for live in ["people/blank", "people/aliases"] {
        assert_eq!(find(live, false).as_deref(), Some(live));
    }
    assert_eq!(find("people/nc", false), None);
    assert_eq!(find("people/nc", true), None);
    assert_eq!(find("people/ghost", false), None);
    // Several slugs: the first live one in the given order, retired or not when no filter is set.
    let any = |slugs: &[&str]| {
        let slugs: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
        store.find_exact_slug("default", &slugs, None).unwrap()
    };
    assert_eq!(
        any(&["people/ghost", "people/old", "people/ada"]).as_deref(),
        Some("people/old")
    );
    assert_eq!(
        any(&["people/nc", "people/ada"]).as_deref(),
        Some("people/ada")
    );
    assert_eq!(any(&["people/ghost"]), None);
    assert_eq!(any(&[]), None);
}

#[test]
fn label_pages_carry_a_label_key_and_no_readers() {
    let dir = TempDir::new("cli-labels");
    let store = seeded(&dir);
    let scope = |v: Value| serde_json::from_value(v).unwrap();
    let rows = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"slugs": ["notes/label", "notes/readers", "notes/plain"]})),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].frontmatter["access"], json!("team-only"));
    let since = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"since": "2000-01-01T00:00:00Z"})),
        )
        .unwrap();
    assert_eq!(since.len(), 1);
    let none = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"since": "2999-01-01T00:00:00Z"})),
        )
        .unwrap();
    assert!(none.is_empty());
    assert!(
        store
            .read_ignored_privacy_label_pages("default", &scope(json!({"since": "yesterday"})))
            .is_err()
    );
}
