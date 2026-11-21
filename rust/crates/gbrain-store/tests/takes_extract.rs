//! The reads, the delete and the batch guard of `gbrain extract takes` (`engine-sql/takes-reads.ts`
//! and `engine-sql/trust-fence.ts` `listGuardedTakeRows`): the page and tier reads, the takes that
//! leave a fence, their before-state, the prune delete, the take-id read and the rows a lower-tier
//! batch may not delete or change.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::{IncomingTake, ListTakesOptions, TakeInput, TakesLeavingFence};
use gbrain_store::trust::held_rows::GuardedTakeRowsQuery;
use gbrain_store::trust::proposals::NewProposal;
use serde_json::{Value, json};

fn names(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn page(store: &Store, slug: &str, frontmatter: Value) -> i64 {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: format!("body of {slug}"),
        frontmatter: frontmatter.as_object().cloned(),
        ..PageInput::default()
    };
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn take(store: &Store, page_id: i64, row: i32, claim: &str, tier: Option<&str>) {
    match tier {
        Some(t) => store
            .apply_write_trust(
                &names(&["gbrain.write_trust_tier", "gbrain.write_trust_promotion"]),
                &names(&[t, t]),
            )
            .unwrap(),
        None => store.clear_write_trust(),
    }
    let rows: Vec<TakeInput> = serde_json::from_value(json!([{
        "page_id": page_id, "row_num": row, "claim": claim, "kind": "take", "holder": "h",
        "weight": 0.5, "active": true,
    }]))
    .unwrap();
    store.add_takes_batch(&rows).unwrap();
    store.clear_write_trust();
}

fn take_ids(store: &Store, page_id: i64) -> Vec<u64> {
    let options: ListTakesOptions =
        serde_json::from_value(json!({ "page_id": page_id, "limit": 50, "active": true })).unwrap();
    let mut rows = store.list_takes(&options).unwrap();
    rows.sort_by_key(|r| r["row_num"].as_i64());
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

fn ids(v: &[u64]) -> Vec<i64> {
    v.iter().map(|id| i64::try_from(*id).unwrap()).collect()
}

#[test]
fn page_reads_find_the_live_page_its_tier_and_its_frontmatter_keys() {
    let dir = TempDir::new("takes-extract-pages");
    let store = open(&dir);
    let a = page(
        &store,
        "a",
        json!({ "quarantine": true, "nested": { "inner": 1 } }),
    );
    let b = page(&store, "b", json!({}));
    assert_eq!(
        store.read_live_page_id_by_slug("a", "default").unwrap(),
        Some(u64::try_from(a).unwrap())
    );
    assert_eq!(store.read_live_page_id_by_slug("a", "other").unwrap(), None);
    assert_eq!(
        store.read_live_page_id_by_slug("nope", "default").unwrap(),
        None
    );
    assert_eq!(
        store.read_page_tier_ref(a).unwrap(),
        Some(json!({ "source_id": "default", "slug": "a", "trust_tier": "unknown" }))
    );
    assert_eq!(store.read_page_tier_ref(-1).unwrap(), None);
    assert!(store.page_has_frontmatter_key(a, "quarantine").unwrap());
    assert!(!store.page_has_frontmatter_key(a, "inner").unwrap());
    assert!(!store.page_has_frontmatter_key(b, "quarantine").unwrap());
    assert!(!store.page_has_frontmatter_key(-1, "quarantine").unwrap());
    // A soft-deleted page is hidden from the slug read only.
    store.soft_delete_page("a", Some("default")).unwrap();
    assert_eq!(
        store.read_live_page_id_by_slug("a", "default").unwrap(),
        None
    );
    assert!(store.read_page_tier_ref(a).unwrap().is_some());
    assert!(store.page_has_frontmatter_key(a, "quarantine").unwrap());
    // By id, once per id, deleted or not; unknown and negative ids read nothing.
    let rows = store.read_page_tier_rows(&[b, a, b, -1, 999_999]).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["slug"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
fn take_reads_and_the_prune_delete_follow_the_fence() {
    let dir = TempDir::new("takes-extract-takes");
    let store = open(&dir);
    let a = page(&store, "a", json!({}));
    let b = page(&store, "b", json!({}));
    for (row, claim) in [(1, "one"), (2, "two"), (3, "three")] {
        take(&store, a, row, claim, None);
    }
    take(&store, b, 1, "other", None);
    let t = take_ids(&store, a);
    let other = take_ids(&store, b)[0];

    let removed: TakesLeavingFence =
        serde_json::from_value(json!({ "change": "removed", "rowNums": [1, 3] })).unwrap();
    assert_eq!(
        store.list_take_ids_leaving_fence(a, &removed).unwrap(),
        vec![t[1]]
    );
    let replaced: TakesLeavingFence = serde_json::from_value(json!({
        "change": "replaced",
        "rows": [{ "row_num": 1, "claim": "one" }, { "row_num": 2, "claim": "TWO" }],
    }))
    .unwrap();
    assert_eq!(
        store.list_take_ids_leaving_fence(a, &replaced).unwrap(),
        vec![t[1], t[2]]
    );

    assert_eq!(store.find_take_id(a, 2).unwrap(), Some(t[1]));
    assert_eq!(store.find_take_id(a, 9).unwrap(), None);
    assert_eq!(store.find_take_id(-1, 2).unwrap(), None);

    // Gone takes, and takes an incoming row restates differently, once per such row.
    let incoming: Vec<IncomingTake> = serde_json::from_value(json!([
        { "row_num": 1, "claim": "one", "kind": "take", "holder": "h" },
        { "row_num": 2, "claim": "two", "kind": "bet", "holder": "h" },
        { "row_num": 2, "claim": "2", "kind": "take", "holder": "h" },
    ]))
    .unwrap();
    let pre = store
        .list_take_preimages(a, &ids(&[t[2]]), &incoming)
        .unwrap();
    let got: Vec<(i64, bool)> = pre
        .iter()
        .map(|r| {
            (
                r["preimage"]["row_num"].as_i64().unwrap(),
                r["gone"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(got, vec![(2, false), (2, false), (3, true)]);
    assert_eq!(pre[0]["preimage"]["claim"], json!("two"));
    assert_eq!(pre[0]["preimage"]["resolved_at"], Value::Null);

    // The delete removes the listed takes on any page; an empty list writes nothing.
    store.delete_takes_by_ids(&[]).unwrap();
    store
        .delete_takes_by_ids(
            &ids(&[t[0], other])
                .into_iter()
                .chain([999_999, -1])
                .collect::<Vec<_>>(),
        )
        .unwrap();
    assert_eq!(take_ids(&store, a), vec![t[1], t[2]]);
    assert!(take_ids(&store, b).is_empty());
}

#[test]
fn the_batch_guard_holds_more_trusted_takes_and_takes_under_a_pending_forget() {
    let dir = TempDir::new("takes-extract-guard");
    let store = open(&dir);
    let a = page(&store, "a", json!({}));
    take(&store, a, 1, "plain", None);
    take(&store, a, 2, "curated", Some("operator_curated"));
    take(&store, a, 3, "agent", Some("agent_written"));
    let t = take_ids(&store, a);
    let query = |pending: bool| -> GuardedTakeRowsQuery {
        serde_json::from_value(json!({
            "incoming": [
                { "page_id": a, "row_num": 1, "claim": "PLAIN", "kind": "take", "holder": "h", "active": true },
                { "page_id": a, "row_num": 2, "claim": "curated", "kind": "take", "holder": "h", "active": false },
                { "page_id": a, "row_num": 3, "claim": "agent", "kind": "take", "holder": "h", "active": true },
            ],
            "gone": [],
            "pending": pending,
        }))
        .unwrap()
    };
    let guarded = |q: &GuardedTakeRowsQuery| -> Vec<(u64, String, String)> {
        store
            .list_guarded_take_rows(q, &store.fence_context())
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["id"].as_u64().unwrap(),
                    r["trust_tier"].as_str().unwrap().to_string(),
                    r["change"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    // An undeclared writer is `unknown`: the curated take it deactivates is held; the agent take
    // is restated unchanged, and the plain take ranks no higher than the writer.
    assert_eq!(
        guarded(&query(false)),
        vec![(t[1], "operator_curated".into(), "deactivated".into())]
    );
    // A row of the batch's `gone` list is `removed`.
    let gone: GuardedTakeRowsQuery = serde_json::from_value(json!({
        "incoming": [], "gone": [{ "page_id": a, "row_num": 3 }],
    }))
    .unwrap();
    assert_eq!(
        guarded(&gone),
        vec![(t[2], "agent_written".into(), "removed".into())]
    );
    // An operator-curated writer holds nothing; a pending forget on the plain take holds it with `pending`.
    store
        .apply_write_trust(
            &names(&["gbrain.write_trust_tier"]),
            &names(&["operator_curated"]),
        )
        .unwrap();
    assert!(guarded(&query(false)).is_empty());
    let proposal: NewProposal = serde_json::from_value(json!({
        "action": "forget", "sourceId": "default",
        "target": { "table": "takes", "id": t[0] },
        "before": {}, "proposer": "test",
    }))
    .unwrap();
    store.insert_trust_proposal(&proposal).unwrap();
    assert!(guarded(&query(false)).is_empty());
    assert_eq!(
        guarded(&query(true)),
        vec![(t[0], "unknown".into(), "replaced".into())]
    );
    store.clear_write_trust();
    // An empty batch reads nothing.
    assert!(guarded(&GuardedTakeRowsQuery::default()).is_empty());
}
