//! The subagent transcript and tool ledger on the store (`subagent_messages` and
//! `subagent_tool_executions`): positions, legacy rows, settles, the dream-cycle reads, refusals and
//! the cascade when a job is deleted. The TypeScript parity file (test/engine-parity/jobs-subagent.test.ts)
//! pins the same behaviour against PGLite and Postgres.

mod memory_env;

use gbrain_store::error::CONSTRAINT_VIOLATION;
use gbrain_store::jobs::{
    AdmitSpec, CancelOpts, FailureFallback, MessageInsert, ToolInsert, ToolStart, ToolTarget,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;

fn add(b: &Brain, name: &str) -> i64 {
    let insert = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 5 })).unwrap();
    let id = b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    b.clock.advance(SEC);
    id
}

fn message(idx: i64, role: &str, blocks: &str) -> MessageInsert {
    serde_json::from_value(json!({
        "message_idx": idx, "role": role, "content_blocks": blocks, "tokens_in": 3, "model": "m",
    }))
    .unwrap()
}

fn tool(
    idx: i64,
    ordinal: Option<i64>,
    use_id: &str,
    name: &str,
    input: &str,
    status: &str,
) -> ToolInsert {
    serde_json::from_value(json!({
        "message_idx": idx, "ordinal": ordinal, "tool_use_id": use_id, "tool_name": name,
        "input": input, "status": status,
    }))
    .unwrap()
}

fn at(job: i64, idx: i64, ordinal: i64, use_id: &str) -> ToolTarget {
    serde_json::from_value(json!({
        "jobId": job, "messageIdx": idx, "ordinal": ordinal, "toolUseId": use_id,
    }))
    .unwrap()
}

fn stable(id: &str) -> ToolTarget {
    serde_json::from_value(json!({ "gbrainToolUseId": id })).unwrap()
}

fn start(idx: i64, ordinal: i64, use_id: &str, stable_id: &str) -> ToolStart {
    serde_json::from_value(json!({
        "message_idx": idx, "ordinal": ordinal, "tool_use_id": use_id, "tool_name": "brain_get_page",
        "input": "{}", "gbrain_tool_use_id": stable_id, "provider_id": "anthropic",
    }))
    .unwrap()
}

const ID_A: &str = "0190a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const ID_B: &str = "0190a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c";

fn field(rows: &Value, name: &str) -> Vec<Value> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| r[name].clone())
        .collect()
}

fn list(b: &Brain, job: i64, replay: bool) -> Value {
    Value::Array(b.list_subagent_tool_executions(job, replay).unwrap())
}

#[test]
fn messages_keep_the_first_writer_and_list_by_index() {
    let b = brain("subagent-messages");
    let job = add(&b, "sub");
    b.insert_subagent_message(job, &message(2, "assistant", r#"[{"type":"text"}]"#))
        .unwrap();
    b.insert_subagent_message(job, &message(1, "user", r#"[{"zz":1,"a":2}]"#))
        .unwrap();
    b.insert_subagent_message(job, &message(1, "assistant", "[]"))
        .unwrap();
    let rows = Value::Array(b.list_subagent_messages(job, false).unwrap());
    assert_eq!(field(&rows, "message_idx"), vec![json!(1), json!(2)]);
    assert_eq!(
        field(&rows, "role"),
        vec![json!("user"), json!("assistant")]
    );
    // jsonb prints keys by length, then bytes.
    assert_eq!(
        serde_json::to_string(&rows[0]["content_blocks"]).unwrap(),
        r#"[{"a":2,"zz":1}]"#
    );
    assert_eq!(rows[0]["tokens_in"], 3);
    assert_eq!(rows[0]["tokens_out"], Value::Null);
    assert_eq!(rows[0]["ended_at"], "2027-01-15T08:00:01.000000Z");
    let last = b.list_subagent_messages(job, true).unwrap();
    assert_eq!(last.len(), 1);
    assert_eq!(last[0]["message_idx"], 2);
    assert_eq!(b.count_subagent_messages(job).unwrap(), 2);
    assert_eq!(b.count_subagent_messages(job + 99).unwrap(), 0);
    assert!(b.list_subagent_messages(job + 99, true).unwrap().is_empty());
}

#[test]
fn a_write_that_refuses_writes_nothing() {
    let b = brain("subagent-refusals");
    let job = add(&b, "sub");
    let refused = |e: gbrain_store::StoreError| e.code;
    assert_eq!(
        refused(
            b.insert_subagent_message(job + 1, &message(0, "user", "[]"))
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        refused(
            b.insert_subagent_message(job, &message(0, "system", "[]"))
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
    assert!(
        b.insert_subagent_message(job, &message(0, "user", "{not json"))
            .is_err()
    );
    assert!(
        b.insert_subagent_message(job, &message(0, "user", r#"["\u0000"]"#))
            .is_err()
    );
    assert!(
        b.insert_subagent_message(job, &message(i64::from(i32::MAX) + 1, "user", "[]"))
            .is_err()
    );
    assert_eq!(b.count_subagent_messages(job).unwrap(), 0);

    // One bad row sinks the whole batch; a missing job refuses; an empty batch is fine anywhere.
    let batch = [
        tool(1, Some(0), "t", "brain_get_page", "{}", "pending"),
        tool(1, Some(1), "t", "brain_get_page", "{}", "bogus"),
    ];
    assert_eq!(
        refused(
            b.record_subagent_tool_executions(job, &batch, false)
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
    assert!(list(&b, job, false).as_array().unwrap().is_empty());
    let one = [tool(1, Some(0), "t", "brain_get_page", "{}", "pending")];
    assert_eq!(
        refused(
            b.record_subagent_tool_executions(job + 1, &one, false)
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
    b.record_subagent_tool_executions(job + 1, &[], false)
        .unwrap();
    assert!(
        b.start_subagent_tool_execution(job, &start(1, 0, "t", "not-a-uuid"))
            .is_err()
    );
    assert!(
        b.complete_subagent_tool_execution(&stable(ID_A), "{oops")
            .is_err()
    );
    assert_eq!(
        refused(
            b.start_subagent_tool_execution(job + 1, &start(1, 0, "t", ID_A))
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn a_position_keeps_its_first_row_and_a_legacy_row_never_conflicts() {
    let b = brain("subagent-positions");
    let job = add(&b, "sub");
    let rows = [
        tool(
            2,
            Some(1),
            "toolu_01",
            "brain_search",
            r#"{"q":"x"}"#,
            "pending",
        ),
        tool(1, Some(0), "toolu_01", "brain_get_page", "{}", "pending"),
        tool(
            1,
            None,
            "toolu_old",
            "brain_get_page",
            r#"{"n":1}"#,
            "pending",
        ),
        tool(
            1,
            None,
            "toolu_old",
            "brain_get_page",
            r#"{"n":2}"#,
            "pending",
        ),
    ];
    b.record_subagent_tool_executions(job, &rows, false)
        .unwrap();
    b.record_subagent_tool_executions(
        job,
        &[tool(
            2,
            Some(1),
            "toolu_new",
            "brain_put_page",
            "{}",
            "complete",
        )],
        false,
    )
    .unwrap();
    let by_id = list(&b, job, false);
    assert_eq!(
        field(&by_id, "tool_name"),
        vec![
            json!("brain_search"),
            json!("brain_get_page"),
            json!("brain_get_page"),
            json!("brain_get_page")
        ]
    );
    // Replay order: turn, then ordinal with a legacy NULL as 0, then id.
    let replay = list(&b, job, true);
    assert_eq!(
        field(&replay, "ordinal"),
        vec![json!(0), Value::Null, Value::Null, json!(1)]
    );
    // The legacy guard skips a banked row only when a legacy row of that turn and tool id is there.
    b.record_subagent_tool_executions(
        job,
        &[
            tool(1, Some(5), "toolu_old", "brain_get_page", "{}", "pending"),
            tool(1, Some(6), "toolu_other", "brain_get_page", "{}", "pending"),
        ],
        true,
    )
    .unwrap();
    assert_eq!(list(&b, job, false).as_array().unwrap().len(), 5);
}

#[test]
fn a_settle_by_position_takes_its_own_ordinal_then_a_legacy_row_and_never_a_complete_one() {
    let b = brain("subagent-settle-position");
    let job = add(&b, "sub");
    b.record_subagent_tool_executions(
        job,
        &[
            tool(1, None, "t", "brain_get_page", "{}", "pending"),
            tool(1, Some(3), "t", "brain_get_page", "{}", "pending"),
        ],
        false,
    )
    .unwrap();
    assert_eq!(
        b.complete_subagent_tool_execution(&at(job, 1, 3, "t"), r#"{"own":true}"#)
            .unwrap(),
        1
    );
    // The own row is complete now: the legacy row is next, then nothing is left.
    assert_eq!(
        b.complete_subagent_tool_execution(&at(job, 1, 3, "t"), r#"{"legacy":true}"#)
            .unwrap(),
        1
    );
    assert_eq!(
        b.complete_subagent_tool_execution(&at(job, 1, 3, "t"), r#"{"third":true}"#)
            .unwrap(),
        0
    );
    assert_eq!(
        b.complete_subagent_tool_execution(&at(job, 1, 3, "other"), "{}")
            .unwrap(),
        0
    );
    let rows = list(&b, job, false);
    assert_eq!(rows[0]["output"], json!({"legacy": true}));
    assert_eq!(rows[1]["output"], json!({"own": true}));
    assert_eq!(rows[1]["ended_at"], "2027-01-15T08:00:01.000000Z");
}

#[test]
fn a_failure_with_a_fallback_inserts_only_into_an_empty_position() {
    let b = brain("subagent-fail");
    let job = add(&b, "sub");
    let fallback = FailureFallback {
        tool_name: "brain_put_page".into(),
        input: r#"{"slug":"s"}"#.into(),
    };
    assert_eq!(
        b.fail_subagent_tool_execution(&at(job, 1, 0, "t"), "boom", None)
            .unwrap(),
        0
    );
    assert_eq!(
        b.fail_subagent_tool_execution(&at(job, 1, 0, "t"), "boom", Some(&fallback))
            .unwrap(),
        1
    );
    let rows = list(&b, job, false);
    assert_eq!(rows[0]["status"], "failed");
    assert_eq!(rows[0]["error"], "boom");
    assert_eq!(rows[0]["input"], json!({"slug": "s"}));
    assert_eq!(rows[0]["output"], Value::Null);
    // A complete row, and a row of another tool id, are left alone and nothing is inserted.
    b.record_subagent_tool_executions(
        job,
        &[tool(1, Some(1), "done", "brain_get_page", "{}", "pending")],
        false,
    )
    .unwrap();
    b.complete_subagent_tool_execution(&at(job, 1, 1, "done"), "{}")
        .unwrap();
    assert_eq!(
        b.fail_subagent_tool_execution(&at(job, 1, 1, "done"), "late", Some(&fallback))
            .unwrap(),
        0
    );
    assert_eq!(
        b.fail_subagent_tool_execution(&at(job, 1, 0, "other"), "late", Some(&fallback))
            .unwrap(),
        0
    );
    let rows = list(&b, job, false);
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert_eq!(rows[1]["status"], "complete");
    assert_eq!(rows[0]["error"], "boom");
}

#[test]
fn a_stable_id_is_minted_once_stored_lowercase_and_settles_every_match() {
    let b = brain("subagent-stable");
    let job = add(&b, "sub");
    let other = add(&b, "sub-2");
    assert_eq!(
        b.start_subagent_tool_execution(job, &start(1, 0, "t", &ID_A.to_uppercase()))
            .unwrap()
            .as_deref(),
        Some(ID_A)
    );
    // A replay of the position gets the first run's id; a banked row has none to give.
    assert_eq!(
        b.start_subagent_tool_execution(job, &start(1, 0, "t", ID_B))
            .unwrap()
            .as_deref(),
        Some(ID_A)
    );
    b.record_subagent_tool_executions(
        job,
        &[tool(1, Some(7), "t", "brain_get_page", "{}", "pending")],
        false,
    )
    .unwrap();
    assert_eq!(
        b.start_subagent_tool_execution(job, &start(1, 7, "t", ID_B))
            .unwrap(),
        None
    );
    // The same id on a second job: one settle takes both rows, whatever their status.
    b.start_subagent_tool_execution(other, &start(1, 0, "t", ID_A))
        .unwrap();
    assert_eq!(
        b.complete_subagent_tool_execution(&stable(ID_A), r#"{"ok":1}"#)
            .unwrap(),
        2
    );
    assert_eq!(
        b.fail_subagent_tool_execution(&stable(ID_A), "after the fact", None)
            .unwrap(),
        2
    );
    assert_eq!(
        b.complete_subagent_tool_execution(&stable(&ID_A.to_uppercase()), "{}")
            .unwrap(),
        0
    );
    assert_eq!(
        b.complete_subagent_tool_execution(&stable("not a uuid"), "{}")
            .unwrap(),
        0
    );
    let rows = list(&b, job, false);
    assert_eq!(rows[0]["status"], "failed");
    assert_eq!(rows[0]["output"], json!({"ok": 1}));
    assert_eq!(rows[0]["gbrain_tool_use_id"], ID_A);
    assert_eq!(rows[0]["schema_version"], 2);
    assert_eq!(rows[0]["provider_id"], "anthropic");
}

#[test]
fn the_reads_scope_by_status_prefix_and_tool() {
    let b = brain("subagent-reads");
    let job = add(&b, "sub");
    b.record_subagent_tool_executions(
        job,
        &[
            tool(
                1,
                Some(0),
                "oneshot-a1",
                "brain_put_page",
                r#"{"slug":"a","content":"c","request_id":"r","batch_id":"b1"}"#,
                "pending",
            ),
            tool(
                1,
                Some(1),
                "oneshot-a2",
                "brain_put_page",
                r#"{"slug":7}"#,
                "pending",
            ),
            tool(1, Some(2), "toolu_1", "brain_get_page", "{}", "pending"),
            tool(1, Some(3), "100%-x", "brain_get_page", "{}", "pending"),
        ],
        false,
    )
    .unwrap();
    b.complete_subagent_tool_execution(
        &at(job, 1, 0, "oneshot-a1"),
        r#"{"state":"committed","status":"ok","bb":1,"a":[null,2.5]}"#,
    )
    .unwrap();
    b.complete_subagent_tool_execution(&at(job, 1, 2, "toolu_1"), "null")
        .unwrap();
    b.fail_subagent_tool_execution(&at(job, 1, 1, "oneshot-a2"), "nope", None)
        .unwrap();
    assert!(
        b.has_subagent_tool_execution(job, Some("failed"), Some("oneshot-"))
            .unwrap()
    );
    assert!(
        !b.has_subagent_tool_execution(job, Some("complete"), Some("toolu_2"))
            .unwrap()
    );
    // `_` is a wildcard: `one_hot` matches `oneshot-a1`.
    assert!(
        b.has_subagent_tool_execution(job, None, Some("one_hot"))
            .unwrap()
    );
    assert!(
        b.has_subagent_tool_execution(job, None, Some("100\\%"))
            .unwrap()
    );
    assert!(!b.has_subagent_tool_execution(job + 1, None, None).unwrap());
    let ledger = Value::Array(b.list_subagent_oneshot_ledger(job, "oneshot-").unwrap());
    assert_eq!(field(&ledger, "slug"), vec![json!("a"), json!("7")]);
    assert_eq!(field(&ledger, "batch_id"), vec![json!("b1"), Value::Null]);
    let outcomes = Value::Array(b.list_subagent_write_outcomes(job, None).unwrap());
    assert_eq!(
        field(&outcomes, "status"),
        vec![json!("complete"), json!("failed")]
    );
    // `null` output is jsonb null (4 bytes); a pending row has no output at all.
    let sum = b
        .summarize_subagent_tool_executions(&[job, job], "brain_get_page", "complete")
        .unwrap();
    assert_eq!(sum, json!({"count": 1, "output_bytes": 4}));
    let sum = b
        .summarize_subagent_tool_executions(&[job], "brain_put_page", "complete")
        .unwrap();
    assert_eq!(
        sum,
        json!({"count": 1, "output_bytes": r#"{"a": [null, 2.5], "bb": 1, "state": "committed", "status": "ok"}"#.len()})
    );
    assert_eq!(
        b.list_subagent_put_page_slugs(&[job]).unwrap(),
        vec![json!("a")]
    );
    let kept = Value::Array(b.list_subagent_retained_put_pages(&[job]).unwrap());
    assert_eq!(kept[0]["job_key"], Value::Null);
    assert_eq!(kept[0]["output"]["state"], "committed");
}

#[test]
fn deleting_a_job_takes_its_rows_and_frees_its_stable_ids() {
    let b = brain("subagent-cascade");
    let done = add(&b, "done");
    let kept = add(&b, "kept");
    for job in [done, kept] {
        b.insert_subagent_message(job, &message(0, "user", "[]"))
            .unwrap();
        b.record_subagent_tool_executions(
            job,
            &[
                tool(1, Some(0), "t", "brain_get_page", "{}", "pending"),
                tool(1, None, "t", "brain_get_page", "{}", "pending"),
            ],
            false,
        )
        .unwrap();
    }
    b.start_subagent_tool_execution(done, &start(2, 0, "t", ID_A))
        .unwrap();
    b.cancel_jobs(&[done], &CancelOpts::default()).unwrap();
    assert!(b.delete_terminal_job(done).unwrap());
    assert_eq!(b.count_subagent_messages(done).unwrap(), 0);
    assert!(list(&b, done, true).as_array().unwrap().is_empty());
    assert_eq!(list(&b, kept, true).as_array().unwrap().len(), 2);
    assert_eq!(
        b.complete_subagent_tool_execution(&stable(ID_A), "{}")
            .unwrap(),
        0
    );
    assert_eq!(
        b.start_subagent_tool_execution(kept, &start(2, 0, "t", ID_A))
            .unwrap()
            .as_deref(),
        Some(ID_A)
    );
    assert_eq!(
        b.complete_subagent_tool_execution(&stable(ID_A), "{}")
            .unwrap(),
        1
    );
}
