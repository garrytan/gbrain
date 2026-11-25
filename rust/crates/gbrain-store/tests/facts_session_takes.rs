//! The agent-session repair members of `facts/session_takes.rs`, each against the rows its PGLite statement returns
//! (src/core/engine-sql/facts-repair.ts).

mod memory_env;

use gbrain_store::facts::captured::NamedFactsArgs;
use gbrain_store::facts::session_takes::{
    ReattributeArgs, RetireTakesArgs, SessionTakeCandidatesArgs, TakeIdsArgs,
};
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const NOTE: &str = "[agent-session]";
const SEP: &str = " ; ";

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str) {
    b.upsert_source(&de::<SourceInput>(json!({ "id": id, "name": id })))
        .unwrap();
}

fn page(b: &Brain, source: &str, slug: &str) -> u64 {
    let input: PageInput = de(json!({ "type": "note", "title": slug, "compiled_truth": "x" }));
    let opts: PutPageOptions = de(json!({ "sourceId": source }));
    b.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// Adds self fact takes at rows 1.. of the page and answers their ids, in row order.
fn takes(b: &Brain, page_id: u64, claims: &[&str]) -> Vec<u64> {
    let rows: Vec<TakeInput> = claims
        .iter()
        .enumerate()
        .map(|(i, c)| {
            de(json!({ "page_id": page_id, "row_num": i + 1, "claim": c, "kind": "fact", "holder": "self",
                       "weight": 0.5, "active": true }))
        })
        .collect();
    b.add_takes_batch(&rows).unwrap();
    let listed = b
        .list_takes(&de(
            json!({ "page_id": page_id, "active": null, "limit": 100 }),
        ))
        .unwrap();
    (1..=claims.len())
        .map(|row| {
            listed.iter().find(|t| t["row_num"] == row).unwrap()["id"]
                .as_u64()
                .unwrap()
        })
        .collect()
}

/// One database-only fact of the source; `extra` overrides the defaults.
fn fact(b: &Brain, source: &str, claim: &str, extra: Value) -> u64 {
    let mut input =
        json!({ "fact": claim, "entity_slug": "people/a", "kind": "fact", "source": "t" });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let id = b
        .insert_fact(&de::<InsertFactArgs>(
            json!({ "input": input, "sourceId": source }),
        ))
        .unwrap()["id"]
        .as_u64()
        .unwrap();
    b.clock.advance(1);
    id
}

fn consolidate(b: &Brain, fact: u64, take: u64) {
    b.consolidate_fact(fact as f64, take as f64).unwrap();
}

fn candidates(b: &Brain, sources: &[&str], ids: Option<Vec<u64>>) -> Vec<Value> {
    b.list_agent_session_take_candidates(&de::<SessionTakeCandidatesArgs>(
        json!({ "sourceIds": sources, "ids": ids, "noteMark": NOTE }),
    ))
    .unwrap()
}

fn ids(rows: &[Value]) -> Vec<u64> {
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

fn named(source: &str, ids: &[u64]) -> NamedFactsArgs {
    de(json!({ "sourceId": source, "ids": ids }))
}

#[test]
fn take_candidates_group_the_facts_of_the_named_sources_and_skip_closed_and_older_takes() {
    let b = brain("session-takes-candidates");
    source(&b, "other");
    let p = page(&b, "default", "notes/takes");
    let t = takes(
        &b,
        p,
        &[
            "noted take",
            "other only",
            "user take",
            "never consolidated",
        ],
    );
    let a1 = fact(&b, "default", "a1", json!({ "attributed_to": "user" }));
    let a2 = fact(
        &b,
        "default",
        "a2",
        json!({ "attributed_to": "other", "context": format!("heard {NOTE}") }),
    );
    let b1 = fact(&b, "default", "b1", json!({ "attributed_to": "other" }));
    let c1 = fact(&b, "default", "c1", json!({}));
    let away = fact(&b, "other", "away", json!({ "attributed_to": "user" }));
    for (f, take) in [(a1, t[0]), (a2, t[0]), (b1, t[1]), (c1, t[2]), (away, t[2])] {
        consolidate(&b, f, take);
    }
    assert_eq!(
        candidates(&b, &["default"], None),
        vec![
            json!({ "id": t[0], "source_id": "default", "slug": "notes/takes", "row_num": 1, "claim": "noted take",
                    "fact_ids": [a1, a2], "user_fact_ids": [a1], "noted": true }),
            json!({ "id": t[1], "source_id": "default", "slug": "notes/takes", "row_num": 2, "claim": "other only",
                    "fact_ids": [b1], "user_fact_ids": [], "noted": false }),
            json!({ "id": t[2], "source_id": "default", "slug": "notes/takes", "row_num": 3, "claim": "user take",
                    "fact_ids": [c1], "user_fact_ids": [c1], "noted": false }),
        ]
    );
    assert_eq!(
        ids(&candidates(&b, &["default"], Some(vec![t[1], 999_999]))),
        vec![t[1]]
    );
    assert!(candidates(&b, &[], None).is_empty());
    // The take's page is in `default`, so the `other` facts alone name no candidate.
    assert!(candidates(&b, &["other"], None).is_empty());

    // A take created more than one second before its first consolidation is not a session take.
    let old = takes(&b, page(&b, "default", "notes/old"), &["old take"])[0];
    b.clock.advance(2_000_000);
    let late = fact(&b, "default", "late", json!({ "attributed_to": "other" }));
    consolidate(&b, late, old);
    assert!(!ids(&candidates(&b, &["default"], None)).contains(&old));
    let retired = b
        .retire_session_takes(&de::<RetireTakesArgs>(
            json!({ "sourceId": "default", "takeIds": [old] }),
        ))
        .unwrap();
    assert!(retired.is_empty());
}

#[test]
fn retire_session_takes_needs_every_contributor_of_every_source_non_user_and_the_take_page_in_the_source()
 {
    let b = brain("session-takes-retire");
    source(&b, "other");
    let p = page(&b, "default", "notes/takes");
    let t = takes(&b, p, &["other only", "user elsewhere", "user here"]);
    let f1 = fact(&b, "default", "f1", json!({ "attributed_to": "other" }));
    let f2 = fact(&b, "default", "f2", json!({ "attributed_to": "other" }));
    let away = fact(&b, "other", "away", json!({ "attributed_to": "user" }));
    let f3 = fact(&b, "default", "f3", json!({}));
    for (f, take) in [(f1, t[0]), (f2, t[1]), (away, t[1]), (f3, t[2])] {
        consolidate(&b, f, take);
    }
    let retire = |source: &str, takes: &[u64]| {
        ids(&b
            .retire_session_takes(&de::<RetireTakesArgs>(
                json!({ "sourceId": source, "takeIds": takes }),
            ))
            .unwrap())
    };
    assert!(retire("other", &[t[0]]).is_empty());
    assert_eq!(retire("default", &[t[0], t[1], t[2], 999_999]), vec![t[0]]);
    assert!(retire("default", &[t[0]]).is_empty());
    let inactive = b
        .list_inactive_take_ids(&de::<TakeIdsArgs>(json!({ "ids": [t[0], t[1], t[2]] })))
        .unwrap();
    assert_eq!(ids(&inactive), vec![t[0]]);
    assert_eq!(ids(&candidates(&b, &["default"], None)), vec![t[1], t[2]]);
}

#[test]
fn reattribute_session_facts_sets_other_and_appends_the_note_once_and_the_reads_follow() {
    let b = brain("session-takes-reattribute");
    source(&b, "other");
    let plain = fact(
        &b,
        "default",
        "plain",
        json!({ "attributed_to": "user", "context": "ctx" }),
    );
    let bare = fact(&b, "default", "bare", json!({ "attributed_to": "user" }));
    let unset = fact(&b, "default", "unset", json!({ "context": "kept" }));
    let already = fact(
        &b,
        "default",
        "already",
        json!({ "attributed_to": "user", "context": format!("said {NOTE}") }),
    );
    let settled = fact(
        &b,
        "default",
        "settled",
        json!({ "attributed_to": "other", "context": "earlier" }),
    );
    let gone = fact(&b, "default", "gone", json!({ "attributed_to": "user" }));
    assert!(
        b.expire_fact(&de::<ExpireFactArgs>(json!({ "id": gone })))
            .unwrap()
    );
    let away = fact(&b, "other", "away", json!({ "attributed_to": "user" }));
    let empty_note = fact(
        &b,
        "default",
        "empty note",
        json!({ "attributed_to": "user" }),
    );
    let all = [plain, bare, unset, already, settled, gone, away];
    let mut notes: Vec<Value> = all
        .iter()
        .map(|id| json!({ "id": id, "note": NOTE }))
        .collect();
    notes.push(json!({ "id": empty_note, "note": "" }));
    notes.push(json!({ "id": plain, "note": "second note" }));
    let changed = b
        .reattribute_session_facts(&de::<ReattributeArgs>(
            json!({ "sourceId": "default", "facts": notes, "separator": SEP }),
        ))
        .unwrap();
    let mut expected = vec![plain, bare, unset, already, empty_note];
    expected.sort_unstable();
    assert_eq!(ids(&changed), expected);
    let mut read_ids = all.to_vec();
    read_ids.push(empty_note);
    let settled_rows = b
        .list_settled_session_facts(&named("default", &read_ids))
        .unwrap();
    let mut want = vec![
        json!({ "id": plain, "context": format!("ctx{SEP}{NOTE}") }),
        json!({ "id": bare, "context": NOTE }),
        json!({ "id": unset, "context": format!("kept{SEP}{NOTE}") }),
        json!({ "id": already, "context": format!("said {NOTE}") }),
        json!({ "id": settled, "context": "earlier" }),
        json!({ "id": empty_note, "context": null }),
    ];
    want.sort_by_key(|r| r["id"].as_u64());
    assert_eq!(settled_rows, want);
    let other = b
        .list_other_attributed_fact_ids(&named("default", &read_ids))
        .unwrap();
    assert_eq!(ids(&other), ids(&want));
    assert!(
        b.list_other_attributed_fact_ids(&named("other", &[away]))
            .unwrap()
            .is_empty()
    );
}
