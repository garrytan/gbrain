//! The persistence doctor's checkpoint reads (`persistence/diagnostic_checkpoints.rs`): the
//! derived-origin parks whose page is a tombstone and the failed requests blocked managed-sync
//! cursors wait on, each with the statement's filters and its byte order.

use gbrain_store::env::{Env, uuid_from_bytes};
use gbrain_store::kv::Kv;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{ClaimStamp, WriteCompletion, WriteRequestInsert};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const START: i64 = 1_800_000_000_000_000;

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
        "diag-ckp-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let clock = Arc::new(Clock {
        now: AtomicI64::new(START),
        ids: AtomicU64::new(1),
    });
    let store = Store::open_kv(kv, clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn page(s: &Store, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    s.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn derived_origin_parks_list_tombstoned_pages_oldest_first_ties_by_fingerprint_bytes() {
    let (s, clock) = brain("parks");
    let ids: Vec<u64> = (0..4).map(|i| page(&s, &format!("collate/{i}"))).collect();
    let live = page(&s, "collate/live");
    for i in 0..4 {
        s.soft_delete_page(&format!("collate/{i}"), Some("default"))
            .unwrap();
    }
    // One batch, one timestamp: the fingerprint breaks the tie. The padded text of a page id and the
    // id of a live page name no tombstone.
    let mut rows: Vec<(String, Value)> = ids[1..]
        .iter()
        .rev()
        .map(|id| (id.to_string(), json!({ "page_id": id })))
        .collect();
    rows.push((format!("0{}", ids[1]), json!({ "page_id": "padded" })));
    rows.push((live.to_string(), json!({ "page_id": live })));
    s.write_op_checkpoint_records("derived-origin-park", &rows)
        .unwrap();
    // A later park comes after them even though its fingerprint sorts first.
    clock.now.store(START + 10, Ordering::SeqCst);
    s.write_op_checkpoint_records(
        "derived-origin-park",
        &[(ids[0].to_string(), json!({ "page_id": ids[0] }))],
    )
    .unwrap();
    let mut expected: Vec<String> = ids[1..].iter().map(u64::to_string).collect();
    expected.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    expected.push(ids[0].to_string());
    assert!(ids[0].to_string().as_bytes() < expected[0].as_bytes());
    let got: Vec<String> = s
        .list_derived_origin_parks("derived-origin-park")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["park"]["page_id"].to_string())
        .collect();
    assert_eq!(got, expected);
    assert!(
        s.list_derived_origin_parks("other-op")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

fn request(s: &Store, source: &str, n: u64, state: &str) -> String {
    let incarnation = s.read_source_membership(source).unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let request_id = format!("b0000000-0000-4000-8000-{n:012}");
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "w", "requestId": request_id,
        "operation": "put_page", "sourceId": source, "sourceIncarnation": incarnation, "pageId": null,
        "slug": "notes/a", "worktreeId": null, "topologyGeneration": null, "digest": format!("d{n}"), "intent": {},
        "authority": {}, "intentBytes": 0, "terminalReservation": 0, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "admitterHostId": null, "counterKeys": [],
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    let id = s.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    s.stamp_write_claim(&ClaimStamp {
        fence: None,
        id: id.clone(),
        token: "c0000000-0000-4000-8000-0000000000c1".into(),
        lease_ms: 60_000.0,
        phase_json: None,
    })
    .unwrap()
    .unwrap();
    let done: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": state, "outcome": null, "errorCode": if state == "committed" { Value::Null } else { json!("invalid_frontmatter") },
        "errorMessage": if state == "committed" { Value::Null } else { json!(format!("refused {n}")) },
        "consumerVersion": "v", "consumerHostId": null, "errorDetail": null, "resultBytes": 0,
        "counterKeys": [], "intentBytes": 0, "retainedBytes": 0, "terminalReservation": 0, "probePurges": false,
    }))
    .unwrap();
    s.complete_write_row(&done).unwrap().unwrap();
    request_id
}

#[test]
fn content_blocked_receipts_name_the_failed_pending_request_of_each_unfinished_cursor_by_source_bytes()
 {
    let (s, _) = brain("blocked");
    for id in ["ac", "a-z", "ab", "done", "ok"] {
        s.upsert_source(&SourceInput {
            id: id.into(),
            ..Default::default()
        })
        .unwrap();
    }
    let mut n = 0;
    let mut cursor = |source: &str, state: &str, done: bool| {
        n += 1;
        let request_id = request(&s, source, n, state);
        s.write_op_checkpoint_record(
            "managed-sync",
            source,
            Some(&json!([{ "sourceId": source, "pending": { "requestId": request_id }, "done": done }])),
        )
        .unwrap();
    };
    cursor("ac", "failed", false);
    cursor("a-z", "conflict", false);
    cursor("ab", "cancelled", false);
    // A finished cursor and one waiting on a committed request block nothing.
    cursor("done", "failed", true);
    cursor("ok", "committed", false);
    let rows = s.list_content_blocked_receipts().unwrap();
    let got: Vec<(String, String)> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().to_string(),
                r["error_message"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("a-z".to_string(), "refused 2".to_string()),
            ("ab".to_string(), "refused 3".to_string()),
            ("ac".to_string(), "refused 1".to_string()),
        ]
    );
    assert_eq!(rows[0]["error_code"], "invalid_frontmatter");
}

fn source(s: &Store, id: &str) -> String {
    s.upsert_source(&SourceInput {
        id: id.into(),
        ..Default::default()
    })
    .unwrap();
    s.read_source_membership(id).unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn page_in(
    s: &Store,
    source: &str,
    slug: &str,
    kind: &str,
    title: &str,
    frontmatter: Value,
) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": kind, "title": title, "compiled_truth": "x", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    s.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn noncanonical_holds_count_one_code_of_live_sources_at_their_incarnation() {
    let (s, _) = brain("noncanonical");
    let ab = source(&s, "ab");
    let cd = source(&s, "cd");
    let hold = |fp: &str, src: &str, inc: &str, code: &str| {
        s.write_op_checkpoint_record(
            "git-hold",
            fp,
            Some(&json!([{ "source_id": src, "incarnation": inc, "code": code, "path": fp }])),
        )
        .unwrap();
    };
    hold("a", "ab", &ab, "readers_noncanonical");
    hold("b", "ab", &ab, "readers_noncanonical");
    hold("c", "ab", "stale-incarnation", "readers_noncanonical");
    hold("d", "cd", &cd, "readers_noncanonical");
    hold("e", "ab", &ab, "visibility_noncanonical");
    hold("f", "gone", &ab, "readers_noncanonical");
    let count = |code: &str, ids: Option<&[String]>| {
        s.count_noncanonical_holds("git-hold", code, ids).unwrap()
    };
    assert_eq!(count("readers_noncanonical", None), 3);
    assert_eq!(count("readers_noncanonical", Some(&["ab".to_string()])), 2);
    assert_eq!(count("visibility_noncanonical", None), 1);
    assert_eq!(count("readers_noncanonical", Some(&[])), 0);
}

#[test]
fn reader_candidate_pages_name_a_misspelled_readers_key_by_source_and_slug_bytes() {
    let (s, _) = brain("readers");
    source(&s, "a-z");
    source(&s, "ab");
    page_in(
        &s,
        "ab",
        "notes/one",
        "note",
        "one",
        json!({ "Readable-By": ["x"] }),
    );
    page_in(
        &s,
        "a-z",
        "notes/bx",
        "note",
        "two",
        json!({ "readable by": ["x"] }),
    );
    page_in(
        &s,
        "a-z",
        "notes/b-x",
        "note",
        "One",
        json!({ "READABLE_by": ["x"] }),
    );
    // The canonical key and an unrelated key are not candidates.
    page_in(
        &s,
        "ab",
        "notes/ok",
        "note",
        "ok",
        json!({ "readable_by": ["x"] }),
    );
    page_in(
        &s,
        "ab",
        "notes/other",
        "note",
        "other",
        json!({ "readers": ["x"] }),
    );
    let rows = s.list_reader_candidate_pages(None).unwrap();
    let got: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "{}:{}",
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(got, vec!["a-z:notes/b-x", "a-z:notes/bx", "ab:notes/one"]);
    assert_eq!(
        s.list_reader_candidate_pages(Some(&["ab".to_string()]))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn held_hit_rows_stamp_the_hits_in_fingerprint_order_and_count_what_could_affect_the_read() {
    let (s, _) = brain("held-hits");
    let ab = source(&s, "ab");
    let hit = page_in(&s, "ab", "notes/hit", "note", "Hit", json!({}));
    let typed = page_in(&s, "ab", "notes/typed", "meeting", "Typed", json!({}));
    let worded = page_in(
        &s,
        "ab",
        "notes/worded",
        "note",
        "The Alpha plan",
        json!({}),
    );
    let other = page_in(&s, "ab", "notes/other", "note", "Alphabet", json!({}));
    let hold = |fp: &str, page: u64, held_at: &str| {
        s.write_op_checkpoint_record(
            "git-hold",
            fp,
            Some(&json!([{ "source_id": "ab", "incarnation": ab, "page_id": page, "path": format!("{fp}.md"), "held_at": held_at }])),
        )
        .unwrap();
    };
    hold("ab:z", hit, "2021");
    hold("ab:a-z", hit, "2020");
    hold("ab:t", typed, "2022");
    hold("ab:w", worded, "2022");
    hold("ab:o", other, "2022");
    let query: gbrain_store::persistence::HeldHitQuery = serde_json::from_value(json!({
        "holdOp": "git-hold", "pageIds": [hit.to_string()], "sourceIds": ["ab"], "types": ["meeting"],
        "terms": ["alpha"], "cap": 100,
    }))
    .unwrap();
    let rows = s.read_held_hit_rows(&query).unwrap();
    let rows = rows.as_array().unwrap();
    let stamped: Vec<&str> = rows[..rows.len() - 1]
        .iter()
        .map(|r| r["record"]["held_at"].as_str().unwrap())
        .collect();
    assert_eq!(stamped, vec!["2020", "2021"]);
    assert!(rows[0]["revision"].is_string());
    // The two holds of the hit, the meeting page and the whole word `alpha`; `Alphabet` is no match.
    assert_eq!(rows[rows.len() - 1]["could_affect"], 4);
    let capped: gbrain_store::persistence::HeldHitQuery = serde_json::from_value(json!({
        "holdOp": "git-hold", "pageIds": [hit.to_string()], "sourceIds": ["ab"], "types": ["meeting"],
        "terms": ["alpha"], "cap": 2,
    }))
    .unwrap();
    let rows = s.read_held_hit_rows(&capped).unwrap();
    assert_eq!(rows.as_array().unwrap().last().unwrap()["could_affect"], 2);
}

#[test]
fn revival_pages_list_the_tombstones_of_a_slug_by_source_bytes() {
    let (s, _) = brain("revival");
    for id in ["ab", "a-z", "live"] {
        source(&s, id);
        page_in(&s, id, "notes/revived", "note", "r", json!({}));
    }
    s.soft_delete_page("notes/revived", Some("ab")).unwrap();
    s.soft_delete_page("notes/revived", Some("a-z")).unwrap();
    let got: Vec<String> = s
        .list_revival_pages("notes/revived", None)
        .unwrap()
        .iter()
        .map(|r| r["source_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(got, vec!["a-z", "ab"]);
    assert_eq!(
        s.list_revival_pages("notes/revived", Some("ab"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        s.list_revival_pages("notes/revived", Some("live"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn soak_counter_events_add_up_per_day_and_keep_the_other_counters() {
    let (store, _) = brain("soak-counter-events");
    store
        .add_soak_counter_event("sync-soak-counters", "2026-01-02", "repair_apply", 1)
        .unwrap();
    store
        .add_soak_counter_event("sync-soak-counters", "2026-01-02", "repair_apply", 3)
        .unwrap();
    store
        .add_soak_counter_event("sync-soak-counters", "2026-01-02", "needs_human", 2)
        .unwrap();
    let rows = store
        .read_op_checkpoint_records(
            "sync-soak-counters",
            &["2026-01-02".into(), "2026-01-03".into()],
        )
        .unwrap();
    assert_eq!(
        rows,
        json!([{ "day": "2026-01-02", "repair_apply": 4, "needs_human": 2 }])
    );
    // A count past an int4 refuses, as the `::int` arithmetic does, and leaves the row as it was.
    assert!(
        store
            .add_soak_counter_event(
                "sync-soak-counters",
                "2026-01-02",
                "repair_apply",
                i64::from(i32::MAX)
            )
            .is_err()
    );
    let rows = store
        .read_op_checkpoint_records("sync-soak-counters", &["2026-01-02".into()])
        .unwrap();
    assert_eq!(rows[0]["repair_apply"], json!(4));
}
