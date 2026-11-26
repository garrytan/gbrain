//! The entity resolver's page reads (`entities/resolve.ts`): live pages only, per source, each
//! slug once, the caps, and the retired-page and privacy filters where the resolver applies them.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, page: Value) {
    let input: PageInput = serde_json::from_value(page).unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn page(t: &str, title: &str, fm: Value) -> Value {
    json!({"type": t, "title": title, "compiled_truth": format!("{title} body."), "frontmatter": fm})
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    let rows = [
        (
            "default",
            "companies/acme",
            page("company", "Acme", json!({})),
        ),
        (
            "default",
            "orgs/acme",
            page("company", "Acme Org", json!({})),
        ),
        (
            "default",
            "organizations/acme",
            page(
                "company",
                "Acme Organization",
                json!({"merged_into": "companies/acme"}),
            ),
        ),
        (
            "default",
            "people/alice-example",
            page("person", "Alice Example", json!({})),
        ),
        (
            "default",
            "companies/alice-example",
            page("company", "Alice Example Co", json!({})),
        ),
        ("default", "people/gone", page("person", "Gone", json!({}))),
        ("other", "orgs/widget", page("company", "Widget", json!({}))),
    ];
    for (source, slug, p) in rows {
        put(&store, source, slug, p);
    }
    store
        .soft_delete_page("people/gone", Some("default"))
        .unwrap();
    store
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[test]
fn the_live_slug_read_names_live_pages_once_and_stops_at_its_cap() {
    let dir = TempDir::new("resolve-live-slugs");
    let store = seeded(&dir);
    let all = strings(&[
        "companies/acme",
        "orgs/acme",
        "organizations/acme",
        "people/gone",
        "orgs/widget",
        "people/missing",
        "companies/acme",
    ]);
    assert_eq!(
        store.read_live_slugs("default", &all, None).unwrap(),
        strings(&["companies/acme", "orgs/acme", "organizations/acme"])
    );
    assert_eq!(
        store
            .read_live_slugs("other", &strings(&["orgs/widget", "companies/acme"]), None)
            .unwrap(),
        strings(&["orgs/widget"])
    );
    assert_eq!(
        store
            .read_live_slugs("default", &all, Some(2))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .read_live_slugs(
                "default",
                &strings(&[
                    "people/alice-example",
                    "people/gone",
                    "people/alice-example"
                ]),
                Some(2)
            )
            .unwrap(),
        strings(&["people/alice-example"])
    );
    assert!(
        store
            .read_live_slugs("default", &[], None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_live_page_type_read_applies_the_page_policy() {
    let dir = TempDir::new("resolve-live-types");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/hidden-example",
        page("person", "Hidden Example", json!({"visibility": "private"})),
    );
    let slugs = strings(&[
        "organizations/acme",
        "people/gone",
        "orgs/widget",
        "people/hidden-example",
        "organizations/acme",
    ]);
    let read = |policy: Option<PrivacyPolicy>| -> Vec<(String, String)> {
        store
            .read_live_page_types("default", &slugs, policy.as_ref())
            .unwrap()
            .into_iter()
            .map(|r| (r.slug, r.page_type))
            .collect()
    };
    let company = "company".to_string();
    assert_eq!(
        read(None),
        [
            ("organizations/acme".to_string(), company.clone()),
            ("people/hidden-example".to_string(), "person".to_string()),
        ]
    );
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        read(Some(policy)),
        [("organizations/acme".to_string(), company)]
    );
}

#[test]
fn the_trigram_candidate_read_ranks_live_non_retired_pages_and_scores_only_the_fuzzy_arm() {
    let dir = TempDir::new("resolve-trigram");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/hidden-alice-example",
        page("person", "Alice Example", json!({"visibility": "private"})),
    );
    put(
        &store,
        "default",
        "people/alice-examples",
        page("person", "Alice Example", json!({"canonical": "false"})),
    );
    let slugs = |arm: &str, policy: Option<PrivacyPolicy>| -> Vec<String> {
        store
            .read_trigram_candidates(
                "default",
                arm,
                "alice example",
                "alice-example",
                policy.as_ref(),
            )
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    // Exact-title pages tie at similarity 1 and sort by slug ahead of "Alice Example Co"; the
    // retired duplicate, the deleted page and the other source never appear; a policy hides the
    // private page.
    assert_eq!(
        slugs("near", None),
        strings(&[
            "people/alice-example",
            "people/hidden-alice-example",
            "companies/alice-example",
        ])
    );
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        slugs("same_name", Some(policy)),
        strings(&["people/alice-example", "companies/alice-example"])
    );
    let fuzzy = store
        .read_trigram_candidates("default", "fuzzy", "alice example", "alice-example", None)
        .unwrap();
    assert!(fuzzy.iter().all(|r| r.score.is_some()));
    assert!(
        store
            .read_trigram_candidates("default", "near", "alice example", "x", None)
            .unwrap()
            .iter()
            .all(|r| r.score.is_none())
    );
    assert!(
        store
            .read_trigram_candidates("default", "sideways", "a", "a", None)
            .is_err()
    );
}

#[test]
fn the_prefix_candidate_read_counts_ranking_links_and_chunks() {
    let dir = TempDir::new("resolve-prefix");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/alice-retired",
        page("person", "Alice Retired", json!({"canonical": "no"})),
    );
    put(
        &store,
        "default",
        "people/aliceberg",
        page("person", "Aliceberg", json!({})),
    );
    let read = |patterns: &[&str], limit: usize| -> Vec<(String, i64)> {
        store
            .read_prefix_candidates("default", &strings(patterns), limit)
            .unwrap()
            .into_iter()
            .map(|r| (r.slug, r.connection_count))
            .collect()
    };
    // put_page writes one body chunk per page; the retired page and people/aliceberg (no hyphen)
    // stay out.
    assert_eq!(
        read(&["people/alice", "people/alice-%", "companies/alice-%"], 10),
        [
            ("companies/alice-example".to_string(), 1),
            ("people/alice-example".to_string(), 1),
        ]
    );
    assert_eq!(read(&["people/alice-%", "companies/alice-%"], 1).len(), 1);
}

#[test]
fn the_prefix_directory_read_names_at_most_two_directories() {
    let dir = TempDir::new("resolve-prefix-dirs");
    let store = seeded(&dir);
    let dirs = |patterns: &[&str]| {
        store
            .read_prefix_dirs("default", &strings(patterns))
            .unwrap()
    };
    assert_eq!(dirs(&["people/alice-%"]), strings(&["people"]));
    assert_eq!(
        dirs(&["people/alice-%", "companies/alice-%", "organizations/%"]),
        strings(&["companies", "people"])
    );
    assert!(dirs(&["people/gone"]).is_empty());
}

#[test]
fn the_prefix_title_read_matches_the_name_ignoring_case() {
    let dir = TempDir::new("resolve-prefix-title");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "companies/acme-0",
        page("company", "ACME", json!({})),
    );
    let slugs = |title: &str| -> Vec<String> {
        let mut out: Vec<String> = store
            .read_prefix_title_matches(
                "default",
                &strings(&["companies/acme", "companies/acme-%", "organizations/%"]),
                title,
            )
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect();
        out.sort();
        out
    };
    assert_eq!(
        slugs("acme"),
        strings(&["companies/acme", "companies/acme-0"])
    );
    assert!(slugs("Acme Organization").is_empty());
}

#[test]
fn the_named_entity_read_names_live_non_retired_pages_by_slug_under_the_policy() {
    let dir = TempDir::new("resolve-named");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/hidden-example",
        page("person", "Hidden Example", json!({"visibility": "private"})),
    );
    for n in 1..=6 {
        put(
            &store,
            "default",
            &format!("people/many-{n}"),
            page("person", &format!("Many {n}"), json!({})),
        );
    }
    let slugs = strings(&[
        "orgs/acme",
        "companies/acme",
        "organizations/acme",
        "people/gone",
        "orgs/widget",
        "people/hidden-example",
        "companies/acme",
    ]);
    assert_eq!(
        store
            .read_named_entity_slugs("default", &slugs, None)
            .unwrap(),
        strings(&["companies/acme", "orgs/acme", "people/hidden-example"])
    );
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        store
            .read_named_entity_slugs("default", &slugs, Some(&policy))
            .unwrap(),
        strings(&["companies/acme", "orgs/acme"])
    );
    let many: Vec<String> = (1..=6).rev().map(|n| format!("people/many-{n}")).collect();
    assert_eq!(
        store
            .read_named_entity_slugs("default", &many, None)
            .unwrap(),
        strings(&[
            "people/many-1",
            "people/many-2",
            "people/many-3",
            "people/many-4",
            "people/many-5"
        ])
    );
    assert!(
        store
            .read_named_entity_slugs("default", &[], None)
            .unwrap()
            .is_empty()
    );
}
