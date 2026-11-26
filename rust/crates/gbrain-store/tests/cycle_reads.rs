//! The cycle's changed-page window, which was raw SQL (rust/docs/store/cycle-window.md), against the rows the PGLite SQL
//! of src/core/engine-sql/cycle-reads.ts returns.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, extra: Value) {
    let mut input = json!({ "type": "note", "title": slug, "compiled_truth": "x", "timeline": "" });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    let input: PageInput = de(input);
    let opts: PutPageOptions = de(json!({ "sourceId": "default", "index": false }));
    b.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn the_window_lists_live_pages_after_a_cursor_by_time_then_slug_bytes() {
    let b = brain("cycle-window");
    b.clock.set(memory_env::T0);
    for slug in ["ab", "a0", "a-z"] {
        page(&b, slug, json!({}));
    }
    b.clock.advance(1_000_000);
    page(&b, "later", json!({}));
    b.soft_delete_page("a0", Some("default")).unwrap();
    let all = b
        .list_source_changed_pages_after("default", None, "", 10)
        .unwrap();
    let slugs: Vec<&str> = all.iter().map(|r| r.slug.as_str()).collect();
    // The soft-deleted page is not listed; the tie is in byte order, the later page last.
    assert_eq!(slugs, ["a-z", "ab", "later"]);
    assert_eq!(all[0].updated_at, "2027-01-15T08:00:00.000000Z");
    // After the first page of the tie: the cursor names its time and slug.
    let after = b
        .list_source_changed_pages_after("default", Some(&all[0].updated_at), "a-z", 10)
        .unwrap();
    assert_eq!(
        after.iter().map(|r| r.slug.as_str()).collect::<Vec<_>>(),
        ["ab", "later"]
    );
    assert_eq!(
        b.list_source_changed_pages_after("default", None, "", 1)
            .unwrap()
            .len(),
        1
    );
    assert!(
        b.list_source_changed_pages_after("default", Some("yesterday"), "", 1)
            .is_err()
    );
    assert_eq!(
        b.read_cycle_listing_instant().unwrap(),
        "2027-01-15T08:00:01.000000Z"
    );
}
