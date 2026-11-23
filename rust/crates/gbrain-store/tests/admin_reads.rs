//! The admin operations' page reads (`listVisiblePageSlugs`, `readPagesForVersionHistory`) and the
//! captured-query listing (`listEvalCandidateQueries`), matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::eval_capture::EvalCandidateInput;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store.read_page_id_in_source(slug, source).unwrap().unwrap()
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    store
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

#[test]
fn visible_slugs_keep_live_pages_in_scope_that_the_policy_admits() {
    let dir = TempDir::new("admin-visible-slugs");
    let store = seeded(&dir);
    put(&store, "default", "notes/open", json!({}));
    put(
        &store,
        "default",
        "notes/private",
        json!({"visibility": "private"}),
    );
    put(&store, "default", "notes/gone", json!({}));
    put(&store, "other", "notes/elsewhere", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let slugs = strings(&[
        "notes/open",
        "notes/private",
        "notes/gone",
        "notes/elsewhere",
        "notes/open",
        "notes/never",
    ]);
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        store.list_visible_page_slugs(&slugs, None, None).unwrap(),
        strings(&["notes/elsewhere", "notes/open", "notes/private"])
    );
    assert_eq!(
        store
            .list_visible_page_slugs(&slugs, None, Some(&policy))
            .unwrap(),
        strings(&["notes/elsewhere", "notes/open"])
    );
    assert_eq!(
        store
            .list_visible_page_slugs(&slugs, Some(&strings(&["other"])), Some(&policy))
            .unwrap(),
        strings(&["notes/elsewhere"])
    );
    assert!(
        store
            .list_visible_page_slugs(&[], None, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn version_history_pages_read_by_id_including_a_soft_deleted_page() {
    let dir = TempDir::new("admin-version-pages");
    let store = seeded(&dir);
    let one = put(&store, "default", "notes/one", json!({"tier": "a"}));
    let two = put(&store, "other", "notes/two", json!({}));
    store.soft_delete_page("notes/two", Some("other")).unwrap();
    let rows = store
        .read_pages_for_version_history(&[two as i64, one as i64, one as i64, 987_654, -1])
        .unwrap();
    let mut want = vec![(one, "notes/one", "default"), (two, "notes/two", "other")];
    want.sort();
    let view: Vec<(u64, &str, &str)> = rows
        .iter()
        .map(|r| (r.id, r.slug.as_str(), r.source_id.as_str()))
        .collect();
    assert_eq!(view, want);
    let first = rows.iter().find(|r| r.id == one).unwrap();
    assert_eq!(first.frontmatter.get("tier"), Some(&json!("a")));
    assert!(
        store
            .read_pages_for_version_history(&[])
            .unwrap()
            .is_empty()
    );
}

fn candidate(query: &str) -> EvalCandidateInput {
    serde_json::from_value(json!({
        "tool_name": "query", "query": query, "retrieved_slugs": [], "retrieved_chunk_ids": [],
        "source_ids": ["default"], "expand_enabled": null, "detail": null, "detail_resolved": null,
        "vector_enabled": false, "expansion_applied": false, "latency_ms": 1, "remote": false,
        "job_id": null, "subagent_id": null, "embedding_column": null,
    }))
    .unwrap()
}

#[test]
fn candidate_queries_come_newest_first_up_to_the_limit() {
    let dir = TempDir::new("eval-candidate-queries");
    let store = open(&dir);
    assert!(store.list_eval_candidate_queries(5.0).unwrap().is_empty());
    for q in ["first", "second", "third"] {
        store.log_eval_candidate(&candidate(q)).unwrap();
    }
    assert_eq!(
        store.list_eval_candidate_queries(100.0).unwrap(),
        strings(&["third", "second", "first"])
    );
    assert_eq!(
        store.list_eval_candidate_queries(2.0).unwrap(),
        strings(&["third", "second"])
    );
    assert!(store.list_eval_candidate_queries(0.0).unwrap().is_empty());
    for bad in [-1.0, 1.5, f64::NAN] {
        let err = store.list_eval_candidate_queries(bad).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}
