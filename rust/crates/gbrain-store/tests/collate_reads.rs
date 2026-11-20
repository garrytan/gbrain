//! The byte-ordered page, mention and fact-pool reads (`collate_reads.rs`): the type pairs, the mention counts and scan,
//! the gazetteer's pages and aliases, and the pool's entity pairs and unbacked keys.

mod common;
mod memory_env;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::trust::PoolArgs;
use gbrain_store::links::LinkBatchInput;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&args::<SourceInput>(
            json!({ "id": id, "name": id, "config": {} }),
        ))
        .unwrap();
}

fn put(store: &Store, source: &str, slug: &str, kind: &str, frontmatter: Value) {
    let input: PageInput = args(json!({
        "type": kind, "title": format!("Title {slug}"), "compiled_truth": format!("{slug} body"),
        "timeline": "tl", "frontmatter": frontmatter,
    }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    store.put_page(slug, &input, &options).unwrap();
}

fn mention(store: &Store, from: &str, to: &str) {
    let link: LinkBatchInput = args(json!({
        "from_slug": from, "to_slug": to, "link_type": "mentions", "context": "", "link_source": "mentions",
        "from_source_id": "default", "to_source_id": "default", "link_kind": "plain",
    }));
    store.add_links_batch(&[link]).unwrap();
}

fn strings(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn type_pairs_are_the_distinct_live_source_and_type_pairs_by_byte() {
    let dir = TempDir::new("collate-type-pairs");
    let s = open(&dir);
    for id in ["b", "a-z", "a0"] {
        source(&s, id);
    }
    put(&s, "b", "x", "note", json!({}));
    put(&s, "a0", "y", "person", json!({}));
    put(&s, "a-z", "z", "note", json!({}));
    put(&s, "a-z", "w", "note", json!({}));
    put(&s, "a-z", "gone", "ghost", json!({}));
    s.soft_delete_page("gone", Some("a-z")).unwrap();
    let pairs: Vec<(String, String)> = s
        .list_page_type_pairs()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().into(),
                r["type"].as_str().unwrap().into(),
            )
        })
        .collect();
    let want = [("a-z", "note"), ("a0", "person"), ("b", "note")]
        .map(|(a, b)| (a.to_string(), b.to_string()));
    assert_eq!(pairs, want);
}

#[test]
fn the_stale_mention_scan_takes_the_byte_first_pages_and_lists_their_links_by_byte() {
    let dir = TempDir::new("collate-stale-mentions");
    let s = open(&dir);
    for slug in ["ab", "a0", "a_b", "a-b", "target"] {
        put(&s, "default", slug, "note", json!({}));
    }
    for from in ["ab", "a0", "a_b", "a-b"] {
        mention(&s, from, "target");
    }
    mention(&s, "a-b", "ab");
    mention(&s, "a-b", "a0");
    assert_eq!(s.count_pages_with_mention_links().unwrap(), 4);
    let pages = s.list_stale_mention_pages(3).unwrap();
    assert_eq!(strings(&pages, "slug"), ["a-b", "a0", "a_b"]);
    assert_eq!(pages[0]["body"], "Title a-b\n\na-b body\n\ntl");
    assert_eq!(pages[0]["body_storage"], "inline");
    let links = s.list_stale_mention_links(3).unwrap();
    let pairs: Vec<(String, String)> = links
        .iter()
        .map(|r| {
            (
                r["from_slug"].as_str().unwrap().into(),
                r["to_slug"].as_str().unwrap().into(),
            )
        })
        .collect();
    let want = [
        ("a-b", "a0"),
        ("a-b", "ab"),
        ("a-b", "target"),
        ("a0", "target"),
        ("a_b", "target"),
    ]
    .map(|(a, b)| (a.to_string(), b.to_string()));
    assert_eq!(pairs, want);
    assert_eq!(links[0]["link_type"], "mentions");
    assert_eq!(links[0]["link_kind"], "plain");
    s.soft_delete_page("a0", None).unwrap();
    assert_eq!(s.count_pages_with_mention_links().unwrap(), 3);
}

#[test]
fn the_gazetteer_reads_live_pages_of_the_listed_types_with_handles_and_aliases() {
    let dir = TempDir::new("collate-gazetteer");
    let s = open(&dir);
    source(&s, "other");
    put(
        &s,
        "default",
        "people/alice",
        "person",
        json!({ "x_handle": "@alice", "google_contact_id": "g1", "identity": "ceo" }),
    );
    put(&s, "default", "notes/n", "note", json!({}));
    put(
        &s,
        "other",
        "people/bob",
        "person",
        json!({ "twitter": "bob" }),
    );
    put(&s, "other", "people/old", "person", json!({}));
    s.soft_delete_page("people/old", Some("other")).unwrap();
    assert_eq!(
        strings(&s.list_gazetteer_source_ids().unwrap(), "id"),
        ["default", "other"]
    );
    let keys: Vec<String> = ["x_handle", "twitter", "twitter_handle", "x"]
        .map(String::from)
        .to_vec();
    let pages = s
        .list_gazetteer_pages(&["person".to_string()], &keys)
        .unwrap();
    assert_eq!(strings(&pages, "slug"), ["people/alice", "people/bob"]);
    assert_eq!(pages[0]["connector_stub"], true);
    assert_eq!(pages[0]["h1"], "@alice");
    assert_eq!(pages[0]["h2"], Value::Null);
    assert_eq!(pages[1]["connector_stub"], false);
    assert_eq!(pages[1]["h2"], "bob");
    s.set_page_aliases("people/alice", "default", &["Al".to_string()])
        .unwrap();
    s.set_page_aliases(
        "people/bob",
        "other",
        &["Bobby".to_string(), "Rob".to_string()],
    )
    .unwrap();
    s.set_page_aliases("notes/n", "default", &["Not".to_string()])
        .unwrap();
    let rows = s
        .list_gazetteer_alias_rows(&["person".to_string()])
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["slug"], "people/alice");
    assert_eq!(rows[0]["identity"], "ceo");
    assert_eq!(rows[0]["type"], "person");
    assert_eq!(strings(&rows[1..], "slug"), ["people/bob", "people/bob"]);
}

fn pool(sources: &[&str]) -> PoolArgs {
    args(json!({ "sourceIds": sources }))
}

fn fact(b: &memory_env::Brain, source: &str, entity: Option<&str>, text: &str) {
    b.insert_facts(&args::<InsertFactsArgs>(json!({
        "rows": [{ "fact": text, "entity_slug": entity, "kind": "fact", "visibility": "world", "source": "test" }],
        "sourceId": source,
    })))
    .unwrap();
}

#[test]
fn pool_pairs_and_unbacked_keys_come_back_by_byte_under_the_limit() {
    let b = memory_env::brain("collate-pool-pairs");
    for id in ["b", "a-z", "a0"] {
        source(&b, id);
    }
    for id in ["b", "a-z", "a0"] {
        for slug in ["ab", "a0", "a_b", "a-b"] {
            fact(&b, id, Some(slug), &format!("{slug} fact in {id}"));
        }
        fact(&b, id, None, "a fact about nobody");
    }
    // A live page backs one pair; a removed page does not (a soft-deleted entity page would hide its facts from the pool).
    put(&b, "a-z", "a-b", "note", json!({}));
    put(&b, "a0", "a0", "note", json!({}));
    b.delete_page("a0", Some("a0")).unwrap();
    let pairs = b
        .list_pool_entity_pairs(&pool(&["b", "a0", "a-z"]))
        .unwrap();
    let got: Vec<String> = pairs
        .iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["source_id"].as_str().unwrap(),
                r["entity_slug"].as_str().unwrap()
            )
        })
        .collect();
    let mut want = Vec::new();
    for id in ["a-z", "a0", "b"] {
        for slug in ["a-b", "a0", "a_b", "ab"] {
            want.push(format!("{id}/{slug}"));
        }
    }
    assert_eq!(got, want);
    let wanted: Vec<String> = ["a-b", "a0", "ab"].map(String::from).to_vec();
    let all = b
        .list_pool_unbacked_keys(&pool(&["b", "a0", "a-z"]), &wanted, 100)
        .unwrap();
    let got: Vec<String> = all
        .iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["source_id"].as_str().unwrap(),
                r["entity_slug"].as_str().unwrap()
            )
        })
        .collect();
    // a-z/a-b has a live page; a0/a0's page is deleted, so that pair stays unbacked.
    assert_eq!(
        got,
        [
            "a-z/a0", "a-z/ab", "a0/a-b", "a0/a0", "a0/ab", "b/a-b", "b/a0", "b/ab"
        ]
    );
    let few = b
        .list_pool_unbacked_keys(&pool(&["b", "a0", "a-z"]), &wanted, 3)
        .unwrap();
    assert_eq!(few.len(), 3);
    assert_eq!(strings(&few, "entity_slug"), ["a0", "ab", "a-b"]);
}
