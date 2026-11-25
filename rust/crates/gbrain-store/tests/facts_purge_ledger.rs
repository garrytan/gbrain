//! The fact purge ledger (`facts/purge_ledger.rs`): tombstones, the guard on fact writes, the fence
//! overlay's `purged` and the source probe.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::purge::PurgeTargetArgs;
use gbrain_store::facts::purge_ledger::{FactPurgeInsert, PURGED_CONTENT};
use gbrain_store::facts::{FenceOverlayInput, InsertFactArgs, InsertFactsArgs};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SLUG: &str = "people/purge-example";
const OTHER: &str = "people/other-example";
const REQUEST: &str = "6F9619FF-8B86-4D01-B42D-00CF4FC964FF";
const TERMINAL: &str = "cli:extract-conversation-facts:terminal:v2";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str) {
    let input: gbrain_store::pages::PageInput =
        args(json!({ "type": "person", "title": slug, "compiled_truth": "x" }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

fn row(text: &str, entity: Option<&str>, row_num: Option<i64>, visibility: &str) -> Value {
    json!({ "fact": text, "entity_slug": entity, "source_markdown_slug": row_num.map(|_| SLUG),
        "row_num": row_num, "kind": "fact", "visibility": visibility, "source": "fence" })
}

fn batch(b: &Brain, rows: Value) -> gbrain_store::error::Result<Value> {
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": rows, "sourceId": "default" }),
    ))
}

fn single(b: &Brain, input: Value) -> gbrain_store::error::Result<Value> {
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": "default" }),
    ))
}

fn hash_of(b: &Brain, text: &str, row_num: i64) -> String {
    let id = batch(b, json!([row(text, Some(SLUG), Some(row_num), "world")])).unwrap()["ids"][0]
        .as_u64()
        .unwrap();
    let target: PurgeTargetArgs = args(json!({ "id": id as f64, "sourceId": "default" }));
    b.load_purge_target(&target).unwrap()["fact_hash"]
        .as_str()
        .unwrap()
        .to_string()
}

fn tombstone(visibility: &str, subject: &str, hash: &str) -> FactPurgeInsert {
    args(
        json!({ "sourceId": "default", "visibility": visibility, "subject": subject,
        "factHash": hash, "requestId": REQUEST, "actor": "owner:local", "reason": "test" }),
    )
}

fn refused(result: gbrain_store::error::Result<Value>) -> bool {
    match result {
        Ok(_) => false,
        Err(e) => {
            assert_eq!(e.code, PURGED_CONTENT);
            assert!(e.message.starts_with("purged_content:"), "{}", e.message);
            true
        }
    }
}

#[test]
fn a_tombstone_is_stored_once_and_the_source_reports_it() {
    let b = brain("purge-once");
    assert!(!b.has_fact_purges("default").unwrap());
    let t = tombstone("world", "*", "abc");
    assert!(b.insert_fact_purge(&t).unwrap());
    assert!(!b.insert_fact_purge(&t).unwrap());
    assert!(b.has_fact_purges("default").unwrap());

    let bad = tombstone("team", "*", "abc");
    assert_eq!(
        b.insert_fact_purge(&bad).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut no_uuid = tombstone("world", "*", "def");
    no_uuid.request_id = Some("not-a-uuid".into());
    assert_eq!(
        b.insert_fact_purge(&no_uuid).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut missing = tombstone("world", "*", "def");
    missing.source_id = "nowhere".into();
    assert!(b.insert_fact_purge(&missing).is_err());
    assert!(!b.has_fact_purges("nowhere").unwrap());
}

#[test]
fn the_fence_overlay_reports_a_row_purged_under_every_subject_or_the_page() {
    let b = brain("purge-overlay");
    page(&b, SLUG);
    let bees = hash_of(&b, "Ana keeps bees", 1);
    let paints = hash_of(&b, "Ana paints", 2);
    let opera = hash_of(&b, "Ana sings opera", 3);
    for (vis, subject, hash) in [
        ("world", "*", &bees),
        ("world", SLUG, &paints),
        ("world", OTHER, &opera),
    ] {
        assert!(b.insert_fact_purge(&tombstone(vis, subject, hash)).unwrap());
    }
    let incoming: Vec<Value> = [
        ("Ana keeps bees", 1, "world"),
        ("Ana paints", 2, "world"),
        ("Ana sings opera", 3, "world"),
        ("Ana keeps bees", 4, "private"),
        ("  ANA keeps   bees. ", 5, "world"),
    ]
    .iter()
    .map(|(claim, n, vis)| json!({ "row_num": n, "claim": claim, "visibility": vis, "fp": null }))
    .collect();
    let input: FenceOverlayInput =
        args(json!({ "sourceId": "default", "slug": SLUG, "incoming": incoming }));
    let purged: Vec<bool> = b
        .read_fence_overlay_rows(&input)
        .unwrap()
        .iter()
        .map(|r| r["purged"].as_bool().unwrap())
        .collect();
    assert_eq!(purged, [true, true, false, false, true]);
}

#[test]
fn a_purged_claim_refuses_on_insert_and_saves_nothing() {
    let b = brain("purge-guard");
    page(&b, SLUG);
    let bees = hash_of(&b, "Ana keeps bees", 1);
    let paints = hash_of(&b, "Ana paints", 2);
    b.insert_fact_purge(&tombstone("world", "*", &bees))
        .unwrap();
    b.insert_fact_purge(&tombstone("world", SLUG, &paints))
        .unwrap();

    let before = b.has_fact_purges("default").unwrap();
    assert!(before);
    // A batch with one purged row saves none of them.
    assert!(refused(batch(
        &b,
        json!([
            row("Ana likes tea", Some(SLUG), Some(10), "world"),
            row("ana KEEPS bees", Some(SLUG), Some(11), "world")
        ])
    )));
    assert!(refused(single(
        &b,
        row("Ana keeps bees.", Some(OTHER), None, "world")
    )));
    assert!(refused(batch(
        &b,
        json!([row("Ana paints", Some(SLUG), Some(12), "world")])
    )));
    // An unbacked name key is reached by a tombstone of any subject.
    assert!(refused(single(
        &b,
        row("Ana paints", Some("ana"), None, "world")
    )));
    // Another subject or another visibility is not reached.
    assert!(!refused(single(
        &b,
        row("Ana paints", Some(OTHER), None, "world")
    )));
    assert!(!refused(batch(
        &b,
        json!([row("Ana keeps bees", Some(SLUG), Some(13), "private")])
    )));
    assert!(!refused(batch(
        &b,
        json!([row("Ana likes tea", Some(SLUG), Some(14), "world")])
    )));
}

#[test]
fn an_outcome_marker_is_not_refused_on_insert() {
    let b = brain("purge-marker");
    let hash = hash_of(&b, "EXTRACTION_COMPLETE", 1);
    b.insert_fact_purge(&tombstone("world", "*", &hash))
        .unwrap();
    let marker = |source: &str, n: i64| {
        json!([{ "fact": "EXTRACTION_COMPLETE", "entity_slug": SLUG, "visibility": "world",
            "source": source, "kind": "fact", "row_num": n, "source_markdown_slug": SLUG }])
    };
    assert!(!refused(batch(&b, marker(TERMINAL, 2))));
    assert!(refused(batch(&b, marker("fence", 3))));
}

#[test]
fn the_claim_checks_read_both_ledgers_for_their_subjects() {
    let b = brain("purge-claim-checks");
    page(&b, SLUG);
    let bees = hash_of(&b, "Ana keeps bees", 1);
    let paints = hash_of(&b, "Ana paints", 2);
    b.insert_fact_purge(&tombstone("world", "*", &bees))
        .unwrap();
    b.insert_fact_purge(&tombstone("private", SLUG, &paints))
        .unwrap();
    b.insert_fact_withdrawal("default", "private", "Ana reads", SLUG, None)
        .unwrap();
    b.insert_fact_withdrawal("default", "world", "Ana cooks", "members/ana", None)
        .unwrap();
    let purged = |vis, claim, entity| b.is_fact_purged("default", vis, claim, entity).unwrap();
    assert!(purged("world", "  ANA keeps   bees. ", None));
    assert!(!purged("private", "Ana keeps bees", Some(SLUG)));
    assert!(purged("private", "Ana paints", Some(SLUG)));
    assert!(!purged("private", "Ana paints", None));
    assert!(!purged("public", "Ana keeps bees", None));
    let withdrawn = |vis, claim, entity, member| {
        b.is_fact_withdrawn("default", vis, claim, entity, member)
            .unwrap()
    };
    assert!(withdrawn(None, "Ana reads", Some(SLUG), None));
    assert!(!withdrawn(Some("world"), "Ana reads", Some(SLUG), None));
    assert!(withdrawn(Some("private"), "Ana reads", None, Some(SLUG)));
    assert!(withdrawn(
        Some("world"),
        "Ana cooks",
        None,
        Some("members/ana")
    ));
    assert!(!withdrawn(Some("world"), "Ana cooks", Some(OTHER), None));
    assert!(withdrawn(None, "Ana paints", Some(SLUG), None));
    assert!(!withdrawn(None, "Ana paints", None, Some(SLUG)));
    assert!(withdrawn(Some("world"), "Ana keeps bees", None, None));
    assert!(
        !b.is_fact_withdrawn("missing", None, "Ana reads", Some(SLUG), None)
            .unwrap()
    );
    let nul = b
        .is_fact_purged("default", "world", "a\0b", None)
        .unwrap_err();
    assert_eq!(nul.code, INVALID_ARGUMENT);
}

#[test]
fn the_global_purge_lookup_answers_the_asked_star_tombstones_in_order() {
    let b = brain("purge-global");
    for (vis, subject, hash) in [
        ("world", "*", "bb"),
        ("private", "*", "bb"),
        ("world", "*", "aa"),
        ("world", SLUG, "cc"),
        ("world", "*", "zz"),
    ] {
        assert!(b.insert_fact_purge(&tombstone(vis, subject, hash)).unwrap());
    }
    let asked = ["aa", "bb", "cc"].map(String::from);
    let every = b
        .list_global_purge_withdrawals("default", &asked, false)
        .unwrap();
    let keys: Vec<(String, String)> = every
        .iter()
        .map(|w| {
            (
                w["visibility"].as_str().unwrap().into(),
                w["fact_hash"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        keys,
        [("private", "bb"), ("world", "aa"), ("world", "bb")]
            .map(|(v, h)| (v.to_string(), h.to_string()))
    );
    assert!(every.iter().all(|w| w["purged"] == true && w["withdrawn_at"].as_str().unwrap().ends_with("+00:00")));
    let world = b
        .list_global_purge_withdrawals("default", &asked, true)
        .unwrap();
    assert_eq!(world.len(), 2);
    assert!(
        b.list_global_purge_withdrawals("default", &[], false)
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_global_purge_withdrawals("other", &asked, false)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_purge_tombstones_list_each_source_tombstone_with_its_request_in_byte_order() {
    let b = brain("purge-tombstones");
    for (visibility, subject, hash) in [
        ("world", "people/b-example", "h2"),
        ("private", "people/b-example", "h1"),
        ("world", "people/a-example", "h9"),
        ("world", "people/a-example", "H3"),
    ] {
        assert!(
            b.insert_fact_purge(&tombstone(visibility, subject, hash))
                .unwrap()
        );
    }
    let mut elsewhere = tombstone("world", "people/a-example", "h0");
    let other: gbrain_store::sources::SourceInput = args(json!({ "id": "other" }));
    b.upsert_source(&other).unwrap();
    elsewhere.source_id = "other".into();
    b.insert_fact_purge(&elsewhere).unwrap();
    for (subject, claim) in [("people/b-example", "c1"), ("people/a-example", "c2")] {
        let row: gbrain_store::facts::take_purges::TakePurgeInsert = args(json!({
            "sourceId": "default", "subject": subject, "claimHash": claim, "requestId": REQUEST }));
        b.insert_take_purge(&row).unwrap();
    }
    let listed = b.list_purge_tombstones("default").unwrap();
    let request = REQUEST.to_lowercase();
    let fact = |visibility: &str, subject: &str, hash: &str| {
        json!({ "subject": subject, "visibility": visibility, "fact_hash": hash,
            "request_id": request, "actor": "owner:local", "reason": "test" })
    };
    assert_eq!(
        listed["facts"],
        json!([
            fact("private", "people/b-example", "h1"),
            fact("world", "people/a-example", "H3"),
            fact("world", "people/a-example", "h9"),
            fact("world", "people/b-example", "h2"),
        ])
    );
    assert_eq!(
        listed["takes"],
        json!([
            { "subject": "people/a-example", "claim_hash": "c2", "request_id": request },
            { "subject": "people/b-example", "claim_hash": "c1", "request_id": request },
        ])
    );
    assert_eq!(
        b.list_purge_tombstones("other").unwrap()["facts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        b.list_purge_tombstones("missing").unwrap(),
        json!({ "facts": [], "takes": [] })
    );
    assert_eq!(
        b.list_purge_tombstones("de\0fault").unwrap_err().code,
        INVALID_ARGUMENT
    );
}
