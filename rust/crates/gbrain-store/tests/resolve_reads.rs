//! The entity resolver's page reads (`entities/resolve.ts`): live pages only, per source, each
//! slug once, the caps, and the retired-page and privacy filters where the resolver applies them.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
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
