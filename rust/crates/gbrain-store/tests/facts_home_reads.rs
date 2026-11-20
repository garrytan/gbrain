//! `facts/home_reads.rs`: the facts-home scan's reads, each against the rows its statement returns
//! (src/core/engine-sql/collate-facts-home-reads.ts).

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn page(b: &Brain, slug: &str, path: Option<&str>) {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: "x".into(),
        source_path: path.map(str::to_string),
        ..PageInput::default()
    };
    b.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn insert(b: &Brain, rows: Value) {
    let mut rows = rows;
    for row in rows.as_array_mut().unwrap() {
        row["source"] = row.get("source").cloned().unwrap_or(json!("t"));
    }
    let args: InsertFactsArgs =
        serde_json::from_value(json!({ "rows": rows, "sourceId": "default" })).unwrap();
    b.insert_facts(&args).unwrap();
}

fn column(rows: &[Value], name: &str) -> Vec<Value> {
    rows.iter().map(|r| r[name].clone()).collect()
}

#[test]
fn unfenced_rows_list_by_entity_byte_order_null_first_with_page_flags() {
    let b = brain("home-unfenced");
    page(&b, "people/live", None);
    page(&b, "people/gone", None);
    b.soft_delete_page("people/gone", None).unwrap();
    insert(
        &b,
        json!([
            { "fact": "upper", "entity_slug": "People/z" },
            { "fact": "live", "entity_slug": "people/live" },
            { "fact": "none" },
            { "fact": "gone", "entity_slug": "people/gone" },
            { "fact": "fenced", "entity_slug": "people/live", "row_num": 1, "source_markdown_slug": "people/live" },
            { "fact": "obs", "entity_slug": "people/live", "dimension": "role", "value": "cto" },
        ]),
    );
    let rows = b.scan_unfenced_fact_rows("default").unwrap();
    assert_eq!(
        column(&rows, "fact"),
        ["none", "upper", "gone", "live", "obs"].map(|f| json!(f))
    );
    let by = |fact: &str| rows.iter().find(|r| r["fact"] == fact).unwrap();
    assert_eq!(
        (
            by("live")["page_exists"].clone(),
            by("live")["page_deleted"].clone()
        ),
        (json!(true), json!(false))
    );
    assert_eq!(
        (
            by("gone")["page_exists"].clone(),
            by("gone")["page_deleted"].clone()
        ),
        (json!(false), json!(true))
    );
    assert_eq!(by("none")["page_exists"], json!(false));
    assert_eq!(by("obs")["dimension"], json!("role"));
    assert!(b.scan_unfenced_fact_rows("other").unwrap().is_empty());
}

#[test]
fn held_rows_are_the_other_entity_facts_on_a_holding_page_with_their_age() {
    let b = brain("home-held");
    page(&b, "memory/unattributed", None);
    page(&b, "people/live", None);
    insert(
        &b,
        json!([
            { "fact": "b", "entity_slug": "people/b", "row_num": 1, "source_markdown_slug": "memory/unattributed" },
            { "fact": "live", "entity_slug": "people/live", "row_num": 2, "source_markdown_slug": "memory/unattributed" },
            { "fact": "self", "entity_slug": "memory/unattributed", "row_num": 3, "source_markdown_slug": "memory/unattributed" },
            { "fact": "elsewhere", "entity_slug": "people/b", "row_num": 4, "source_markdown_slug": "people/live" },
            { "fact": "unfenced", "entity_slug": "people/b" },
        ]),
    );
    b.clock.advance(40 * DAY);
    insert(
        &b,
        json!([{ "fact": "young", "entity_slug": "people/a", "row_num": 5, "source_markdown_slug": "memory/unattributed" }]),
    );
    let rows = b.list_held_fact_rows("default", "30").unwrap();
    assert_eq!(
        column(&rows, "fact"),
        vec![json!("young"), json!("b"), json!("live")]
    );
    assert_eq!(
        column(&rows, "old"),
        vec![json!(false), json!(true), json!(true)]
    );
    assert_eq!(
        column(&rows, "page_exists"),
        vec![json!(false), json!(false), json!(true)]
    );
    assert_eq!(rows[1]["from_slug"], json!("memory/unattributed"));
    assert_eq!(rows[1]["held_since"], json!("2027-01-15T08:00:00Z"));
    let rows = b.list_held_fact_rows("default", "50").unwrap();
    assert_eq!(column(&rows, "old"), vec![json!(false); 3]);
    assert!(b.list_held_fact_rows("default", "1 day").is_err());
}

#[test]
fn fenced_facts_of_missing_or_soft_deleted_pages_list_by_id() {
    let b = brain("home-orphaned");
    page(&b, "n/live", None);
    page(&b, "n/gone", None);
    b.soft_delete_page("n/gone", None).unwrap();
    insert(
        &b,
        json!([
            { "fact": "ok", "row_num": 1, "source_markdown_slug": "n/live" },
            { "fact": "gone", "row_num": 1, "source_markdown_slug": "n/gone" },
            { "fact": "missing", "row_num": 1, "source_markdown_slug": "n/missing" },
            { "fact": "unfenced", "entity_slug": "n/missing" },
        ]),
    );
    let rows = b.list_fenced_facts_of_missing_pages("default").unwrap();
    assert_eq!(
        column(&rows, "slug"),
        vec![json!("n/gone"), json!("n/missing")]
    );
    assert!(rows[0]["id"].as_u64().unwrap() < rows[1]["id"].as_u64().unwrap());
}

#[test]
fn page_file_origin_reads_a_live_page_only_and_nul_is_refused() {
    let b = brain("home-origin");
    page(&b, "n/filed", Some("n/filed.md"));
    page(&b, "n/gone", Some("n/gone.md"));
    b.soft_delete_page("n/gone", None).unwrap();
    let origin = b
        .read_page_file_origin("default", "n/filed")
        .unwrap()
        .unwrap();
    assert_eq!(origin["source_path"], json!("n/filed.md"));
    assert_eq!(origin["source_uri"], Value::Null);
    assert!(
        b.read_page_file_origin("default", "n/gone")
            .unwrap()
            .is_none()
    );
    assert!(
        b.read_page_file_origin("default", "n/none")
            .unwrap()
            .is_none()
    );
    assert!(b.read_page_file_origin("default", "n/\0").is_err());
    assert!(b.scan_unfenced_fact_rows("de\0").is_err());
    assert!(b.list_held_fact_rows("default", "3\0").is_err());
    assert!(b.list_fenced_facts_of_missing_pages("de\0").is_err());
}
