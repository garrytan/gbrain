//! Entity and mention reads the CLI made through `executeRaw`: what the store answers with no
//! mention state, and the PGLite rules for sibling titles, retired pages and privacy labels.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::entities::{
    MentionDueQuery, NameVariantCandidateQuery, PageRetirementRow, SiblingCandidateQuery,
};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::links::AddLinkOptions;
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
fn slug_pattern_pages_are_live_unretired_and_capped() {
    let dir = TempDir::new("cli-slug-patterns");
    let store = seeded(&dir);
    let patterns = vec!["people/ada%".to_string(), "people/m%".to_string()];
    let slugs = |limit: u64| {
        store
            .list_unretired_pages_by_slug_pattern("default", &patterns, limit)
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect::<Vec<_>>()
    };
    assert_eq!(slugs(10), ["people/ada", "people/ada-2", "people/ada-q"]);
    assert_eq!(slugs(2), ["people/ada", "people/ada-2"]);
    assert_eq!(slugs(0), Vec::<String>::new());
}

#[test]
fn name_variant_candidates_rank_by_probe_hits_then_title_length() {
    let dir = TempDir::new("cli-name-variants");
    let store = seeded(&dir);
    let rows = store
        .list_name_variant_candidates(
            "default",
            &NameVariantCandidateQuery {
                types: vec!["company".into()],
                slug_patterns: vec!["people/%".into()],
                probes: vec!["%ADA%".into(), "%founder%".into()],
                limit: 10,
            },
        )
        .unwrap();
    let got: Vec<(&str, u64)> = rows
        .iter()
        .map(|r| (r.slug.as_str(), r.probe_hits))
        .collect();
    assert_eq!(
        got,
        [
            ("people/ada-2", 2),
            ("companies/ada", 1),
            ("people/ada", 1),
            ("people/ada-q", 1)
        ]
    );
    assert_eq!(rows[2].frontmatter.get("identity"), Some(&json!("ada-1")));
}

#[test]
fn page_retirement_reads_the_trimmed_redirect_of_a_live_page() {
    let dir = TempDir::new("cli-retirement");
    let store = seeded(&dir);
    let read = |slug: &str| store.read_page_retirement("default", slug).unwrap();
    let row = |slug: &str, retired: bool, target: Option<&str>| PageRetirementRow {
        slug: slug.into(),
        page_type: "person".into(),
        retired,
        target: target.map(String::from),
    };
    assert_eq!(
        read("people/merged"),
        Some(row("people/merged", true, Some("people/ada")))
    );
    assert_eq!(read("people/blank"), Some(row("people/blank", false, None)));
    assert_eq!(read("people/old"), Some(row("people/old", true, None)));
    assert_eq!(read("people/ada"), Some(row("people/ada", false, None)));
    assert_eq!(read("people/nc"), None);
    assert_eq!(read("people/ghost"), None);
}

#[test]
fn inbound_linkers_count_each_linking_page_once() {
    let dir = TempDir::new("cli-inbound-linkers");
    let store = seeded(&dir);
    for (from, link_type) in [
        ("notes/plain", "mentions"),
        ("notes/plain", "cites"),
        ("notes/label", "cites"),
    ] {
        let opts = AddLinkOptions {
            link_type: Some(link_type.into()),
            link_source: Some("manual".into()),
            ..Default::default()
        };
        store.add_link(from, "people/ada", &opts).unwrap();
    }
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rows = store
        .count_distinct_inbound_linkers(
            &ids(&["default", "default", "default", "other"]),
            &ids(&["people/ada", "people/ada", "people/old", "people/ada"]),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].source_id.as_str(), rows[0].slug.as_str(), rows[0].n),
        ("default", "people/ada", 2)
    );
    assert!(
        store
            .count_distinct_inbound_linkers(&[], &[])
            .unwrap()
            .is_empty()
    );
}
