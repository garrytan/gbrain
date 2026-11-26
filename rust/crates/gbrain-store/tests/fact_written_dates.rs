//! memory_recall's date column (`read_fact_written_dates`, facts/recall.rs): the UTC day each named fact is valid from,
//! one row per distinct fact that exists, in id order, whatever the source or state of the fact.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn fact(b: &Brain, valid_from: &str, row: u32) -> u64 {
    let args: InsertFactsArgs = serde_json::from_value(json!({
        "rows": [{ "fact": format!("dated fact {row}"), "entity_slug": null, "source_markdown_slug": "notes/open",
            "row_num": row, "kind": "fact", "visibility": "world", "source": "fence", "valid_from": valid_from }],
        "sourceId": "default",
    }))
    .unwrap();
    b.insert_facts(&args).unwrap()["ids"][0].as_u64().unwrap()
}

fn row(id: u64, d: &str) -> Value {
    json!({ "id": id, "d": d })
}

#[test]
fn each_named_fact_gets_its_utc_day_and_a_missing_id_gets_none() {
    let b = brain("fact-written-dates");
    let plain = fact(&b, "2026-05-06T12:00:00.000Z", 1);
    let late = fact(&b, "2026-12-31T23:30:00.000Z", 2);
    let early = fact(&b, "2026-01-01T00:30:00.000Z", 3);
    let fifty = fact(&b, "0050-03-04T00:00:00.000Z", 4);
    // Out of order, repeated, missing and negative ids: one row per fact that exists, by id.
    let ids = [
        fifty as f64,
        late as f64,
        plain as f64,
        plain as f64,
        999_999.0,
        -1.0,
        early as f64,
    ];
    assert_eq!(
        b.read_fact_written_dates(&ids).unwrap(),
        vec![
            row(plain, "2026-05-06"),
            row(late, "2026-12-31"),
            row(early, "2026-01-01"),
            row(fifty, "0050-03-04"),
        ]
    );
    assert_eq!(b.read_fact_written_dates(&[]).unwrap(), Vec::<Value>::new());
}

#[test]
fn an_id_that_is_not_a_whole_number_is_refused() {
    let b = brain("fact-written-dates-input");
    assert!(b.read_fact_written_dates(&[1.5]).is_err());
    assert!(b.read_fact_written_dates(&[f64::NAN]).is_err());
}
