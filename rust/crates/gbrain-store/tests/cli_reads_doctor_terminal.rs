//! The doctor terminal write failure reads (`cli_reads/doctor_terminal.rs`): the PGLite semantics of the aggregate and
//! of the drill-down batch, over receipts written through the journal members.

use gbrain_store::cli_reads::doctor_terminal::{TerminalBatchQuery, TerminalGroupsQuery};
use gbrain_store::env::uuid_from_bytes;
use gbrain_store::persistence::{WriteCompletion, WriteRequestInsert};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const START: i64 = 1_800_000_000_000_000;
const DAY: i64 = 86_400_000_000;
const SECOND: i64 = 1_000_000;

struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain(name: &str) -> (Store, Arc<Clock>) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-terminal-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let clock = Arc::new(Clock {
        now: AtomicI64::new(START),
        ids: AtomicU64::new(1),
    });
    let store = Store::open_kv(kv, clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn rules() -> Value {
    json!({
        "syncKnockOnOrigin": "sync_knock_on",
        "legacyCancelMessages": ["An earlier page of the same sync did not commit; re-frozen."],
        "legacyCancelPatterns": ["Its predecessor request % was never admitted; re-frozen."],
        "earlierPageRefusal": "An earlier page of this sync did not commit.",
        "syncPassSuperseded": "sync_pass_superseded",
        "legacyPublicationPrefix": "Publication failed (P0001)",
        "grandfatherRetired": "grandfather_retired",
        "fixedKnockOn": "0.60.216.0",
        "fixedFenceUnrenderable": "0.60.218.0",
        "connectorKinds": ["connector_v2_import", "connector_v2_delete", "connector_v2_checkpoint"],
        "pageRemovalOperations": ["delete_page", "purge_page"],
        "connectorLineageMaxDepth": 32,
    })
}

fn groups_query(sources: Option<Vec<&str>>) -> TerminalGroupsQuery {
    serde_json::from_value(json!({
        "spanDays": 8, "windowDays": 7, "sourceIds": sources, "rules": rules(),
    }))
    .unwrap()
}

fn batch_query(source: &str, before: Option<&str>, limit: i64) -> TerminalBatchQuery {
    serde_json::from_value(json!({
        "sourceId": source, "windowDays": 7, "before": before, "limit": limit, "rules": rules(),
    }))
    .unwrap()
}

fn source(s: &Store, id: &str) {
    let input: SourceInput = serde_json::from_value(json!({ "id": id })).unwrap();
    s.upsert_source(&input).unwrap();
}

fn incarnation(s: &Store, source_id: &str) -> String {
    s.read_source_membership(source_id).unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

struct Seed {
    n: u32,
}

impl Seed {
    fn request_id(&self) -> String {
        format!("b0000000-0000-4000-8000-{:012x}", self.n)
    }

    /// Admits a request and returns its row id and request id.
    #[allow(clippy::too_many_arguments)]
    fn admit(
        &mut self,
        s: &Store,
        source_id: &str,
        slug: &str,
        operation: &str,
        digest: &str,
        intent: Value,
        build: &str,
    ) -> (String, String) {
        self.n += 1;
        let request = self.request_id();
        let input: WriteRequestInsert = serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "w", "requestId": request,
            "operation": operation, "sourceId": source_id,
            "sourceIncarnation": incarnation(s, source_id), "pageId": null, "slug": slug,
            "worktreeId": null, "topologyGeneration": null, "digest": digest, "intent": intent,
            "authority": {}, "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page",
            "protocolVersion": 1, "admitterVersion": build, "admitterHostId": null,
            "counterKeys": [], "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
        }))
        .unwrap();
        let row = s.insert_write_request(&input).unwrap();
        (row["id"].as_str().unwrap().to_string(), request)
    }

    fn end(
        &self,
        s: &Store,
        id: &str,
        state: &str,
        code: Option<&str>,
        message: Option<&str>,
        detail: Value,
    ) {
        let done: WriteCompletion = serde_json::from_value(json!({
            "id": id, "state": state, "outcome": null, "errorCode": code, "errorMessage": message,
            "consumerVersion": "0.60.300.0", "consumerHostId": null, "errorDetail": detail,
            "resultBytes": 0, "counterKeys": [], "intentBytes": 10, "retainedBytes": 4096,
            "terminalReservation": 4096, "probePurges": false,
        }))
        .unwrap();
        s.complete_write_row(&done).unwrap().unwrap();
    }
}

fn group<'a>(rows: &'a [Value], source_id: &str, pick: impl Fn(&Value) -> bool) -> &'a Value {
    rows.iter()
        .find(|r| r["source_id"] == source_id && r["set"] == 0 && pick(r))
        .expect("the group")
}

fn total<'a>(rows: &'a [Value], source_id: &str) -> &'a Value {
    rows.iter()
        .find(|r| r["source_id"] == source_id && r["set"] == 1)
        .expect("the total row")
}

#[test]
fn an_empty_journal_has_no_group_and_no_batch() {
    let (s, _) = brain("empty");
    assert!(
        s.read_terminal_failure_groups(&groups_query(None))
            .unwrap()
            .is_empty()
    );
    assert!(
        s.list_terminal_failure_batch(&batch_query("default", None, 10))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn groups_carry_the_classification_columns_and_a_total_row_per_source() {
    let (s, clock) = brain("groups");
    let mut seed = Seed { n: 0 };
    let put = json!({ "kind": "managed_sync_import" });
    // A knock-on by its typed marker, an old-build knock-on, a connection loss and a legacy publication refusal.
    let (a, _) = seed.admit(
        &s,
        "default",
        "notes/a",
        "put_page",
        "da",
        put.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &a,
        "cancelled",
        Some("cancelled"),
        Some("m"),
        json!({ "origin": "sync_knock_on" }),
    );
    let (b, _) = seed.admit(
        &s,
        "default",
        "notes/b",
        "put_page",
        "db",
        put.clone(),
        "0.60.100.0",
    );
    seed.end(
        &s,
        &b,
        "failed",
        Some("revision_conflict"),
        Some("An earlier page of this sync did not commit."),
        Value::Null,
    );
    let (c, _) = seed.admit(
        &s,
        "default",
        "notes/c",
        "submit_job",
        "dc",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &c,
        "failed",
        Some("storage_error"),
        Some("read ECONNRESET"),
        Value::Null,
    );
    let (d, _) = seed.admit(
        &s,
        "default",
        "notes/d",
        "delete_page",
        "dd",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &d,
        "failed",
        Some("storage_error"),
        Some("Publication failed (P0001): guard"),
        Value::Null,
    );
    clock.now.fetch_add(10 * SECOND, Ordering::SeqCst);

    let rows = s.read_terminal_failure_groups(&groups_query(None)).unwrap();
    assert_eq!(rows.len(), 5, "four groups and the total");
    let knock = group(&rows, "default", |r| {
        r["slug"].is_null() && r["knock_on"] == true && r["build"] == "0.60.300.0"
    });
    assert_eq!(knock["state"], "cancelled");
    assert_eq!(knock["origin"], "sync_knock_on");
    assert_eq!(knock["rows"], 1);
    assert_eq!(knock["n_24h"], 1);
    assert_eq!(knock["distinct_slugs"], 1);
    assert_eq!(knock["oldest_age"], 10);
    let old_knock = group(&rows, "default", |r| r["build"] == "0.60.100.0");
    assert_eq!(old_knock["knock_on"], true);
    assert_eq!(
        old_knock["distinct_slugs"], 0,
        "a build older than the fix is history"
    );
    let lost = group(&rows, "default", |r| {
        r["routed_message"] == "connection closed"
    });
    assert_eq!(lost["knock_on"], false);
    assert_eq!(lost["distinct_intents"], 1);
    let legacy = group(&rows, "default", |r| {
        r["routed_message"] == "Publication failed (P0001)"
    });
    assert_eq!(
        legacy["distinct_slugs"], 0,
        "an unclassified publication refusal is history"
    );
    let all = total(&rows, "default");
    assert_eq!(all["rows"], 4);
    assert_eq!(
        all["distinct_slugs"], 2,
        "the typed knock-on and the connection loss"
    );
    assert_eq!(all["state"], Value::Null);
    assert_eq!(all["d2"], 0);
}

#[test]
fn a_later_request_resolves_a_failed_one_and_a_pass_checkpoint_resolves_itself() {
    let (s, _) = brain("resolved");
    let mut seed = Seed { n: 0 };
    let none = json!({});
    // Same digest committed later; removal later; later put_page for a put_page; a failed caller put_page; nothing later.
    let (a, _) = seed.admit(
        &s,
        "default",
        "notes/same",
        "put_page",
        "ds",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &a,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    let (b, _) = seed.admit(
        &s,
        "default",
        "notes/same",
        "put_page",
        "ds",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(&s, &b, "committed", None, None, Value::Null);
    let (c, _) = seed.admit(
        &s,
        "default",
        "notes/gone",
        "add_timeline_entry",
        "d1",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &c,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    let (d, _) = seed.admit(
        &s,
        "default",
        "notes/gone",
        "delete_page",
        "d2",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(&s, &d, "committed", None, None, Value::Null);
    let (e, _) = seed.admit(
        &s,
        "default",
        "notes/later",
        "put_page",
        "d3",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &e,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    let (f, _) = seed.admit(
        &s,
        "default",
        "notes/later",
        "put_page",
        "d4",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &f,
        "failed",
        Some("storage_error"),
        Some("y"),
        Value::Null,
    );
    let (g, _) = seed.admit(
        &s,
        "default",
        "notes/open",
        "add_timeline_entry",
        "d5",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &g,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    let (h, _) = seed.admit(
        &s,
        "default",
        "notes/pass",
        "submit_job",
        "d6",
        none.clone(),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &h,
        "cancelled",
        Some("sync_pass_superseded"),
        None,
        Value::Null,
    );

    let rows = s.read_terminal_failure_groups(&groups_query(None)).unwrap();
    let groups: Vec<&Value> = rows.iter().filter(|r| r["set"] == 0).collect();
    let resolved: i64 = groups
        .iter()
        .filter(|r| r["resolved"] == true)
        .map(|r| r["rows"].as_i64().unwrap())
        .sum();
    let open: i64 = groups
        .iter()
        .filter(|r| r["resolved"] == false)
        .map(|r| r["rows"].as_i64().unwrap())
        .sum();
    // notes/same#a, notes/gone#c, notes/later#e (a later failed caller put_page) and the pass checkpoint resolve.
    assert_eq!(resolved, 4);
    // notes/later#f (the latest), notes/open#g.
    assert_eq!(open, 2);
    assert_eq!(total(&rows, "default")["distinct_slugs"], 2);

    let batch = s
        .list_terminal_failure_batch(&batch_query("default", None, 20))
        .unwrap();
    let by_slug = |slug: &str| {
        batch
            .iter()
            .find(|r| r["slug"] == slug && r["state"] != "committed")
            .unwrap()
    };
    assert_eq!(by_slug("notes/same")["later_state"], "committed");
    assert_eq!(by_slug("notes/same")["same_intent"], true);
    assert_eq!(by_slug("notes/gone")["later_state"], "committed");
    assert_eq!(by_slug("notes/gone")["same_intent"], false);
    assert_eq!(by_slug("notes/open")["later_state"], Value::Null);
}

#[test]
fn the_batch_runs_newest_first_with_a_cursor_and_a_limit_and_skips_other_sources() {
    let (s, _) = brain("batch");
    source(&s, "other");
    let mut seed = Seed { n: 0 };
    for (i, slug) in ["notes/a", "notes/b", "notes/c"].iter().enumerate() {
        let (id, _) = seed.admit(
            &s,
            "default",
            slug,
            "add_timeline_entry",
            &format!("d{i}"),
            json!({}),
            "0.60.300.0",
        );
        seed.end(
            &s,
            &id,
            "failed",
            Some("storage_error"),
            Some("x"),
            json!({ "reason": "why", "cause": "c" }),
        );
    }
    let (o, _) = seed.admit(
        &s,
        "other",
        "notes/o",
        "add_timeline_entry",
        "do",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &o,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );

    let all = s
        .list_terminal_failure_batch(&batch_query("default", None, 10))
        .unwrap();
    let slugs: Vec<&str> = all.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["notes/c", "notes/b", "notes/a"]);
    assert_eq!(all[0]["reason"], "why");
    assert_eq!(all[0]["cause"], "c");
    assert_eq!(
        all[0]["error_detail"],
        json!({ "reason": "why", "cause": "c" })
    );
    assert_eq!(all[0]["ended_at"].as_str().unwrap().len(), 20);
    let first = s
        .list_terminal_failure_batch(&batch_query("default", None, 2))
        .unwrap();
    assert_eq!(first.len(), 2);
    let cursor = first[1]["sequence"].as_str().unwrap();
    let rest = s
        .list_terminal_failure_batch(&batch_query("default", Some(cursor), 2))
        .unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0]["slug"], "notes/a");
    assert!(
        s.list_terminal_failure_batch(&batch_query("default", Some("nope"), 2))
            .is_err()
    );
}

#[test]
fn receipts_outside_the_window_and_archived_sources_are_not_read() {
    let (s, clock) = brain("window");
    source(&s, "gone");
    let mut seed = Seed { n: 0 };
    let (a, _) = seed.admit(
        &s,
        "default",
        "notes/old",
        "add_timeline_entry",
        "d1",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &a,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    let (b, _) = seed.admit(
        &s,
        "gone",
        "notes/b",
        "add_timeline_entry",
        "d2",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &b,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    s.set_source_archived("gone", true).unwrap();
    clock.now.fetch_add(9 * DAY, Ordering::SeqCst);
    let (c, _) = seed.admit(
        &s,
        "default",
        "notes/new",
        "add_timeline_entry",
        "d3",
        json!({}),
        "0.60.300.0",
    );
    seed.end(
        &s,
        &c,
        "failed",
        Some("storage_error"),
        Some("x"),
        Value::Null,
    );
    clock.now.fetch_add(DAY / 2, Ordering::SeqCst);

    let rows = s.read_terminal_failure_groups(&groups_query(None)).unwrap();
    assert!(
        rows.iter().all(|r| r["source_id"] == "default"),
        "archived sources are skipped"
    );
    assert_eq!(
        total(&rows, "default")["rows"],
        1,
        "only the receipt inside the window"
    );
    let scoped = s
        .read_terminal_failure_groups(&groups_query(Some(vec!["nope"])))
        .unwrap();
    assert!(scoped.is_empty());
    let batch = s
        .list_terminal_failure_batch(&batch_query("default", None, 10))
        .unwrap();
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0]["slug"], "notes/new");
}

#[test]
fn daily_counts_bucket_the_days_before_the_last_one() {
    let (s, clock) = brain("days");
    let mut seed = Seed { n: 0 };
    for i in 0..5 {
        let (id, _) = seed.admit(
            &s,
            "default",
            &format!("notes/{i}"),
            "add_timeline_entry",
            &format!("d{i}"),
            json!({}),
            "0.60.300.0",
        );
        seed.end(
            &s,
            &id,
            "failed",
            Some("storage_error"),
            Some("x"),
            Value::Null,
        );
    }
    // All five ended at START: read half a day after, then a day and a half after.
    clock.now.fetch_add(DAY / 2, Ordering::SeqCst);
    let rows = s.read_terminal_failure_groups(&groups_query(None)).unwrap();
    assert_eq!(total(&rows, "default")["n_24h"], 5);
    clock.now.fetch_add(DAY, Ordering::SeqCst);
    let rows = s.read_terminal_failure_groups(&groups_query(None)).unwrap();
    let all = total(&rows, "default");
    assert_eq!(all["n_24h"], 0);
    assert_eq!(all["d2"], 5, "ended one to two days ago");
    assert_eq!(all["d3"], 0);
}
