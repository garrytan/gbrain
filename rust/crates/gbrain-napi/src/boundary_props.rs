//! Property tests for the addon boundary: hostile input must never panic the engine.
//!
//! Every `Brain` method decodes loose JSON with `required` / `arg` and then makes one store call.
//! These tests send arbitrary JSON, hostile strings and mangled copies of valid arguments through
//! that same decode and the same store call, against a real store in a temp directory, and check
//! three things:
//!   1. nothing panics (a panic in the addon would show up as `internal_error` or end the process);
//!   2. every failure is a `StoreError` whose code says the caller's input was wrong, never a
//!      storage fault code, and never `internal_error`;
//!   3. the store still works afterwards.
//!
//! The method bodies are copied from `families/*.rs` (the napi macros cannot be called from plain
//! Rust), so a method added or changed there is not covered until it is added to a table below.
//! The Bun fuzz in `rust/smoke/cases.ts` covers the real built addon, including the JavaScript to
//! JSON conversion that these tests cannot reach (lone surrogates, typed arrays, symbols).
//!
//! Sizes are kept for CI: a fixed case count per family and one store per family.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Mutex;

use gbrain_store::error::StoreError;
use gbrain_store::facts::purge::{FactScopeArgs, WithdrawalExpiry};
use gbrain_store::facts::purge_ledger::FactPurgeInsert;
use gbrain_store::facts::{ExpireFactArgs, FactQuery, InsertFactArgs};
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, ListFilter};
use gbrain_store::pages::{PageKey, ReadScope};
use gbrain_store::{OpenOptions, Store};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use serde_json::{Map, Number, Value, json};

use crate::store_binding::{arg, required};

/// How many hostile calls each family gets. About 3 to 5 seconds per family in a debug build.
/// Set `GBRAIN_BOUNDARY_CASES` to hunt harder on a developer machine; CI uses this default.
const CASES: u32 = 150;

fn case_count() -> u32 {
    std::env::var("GBRAIN_BOUNDARY_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(CASES)
}

// ---------------------------------------------------------------------------------------------
// Which error codes are acceptable
// ---------------------------------------------------------------------------------------------

/// Codes that mean the disk or the handle failed, not that the caller's input was wrong. Bad
/// input must never produce one of these.
const FAULT_CODES: &[&str] = &[
    "store_corrupt",
    "store_io",
    "store_closed",
    "store_locked",
    "format_unknown",
    "writer_not_initialized",
    "internal_error",
];

/// Every code the store defines: the constants in `gbrain-store/src/error.rs`, read from the
/// file itself so a new code cannot be missed, plus the two defined next to their features (`purged_content`, `trust_raise_refused`).
fn known_codes() -> Vec<String> {
    let source = include_str!("../../gbrain-store/src/error.rs");
    let mut codes: Vec<String> = source
        .lines()
        .filter(|line| line.starts_with("pub const ") && line.contains(": &str = \""))
        .filter_map(|line| line.split('"').nth(1).map(str::to_owned))
        .collect();
    codes.push(gbrain_store::facts::purge_ledger::PURGED_CONTENT.to_owned());
    // `trust::stamp` is private to the store crate, so this one is written out.
    codes.push("trust_raise_refused".to_owned());
    codes
}

#[test]
fn the_code_list_is_read_from_the_store_and_is_not_empty() {
    let codes = known_codes();
    assert!(codes.len() >= 20, "{codes:?}");
    assert!(codes.iter().any(|c| c == "invalid_argument"));
    assert!(codes.iter().any(|c| c == "invalid_slug"));
    assert!(
        codes.iter().all(|c| c != "internal_error"),
        "the store never reports internal_error; only a caught panic does"
    );
}

/// Why a store error is not an acceptable answer to bad input, or `None` when it is fine.
fn unacceptable(error: &StoreError, known: &[String]) -> Option<String> {
    if FAULT_CODES.contains(&error.code) {
        return Some(format!(
            "storage-fault code {:?} for bad input: {}",
            error.code, error.message
        ));
    }
    if !known.iter().any(|c| c == error.code) {
        return Some(format!("untyped code {:?}: {}", error.code, error.message));
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Hostile value generators
// ---------------------------------------------------------------------------------------------

/// Characters that tend to break parsers, escapers and SQL-ish or path-ish code.
const NASTY_CHARS: &[char] = &[
    '\0',
    '\u{1}',
    '\u{7f}',
    '\u{85}',
    '\u{2028}',
    '\u{2029}',
    '\u{200b}',
    '\u{202e}',
    '\u{feff}',
    '\u{fdd0}',
    '\u{fffe}',
    '\u{ffff}',
    '\u{1fffe}',
    '\u{10ffff}',
    'é',
    'ß',
    'İ',
    '漢',
    '😀',
    '/',
    '\\',
    '.',
    ' ',
    '%',
    '_',
    '\'',
    '"',
    ';',
    '\n',
    '\r',
    '\t',
    '*',
    '?',
    '[',
    ']',
    '{',
    '}',
    '-',
    'a',
    'Z',
    '0',
    '9',
];

fn hostile_string() -> BoxedStrategy<String> {
    prop_oneof![
        4 => any::<String>(),
        4 => prop::collection::vec(prop::sample::select(NASTY_CHARS), 0..24)
            .prop_map(|chars| chars.into_iter().collect::<String>()),
        1 => Just(String::new()),
        1 => Just("\0".to_owned()),
        1 => Just("a\0b".to_owned()),
        1 => Just("../../etc/passwd".to_owned()),
        1 => Just("people/alice".to_owned()),
        1 => Just("default".to_owned()),
        // Long strings: 8 KB up to about 600 KB, plain and multi-byte.
        1 => (0u32..4, any::<bool>()).prop_map(|(step, wide)| {
            let unit = if wide { "漢" } else { "x" };
            unit.repeat(8_192 << (step * 2))
        }),
    ]
    .boxed()
}

fn number_value() -> BoxedStrategy<Value> {
    prop_oneof![
        any::<i64>().prop_map(|n| json!(n)),
        any::<u64>().prop_map(|n| json!(n)),
        any::<f64>().prop_map(float_value),
        Just(json!(i64::MIN)),
        Just(json!(i64::MAX)),
        Just(json!(u64::MAX)),
        Just(json!(1e308)),
        Just(json!(-1e308)),
        Just(json!(5e-324)),
        Just(json!(-0.0)),
        Just(json!(9_007_199_254_740_993_i64)),
        Just(json!(0.1)),
        Just(json!(-1)),
    ]
    .boxed()
}

/// JSON has no NaN or infinity; `serde_json` turns them into `null`, as JavaScript's
/// `JSON.stringify` does, so that is what reaches the engine.
fn float_value(f: f64) -> Value {
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

fn leaf_value() -> BoxedStrategy<Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        number_value(),
        hostile_string().prop_map(Value::String),
    ]
    .boxed()
}

/// Keys the engine's argument structs actually read, plus keys that are hostile in JavaScript.
fn hostile_key() -> BoxedStrategy<String> {
    prop_oneof![
        3 => prop::sample::select(vec![
            "sourceId", "sourceIds", "slug", "id", "limit", "offset", "input", "fact", "kind",
            "entity_slug", "visibility", "source", "source_id", "name", "queue", "status",
            "config", "type", "title", "compiled_truth", "where", "types", "__proto__",
            "constructor", "prototype", "toString", "hasOwnProperty",
        ]).prop_map(str::to_owned),
        2 => hostile_string(),
    ]
    .boxed()
}

/// Arbitrary JSON, nested up to a bound.
fn json_value() -> BoxedStrategy<Value> {
    leaf_value()
        .prop_recursive(5, 96, 6, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
                prop::collection::vec((hostile_key(), inner), 0..6).prop_map(|pairs| {
                    Value::Object(pairs.into_iter().collect::<Map<String, Value>>())
                }),
            ]
        })
        .boxed()
}

/// An array or object nested as deep as the addon lets a client go. `napi` refuses a JavaScript
/// value deeper than `MAX_JSON_DEPTH` (128 levels) or with more than a million nodes before any
/// engine code runs, so deeper values never reach the methods tested here.
const MAX_CLIENT_DEPTH: usize = 127;

/// Built without recursion. Decoding and dropping it still recurse, which is the point.
fn deep_value() -> BoxedStrategy<Value> {
    (
        MAX_CLIENT_DEPTH - 40..=MAX_CLIENT_DEPTH,
        any::<bool>(),
        leaf_value(),
    )
        .prop_map(|(depth, objects, leaf)| {
            let mut value = leaf;
            for _ in 0..depth {
                value = if objects {
                    json!({ "x": value })
                } else {
                    Value::Array(vec![value])
                };
            }
            value
        })
        .boxed()
}

// ---------------------------------------------------------------------------------------------
// Mutating valid arguments
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Mutation {
    /// Remove a field (or an array element).
    Drop,
    /// Put a value of another type, or a hostile one, where a field was.
    Replace(Value),
    /// Add a field the method does not know.
    Extra(String, Value),
}

fn mutation() -> BoxedStrategy<Mutation> {
    prop_oneof![
        1 => Just(Mutation::Drop),
        3 => json_value().prop_map(Mutation::Replace),
        1 => (hostile_key(), json_value()).prop_map(|(k, v)| Mutation::Extra(k, v)),
    ]
    .boxed()
}

/// Every place in `value`: the path of keys (objects) or indexes (arrays) that leads to it.
fn paths(value: &Value, here: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
    out.push(here.clone());
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                here.push(key.clone());
                paths(child, here, out);
                here.pop();
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                here.push(index.to_string());
                paths(child, here, out);
                here.pop();
            }
        }
        _ => {}
    }
}

fn node_mut<'a>(root: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    let mut at = root;
    for step in path {
        at = match at {
            Value::Object(map) => map.get_mut(step)?,
            Value::Array(items) => items.get_mut(step.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// Applies `mutations` to a copy of `valid`. `pick` chooses the place for each one.
fn mutate(valid: &Value, mutations: &[(u32, Mutation)]) -> Value {
    let mut out = valid.clone();
    for (pick, mutation) in mutations {
        let mut all = Vec::new();
        paths(&out, &mut Vec::new(), &mut all);
        let path = &all[*pick as usize % all.len()];
        match mutation {
            Mutation::Replace(new) => {
                if let Some(node) = node_mut(&mut out, path) {
                    *node = new.clone();
                }
            }
            Mutation::Drop => match path.split_last() {
                None => out = Value::Null,
                Some((last, parent)) => match node_mut(&mut out, parent) {
                    Some(Value::Object(map)) => {
                        map.remove(last);
                    }
                    Some(Value::Array(items)) => {
                        if let Ok(index) = last.parse::<usize>()
                            && index < items.len()
                        {
                            items.remove(index);
                        }
                    }
                    _ => {}
                },
            },
            Mutation::Extra(key, new) => {
                if let Some(Value::Object(map)) = node_mut(&mut out, path) {
                    map.insert(key.clone(), new.clone());
                } else {
                    out = json!({ key.clone(): new.clone(), "wrapped": out });
                }
            }
        }
    }
    out
}

/// A JSON argument: the valid sample as is, a mangled copy of it, arbitrary JSON, or very deep.
fn json_arg(valid: Value) -> BoxedStrategy<Value> {
    prop_oneof![
        2 => Just(valid.clone()),
        6 => prop::collection::vec((any::<u32>(), mutation()), 1..4)
            .prop_map(move |mutations| mutate(&valid, &mutations)),
        3 => json_value(),
        1 => deep_value(),
    ]
    .boxed()
}

// ---------------------------------------------------------------------------------------------
// The sampled methods
// ---------------------------------------------------------------------------------------------

/// What a position in a method's argument list is, as the napi signature declares it.
#[derive(Clone)]
enum Slot {
    /// A `String` parameter: JavaScript can only pass a string here (anything else is refused
    /// by napi before Rust runs).
    Str,
    /// A number parameter (`f64`).
    Num,
    /// A `Value` parameter, with a valid sample to mangle.
    Json(Value),
}

type Call = fn(&Store, Vec<Value>) -> Result<Value, StoreError>;

struct Method {
    name: &'static str,
    slots: Vec<Slot>,
    call: Call,
}

fn text(args: &[Value], at: usize) -> String {
    args[at].as_str().unwrap_or_default().to_owned()
}

fn number(args: &[Value], at: usize) -> f64 {
    args[at].as_f64().unwrap_or_default()
}

/// The `Option<Value>` a napi method gets: `undefined` and `null` arrive as `None`.
fn optional(args: &[Value], at: usize) -> Option<Value> {
    match args.get(at) {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.clone()),
    }
}

fn to_value<T: serde::Serialize>(result: Result<T, StoreError>) -> Result<Value, StoreError> {
    result.map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
}

/// Same check as `families::jobs::job_id`.
fn job_id(id: f64, what: &str) -> Result<i64, StoreError> {
    if id.fract() != 0.0 || !id.is_finite() || id.abs() > 9_007_199_254_740_991.0 {
        return Err(StoreError::invalid(format!(
            "{what}: id {id} is not a whole number"
        )));
    }
    Ok(id as i64)
}

fn page_sample() -> Value {
    json!({ "type": "note", "title": "Alice", "compiled_truth": "Alice likes zebra stripes." })
}

fn job_insert_sample() -> Value {
    json!({
        "name": "work", "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": { "version": 1, "kind": "application" },
    })
}

fn pages_methods() -> Vec<Method> {
    use Slot::*;
    let scope = || Json(json!({ "sourceId": "default", "includeDeleted": true }));
    vec![
        Method {
            name: "readPageSnapshot",
            slots: vec![Str, scope()],
            call: |s, a| {
                to_value(s.read_page_snapshot(
                    &text(&a, 0),
                    &arg(optional(&a, 1), "readPageSnapshot options")?,
                ))
            },
        },
        Method {
            name: "putPage",
            slots: vec![
                Str,
                Json(page_sample()),
                Json(json!({ "sourceId": "default", "force": true })),
            ],
            call: |s, a| {
                to_value(s.put_page(
                    &text(&a, 0),
                    &required(a[1].clone(), "putPage page")?,
                    &arg(optional(&a, 2), "putPage options")?,
                ))
            },
        },
        Method {
            name: "listPages",
            slots: vec![Json(json!({ "limit": 10, "type": "note" }))],
            call: |s, a| to_value(s.list_pages(&arg(optional(&a, 0), "listPages filters")?)),
        },
        Method {
            name: "softDeletePage",
            slots: vec![Str, scope()],
            call: |s, a| {
                let scope: ReadScope = arg(optional(&a, 1), "softDeletePage options")?;
                to_value(s.soft_delete_page(&text(&a, 0), scope.source_id.as_deref()))
            },
        },
        Method {
            name: "resolveSlugs",
            slots: vec![Str, scope()],
            call: |s, a| {
                to_value(
                    s.resolve_slugs(&text(&a, 0), &arg(optional(&a, 1), "resolveSlugs options")?),
                )
            },
        },
        Method {
            name: "lockPageKeys",
            slots: vec![Json(
                json!([{ "sourceId": "default", "slug": "people/alice" }]),
            )],
            call: |s, a| {
                to_value(s.lock_page_keys(&required::<Vec<PageKey>>(
                    a[0].clone(),
                    "lockPageKeys keys",
                )?))
            },
        },
    ]
}

fn fact_input() -> Value {
    json!({ "input": { "fact": "Alice likes zebras", "entity_slug": "people/alice", "source": "s" },
            "sourceId": "default" })
}

fn fact_scope() -> Value {
    json!({ "sourceId": "default", "visibility": "world", "factHash": "abc", "subject": "*" })
}

fn facts_methods() -> Vec<Method> {
    use Slot::*;
    vec![
        Method {
            name: "insertFact",
            slots: vec![Json(fact_input())],
            call: |s, a| {
                let a: InsertFactArgs = required(a[0].clone(), "insertFact args")?;
                to_value(s.insert_fact(&a))
            },
        },
        Method {
            name: "listFactsByEntity",
            slots: vec![Json(
                json!({ "sourceId": "default", "entitySlug": "people/alice",
                                      "activeOnly": true, "limit": 10 }),
            )],
            call: |s, a| {
                let q: FactQuery = required(a[0].clone(), "listFactsByEntity query")?;
                to_value(s.list_facts_by_entity(&q))
            },
        },
        Method {
            name: "expireFact",
            slots: vec![Json(json!({ "id": 1, "at": "2026-01-01T00:00:00.000Z" }))],
            call: |s, a| {
                let q: ExpireFactArgs = required(a[0].clone(), "expireFact args")?;
                to_value(s.expire_fact(&q))
            },
        },
        Method {
            name: "expireFactsByWithdrawal",
            slots: vec![Json(json!({ "sourceId": "default", "visibility": "world",
                                      "fact": "Alice likes zebras", "subject": "people/alice" }))],
            call: |s, a| {
                let q: WithdrawalExpiry = required(a[0].clone(), "expireFactsByWithdrawal args")?;
                to_value(s.expire_facts_by_withdrawal(&q))
            },
        },
        Method {
            name: "planFactPurgeIds",
            slots: vec![Json(fact_scope())],
            call: |s, a| {
                let q: FactScopeArgs = required(a[0].clone(), "planFactPurgeIds args")?;
                to_value(s.plan_fact_purge_ids(&q))
            },
        },
        Method {
            name: "insertFactPurge",
            slots: vec![Json(json!({ "sourceId": "default", "visibility": "world",
                                      "subject": "people/alice", "factHash": "abc",
                                      "requestId": "00000000-0000-4000-8000-000000000002", "actor": "t", "reason": "test" }))],
            call: |s, a| {
                let q: FactPurgeInsert = required(a[0].clone(), "insertFactPurge row")?;
                to_value(s.insert_fact_purge(&q))
            },
        },
    ]
}

fn search_methods() -> Vec<Method> {
    use Slot::*;
    let options = || Json(json!({ "limit": 5, "type": "note", "sources": ["default"] }));
    vec![
        Method {
            name: "searchKeyword",
            slots: vec![Str, options()],
            call: |s, a| {
                to_value(s.search_keyword(
                    &text(&a, 0),
                    &arg(optional(&a, 1), "searchKeyword options")?,
                ))
            },
        },
        Method {
            name: "searchKeywordChunks",
            slots: vec![Str, options()],
            call: |s, a| {
                to_value(s.search_keyword_chunks(
                    &text(&a, 0),
                    &arg(optional(&a, 1), "searchKeywordChunks options")?,
                ))
            },
        },
        Method {
            name: "countKeywordPages",
            slots: vec![Str, options()],
            call: |s, a| {
                to_value(s.count_keyword_pages(
                    &text(&a, 0),
                    &arg(optional(&a, 1), "countKeywordPages options")?,
                ))
            },
        },
    ]
}

fn config_methods() -> Vec<Method> {
    use Slot::*;
    vec![
        Method {
            name: "getConfig",
            slots: vec![Str],
            call: |s, a| to_value(s.get_config(&text(&a, 0))),
        },
        Method {
            name: "setConfig",
            slots: vec![Str, Str],
            call: |s, a| to_value(s.set_config(&text(&a, 0), &text(&a, 1))),
        },
        Method {
            name: "unsetConfig",
            slots: vec![Str],
            call: |s, a| to_value(s.unset_config(&text(&a, 0))),
        },
        Method {
            name: "listConfigKeys",
            slots: vec![Str],
            call: |s, a| to_value(s.list_config_keys(&text(&a, 0))),
        },
        Method {
            name: "getConfigValues",
            slots: vec![Json(json!(["version", "sync.repo"]))],
            call: |s, a| {
                to_value(s.get_config_values(&required::<Vec<String>>(
                    a[0].clone(),
                    "getConfigValues keys",
                )?))
            },
        },
    ]
}

fn sources_methods() -> Vec<Method> {
    use Slot::*;
    vec![
        Method {
            name: "upsertSource",
            slots: vec![Json(
                json!({ "id": "notes", "name": "Notes", "config": { "federated": true } }),
            )],
            call: |s, a| to_value(s.upsert_source(&required(a[0].clone(), "upsertSource input")?)),
        },
        Method {
            name: "updateSourceConfig",
            slots: vec![Str, Json(json!({ "federated": false }))],
            call: |s, a| {
                to_value(s.update_source_config(
                    &text(&a, 0),
                    &required(a[1].clone(), "updateSourceConfig patch")?,
                ))
            },
        },
        Method {
            name: "getSourceById",
            slots: vec![Str],
            call: |s, a| to_value(s.get_source_by_id(&text(&a, 0))),
        },
        Method {
            name: "listAllSources",
            slots: vec![Json(json!({ "includeArchived": true }))],
            call: |s, a| {
                to_value(s.list_all_sources(&arg(optional(&a, 0), "listAllSources options")?))
            },
        },
    ]
}

fn jobs_methods() -> Vec<Method> {
    use Slot::*;
    vec![
        Method {
            name: "admitJob",
            slots: vec![Json(
                json!({ "insert": job_insert_sample(), "maxSpawnDepth": 5 }),
            )],
            call: |s, a| {
                let spec: AdmitSpec = required(a[0].clone(), "admitJob spec")?;
                to_value(s.admit_job(&spec))
            },
        },
        Method {
            name: "listJobs",
            slots: vec![Json(json!({ "status": "waiting", "limit": 10 }))],
            call: |s, a| {
                let filter: ListFilter = arg(optional(&a, 0), "listJobs filter")?;
                to_value(s.list_jobs(&filter))
            },
        },
        Method {
            name: "claimNextJob",
            slots: vec![Json(json!({
                "lockToken": "w:1", "lockDurationMs": 30000, "queue": "default",
                "names": ["work"], "suspectMark": "watchdog_suspect",
                "handlerTimeouts": {}, "handlerLockDurations": {},
                "legacySpend": { "groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5 },
            }))],
            call: |s, a| {
                let spec: ClaimSpec = required(a[0].clone(), "claimNextJob spec")?;
                to_value(s.claim_next_job(&spec))
            },
        },
        Method {
            name: "getJob",
            slots: vec![Num],
            call: |s, a| to_value(s.get_job(job_id(number(&a, 0), "getJob")?)),
        },
        Method {
            name: "completeJob",
            slots: vec![Num, Str, Json(json!({ "ok": true }))],
            call: |s, a| {
                to_value(s.complete_job(
                    job_id(number(&a, 0), "completeJob")?,
                    &text(&a, 1),
                    optional(&a, 2).as_ref(),
                ))
            },
        },
        Method {
            name: "renewJobLease",
            slots: vec![Num, Str, Num],
            call: |s, a| {
                to_value(s.renew_job_lease(
                    job_id(number(&a, 0), "renewJobLease")?,
                    &text(&a, 1),
                    number(&a, 2),
                ))
            },
        },
    ]
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

fn slot_strategy(slot: &Slot) -> BoxedStrategy<Value> {
    match slot {
        Slot::Str => hostile_string().prop_map(Value::String).boxed(),
        Slot::Num => prop_oneof![
            number_value(),
            // A number napi would hand over as f64 but that is not a whole number or not finite.
            Just(json!(0.5)),
            Just(json!(1e300)),
        ]
        .boxed(),
        Slot::Json(valid) => json_arg(valid.clone()),
    }
}

/// A method index and one argument per slot.
fn call_strategy(methods: &[Method]) -> BoxedStrategy<(usize, Vec<Value>)> {
    let per_method: Vec<BoxedStrategy<(usize, Vec<Value>)>> = methods
        .iter()
        .enumerate()
        .map(|(index, method)| {
            method
                .slots
                .iter()
                .map(slot_strategy)
                .collect::<Vec<_>>()
                .prop_map(move |args| (index, args))
                .boxed()
        })
        .collect();
    proptest::strategy::Union::new(per_method).boxed()
}

struct TempBrain {
    dir: PathBuf,
    store: Option<Store>,
}

impl TempBrain {
    fn open(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "gbrain-boundary-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        let options = OpenOptions {
            engine_abi: crate::ENGINE_ABI,
            catalog_version: crate::CATALOG_VERSION,
            keyword_index_builder: false,
            ..OpenOptions::default()
        };
        let store = Store::open_dir(&dir, options).expect("a temp brain opens");
        Self {
            dir,
            store: Some(store),
        }
    }

    fn store(&self) -> &Store {
        self.store.as_ref().expect("the brain is open")
    }
}

impl Drop for TempBrain {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            store.close();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A page, a fact and a source for the calls to find, so reads and writes have something to hit.
fn seed(store: &Store) {
    store
        .put_page(
            "people/alice",
            &serde_json::from_value(page_sample()).unwrap(),
            &Default::default(),
        )
        .expect("seed page");
    let fact: InsertFactArgs = serde_json::from_value(fact_input()).unwrap();
    store.insert_fact(&fact).expect("seed fact");
}

/// What one family's run saw.
#[derive(Default, Debug)]
struct Tally {
    ok: u32,
    codes: BTreeMap<&'static str, u32>,
    per_method_ok: BTreeMap<&'static str, u32>,
}

/// Runs `CASES` hostile calls over `methods` and checks the three rules in the module comment.
/// Returns what it saw so the caller can check the run was not vacuous.
fn hostile_run(label: &str, methods: Vec<Method>) -> Tally {
    let brain = TempBrain::open(label);
    seed(brain.store());
    let known = known_codes();
    let tally = Mutex::new(Tally::default());
    let mut runner = TestRunner::new(Config {
        cases: case_count(),
        failure_persistence: None,
        max_shrink_iters: 200,
        ..Config::default()
    });
    let result = runner.run(&call_strategy(&methods), |(index, args)| {
        let method = &methods[index];
        let outcome = catch_unwind(AssertUnwindSafe(|| (method.call)(brain.store(), args)));
        match outcome {
            Err(_) => Err(TestCaseError::fail(format!("{} panicked", method.name))),
            Ok(Ok(_)) => {
                let mut t = tally.lock().unwrap();
                t.ok += 1;
                *t.per_method_ok.entry(method.name).or_default() += 1;
                Ok(())
            }
            Ok(Err(error)) => {
                tally
                    .lock()
                    .unwrap()
                    .codes
                    .entry(error.code)
                    .and_modify(|n| *n += 1)
                    .or_insert(1);
                match unacceptable(&error, &known) {
                    Some(why) => Err(TestCaseError::fail(format!("{}: {why}", method.name))),
                    None => Ok(()),
                }
            }
        }
    });
    if let Err(failure) = result {
        panic!("{label}: {failure}");
    }
    // The brain must still answer ordinary calls after everything above.
    assert_eq!(
        brain.store().get_config("version").map(|v| v.is_some()),
        Ok(true),
        "{label}: the brain stopped answering after hostile input"
    );
    // A hostile call may legitimately have soft-deleted the seed page, so write and read a new one.
    brain
        .store()
        .put_page(
            "after/hostile",
            &serde_json::from_value(page_sample()).unwrap(),
            &Default::default(),
        )
        .unwrap_or_else(|e| panic!("{label}: a normal write failed after hostile input: {e}"));
    assert!(
        brain
            .store()
            .read_page_snapshot("after/hostile", &Default::default())
            .is_ok_and(|snapshot| snapshot.is_some()),
        "{label}: a page written after hostile input cannot be read"
    );
    let tally = tally.into_inner().unwrap();
    println!(
        "{label}: {} ok, error codes {:?}, ok per method {:?}",
        tally.ok, tally.codes, tally.per_method_ok
    );
    tally
}

/// A run that only ever failed to decode would prove nothing about the store calls behind it.
fn assert_not_vacuous(label: &str, tally: &Tally) {
    assert!(tally.ok > 0, "{label}: no call succeeded");
    assert!(
        tally.codes.contains_key("invalid_argument") || tally.codes.contains_key("invalid_slug"),
        "{label}: hostile input never produced a typed input error: {:?}",
        tally.codes
    );
}

#[test]
fn every_valid_sample_is_accepted_on_a_fresh_brain() {
    let families: Vec<(&str, Vec<Method>)> = vec![
        ("pages", pages_methods()),
        ("facts", facts_methods()),
        ("search", search_methods()),
        ("config", config_methods()),
        ("sources", sources_methods()),
        ("jobs", jobs_methods()),
    ];
    for (family, methods) in families {
        for method in methods {
            let brain = TempBrain::open("valid");
            seed(brain.store());
            let args: Vec<Value> = method
                .slots
                .iter()
                .map(|slot| match slot {
                    Slot::Str => json!("people/alice"),
                    Slot::Num => json!(1),
                    Slot::Json(valid) => valid.clone(),
                })
                .collect();
            // These samples are for the method's own happy path; a typed refusal is fine for the
            // few whose sample depends on rows that do not exist (job ids, lease tokens), but a
            // decode failure would mean the sample is wrong and the mangling tests are aimless.
            if let Err(error) = (method.call)(brain.store(), args) {
                assert_ne!(
                    error.code, "invalid_argument",
                    "{family}/{}: the valid sample was refused: {}",
                    method.name, error.message
                );
            }
        }
    }
}

#[test]
fn hostile_input_to_page_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("pages", &hostile_run("pages", pages_methods()));
}

#[test]
fn hostile_input_to_fact_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("facts", &hostile_run("facts", facts_methods()));
}

#[test]
fn hostile_input_to_search_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("search", &hostile_run("search", search_methods()));
}

#[test]
fn hostile_input_to_config_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("config", &hostile_run("config", config_methods()));
}

#[test]
fn hostile_input_to_source_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("sources", &hostile_run("sources", sources_methods()));
}

#[test]
fn hostile_input_to_job_methods_is_refused_in_a_typed_way() {
    assert_not_vacuous("jobs", &hostile_run("jobs", jobs_methods()));
}

/// Fixed hostile inputs that a random run may not reach: a NUL in a slug, a huge string, the
/// largest and smallest numbers and the deepest nesting a client can send, sent to every sampled method at once.
#[test]
fn fixed_hostile_inputs_never_panic() {
    let brain = TempBrain::open("fixed");
    seed(brain.store());
    let known = known_codes();
    let mut deep = json!(1);
    for _ in 0..MAX_CLIENT_DEPTH {
        deep = Value::Array(vec![deep]);
    }
    let mut deep_object = json!(1);
    for _ in 0..MAX_CLIENT_DEPTH {
        deep_object = json!({ "x": deep_object });
    }
    let strings = [
        "\0".to_owned(),
        "people/\0alice".to_owned(),
        "\u{10ffff}\u{fffe}\u{fdd0}".to_owned(),
        "x".repeat(2_000_000),
    ];
    let values = [
        Value::Null,
        json!(true),
        json!(u64::MAX),
        json!(i64::MIN),
        json!(1e308),
        json!(-0.0),
        json!("\0"),
        json!([]),
        json!({}),
        json!({ "__proto__": { "x": 1 }, "constructor": 1 }),
        deep,
        deep_object,
    ];
    let all: Vec<Method> = pages_methods()
        .into_iter()
        .chain(facts_methods())
        .chain(search_methods())
        .chain(config_methods())
        .chain(sources_methods())
        .chain(jobs_methods())
        .collect();
    for method in &all {
        for string in &strings {
            for value in &values {
                let args: Vec<Value> = method
                    .slots
                    .iter()
                    .map(|slot| match slot {
                        Slot::Str => Value::String(string.clone()),
                        Slot::Num => value.clone(),
                        Slot::Json(_) => value.clone(),
                    })
                    .collect();
                let outcome = catch_unwind(AssertUnwindSafe(|| (method.call)(brain.store(), args)));
                match outcome {
                    Err(_) => panic!("{} panicked", method.name),
                    Ok(Err(error)) => {
                        if let Some(why) = unacceptable(&error, &known) {
                            panic!("{}: {why}", method.name);
                        }
                    }
                    Ok(Ok(_)) => {}
                }
            }
        }
    }
    assert!(brain.store().get_config("version").is_ok());
}
