//! The unchanged-body recheck reads of doctor's `atom_provenance_drift` (`listBodyRecheckGroups`,
//! `readBodyRecheckPage`, `listBodyRecheckVersions`), matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store
        .read_page_id_in_source(slug, "default")
        .unwrap()
        .unwrap()
}

fn atom(store: &Store, slug: &str, hash: &str, source_slug: &str, extra: Value) {
    let mut fm = json!({"source_hash": hash, "source_slug": source_slug});
    for (k, v) in extra.as_object().unwrap() {
        fm[k] = v.clone();
    }
    put(store, slug, "atom", fm);
}

#[test]
fn groups_count_drifted_atoms_of_live_inline_pages_by_page_then_byte_hash() {
    let dir = TempDir::new("body-recheck-groups");
    let store = open(&dir);
    let origin = put(&store, "notes/origin", "note", json!({}));
    atom(
        &store,
        "atoms/b1",
        "bbbbbbbbbbbbbbbb",
        "notes/origin",
        json!({}),
    );
    atom(
        &store,
        "atoms/b2",
        "bbbbbbbbbbbbbbbb",
        "notes/origin",
        json!({}),
    );
    atom(
        &store,
        "atoms/upper",
        "Aaaaaaaaaaaaaaaa",
        "notes/origin",
        json!({}),
    );
    // Not counted: a short hash, an unmanaged pending marker, an atom of a missing page, an unbound atom.
    atom(&store, "atoms/short", "abc", "notes/origin", json!({}));
    atom(
        &store,
        "atoms/pending",
        "pending:cccccccccccccccc",
        "notes/origin",
        json!({}),
    );
    atom(
        &store,
        "atoms/gone",
        "dddddddddddddddd",
        "notes/missing",
        json!({}),
    );
    atom(&store, "atoms/unbound", "eeeeeeeeeeeeeeee", "", json!({}));
    // A managed atom sheds its pending marker.
    atom(
        &store,
        "atoms/managed",
        "pending:ffffffffffffffff",
        "notes/origin",
        json!({"managed_extraction": "true"}),
    );
    let groups = store.list_body_recheck_groups().unwrap();
    assert_eq!(
        groups,
        vec![
            json!({"page_id": origin, "sh": "Aaaaaaaaaaaaaaaa", "n": 1}),
            json!({"page_id": origin, "sh": "bbbbbbbbbbbbbbbb", "n": 2}),
            json!({"page_id": origin, "sh": "ffffffffffffffff", "n": 1}),
        ]
    );
    let page = store
        .read_body_recheck_page(origin as i64)
        .unwrap()
        .unwrap();
    assert_eq!(
        page,
        json!({"body_storage": "inline", "compiled_truth": "body", "timeline": ""})
    );
    assert!(store.read_body_recheck_page(987_654).unwrap().is_none());
    assert!(store.list_body_recheck_versions(-1).unwrap().is_empty());
}
