//! The CLI import reads (cli_reads/import.rs): what each answers from the store's records.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::import::{
    PageAtRevisionRef, PageTrustKey, PageTrustLookup, RowTrustLookup,
};
use gbrain_store::facts::InsertFactArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::{ListTakesOptions, SupersedeTakeInput, TakeInput, UpdateTakeInput};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::trust::proposals::NewProposal;
use gbrain_store::trust::write_gate::ReceiptInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str, config: Value) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            config: config.as_object().cloned(),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, frontmatter: Value) -> Value {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.to_uppercase(),
        compiled_truth: format!("body of {slug}"),
        frontmatter: frontmatter.as_object().cloned(),
        ..PageInput::default()
    };
    let options = PutPageOptions {
        source_id: Some(source_id.into()),
        ..PutPageOptions::default()
    };
    store.put_page(slug, &input, &options).unwrap()
}

#[test]
fn source_records_list_default_first_with_archived_and_no_commit_columns() {
    let dir = TempDir::new("cli-reads-sources");
    let store = open(&dir);
    source(&store, "zeta", json!({ "keep": 1 }));
    source(&store, "alpha", json!({}));
    store.set_source_archived("zeta", true).unwrap();
    let rows = store.list_source_records().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["default", "alpha", "zeta"]);
    let zeta = &rows[2];
    assert!(zeta.archived);
    assert_eq!(zeta.last_commit, None);
    assert_eq!(zeta.newest_content_at, None);
    assert_eq!(Value::Object(zeta.config.clone()), json!({ "keep": 1 }));

    let found = store.read_source_incarnation("alpha").unwrap().unwrap();
    assert_eq!(found.incarnation.len(), 36);
    assert!(store.read_source_incarnation("nope").unwrap().is_none());
    assert!(!store.has_company_brain_receipt("alpha").unwrap());
}

#[test]
fn a_guest_source_is_one_whose_config_says_guest() {
    let dir = TempDir::new("cli-reads-guests");
    let store = open(&dir);
    assert!(!store.has_guest_source().unwrap());
    source(&store, "visitors", json!({ "guest": true }));
    source(&store, "texty", json!({ "guest": "true" }));
    source(&store, "plain", json!({ "guest": false }));
    assert!(store.has_guest_source().unwrap());
    let ids = ["plain", "visitors", "texty", "visitors", "missing"].map(String::from);
    assert_eq!(
        store.list_guest_source_ids(&ids).unwrap(),
        ["texty", "visitors"]
    );
    assert!(store.list_guest_source_ids(&[]).unwrap().is_empty());
    let row = store.read_guest_source_row("visitors").unwrap();
    assert!(!row.hidden);
    assert_eq!(row.source_id, None);
}

#[test]
fn page_reads_answer_trust_metadata_and_revisions() {
    let dir = TempDir::new("cli-reads-pages");
    let store = open(&dir);
    source(&store, "visitors", json!({ "guest": true }));
    let a = page(&store, "default", "a", json!({ "aliases": ["Alpha"] }));
    let b = page(&store, "visitors", "b", json!({}));
    page(&store, "default", "gone", json!({}));
    store.soft_delete_page("gone", Some("default")).unwrap();

    let trust = store
        .read_page_trust_rows(&PageTrustLookup {
            ids: vec![a["id"].as_u64().unwrap()],
            keys: vec![
                PageTrustKey {
                    source_id: "visitors".into(),
                    slug: "b".into(),
                },
                PageTrustKey {
                    source_id: "default".into(),
                    slug: "gone".into(),
                },
            ],
            include_deleted: false,
        })
        .unwrap();
    assert_eq!(trust.len(), 2);
    assert!(trust[0].by_id && !trust[0].guest && trust[0].trust_tier == "unknown");
    assert!(!trust[1].by_id && trust[1].guest && trust[1].slug == "b");
    let with_deleted = store
        .read_page_trust_rows(&PageTrustLookup {
            keys: vec![PageTrustKey {
                source_id: "default".into(),
                slug: "gone".into(),
            }],
            include_deleted: true,
            ..PageTrustLookup::default()
        })
        .unwrap();
    assert_eq!(with_deleted.len(), 1);

    let all = store.list_link_page_metadata(None).unwrap();
    let keys: Vec<(&str, &str)> = all
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str()))
        .collect();
    assert_eq!(keys, [("default", "a"), ("visitors", "b")]);
    assert_eq!(all[0].aliases, json!(["Alpha"]));
    assert_eq!(all[1].aliases, Value::Null);
    assert_eq!(
        store
            .list_link_page_metadata(Some("visitors"))
            .unwrap()
            .len(),
        1
    );

    let revision = b["knowledge_revision"].as_str().unwrap().to_string();
    let at = store
        .filter_pages_at_revision(&[
            PageAtRevisionRef {
                source_id: "visitors".into(),
                slug: "b".into(),
                revision,
            },
            PageAtRevisionRef {
                source_id: "default".into(),
                slug: "a".into(),
                revision: "stale".into(),
            },
        ])
        .unwrap();
    assert_eq!(at.len(), 1);
    assert_eq!(at[0].slug, "b");
}

#[test]
fn stored_timeline_rows_are_the_page_rows_by_id_and_the_clock_is_iso() {
    let dir = TempDir::new("cli-reads-timeline");
    let store = open(&dir);
    page(&store, "default", "a", json!({}));
    for (date, summary) in [("2026-02-01", "second"), ("2026-01-01", "first")] {
        let entry = TimelineInput {
            date: Some(date.into()),
            summary: Some(summary.into()),
            ..TimelineInput::default()
        };
        store
            .add_timeline_entry("a", &entry, &AddTimelineOptions::default())
            .unwrap();
    }
    let rows = store.list_stored_timeline_rows("default", "a").unwrap();
    let summaries: Vec<&str> = rows.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(summaries, ["second", "first"]);
    assert!(rows[0].id < rows[1].id);
    assert!(
        store
            .list_stored_timeline_rows("default", "missing")
            .unwrap()
            .is_empty()
    );

    let clock = store.read_database_clock().unwrap();
    assert_eq!(clock.len(), "2026-01-01T00:00:00.000000Z".len());
    assert!(clock.ends_with('Z'));
}

fn declare(store: &Store, tier: &str, origin: &str) {
    let names = ["gbrain.write_trust_tier", "gbrain.write_origin"].map(String::from);
    store
        .apply_write_trust(&names, &[tier.to_string(), origin.to_string()])
        .unwrap();
}

fn stamped(store: &Store, slug: &str) -> (String, Option<Value>) {
    let rows = store
        .read_page_trust_rows(&PageTrustLookup {
            keys: vec![PageTrustKey {
                source_id: "default".into(),
                slug: slug.into(),
            }],
            include_deleted: true,
            ..PageTrustLookup::default()
        })
        .unwrap();
    (rows[0].trust_tier.clone(), rows[0].write_origin.clone())
}

#[test]
fn a_page_write_stamps_the_tier_and_origin_of_the_write_trust_context() {
    let dir = TempDir::new("cli-reads-page-trust");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    declare(&tx, "operator_curated", r#"{"channel":"import"}"#);
    page(&tx, "default", "curated", json!({}));
    let curated = (
        "operator_curated".to_string(),
        Some(json!({ "channel": "import" })),
    );
    assert_eq!(stamped(&tx, "curated"), curated);

    // A rewrite of only a trust-ephemeral frontmatter key is no content change.
    declare(&tx, "agent_written", r#"{"channel":"agent"}"#);
    page(
        &tx,
        "default",
        "curated",
        json!({ "captured_at": "2026-01-01" }),
    );
    assert_eq!(stamped(&tx, "curated"), curated);
    // A content change by a lower writer lowers the tier and takes its origin.
    page(&tx, "default", "curated", json!({ "kind": "rewritten" }));
    let agent = (
        "agent_written".to_string(),
        Some(json!({ "channel": "agent" })),
    );
    assert_eq!(stamped(&tx, "curated"), agent);
    // A change to the body alone is a content change.
    declare(&tx, "operator_curated", r#"{"channel":"body"}"#);
    let body_only = PageInput {
        page_type: "note".into(),
        title: "CURATED".into(),
        compiled_truth: "a new body".into(),
        frontmatter: json!({ "kind": "rewritten" }).as_object().cloned(),
        ..PageInput::default()
    };
    tx.put_page("curated", &body_only, &PutPageOptions::default())
        .unwrap();
    assert_eq!(
        stamped(&tx, "curated"),
        (
            "operator_curated".to_string(),
            Some(json!({ "channel": "body" })),
        )
    );
    // A soft delete is a content change.
    declare(&tx, "operator_curated", r#"{"channel":"owner"}"#);
    tx.soft_delete_page("curated", Some("default")).unwrap();
    let owner = (
        "operator_curated".to_string(),
        Some(json!({ "channel": "owner" })),
    );
    assert_eq!(stamped(&tx, "curated"), owner);

    // A writer above operator_curated needs a covering promotion.
    declare(&tx, "user_confirmed", r#"{"channel":"claim"}"#);
    let input = PageInput {
        page_type: "note".into(),
        title: "RAISED".into(),
        compiled_truth: "body".into(),
        ..PageInput::default()
    };
    let refused = tx
        .put_page("raised", &input, &PutPageOptions::default())
        .unwrap_err();
    assert_eq!(refused.code, "trust_raise_refused");
    tx.commit_transaction().unwrap();

    // The context ends with the transaction: an undeclared rewrite stamps unknown and NULL.
    page(&store, "default", "plain", json!({}));
    assert_eq!(stamped(&store, "plain"), ("unknown".to_string(), None));
    assert_eq!(stamped(&store, "curated"), owner);
}

fn takes(store: &Store, rows: Value) {
    let rows: Vec<TakeInput> = serde_json::from_value(rows).unwrap();
    store.add_takes_batch(&rows).unwrap();
}

fn take_ids(store: &Store, page_id: u64) -> Vec<u64> {
    let options: ListTakesOptions =
        serde_json::from_value(json!({ "page_id": page_id, "limit": 50 })).unwrap();
    let mut rows = store.list_takes(&options).unwrap();
    rows.sort_by_key(|r| r["row_num"].as_i64());
    rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
}

fn row_trust(
    store: &Store,
    table: &str,
    ids: &[u64],
) -> Vec<(String, Value, bool, Option<String>)> {
    store
        .read_row_trust_rows(&RowTrustLookup {
            table: table.into(),
            ids: ids.to_vec(),
        })
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.trust_tier,
                r.write_origin.unwrap_or(Value::Null),
                r.flagged,
                r.contested,
            )
        })
        .collect()
}

fn take(page: u64, row: i32, claim: &str, weight: f64) -> Value {
    json!({ "page_id": page, "row_num": row, "claim": claim, "kind": "take", "holder": "h",
            "weight": weight, "active": true })
}

#[test]
fn take_writes_stamp_trust_and_fact_and_take_rows_read_it_with_contested_refs() {
    let dir = TempDir::new("cli-reads-row-trust");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    declare(&tx, "operator_curated", r#"{"channel":"import"}"#);
    let page_id = page(&tx, "default", "p", json!({}))["id"].as_u64().unwrap();
    takes(
        &tx,
        json!([take(page_id, 1, "a", 0.5), take(page_id, 2, "b", 0.5)]),
    );
    let curated = (
        "operator_curated".to_string(),
        json!({ "channel": "import" }),
    );
    let agent = ("agent_written".to_string(), json!({ "channel": "agent" }));

    declare(&tx, "agent_written", r#"{"channel":"agent"}"#);
    // A claim rewrite lowers the tier; a weight-only rewrite and updateTake keep it.
    takes(
        &tx,
        json!([take(page_id, 1, "a2", 0.5), take(page_id, 2, "b", 0.9)]),
    );
    let update: UpdateTakeInput =
        serde_json::from_value(json!({ "page_id": page_id, "row_num": 2, "weight": 0.7 })).unwrap();
    assert!(tx.update_take(&update).unwrap());
    // supersedeTake inserts the new row under the write's tier and keeps the old row's.
    let supersede: SupersedeTakeInput = serde_json::from_value(json!({
        "page_id": page_id, "old_row": 2, "claim": "b2", "kind": "take", "holder": "h",
        "weight": 0.5, "active": true,
    }))
    .unwrap();
    assert_eq!(tx.supersede_take(&supersede).unwrap()["status"], "ok");
    // An undeclared insert reads unknown with no origin.
    tx.clear_write_trust();
    takes(&tx, json!([take(page_id, 4, "d", 0.5)]));

    let ids = take_ids(&tx, page_id);
    assert_eq!(ids.len(), 4);
    let proposal: NewProposal = serde_json::from_value(json!({
        "action": "supersede_take", "sourceId": "default",
        "target": { "table": "takes", "id": ids[1] },
        "related": { "table": "takes", "id": ids[2] },
        "before": {}, "proposer": "test",
    }))
    .unwrap();
    let tp = tx.insert_trust_proposal(&proposal).unwrap()["id"]
        .as_u64()
        .unwrap();
    let rows = row_trust(&tx, "takes", &[ids[3], ids[0], ids[2], ids[1], 999_999]);
    let row = |t: &(String, Value), contested: Option<String>| {
        (t.0.clone(), t.1.clone(), false, contested)
    };
    assert_eq!(
        rows,
        [
            row(&agent, None),
            row(&curated, Some(format!("tp{tp}:challenged"))),
            row(&agent, Some(format!("tp{tp}:challenger"))),
            row(&("unknown".to_string(), Value::Null), None),
        ]
    );

    // Facts read the tier their insert stamped and the same contested reference.
    declare(&tx, "operator_curated", r#"{"channel":"import"}"#);
    let fact = |text: &str| {
        let args: InsertFactArgs = serde_json::from_value(
            json!({ "input": { "fact": text, "source": "s" }, "sourceId": "default" }),
        )
        .unwrap();
        tx.insert_fact(&args).unwrap()["id"].as_u64().unwrap()
    };
    let (f1, f2) = (fact("one"), fact("two"));
    let proposal: NewProposal = serde_json::from_value(json!({
        "action": "supersede_fact", "sourceId": "default",
        "target": { "table": "facts", "id": f1 }, "related": { "table": "facts", "id": f2 },
        "before": {}, "proposer": "test",
    }))
    .unwrap();
    let fp = tx.insert_trust_proposal(&proposal).unwrap()["id"]
        .as_u64()
        .unwrap();
    assert_eq!(
        row_trust(&tx, "facts", &[f2, f1]),
        [
            row(&curated, Some(format!("tp{fp}:challenged"))),
            row(&curated, Some(format!("tp{fp}:challenger"))),
        ]
    );
    // A decided proposal no longer contests its rows, and a pending proposal of another action
    // never does.
    assert!(
        tx.transition_trust_proposal(fp as i64, "pending", "rejected", None, None)
            .unwrap()
    );
    let forget: NewProposal = serde_json::from_value(json!({
        "action": "forget", "sourceId": "default",
        "target": { "table": "facts", "id": f1 }, "before": {}, "proposer": "test",
    }))
    .unwrap();
    tx.insert_trust_proposal(&forget).unwrap();
    // An agent-written fact with an instruction-family flag receipt reads flagged.
    declare(&tx, "agent_written", r#"{"channel":"agent"}"#);
    let f3 = fact("three");
    tx.upsert_write_gate_receipt(ReceiptInput {
        target_table: "facts".into(),
        target_id: f3.to_string(),
        source_id: Some("default".into()),
        content_hash: "h".into(),
        tier: "agent_written".into(),
        detector_version: 1,
        verdict: "flag".into(),
        reason_families: vec!["override".into()],
        reasons: vec!["a reason".into()],
        detector_error: false,
        request_id: None,
    })
    .unwrap();
    assert_eq!(
        row_trust(&tx, "facts", &[f1, f2, f3]),
        [
            row(&curated, None),
            row(&curated, None),
            (agent.0.clone(), agent.1.clone(), true, None),
        ]
    );
    assert!(row_trust(&tx, "facts", &[]).is_empty());
    let refused = tx
        .read_row_trust_rows(&RowTrustLookup {
            table: "pages".into(),
            ids: vec![1],
        })
        .unwrap_err();
    assert!(refused.message.contains("unknown table"));
}

#[test]
fn link_page_metadata_for_slugs_reads_the_named_live_pages_of_one_source_by_slug() {
    let dir = TempDir::new("link-metadata-for-slugs");
    let store = open(&dir);
    source(&store, "work", json!({}));
    for (slug, src) in [
        ("b", "default"),
        ("a", "default"),
        ("gone", "default"),
        ("b", "work"),
    ] {
        page(&store, src, slug, json!({"aliases": ["Bee"]}));
    }
    store.soft_delete_page("gone", None).unwrap();
    let slugs: Vec<String> = ["b", "a", "gone", "missing", "a"]
        .map(String::from)
        .to_vec();
    let rows = store
        .read_link_page_metadata_for_slugs("default", &slugs)
        .unwrap();
    let keys: Vec<(&str, &str)> = rows
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str()))
        .collect();
    assert_eq!(keys, [("default", "a"), ("default", "b")]);
    assert_eq!(rows[1].aliases, json!(["Bee"]));
    assert!(
        store
            .read_link_page_metadata_for_slugs("default", &[])
            .unwrap()
            .is_empty()
    );
}
