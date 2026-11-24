//! The label door the store serves (`label_door.rs`): the privacy-origin read, the dependents a removal exposes, the
//! checkout files, the label row and the label guard write.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::label_door::{OriginRef, PrivacyOrigin};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = serde_json::from_value(
        json!({ "id": "other", "name": "other", "local_path": "/brains/other", "config": {} }),
    )
    .unwrap();
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn put(store: &Store, source: &str, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    put_with(store, source, slug, page_type, frontmatter, None)
}

fn put_with(
    store: &Store,
    source: &str,
    slug: &str,
    page_type: &str,
    frontmatter: Value,
    source_path: Option<&str>,
) -> u64 {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type, "title": slug, "compiled_truth": slug, "frontmatter": frontmatter,
        "source_path": source_path,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
    store
        .read_page_label_row(source, slug)
        .unwrap()
        .expect("page written")
        .id
}

fn origin(id: u64, source: &str, slug: &str) -> OriginRef {
    serde_json::from_value(json!({ "id": id, "sourceId": source, "slug": slug })).unwrap()
}

#[test]
fn an_origin_is_an_atom_or_a_page_the_privacy_rules_hide() {
    let (_dir, store) = brain("label-door-origin");
    let private = put(
        &store,
        "default",
        "notes/p",
        "note",
        json!({ "visibility": "private" }),
    );
    put(&store, "default", "notes/w", "note", json!({}));
    let atom = put(
        &store,
        "default",
        "atoms/a",
        "atom",
        json!({ "visibility": "world" }),
    );
    let read = |slug: &str| store.read_privacy_origin("default", slug, false).unwrap();
    assert_eq!(
        read("notes/p"),
        Some(PrivacyOrigin {
            id: private,
            deleted: false
        })
    );
    assert_eq!(read("notes/w"), None);
    assert_eq!(
        read("atoms/a"),
        Some(PrivacyOrigin {
            id: atom,
            deleted: false
        })
    );
    assert_eq!(read("notes/missing"), None);
    // The other source's slug is a different page.
    assert_eq!(
        store
            .read_privacy_origin("other", "notes/p", false)
            .unwrap(),
        None
    );

    store.soft_delete_page("notes/p", Some("default")).unwrap();
    assert_eq!(
        read("notes/p"),
        Some(PrivacyOrigin {
            id: private,
            deleted: true
        })
    );

    // An alias-labelled page is an origin only while aliases are honored.
    put(
        &store,
        "default",
        "notes/alias",
        "note",
        json!({ "access": "private" }),
    );
    let honored = store
        .read_privacy_origin("default", "notes/alias", true)
        .unwrap();
    assert!(honored.is_some());
    assert_eq!(read("notes/alias"), None);
}

#[test]
fn dependents_are_the_pages_hidden_now_and_visible_once_the_origin_goes() {
    let (_dir, store) = brain("label-door-dependents");
    let p = put(
        &store,
        "default",
        "notes/p",
        "note",
        json!({ "visibility": "private" }),
    );
    let atom = put(
        &store,
        "default",
        "atoms/from-p",
        "atom",
        json!({ "visibility": "world", "source_slug": "notes/p" }),
    );
    let declared = put(
        &store,
        "default",
        "notes/q",
        "note",
        json!({ "visibility": "world", "derived_from": ["notes/p.md"] }),
    );
    let event = put(
        &store,
        "default",
        "events/e",
        "event",
        json!({ "visibility": "world", "captured_via": "life-chronicle:x", "event": { "depth": "notes/q" } }),
    );
    // Hidden by a second private origin, so it stays hidden after `notes/p` goes.
    put(
        &store,
        "default",
        "notes/p2",
        "note",
        json!({ "visibility": "private" }),
    );
    put(
        &store,
        "default",
        "notes/both",
        "note",
        json!({ "visibility": "world", "derived_from": ["notes/p", "notes/p2"] }),
    );
    // Another source names the same slug: not a dependent.
    put(
        &store,
        "other",
        "atoms/elsewhere",
        "atom",
        json!({ "visibility": "world", "source_slug": "notes/p" }),
    );
    // Private on its own: removing the origin does not expose it.
    put(
        &store,
        "default",
        "atoms/own",
        "atom",
        json!({ "visibility": "private", "source_slug": "notes/p" }),
    );

    let rows = store
        .list_origin_dependents(&[origin(p, "default", "notes/p")], false)
        .unwrap();
    let got: Vec<(u64, u64, &str, bool)> = rows
        .iter()
        .map(|r| (r.id, r.cleared_id, r.slug.as_str(), r.deleted))
        .collect();
    let mut want = vec![
        (atom, p, "atoms/from-p", false),
        (declared, p, "notes/q", false),
        (event, p, "events/e", false),
    ];
    want.sort();
    assert_eq!(got, want);
    assert!(rows.iter().all(|r| r.source_id == "default"));

    // No origins, no rows; an origin id that names nothing, no rows.
    assert!(store.list_origin_dependents(&[], false).unwrap().is_empty());
    assert!(
        store
            .list_origin_dependents(&[origin(99_999, "default", "notes/nothing")], false)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_renamed_source_slug_ties_the_dependent_to_the_moved_origin() {
    let (_dir, store) = brain("label-door-rename");
    let moved = put(
        &store,
        "default",
        "notes/old",
        "note",
        json!({ "visibility": "private" }),
    );
    let atom = put(
        &store,
        "default",
        "atoms/old-name",
        "atom",
        json!({ "visibility": "world", "source_slug": "notes/old" }),
    );
    assert_eq!(
        store
            .update_slug("notes/old", "notes/new", Some("default"))
            .unwrap(),
        1
    );
    let rows = store
        .list_origin_dependents(&[origin(moved, "default", "notes/new")], false)
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| (r.id, r.cleared_id))
            .collect::<Vec<_>>(),
        vec![(atom, moved)]
    );
}

#[test]
fn checkout_files_are_the_recorded_files_with_their_source_checkout() {
    let (_dir, store) = brain("label-door-checkout");
    let filed = put_with(
        &store,
        "other",
        "notes/f",
        "note",
        json!({}),
        Some("notes/f.md"),
    );
    let unfiled = put(&store, "other", "notes/u", "note", json!({}));
    let default = put_with(
        &store,
        "default",
        "notes/d",
        "note",
        json!({}),
        Some("notes/d.md"),
    );
    let rows = store
        .list_checkout_files(&[
            default as i64,
            unfiled as i64,
            filed as i64,
            filed as i64,
            -1,
        ])
        .unwrap();
    let got: Vec<(u64, &str, &str, Option<&str>)> = rows
        .iter()
        .map(|r| {
            (
                r.id,
                r.source_id.as_str(),
                r.source_path.as_str(),
                r.local_path.as_deref(),
            )
        })
        .collect();
    let mut want = vec![
        (filed, "other", "notes/f.md", Some("/brains/other")),
        (default, "default", "notes/d.md", None),
    ];
    want.sort();
    assert_eq!(got, want);
    assert!(store.list_checkout_files(&[]).unwrap().is_empty());
}

#[test]
fn the_label_guard_is_set_cleared_and_goes_with_its_page() {
    let (_dir, store) = brain("label-door-guard");
    let id = put(
        &store,
        "default",
        "notes/g",
        "note",
        json!({ "visibility": "private" }),
    );
    let row = store
        .read_page_label_row("default", "notes/g")
        .unwrap()
        .unwrap();
    assert_eq!(row.frontmatter["visibility"], json!("private"));
    assert!(
        store
            .read_page_label_row("default", "notes/none")
            .unwrap()
            .is_none()
    );

    let guard = || store.read_page_label_guard(id as i64).unwrap();
    store
        .write_page_label_guard(id as i64, Some("operator_curated"))
        .unwrap();
    let first = guard().expect("guard set");
    assert_eq!(first.tier, "operator_curated");
    store
        .write_page_label_guard(id as i64, Some("user_confirmed"))
        .unwrap();
    let second = guard().expect("guard kept");
    assert_eq!(second.tier, "user_confirmed");
    assert!(second.set_at_us >= first.set_at_us);
    store.write_page_label_guard(id as i64, None).unwrap();
    assert!(guard().is_none());
    // Clearing an absent guard is a no-op.
    store.write_page_label_guard(id as i64, None).unwrap();

    // The tier is checked and the page must exist.
    let bad = store
        .write_page_label_guard(id as i64, Some("owner"))
        .unwrap_err();
    assert_eq!(bad.code, gbrain_store::error::INVALID_ARGUMENT);
    let missing = store
        .write_page_label_guard(99_999, Some("operator_curated"))
        .unwrap_err();
    assert_eq!(missing.code, gbrain_store::error::CONSTRAINT_VIOLATION);

    // A soft delete keeps the guard; a hard delete removes it.
    store
        .write_page_label_guard(id as i64, Some("operator_curated"))
        .unwrap();
    store.soft_delete_page("notes/g", Some("default")).unwrap();
    assert!(guard().is_some());
    assert!(
        store
            .read_page_label_row("default", "notes/g")
            .unwrap()
            .is_some()
    );
    store.delete_page("notes/g", Some("default")).unwrap();
    assert!(guard().is_none());
}

// The label guard and the belief ledger's page lifetimes share the `t` keyspace: the guard is `t 0x0e`, the
// lifetimes `t 0x0a`. A page that holds both reads each back unchanged, and ending the lifetime leaves the guard.
#[test]
fn a_label_guard_and_a_belief_lifetime_on_one_page_both_read_back() {
    use gbrain_store::trust::belief_lifetimes::{LifetimeMint, LifetimePair};
    let (_dir, store) = brain("label-door-guard-lifetime");
    let id = put(
        &store,
        "default",
        "notes/both",
        "note",
        json!({ "visibility": "private" }),
    );
    let incarnation = "00000000-0000-4000-8000-000000000001";
    let lifetime = "00000000-0000-4000-8000-0000000000aa";
    store
        .write_page_label_guard(id as i64, Some("operator_curated"))
        .unwrap();
    let mint: LifetimeMint = serde_json::from_value(json!({
        "lifetime": lifetime, "sourceId": "default", "incarnation": incarnation,
        "slug": "notes/both", "pageId": id as i32,
    }))
    .unwrap();
    assert_eq!(store.mint_belief_lifetime(&mint).unwrap(), lifetime);
    let pair = LifetimePair {
        incarnation: Some(incarnation.to_string()),
        slug: Some("notes/both".to_string()),
    };
    let open = store
        .read_open_belief_lifetimes(std::slice::from_ref(&pair))
        .unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].page_lifetime, lifetime);
    assert_eq!(open[0].page_id, Some(id as i32));
    let guard = store
        .read_page_label_guard(id as i64)
        .unwrap()
        .expect("guard kept");
    assert_eq!(guard.tier, "operator_curated");

    store.end_belief_lifetime(lifetime).unwrap();
    assert!(
        store
            .read_open_belief_lifetimes(std::slice::from_ref(&pair))
            .unwrap()
            .is_empty()
    );
    let guard = store
        .read_page_label_guard(id as i64)
        .unwrap()
        .expect("guard kept");
    assert_eq!(guard.tier, "operator_curated");
}
