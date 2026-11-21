//! The batch 6a history repair reads: the purged-reason version pair (`repair_versions.rs`), the redacted-facts and
//! label-retirement fact members (`facts/text_repair.rs`), the restorable atoms (`page_ops/atom_restore.rs`) and the
//! moved-page reads (`moved_page_reads.rs`).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::text_repair::{
    ExpireWithNote, FactIdsQuery, FactTextRestoreArgs, PageFactsArgs, RedactedFactQuery,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::repair_versions::{VersionReasonQuery, VersionReasonReplace};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn page(
    store: &Store,
    slug: &str,
    page_type: &str,
    source_path: Option<&str>,
    frontmatter: Value,
) -> u64 {
    let mut input = json!({ "type": page_type, "title": slug, "compiled_truth": format!("{slug} body."), "timeline": "", "frontmatter": frontmatter });
    if let Some(path) = source_path {
        input["source_path"] = json!(path);
    }
    let options: PutPageOptions = args(json!({ "sourceId": "default" }));
    let saved = store
        .put_page(slug, &args::<PageInput>(input), &options)
        .unwrap();
    saved["id"].as_u64().unwrap()
}

fn facts(store: &Store, rows: Value) -> Vec<u64> {
    let out = store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": "default" }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect()
}

#[test]
fn purged_reasons_are_listed_and_replaced_only_while_unchanged() {
    let (_d, store) = brain("history-reasons");
    for slug in ["notes/a", "notes/b"] {
        page(&store, slug, "note", Some(&format!("{slug}.md")), json!({}));
        store
            .create_version_opts(
                slug,
                &args(json!({ "sourceId": "default", "reason": "Leaked text." })),
            )
            .unwrap();
    }
    let listed = store
        .list_versions_by_change_reason(&args::<VersionReasonQuery>(
            json!({ "sourceId": "default", "reasons": ["Leaked text."] }),
        ))
        .unwrap();
    assert_eq!(listed.len(), 2);
    let (a, b) = (listed[0].id as i64, listed[1].id as i64);
    let replace = |rows: Value| {
        store
            .replace_version_change_reasons(&args::<VersionReasonReplace>(
                json!({ "sourceId": "default", "rows": rows, "replacement": "[purged]" }),
            ))
            .unwrap()
    };
    assert_eq!(
        replace(json!([{ "id": a, "reason": "Other text." }])),
        Vec::<u64>::new()
    );
    assert_eq!(
        replace(json!([{ "id": a, "reason": "Leaked text." }])),
        vec![a as u64]
    );
    let left = store
        .list_versions_by_change_reason(&args::<VersionReasonQuery>(
            json!({ "sourceId": "default", "reasons": ["Leaked text."] }),
        ))
        .unwrap();
    assert_eq!(
        left.iter().map(|r| r.id as i64).collect::<Vec<_>>(),
        vec![b]
    );
}

#[test]
fn redacted_restores_compare_and_retirements_append_their_note() {
    let (_d, store) = brain("history-facts");
    page(&store, "notes/rows", "note", None, json!({}));
    let ids = facts(
        &store,
        json!([
            { "fact": "Two [redacted](B) text", "visibility": "private", "source": "mcp:put_page", "valid_from": "2026-01-01T00:00:00.000Z" },
            { "fact": "Audit", "visibility": "world", "source": "audit:t", "valid_from": "2026-01-01T00:00:00.000Z",
              "source_markdown_slug": "notes/rows", "row_num": 4, "context": "ctx" },
        ]),
    );
    let candidates = store
        .list_redacted_fact_candidates(&args::<RedactedFactQuery>(
            json!({ "sourceIds": ["default"], "ids": null }),
        ))
        .unwrap();
    assert_eq!(
        candidates.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![ids[0]]
    );
    let restore = |visibility: &str| {
        store
            .restore_redacted_fact_texts(&args::<FactTextRestoreArgs>(json!({ "sourceId": "default", "marker": "restored", "restores": [
                { "id": ids[0], "from_text": "Two [redacted](B) text", "to_text": "Two Beta (B) text", "visibility": visibility,
                  "entity_slug": null, "source_markdown_slug": null, "row_num": null }] })))
            .unwrap()
    };
    assert_eq!(restore("world"), Vec::<u64>::new());
    assert_eq!(restore("private"), vec![ids[0]]);
    assert!(
        store
            .list_redacted_fact_candidates(&args::<RedactedFactQuery>(
                json!({ "sourceIds": ["default"], "ids": null })
            ))
            .unwrap()
            .is_empty()
    );
    let note = |id: u64| {
        store
            .expire_fact_with_note(&args::<ExpireWithNote>(
                json!({ "sourceId": "default", "id": id, "note": "retired" }),
            ))
            .unwrap()
    };
    assert!(note(ids[0]));
    assert!(!note(ids[0]));
    let page_args: PageFactsArgs =
        args(json!({ "sourceId": "default", "slug": "notes/rows", "sources": ["audit:t"] }));
    assert_eq!(store.expire_page_facts_by_source(&page_args).unwrap(), 1);
    assert_eq!(store.read_max_fact_row_num(&page_args).unwrap(), Some(4));
    assert!(
        store
            .list_unexpired_fact_ids(&args::<FactIdsQuery>(
                json!({ "ids": [ids[0], ids[1], 999] })
            ))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn restorable_atoms_follow_the_retirement_rule() {
    let (_d, store) = brain("history-atoms");
    page(&store, "notes/origin", "note", None, json!({}));
    let retire = |slug: &str, origin: &str, hash: &str, at: &str| {
        page(
            &store,
            slug,
            "atom",
            None,
            json!({ "source_slug": origin, "source_hash": hash }),
        );
        store.create_version(slug, Some("default")).unwrap();
        page(
            &store,
            slug,
            "atom",
            None,
            json!({ "source_slug": origin, "source_hash": hash, "retired_by": "managed-reextract", "retired_at": at }),
        );
        store.soft_delete_page(slug, Some("default")).unwrap();
    };
    retire("atoms/older", "notes/origin", "h0", "2026-01-01");
    retire("atoms/latest", "notes/origin", "pending:h1", "2026-02-01");
    retire("atoms/orphan", "notes/gone", "h2", "2026-02-01");
    let sources = vec!["default".to_string()];
    let listed = store.list_restorable_atoms(&sources, None).unwrap();
    assert_eq!(
        listed.iter().map(|r| r["slug"].clone()).collect::<Vec<_>>(),
        vec![json!("atoms/latest")]
    );
    assert_eq!(listed[0]["hash"], json!("h1"));
    assert!(listed[0]["version_id"].is_u64());
    assert_eq!(
        store.count_kept_atom_retirements(&sources).unwrap(),
        json!({ "origin_gone": 1, "replaced": 0, "older_generation": 1 })
    );
}

#[test]
fn moved_page_reads_match_names_and_frontmatter_ids() {
    let (_d, store) = brain("history-moved");
    let a = page(
        &store,
        "notes/a",
        "note",
        Some("notes/a.md"),
        json!({ "id": "shared" }),
    );
    page(
        &store,
        "notes/b",
        "note",
        Some("docs/a.md"),
        json!({ "id": "shared" }),
    );
    page(&store, "notes/c", "note", Some("notes/ba.md"), json!({}));
    let named = store
        .list_live_pages_by_file_name("default", a as i64, "a.md")
        .unwrap();
    assert_eq!(
        named,
        vec![json!({ "slug": "notes/b", "source_path": "docs/a.md" })]
    );
    assert_eq!(
        store
            .list_live_pages_sharing_frontmatter_id("default", a as i64)
            .unwrap(),
        vec!["notes/b".to_string()]
    );
    assert!(!store.has_segmented_history(a as i64).unwrap());
    let by_paths = store
        .list_live_pages_by_source_paths(
            "default",
            a as i64,
            &["notes/a.md".into(), "docs/a.md".into()],
        )
        .unwrap();
    assert_eq!(
        by_paths
            .iter()
            .map(|r| r["slug"].clone())
            .collect::<Vec<_>>(),
        vec![json!("notes/b")]
    );
}
