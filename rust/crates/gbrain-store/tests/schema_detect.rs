//! The `gbrain schema detect` page-shape reads of `schema_detect.rs`, each against the rows its SQL returns
//! (src/core/engine-sql/schema-detect.ts).

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::schema_detect::{PagePrefixSamplesArgs, PageTypeCountsArgs, PageTypeTotalsArgs};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str) {
    b.upsert_source(&de::<SourceInput>(json!({ "id": id, "name": id })))
        .unwrap();
}

fn page(b: &Brain, source: &str, slug: &str, page_type: &str) {
    let input: PageInput = de(json!({ "type": page_type, "title": slug, "compiled_truth": "x" }));
    let opts: PutPageOptions = de(json!({ "sourceId": source }));
    b.put_page(slug, &input, &opts).unwrap();
}

fn seeded() -> Brain {
    let b = brain("schema-detect");
    source(&b, "s1");
    source(&b, "s2");
    for (slug, t) in [
        ("notes/a", "ab"),
        ("notes/b", "a-z"),
        ("notes/c", "ab"),
        ("notes/d", ""),
        ("people/a", "person"),
        ("people/b", "person"),
        ("people/c", "person"),
        ("zeta/a", "z"),
        ("zeta/b", "z"),
        ("zeta/c", "z"),
        ("alpha/a", "a"),
        ("alpha/b", "a"),
        ("alpha/c", "a"),
        ("loose", "ab"),
        ("gone/a", "ab"),
    ] {
        page(&b, "s1", slug, t);
    }
    page(&b, "s2", "notes/x", "other");
    b.soft_delete_page("gone/a", Some("s1")).unwrap();
    b
}

#[test]
fn totals_count_the_live_pages_of_the_source_and_the_empty_type_as_untyped() {
    let b = seeded();
    let got = b
        .page_type_totals(&de::<PageTypeTotalsArgs>(json!({ "sourceId": "s1" })))
        .unwrap();
    assert_eq!(got, json!({ "total": 14, "typed": 13, "untyped": 1 }));
    let none = b
        .page_type_totals(&de::<PageTypeTotalsArgs>(json!({ "sourceId": "nope" })))
        .unwrap();
    assert_eq!(none, json!({ "total": 0, "typed": 0, "untyped": 0 }));
}

#[test]
fn prefixes_sort_by_count_then_bytes_and_list_their_types_in_byte_order() {
    let b = seeded();
    let got = b
        .page_prefix_samples(&de::<PagePrefixSamplesArgs>(
            json!({ "sourceId": "s1", "minPages": 3, "limit": 3 }),
        ))
        .unwrap();
    assert_eq!(
        got,
        json!([
            { "prefix": "notes/", "cnt": 4, "sample_types": ["a-z", "ab"] },
            { "prefix": "alpha/", "cnt": 3, "sample_types": ["a"] },
            { "prefix": "people/", "cnt": 3, "sample_types": ["person"] },
        ])
    );
    let few = b
        .page_prefix_samples(&de::<PagePrefixSamplesArgs>(
            json!({ "sourceId": "s1", "minPages": 4, "limit": 50 }),
        ))
        .unwrap();
    assert_eq!(few.as_array().unwrap().len(), 1);
}

#[test]
fn type_counts_skip_the_empty_type_and_break_ties_in_byte_order() {
    let b = seeded();
    let got = b
        .count_pages_by_type_for_source(&de::<PageTypeCountsArgs>(
            json!({ "sourceId": "s1", "limit": 4 }),
        ))
        .unwrap();
    assert_eq!(
        got,
        json!([
            { "type": "a", "cnt": 3 },
            { "type": "ab", "cnt": 3 },
            { "type": "person", "cnt": 3 },
            { "type": "z", "cnt": 3 },
        ])
    );
}
