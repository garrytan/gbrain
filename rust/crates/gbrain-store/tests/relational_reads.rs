//! The relational recall arm's seed admit read (`read_admitted_page_refs`): only the live pages the read
//! scope admits come back; a soft-deleted, quarantined, archived-source, other-source or private page never
//! leaks through, and a missing ref answers nothing. The hydrate read (`read_page_synopses`) also needs a
//! served text projection and no pinned question, and cuts the body to 65536 code points.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::page_ops::{PageReadScope, PageRef};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put_in(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "company", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..Default::default()
        })
        .unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    source(&store, "other");
    source(&store, "old");
    put_in(&store, "default", "companies/open", json!({}));
    put_in(
        &store,
        "default",
        "companies/private",
        json!({ "visibility": "private" }),
    );
    put_in(
        &store,
        "default",
        "companies/held",
        json!({ "quarantine": { "reason": "test" } }),
    );
    put_in(&store, "default", "companies/gone", json!({}));
    store
        .soft_delete_page("companies/gone", Some("default"))
        .unwrap();
    put_in(&store, "other", "companies/open", json!({}));
    put_in(&store, "old", "companies/archived", json!({}));
    store.set_source_archived("old", true).unwrap();
    store
}

fn r(source_id: &str, slug: &str) -> PageRef {
    PageRef {
        source_id: source_id.into(),
        slug: slug.into(),
    }
}

fn refs() -> Vec<PageRef> {
    vec![
        r("default", "companies/open"),
        r("default", "companies/private"),
        r("default", "companies/held"),
        r("default", "companies/gone"),
        r("default", "companies/missing"),
        r("other", "companies/open"),
        r("old", "companies/archived"),
    ]
}

fn admitted(store: &Store, scope: &PageReadScope) -> Vec<String> {
    store
        .read_admitted_page_refs(&refs(), scope)
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}",
                row["source_id"].as_str().unwrap(),
                row["slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn the_scope_admits_only_live_pages_of_its_sources() {
    let dir = TempDir::new("relational-scoped");
    let store = seeded(&dir);
    let scoped = PageReadScope {
        source_id: Some("default".into()),
        ..Default::default()
    };
    assert_eq!(
        admitted(&store, &scoped),
        vec!["default:companies/open", "default:companies/private"]
    );
    let federated = PageReadScope {
        source_ids: Some(vec!["other".into(), "old".into()]),
        ..Default::default()
    };
    assert_eq!(admitted(&store, &federated), vec!["other:companies/open"]);
}

#[test]
fn the_privacy_policy_hides_private_pages() {
    let dir = TempDir::new("relational-private");
    let store = seeded(&dir);
    let hidden = PageReadScope {
        exclude_private: Some(PrivacyPolicy {
            honor_aliases: true,
            entity_privacy: true,
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        admitted(&store, &hidden),
        vec!["default:companies/open", "other:companies/open"]
    );
}

#[test]
fn no_refs_answer_nothing() {
    let dir = TempDir::new("relational-empty");
    let store = seeded(&dir);
    assert!(
        store
            .read_admitted_page_refs(&[], &PageReadScope::default())
            .unwrap()
            .is_empty()
    );
}

fn seal(store: &Store, source: &str, slug: &str) {
    let inputs: Vec<ChunkInput> = vec![
        serde_json::from_value(json!({
            "chunk_index": 0, "chunk_text": slug, "chunk_source": "compiled_truth",
        }))
        .unwrap(),
    ];
    let options = UpsertChunksOptions {
        source_id: Some(source.into()),
        seal: true,
        ..UpsertChunksOptions::default()
    };
    store.upsert_chunks(slug, &inputs, &options).unwrap();
}

fn synopses(store: &Store, scope: &PageReadScope) -> Vec<String> {
    store
        .read_page_synopses(&refs(), scope)
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}:{}",
                row["source_id"].as_str().unwrap(),
                row["slug"].as_str().unwrap(),
                row["synopsis"].as_str().map_or(0, |s| s.chars().count())
            )
        })
        .collect()
}

#[test]
fn the_hydrate_read_shows_only_served_unpinned_pages_with_a_bounded_synopsis() {
    let dir = TempDir::new("relational-synopses");
    let store = seeded(&dir);
    // A page written without indexing has no served text projection yet.
    let unindexed: PageInput = serde_json::from_value(json!({
        "type": "company", "title": "unindexed", "compiled_truth": "body", "frontmatter": {}
    }))
    .unwrap();
    let no_index: PutPageOptions =
        serde_json::from_value(json!({ "sourceId": "default", "index": false })).unwrap();
    store
        .put_page("companies/unindexed", &unindexed, &no_index)
        .unwrap();
    let long = "é".repeat(70_000);
    let input: PageInput = serde_json::from_value(json!({
        "type": "company", "title": "open", "compiled_truth": long, "frontmatter": {}
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
    store.put_page("companies/open", &input, &opts).unwrap();
    for (source, slug) in [
        ("default", "companies/open"),
        ("default", "companies/private"),
        ("default", "companies/held"),
        ("other", "companies/open"),
    ] {
        seal(&store, source, slug);
    }
    put_in(
        &store,
        "default",
        "companies/pinned",
        json!({ "pinned_question": true }),
    );
    seal(&store, "default", "companies/pinned");
    let mut with_pinned = refs();
    with_pinned.push(r("default", "companies/pinned"));
    with_pinned.push(r("default", "companies/unindexed"));
    assert_eq!(
        synopses(&store, &PageReadScope::default()),
        vec![
            "default:companies/open:65536",
            "default:companies/private:4",
            "other:companies/open:4"
        ]
    );
    assert_eq!(
        store
            .read_page_synopses(&with_pinned, &PageReadScope::default())
            .unwrap()
            .len(),
        3
    );
    let scoped = PageReadScope {
        source_id: Some("other".into()),
        ..Default::default()
    };
    assert_eq!(synopses(&store, &scoped), vec!["other:companies/open:4"]);
}

#[test]
fn the_title_seed_names_at_most_two_live_unretired_typed_pages() {
    let dir = TempDir::new("relational-title-seed");
    let store = open(&dir);
    source(&store, "other");
    let put = |slug: &str, title: &str, page_type: &str, frontmatter: Value| {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": title, "compiled_truth": "body", "frontmatter": frontmatter
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    };
    put("companies/acme", "Acme Example", "company", json!({}));
    put("people/acme", "acme example", "person", json!({}));
    put(
        "companies/merged",
        "Merged Co",
        "company",
        json!({ "merged_into": "companies/acme" }),
    );
    put("companies/w1", "Widget Co", "company", json!({}));
    put("companies/w2", "WIDGET CO", "company", json!({}));
    put("companies/w3", "Widget Co", "company", json!({}));
    let types = |t: &[&str]| t.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let seed = |title: &str, t: &[&str]| {
        store
            .read_seed_title_slugs("default", &types(t), title)
            .unwrap()
    };
    assert_eq!(seed("ACME example", &["company"]), vec!["companies/acme"]);
    assert_eq!(seed("acme example", &["company", "person"]).len(), 2);
    assert!(seed("Merged Co", &["company"]).is_empty());
    assert_eq!(seed("widget co", &["company"]).len(), 2);
    assert!(seed("Acme Example", &[]).is_empty());
    assert!(
        store
            .read_seed_title_slugs("other", &types(&["company"]), "Acme Example")
            .unwrap()
            .is_empty()
    );
}
