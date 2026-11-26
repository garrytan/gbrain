//! The held-row read of a lower-tier write (`engine-sql/trust-fence.ts` `listHeldRows`): the
//! page's take or timeline rows more trusted than the writer, or held by a pending `forget` contest.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::{ListTakesOptions, TakeInput};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::trust::held_rows::HeldRowsQuery;
use gbrain_store::trust::proposals::NewProposal;
use serde_json::{Value, json};

fn names(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn entry(store: &Store, slug: &str, summary: &str, tier: Option<&str>) {
    match tier {
        Some(t) => store
            .apply_write_trust(
                &names(&["gbrain.write_trust_tier", "gbrain.write_trust_promotion"]),
                &names(&[t, t]),
            )
            .unwrap(),
        None => store.clear_write_trust(),
    }
    let input = TimelineInput {
        date: Some("2026-03-01".into()),
        summary: Some(summary.into()),
        ..TimelineInput::default()
    };
    assert!(
        store
            .add_timeline_entry(slug, &input, &AddTimelineOptions::default())
            .unwrap()
    );
    store.clear_write_trust();
}

fn query(v: Value) -> HeldRowsQuery {
    serde_json::from_value(v).unwrap()
}

fn held(store: &Store, v: Value) -> Vec<(u64, String)> {
    store
        .list_held_rows(&query(v), &store.fence_context())
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["id"].as_u64().unwrap(),
                r["trust_tier"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn held_rows_are_the_rows_above_the_writer_or_under_a_pending_forget() {
    let dir = TempDir::new("held-rows");
    let store = open(&dir);
    let mut page_ids = Vec::new();
    for slug in ["a", "b"] {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: format!("body of {slug}"),
            ..PageInput::default()
        };
        let page = store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        page_ids.push(page["id"].as_i64().unwrap());
    }
    entry(&store, "a", "plain", None);
    entry(&store, "a", "curated", Some("operator_curated"));
    entry(&store, "a", "agent", Some("agent_written"));
    entry(&store, "b", "other page", Some("operator_curated"));
    let rows = store.list_stored_timeline_rows("default", "a").unwrap();
    let id_of = |summary: &str| rows.iter().find(|r| r.summary == summary).unwrap().id;
    let (plain, curated, agent) = (id_of("plain"), id_of("curated"), id_of("agent"));
    let other = store.list_stored_timeline_rows("default", "b").unwrap()[0].id;
    let all = json!([plain, curated, agent, other, 999_999]);
    let base = |extra: Value| {
        let mut q = json!({ "table": "timeline_entries", "pageId": page_ids[0], "ids": all });
        for (k, v) in extra.as_object().unwrap() {
            q[k] = v.clone();
        }
        q
    };
    // No declared tier: the writer is `unknown`, so the curated and agent rows are above it.
    assert_eq!(
        held(&store, base(json!({}))),
        vec![
            (curated, "operator_curated".into()),
            (agent, "agent_written".into())
        ]
    );
    // A named writer; a name that is no tier ranks 0, below `unknown`.
    assert_eq!(
        held(&store, base(json!({ "writer": "agent_written" }))),
        vec![(curated, "operator_curated".into())]
    );
    assert_eq!(
        held(&store, base(json!({ "writer": "no-such-tier" }))).len(),
        3
    );
    // The declared tier of the write trust context, when no writer is named.
    store
        .apply_write_trust(
            &names(&["gbrain.write_trust_tier"]),
            &names(&["operator_curated"]),
        )
        .unwrap();
    assert!(held(&store, base(json!({}))).is_empty());
    store.clear_write_trust();
    // A pending forget on the plain row holds it only with `pending`.
    let proposal: NewProposal = serde_json::from_value(json!({
        "action": "forget", "sourceId": "default",
        "target": { "table": "timeline_entries", "id": plain },
        "before": {}, "proposer": "test",
    }))
    .unwrap();
    store.insert_trust_proposal(&proposal).unwrap();
    let writer = json!({ "writer": "operator_curated" });
    assert!(held(&store, base(writer.clone())).is_empty());
    assert_eq!(
        held(
            &store,
            base(json!({ "writer": "operator_curated", "pending": true }))
        ),
        vec![(plain, "unknown".into())]
    );
    // A table that holds no tier is refused.
    let err = store
        .list_held_rows(
            &query(json!({ "table": "facts", "pageId": page_ids[0], "ids": [1] })),
            &store.fence_context(),
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    // A negative page id or no ids: no rows.
    assert!(
        held(
            &store,
            json!({ "table": "timeline_entries", "pageId": -1, "ids": all })
        )
        .is_empty()
    );
    assert!(
        held(
            &store,
            json!({ "table": "timeline_entries", "pageId": page_ids[0], "ids": [] })
        )
        .is_empty()
    );
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

#[test]
fn held_takes_are_the_takes_above_the_writer_or_under_a_pending_forget() {
    let dir = TempDir::new("held-takes");
    let store = open(&dir);
    let mut page_ids = Vec::new();
    for slug in ["a", "b"] {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: format!("body of {slug}"),
            ..PageInput::default()
        };
        let page = store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        page_ids.push(page["id"].as_i64().unwrap());
    }
    take(&store, page_ids[0], 1, "plain", None);
    take(&store, page_ids[0], 2, "curated", Some("operator_curated"));
    take(&store, page_ids[0], 3, "agent", Some("agent_written"));
    take(
        &store,
        page_ids[1],
        1,
        "other page",
        Some("operator_curated"),
    );
    let ids_of = |page_id: i64| {
        let options: ListTakesOptions =
            serde_json::from_value(json!({ "page_id": page_id, "limit": 50, "active": true }))
                .unwrap();
        let mut rows = store.list_takes(&options).unwrap();
        rows.sort_by_key(|r| r["row_num"].as_i64());
        rows.iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    let a = ids_of(page_ids[0]);
    let (plain, curated, agent) = (a[0], a[1], a[2]);
    let other = ids_of(page_ids[1])[0];
    let all = json!([plain, curated, agent, other, 999_999]);
    let base = |extra: Value| {
        let mut q = json!({ "table": "takes", "pageId": page_ids[0], "ids": all });
        for (k, v) in extra.as_object().unwrap() {
            q[k] = v.clone();
        }
        q
    };
    // An undeclared writer is `unknown`: the curated and agent takes rank above it; the other
    // page's take is not this page's.
    assert_eq!(
        held(&store, base(json!({}))),
        vec![
            (curated, "operator_curated".into()),
            (agent, "agent_written".into())
        ]
    );
    // An agent write may not touch the curated take.
    assert_eq!(
        held(&store, base(json!({ "writer": "agent_written" }))),
        vec![(curated, "operator_curated".into())]
    );
    assert!(held(&store, base(json!({ "writer": "operator_curated" }))).is_empty());
    // A pending forget on the plain take holds it only with `pending`.
    let proposal: NewProposal = serde_json::from_value(json!({
        "action": "forget", "sourceId": "default",
        "target": { "table": "takes", "id": plain },
        "before": {}, "proposer": "test",
    }))
    .unwrap();
    store.insert_trust_proposal(&proposal).unwrap();
    assert!(held(&store, base(json!({ "writer": "operator_curated" }))).is_empty());
    assert_eq!(
        held(
            &store,
            base(json!({ "writer": "operator_curated", "pending": true }))
        ),
        vec![(plain, "unknown".into())]
    );
}
