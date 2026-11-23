//! Entity and mention reads the CLI made through `executeRaw`: what the store answers with no
//! mention state, and the PGLite rules for sibling titles, retired pages and privacy labels.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::entities::{MentionDueQuery, SiblingCandidateQuery};
use gbrain_store::facts::PrivacyPolicy;
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
fn with_no_pass_run_every_live_page_is_due() {
    let dir = TempDir::new("cli-mentions");
    let store = seeded(&dir);
    assert_eq!(store.read_mention_last_pass(None).unwrap(), None);
    assert_eq!(store.read_mention_last_pass(Some("default")).unwrap(), None);
    let due = |source: Option<&str>| {
        store
            .count_pages_due_for_mentions(&MentionDueQuery {
                source_id: source.map(String::from),
                mention_version: 7,
                aliases: None,
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
                    exclude_private: None,
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
fn sibling_candidates_skip_private_pages_under_the_policy() {
    let dir = TempDir::new("cli-siblings-private");
    let store = seeded(&dir);
    let page = |fm: Value| json!({"type": "person", "title": "Ada", "compiled_truth": "body", "frontmatter": fm});
    put(
        &store,
        "default",
        "people/ada-private",
        page(json!({"visibility": "private"})),
    );
    put(
        &store,
        "default",
        "people/ada-restricted",
        page(json!({"access": "restricted"})),
    );
    let read = |exclude_private: Option<PrivacyPolicy>| -> Vec<String> {
        store
            .read_identity_sibling_candidates(
                "default",
                &SiblingCandidateQuery {
                    types: vec!["person".into()],
                    subject: "ada".into(),
                    limit: 10,
                    exclude_quarantined: false,
                    exclude_private,
                },
            )
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    assert_eq!(read(None).len(), 5);
    let honored = read(Some(PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }));
    assert_eq!(honored, ["people/ada", "people/ada-2", "people/ada-q"]);
    let visibility_only = read(Some(PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
        ..Default::default()
    }));
    assert!(visibility_only.contains(&"people/ada-restricted".to_string()));
    assert!(!visibility_only.contains(&"people/ada-private".to_string()));
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

#[test]
fn retirement_hop_reads_retirement_and_target() {
    let dir = TempDir::new("cli-hop");
    let store = seeded(&dir);
    let hop = |slug: &str| store.read_retirement_hop("default", slug, None).unwrap();
    let ada = hop("people/ada").unwrap();
    assert!(!ada.retired);
    assert_eq!(ada.target, None);
    assert_eq!(ada.page_type, "person");
    let merged = hop("people/merged").unwrap();
    assert!(merged.retired);
    assert_eq!(merged.target.as_deref(), Some("people/ada"));
    // Retired by status alone: no target to follow.
    let old = hop("people/old").unwrap();
    assert!(old.retired);
    assert_eq!(old.target, None);
    // A blank `merged_into` neither retires the page nor names a target.
    let blank = hop("people/blank").unwrap();
    assert!(!blank.retired);
    assert_eq!(blank.target, None);
    assert_eq!(hop("people/ghost"), None);
    assert_eq!(
        store
            .read_retirement_hop("no-such-source", "people/ada", None)
            .unwrap(),
        None
    );
}

#[test]
fn entity_card_rows_match_the_title_slugs_and_like_pattern() {
    use gbrain_store::cli_reads::entities::EntityCardMatch;
    let dir = TempDir::new("cli-card");
    let store = seeded(&dir);
    let page = |title: &str, body: &str| json!({"type": "person", "title": title, "compiled_truth": body, "frontmatter": {}});
    put(
        &store,
        "default",
        "people/under_score",
        page("Under", "Under body."),
    );
    put(&store, "default", "people/underxscore", page("ÉLAN", "x"));
    let long = "é".repeat(70_000);
    put(&store, "default", "people/long", page("Long", &long));
    let slugs = |m: EntityCardMatch| {
        let mut out: Vec<String> = store
            .read_entity_card_rows("default", &m, None)
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect();
        out.sort();
        out
    };
    // `_` is a LIKE wildcard; `lower(title)` folds É.
    assert_eq!(
        slugs(EntityCardMatch::Name {
            title_lc: "élan".into(),
            slugs: vec!["people/ada".into()],
            slug_like: "%/under_score".into(),
        }),
        vec!["people/ada", "people/under_score", "people/underxscore"]
    );
    assert_eq!(
        slugs(EntityCardMatch::Slugs {
            slugs: vec!["people/merged".into(), "people/missing".into()],
        }),
        vec!["people/merged"]
    );
    let rows = store
        .read_entity_card_rows(
            "default",
            &EntityCardMatch::Slugs {
                slugs: vec!["people/long".into()],
            },
            None,
        )
        .unwrap();
    let body = rows[0].compiled_truth.as_deref().unwrap();
    assert_eq!(body.chars().count(), 65_536);
    assert_eq!(rows[0].last_retrieved_at, None);
    assert!(
        store
            .read_entity_card_rows(
                "other",
                &EntityCardMatch::Slugs {
                    slugs: vec!["people/merged".into()],
                },
                None,
            )
            .unwrap()
            .is_empty()
    );
}
