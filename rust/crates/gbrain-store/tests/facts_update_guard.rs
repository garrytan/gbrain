//! The withdrawal guard on the fact updates that set a column it watches and can leave a row active
//! (`placeRelinkedFact`, `linkConversationFact`, `restoreSupersededFact`, `restoreFactPreimage`,
//! `migrateFactsToCanonical`): a row the update leaves active that a withdrawal of its claim reaches is
//! saved expired at that withdrawal, its `valid_until` clamped to it, as the Postgres trigger
//! `facts_preserve_withdrawal` does. A row no withdrawal reaches stays active.

mod memory_env;

use gbrain_store::facts::FactRestore;
use gbrain_store::facts::relink_writes::{ConversationFactLink, RelinkPlacement};
use gbrain_store::facts::remember_reads::{
    ExpireSupersededFactArgs, PairFactArgs, RestoreSupersededFactArgs,
};
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const WITHDRAWN: &str = "2026-03-01T10:00:00.000Z";
const CONVERSATION: &str = "cli:extract-conversation-facts";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str) {
    let input: PageInput =
        args(json!({ "type": "person", "title": slug, "compiled_truth": "body" }));
    let options: PutPageOptions = args(json!({ "sourceId": "default" }));
    b.put_page(slug, &input, &options).unwrap();
}

fn one(b: &Brain, input: Value) -> u64 {
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": "default" }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn rows(b: &Brain, rows: Value) -> Vec<u64> {
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": rows, "sourceId": "default" }),
    ))
    .unwrap()["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect()
}

fn withdraw(b: &Brain, claim: &str, subject: &str) {
    assert!(
        b.insert_fact_withdrawal("default", "world", claim, subject, Some(WITHDRAWN))
            .unwrap()
    );
}

/// (expired_at, valid_until) of fact `id`.
fn stamp(b: &Brain, id: u64) -> (Value, Value) {
    let row = b
        .read_pair_fact_row(&args::<PairFactArgs>(json!({ "id": id })))
        .unwrap()
        .unwrap();
    (row["expired_at"].clone(), row["valid_until"].clone())
}

/// The withdrawal time as `readPairFactRow` gives it.
fn withdrawn() -> (Value, Value) {
    let at = json!("2026-03-01T10:00:00.000000Z");
    (at.clone(), at)
}

#[test]
fn a_relink_placement_expires_a_row_a_withdrawal_reaches_on_its_new_entity() {
    let b = brain("update-guard-place");
    page(&b, "people/alice-example");
    let reached = one(
        &b,
        json!({ "fact": "a likes tea", "visibility": "world", "source": "chat" }),
    );
    let other = one(
        &b,
        json!({ "fact": "a likes jam", "visibility": "world", "source": "chat" }),
    );
    withdraw(&b, "a likes tea", "people/alice-example");
    for (id, row_num) in [(reached, 1), (other, 2)] {
        assert!(
            b.place_relinked_fact(
                "default",
                &args::<RelinkPlacement>(json!({ "factId": id, "action": "link",
                    "slug": "people/alice-example", "rowNum": row_num, "context": "relinked" })),
            )
            .unwrap()
        );
    }
    assert_eq!(stamp(&b, reached), withdrawn());
    assert_eq!(stamp(&b, other), (Value::Null, Value::Null));
}

#[test]
fn a_conversation_link_expires_a_row_a_withdrawal_reaches_on_its_new_entity() {
    let b = brain("update-guard-conversation");
    page(&b, "people/alice-example");
    let slug = "conversations/2026-01-01";
    let ids = rows(
        &b,
        json!([
            { "fact": "a met at the cafe", "visibility": "world", "source": CONVERSATION, "row_num": null, "source_markdown_slug": slug },
            { "fact": "a met at the park", "visibility": "world", "source": CONVERSATION, "row_num": null, "source_markdown_slug": slug },
        ]),
    );
    withdraw(&b, "a met at the cafe", "people/alice-example");
    for (id, claim) in [(ids[0], "a met at the cafe"), (ids[1], "a met at the park")] {
        assert!(
            b.link_conversation_fact(
                "default",
                &args::<ConversationFactLink>(
                    json!({ "factId": id, "pageSlug": slug, "fact": claim,
                    "entitySlug": "people/alice-example", "context": "relinked", "from": null })
                ),
            )
            .unwrap()
        );
    }
    assert_eq!(stamp(&b, ids[0]), withdrawn());
    assert_eq!(stamp(&b, ids[1]), (Value::Null, Value::Null));
}

#[test]
fn a_supersession_restore_keeps_a_withdrawn_claim_expired() {
    let b = brain("update-guard-superseded");
    let claim = |fact: &str| {
        one(
            &b,
            json!({ "fact": fact, "entity_slug": "people/a", "visibility": "world", "source": "chat" }),
        )
    };
    let (withdrawn_old, kept_old, new) =
        (claim("old claim"), claim("kept claim"), claim("new claim"));
    for old in [withdrawn_old, kept_old] {
        let a: ExpireSupersededFactArgs =
            args(json!({ "oldId": old, "sourceId": "default", "newId": new }));
        assert_eq!(b.expire_superseded_fact(&a).unwrap(), 1);
    }
    withdraw(&b, "old claim", "*");
    for old in [withdrawn_old, kept_old] {
        let a: RestoreSupersededFactArgs = args(json!({ "oldId": old, "sourceId": "default",
            "expiredAt": null, "validUntil": null, "supersededBy": null, "expectedSupersededBy": new }));
        assert_eq!(b.restore_superseded_fact(&a).unwrap(), 1);
    }
    assert_eq!(stamp(&b, withdrawn_old), withdrawn());
    assert_eq!(stamp(&b, kept_old), (Value::Null, Value::Null));
}

#[test]
fn a_preimage_restore_keeps_a_withdrawn_claim_expired() {
    let b = brain("update-guard-preimage");
    let ids = rows(
        &b,
        json!([
            { "fact": "Alpha", "entity_slug": "people/restore-example", "source": "fence", "source_markdown_slug": "people/restore-example", "kind": "fact", "visibility": "world", "row_num": 1 },
            { "fact": "Beta", "entity_slug": "people/restore-example", "source": "fence", "source_markdown_slug": "people/restore-example", "kind": "fact", "visibility": "world", "row_num": 2 },
        ]),
    );
    let asked: Vec<i64> = ids.iter().map(|id| i64::try_from(*id).unwrap()).collect();
    let pre = b.read_fact_preimages("default", &asked).unwrap();
    for id in &ids {
        assert!(
            b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": id })))
                .unwrap()
        );
    }
    withdraw(&b, "Alpha", "*");
    for p in pre {
        assert!(
            b.restore_fact_preimage("default", &args::<FactRestore>(p))
                .unwrap()
        );
    }
    assert_eq!(stamp(&b, ids[0]), withdrawn());
    assert_eq!(stamp(&b, ids[1]), (Value::Null, Value::Null));
}

#[test]
fn a_canonical_move_expires_a_row_a_withdrawal_reaches_on_the_canonical_entity() {
    let b = brain("update-guard-canonical");
    page(&b, "people/bob-example");
    let fenced = |fact: &str, row_num: u32| {
        json!({ "fact": fact, "entity_slug": "people/bob", "source": "fence",
        "source_markdown_slug": "people/bob", "kind": "fact", "visibility": "world", "row_num": row_num })
    };
    let ids = rows(
        &b,
        json!([fenced("b likes chess", 1), fenced("b likes go", 2)]),
    );
    withdraw(&b, "b likes chess", "people/bob-example");
    assert_eq!(
        b.migrate_facts_to_canonical("people/bob", "people/bob-example", "default")
            .unwrap(),
        2
    );
    assert_eq!(stamp(&b, ids[0]), withdrawn());
    assert_eq!(stamp(&b, ids[1]), (Value::Null, Value::Null));
}
