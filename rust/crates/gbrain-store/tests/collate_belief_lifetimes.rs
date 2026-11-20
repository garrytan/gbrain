//! The belief ledger's page lifetime writes (belief_ledger.rs): the open read, the mint, the end,
//! the rename and the moved-page read. Nothing in a shipped brain calls these yet, so every case
//! drives the store directly.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

const GONE: &str = "6f9619ff-8b86-4d01-b42d-00cf4fc964f1";

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let page = store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    page["id"].as_u64().unwrap()
}

fn incarnation(store: &Store) -> String {
    store
        .get_source_by_id("default")
        .unwrap()
        .expect("the default source exists")
        .incarnation
}

fn open_slugs(store: &Store, inc: &str, slugs: &[&str]) -> Vec<(String, Option<u64>)> {
    let incs: Vec<String> = slugs.iter().map(|_| inc.to_string()).collect();
    let names: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
    let mut rows: Vec<_> = store
        .read_open_lifetimes("default", &incs, &names)
        .unwrap()
        .into_iter()
        .map(|r| (r.slug, r.page_id))
        .collect();
    rows.sort();
    rows
}

#[test]
fn a_mint_is_idempotent_and_an_end_closes_the_lifetime_once() {
    let dir = TempDir::new("belief-lifetimes-mint");
    let store = open(&dir);
    let inc = incarnation(&store);
    let a = put(&store, "a-page");
    let first = store.mint_lifetime("default", &inc, "a-page", a).unwrap();
    assert_eq!(
        store.mint_lifetime("default", &inc, "a-page", a).unwrap(),
        first
    );
    assert_eq!(
        open_slugs(&store, &inc, &["a-page", "missing"]),
        vec![("a-page".to_string(), Some(a))]
    );
    store.end_lifetime(&first).unwrap();
    store.end_lifetime(&first).unwrap();
    store.end_lifetime(GONE).unwrap();
    assert!(open_slugs(&store, &inc, &["a-page"]).is_empty());
    let second = store.mint_lifetime("default", &inc, "a-page", a).unwrap();
    assert_ne!(second, first);
    assert_eq!(open_slugs(&store, &inc, &["a-page"]).len(), 1);
    assert!(store.end_lifetime("not-a-uuid").is_err());
}

#[test]
fn a_read_names_only_the_source_and_incarnation_it_was_asked_for() {
    let dir = TempDir::new("belief-lifetimes-scope");
    let store = open(&dir);
    let inc = incarnation(&store);
    let a = put(&store, "a-page");
    store.mint_lifetime("default", &inc, "a-page", a).unwrap();
    let names = vec!["a-page".to_string()];
    let other = vec!["11111111-2222-4333-8444-555555555555".to_string()];
    assert!(
        store
            .read_open_lifetimes("default", &other, &names)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .read_open_lifetimes("elsewhere", std::slice::from_ref(&inc), &names)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .read_open_lifetimes("default", &[], &[])
            .unwrap()
            .is_empty()
    );
    assert!(store.read_open_lifetimes("default", &[inc], &[]).is_err());
}

#[test]
fn a_rename_keeps_the_lifetime_swaps_through_a_parked_name_and_refuses_an_open_slug() {
    let dir = TempDir::new("belief-lifetimes-rename");
    let store = open(&dir);
    let inc = incarnation(&store);
    let a_id = put(&store, "a-page");
    let b_id = put(&store, "b-page");
    let a = store
        .mint_lifetime("default", &inc, "a-page", a_id)
        .unwrap();
    let b = store
        .mint_lifetime("default", &inc, "b-page", b_id)
        .unwrap();
    store
        .rename_lifetime(&a, &format!("~moving-{a}"), b_id)
        .unwrap();
    store.rename_lifetime(&b, "a-page", a_id).unwrap();
    store.rename_lifetime(&a, "b-page", b_id).unwrap();
    assert_eq!(
        open_slugs(&store, &inc, &["a-page", "b-page", &format!("~moving-{a}")]),
        vec![
            ("a-page".to_string(), Some(a_id)),
            ("b-page".to_string(), Some(b_id))
        ]
    );
    let rows = store
        .read_open_lifetimes(
            "default",
            std::slice::from_ref(&inc),
            &["a-page".to_string()],
        )
        .unwrap();
    assert_eq!(rows[0].page_lifetime, b);
    // Another open lifetime holds the slug: refused, and nothing moved.
    let refused = store.rename_lifetime(&a, "a-page", a_id).unwrap_err();
    assert_eq!(refused.code, "constraint_violation");
    assert_eq!(open_slugs(&store, &inc, &["a-page", "b-page"]).len(), 2);
    // A closed lifetime holds no slug; an unknown uuid changes nothing.
    store.end_lifetime(&a).unwrap();
    store.rename_lifetime(&a, "a-page", a_id).unwrap();
    store.rename_lifetime(GONE, "c-page", a_id).unwrap();
    assert_eq!(
        open_slugs(&store, &inc, &["a-page", "b-page", "c-page"]),
        vec![("a-page".to_string(), Some(a_id))]
    );
}

#[test]
fn a_moved_read_names_an_open_lifetime_whose_page_sits_at_its_slug() {
    let dir = TempDir::new("belief-lifetimes-moved");
    let store = open(&dir);
    let inc = incarnation(&store);
    let a_id = put(&store, "a-page");
    let b_id = put(&store, "b-page");
    let c_id = put(&store, "c-page");
    let a = store
        .mint_lifetime("default", &inc, "a-page", a_id)
        .unwrap();
    let c = store.mint_lifetime("default", &inc, "c-old", c_id).unwrap();
    let b = store
        .mint_lifetime("default", &inc, "b-page", b_id)
        .unwrap();
    store.rename_lifetime(&b, "b-page", a_id).unwrap();
    let ids = [a_id, b_id, c_id];
    let named = |store: &Store| -> Vec<(u64, String)> {
        store
            .read_moved_lifetimes(&ids)
            .unwrap()
            .into_iter()
            .map(|m| (m.page_id, m.page_lifetime))
            .collect()
    };
    assert_eq!(named(&store), vec![(a_id, a.clone())]);
    store.rename_lifetime(&c, "c-page", c_id).unwrap();
    assert_eq!(named(&store), vec![(a_id, a.clone()), (c_id, c.clone())]);
    store.end_lifetime(&a).unwrap();
    assert_eq!(named(&store), vec![(c_id, c)]);
    assert!(store.read_moved_lifetimes(&[]).unwrap().is_empty());
    assert!(store.read_moved_lifetimes(&[999_999]).unwrap().is_empty());
}
