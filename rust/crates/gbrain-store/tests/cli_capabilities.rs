//! The source, config and tag members the CLI reads and import writes: `getSource`,
//! `listSourceLocalPaths`, `getSourceStrictness`, `getConfigValues`, `pruneFrontmatterTags` and
//! `addPageTagsById`, matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(id: &str, local_path: Option<&str>, config: Value) -> SourceInput {
    SourceInput {
        id: id.into(),
        name: Some(id.into()),
        local_path: local_path.map(String::from),
        config: config.as_object().cloned(),
        ..Default::default()
    }
}

fn put(store: &Store, slug: &str) -> Value {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()
}

fn revision(store: &Store, slug: &str) -> Value {
    let snapshot = store
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap();
    let revision = snapshot["page"]["knowledge_revision"].clone();
    assert!(revision.is_string(), "{snapshot}");
    revision
}

fn tags(store: &Store, slug: &str) -> Vec<String> {
    store.get_tags(slug, &ReadScope::default()).unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn get_source_returns_the_row_with_the_columns_the_store_does_not_keep_as_defaults() {
    let dir = TempDir::new("cap-get-source");
    let store = open(&dir);
    assert!(store.get_source("ghost").unwrap().is_none());
    store
        .upsert_source(&source(
            "wiki",
            Some("/work/wiki"),
            json!({"canonical": "git"}),
        ))
        .unwrap();
    let row = serde_json::to_value(store.get_source("wiki").unwrap().unwrap()).unwrap();
    assert_eq!(row["id"], "wiki");
    assert_eq!(row["name"], "wiki");
    assert_eq!(row["local_path"], "/work/wiki");
    assert_eq!(row["config"], json!({"canonical": "git"}));
    assert_eq!(row["last_commit"], Value::Null);
    assert_eq!(row["last_sync_at"], Value::Null);
    assert_eq!(row["contextual_retrieval_mode"], Value::Null);
    assert_eq!(row["trust_frontmatter_overrides"], false);
    assert!(row["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(row.get("incarnation").is_none());

    assert!(store.set_source_archived("wiki", true).unwrap());
    assert!(store.get_source("wiki").unwrap().is_some());
}

#[test]
fn local_paths_skip_empty_and_missing_paths_and_keep_archived_sources() {
    let dir = TempDir::new("cap-local-paths");
    let store = open(&dir);
    assert!(store.list_source_local_paths().unwrap().is_empty());
    store
        .upsert_source(&source("zeta", Some("/work/zeta"), json!({})))
        .unwrap();
    store
        .upsert_source(&source("alpha", Some("/work/alpha"), json!({})))
        .unwrap();
    store
        .upsert_source(&source("none", None, json!({})))
        .unwrap();
    store
        .upsert_source(&source("blank", Some(""), json!({})))
        .unwrap();
    assert!(store.set_source_archived("zeta", true).unwrap());
    let mut paths = store.list_source_local_paths().unwrap();
    paths.sort();
    assert_eq!(paths, ["/work/alpha", "/work/zeta"]);
    // The readiness sync probe counts only live bound sources: alpha (zeta is archived).
    assert_eq!(store.count_repo_bound_sources().unwrap(), 1);
}

#[test]
fn strictness_is_true_only_for_a_git_canonical_source() {
    let dir = TempDir::new("cap-strict");
    let store = open(&dir);
    store
        .upsert_source(&source("git", None, json!({"canonical": "git"})))
        .unwrap();
    store
        .upsert_source(&source("db", None, json!({"canonical": "db"})))
        .unwrap();
    store
        .upsert_source(&source("flag", None, json!({"canonical": true})))
        .unwrap();
    assert!(store.get_source_strictness("git").unwrap());
    assert!(!store.get_source_strictness("db").unwrap());
    assert!(!store.get_source_strictness("flag").unwrap());
    assert!(!store.get_source_strictness("default").unwrap());
    assert!(!store.get_source_strictness("ghost").unwrap());
}

#[test]
fn config_values_are_the_stored_keys_once_each_in_key_order() {
    let dir = TempDir::new("cap-config-values");
    let store = open(&dir);
    store.set_config("b.key", "two").unwrap();
    store.set_config("a.key", "one").unwrap();
    assert!(store.get_config_values(&[]).unwrap().is_empty());
    let rows = store
        .get_config_values(&strings(&[
            "b.key", "missing", "a.key", "b.key", "bad\0key",
        ]))
        .unwrap();
    assert_eq!(
        serde_json::to_value(rows).unwrap(),
        json!([{"key": "a.key", "value": "one"}, {"key": "b.key", "value": "two"}])
    );
}

#[test]
fn tag_claims_follow_pglite_and_prune_removes_only_import_owned_tags() {
    let dir = TempDir::new("cap-tags");
    let store = open(&dir);
    put(&store, "a");
    // An explicit add claims the tag; a later import claim leaves it explicit.
    store.add_tag("a", "kept", None).unwrap();
    store.add_tag_claimed("a", "kept", None, true).unwrap();
    // An import claim of a new tag owns it; an explicit add then takes it over.
    store.add_tag_claimed("a", "taken", None, true).unwrap();
    let before = revision(&store, "a").clone();
    store.add_tag("a", "taken", None).unwrap();
    assert_eq!(
        revision(&store, "a"),
        before,
        "a claim that changes alone keeps the page revision"
    );
    store.add_tag_claimed("a", "owned", None, true).unwrap();
    store.add_tag_claimed("a", "stays", None, true).unwrap();

    let before = revision(&store, "a").clone();
    store
        .prune_frontmatter_tags("a", &strings(&["stays"]), None)
        .unwrap();
    assert_eq!(tags(&store, "a"), ["kept", "stays", "taken"]);
    assert_ne!(revision(&store, "a"), before);

    let before = revision(&store, "a").clone();
    store
        .prune_frontmatter_tags("a", &strings(&["stays"]), None)
        .unwrap();
    assert_eq!(revision(&store, "a"), before);
    // A removed and re-added tag starts with no stale claim.
    store.remove_tag("a", "stays", None).unwrap();
    store.add_tag("a", "stays", None).unwrap();
    store.prune_frontmatter_tags("a", &[], None).unwrap();
    assert_eq!(tags(&store, "a"), ["kept", "stays", "taken"]);
    // A missing page is no error.
    store.prune_frontmatter_tags("ghost", &[], None).unwrap();
}

#[test]
fn add_page_tags_by_id_claims_each_distinct_tag_once() {
    let dir = TempDir::new("cap-tags-by-id");
    let store = open(&dir);
    let id = put(&store, "a")["id"].as_u64().unwrap();
    let before = revision(&store, "a").clone();
    store.add_page_tags_by_id(id, &[], false).unwrap();
    assert_eq!(revision(&store, "a"), before);

    store
        .add_page_tags_by_id(id, &strings(&["fm", "fm", "both"]), true)
        .unwrap();
    store
        .add_page_tags_by_id(id, &strings(&["both", "manual"]), false)
        .unwrap();
    assert_eq!(tags(&store, "a"), ["both", "fm", "manual"]);
    store.prune_frontmatter_tags("a", &[], None).unwrap();
    assert_eq!(tags(&store, "a"), ["both", "manual"]);

    assert_eq!(
        store
            .add_page_tags_by_id(id + 1000, &strings(&["x"]), false)
            .unwrap_err()
            .code,
        PAGE_NOT_FOUND
    );
}
