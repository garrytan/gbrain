//! The phantom redirect's statements (facts/phantom.rs, links/phantom_merge.rs), each against what the PGLite SQL of
//! src/core/engine-sql/facts-cycle.ts answers.

mod memory_env;

use gbrain_store::facts::cycle::PageCoordinate;
use gbrain_store::facts::phantom::{FactIdsOnPage, MoveFactArgs, RootSlugsQuery};
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::links::LinkScope;
use gbrain_store::links::phantom_merge::{LinkIdsOnPage, RepointArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str) -> u64 {
    let input: PageInput =
        de(json!({ "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": {} }));
    let opts: PutPageOptions = de(json!({ "sourceId": "default", "index": false }));
    b.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn fact(b: &Brain, text: &str, slug: &str, row_num: i64) -> u64 {
    let row = json!({ "fact": text, "entity_slug": null, "source_markdown_slug": slug, "row_num": row_num,
        "kind": "fact", "visibility": "world", "source": "fence" });
    b.insert_facts(&de::<InsertFactsArgs>(
        json!({ "rows": [row], "sourceId": "default" }),
    ))
    .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn at(slug: &str) -> PageCoordinate {
    de(json!({ "sourceId": "default", "slug": slug }))
}

fn mv(b: &Brain, id: u64, slug: &str, row_num: Option<i64>) -> gbrain_store::error::Result<()> {
    b.move_fact_to_page(&de::<MoveFactArgs>(
        json!({ "sourceId": "default", "id": id as f64, "slug": slug, "rowNum": row_num }),
    ))
}

fn ids(rows: &[Value]) -> Vec<u64> {
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

#[test]
fn the_phantom_fact_move_reads_moves_and_expires_rows() {
    let b = brain("phantom-facts");
    let one = fact(&b, "p1", "phantom", 1);
    let two = fact(&b, "p2", "phantom", 2);
    let three = fact(&b, "p3", "phantom", 3);
    fact(&b, "c5", "canon", 5);
    assert!(
        b.expire_fact(&de::<ExpireFactArgs>(json!({ "id": three as f64 })))
            .unwrap()
    );
    assert_eq!(
        b.list_phantom_fact_rows(&at("phantom")).unwrap(),
        vec![
            json!({ "id": one, "row_num": 1 }),
            json!({ "id": two, "row_num": 2 }),
            json!({ "id": three, "row_num": 3 }),
        ]
    );
    assert_eq!(
        b.list_canonical_fence_row_nums(&at("canon")).unwrap(),
        vec![json!({ "row_num": 5 })]
    );
    assert_eq!(
        ids(&b.list_active_fact_ids_of_page(&at("phantom")).unwrap()),
        vec![one, two]
    );
    // A row number the canonical page already holds breaks the unique fence key.
    let clash = mv(&b, one, "canon", Some(5)).unwrap_err();
    assert_eq!(clash.code, gbrain_store::error::CONSTRAINT_VIOLATION);
    mv(&b, one, "canon", Some(6)).unwrap();
    mv(&b, two, "canon", None).unwrap();
    mv(&b, three, "canon", None).unwrap();
    // A fact of another source is left alone.
    b.move_fact_to_page(&de::<MoveFactArgs>(
        json!({ "sourceId": "other", "id": one as f64, "slug": "elsewhere", "rowNum": 1 }),
    ))
    .unwrap();
    let still: FactIdsOnPage =
        de(json!({ "ids": [one as f64, two as f64, one as f64, 0.0], "slug": "canon" }));
    assert_eq!(
        ids(&b.list_fact_ids_still_on_page(&still).unwrap()),
        vec![one]
    );
    // By fact id: p1 (now row 6) was written before c5.
    assert_eq!(
        b.list_canonical_fence_row_nums(&at("canon")).unwrap(),
        vec![json!({ "row_num": 6 }), json!({ "row_num": 5 })]
    );
    assert!(b.list_phantom_fact_rows(&at("phantom")).unwrap().is_empty());
    assert!(
        mv(&b, two, "canon", None).is_ok(),
        "an expired row moves again with its expiry kept"
    );
    let fraction = b.move_fact_to_page(&de::<MoveFactArgs>(
        json!({ "sourceId": "default", "id": one as f64, "slug": "canon", "rowNum": 6.5 }),
    ));
    assert_eq!(
        fraction.unwrap_err().code,
        gbrain_store::error::INVALID_ARGUMENT
    );
}

#[test]
fn the_phantom_link_merge_moves_links_the_canonical_page_lacks() {
    let b = brain("phantom-links");
    let phantom = page(&b, "phantom");
    let canon = page(&b, "canon");
    page(&b, "other");
    let link = |from: &str, to: &str| {
        let options = AddLinkOptions {
            link_type: Some("cites".into()),
            link_source: Some("manual".into()),
            ..AddLinkOptions::default()
        };
        b.add_link(from, to, &options).unwrap();
    };
    link("other", "phantom");
    link("other", "canon");
    link("phantom", "other");
    link("phantom", "phantom");
    let own = ids(&b.list_own_link_ids(phantom as f64).unwrap());
    assert_eq!(own.len(), 2);
    let args: RepointArgs = de(json!({ "phantomId": phantom, "canonicalId": canon }));
    b.repoint_inbound_links(&args).unwrap();
    b.repoint_outbound_links(&args).unwrap();
    let scope = LinkScope::default();
    let pairs = |rows: Vec<Value>| -> Vec<String> {
        let mut out: Vec<String> = rows
            .iter()
            .map(|l| {
                format!(
                    "{}->{}",
                    l["from_slug"].as_str().unwrap(),
                    l["to_slug"].as_str().unwrap()
                )
            })
            .collect();
        out.sort();
        out
    };
    // other->phantom stays: the canonical page already has other->canon of the same type and source. The self link
    // moves its target first; the outbound pass then skips it, as it would point canon at itself.
    assert_eq!(
        pairs(b.get_backlinks("phantom", &scope).unwrap()),
        vec!["other->phantom"]
    );
    assert_eq!(
        pairs(b.get_backlinks("canon", &scope).unwrap()),
        vec!["other->canon", "phantom->canon"]
    );
    assert_eq!(
        pairs(b.get_links("canon", &scope).unwrap()),
        vec!["canon->other"]
    );
    let on: LinkIdsOnPage = de(json!({ "ids": own, "pageId": canon }));
    assert_eq!(b.list_link_ids_on_page(&on).unwrap().len(), 1);
    let none: LinkIdsOnPage = de(json!({ "ids": [], "pageId": canon }));
    assert!(b.list_link_ids_on_page(&none).unwrap().is_empty());
    let gone: RepointArgs = de(json!({ "phantomId": phantom, "canonicalId": 999_999 }));
    assert_eq!(
        b.repoint_outbound_links(&gone).unwrap_err().code,
        gbrain_store::error::CONSTRAINT_VIOLATION
    );
}

#[test]
fn root_slugs_timeline_and_ontology_reads_answer_as_the_statements_do() {
    let b = brain("phantom-reads");
    for slug in ["a", "b", "c", "d", "x/y"] {
        page(&b, slug);
    }
    b.soft_delete_page("d", Some("default")).unwrap();
    let roots = |take: f64, held: &[&str], after: &str| -> Vec<String> {
        let q: RootSlugsQuery =
            de(json!({ "sourceId": "default", "take": take, "held": held, "after": after }));
        b.list_root_page_slugs_after(&q)
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(roots(10.0, &[], ""), ["a", "b", "c"]);
    assert_eq!(roots(10.0, &["b"], ""), ["a", "c"]);
    assert_eq!(roots(2.0, &[], ""), ["a", "b"]);
    assert_eq!(roots(10.0, &[], "a"), ["b", "c"]);
    assert!(roots(0.0, &[], "").is_empty());

    let with = page(&b, "with-timeline");
    let without = page(&b, "without");
    let entry: TimelineInput = de(json!({ "date": "2026-01-01", "summary": "happened" }));
    b.add_timeline_entry("with-timeline", &entry, &AddTimelineOptions::default())
        .unwrap();
    assert!(b.page_has_timeline_entries(Some(with as f64)).unwrap());
    assert!(!b.page_has_timeline_entries(Some(without as f64)).unwrap());
    assert!(!b.page_has_timeline_entries(None).unwrap());

    assert!(
        b.list_ontology_observation_slugs("default")
            .unwrap()
            .is_empty()
    );
}
