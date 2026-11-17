//! Replays `fixtures/graph-parity.json` against the Rust store and compares every result
//! with the one PGLite gave. The fixture is PGLite's own output, written by
//! `bun rust/scripts/graph-parity-golden.ts` (`--check` fails when it is stale), so each
//! case here is a typed link, graph or timeline read that matches PGLite exactly.
//!
//! The step format is `[op, args, view?]`, args positional as in `BrainEngine`, with the
//! string `"$undef"` for an `undefined` argument. Results are normalized the way the
//! generator does: `created_at` dropped, a `date` cut to its first 10 characters, and an
//! error recorded as `{error: class, message}` (only the class is compared).

mod common;

use common::{TempDir, open};
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::links::{
    AddLinkOptions, LinkBatchInput, LinkScope, PathOptions, RemoveLinkOptions, TraverseGraphOptions,
};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::search::SearchOptions;
use gbrain_store::sources::SourceInput;
use gbrain_store::timeline::{
    AddTimelineOptions, TimelineBatchInput, TimelineInput, TimelineOptions,
};
use gbrain_store::{Store, StoreError};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const FIXTURE: &str = include_str!("fixtures/graph-parity.json");
const UNDEF: &str = "$undef";

/// Columns PGLite's `getTimeline` returns beyond `TimelineEntry` (the write-provenance and
/// trust columns of `timeline_entries`). They are null or `"unknown"` for every row the
/// typed writes make; Rust does not emit them (README "Divergences").
const PGLITE_ONLY_TIMELINE_KEYS: &[&str] = &[
    "write_request_id",
    "write_principal_kind",
    "write_principal_id",
    "last_write_request_id",
    "last_write_principal_kind",
    "last_write_principal_id",
    "last_written_at",
    "trust_tier",
    "write_origin",
];

fn is_undef(value: &Value) -> bool {
    value.as_str() == Some(UNDEF)
}

/// Positional argument `i`, `None` when absent or `"$undef"`.
fn arg(args: &[Value], i: usize) -> Option<&Value> {
    args.get(i).filter(|v| !is_undef(v))
}

fn slug(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("argument {i} is not a slug: {args:?}"))
        .to_string()
}

/// Deserializes an options object, an absent one as the type's default.
fn opts<T: DeserializeOwned + Default>(args: &[Value], i: usize) -> T {
    match arg(args, i) {
        None | Some(Value::Null) => T::default(),
        Some(value) => serde_json::from_value(value.clone())
            .unwrap_or_else(|e| panic!("argument {i} does not deserialize: {e}: {value}")),
    }
}

/// Builds an object from named positional arguments, skipping absent ones, then merges
/// the trailing `opts` object into it (the flattened Rust option structs).
fn named(args: &[Value], names: &[&str], opts_at: usize) -> Value {
    let mut out = Map::new();
    for (i, name) in names.iter().enumerate() {
        if let Some(value) = arg(args, i + 2) {
            out.insert((*name).to_string(), value.clone());
        }
    }
    if let Some(Value::Object(extra)) = arg(args, opts_at) {
        out.extend(extra.clone());
    }
    Value::Object(out)
}

fn source_id(args: &[Value], i: usize) -> Option<String> {
    arg(args, i)
        .and_then(|o| o.get("sourceId"))
        .and_then(Value::as_str)
        .map(String::from)
}

fn ok(value: Value) -> Result<Value, StoreError> {
    Ok(value)
}

fn run(store: &Store, op: &str, args: &[Value]) -> Result<Value, StoreError> {
    match op {
        "putPage" => {
            let input: PageInput = opts(args, 1);
            let options: PutPageOptions = opts(args, 2);
            ok(store.put_page(&slug(args, 0), &input, &options)?)
        }
        "createSource" => {
            let id = slug(args, 0);
            store.upsert_source(&SourceInput {
                id: id.clone(),
                name: Some(id),
                ..Default::default()
            })?;
            ok(Value::Null)
        }
        "softDeletePage" => {
            let out = store.soft_delete_page(&slug(args, 0), source_id(args, 1).as_deref())?;
            ok(out
                .map(|slug| json!({ "slug": slug }))
                .unwrap_or(Value::Null))
        }
        "restorePage" => ok(json!(
            store.restore_page(&slug(args, 0), source_id(args, 1).as_deref())?
        )),
        "deletePage" => {
            store.delete_page(&slug(args, 0), source_id(args, 1).as_deref())?;
            ok(Value::Null)
        }
        "sealChunks" => {
            let slug = slug(args, 0);
            let chunks: Vec<ChunkInput> = opts(args, 1);
            let snapshot = store
                .read_page_snapshot(&slug, &ReadScope::default())?
                .expect("sealChunks on a missing page");
            let revision = snapshot["revision"].as_str().map(String::from);
            store.upsert_chunks(
                &slug,
                &chunks,
                &UpsertChunksOptions {
                    expected_revision: revision,
                    seal: true,
                    ..Default::default()
                },
            )?;
            ok(Value::Null)
        }
        "addLink" => {
            let options: AddLinkOptions = serde_json::from_value(named(
                args,
                &[
                    "context",
                    "linkType",
                    "linkSource",
                    "originSlug",
                    "originField",
                ],
                7,
            ))
            .unwrap();
            store.add_link(&slug(args, 0), &slug(args, 1), &options)?;
            ok(Value::Null)
        }
        "addLinksBatch" => {
            let links: Vec<LinkBatchInput> = opts(args, 0);
            ok(json!(store.add_links_batch(&links)?))
        }
        "removeLink" => {
            let options: RemoveLinkOptions =
                serde_json::from_value(named(args, &["linkType", "linkSource"], 4)).unwrap();
            ok(json!(store.remove_link(
                &slug(args, 0),
                &slug(args, 1),
                &options
            )?))
        }
        "getLinks" => {
            let scope: LinkScope = opts(args, 1);
            ok(json!(store.get_links(&slug(args, 0), &scope)?))
        }
        "getBacklinks" => {
            let scope: LinkScope = opts(args, 1);
            ok(json!(store.get_backlinks(&slug(args, 0), &scope)?))
        }
        "traverseGraph" => {
            let depth = arg(args, 1).map(|d| d.as_i64().expect("depth is an integer"));
            let options: TraverseGraphOptions = opts(args, 2);
            ok(json!(store.traverse_graph(
                &slug(args, 0),
                depth,
                &options
            )?))
        }
        "traversePaths" => {
            let options: PathOptions = opts(args, 1);
            ok(json!(store.traverse_paths(&slug(args, 0), &options)?))
        }
        "traversePathsDetailed" => {
            let options: PathOptions = opts(args, 1);
            ok(store.traverse_paths_detailed(&slug(args, 0), &options)?)
        }
        "addTimelineEntry" => {
            let entry: TimelineInput = opts(args, 1);
            let options: AddTimelineOptions = opts(args, 2);
            ok(json!(store.add_timeline_entry(
                &slug(args, 0),
                &entry,
                &options
            )?))
        }
        "addTimelineEntriesBatch" => {
            let entries: Vec<TimelineBatchInput> = opts(args, 0);
            ok(json!(store.add_timeline_entries_batch(&entries)?))
        }
        "getTimeline" => {
            let options: TimelineOptions = opts(args, 1);
            ok(json!(store.get_timeline(&slug(args, 0), &options)?))
        }
        "searchKeyword" => {
            let query = slug(args, 0);
            let options: SearchOptions = opts(args, 1);
            ok(json!(store.search_keyword(&query, &options)?))
        }
        other => panic!("the fixture uses an op this replay does not know: {other}"),
    }
}

/// The generator's normalization.
fn normalize(value: Value, key: Option<&str>) -> Value {
    match value {
        Value::String(s) if key == Some("date") => Value::String(s.chars().take(10).collect()),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| normalize(v, None)).collect())
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(k, _)| k != "created_at")
                .map(|(k, v)| {
                    let v = normalize(v, Some(&k));
                    (k, v)
                })
                .collect(),
        ),
        other => other,
    }
}

fn view(result: Result<Value, StoreError>, view: Option<&str>) -> Value {
    match result {
        Err(e) => json!({ "error": e.code }),
        Ok(value) => match view {
            Some("quiet") => json!({ "ok": null }),
            Some("stale") => json!({
                "ok": value
                    .as_array()
                    .expect("searchKeyword returns rows")
                    .iter()
                    .map(|r| json!({ "slug": r["slug"], "stale": r["stale"] }))
                    .collect::<Vec<_>>()
            }),
            None => json!({ "ok": normalize(value, None) }),
            Some(other) => panic!("unknown view {other}"),
        },
    }
}

/// PGLite's expected value, with only the error class kept and the PGLite-only timeline
/// columns removed (after checking they hold nothing).
fn expected(op: &str, mut want: Value) -> Value {
    if let Some(class) = want.get("error").cloned() {
        return json!({ "error": class });
    }
    if op == "getTimeline"
        && let Some(rows) = want["ok"].as_array_mut()
    {
        for row in rows {
            let row = row.as_object_mut().unwrap();
            for key in PGLITE_ONLY_TIMELINE_KEYS {
                let held = row.remove(*key).unwrap_or(Value::Null);
                assert!(
                    held.is_null() || held == "unknown",
                    "PGLite timeline column {key} holds {held}; Rust does not model it"
                );
            }
        }
    }
    want
}

#[test]
fn rust_reads_and_writes_match_the_pglite_golden_results() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(fixture["engine"], "pglite");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 18, "the fixture lost cases: {}", cases.len());
    let mut failures = Vec::new();
    let mut steps_run = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let dir = TempDir::new("graph-parity");
        let store = open(&dir);
        let steps = case["steps"].as_array().unwrap();
        let results = case["results"].as_array().unwrap();
        assert_eq!(
            steps.len(),
            results.len(),
            "{name}: steps and results differ in count"
        );
        for (i, (step, want)) in steps.iter().zip(results).enumerate() {
            let step = step.as_array().unwrap();
            let op = step[0].as_str().unwrap();
            let args = step[1].as_array().unwrap();
            let got = view(run(&store, op, args), step.get(2).and_then(Value::as_str));
            let want = expected(op, want.clone());
            steps_run += 1;
            if got != want {
                failures.push(format!(
                    "{name} step {i} {op} {}\n  pglite: {want}\n  rust:   {got}",
                    Value::Array(args.clone())
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {steps_run} steps differ from PGLite:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
