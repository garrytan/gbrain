//! The core edit notice store (`core_edit_notices.rs`, rust/docs/store/core-edit-notices.md): each member against the SQL
//! it mirrors, and the paths that scrub the table (a page purge sweep, a hard page delete, a source delete) and snapshot it.

mod common;

use common::{TempDir, open};
use gbrain_store::core_edit_notices::CoreEditNoticeInput;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::page_ops::SourceOption;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::snapshot::SnapshotOp;
use gbrain_store::sources::SourceInput;
use gbrain_store::verify::{Verdict, verify_store_dir};
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    for id in ["other", "gone"] {
        let source: SourceInput =
            serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
        store.upsert_source(&source).unwrap();
    }
    (dir, store)
}

/// A notice with a base text, as the core guard writes one.
fn notice(
    source: &str,
    slug: &str,
    revision: Option<&str>,
    base_text: Option<&str>,
) -> CoreEditNoticeInput {
    serde_json::from_value(json!({
        "sourceId": source, "slug": slug, "pageId": 7, "revision": revision,
        "baseRevision": "base-rev", "baseText": base_text, "actor": "remote:agent",
    }))
    .unwrap()
}

fn insert(store: &Store, source: &str, slug: &str, revision: &str, base: Option<&str>) -> u64 {
    store
        .insert_core_edit_notice(&notice(source, slug, Some(revision), base))
        .unwrap()
}

fn pending(store: &Store, sources: Option<&[&str]>) -> Vec<Value> {
    let owned: Option<Vec<String>> = sources.map(|s| s.iter().map(|x| x.to_string()).collect());
    store
        .list_pending_core_edit_notices(owned.as_deref())
        .unwrap()
}

fn pages_of(rows: &[Value]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().to_string(),
                r["slug"].as_str().unwrap().to_string(),
                r["revision"].as_str().unwrap_or("-").to_string(),
            )
        })
        .collect()
}

fn t(source: &str, slug: &str, revision: &str) -> (String, String, String) {
    (source.into(), slug.into(), revision.into())
}

fn put(store: &Store, slug: &str, source: &str) {
    let input: PageInput = serde_json::from_value(
        json!({ "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {} }),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn store_probe(store: &Store, probe: Value, rows: i64) -> i64 {
    let q = serde_json::from_value(json!({ "probe": probe, "rows": rows })).unwrap();
    store.count_purge_store_probe(&q).unwrap()
}

#[test]
fn ids_count_up_from_one_and_are_never_reused() {
    let (_dir, store) = brain("notices-ids");
    assert_eq!(insert(&store, "default", "core/a", "r1", None), 1);
    assert_eq!(insert(&store, "default", "core/a", "r2", None), 2);
    assert_eq!(insert(&store, "other", "core/b", "r1", None), 3);
    // Removing the rows does not give their ids back (a sequence, as `BIGSERIAL`).
    let swept = store
        .delete_purged_slug_store_rows("default", &["core/a".to_string()])
        .unwrap();
    assert_eq!(swept["removed"]["core_edit_notices"], 2);
    assert_eq!(insert(&store, "default", "core/a", "r3", None), 4);
}

#[test]
fn an_insert_refuses_a_nul_byte_in_any_text_and_writes_nothing() {
    let (_dir, store) = brain("notices-nul");
    for (source, slug, base) in [
        ("a\0b", "s", "x"),
        ("default", "s\0", "x"),
        ("default", "s", "x\0"),
    ] {
        let input = notice(source, slug, Some("r"), Some(base));
        assert_eq!(
            store.insert_core_edit_notice(&input).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
    let mut input = notice("default", "s", Some("r\0"), None);
    assert_eq!(
        store.insert_core_edit_notice(&input).unwrap_err().code,
        INVALID_ARGUMENT
    );
    input.revision = None;
    input.actor = "a\0".into();
    assert_eq!(
        store.insert_core_edit_notice(&input).unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert!(pending(&store, None).is_empty());
    assert_eq!(
        insert(&store, "default", "s", "r", None),
        1,
        "a refused insert takes no id"
    );
}

#[test]
fn an_unknown_input_field_does_not_parse() {
    assert!(
        serde_json::from_value::<CoreEditNoticeInput>(json!({
            "sourceId": "default", "slug": "s", "actor": "a", "ackedAt": "x"
        }))
        .is_err()
    );
    // The four nullable columns may be missing: they read as NULL.
    let input: CoreEditNoticeInput =
        serde_json::from_value(json!({ "sourceId": "default", "slug": "s", "actor": "a" }))
            .unwrap();
    assert!(input.page_id.is_none() && input.revision.is_none() && input.base_text.is_none());
}

#[test]
fn the_list_has_the_newest_pending_notice_of_each_page_in_byte_order() {
    let (_dir, store) = brain("notices-list");
    assert!(pending(&store, None).is_empty());
    insert(&store, "other", "core/zed", "z1", None);
    insert(&store, "default", "core/b", "b1", None);
    insert(&store, "default", "core/a", "a1", None);
    insert(&store, "default", "core/a", "a2", None);
    insert(&store, "default", "core/a/sub", "s1", None);
    insert(&store, "default", "core/b", "b2", None);
    // `core/a` sorts before `core/a/sub` before `core/b`, and `default` before `other`.
    assert_eq!(
        pages_of(&pending(&store, None)),
        [
            t("default", "core/a", "a2"),
            t("default", "core/a/sub", "s1"),
            t("default", "core/b", "b2"),
            t("other", "core/zed", "z1"),
        ]
    );
    // A source filter keeps the wanted sources only; an empty list matches none; a repeat or an unknown one adds nothing.
    assert_eq!(
        pages_of(&pending(&store, Some(&["other", "other", "nobody"]))),
        [t("other", "core/zed", "z1")]
    );
    assert!(pending(&store, Some(&[])).is_empty());
    // The row shape and the `timestamptz::text` form of created_at.
    let row = &pending(&store, Some(&["other"]))[0];
    let mut keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["actor", "created_at", "revision", "slug", "source_id"]
    );
    assert_eq!(row["actor"], "remote:agent");
    let created = row["created_at"].as_str().unwrap();
    let (date, rest) = created.split_once(' ').unwrap();
    assert_eq!(date.len(), 10);
    assert!(
        rest.ends_with("+00") && !rest.contains('T') && !rest.contains('Z'),
        "{created}"
    );
}

#[test]
fn an_acknowledged_notice_leaves_the_list_and_a_later_one_brings_the_page_back() {
    let (_dir, store) = brain("notices-list-ack");
    let first = insert(&store, "default", "core/a", "a1", None);
    let second = insert(&store, "default", "core/a", "a2", None);
    insert(&store, "default", "core/b", "b1", None);
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(first as i64))
            .unwrap(),
        1
    );
    // The newest pending one is still the second.
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/a", "a2"), t("default", "core/b", "b1")]
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(second as i64))
            .unwrap(),
        1
    );
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/b", "b1")]
    );
    insert(&store, "default", "core/a", "a3", None);
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/a", "a3"), t("default", "core/b", "b1")]
    );
}

#[test]
fn the_list_stops_at_fifty_pages() {
    let (_dir, store) = brain("notices-list-limit");
    for n in 0..60 {
        insert(&store, "default", &format!("core/p{n:02}"), "r", None);
    }
    for n in 0..5 {
        insert(&store, "other", &format!("core/q{n}"), "r", None);
    }
    let all = pending(&store, None);
    assert_eq!(all.len(), 50);
    assert_eq!(all[0]["slug"], "core/p00");
    assert_eq!(all[49]["slug"], "core/p49");
    // Fifty by the filter too, and a filter on the second source reaches past the first one's rows.
    assert_eq!(pending(&store, Some(&["default", "other"])).len(), 50);
    assert_eq!(pending(&store, Some(&["other"])).len(), 5);
    // Fifty pages exactly, none after: no fifty-first row appears.
    let (_d2, small) = brain("notices-list-limit-exact");
    for n in 0..50 {
        insert(&small, "default", &format!("core/p{n:02}"), "r", None);
    }
    assert_eq!(pending(&small, None).len(), 50);
}

#[test]
fn the_oldest_pending_notice_is_the_lowest_id_the_page_has_not_acknowledged() {
    let (_dir, store) = brain("notices-oldest");
    assert!(
        store
            .read_oldest_pending_core_edit_notice("default", "core/a")
            .unwrap()
            .is_none()
    );
    let first = insert(&store, "default", "core/a", "a1", Some("text one"));
    insert(&store, "default", "core/a", "a2", Some("text two"));
    insert(&store, "other", "core/a", "o1", Some("other text"));
    let oldest = store
        .read_oldest_pending_core_edit_notice("default", "core/a")
        .unwrap()
        .unwrap();
    assert_eq!(oldest["base_text"], "text one");
    assert_eq!(oldest["actor"], "remote:agent");
    assert!(oldest["created_at"].as_str().unwrap().ends_with("+00"));
    let mut keys: Vec<&str> = oldest
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["actor", "base_text", "created_at"]);
    // Acknowledge the first: the second is the oldest pending one.
    store
        .ack_core_edit_notices("default", "core/a", Some(first as i64))
        .unwrap();
    let next = store
        .read_oldest_pending_core_edit_notice("default", "core/a")
        .unwrap()
        .unwrap();
    assert_eq!(next["base_text"], "text two");
    store
        .ack_core_edit_notices("default", "core/a", None)
        .unwrap();
    assert!(
        store
            .read_oldest_pending_core_edit_notice("default", "core/a")
            .unwrap()
            .is_none()
    );
    // Another source's page is its own.
    assert_eq!(
        store
            .read_oldest_pending_core_edit_notice("other", "core/a")
            .unwrap()
            .unwrap()["base_text"],
        "other text"
    );
    // A NULL base text reads as null.
    store
        .insert_core_edit_notice(&notice("default", "core/n", Some("n1"), None))
        .unwrap();
    assert!(
        store
            .read_oldest_pending_core_edit_notice("default", "core/n")
            .unwrap()
            .unwrap()["base_text"]
            .is_null()
    );
}

#[test]
fn a_revision_names_the_highest_id_of_the_page_pending_or_acknowledged() {
    let (_dir, store) = brain("notices-revision");
    let find = |source: &str, slug: &str, rev: &str| {
        store
            .find_core_edit_notice_id_by_revision(source, slug, rev)
            .unwrap()
    };
    assert_eq!(find("default", "core/a", "r1"), None);
    let first = insert(&store, "default", "core/a", "r1", None);
    let repeat = insert(&store, "default", "core/a", "r2", None);
    let again = insert(&store, "default", "core/a", "r1", None);
    store
        .insert_core_edit_notice(&notice("default", "core/a", None, None))
        .unwrap();
    insert(&store, "other", "core/a", "r1", None);
    assert_eq!(find("default", "core/a", "r1"), Some(again));
    assert_eq!(find("default", "core/a", "r2"), Some(repeat));
    // An acknowledged notice still answers: `ack --revision` names a reviewed edit.
    store
        .ack_core_edit_notices("default", "core/a", None)
        .unwrap();
    assert_eq!(find("default", "core/a", "r1"), Some(again));
    assert_eq!(find("default", "core/a", "nope"), None);
    assert_eq!(find("default", "core/other", "r1"), None);
    assert!(first < repeat && repeat < again);
    // A NULL revision matches no revision, not even the empty one.
    assert_eq!(find("default", "core/a", ""), None);
}

#[test]
fn an_ack_closes_the_pages_pending_notices_up_to_the_ceiling_and_counts_them() {
    let (_dir, store) = brain("notices-ack");
    let a1 = insert(&store, "default", "core/a", "a1", None);
    let a2 = insert(&store, "default", "core/a", "a2", None);
    let a3 = insert(&store, "default", "core/a", "a3", None);
    let other_page = insert(&store, "default", "core/b", "b1", None);
    let other_source = insert(&store, "other", "core/a", "o1", None);
    assert!(a1 < a2 && a2 < a3 && a3 < other_page && other_page < other_source);
    // A ceiling below the first id closes nothing; at the second, two.
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(-4))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(a2 as i64))
            .unwrap(),
        2
    );
    // Already closed rows are not counted twice, and a ceiling past the last id closes the rest.
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(a2 as i64))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", Some(i64::MAX))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/a", None)
            .unwrap(),
        0
    );
    // The other page and the other source were not touched.
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/b", "b1"), t("other", "core/a", "o1")]
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/none", None)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .ack_core_edit_notices("default", "core/b", None)
            .unwrap(),
        1
    );
    // An acknowledged row stays: a slug probe still counts it, and the revision lookup finds it.
    assert_eq!(
        store_probe(
            &store,
            json!({ "kind": "slug_key", "store": "core_edit_notices", "sourceId": "default", "slug": "core/a" }),
            10
        ),
        3
    );
}

#[test]
fn a_purge_blanks_the_base_text_of_the_sources_rows_that_hold_the_fact() {
    let (_dir, store) = brain("notices-blank");
    insert(
        &store,
        "default",
        "core/a",
        "a1",
        Some("The Harbor will REOPEN in May"),
    );
    insert(&store, "default", "core/b", "b1", Some("nothing to see"));
    insert(
        &store,
        "default",
        "core/b",
        "b2",
        Some("the harbor will reopen too"),
    );
    store
        .insert_core_edit_notice(&notice("default", "core/c", Some("c1"), None))
        .unwrap();
    insert(
        &store,
        "other",
        "core/a",
        "o1",
        Some("the harbor will reopen"),
    );
    // The needle arrives lowered; the text is lowered before it is searched.
    assert_eq!(
        store
            .blank_purge_core_edit_notices("default", "harbor will reopen")
            .unwrap(),
        2
    );
    assert_eq!(
        store
            .blank_purge_core_edit_notices("default", "harbor will reopen")
            .unwrap(),
        0
    );
    let base = |source: &str, slug: &str| {
        store
            .read_oldest_pending_core_edit_notice(source, slug)
            .unwrap()
            .unwrap()["base_text"]
            .clone()
    };
    assert!(base("default", "core/a").is_null());
    assert_eq!(base("default", "core/b"), "nothing to see");
    assert!(base("default", "core/c").is_null());
    assert_eq!(
        base("other", "core/a"),
        "the harbor will reopen",
        "another source is not touched"
    );
    // Blanking changes no other column and does not close the notice.
    assert_eq!(pending(&store, None).len(), 4);
    // The blanked text no longer answers the claim probe.
    let claim = |source: &str, needle: &str| {
        store_probe(
            &store,
            json!({ "kind": "claim_text", "store": "core_edit_notices", "sourceId": source,
            "claim": needle, "json": needle, "reason": "x", "reasonJson": "x" }),
            10,
        )
    };
    assert_eq!(claim("default", "harbor will reopen"), 0);
    assert_eq!(claim("other", "harbor will reopen"), 1);
}

#[test]
fn an_empty_fact_blanks_every_row_that_has_a_base_text_and_a_null_one_never_matches() {
    let (_dir, store) = brain("notices-blank-empty");
    insert(&store, "default", "core/a", "a1", Some("text"));
    insert(&store, "default", "core/b", "b1", Some(""));
    store
        .insert_core_edit_notice(&notice("default", "core/c", Some("c1"), None))
        .unwrap();
    // `strpos(lower(base_text), '') > 0` is true for any non-NULL text, the empty one too.
    assert_eq!(
        store.blank_purge_core_edit_notices("default", "").unwrap(),
        2
    );
    assert_eq!(
        store.blank_purge_core_edit_notices("default", "").unwrap(),
        0
    );
    assert_eq!(
        store.blank_purge_core_edit_notices("nobody", "x").unwrap(),
        0
    );
    assert_eq!(
        store
            .blank_purge_core_edit_notices("default", "a\0")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn lower_follows_the_postgres_table_not_rusts() {
    let (_dir, store) = brain("notices-blank-lower");
    // U+0130 lowers to `i` in the PGLite table the other purge probes use, and Rust's own table says `i` + U+0307.
    insert(&store, "default", "core/a", "a1", Some("İSTANBUL harbor"));
    assert_eq!(
        store
            .blank_purge_core_edit_notices("default", "istanbul")
            .unwrap(),
        1
    );
}

#[test]
fn the_page_purge_sweep_deletes_the_slugs_notices_in_its_source_and_counts_them() {
    let (_dir, store) = brain("notices-sweep");
    insert(&store, "default", "core/a", "a1", None);
    let a2 = insert(&store, "default", "core/a", "a2", None);
    insert(&store, "default", "core/b", "b1", None);
    insert(&store, "other", "core/a", "o1", None);
    store
        .ack_core_edit_notices("default", "core/a", Some(a2 as i64))
        .unwrap();
    let out = store
        .delete_purged_slug_store_rows("default", &["core/a".to_string(), "core/a".to_string()])
        .unwrap();
    // Both rows of the page, the acknowledged one included, and no other.
    assert_eq!(out["removed"]["core_edit_notices"], 2);
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/b", "b1"), t("other", "core/a", "o1")]
    );
    let again = store
        .delete_purged_slug_store_rows("default", &["core/a".to_string()])
        .unwrap();
    assert_eq!(again["removed"]["core_edit_notices"], 0);
    // An empty brain and an empty slug list still answer 0 and `{}`.
    let (_d, empty) = brain("notices-sweep-empty");
    let none = empty
        .delete_purged_slug_store_rows("default", &["core/a".to_string()])
        .unwrap();
    assert_eq!(none["removed"]["core_edit_notices"], 0);
}

#[test]
fn a_hard_page_delete_scrubs_the_pages_notices_as_the_sql_engines_do() {
    let (_dir, store) = brain("notices-page-delete");
    put(&store, "core/a", "default");
    put(&store, "core/b", "default");
    insert(&store, "default", "core/a", "a1", None);
    insert(&store, "default", "core/b", "b1", None);
    insert(&store, "other", "core/a", "o1", None);
    let option = SourceOption {
        source_id: Some("default".into()),
    };
    assert_eq!(
        store
            .delete_pages(&["core/a".to_string()], &option)
            .unwrap(),
        ["core/a"]
    );
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/b", "b1"), t("other", "core/a", "o1")]
    );
}

#[test]
fn a_slug_probe_counts_the_pages_notices_by_source_and_slug_and_stops_at_the_bound() {
    let (_dir, store) = brain("notices-slug-probe");
    let slug_key = |source: &str, slug: &str, rows: i64| {
        store_probe(
            &store,
            json!({ "kind": "slug_key", "store": "core_edit_notices", "sourceId": source, "slug": slug }),
            rows,
        )
    };
    assert_eq!(slug_key("default", "core/a", 10), 0);
    insert(&store, "default", "core/a", "a1", None);
    insert(&store, "default", "core/a", "a2", None);
    insert(&store, "default", "core/a", "a3", None);
    insert(&store, "default", "core/ab", "x", None);
    insert(&store, "other", "core/a", "o1", None);
    assert_eq!(slug_key("default", "core/a", 10), 3);
    assert_eq!(slug_key("default", "core/a", 1), 2, "capped at rows + 1");
    assert_eq!(slug_key("other", "core/a", 10), 1);
    assert_eq!(slug_key("default", "core/ab", 10), 1);
    assert_eq!(slug_key("default", "core/none", 10), 0);
    assert_eq!(slug_key("gone", "core/a", 10), 0);
}

#[test]
fn a_claim_probe_counts_the_sources_notices_whose_base_text_holds_the_claim() {
    let (_dir, store) = brain("notices-claim-probe");
    insert(
        &store,
        "default",
        "core/a",
        "a1",
        Some("The Harbor Will Reopen"),
    );
    insert(
        &store,
        "default",
        "core/a",
        "a2",
        Some("harbor will reopen again"),
    );
    insert(&store, "default", "core/b", "b1", Some("unrelated"));
    store
        .insert_core_edit_notice(&notice("default", "core/c", Some("c1"), None))
        .unwrap();
    insert(&store, "other", "core/a", "o1", Some("harbor will reopen"));
    let claim = |source: &str, needle: &str, rows: i64| {
        store_probe(
            &store,
            json!({ "kind": "claim_text", "store": "core_edit_notices", "sourceId": source,
            "claim": needle, "json": needle, "reason": "x", "reasonJson": "x" }),
            rows,
        )
    };
    assert_eq!(claim("default", "harbor will reopen", 10), 2);
    assert_eq!(
        claim("default", "harbor will reopen", 0),
        1,
        "capped at rows + 1"
    );
    assert_eq!(claim("other", "harbor will reopen", 10), 1);
    assert_eq!(claim("gone", "harbor will reopen", 10), 0);
    assert_eq!(claim("default", "no such claim", 10), 0);
    // The needle is matched as given, so an upper-case needle does not match the lowered text.
    assert_eq!(claim("default", "Harbor", 10), 0);
}

#[test]
fn the_concept_rebuild_reports_a_page_that_a_notice_is_filed_on() {
    let (_dir, store) = brain("notices-concept");
    let lists = gbrain_store::concept_rebuild::StatedKindLists {
        derived_link_sources: vec!["markdown".into()],
        stated_label_keys: vec!["readable_by".into()],
        synthesis_keys: vec!["type".into(), "title".into(), "synthesized_by".into()],
    };
    put(&store, "concepts/held", "default");
    let kinds = |source: &str, slug: &str| {
        store
            .read_concept_stated_kinds(1, source, slug, &lists)
            .unwrap()
            .kinds
    };
    assert!(!kinds("default", "concepts/held").contains(&"core_edit_notices".to_string()));
    insert(&store, "default", "concepts/held", "r1", None);
    assert!(kinds("default", "concepts/held").contains(&"core_edit_notices".to_string()));
    // Another slug or another source is not stated.
    assert!(!kinds("default", "concepts/other").contains(&"core_edit_notices".to_string()));
    assert!(!kinds("other", "concepts/held").contains(&"core_edit_notices".to_string()));
    // An acknowledged notice still states the page: the SQL read has no `acked_at` filter.
    store
        .ack_core_edit_notices("default", "concepts/held", None)
        .unwrap();
    assert!(kinds("default", "concepts/held").contains(&"core_edit_notices".to_string()));
}

#[test]
fn a_source_delete_removes_the_sources_notices_and_no_other() {
    let (_dir, store) = brain("notices-source-delete");
    insert(&store, "gone", "core/a", "g1", Some("text"));
    let g2 = insert(&store, "gone", "core/b", "g2", None);
    store
        .ack_core_edit_notices("gone", "core/b", Some(g2 as i64))
        .unwrap();
    insert(&store, "default", "core/a", "d1", None);
    insert(&store, "other", "core/a", "o1", None);
    assert!(store.delete_source_record("gone", false).unwrap());
    assert_eq!(
        pages_of(&pending(&store, None)),
        [t("default", "core/a", "d1"), t("other", "core/a", "o1")]
    );
    assert_eq!(
        store_probe(
            &store,
            json!({ "kind": "slug_key", "store": "core_edit_notices", "sourceId": "gone", "slug": "core/b" }),
            10
        ),
        0,
        "the acknowledged row went too"
    );
    assert!(
        store
            .find_core_edit_notice_id_by_revision("gone", "core/b", "g2")
            .unwrap()
            .is_none()
    );
    // The id counter keeps going.
    assert_eq!(insert(&store, "default", "core/z", "z", None), 5);
}

#[test]
fn a_snapshot_carries_the_notices_and_its_digest_covers_the_tag() {
    let dir = TempDir::new("notices-snapshot");
    let path = dir.path().join("brain");
    let options = OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&path, options).unwrap();
    insert(&store, "default", "core/a", "a1", Some("base text one"));
    let a2 = insert(&store, "default", "core/a", "a2", Some("base text two"));
    insert(&store, "default", "core/b", "b1", None);
    store
        .ack_core_edit_notices("default", "core/a", Some(a2 as i64))
        .unwrap();
    let target = dir.path().join("copy");
    let manifest = store.snapshot_to(&target, &SnapshotOp::new()).unwrap();
    // Tag `2` (0x32) is in the per-tag inventory with its keys: 3 rows and 3 index entries.
    assert_eq!(manifest.tags["32"].keys, 6);
    let report = verify_store_dir(&target, Some(&manifest)).unwrap();
    assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
    let copy = Store::open_dir_read_only(&target).unwrap();
    let rows = copy.list_pending_core_edit_notices(None).unwrap();
    assert_eq!(pages_of(&rows), [t("default", "core/b", "b1")]);
    assert_eq!(
        copy.find_core_edit_notice_id_by_revision("default", "core/a", "a1")
            .unwrap(),
        Some(1)
    );
    let oldest = copy
        .read_oldest_pending_core_edit_notice("default", "core/b")
        .unwrap()
        .unwrap();
    assert!(oldest["base_text"].is_null());
    copy.close();
    // The copy's digest differs when a notice differs: one more write changes tag 2.
    let before = manifest.tags["32"].sha256.clone();
    insert(&store, "default", "core/c", "c1", None);
    let second = store
        .snapshot_to(&dir.path().join("copy2"), &SnapshotOp::new())
        .unwrap();
    assert_ne!(second.tags["32"].sha256, before);
    assert_eq!(second.tags["32"].keys, 8);
}

#[test]
fn the_keyspace_catalog_names_the_family() {
    let catalog = gbrain_store::keyspaces::keyspace_catalog();
    let space = catalog
        .keyspaces
        .iter()
        .find(|k| k.tag == b'2')
        .expect("tag 2 is listed");
    assert_eq!(space.family, "core_edit_notices");
}
