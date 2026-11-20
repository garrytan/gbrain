//! The reads link preparation made through `executeRaw`: the alias targets a link may follow and the
//! source slug fingerprint. The parity cases are in test/engine-parity/links-preparation*.test.ts;
//! these pin the rules those cannot show on one engine alone: what counts as live, the exact hash
//! sum, and the inputs that name nothing.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::links_preparation::hashtextextended;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
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
    store
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

fn aliases(store: &Store, source: &str, targets: &[&str]) -> Vec<(String, String)> {
    store
        .read_live_slug_aliases(source, &strings(targets))
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["alias_slug"].as_str().unwrap().to_string(),
                row["canonical_slug"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn pair(alias: &str, canonical: &str) -> (String, String) {
    (alias.to_string(), canonical.to_string())
}

#[test]
fn an_alias_with_no_live_page_and_a_live_canonical_page_is_returned() {
    let dir = TempDir::new("links-prep-alias");
    let store = seeded(&dir);
    put(&store, "default", "people/bob-old", json!({}));
    put(&store, "default", "people/carol-old", json!({}));
    put(&store, "default", "people/dan-old", json!({}));
    store
        .update_slug("people/bob-old", "people/bob", None)
        .unwrap();
    store
        .update_slug("people/carol-old", "people/carol", None)
        .unwrap();
    store
        .update_slug("people/dan-old", "people/dan", None)
        .unwrap();
    // A page created at an alias slug answers for itself: the alias is not followed.
    put(&store, "default", "people/carol-old", json!({}));
    store.soft_delete_page("people/dan", None).unwrap();
    assert_eq!(
        aliases(
            &store,
            "default",
            &[
                "people/bob-old",
                "people/carol-old",
                "people/dan-old",
                "people/nobody"
            ]
        ),
        vec![pair("people/bob-old", "people/bob")]
    );
    // The alias rows belong to their source.
    assert_eq!(aliases(&store, "other", &["people/bob-old"]), vec![]);
}

#[test]
fn a_deleted_alias_page_gives_way_and_a_quarantined_canonical_page_counts_as_live() {
    let dir = TempDir::new("links-prep-live");
    let store = seeded(&dir);
    put(&store, "default", "people/eve-old", json!({}));
    store
        .update_slug("people/eve-old", "people/eve", None)
        .unwrap();
    // A soft-deleted page at the alias slug is not live, so the alias answers.
    put(&store, "default", "people/eve-old", json!({}));
    store.soft_delete_page("people/eve-old", None).unwrap();
    assert_eq!(
        aliases(&store, "default", &["people/eve-old"]),
        vec![pair("people/eve-old", "people/eve")]
    );
    // The SQL's live test is `deleted_at IS NULL` alone: a quarantined canonical page still counts.
    put(
        &store,
        "default",
        "people/eve",
        json!({"quarantine": {"reason": "test"}}),
    );
    assert_eq!(
        aliases(&store, "default", &["people/eve-old"]),
        vec![pair("people/eve-old", "people/eve")]
    );
}

#[test]
fn targets_are_deduplicated_and_empty_or_nul_input_names_nothing() {
    let dir = TempDir::new("links-prep-targets");
    let store = seeded(&dir);
    put(&store, "default", "a/old", json!({}));
    put(&store, "default", "b/old", json!({}));
    store.update_slug("a/old", "a/new", None).unwrap();
    store.update_slug("b/old", "b/new", None).unwrap();
    assert_eq!(
        aliases(&store, "default", &["b/old", "a/old", "b/old", "a/old"]),
        vec![pair("a/old", "a/new"), pair("b/old", "b/new")]
    );
    assert_eq!(aliases(&store, "default", &[]), vec![]);
    assert_eq!(aliases(&store, "default", &["a/old\0x"]), vec![]);
    assert_eq!(aliases(&store, "d\0efault", &["a/old"]), vec![]);
}

fn fingerprint(store: &Store, source: &str) -> (u64, String, u64, Vec<String>) {
    let all = store.read_source_slug_fingerprint(source).unwrap();
    (
        all["n"].as_u64().unwrap(),
        all["h"].as_str().unwrap().to_string(),
        all["m"].as_u64().unwrap(),
        all["slugs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect(),
    )
}

#[test]
fn the_fingerprint_counts_every_page_row_and_sums_the_postgres_hash() {
    let dir = TempDir::new("links-prep-fingerprint");
    let store = seeded(&dir);
    let slugs = [
        "people/alice-example",
        "notes/caf\u{e9}",
        "people/\u{65e5}\u{672c}\u{8a9e}",
        "abcdefghijklmnopqrstuvwxy",
    ];
    for slug in slugs {
        put(&store, "default", slug, json!({}));
    }
    put(&store, "other", "elsewhere/page", json!({}));
    // A soft-deleted page stays in the fingerprint: the SQL has no live filter.
    store.soft_delete_page("notes/caf\u{e9}", None).unwrap();

    let (n, h, m, mut listed) = fingerprint(&store, "default");
    let expected: i128 = slugs.iter().map(|s| i128::from(hashtextextended(s))).sum();
    assert_eq!((n, h.as_str()), (4, expected.to_string().as_str()));
    assert!(m >= 4);
    listed.sort();
    let mut every = strings(&slugs);
    every.sort();
    assert_eq!(listed, every);

    // The other source and a source with no pages are fingerprinted on their own.
    assert_eq!(fingerprint(&store, "other").0, 1);
    assert_eq!(
        fingerprint(&store, "ghost"),
        (0, "0".to_string(), 0, Vec::new())
    );
    assert_eq!(fingerprint(&store, "de\0fault").0, 0);
}

#[test]
fn the_probe_reports_the_pages_added_after_an_id() {
    let dir = TempDir::new("links-prep-probe");
    let store = seeded(&dir);
    put(&store, "default", "notes/one", json!({}));
    put(&store, "default", "notes/two", json!({}));
    let (_, h_before, m_before, _) = fingerprint(&store, "default");
    put(&store, "default", "notes/three", json!({}));
    put(&store, "default", "notes/four", json!({}));

    let probe = store
        .probe_source_slug_fingerprint("default", m_before as i64)
        .unwrap();
    assert_eq!(probe["n"], json!(4));
    let mut added: Vec<&str> = probe["added"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    added.sort();
    assert_eq!(added, vec!["notes/four", "notes/three"]);
    let added_h: i128 = ["notes/three", "notes/four"]
        .iter()
        .map(|s| i128::from(hashtextextended(s)))
        .sum();
    assert_eq!(probe["added_h"], json!(added_h.to_string()));
    // The whole sum is the earlier sum plus the added sum, which is how the caller checks it.
    let whole: i128 = h_before.parse::<i128>().unwrap() + added_h;
    assert_eq!(probe["h"], json!(whole.to_string()));

    let none = store
        .probe_source_slug_fingerprint("default", probe["m"].as_i64().unwrap())
        .unwrap();
    assert_eq!(
        (none["added"].clone(), none["added_h"].clone()),
        (json!([]), json!("0"))
    );
    let all = store.probe_source_slug_fingerprint("default", 0).unwrap();
    assert_eq!(all["added"].as_array().unwrap().len(), 4);
}
