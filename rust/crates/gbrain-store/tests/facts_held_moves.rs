//! The held-fact move and facts home reads (facts/held_moves.rs): the rows a holding page keeps for an entity with no
//! page, the page reads the move decides by, the age of a held row, and the reads that take the empty-rule values.

mod memory_env;

use gbrain_store::facts::held_moves::{HeldAgeArgs, HeldPageArgs, HeldVisibilityArgs};
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::journal::{FinishWrite, WriteAdmission};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const HOLDING: &str = "memory/unattributed";
const NESTED: &str = "members/ann/memory/unattributed";
const DAY: i64 = 86_400_000_000;

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, frontmatter: Value) {
    let input: gbrain_store::pages::PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }),
    );
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

/// One fact: its page `slug`, row number and entity; returns the id.
fn fact(
    b: &Brain,
    text: &str,
    entity: Option<&str>,
    slug: &str,
    row_num: i64,
    extra: Value,
) -> u64 {
    let mut row = json!({ "fact": text, "entity_slug": entity, "source_markdown_slug": slug,
        "row_num": row_num, "kind": "fact", "visibility": "private", "source": "fence" });
    row.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [row], "sourceId": "default" }),
        ))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn expire(b: &Brain, id: u64) {
    let a: ExpireFactArgs = args(json!({ "id": id as f64 }));
    assert!(b.expire_fact(&a).unwrap());
}

fn texts(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_owned())
        .collect()
}

fn at(slug: &str) -> HeldPageArgs {
    args(json!({ "sourceId": "default", "slug": slug }))
}

#[test]
fn held_rows_are_the_live_fenced_rows_about_other_entities_on_a_holding_page() {
    let b = brain("held-live");
    for slug in [HOLDING, NESTED, "people/a"] {
        page(&b, slug, json!({}));
    }
    fact(&b, "top for z", Some("people/z"), HOLDING, 1, json!({}));
    fact(&b, "nested for a", Some("people/a"), NESTED, 1, json!({}));
    fact(&b, "top for a", Some("people/a"), HOLDING, 2, json!({}));
    // Not held rows: an ordinary page, an entity that is a holding page, an ontology slot, no entity, an unlisted page.
    fact(&b, "ordinary", Some("people/a"), "people/a", 1, json!({}));
    fact(
        &b,
        "about a holding page",
        Some(NESTED),
        HOLDING,
        3,
        json!({}),
    );
    fact(
        &b,
        "a slot",
        Some("people/a"),
        HOLDING,
        4,
        json!({ "dimension": "city", "value": "Paris", "source": "conversation:x" }),
    );
    fact(&b, "no entity", None, HOLDING, 5, json!({}));
    fact(
        &b,
        "no page",
        Some("people/a"),
        "gone/memory/unattributed",
        1,
        json!({}),
    );
    let rows = b.list_held_move_rows("default").unwrap();
    assert_eq!(
        texts(&rows, "fact"),
        ["nested for a", "top for a", "top for z"]
    );
    assert_eq!(texts(&rows, "from_slug"), [NESTED, HOLDING, HOLDING]);
    assert!(rows.iter().all(|r| r["page_exists"] == json!(true)));
    assert!(rows[0]["confidence"].is_number());
    assert!(b.list_held_move_rows("elsewhere").unwrap().is_empty());
}

#[test]
fn a_struck_row_is_an_expired_held_row_no_active_fact_reuses() {
    let b = brain("held-struck");
    page(&b, HOLDING, json!({}));
    let once = fact(&b, "struck once", Some("people/a"), HOLDING, 1, json!({}));
    let reused = fact(
        &b,
        "struck, then reused",
        Some("people/b"),
        HOLDING,
        2,
        json!({}),
    );
    fact(&b, "live", Some("people/c"), HOLDING, 3, json!({}));
    expire(&b, once);
    expire(&b, reused);
    let struck = b.list_struck_held_rows("default").unwrap();
    assert_eq!(
        texts(&struck, "fact"),
        ["struck once", "struck, then reused"]
    );
    assert_eq!(struck[0]["row_num"], json!(1));
    assert_eq!(struck[1]["entity_slug"], json!("people/b"));
    // A fence row number stays taken once its row is struck: a new fact at the same row is not inserted.
    let again = b
        .insert_facts(&args::<InsertFactsArgs>(json!({ "sourceId": "default", "rows": [{
            "fact": "takes row 2", "entity_slug": "people/b", "source_markdown_slug": HOLDING, "row_num": 2,
            "kind": "fact", "visibility": "private", "source": "fence" }] })))
        .unwrap();
    assert_eq!(again["inserted"], json!(0));
    assert_eq!(b.list_struck_held_rows("default").unwrap().len(), 2);
}

#[test]
fn page_reads_tell_a_live_page_from_a_deleted_one_and_from_none() {
    let b = brain("held-pages");
    page(&b, "people/live", json!({}));
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": "note", "title": "f", "compiled_truth": "x", "source_path": "people/file.md",
        "source_uri": "file:///people/file.md" }));
    b.put_page("people/file", &input, &args(json!({}))).unwrap();
    page(&b, "people/gone", json!({}));
    b.soft_delete_page("people/gone", None).unwrap();
    let ask = |slug: &str| {
        (
            b.held_entity_page_deleted(&at(slug)).unwrap(),
            b.held_target_page_live(&at(slug)).unwrap(),
        )
    };
    assert_eq!(ask("people/live"), (false, true));
    assert_eq!(ask("people/gone"), (true, false));
    assert_eq!(ask("people/none"), (false, false));
    let elsewhere: HeldPageArgs = args(json!({ "sourceId": "other", "slug": "people/live" }));
    assert!(!b.held_target_page_live(&elsewhere).unwrap());
    let place = |slug: &str| b.read_held_page_location(&at(slug)).unwrap();
    assert_eq!(
        place("people/file"),
        Some(json!({ "source_path": "people/file.md", "source_uri": "file:///people/file.md" }))
    );
    assert_eq!(
        place("people/live"),
        Some(json!({ "source_path": null, "source_uri": null }))
    );
    assert_eq!(place("people/gone"), None);
    assert_eq!(place("people/none"), None);
    let nul = b.held_target_page_live(&at("people/\0x")).unwrap_err();
    assert_eq!(nul.code, "invalid_argument");
}

#[test]
fn row_visibility_follows_the_world_page_policy_and_a_deleted_page_has_none() {
    let b = brain("held-visibility");
    page(&b, "people/open", json!({}));
    page(&b, "people/private", json!({ "visibility": "private" }));
    page(
        &b,
        "people/readers",
        json!({ "readable_by": ["member:ann"] }),
    );
    page(&b, "people/gone", json!({}));
    b.soft_delete_page("people/gone", None).unwrap();
    let policy = json!({ "honorAliases": false, "entityPrivacy": true });
    let ask = |slug: &str| {
        let q: HeldVisibilityArgs =
            args(json!({ "sourceId": "default", "slug": slug, "policy": policy }));
        b.read_held_row_visibility(&q).unwrap()
    };
    assert_eq!(ask("people/open"), Some(json!({ "visible": true })));
    assert_eq!(ask("people/private"), Some(json!({ "visible": false })));
    assert_eq!(ask("people/readers"), Some(json!({ "visible": false })));
    assert_eq!(ask("people/gone"), None);
    assert_eq!(ask("people/none"), None);
}

#[test]
fn the_rule_reads_take_the_empty_rule_values_and_the_config_read_is_get_config() {
    let b = brain("held-rules");
    page(&b, HOLDING, json!({}));
    fact(&b, "held", Some("people/a"), HOLDING, 1, json!({}));
    assert_eq!(
        b.read_held_access_state(&at("people/a")).unwrap(),
        [json!({ "unreadable": false, "page_rule": false, "restricted": false })]
    );
    assert!(!b.held_move_due("default").unwrap());
    assert!(!b.held_move_due("elsewhere").unwrap());
    assert!(b.held_move_due("a\0b").is_err());
    b.set_config("sync.write_through", "false").unwrap();
    assert_eq!(
        b.read_held_config_value("sync.write_through")
            .unwrap()
            .as_deref(),
        Some("false")
    );
    assert_eq!(b.read_held_config_value("sync.never_set").unwrap(), None);
}

#[test]
fn versions_edited_reads_the_recorded_count_by_request_id() {
    let b = brain("held-edited");
    let request = |id: &str| -> WriteAdmission {
        args(
            json!({ "principal": { "kind": "local_cli", "id": "w" }, "operation": "put_page",
            "requestId": id, "slug": "notes/a", "callerIntent": {} }),
        )
    };
    let with = "b0000000-0000-4000-8000-0000000000b1";
    let without = "b0000000-0000-4000-8000-0000000000b2";
    b.admit_write(&request(with), None).unwrap();
    b.admit_write(&request(without), None).unwrap();
    let finish: FinishWrite = args(json!({ "state": "committed",
        "outcome": { "held_versions_edited": { "segmented_versions_not_edited": 3 } } }));
    b.finish_write(
        &args(json!({ "kind": "local_cli", "id": "w" })),
        with,
        &finish,
    )
    .unwrap();
    assert_eq!(b.read_held_versions_edited(with).unwrap(), 3);
    assert_eq!(
        b.read_held_versions_edited(&with.to_uppercase()).unwrap(),
        3
    );
    assert_eq!(b.read_held_versions_edited(without).unwrap(), 0);
    assert_eq!(
        b.read_held_versions_edited("b0000000-0000-4000-8000-0000000000ff")
            .unwrap(),
        0
    );
    assert_eq!(
        b.read_held_versions_edited("not-a-uuid").unwrap_err().code,
        "invalid_argument"
    );
}

#[test]
fn the_facts_home_scans_report_page_flags_age_and_missing_pages() {
    let b = brain("held-home");
    for slug in [HOLDING, "people/live", "people/closed"] {
        page(&b, slug, json!({}));
    }
    let held = fact(&b, "about live", Some("people/live"), HOLDING, 1, json!({}));
    fact(
        &b,
        "about absent",
        Some("people/absent"),
        HOLDING,
        2,
        json!({}),
    );
    fact(
        &b,
        "on closed",
        Some("people/closed"),
        "people/closed",
        1,
        json!({}),
    );
    fact(
        &b,
        "on none",
        Some("people/never"),
        "people/never",
        1,
        json!({}),
    );
    let unfenced = |text: &str, entity: Option<&str>, extra: Value| {
        let mut row = json!({ "fact": text, "entity_slug": entity, "kind": "fact", "visibility": "world", "source": "t" });
        row.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        b.insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [row], "sourceId": "default" }),
        ))
        .unwrap();
    };
    unfenced("no entity", None, json!({}));
    unfenced("on live", Some("people/live"), json!({}));
    unfenced(
        "slot",
        Some("people/live"),
        json!({ "dimension": "city", "value": "Paris" }),
    );
    unfenced("on closed", Some("people/closed"), json!({}));
    b.soft_delete_page("people/closed", None).unwrap();
    let _ = held;
    let scan = b.scan_unfenced_fact_rows("default").unwrap();
    let line = |r: &Value| {
        format!(
            "{}|{}|{}|{}|{}",
            r["entity_slug"], r["fact"], r["dimension"], r["page_exists"], r["page_deleted"]
        )
    };
    assert_eq!(
        scan.iter().map(line).collect::<Vec<_>>(),
        [
            "null|\"no entity\"|null|false|false",
            "\"people/closed\"|\"on closed\"|null|false|true",
            "\"people/live\"|\"on live\"|null|true|false",
            "\"people/live\"|\"slot\"|\"city\"|true|false",
        ]
    );
    assert_eq!(scan[0]["valid_from"].as_str().unwrap().len(), 27);
    let age = |days: &str| -> Vec<Value> {
        b.list_held_fact_rows(&args::<HeldAgeArgs>(
            json!({ "sourceId": "default", "days": days }),
        ))
        .unwrap()
    };
    let young = age("30");
    assert_eq!(
        texts(&young, "entity_slug"),
        ["people/absent", "people/live"]
    );
    assert_eq!(
        young
            .iter()
            .map(|r| r["page_exists"].clone())
            .collect::<Vec<_>>(),
        [json!(false), json!(true)]
    );
    assert!(young.iter().all(|r| r["old"] == json!(false)));
    assert_eq!(young[0]["held_since"], json!("2027-01-15T08:00:00Z"));
    assert!(age("-1").iter().all(|r| r["old"] == json!(true)));
    // The clock moves a month on: a row waits past the cutoff of 30 days, and the cutoff of 40 days keeps it young.
    b.clock.advance(31 * DAY + 1_500_000);
    assert!(age("30").iter().all(|r| r["old"] == json!(true)));
    assert!(age("40").iter().all(|r| r["old"] == json!(false)));
    assert!(age("1.5").iter().all(|r| r["old"] == json!(true)));
    assert_eq!(young[0]["held_since"], age("30")[0]["held_since"]);
    for bad in ["", "1 hour", "1e2", "30 days"] {
        assert_eq!(
            b.list_held_fact_rows(&args::<HeldAgeArgs>(
                json!({ "sourceId": "default", "days": bad })
            ))
            .unwrap_err()
            .code,
            "invalid_argument",
            "{bad}"
        );
    }
    let missing = b.list_fenced_facts_of_missing_pages("default").unwrap();
    assert_eq!(texts(&missing, "slug"), ["people/closed", "people/never"]);
    assert!(missing[0]["id"].as_u64().unwrap() < missing[1]["id"].as_u64().unwrap());
}
