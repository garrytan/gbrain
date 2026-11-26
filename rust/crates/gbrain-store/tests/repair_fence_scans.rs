//! The page scans of the contact-rows, split-facts and atom-fence-rows repair plans. The three-arm cases are in
//! test/engine-parity/repair-fence-scans.test.ts; these pin the filters on one store: soft-deleted pages drop out,
//! the contact-row count, slug and cursor filters, the two fence sections, the world-atom join and its text, and
//! the request read by client request id.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::repair_fence_scans::{AtomFenceQuery, ContactRowQuery};
use serde_json::{Value, json};

fn put(
    store: &Store,
    slug: &str,
    kind: &str,
    truth: &str,
    timeline: &str,
    frontmatter: Value,
) -> u64 {
    let input = serde_json::from_value(json!({
        "type": kind, "title": slug, "compiled_truth": truth, "timeline": timeline, "frontmatter": frontmatter,
    }))
    .unwrap();
    let options = serde_json::from_value(json!({})).unwrap();
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn sources() -> Vec<String> {
    vec!["default".to_owned()]
}

#[test]
fn contact_rows_need_two_live_inline_rows() {
    let dir = TempDir::new("repair-fence-contacts");
    let store = open(&dir);
    let row = json!({ "type": "phone", "value": "+15550100" });
    let a = put(
        &store,
        "people/a",
        "person",
        "a",
        "",
        json!({ "contacts": [row, row] }),
    );
    let b = put(
        &store,
        "people/b",
        "person",
        "b",
        "",
        json!({ "contacts": [row, row, row] }),
    );
    put(
        &store,
        "people/c",
        "person",
        "c",
        "",
        json!({ "contacts": [row] }),
    );
    put(
        &store,
        "people/d",
        "person",
        "d",
        "",
        json!({ "contacts": "not a list" }),
    );
    put(
        &store,
        "people/e",
        "person",
        "e",
        "",
        json!({ "contacts": [row, row] }),
    );
    store.soft_delete_page("people/e", None).unwrap();

    let query = |after_id: u64, limit: u64, slugs: &[&str]| ContactRowQuery {
        after_id,
        limit,
        slugs: slugs.iter().map(|s| (*s).to_owned()).collect(),
    };
    let slugs = |q: ContactRowQuery| -> Vec<String> {
        store
            .list_contact_row_pages(&sources(), &q)
            .unwrap()
            .into_iter()
            .map(|p| p.slug)
            .collect()
    };
    assert_eq!(slugs(query(0, 10, &[])), ["people/a", "people/b"]);
    assert_eq!(slugs(query(0, 1, &[])), ["people/a"]);
    assert_eq!(
        slugs(query(0, 0, &[])),
        ["people/a"],
        "a limit below one reads one page"
    );
    assert_eq!(slugs(query(a, 10, &[])), ["people/b"]);
    assert_eq!(slugs(query(0, 10, &["people/b", "people/c"])), ["people/b"]);
    assert!(slugs(query(b, 10, &[])).is_empty());
    assert!(
        store
            .list_contact_row_pages(&["other".to_owned()], &query(0, 10, &[]))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn split_facts_needs_a_fence_in_both_sections() {
    let dir = TempDir::new("repair-fence-split");
    let store = open(&dir);
    let fence = "<!--- gbrain:facts:begin -->\n| # |\n<!--- gbrain:facts:end -->";
    put(
        &store,
        "people/split",
        "person",
        &format!("bio\n\n{fence}"),
        &format!("tl\n\n{fence}"),
        json!({}),
    );
    put(
        &store,
        "people/truth-only",
        "person",
        &format!("bio\n\n{fence}"),
        "tl",
        json!({}),
    );
    put(
        &store,
        "people/timeline-only",
        "person",
        "bio",
        &format!("tl\n\n{fence}"),
        json!({}),
    );
    put(
        &store,
        "people/gone",
        "person",
        &format!("bio\n\n{fence}"),
        &format!("tl\n\n{fence}"),
        json!({}),
    );
    store.soft_delete_page("people/gone", None).unwrap();

    let found = store.list_split_facts_pages(&sources()).unwrap();
    let inline: Vec<&str> = found.inline.iter().map(|p| p.slug.as_str()).collect();
    assert_eq!(inline, ["people/split"]);
    assert!(found.segmented.is_empty());
}

#[test]
fn atom_candidates_join_their_live_fenced_source_page() {
    let dir = TempDir::new("repair-fence-atoms");
    let store = open(&dir);
    let origin = put(
        &store,
        "notes/fenced",
        "note",
        "intro\n<!--- gbrain:takes:begin -->\nrows",
        "",
        json!({}),
    );
    put(&store, "notes/plain", "note", "no fence", "", json!({}));
    let atom = |slug: &str, frontmatter: Value| put(&store, slug, "atom", "claim", "", frontmatter);
    let first = atom(
        "atoms/one",
        json!({ "source_slug": "notes/fenced", "visibility": "world", "source_quote": "quoted" }),
    );
    let second = atom(
        "atoms/two",
        json!({ "source_slug": "notes/fenced", "visibility": "world" }),
    );
    atom(
        "atoms/private",
        json!({ "source_slug": "notes/fenced", "visibility": "private" }),
    );
    atom(
        "atoms/plain",
        json!({ "source_slug": "notes/plain", "visibility": "world" }),
    );
    atom(
        "atoms/orphan",
        json!({ "source_slug": "notes/missing", "visibility": "world" }),
    );

    let query = |atom_id: Option<u64>, after_id: u64, limit: u64| AtomFenceQuery {
        atom_id,
        after_id,
        limit,
    };
    let all = store
        .list_atom_fence_candidates(&sources(), &query(None, 0, 10))
        .unwrap();
    let slugs: Vec<&str> = all.iter().map(|c| c.slug.as_str()).collect();
    assert_eq!(slugs, ["atoms/one", "atoms/two"]);
    assert_eq!(
        all[0].text.as_deref(),
        Some("atoms/one\nclaim\nquoted"),
        "joined with a newline, as the SQL"
    );
    assert_eq!(all[1].text.as_deref(), Some("atoms/two\nclaim"));
    assert_eq!(
        (
            all[0].origin_id,
            all[0].origin_slug.as_str(),
            all[0].origin_unread
        ),
        (origin, "notes/fenced", false)
    );
    assert_eq!(all[0].revision, all[0].revision.to_lowercase());

    let one = store
        .list_atom_fence_candidates(&sources(), &query(Some(second), 0, 10))
        .unwrap();
    assert_eq!(one.iter().map(|c| c.id).collect::<Vec<_>>(), [second]);
    let after = store
        .list_atom_fence_candidates(&sources(), &query(None, first, 10))
        .unwrap();
    assert_eq!(after.iter().map(|c| c.id).collect::<Vec<_>>(), [second]);
    let capped = store
        .list_atom_fence_candidates(&sources(), &query(None, 0, 1))
        .unwrap();
    assert_eq!(capped.iter().map(|c| c.id).collect::<Vec<_>>(), [first]);

    let truths = store.list_page_truths(&[origin, 999_999]).unwrap();
    assert_eq!(truths.len(), 1);
    assert_eq!(
        truths[0].body.as_deref(),
        Some("intro\n<!--- gbrain:takes:begin -->\nrows")
    );
    store.soft_delete_page("notes/fenced", None).unwrap();
    assert_eq!(
        store.list_page_truths(&[origin]).unwrap().len(),
        1,
        "any state"
    );
    assert!(
        store
            .list_atom_fence_candidates(&sources(), &query(None, 0, 10))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn requests_by_client_id_check_each_id() {
    let dir = TempDir::new("repair-fence-requests");
    let store = open(&dir);
    assert!(
        store
            .list_write_requests_by_request_ids(&[])
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_write_requests_by_request_ids(
                &["00000000-0000-4000-8000-000000000000".to_owned()]
            )
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_write_requests_by_request_ids(&["not-a-uuid".to_owned()])
            .is_err()
    );
}
