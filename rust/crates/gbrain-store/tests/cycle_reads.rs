//! The cycle, identity-downgrade and segmented-rewrite reads that were raw SQL
//! (rust/docs/store/cycle-window.md, identity-downgrades.md, phantom-redirect.md, page_body.md), each against the rows the PGLite SQL of
//! src/core/engine-sql/cycle-reads.ts returns.

mod memory_env;

use gbrain_store::links::AddLinkOptions;
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

#[test]
fn the_root_page_walk_skips_nested_held_and_deleted_slugs() {
    let b = brain("cycle-roots");
    for slug in ["ab", "a0", "a-z", "a/z", "gone"] {
        page(&b, slug, json!({}));
    }
    b.soft_delete_page("gone", Some("default")).unwrap();
    let walk = |after: &str, held: &[&str], limit: usize| -> Vec<String> {
        let held: Vec<String> = held.iter().map(|s| s.to_string()).collect();
        b.list_root_page_slugs_after("default", limit, &held, after)
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(walk("", &[], 10), ["a-z", "a0", "ab"]);
    assert_eq!(walk("a-z", &["a0"], 10), ["ab"]);
    assert_eq!(walk("", &[], 2), ["a-z", "a0"]);
    assert!(walk("ab", &[], 10).is_empty());
}

#[test]
fn the_identity_downgrade_reads_follow_the_old_files_pages() {
    let b = brain("cycle-identity");
    // One path backs six pages that were soft-deleted in one sync (one clock reading): the lowest id is named.
    for slug in ["notes/m", "notes/c", "notes/x"] {
        page(&b, slug, json!({ "source_path": "notes/old.md" }));
        b.soft_delete_page(slug, Some("default")).unwrap();
    }
    let old = b
        .read_soft_deleted_page_at_origin("default", "notes/old.md", "notes/none")
        .unwrap()
        .unwrap();
    assert_eq!((old.id, old.slug.as_str()), (1, "notes/m"));
    assert_eq!(old.deleted_at, "2027-01-15 08:00:00+00");
    // A page with no path is found by its slug; a live page is not a soft-deleted one.
    page(&b, "notes/bare", json!({}));
    b.soft_delete_page("notes/bare", Some("default")).unwrap();
    let bare = b
        .read_soft_deleted_page_at_origin("default", "elsewhere.md", "notes/bare")
        .unwrap()
        .unwrap();
    assert_eq!(bare.slug, "notes/bare");
    page(&b, "notes/b", json!({ "source_path": "notes/new.md" }));
    page(&b, "notes/a", json!({}));
    // A live page's origin is unique (a second page at the path is refused), so the path names one page.
    let live = b
        .list_live_pages_at_origin("default", "notes/new.md")
        .unwrap();
    assert_eq!(
        live.iter().map(|r| r.slug.as_str()).collect::<Vec<_>>(),
        ["notes/b"]
    );
    assert!(
        b.list_live_pages_at_origin("default", "notes/old.md")
            .unwrap()
            .is_empty()
    );
    // A carry moves facts, links (either end, a self link once) and aliases of the old page.
    let options = AddLinkOptions {
        link_type: Some("mentions".into()),
        link_source: Some("manual".into()),
        ..AddLinkOptions::default()
    };
    b.add_link("notes/a", "notes/b", &options).unwrap();
    b.add_link("notes/b", "notes/a", &options).unwrap();
    b.add_link("notes/b", "notes/b", &options).unwrap();
    let counts = b.count_page_carry_rows("default", "notes/b", 5).unwrap();
    assert_eq!((counts.facts, counts.aliases), (0, 0));
    assert_eq!(counts.links, 3);
}

#[test]
fn the_segmented_rewrite_page_read_answers_an_inline_page_and_restores_deleted_at() {
    let b = brain("cycle-rewrite-page");
    page(&b, "notes/x", json!({}));
    for tag in ["b", "a", "B"] {
        b.add_tag("notes/x", tag, Some("default")).unwrap();
    }
    let read = b.read_segmented_rewrite_page(1).unwrap().unwrap();
    assert_eq!(
        (
            read.slug.as_str(),
            read.body_storage.as_str(),
            read.body_generation
        ),
        ("notes/x", "inline", 0)
    );
    assert_eq!(read.tags, ["B", "a", "b"]);
    assert_eq!(read.deleted_at, None);
    assert!(b.read_segmented_rewrite_page(99).unwrap().is_none());
    assert!(b.read_segmented_rewrite_page(0).unwrap().is_none());
    b.restore_page_deleted_at(1, "2027-02-01T00:00:00.000000Z")
        .unwrap();
    assert_eq!(
        b.read_segmented_rewrite_page(1)
            .unwrap()
            .unwrap()
            .deleted_at
            .as_deref(),
        Some("2027-02-01T00:00:00.000000Z")
    );
    b.restore_page_deleted_at(99, "2027-02-01T00:00:00.000000Z")
        .unwrap();
    assert!(b.restore_page_deleted_at(1, "soon").is_err());
}
