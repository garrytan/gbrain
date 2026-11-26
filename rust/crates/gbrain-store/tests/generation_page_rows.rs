//! The page row read of the generation adapters, matched to PGLite
//! (`engine-sql/generation-page-rows.ts` `readGenerationPageRows`): each `match` selects the
//! rows its statement selects, deleted rows included, by slug.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::generations::GenerationPageRowsQuery;
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, slug: &str, page: Value) {
    b.put_page(
        slug,
        &args::<PageInput>(page),
        &args::<PutPageOptions>(json!({})),
    )
    .unwrap();
}

fn read(b: &Brain, query: Value) -> Vec<Value> {
    b.read_generation_page_rows(&args::<GenerationPageRowsQuery>(query))
        .unwrap()
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn generation_page_rows_select_each_match_with_deleted_rows_by_slug() {
    let b = brain("generation-page-rows");
    put(
        &b,
        "notes/one",
        json!({ "type": "note", "title": "One", "compiled_truth": "body", "timeline": "",
                "frontmatter": { "k": 1 } }),
    );
    b.add_tag("notes/one", "zeta", None).unwrap();
    b.add_tag("notes/one", "alpha", None).unwrap();
    let one = read(
        &b,
        json!({ "sourceId": "default", "match": "slug", "slug": "notes/one" }),
    );
    assert_eq!(one.len(), 1);
    let row = &one[0];
    assert!(row["page_id"].as_u64().unwrap() > 0);
    assert_eq!(row["type"], json!("note"));
    assert_eq!(row["title"], json!("One"));
    assert_eq!(row["compiled_truth"], json!("body"));
    assert_eq!(row["frontmatter"]["k"], json!(1));
    assert_eq!(row["deleted"], json!(false));
    assert_eq!(row["segmented"], json!(false));
    assert_eq!(row["tags"], json!(["alpha", "zeta"]));
    assert!(
        read(
            &b,
            json!({ "sourceId": "other", "match": "slug", "slug": "notes/one" })
        )
        .is_empty()
    );

    // Synthesis: listed slugs, and live dream-generated pages of the locator.
    let dream = |raw: &str, generated: Value| {
        json!({ "type": "note", "title": "D", "compiled_truth": "d",
                "frontmatter": { "raw_source": raw, "dream_generated": generated } })
    };
    put(&b, "dream/b", dream("loc-1", json!(true)));
    put(&b, "dream/a", dream("loc-1", json!("true")));
    put(&b, "dream/c", dream("loc-2", json!(true)));
    put(&b, "dream/d", dream("loc-1", json!(false)));
    put(&b, "dream/gone", dream("loc-1", json!(true)));
    b.soft_delete_page("dream/gone", None).unwrap();
    let synthesis = |listed: Value, locator: Value| {
        read(
            &b,
            json!({ "sourceId": "default", "match": "synthesis", "slugs": listed, "locator": locator }),
        )
    };
    assert_eq!(
        slugs(&synthesis(json!(["dream/gone"]), json!("loc-1"))),
        ["dream/a", "dream/b", "dream/gone"]
    );
    assert_eq!(
        slugs(&synthesis(json!(["dream/c"]), json!(null))),
        ["dream/c"]
    );
    let gone = synthesis(json!(["dream/gone"]), json!(null));
    assert_eq!(gone[0]["deleted"], json!(true));

    // Atoms: only atom pages, listed or live with the origin field.
    let atom = |field: &str, value: &str| {
        let mut fm = serde_json::Map::new();
        fm.insert(field.into(), json!(value));
        json!({ "type": "atom", "title": "A", "compiled_truth": "a", "frontmatter": fm })
    };
    put(&b, "atoms/x", atom("source_slug", "notes/one"));
    put(&b, "atoms/y", atom("source_path", "notes/one"));
    put(
        &b,
        "notes/not-atom",
        json!({ "type": "note", "title": "N", "compiled_truth": "n",
        "frontmatter": { "source_slug": "notes/one" } }),
    );
    let atoms = |field: &str, value: Value, listed: Value| {
        read(
            &b,
            json!({ "sourceId": "default", "match": "atoms", "slugs": listed, "field": field, "value": value }),
        )
    };
    assert_eq!(
        slugs(&atoms(
            "source_slug",
            json!("notes/one"),
            json!(["notes/not-atom"])
        )),
        ["atoms/x"]
    );
    assert_eq!(
        slugs(&atoms("source_path", json!(null), json!(["atoms/x"]))),
        ["atoms/x"]
    );
    assert_eq!(
        slugs(&atoms("source_path", json!("notes/one"), json!([]))),
        ["atoms/y"]
    );

    // Chronicle: listed slugs, and live Life Chronicle events of the depth.
    let event = |depth: Value, via: &str| {
        json!({ "type": "event", "title": "E", "compiled_truth": "e",
                "frontmatter": { "event": { "depth": depth }, "captured_via": via } })
    };
    put(&b, "events/a", event(json!("year"), "life-chronicle:dream"));
    put(&b, "events/b", event(json!("day"), "life-chronicle:dream"));
    put(&b, "events/c", event(json!("year"), "manual"));
    put(&b, "events/d", event(json!(2), "life-chronicle:x"));
    let chronicle = |depth: &str| {
        read(
            &b,
            json!({ "sourceId": "default", "match": "chronicle", "slugs": ["events/c"], "depth": depth }),
        )
    };
    assert_eq!(slugs(&chronicle("year")), ["events/a", "events/c"]);
    assert_eq!(slugs(&chronicle("2")), ["events/c", "events/d"]);

    // Refusals: an unknown match, an atoms field outside the two, a NUL.
    for bad in [
        json!({ "sourceId": "default", "match": "other", "slugs": [] }),
        json!({ "sourceId": "default", "match": "atoms", "slugs": [], "field": "x", "value": null }),
        json!({ "sourceId": "default", "match": "slug", "slug": "a\u{0}b" }),
        json!({ "sourceId": "default", "match": "synthesis", "locator": null }),
    ] {
        let err = b
            .read_generation_page_rows(&args::<GenerationPageRowsQuery>(bad))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}
