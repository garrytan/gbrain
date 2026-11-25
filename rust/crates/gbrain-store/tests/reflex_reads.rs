//! The retrieval reflex's page reads and the proactive brief's entity-page read: the sources, live
//! pages, match kinds, page policy and eligibility the SQL statements apply.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::reflex_reads::{BriefEligibility, ReflexPageMatch};
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
    json!({"type": t, "title": title, "compiled_truth": "body", "frontmatter": fm})
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    // Written out of id order against the (source, slug) scan order, so the `names` sort shows.
    put(
        &store,
        "default",
        "people/zed-example",
        page("person", "Zed Example", json!({})),
    );
    put(
        &store,
        "default",
        "people/alice-example",
        page("person", "Alice Example", json!({})),
    );
    put(
        &store,
        "default",
        "companies/acme-example",
        page("company", "Acme Example", json!({})),
    );
    put(
        &store,
        "default",
        "people/quinn-zorvexample",
        page("person", "Quinn Zorvexample", json!({})),
    );
    put(
        &store,
        "default",
        "companies/zorvexample",
        page("company", "Labs Zorvexample", json!({})),
    );
    put(
        &store,
        "default",
        "people/ailisi-example",
        page("person", "爱丽丝", json!({})),
    );
    put(
        &store,
        "default",
        "people/hidden-example",
        page("person", "Hidden Example", json!({"visibility": "private"})),
    );
    put(
        &store,
        "default",
        "people/gone-example",
        page("person", "Gone Example", json!({})),
    );
    put(
        &store,
        "other",
        "people/alice-example",
        page("person", "Alice Example", json!({})),
    );
    store
        .soft_delete_page("people/gone-example", Some("default"))
        .unwrap();
    store
}

fn ids(sources: &[&str]) -> Vec<String> {
    sources.iter().map(|s| s.to_string()).collect()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn keys(rows: &[gbrain_store::cli_reads::reflex_reads::ReflexPageRow]) -> Vec<(String, String)> {
    rows.iter()
        .map(|r| (r.source_id.clone(), r.slug.clone()))
        .collect()
}

fn hide_private() -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }
}

#[test]
fn live_keys_read_the_live_pages_of_exactly_the_given_sources() {
    let dir = TempDir::new("reflex-live");
    let store = seeded(&dir);
    let slugs = strings(&[
        "people/alice-example",
        "people/gone-example",
        "people/hidden-example",
    ]);
    let all = store
        .read_reflex_live_keys(&ids(&["default", "other"]), &slugs, None)
        .unwrap();
    let got: Vec<(&str, &str)> = all
        .iter()
        .map(|k| (k.source_id.as_str(), k.slug.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("default", "people/alice-example"),
            ("default", "people/hidden-example"),
            ("other", "people/alice-example"),
        ]
    );
    let hidden = store
        .read_reflex_live_keys(&ids(&["default"]), &slugs, Some(&hide_private()))
        .unwrap();
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].slug, "people/alice-example");
    assert!(
        store
            .read_reflex_live_keys(&[], &slugs, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn names_match_title_slug_suffix_and_surname_in_page_id_order() {
    let dir = TempDir::new("reflex-names");
    let store = seeded(&dir);
    let names = |surname: &[&str]| ReflexPageMatch::Names {
        titles_lc: strings(&["zed example"]),
        exact_slugs: strings(&["alice-example"]),
        // `_` stays a LIKE wildcard, as the unescaped suffix is in SQL.
        slug_suffixes: strings(&["%/alice-example", "%/acme_example"]),
        surname_patterns: strings(surname),
    };
    let rows = store
        .read_reflex_pages(&ids(&["default"]), &names(&[]), None)
        .unwrap();
    assert_eq!(
        keys(&rows),
        vec![
            ("default".into(), "people/zed-example".into()),
            ("default".into(), "people/alice-example".into()),
            ("default".into(), "companies/acme-example".into()),
        ]
    );
    assert_eq!(rows[0].page_type, "person");
    assert_eq!(rows[0].compiled_truth.as_deref(), Some("body"));
    // The surname arm keeps person pages only: the company titled "... Zorvexample" stays out.
    let with_surname = store
        .read_reflex_pages(&ids(&["default"]), &names(&["% zorvexample"]), None)
        .unwrap();
    assert_eq!(
        keys(&with_surname).last().unwrap(),
        &(
            "default".to_string(),
            "people/quinn-zorvexample".to_string()
        )
    );
    assert_eq!(with_surname.len(), 4);
    let both = store
        .read_reflex_pages(&ids(&["default", "other"]), &names(&[]), None)
        .unwrap();
    assert_eq!(both.len(), 4);
    assert!(
        store
            .read_reflex_pages(&[], &names(&[]), None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn slugs_cjk_and_titles_kinds_and_the_page_policy() {
    let dir = TempDir::new("reflex-kinds");
    let store = seeded(&dir);
    let src = ids(&["default"]);
    let slugs = ReflexPageMatch::Slugs {
        slugs: strings(&[
            "people/hidden-example",
            "people/gone-example",
            "people/alice-example",
        ]),
    };
    assert_eq!(
        store.read_reflex_pages(&src, &slugs, None).unwrap().len(),
        2
    );
    let visible = store
        .read_reflex_pages(&src, &slugs, Some(&hide_private()))
        .unwrap();
    assert_eq!(
        keys(&visible),
        vec![("default".into(), "people/alice-example".into())]
    );
    let cjk = ReflexPageMatch::CjkExact {
        norms: strings(&["爱丽丝"]),
    };
    let rows = store.read_reflex_pages(&src, &cjk, None).unwrap();
    assert_eq!(
        keys(&rows),
        vec![("default".into(), "people/ailisi-example".into())]
    );
    let titles = ReflexPageMatch::Titles {
        titles_lc: strings(&["acme example", "hidden example"]),
    };
    assert_eq!(
        store.read_reflex_pages(&src, &titles, None).unwrap().len(),
        2
    );
    assert_eq!(
        store
            .read_reflex_pages(&src, &titles, Some(&hide_private()))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn match_kinds_deserialize_from_the_member_json() {
    let names: ReflexPageMatch = serde_json::from_value(json!({
        "kind": "names", "titlesLc": ["a"], "exactSlugs": [], "slugSuffixes": [], "surnamePatterns": []
    }))
    .unwrap();
    assert!(matches!(names, ReflexPageMatch::Names { .. }));
    let cjk: ReflexPageMatch =
        serde_json::from_value(json!({"kind": "cjkExact", "norms": ["x"]})).unwrap();
    assert!(matches!(cjk, ReflexPageMatch::CjkExact { .. }));
    assert!(
        serde_json::from_value::<ReflexPageMatch>(json!({"kind": "fuzzy", "norms": []})).is_err()
    );
}

#[test]
fn brief_entity_pages_apply_the_source_policy_and_trust_floor() {
    let dir = TempDir::new("reflex-brief");
    let store = seeded(&dir);
    let slugs = strings(&[
        "people/alice-example",
        "people/hidden-example",
        "people/gone-example",
    ]);
    let open_read = store
        .read_brief_entity_pages("default", &slugs, None, &BriefEligibility::default())
        .unwrap();
    let got: Vec<(&str, &str, &str)> = open_read
        .iter()
        .map(|r| (r.slug.as_str(), r.title.as_str(), r.page_type.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("people/alice-example", "Alice Example", "person"),
            ("people/hidden-example", "Hidden Example", "person"),
        ]
    );
    let private_hidden = store
        .read_brief_entity_pages(
            "default",
            &slugs,
            Some(&hide_private()),
            &BriefEligibility::default(),
        )
        .unwrap();
    assert_eq!(private_hidden.len(), 1);
    // A page written with no stamped tier reads as `unknown`, below an operator-curated floor.
    let floored = store
        .read_brief_entity_pages(
            "default",
            &slugs,
            None,
            &BriefEligibility {
                min_trust: Some("operator_curated".into()),
                suppress_flagged: false,
            },
        )
        .unwrap();
    assert!(floored.is_empty());
    let unknown_floor = store
        .read_brief_entity_pages(
            "default",
            &slugs,
            None,
            &BriefEligibility {
                min_trust: Some("unknown".into()),
                suppress_flagged: false,
            },
        )
        .unwrap();
    assert_eq!(unknown_floor.len(), open_read.len());
    let bad = store.read_brief_entity_pages(
        "default",
        &slugs,
        None,
        &BriefEligibility {
            min_trust: Some("bogus".into()),
            suppress_flagged: false,
        },
    );
    assert!(bad.is_err());
}
