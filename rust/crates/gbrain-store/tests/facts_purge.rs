//! Group 5 facts members: purge, withdrawal, relink and fence repair (`facts/purge.rs`).

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::purge::{
    FactScopeArgs, HeldFenceQuery, PurgeTargetArgs, RelinkQuery, SimilarQuery, SingleFactQuery,
    SourceArgs, UnfencedQuery, WithdrawalExpiry,
};
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs, InsertFactsArgs};
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;
const TERMINAL: &str = "cli:extract-conversation-facts:terminal:v2";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn insert(b: &Brain, input: Value) -> u64 {
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": "default" }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn batch(b: &Brain, rows: Value) -> Vec<u64> {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": "default" }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect()
}

fn page(b: &Brain, slug: &str) {
    let input: gbrain_store::pages::PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": "x" }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

fn fact(entity: Option<&str>, text: &str, visibility: &str) -> Value {
    json!({ "fact": text, "entity_slug": entity, "visibility": visibility, "source": "chat" })
}

/// A vector literal 1536 wide: `head` in the first slots, zero elsewhere.
fn literal(head: &[f64]) -> String {
    let mut v = vec!["0".to_string(); 1536];
    for (slot, x) in v.iter_mut().zip(head) {
        *slot = x.to_string();
    }
    format!("[{}]", v.join(","))
}

fn scope(visibility: &str, hash: &str, subject: &str) -> FactScopeArgs {
    args(
        json!({ "sourceId": "default", "visibility": visibility, "factHash": hash, "subject": subject }),
    )
}

fn hash_of(b: &Brain, id: u64) -> String {
    let target: PurgeTargetArgs = args(json!({ "id": id as f64, "sourceId": "default" }));
    b.load_purge_target(&target).unwrap()["fact_hash"]
        .as_str()
        .unwrap()
        .to_string()
}

fn ids(rows: &[Value]) -> Vec<u64> {
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

#[test]
fn load_purge_target_reads_the_row_with_its_fingerprint_and_vector_text() {
    let b = brain("purge-target");
    let id = insert(
        &b,
        json!({ "fact": "Alice  likes TEA", "entity_slug": "people/alice", "source": "chat",
            "embedding": literal(&[1.0, 0.5, 0.1]), "embedding_model": "m1" }),
    );
    let marker = insert(
        &b,
        json!({ "fact": "EXTRACTION_COMPLETE", "source": TERMINAL, "entity_slug": "people/alice" }),
    );
    let plain = insert(&b, json!({ "fact": "plain", "source": "chat" }));
    let load = |id: f64, source: &str| {
        b.load_purge_target(&args(json!({ "id": id, "sourceId": source })))
            .unwrap()
    };
    let row = load(id as f64, "default");
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["fact"], "Alice  likes TEA");
    assert_eq!(row["entity_slug"], "people/alice");
    assert_eq!(row["source_markdown_slug"], Value::Null);
    assert_eq!(row["visibility"], "private");
    assert_eq!(row["embedding_model"], "m1");
    let text = row["embedding"].as_str().unwrap();
    assert!(text.starts_with("[1,0.5,0.099975586,0,"));
    assert!(text.ends_with(",0]"));
    assert_eq!(text.split(',').count(), 1536);
    assert_eq!(row["fact_hash"].as_str().unwrap().len(), 64);
    // No vector: null text and model.
    let none = load(plain as f64, "default");
    assert_eq!(none["embedding"], Value::Null);
    assert_eq!(none["embedding_model"], Value::Null);
    // A checkpoint row, another source, an unknown id and an id no row can have answer nothing.
    assert_eq!(load(marker as f64, "default"), Value::Null);
    assert_eq!(load(id as f64, "other"), Value::Null);
    assert_eq!(load(999.0, "default"), Value::Null);
    assert_eq!(load(0.0, "default"), Value::Null);
    let fractional = b.load_purge_target(&args(json!({ "id": 1.5, "sourceId": "default" })));
    assert_eq!(fractional.unwrap_err().code, INVALID_ARGUMENT);
}

#[test]
fn plan_ids_and_leftovers_split_a_claim_by_visibility_and_subject() {
    let b = brain("purge-plan");
    page(&b, "people/alice");
    let a = insert(&b, fact(Some("people/alice"), "Shared claim", "private"));
    let bob = insert(&b, fact(Some("people/bob"), "shared  claim.", "private"));
    let loose = insert(&b, fact(None, "SHARED CLAIM", "private"));
    let name_key = insert(&b, fact(Some("alice"), "Shared claim", "private"));
    let backed_key = insert(&b, fact(Some("people"), "Shared claim", "private"));
    page(&b, "people");
    let world = insert(&b, fact(Some("people/alice"), "Shared claim", "world"));
    let other = insert(&b, fact(Some("people/alice"), "Other claim", "private"));
    let hash = hash_of(&b, a);
    assert_eq!(hash_of(&b, bob), hash);
    assert_eq!(hash_of(&b, loose), hash);
    assert_ne!(hash_of(&b, other), hash);
    let plan = |subject: &str| {
        ids(&b
            .plan_fact_purge_ids(&scope("private", &hash, subject))
            .unwrap())
    };
    // The subject's rows and the unbacked name key (the unbacked key reaches under any subject).
    assert_eq!(plan("people/alice"), [a, name_key]);
    assert_eq!(plan("people/bob"), [bob, name_key]);
    assert_eq!(plan("*"), [a, bob, loose, name_key, backed_key]);
    assert_eq!(plan("people/missing"), [name_key]);
    assert_eq!(
        ids(&b.plan_fact_purge_ids(&scope("world", &hash, "*")).unwrap()),
        [world]
    );
    assert!(
        ids(&b
            .plan_fact_purge_ids(&scope("private", "nope", "*"))
            .unwrap())
        .is_empty()
    );
    // A checkpoint row of the same text is never planned or counted; a chat row of it is.
    let text = insert(
        &b,
        fact(Some("people/alice"), "EXTRACTION_COMPLETE", "private"),
    );
    insert(
        &b,
        json!({ "fact": "EXTRACTION_COMPLETE", "source": TERMINAL, "entity_slug": "people/alice" }),
    );
    insert(
        &b,
        json!({ "fact": "EXTRACTION_COMPLETE", "source": TERMINAL, "entity_slug": "people/bob" }),
    );
    let marker_hash = hash_of(&b, text);
    assert_eq!(
        ids(&b
            .plan_fact_purge_ids(&scope("private", &marker_hash, "*"))
            .unwrap()),
        [text]
    );
    assert_eq!(
        b.count_fact_fingerprint_leftovers(&scope("world", &marker_hash, "*"))
            .unwrap(),
        1
    );
    // Leftovers: another visibility, or another entity (a row with no entity counts only for the visibility).
    let left = |vis: &str, subject: &str| {
        b.count_fact_fingerprint_leftovers(&scope(vis, &hash, subject))
            .unwrap()
    };
    assert_eq!(left("private", "*"), 1);
    assert_eq!(left("world", "*"), 5);
    assert_eq!(left("private", "people/alice"), 1 + 3);
    assert_eq!(left("world", "people/alice"), 5);
    assert_eq!(left("private", "people/zed"), 1 + 4);
}

#[test]
fn relink_candidates_are_the_loose_active_rows_after_an_id() {
    let b = brain("purge-relink");
    let old = insert(&b, fact(None, "old loose", "private"));
    b.clock.advance(DAY);
    let one = insert(&b, fact(None, "loose one", "world"));
    let two = insert(
        &b,
        json!({ "fact": "loose two", "source": "s", "context": "ctx", "attributed_to": "user" }),
    );
    insert(&b, fact(Some("people/alice"), "has entity", "private"));
    let expired = insert(&b, fact(None, "expired loose", "private"));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired as f64 })))
        .unwrap();
    insert(
        &b,
        json!({ "fact": "lapsed", "source": "s", "valid_until": iso(T0) }),
    );
    batch(
        &b,
        json!([{ "fact": "fenced", "source": "fence", "row_num": 1, "source_markdown_slug": "notes/a" },
               { "fact": "paged", "source": "fence", "source_markdown_slug": "notes/b" }]),
    );
    let list = |after: f64, since: Option<String>, limit: f64| {
        b.list_relink_candidate_rows(&args::<RelinkQuery>(
            json!({ "sourceId": "default", "afterId": after, "since": since, "limit": limit }),
        ))
        .unwrap()
    };
    assert_eq!(ids(&list(0.0, None, 100.0)), [old, one, two]);
    assert_eq!(ids(&list(old as f64, None, 100.0)), [one, two]);
    assert_eq!(ids(&list(0.0, None, 2.0)), [old, one]);
    assert_eq!(ids(&list(0.0, Some(iso(T0 + DAY)), 100.0)), [one, two]);
    let rows = list(0.0, None, 100.0);
    assert_eq!(
        rows[2],
        json!({ "id": two, "fact": "loose two", "visibility": "private", "context": "ctx",
                "source": "s", "attributed_to": "user" })
    );
    assert_eq!(rows[0]["context"], Value::Null);
    assert_eq!(rows[0]["attributed_to"], Value::Null);
    // The fence-owned and page-owned loose rows are counted; an expired one still is not.
    let owned = |source: &str| {
        b.count_relink_candidates(&args::<SourceArgs>(json!({ "sourceId": source })))
            .unwrap()
    };
    assert_eq!(owned("default"), 2);
    assert_eq!(owned("other"), 0);
}

#[test]
fn similar_active_facts_rank_same_model_neighbours_of_the_entity() {
    let b = brain("purge-similar");
    let vec_row = |text: &str, head: &[f64], model: &str, entity: Option<&str>, vis: &str| {
        insert(
            &b,
            json!({ "fact": text, "source": "s", "entity_slug": entity, "visibility": vis,
                "embedding": literal(head), "embedding_model": model }),
        )
    };
    let anchor = vec_row("anchor", &[1.0, 0.0], "m1", Some("people/a"), "private");
    let near = vec_row("near", &[1.0, 0.1], "m1", Some("people/a"), "private");
    let nearer = vec_row("nearer", &[1.0, 0.01], "m1", Some("people/a"), "private");
    let tie = vec_row("tie", &[1.0, 0.01], "m1", Some("people/a"), "private");
    let _far = vec_row("far", &[0.0, 1.0], "m1", Some("people/a"), "private");
    let _model = vec_row("model", &[1.0, 0.0], "m2", Some("people/a"), "private");
    let _entity = vec_row("entity", &[1.0, 0.0], "m1", Some("people/b"), "private");
    let _world = vec_row("world", &[1.0, 0.0], "m1", Some("people/a"), "world");
    let gone = vec_row("gone", &[1.0, 0.0], "m1", Some("people/a"), "private");
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone as f64 })))
        .unwrap();
    let plain = insert(&b, fact(Some("people/a"), "no vector", "private"));
    let q = |id: u64, remote: bool, min: f64, limit: f64| {
        b.list_similar_active_facts(&args::<SimilarQuery>(json!({
            "sourceId": "default", "factId": id as f64, "remote": remote,
            "minCosine": min, "limit": limit })))
            .unwrap()
    };
    let out = q(anchor, false, 0.9, 10.0);
    assert_eq!(
        out["anchor"],
        json!({ "has_embedding": true, "entity_slug": "people/a" })
    );
    let rows = out["rows"].as_array().unwrap();
    assert_eq!(ids(rows), [nearer, tie, near]);
    assert!((rows[0]["similarity"].as_f64().unwrap() - 0.99995).abs() < 1e-4);
    assert_eq!(
        ids(q(anchor, false, 0.9, 2.0)["rows"].as_array().unwrap()),
        [nearer, tie]
    );
    assert!(
        q(anchor, false, 1.5, 10.0)["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // `remote` keeps world rows only: none is a neighbour of a private anchor.
    assert!(
        q(anchor, true, 0.0, 10.0)["rows"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // An anchor with no vector answers its flag and no rows; an unknown id answers no anchor.
    let none = q(plain, false, 0.0, 10.0);
    assert_eq!(
        none,
        json!({ "anchor": { "has_embedding": false, "entity_slug": "people/a" }, "rows": [] })
    );
    assert_eq!(
        q(9999, false, 0.0, 10.0),
        json!({ "anchor": null, "rows": [] })
    );
}

#[test]
fn find_active_single_fact_with_newest_answers_the_highest_id_copy() {
    let b = brain("purge-single-newest");
    let old = insert(&b, fact(None, "Likes tea", "private"));
    let newer = insert(&b, fact(None, "likes  TEA.", "private"));
    let expired = insert(&b, fact(None, "Likes tea", "private"));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired as f64 })))
        .unwrap();
    insert(&b, fact(Some("people/a"), "Likes tea", "private"));
    insert(&b, fact(None, "Likes tea", "world"));
    let member = batch(
        &b,
        json!([{ "fact": "Likes tea", "source": "chat", "source_markdown_slug": "memory/members/alice", "row_num": 1 },
              { "fact": "Likes tea", "source": "chat", "source_markdown_slug": "memory/members/alice", "row_num": 2 }]),
    );
    let find = |page: Option<&str>, newest: Option<bool>| {
        let mut q = json!({ "sourceId": "default", "entitySlug": null, "visibility": "private",
            "fact": "likes tea", "attributedTo": null, "pageSlug": page });
        if let Some(n) = newest {
            q["newest"] = json!(n);
        }
        b.find_active_single_fact(&args::<SingleFactQuery>(q))
            .unwrap()["id"]
            .as_u64()
    };
    assert_eq!(find(None, None), Some(old));
    assert_eq!(find(None, Some(false)), Some(old));
    assert_eq!(find(None, Some(true)), Some(newer));
    assert_eq!(
        find(Some("memory/members/alice"), Some(true)),
        Some(member[1])
    );
    assert_eq!(find(Some("memory/members/alice"), None), Some(member[0]));
    assert_eq!(find(Some(""), Some(true)), None);
}

#[test]
fn find_active_single_fact_matches_the_speaker_slot_and_page() {
    let b = brain("purge-single");
    let plain = insert(&b, fact(Some("people/a"), "Likes tea", "private"));
    let by_user = insert(
        &b,
        json!({ "fact": "likes  TEA.", "source": "chat", "entity_slug": "people/a", "attributed_to": "user",
            "embedding": literal(&[0.5]), "embedding_model": "m1" }),
    );
    let fenced = batch(
        &b,
        json!([{ "fact": "Likes tea", "source": "chat", "entity_slug": "people/a",
                "source_markdown_slug": "memory/members/alice", "row_num": 1 },
              { "fact": "Likes tea", "source": "chat", "entity_slug": "people/a",
                "source_markdown_slug": "notes/a", "row_num": 2 }]),
    );
    let (on_member, on_page) = (fenced[0], fenced[1]);
    let loose = insert(&b, fact(None, "Likes tea", "private"));
    let find = |entity: Option<&str>, who: Option<&str>, page: Option<&str>| {
        b.find_active_single_fact(&args::<SingleFactQuery>(json!({
            "sourceId": "default", "entitySlug": entity, "visibility": "private",
            "fact": "likes tea", "attributedTo": who, "pageSlug": page })))
            .unwrap()
    };
    let id_of = |row: &Value| row["id"].as_u64();
    assert_eq!(id_of(&find(Some("people/a"), None, None)), Some(plain));
    assert_eq!(
        id_of(&find(Some("people/a"), Some("user"), None)),
        Some(plain)
    );
    assert_eq!(
        id_of(&find(Some("people/a"), None, Some("notes/a"))),
        Some(on_page)
    );
    assert_eq!(
        id_of(&find(Some("people/a"), None, Some("memory/members/alice"))),
        Some(on_member)
    );
    assert_eq!(id_of(&find(None, None, None)), Some(loose));
    assert_eq!(find(Some("people/a"), None, Some("")), Value::Null);
    assert_eq!(
        find(Some("people/a"), None, Some("notes/none")),
        Value::Null
    );
    assert_eq!(find(Some("people/zed"), None, None), Value::Null);
    // With the lowest id gone the speaker slot's own row answers, with every column of the row.
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": plain as f64 })))
        .unwrap();
    let row = find(Some("people/a"), Some("user"), None);
    assert_eq!(id_of(&row), Some(by_user));
    assert_eq!(row["attributed_to"], "user");
    assert_eq!(row["embedding_model"], "m1");
    assert!(row["embedding"].as_str().unwrap().starts_with("[0.5,0,"));
    assert_eq!(row["trust_tier"], "unknown");
    assert_eq!(row["write_origin"], Value::Null);
    assert_eq!(row["source_window"], Value::Null);
    assert_eq!(row["row_num"], Value::Null);
    assert_eq!(row["expired_at"], Value::Null);
    assert!(row["created_at"].is_string());
    assert_eq!(row["confidence"].as_f64(), Some(1.0));
    // A row of another speaker is no match; the row of no speaker still is.
    assert_eq!(
        id_of(&find(Some("people/a"), Some("assistant"), None)),
        Some(on_page)
    );
}

#[test]
fn unfenced_rows_and_held_fence_rows_read_the_fence_state() {
    let b = brain("purge-fence");
    page(&b, "people/alice");
    let upper = insert(&b, fact(Some("People/zed"), "upper", "private"));
    let alice = insert(
        &b,
        json!({ "fact": "alice fact", "source": "chat", "entity_slug": "people/alice",
            "claim_metric": "arr", "claim_value": 1.5, "attributed_to": "user" }),
    );
    let bob = insert(&b, fact(Some("people/bob"), "bob fact", "world"));
    let loose = insert(&b, fact(None, "loose", "private"));
    let expired = insert(&b, fact(Some("people/bob"), "expired", "private"));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired as f64 })))
        .unwrap();
    batch(
        &b,
        json!([
            { "fact": "fenced 2", "source": "fence", "row_num": 2, "source_markdown_slug": "people/alice",
              "entity_slug": "people/alice" },
            { "fact": "fenced 1", "source": "fence", "row_num": 1, "source_markdown_slug": "people/alice",
              "entity_slug": "people/alice", "claim_metric": "arr", "claim_value": 2.0 },
            { "fact": "conversation", "source": "cli:extract-conversation-facts:segment", "row_num": 3,
              "source_markdown_slug": "people/alice", "entity_slug": "people/alice" },
            { "fact": "dimension", "source": "ontology", "dimension": "role", "value": "cto",
              "entity_slug": "people/alice" }
        ]),
    );
    let rows = b
        .list_unfenced_fact_rows(&args::<UnfencedQuery>(json!({})))
        .unwrap();
    // Source, then entity by bytes (upper case first, an entity-less row last), then id.
    assert_eq!(ids(&rows), [upper, alice, bob, loose]);
    assert_eq!(rows[0]["page_exists"], false);
    assert_eq!(rows[1]["page_exists"], true);
    assert_eq!(rows[2]["page_exists"], false);
    assert_eq!(rows[3]["page_exists"], false);
    assert_eq!(rows[1]["claim_value"].as_f64(), Some(1.5));
    assert_eq!(rows[1]["attributed_to"], "user");
    assert_eq!(rows[1]["confidence"].as_f64(), Some(1.0));
    assert_eq!(rows[1]["valid_until"], Value::Null);
    assert!(rows[1]["valid_from"].is_string());
    let one = b
        .list_unfenced_fact_rows(&args::<UnfencedQuery>(json!({ "sourceId": "default" })))
        .unwrap();
    assert_eq!(ids(&one), ids(&rows));
    let none = b
        .list_unfenced_fact_rows(&args::<UnfencedQuery>(json!({ "sourceId": "other" })))
        .unwrap();
    assert!(none.is_empty());
    // Held fence rows: by position, a conversation extractor's own row and an expired one apart.
    let held = b
        .list_held_fence_fact_rows(&args::<HeldFenceQuery>(
            json!({ "sourceId": "default", "slug": "people/alice" }),
        ))
        .unwrap();
    let facts: Vec<&str> = held.iter().map(|r| r["fact"].as_str().unwrap()).collect();
    assert_eq!(facts, ["fenced 1", "fenced 2"]);
    assert_eq!(held[0]["row_num"], 1);
    assert_eq!(held[0]["claim_metric"], "arr");
    assert_eq!(held[0]["claim_value"].as_f64(), Some(2.0));
    assert_eq!(held[0]["entity_slug"], "people/alice");
    assert_eq!(held[0]["source"], "fence");
    assert_eq!(held[0]["confidence"].as_f64(), Some(1.0));
    let elsewhere = b
        .list_held_fence_fact_rows(&args::<HeldFenceQuery>(
            json!({ "sourceId": "default", "slug": "people/none" }),
        ))
        .unwrap();
    assert!(elsewhere.is_empty());
}

#[test]
fn withdrawal_slugs_and_expiry_follow_the_subject_rules() {
    let b = brain("purge-withdrawal");
    page(&b, "people/alice");
    let a = insert(&b, fact(Some("people/alice"), "Withdraw me", "private"));
    let bob = insert(&b, fact(Some("people/bob"), "withdraw me", "private"));
    let key = insert(&b, fact(Some("alice"), "Withdraw me.", "private"));
    let loose = insert(&b, fact(None, "Withdraw  me", "private"));
    let fenced_rows = batch(
        &b,
        json!([{ "fact": "Withdraw me", "source": "fence", "entity_slug": "people/bob",
                "source_markdown_slug": "notes/page", "row_num": 1 },
              { "fact": "Withdraw me", "source": "fence", "entity_slug": "people/carol",
                "source_markdown_slug": "memory/members/carol", "row_num": 1 }]),
    );
    let (fenced, member) = (fenced_rows[0], fenced_rows[1]);
    let world = insert(&b, fact(Some("people/alice"), "Withdraw me", "world"));
    let hash = hash_of(&b, a);
    let slugs = |subject: &str| -> Vec<String> {
        b.list_withdrawal_slugs(&scope("private", &hash, subject))
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    // A fenced row is named by its page; an unbacked name key reaches under any subject but an owned page.
    assert_eq!(slugs("people/alice"), ["alice", "people/alice"]);
    assert_eq!(slugs("people/bob"), ["alice", "notes/page", "people/bob"]);
    assert_eq!(slugs("memory/members/carol"), ["memory/members/carol"]);
    assert_eq!(
        slugs("*"),
        [
            "alice",
            "memory/members/carol",
            "notes/page",
            "people/alice",
            "people/bob"
        ]
    );
    assert_eq!(slugs("people/zed"), ["alice"]);
    let expire = |vis: &str, subject: &str| {
        b.expire_facts_by_withdrawal(&args::<WithdrawalExpiry>(json!({
            "sourceId": "default", "visibility": vis, "fact": "WITHDRAW ME", "subject": subject })))
            .unwrap()
    };
    b.clock.advance(DAY);
    assert_eq!(ids(&expire("private", "people/alice")), [a, key]);
    // Nothing is left of those rows to expire a second time.
    assert!(expire("private", "people/alice").is_empty());
    // A purge plan reads expired rows too; the withdrawal's slugs do not.
    let live = |subject: &str| {
        ids(&b
            .plan_fact_purge_ids(&scope("private", &hash, subject))
            .unwrap())
    };
    assert_eq!(live("*"), [a, bob, key, loose, fenced, member]);
    assert_eq!(
        slugs("*"),
        ["memory/members/carol", "notes/page", "people/bob"]
    );
    assert_eq!(ids(&expire("private", "memory/members/carol")), [member]);
    assert_eq!(ids(&expire("private", "*")), [bob, loose, fenced]);
    assert_eq!(ids(&expire("world", "*")), [world]);
    assert!(slugs("*").is_empty());
    let after = b
        .list_facts_by_entity(&args(
            json!({ "sourceId": "default", "entitySlug": "people/alice", "limit": 50 }),
        ))
        .unwrap();
    let row = after.iter().find(|r| r["id"] == json!(a)).unwrap();
    assert_eq!(row["expired_at"], iso(T0 + DAY));
    assert_eq!(row["valid_until"], iso(T0 + DAY));
}

#[test]
fn find_active_single_fact_under_the_remote_floor_judges_only_the_holding_page() {
    let b = brain("purge-single-floor");
    let private_page = |slug: &str, frontmatter: Value| {
        let input: gbrain_store::pages::PageInput = args(json!({ "type": "note", "title": slug,
            "compiled_truth": "x", "frontmatter": frontmatter }));
        b.put_page(slug, &input, &args(json!({}))).unwrap();
    };
    private_page("people/secret", json!({ "visibility": "private" }));
    private_page("notes/hidden", json!({ "visibility": "private" }));
    page(&b, "notes/open");
    let rows = batch(
        &b,
        json!([{ "fact": "Likes tea", "source": "chat", "entity_slug": "people/secret",
                "source_markdown_slug": "notes/hidden", "row_num": 1 },
              { "fact": "Likes tea", "source": "chat", "entity_slug": "people/secret",
                "source_markdown_slug": "notes/open", "row_num": 1 }]),
    );
    let (hidden, open) = (rows[0], rows[1]);
    let find = |page: Option<&str>, floor: bool| {
        let floor = floor.then(
            || json!({ "honorAliases": true, "entityPrivacy": false, "provenanceOnly": true, "ownerOnly": "fn" }),
        );
        b.find_active_single_fact(&args::<SingleFactQuery>(json!({
            "sourceId": "default", "entitySlug": "people/secret", "visibility": "private",
            "fact": "likes tea", "attributedTo": null, "pageSlug": page, "remoteFloor": floor })))
            .unwrap()["id"]
            .as_u64()
    };
    assert_eq!(find(Some("notes/hidden"), false), Some(hidden));
    assert_eq!(find(Some("notes/hidden"), true), None);
    // The entity page is private, but the floor has no entity gate.
    assert_eq!(find(Some("notes/open"), true), Some(open));
    assert_eq!(find(None, false), Some(hidden));
    assert_eq!(find(None, true), Some(open));
}
