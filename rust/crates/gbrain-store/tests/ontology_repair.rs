//! The ontology re-key and repair statements (`facts/ontology_repair.rs`): the PGLite semantics of `listRekeyLosers`,
//! `repointSupersededToKept`, `clearOntologySlots`, `deleteRekeyLosers`, `listOntologyFactCandidates` and
//! `restoreOntologyFact`.

mod memory_env;

use gbrain_store::facts::ontology_repair::{IdsArgs, RekeyArgs, RepointArgs, RestoreArgs};
use gbrain_store::facts::remember_reads::LinkArgs;
use gbrain_store::facts::{FactQuery, InsertFactsArgs};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

const FROM: &str = "2026-01-01T00:00:00.000Z";

/// One fact with an ontology slot; `over` replaces any column.
fn insert(b: &Brain, over: Value) -> u64 {
    let mut row = json!({
        "fact": "Lisbon", "kind": "fact", "visibility": "world", "source": "meetings/chat",
        "entity_slug": "people/dan-old", "source_markdown_slug": "meetings/chat",
        "valid_from": FROM, "dimension": "location", "value": "Lisbon", "value_hash": "h-lisbon",
    });
    for (k, v) in over.as_object().unwrap() {
        row[k] = v.clone();
    }
    b.insert_facts(&args::<InsertFactsArgs>(
        json!({ "rows": [row], "sourceId": "default" }),
    ))
    .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

/// A conversation slot (`cli:extract-conversation-facts`) holding the same key.
fn conversation(b: &Brain, over: Value) -> u64 {
    let mut row = json!({
        "source": "cli:extract-conversation-facts", "visibility": "private", "row_num": 1,
        "entity_slug": "people/dan",
    });
    for (k, v) in over.as_object().unwrap() {
        row[k] = v.clone();
    }
    insert(b, row)
}

fn row(b: &Brain, entity: &str, id: u64) -> Option<Value> {
    b.list_facts_by_entity(&args::<FactQuery>(json!({
        "sourceId": "default", "entitySlug": entity, "limit": 100, "activeOnly": false,
    })))
    .unwrap()
    .into_iter()
    .find(|r| r["id"].as_u64() == Some(id))
}

fn mv(where_shape: &str, entity: &str, sms: &str, p2: Option<&str>, p3: Option<&str>) -> RekeyArgs {
    args(json!({
        "sourceId": "default", "where": where_shape, "entity": entity, "sms": sms, "params": [p2, p3],
    }))
}

fn losers(b: &Brain, m: &RekeyArgs) -> Vec<(u64, u64)> {
    b.list_rekey_losers(m)
        .unwrap()
        .iter()
        .map(|l| (l["id"].as_u64().unwrap(), l["keep"].as_u64().unwrap()))
        .collect()
}

fn ids(v: &[u64]) -> IdsArgs {
    args(json!({ "ids": v }))
}

#[test]
fn a_conversation_slot_loses_to_the_ontology_row_it_collides_with() {
    let b = brain("ontology-repair-1");
    let ontology = insert(&b, json!({}));
    let slot = conversation(&b, json!({}));
    let m = mv(
        "entity_unfenced",
        "param3",
        "own",
        Some("people/dan-old"),
        Some("people/dan"),
    );
    assert_eq!(losers(&b, &m), vec![(slot, ontology)]);
    // The same set holds whichever row is older: the conversation slot still loses.
    let b = brain("ontology-repair-2");
    let slot = conversation(&b, json!({}));
    let ontology = insert(&b, json!({}));
    assert!(slot < ontology);
    assert_eq!(losers(&b, &m), vec![(slot, ontology)]);
    // A clear names only conversation slots: the ontology row keeps its slot, and the conversation row gives its up.
    b.clear_ontology_slots(&ids(&[ontology])).unwrap();
    assert_eq!(losers(&b, &m), vec![(slot, ontology)]);
    b.clear_ontology_slots(&ids(&[slot])).unwrap();
    assert!(losers(&b, &m).is_empty());
    assert!(
        row(&b, "people/dan", slot).is_some(),
        "the conversation fact keeps its row"
    );
}

#[test]
fn the_active_row_survives_then_the_one_already_at_the_target() {
    let b = brain("ontology-repair-active");
    let page = json!({ "source_markdown_slug": "meetings/a", "source": "meetings/a" });
    let with = |extra: Value| {
        let mut o = page.clone();
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o
    };
    let retired_at = json!({ "expired_at": "2026-02-01T00:00:00.000Z" });
    // A retired moving row loses to the active row at the target.
    let moving = insert(&b, with(retired_at.clone()));
    let at_target = insert(&b, with(json!({ "entity_slug": "people/dan" })));
    // An active moving row beats the retired row already at the target.
    let moving_live = insert(
        &b,
        with(json!({ "value_hash": "h-porto", "value": "Porto" })),
    );
    let retired_target = insert(
        &b,
        with(
            json!({ "entity_slug": "people/dan", "value_hash": "h-porto", "value": "Porto",
                    "expired_at": "2026-02-01T00:00:00.000Z" }),
        ),
    );
    // A row at another key is never named.
    insert(
        &b,
        with(json!({ "entity_slug": "people/dan", "value_hash": "h-faro", "value": "Faro" })),
    );
    let m = mv(
        "entity",
        "param3",
        "own",
        Some("people/dan-old"),
        Some("people/dan"),
    );
    assert_eq!(
        losers(&b, &m),
        vec![(moving, at_target), (retired_target, moving_live)]
    );
}

#[test]
fn every_where_shape_selects_its_rows() {
    let b = brain("ontology-repair-4");
    let moving = insert(&b, json!({ "row_num": null }));
    let target = insert(&b, json!({ "entity_slug": "people/dan" }));
    let fenced = insert(
        &b,
        json!({ "row_num": 3, "value_hash": "h-porto", "value": "Porto" }),
    );
    let at_target_of_fenced = insert(
        &b,
        json!({ "entity_slug": "people/dan", "value_hash": "h-porto", "value": "Porto" }),
    );
    let (old, new) = (Some("people/dan-old"), Some("people/dan"));
    // Unfenced rows of the entity only.
    assert_eq!(
        losers(&b, &mv("entity_unfenced", "param3", "own", old, new)),
        vec![(moving, target)]
    );
    // Every row of the entity, fenced or not.
    assert_eq!(
        losers(&b, &mv("entity", "param3", "own", old, new)),
        vec![(moving, target), (fenced, at_target_of_fenced)]
    );
    // Rows of the entity that sit off the page named in $2 (here: every row of the entity, `$2` being the entity).
    assert_eq!(
        losers(&b, &mv("entity_off_page", "param3", "own", old, new)),
        vec![(moving, target), (fenced, at_target_of_fenced)]
    );
    // Rows on the page named in $2, all taking the new entity and that page.
    assert_eq!(
        losers(
            &b,
            &mv("page", "param3", "param2", Some("meetings/chat"), new)
        ),
        vec![(target, moving), (at_target_of_fenced, fenced)]
    );
    // The live rows of the page named in $3: kept on their own entity they collide with nothing; moved they collide in pairs.
    assert!(
        losers(
            &b,
            &mv("page_live", "own", "own", old, Some("meetings/chat"))
        )
        .is_empty()
    );
    assert_eq!(
        losers(
            &b,
            &mv("page_live", "param3", "own", old, Some("meetings/chat"))
        ),
        vec![(target, moving), (at_target_of_fenced, fenced)]
    );
    // A text that is not a bigint refuses; a name no shape has refuses.
    let err = b
        .list_rekey_losers(&mv("unbacked_id", "own", "own", Some("abc"), None))
        .unwrap_err();
    assert_eq!(err.code, "invalid_argument");
    let err = b
        .list_rekey_losers(&mv("everything", "own", "own", None, None))
        .unwrap_err();
    assert_eq!(err.code, "invalid_argument");
    // No id matches no row.
    assert!(losers(&b, &mv("unbacked_id", "own", "own", Some("999999"), None)).is_empty());
}

#[test]
fn repointing_follows_the_survivor_and_clears_its_own_link() {
    let b = brain("ontology-repair-5");
    let first = insert(&b, json!({ "value_hash": "h-a", "value": "A" }));
    let second = insert(&b, json!({ "value_hash": "h-b", "value": "B" }));
    let dropped = insert(&b, json!({ "value_hash": "h-c", "value": "C" }));
    let kept = insert(&b, json!({ "value_hash": "h-d", "value": "D" }));
    // Fact rows point at their successors through `superseded_by_row` only at insert time on SQL; set them with the
    // store's writer.
    let link = |id: u64, to: u64| {
        b.link_superseded_fact(&args::<LinkArgs>(json!({ "oldId": id, "newId": to })))
            .unwrap();
    };
    link(first, dropped);
    link(kept, dropped);
    let by = |id: u64| row(&b, "people/dan-old", id).unwrap()["superseded_by"].clone();
    assert_eq!(by(first), json!(dropped));
    b.repoint_superseded_to_kept(&args::<RepointArgs>(
        json!({ "ids": [dropped, dropped], "keeps": [kept, first] }),
    ))
    .unwrap();
    assert_eq!(
        by(first),
        json!(kept),
        "the first survivor of a repeated id wins"
    );
    assert!(by(kept).is_null(), "the survivor's own link is cleared");
    assert!(by(second).is_null());
    // Lists of different lengths pad with nulls, as `unnest` does: a missing survivor clears the link.
    link(first, dropped);
    b.repoint_superseded_to_kept(&args::<RepointArgs>(
        json!({ "ids": [dropped], "keeps": [] }),
    ))
    .unwrap();
    assert!(by(first).is_null());
}

#[test]
fn a_delete_names_only_rows_that_hold_a_slot() {
    let b = brain("ontology-repair-6");
    let slot = insert(&b, json!({}));
    let plain = insert(
        &b,
        json!({ "dimension": null, "value": null, "value_hash": null, "fact": "plain" }),
    );
    b.delete_rekey_losers(&ids(&[slot, plain, 999_999, 0]))
        .unwrap();
    assert!(row(&b, "people/dan-old", slot).is_none());
    assert!(row(&b, "people/dan-old", plain).is_some());
}

fn source_ids(ids: &[&str]) -> gbrain_store::facts::repair_previews::SourcesArgs {
    gbrain_store::facts::repair_previews::SourcesArgs {
        source_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

fn candidates(b: &Brain) -> Vec<Value> {
    b.list_ontology_fact_candidates(&source_ids(&["default"]))
        .unwrap()
}

fn restore(b: &Brain, c: &Value, over: Value) -> Vec<Value> {
    let mut a = json!({
        "id": c["id"], "sourceId": c["source_id"], "rowNum": c["row_num"], "page": c["page"],
        "expiredAt": c["expired_at"],
    });
    for (k, v) in over.as_object().unwrap() {
        a[k] = v.clone();
    }
    b.restore_ontology_fact(&args::<RestoreArgs>(a)).unwrap()
}

#[test]
fn candidates_list_fenced_and_retired_rows_and_a_restore_applies_only_as_previewed() {
    let b = brain("ontology-repair-7");
    let own = json!({ "entity_slug": "people/fay", "source_markdown_slug": "people/fay", "source": "manual", "visibility": "world" });
    let mix = |extra: Value| {
        let mut o = own.clone();
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o
    };
    insert(
        &b,
        mix(json!({ "row_num": 1, "value": "Lisbon", "value_hash": "h-1", "fact": "Lisbon" })),
    );
    insert(
        &b,
        mix(
            json!({ "row_num": 2, "value": "Porto", "value_hash": "h-2", "fact": "Porto",
                           "expired_at": "2026-03-01T12:34:56.789Z" }),
        ),
    );
    insert(
        &b,
        mix(json!({ "row_num": 3, "value": "Faro", "value_hash": "h-3", "fact": "Faro" })),
    );
    insert(
        &b,
        mix(
            json!({ "source_markdown_slug": "manual", "value": "Faro", "value_hash": "h-3", "fact": "Faro" }),
        ),
    );
    insert(
        &b,
        mix(
            json!({ "source": "cli:extract-conversation-facts", "row_num": 4, "value": "Braga", "value_hash": "h-4" }),
        ),
    );
    insert(
        &b,
        mix(
            json!({ "dimension": null, "value": null, "value_hash": null, "row_num": 5, "fact": "plain" }),
        ),
    );
    let all = candidates(&b);
    let view: Vec<_> = all
        .iter()
        .map(|c| (c["row_num"].clone(), c["duplicate"].clone()))
        .collect();
    assert_eq!(
        view,
        vec![
            (json!(1), json!(false)),
            (json!(2), json!(false)),
            (json!(3), json!(true))
        ]
    );
    assert_eq!(all[1]["expired_at"], "2026-03-01T12:34:56.789000Z");
    assert!(all[0]["expired_at"].is_null());
    assert_eq!(all[0]["withdrawn"], json!(false));
    assert_eq!(all[0]["consolidated"], json!(false));
    assert!(
        b.list_ontology_fact_candidates(&source_ids(&["nowhere"]))
            .unwrap()
            .is_empty()
    );
    assert!(restore(&b, &all[0], json!({ "rowNum": 99 })).is_empty());
    assert!(restore(&b, &all[0], json!({ "page": "people/other" })).is_empty());
    assert!(
        restore(
            &b,
            &all[0],
            json!({ "expiredAt": "2026-03-01T00:00:00.000000Z" })
        )
        .is_empty()
    );
    assert!(
        restore(&b, &all[2], json!({})).is_empty(),
        "a duplicate stays"
    );
    assert_eq!(restore(&b, &all[0], json!({}))[0]["expired"], json!(false));
    assert_eq!(restore(&b, &all[1], json!({}))[0]["expired"], json!(false));
    assert!(
        restore(&b, &all[0], json!({})).is_empty(),
        "a restored row no longer matches"
    );
    let left: Vec<_> = candidates(&b)
        .iter()
        .map(|c| c["row_num"].clone())
        .collect();
    assert_eq!(left, vec![json!(3)]);
    let id = all[1]["id"].as_u64().unwrap();
    assert!(row(&b, "people/fay", id).unwrap()["expired_at"].is_null());
}

#[test]
fn a_withdrawal_after_the_preview_expires_the_restored_row_again() {
    let b = brain("ontology-repair-8");
    insert(
        &b,
        json!({ "entity_slug": "people/gus", "source": "manual", "row_num": 1, "source_markdown_slug": "people/gus",
                "fact": "Gus lives in Lisbon", "visibility": "private" }),
    );
    let all = candidates(&b);
    assert_eq!(all[0]["withdrawn"], json!(false));
    b.insert_fact_withdrawal(
        "default",
        "private",
        "Gus lives in Lisbon",
        "*",
        Some("2026-04-01T00:00:00.000000Z"),
    )
    .unwrap();
    assert_eq!(candidates(&b)[0]["withdrawn"], json!(true));
    let out = restore(&b, &all[0], json!({}));
    assert_eq!(out[0]["expired"], json!(true));
    let id = all[0]["id"].as_u64().unwrap();
    assert!(!row(&b, "people/gus", id).unwrap()["expired_at"].is_null());
}
