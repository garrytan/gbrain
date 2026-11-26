//! The facts write-path, repair and fence-cycle members of `facts/write_path.rs`, each against the rows its PGLite
//! statement returns (src/core/engine-sql/facts-trust.ts, facts-repair.ts and facts-cycle.ts), and the withdrawal
//! filter of the embeddable-fact scan they share with `countStaleFactEmbeddings`.

mod memory_env;

use gbrain_store::facts::doctor::CoverageQuery;
use gbrain_store::facts::write_path::{
    AdoptFactArgs, CaptureDuplicateArgs, OversizedStaleArgs, PageSlugArgs, SourceSlugsArgs,
};
use gbrain_store::facts::{InsertFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn args<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, source: &str, slug: &str, page_type: &str, body: &str, frontmatter: Value) {
    let input: PageInput = args(json!({
        "type": page_type, "title": format!("T {slug}"), "compiled_truth": body, "frontmatter": frontmatter }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    b.put_page(slug, &input, &options).unwrap();
}

fn source(b: &Brain, id: &str, local_path: Option<&str>) {
    let input: SourceInput =
        args(json!({ "id": id, "name": id, "local_path": local_path, "config": {} }));
    b.upsert_source(&input).unwrap();
}

/// One fact through `insertFact` (no page) or `insertFacts` (a fence row on a page).
fn fact(b: &Brain, source: &str, row: Value) -> u64 {
    let mut base = json!({ "fact": "f", "entity_slug": "people/a", "kind": "fact", "source": "t" });
    base.as_object_mut()
        .unwrap()
        .extend(row.as_object().unwrap().clone());
    let id = if base.get("source_markdown_slug").is_some() {
        b.insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [base], "sourceId": source }),
        ))
        .unwrap()["ids"][0]
            .as_u64()
            .unwrap()
    } else {
        b.insert_fact(&args::<InsertFactArgs>(
            json!({ "input": base, "sourceId": source }),
        ))
        .unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    b.clock.advance(1);
    id
}

fn slugs(source_id: &str, slugs: &[&str]) -> SourceSlugsArgs {
    args(json!({ "sourceId": source_id, "slugs": slugs }))
}

fn at(source_id: &str, slug: &str) -> PageSlugArgs {
    args(json!({ "sourceId": source_id, "slug": slug }))
}

fn field(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap_or("null").to_string())
        .collect()
}

#[test]
fn live_titles_skip_deleted_pages_and_person_titles_skip_retired_and_other_types() {
    let b = brain("write-path-titles");
    page(&b, "default", "people/carol", "person", "x", json!({}));
    page(&b, "default", "people/alice", "person", "x", json!({}));
    page(
        &b,
        "default",
        "people/old",
        "person",
        "x",
        json!({ "merged_into": "people/alice" }),
    );
    page(&b, "default", "notes/n", "note", "x", json!({}));
    page(&b, "default", "people/gone", "person", "x", json!({}));
    b.soft_delete_page("people/gone", Some("default")).unwrap();
    let ask = [
        "people/carol",
        "people/alice",
        "people/old",
        "notes/n",
        "people/gone",
        "people/none",
        "people/alice",
    ];
    let all = b.list_live_page_titles(&slugs("default", &ask)).unwrap();
    assert_eq!(
        field(&all, "slug"),
        ["notes/n", "people/alice", "people/carol", "people/old"]
    );
    assert_eq!(all[1]["title"], json!("T people/alice"));
    let people = b.list_live_person_titles(&slugs("default", &ask)).unwrap();
    assert_eq!(field(&people, "slug"), ["people/alice", "people/carol"]);
    assert!(
        b.list_live_page_titles(&slugs("other", &ask))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_live_page_titles(&slugs("default", &["a\0b"]))
            .unwrap_err()
            .to_string()
            .contains("listLivePageTitles")
    );
}

#[test]
fn capture_duplicates_match_the_fingerprint_newest_first_within_the_scan_limit() {
    let b = brain("write-path-capture");
    source(&b, "other", None);
    page(&b, "default", "chats/c", "conversation", "x", json!({}));
    let world = fact(
        &b,
        "default",
        json!({ "fact": "Alice likes tea", "visibility": "world" }),
    );
    let private = fact(
        &b,
        "default",
        json!({ "fact": "alice likes tea.", "visibility": "private" }),
    );
    let user = fact(
        &b,
        "default",
        json!({ "fact": "Alice likes tea", "attributed_to": "user" }),
    );
    let speaker = fact(
        &b,
        "default",
        json!({ "fact": "Alice likes tea", "attributed_to": "other" }),
    );
    let rewrite = fact(
        &b,
        "default",
        json!({ "fact": "Alice likes tea", "source": "cli:extract-conversation-facts:v1",
            "source_markdown_slug": "chats/c", "row_num": 1 }),
    );
    fact(&b, "default", json!({ "fact": "Alice likes coffee" }));
    fact(&b, "other", json!({ "fact": "Alice likes tea" }));
    let ask = |attributed: Option<&str>, replacing: Option<&str>, limit: f64| {
        let rows = b
            .list_capture_duplicate_candidates(&args::<CaptureDuplicateArgs>(json!({
                "sourceId": "default", "visibilities": ["world", "private"], "fact": "Alice likes tea",
                "attributedTo": attributed, "replacingPage": replacing, "scanLimit": limit,
            })))
            .unwrap();
        rows.iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ask(None, None, 50.0),
        [rewrite, speaker, user, private, world]
    );
    assert_eq!(
        ask(Some("user"), None, 50.0),
        [rewrite, user, private, world]
    );
    assert_eq!(
        ask(None, Some("chats/c"), 50.0),
        [speaker, user, private, world]
    );
    assert_eq!(ask(None, None, 2.0), [rewrite, speaker]);
    let row = &b
        .list_capture_duplicate_candidates(&args::<CaptureDuplicateArgs>(json!({
            "sourceId": "default", "visibilities": ["private"], "fact": "Alice likes tea",
            "attributedTo": null, "replacingPage": null, "scanLimit": 1,
        })))
        .unwrap()[0];
    assert!(row["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(
        b.list_capture_duplicate_candidates(&args::<CaptureDuplicateArgs>(json!({
            "sourceId": "default", "visibilities": ["world"], "fact": "x",
            "attributedTo": null, "replacingPage": null, "scanLimit": -1,
        })))
        .is_err()
    );
    let prints = b
        .compute_fact_fingerprints(&["Alice likes tea".into(), "alice likes tea.".into()])
        .unwrap();
    assert_eq!(prints.len(), 2);
    assert_eq!(prints[0], prints[1]);
}

#[test]
fn oversized_stale_facts_and_stale_counts_skip_withdrawn_claims() {
    let b = brain("write-path-oversized");
    source(&b, "other", None);
    let long = "x".repeat(300);
    let first = fact(&b, "default", json!({ "fact": format!("a {long}") }));
    let withdrawn = fact(&b, "default", json!({ "fact": format!("b {long}") }));
    fact(&b, "default", json!({ "fact": "short" }));
    let other = fact(&b, "other", json!({ "fact": format!("c {long}") }));
    b.insert_fact_withdrawal("default", "private", &format!("b {long}"), "people/a", None)
        .unwrap();
    let ask = |source_id: Option<&str>, max: f64| {
        let rows = b
            .list_oversized_stale_facts(&args::<OversizedStaleArgs>(json!({
                "sourceId": source_id, "model": "m1", "dims": 1536, "maxTokens": max,
            })))
            .unwrap();
        field(&rows, "id")
    };
    assert_eq!(ask(Some("default"), 200.0), [first.to_string()]);
    assert_eq!(ask(None, 200.0), [first.to_string(), other.to_string()]);
    assert!(ask(None, 400.0).is_empty());
    assert_ne!(withdrawn, first);
    // countStaleFactEmbeddings reads the same scan: the withdrawn row is not counted.
    let stale = b
        .count_stale_fact_embeddings(&CoverageQuery {
            source_id: Some("default".into()),
            model: "m1".into(),
            dims: 1536.0,
        })
        .unwrap();
    assert_eq!(stale["count"], json!(2));
}

#[test]
fn adopting_a_fact_gives_an_unfenced_row_its_fence_row_once() {
    let b = brain("write-path-adopt");
    page(&b, "default", "people/a", "person", "x", json!({}));
    fact(
        &b,
        "default",
        json!({ "fact": "held", "source": "fence", "source_markdown_slug": "people/a", "row_num": 1 }),
    );
    let loose = fact(&b, "default", json!({ "fact": "adopt me" }));
    b.adopt_fact_into_fence(&args::<AdoptFactArgs>(json!({
        "sourceId": "default", "id": loose.to_string(), "rowNum": 2, "slug": "people/a",
        "fact": "adopt me, as the fence reads it",
    })))
    .unwrap();
    // A second adoption finds the row fenced and changes nothing.
    b.adopt_fact_into_fence(&args::<AdoptFactArgs>(json!({
        "sourceId": "default", "id": loose.to_string(), "rowNum": 9, "slug": "people/a", "fact": "again",
    })))
    .unwrap();
    let claims = b.list_fence_row_claims(&at("default", "people/a")).unwrap();
    let flat: Vec<String> = claims
        .iter()
        .map(|c| {
            format!(
                "{}:{}:{}",
                c["row_num"],
                c["fact"].as_str().unwrap(),
                c["source"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        flat,
        ["1:held:fence", "2:adopt me, as the fence reads it:t"]
    );
    assert!(
        b.adopt_fact_into_fence(&args::<AdoptFactArgs>(json!({
            "sourceId": "default", "id": "abc", "rowNum": 3, "slug": "people/a", "fact": "x",
        })))
        .unwrap_err()
        .to_string()
        .contains("invalid input syntax for type bigint")
    );
}

#[test]
fn page_states_list_the_page_then_its_newest_body_versions() {
    let b = brain("write-path-states");
    source(&b, "repo", Some("/srv/repo"));
    source(&b, "bare", None);
    page(&b, "default", "notes/s", "note", "first body", json!({}));
    b.add_tag("notes/s", "alpha", Some("default")).unwrap();
    b.create_version("notes/s", Some("default")).unwrap();
    page(&b, "default", "notes/s", "note", "second body", json!({}));
    let states = b.list_page_states(&at("default", "notes/s")).unwrap();
    assert_eq!(
        field(&states, "compiled_truth"),
        ["second body", "first body"]
    );
    assert_eq!(states[0]["tags"], json!(["alpha"]));
    assert_eq!(states[0]["type"], json!("note"));
    assert!(
        b.list_page_states(&at("default", "notes/none"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.count_segmented_versions_of_page(&at("default", "notes/s"))
            .unwrap(),
        0
    );
    assert_eq!(
        b.read_source_checkout_path("repo").unwrap().as_deref(),
        Some("/srv/repo")
    );
    assert_eq!(b.read_source_checkout_path("bare").unwrap(), None);
    assert_eq!(b.read_source_checkout_path("none").unwrap(), None);
}
