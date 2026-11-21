//! `listLexicalContestCandidates` (`facts/contest.rs`): the keyless conflict slot's read of a remember.

mod memory_env;

use gbrain_store::facts::contest::LexicalContestQuery;
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs, InsertFactsArgs};
use memory_env::brain;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn insert(b: &memory_env::Brain, input: Value) -> u64 {
    let out = b
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": input, "sourceId": "default" }),
        ))
        .unwrap();
    out["id"].as_u64().unwrap()
}

fn texts(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["fact"].as_str().unwrap()).collect()
}

#[test]
fn lexical_candidates_are_the_slot_rows_more_trusted_than_the_writer_newest_first() {
    let b = brain("facts-contest-lexical");
    let base = json!({ "source": "chat", "entity_slug": "people/pat", "kind": "fact", "visibility": "private" });
    let with = |fact: &str, extra: Value| {
        let mut v = base.clone();
        v["fact"] = json!(fact);
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    insert(&b, with("Pat lives in Lisbon", json!({})));
    insert(&b, with("Pat lives in Braga", json!({})));
    insert(
        &b,
        with(
            "Pat lives in Faro",
            json!({ "valid_until": "2020-01-01T00:00:00Z" }),
        ),
    );
    let gone = insert(&b, with("Pat lives in Evora", json!({})));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone as f64 })))
        .unwrap();
    insert(&b, with("Pat is a pilot", json!({ "kind": "preference" })));
    insert(
        &b,
        with("Pat lives in Tavira", json!({ "visibility": "world" })),
    );
    insert(
        &b,
        with("Sam lives in Lagos", json!({ "entity_slug": "people/sam" })),
    );
    b.insert_facts(&args::<InsertFactsArgs>(json!({ "sourceId": "default", "rows": [
        with("Pat lives in Porto", json!({ "source_markdown_slug": "memory/members/pat", "row_num": 1, "source": "fence" })),
    ] })))
    .unwrap();
    let read = |writer: &str, page: Option<&str>| {
        b.list_lexical_contest_candidates(&args::<LexicalContestQuery>(json!({
            "sourceId": "default", "entitySlug": "people/pat", "kind": "fact",
            "visibility": "private", "pageSlug": page, "writer": writer })))
            .unwrap()
    };
    let rows = read("external_untrusted", None);
    assert_eq!(texts(&rows), ["Pat lives in Braga", "Pat lives in Lisbon"]);
    assert_eq!(rows[0]["trust_tier"], "unknown");
    assert!(rows[0]["id"].is_u64());
    // A writer with no known tier ranks 0, below every stored tier.
    assert_eq!(texts(&read("no-such-tier", None)).len(), 2);
    // Typed writes are tier unknown (rank 2): an equal or higher writer contests nothing.
    assert!(read("unknown", None).is_empty());
    assert!(read("user_confirmed", None).is_empty());
    assert_eq!(
        texts(&read("external_untrusted", Some("memory/members/pat"))),
        ["Pat lives in Porto"]
    );
    // An empty page slug reads as no page.
    assert_eq!(texts(&read("external_untrusted", Some(""))).len(), 2);
}
