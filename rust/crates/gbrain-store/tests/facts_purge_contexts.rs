//! `listFactContextsForPurgeProbe` (`facts/purge_receipt.rs`) is a keyset read: the lowest 1000
//! unexpired facts of the source above the cursor whose context is not empty, in id order. The
//! purge receipt pages through a source with it, so a page that skips or repeats a row loses a
//! quoted claim.

mod memory_env;

use gbrain_store::facts::purge_receipt::FactContextsQuery;
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Facts `from..=to` of `source_id`, each a fence row with its own row number. Row 5 has a blank
/// context and row 7 none.
fn batch(b: &Brain, source_id: &str, from: i32, to: i32) -> Vec<u64> {
    let rows: Vec<Value> = (from..=to)
        .map(|n| {
            let context = match n {
                5 => json!(""),
                7 => Value::Null,
                _ => json!(format!("{source_id} {n:04}")),
            };
            json!({
                "fact": format!("fact {n} of {source_id}"), "kind": "fact", "visibility": "world",
                "source": "fence", "source_markdown_slug": "notes/contexts", "row_num": n,
                "entity_slug": null, "context": context,
            })
        })
        .collect();
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": source_id }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect()
}

fn probe(b: &Brain, source_id: &str, after: f64) -> Vec<(u64, String)> {
    b.list_fact_contexts_for_purge_probe(&args::<FactContextsQuery>(
        json!({ "sourceId": source_id, "after": after }),
    ))
    .unwrap()
    .into_iter()
    .map(|r| {
        (
            r["id"].as_u64().unwrap(),
            r["context"].as_str().unwrap().to_owned(),
        )
    })
    .collect()
}

fn labels(source_id: &str, from: i32, to: i32) -> Vec<String> {
    (from..=to)
        .filter(|n| ![5, 7, 10].contains(n))
        .map(|n| format!("{source_id} {n:04}"))
        .collect()
}

#[test]
fn the_probe_pages_the_lowest_thousand_live_contexts_above_the_cursor_in_id_order() {
    let b = brain("purge-contexts");
    b.upsert_source(&args::<SourceInput>(
        json!({ "id": "other", "name": "other" }),
    ))
    .unwrap();
    // The other source's ids sit inside this source's id range.
    let low = batch(&b, "default", 1, 500);
    let other = batch(&b, "other", 1, 3);
    batch(&b, "default", 501, 1010);
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": low[9] as f64 })))
            .unwrap()
    );

    let first = probe(&b, "default", 0.0);
    let ids: Vec<u64> = first.iter().map(|(id, _)| *id).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
    let texts: Vec<String> = first.iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(texts, labels("default", 1, 1003));

    let second = probe(&b, "default", *ids.last().unwrap() as f64);
    let texts: Vec<String> = second.iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(texts, labels("default", 1004, 1010));

    // A cursor at the last id reads nothing; another source's id starts after it.
    assert!(probe(&b, "default", second.last().unwrap().0 as f64).is_empty());
    let from_other = probe(&b, "default", other[0] as f64);
    assert_eq!(from_other.len(), 510);
    assert_eq!(from_other[0].1, "default 0501");

    // `id > after` holds for a negative or fractional cursor too.
    assert_eq!(probe(&b, "default", -1.0), first);
    let half = probe(&b, "default", low[0] as f64 + 0.5);
    assert_eq!(half[0].1, "default 0002");

    // The other source pages only its own rows.
    let mine: Vec<String> = probe(&b, "other", 0.0)
        .into_iter()
        .map(|(_, c)| c)
        .collect();
    assert_eq!(mine, vec!["other 0001", "other 0002", "other 0003"]);
}
