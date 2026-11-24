//! Slug renames, slug aliases, page aliases and contextual retrieval state. The PGLite parity
//! cases are in test/engine-parity/sync-aliases.test.ts; these cover what they cannot show:
//! durability across a reopen, the hard-delete rules, the rename's alias bookkeeping, the
//! visibility filter of `resolveAliases` and the inputs this engine refuses.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::aliases::*;
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope, VersionsOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use std::time::Duration;

fn put_in(store: &Store, slug: &str, title: &str, frontmatter: Value, source: Option<&str>) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note",
        "title": title,
        "compiled_truth": format!("{slug} body"),
        "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn put(store: &Store, slug: &str) {
    put_in(store, slug, slug, json!({}), None);
}

fn source(store: &Store, id: &str) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
    store.upsert_source(&input).unwrap();
}

fn page_in(store: &Store, slug: &str, source: &str) -> Option<Value> {
    let scope = ReadScope {
        source_id: Some(source.to_string()),
        include_deleted: true,
        ..ReadScope::default()
    };
    store
        .read_page_snapshot(slug, &scope)
        .unwrap()
        .map(|s| s["page"].clone())
}

fn page(store: &Store, slug: &str) -> Value {
    page_in(store, slug, "default").unwrap()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

fn set(store: &Store, slug: &str, source: &str, aliases: &[&str]) -> Result<()> {
    store.set_page_aliases(slug, source, &strings(aliases))
}

/// `resolveAliases` as `alias -> ["source/slug", ...]`.
fn resolve(store: &Store, aliases: &[&str], scope: Value) -> Vec<(String, Vec<String>)> {
    let scope: AliasScope = serde_json::from_value(scope).unwrap();
    store
        .resolve_aliases(&strings(aliases), &scope)
        .unwrap()
        .into_iter()
        .map(|(alias, refs)| {
            let refs = refs
                .into_iter()
                .map(|r| format!("{}/{}", r.source_id, r.slug))
                .collect();
            (alias, refs)
        })
        .collect()
}

fn pair(alias: &str, refs: &[&str]) -> (String, Vec<String>) {
    (alias.to_string(), strings(refs))
}

fn canonical(store: &Store, slug: &str, sources: &[&str]) -> Option<(String, String, usize)> {
    store
        .resolve_slug_with_alias_detailed(slug, &strings(sources), None)
        .unwrap()
        .map(|m| (m.canonical_slug, m.source_id, m.matches))
}

fn tick() {
    std::thread::sleep(Duration::from_millis(2));
}

#[test]
fn page_aliases_are_deduplicated_replaced_and_cleared() {
    let dir = TempDir::new("aliases-set");
    let store = open(&dir);
    put(&store, "people/alice");
    set(
        &store,
        "people/alice",
        "default",
        &["ally", "alice example", "ally", ""],
    )
    .unwrap();
    assert_eq!(
        resolve(&store, &["ally", "alice example", "nobody"], json!({})),
        vec![
            pair("alice example", &["default/people/alice"]),
            pair("ally", &["default/people/alice"]),
        ]
    );
    set(&store, "people/alice", "default", &["al"]).unwrap();
    assert_eq!(
        resolve(&store, &["ally", "al"], json!({})),
        vec![pair("al", &["default/people/alice"])]
    );
    set(&store, "people/alice", "default", &[]).unwrap();
    assert!(resolve(&store, &["al"], json!({})).is_empty());
    assert!(resolve(&store, &[], json!({})).is_empty());
}

#[test]
fn page_aliases_need_a_known_source_only_to_insert() {
    let dir = TempDir::new("aliases-source");
    let store = open(&dir);
    let err = set(&store, "notes/a", "nowhere", &["x"]).unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
    set(&store, "notes/a", "nowhere", &[]).unwrap();
    set(&store, "notes/a", "nowhere", &["", ""]).unwrap();
    let err = set(&store, "notes/a", "default", &["a\0b"]).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn resolve_aliases_is_source_scoped_and_hides_pages_that_are_not_live() {
    let dir = TempDir::new("aliases-scope");
    let store = open(&dir);
    source(&store, "other");
    put(&store, "people/a");
    put_in(&store, "people/b", "people/b", json!({}), Some("other"));
    put_in(
        &store,
        "people/q",
        "people/q",
        json!({ "quarantine": true }),
        None,
    );
    put(&store, "people/gone");
    set(&store, "people/a", "default", &["shared"]).unwrap();
    set(&store, "people/b", "other", &["shared"]).unwrap();
    set(&store, "people/q", "default", &["quiet"]).unwrap();
    set(&store, "people/gone", "default", &["gone"]).unwrap();
    store.soft_delete_page("people/gone", None).unwrap();

    assert_eq!(
        resolve(&store, &["shared", "quiet", "gone"], json!({})),
        vec![pair("shared", &["default/people/a", "other/people/b"])]
    );
    assert_eq!(
        resolve(&store, &["shared"], json!({ "sourceId": "other" })),
        vec![pair("shared", &["other/people/b"])]
    );
    assert_eq!(
        resolve(
            &store,
            &["shared"],
            json!({ "sourceId": "other", "sourceIds": ["default"] })
        ),
        vec![pair("shared", &["default/people/a"])]
    );
    store.set_source_archived("other", true).unwrap();
    assert_eq!(
        resolve(&store, &["shared"], json!({})),
        vec![pair("shared", &["default/people/a"])]
    );
}

#[test]
fn resolve_aliases_under_exclude_private_hides_the_aliases_of_private_pages() {
    let dir = TempDir::new("aliases-private");
    let store = open(&dir);
    source(&store, "other");
    put(&store, "people/open");
    put_in(
        &store,
        "people/hidden",
        "hidden",
        json!({ "visibility": "private" }),
        None,
    );
    put_in(
        &store,
        "people/by-access",
        "access",
        json!({ "access": "private" }),
        None,
    );
    put_in(&store, "people/b", "b", json!({}), Some("other"));
    set(&store, "people/open", "default", &["shared", "open"]).unwrap();
    set(&store, "people/hidden", "default", &["shared", "hid"]).unwrap();
    set(&store, "people/by-access", "default", &["acc"]).unwrap();
    set(&store, "people/b", "other", &["shared"]).unwrap();
    let names = ["shared", "open", "hid", "acc"];
    let everything = vec![
        pair("acc", &["default/people/by-access"]),
        pair("hid", &["default/people/hidden"]),
        pair("open", &["default/people/open"]),
        pair(
            "shared",
            &[
                "default/people/hidden",
                "default/people/open",
                "other/people/b",
            ],
        ),
    ];
    assert_eq!(resolve(&store, &names, json!({})), everything);
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"});
    assert_eq!(
        resolve(&store, &names, json!({ "excludePrivate": policy })),
        vec![
            pair("open", &["default/people/open"]),
            pair("shared", &["default/people/open", "other/people/b"]),
        ]
    );
    // Without the alias-key test (`honorAliases` false) only `visibility` hides a page.
    let visibility_only = json!({ "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"});
    assert_eq!(
        resolve(&store, &names, json!({ "excludePrivate": visibility_only })),
        vec![
            pair("acc", &["default/people/by-access"]),
            pair("open", &["default/people/open"]),
            pair("shared", &["default/people/open", "other/people/b"]),
        ]
    );
    assert_eq!(
        resolve(
            &store,
            &names,
            json!({ "sourceId": "default", "excludePrivate": policy })
        ),
        vec![
            pair("open", &["default/people/open"]),
            pair("shared", &["default/people/open"]),
        ]
    );
}

#[test]
fn alias_rows_outlive_a_hard_delete_and_answer_for_a_new_page() {
    let dir = TempDir::new("aliases-hard-delete");
    let store = open(&dir);
    put(&store, "people/a");
    set(&store, "people/a", "default", &["ay"]).unwrap();
    store.delete_page("people/a", None).unwrap();
    assert!(resolve(&store, &["ay"], json!({})).is_empty());
    put(&store, "people/a");
    assert_eq!(
        resolve(&store, &["ay"], json!({})),
        vec![pair("ay", &["default/people/a"])]
    );
}

#[test]
fn contextual_retrieval_state_reads_back_and_survives_a_reopen() {
    let dir = TempDir::new("aliases-cr");
    {
        let store = open(&dir);
        put(&store, "notes/cr");
        let before = page(&store, "notes/cr");
        assert!(before.get("contextual_retrieval_mode").is_none());
        tick();
        store
            .update_page_contextual_retrieval_state("notes/cr", "default", "title", Some("gen-1"))
            .unwrap();
        let after = page(&store, "notes/cr");
        assert_eq!(after["contextual_retrieval_mode"], "title");
        assert_eq!(after["knowledge_revision"], before["knowledge_revision"]);
        assert_eq!(after["compiled_truth"], before["compiled_truth"]);
        assert_ne!(after["updated_at"], before["updated_at"]);
    }
    let store = open(&dir);
    assert_eq!(
        page(&store, "notes/cr")["contextual_retrieval_mode"],
        "title"
    );
    store
        .update_page_contextual_retrieval_state("notes/cr", "default", "none", None)
        .unwrap();
    assert_eq!(
        page(&store, "notes/cr")["contextual_retrieval_mode"],
        "none"
    );
    // A body write keeps the state, as a putPage without `contextualRetrieval` does.
    put(&store, "notes/cr");
    assert_eq!(
        page(&store, "notes/cr")["contextual_retrieval_mode"],
        "none"
    );
    // A hard delete removes it with the page.
    store.delete_page("notes/cr", None).unwrap();
    put(&store, "notes/cr");
    assert!(
        page(&store, "notes/cr")
            .get("contextual_retrieval_mode")
            .is_none()
    );
}

#[test]
fn contextual_retrieval_state_skips_a_missing_or_deleted_page() {
    let dir = TempDir::new("aliases-cr-skip");
    let store = open(&dir);
    put(&store, "notes/gone");
    store.soft_delete_page("notes/gone", None).unwrap();
    let before = page(&store, "notes/gone");
    store
        .update_page_contextual_retrieval_state("notes/gone", "default", "title", None)
        .unwrap();
    store
        .update_page_contextual_retrieval_state("notes/none", "default", "title", None)
        .unwrap();
    let after = page(&store, "notes/gone");
    assert_eq!(after, before);
    assert!(after.get("contextual_retrieval_mode").is_none());
}

#[test]
fn a_rename_moves_the_page_and_records_the_old_slug() {
    let dir = TempDir::new("aliases-rename");
    let store = open(&dir);
    source(&store, "other");
    put(&store, "notes/a");
    put_in(&store, "notes/a", "notes/a", json!({}), Some("other"));
    let before = page(&store, "notes/a");
    assert_eq!(store.update_slug("notes/a", "Notes/B", None).unwrap(), 1);
    assert!(page_in(&store, "notes/a", "default").is_none());
    let after = page(&store, "notes/b");
    assert_eq!(after["id"], before["id"]);
    assert_ne!(after["knowledge_revision"], before["knowledge_revision"]);
    assert_eq!(
        canonical(&store, "notes/a", &["default"]),
        Some(("notes/b".into(), "default".into(), 1))
    );
    assert_eq!(canonical(&store, "notes/a", &["other"]), None);
    assert_eq!(canonical(&store, "notes/a", &[]), None);
    assert!(page_in(&store, "notes/a", "other").is_some());
    // The page as it stood before the move is a version of the moved page.
    let versions = store
        .get_versions("notes/b", &VersionsOptions::default())
        .unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0]["compiled_truth"], "notes/a body");
}

#[test]
fn renames_repoint_earlier_aliases_and_drop_the_one_a_page_now_owns() {
    let dir = TempDir::new("aliases-repoint");
    let store = open(&dir);
    put(&store, "notes/a");
    store.update_slug("notes/a", "notes/b", None).unwrap();
    store.update_slug("notes/b", "notes/c", None).unwrap();
    assert_eq!(
        canonical(&store, "notes/a", &["default"]),
        Some(("notes/c".into(), "default".into(), 1))
    );
    assert_eq!(
        canonical(&store, "notes/b", &["default"]),
        Some(("notes/c".into(), "default".into(), 1))
    );
    // Moving back onto an alias drops it: a page owns that slug again.
    store.update_slug("notes/c", "notes/a", None).unwrap();
    assert_eq!(canonical(&store, "notes/a", &["default"]), None);
    assert_eq!(
        canonical(&store, "notes/b", &["default"]),
        Some(("notes/a".into(), "default".into(), 1))
    );
    assert_eq!(
        canonical(&store, "notes/c", &["default"]),
        Some(("notes/a".into(), "default".into(), 1))
    );
}

#[test]
fn a_federated_lookup_takes_the_first_source_and_counts_the_matches() {
    let dir = TempDir::new("aliases-federated");
    let store = open(&dir);
    source(&store, "other");
    put(&store, "notes/x");
    put_in(&store, "notes/x", "notes/x", json!({}), Some("other"));
    store.update_slug("notes/x", "notes/y", None).unwrap();
    store
        .update_slug("notes/x", "notes/z", Some("other"))
        .unwrap();
    assert_eq!(
        canonical(&store, "notes/x", &["other", "default", "other"]),
        Some(("notes/z".into(), "other".into(), 2))
    );
    assert_eq!(
        canonical(&store, "notes/x", &["default", "other"]),
        Some(("notes/y".into(), "default".into(), 2))
    );
}

#[test]
fn a_rename_moves_the_page_aliases() {
    let dir = TempDir::new("aliases-rename-move");
    let store = open(&dir);
    put(&store, "people/a");
    set(&store, "people/a", "default", &["ay", "shared"]).unwrap();
    // Rows already held by the new slug merge with the moved ones.
    set(&store, "people/b", "default", &["shared", "bee"]).unwrap();
    store.update_slug("people/a", "people/b", None).unwrap();
    assert_eq!(
        resolve(&store, &["ay", "bee", "shared"], json!({})),
        vec![
            pair("ay", &["default/people/b"]),
            pair("bee", &["default/people/b"]),
            pair("shared", &["default/people/b"]),
        ]
    );
    // setPageAliases on the new slug now replaces every moved row.
    set(&store, "people/b", "default", &["only"]).unwrap();
    assert!(resolve(&store, &["ay", "bee", "shared"], json!({})).is_empty());
}

#[test]
fn a_refused_rename_keeps_nothing() {
    let dir = TempDir::new("aliases-refused");
    let store = open(&dir);
    put(&store, "notes/a");
    put(&store, "notes/b");
    set(&store, "notes/a", "default", &["ay"]).unwrap();
    let before = page(&store, "notes/a");
    let err = store.update_slug("notes/a", "notes/b", None).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = store
        .update_slug("notes/a", "notes/../escape", None)
        .unwrap_err();
    assert_eq!(err.code, INVALID_SLUG);
    assert_eq!(page(&store, "notes/a"), before);
    assert_eq!(canonical(&store, "notes/a", &["default"]), None);
    assert_eq!(
        resolve(&store, &["ay"], json!({})),
        vec![pair("ay", &["default/notes/a"])]
    );
    let versions = store
        .get_versions("notes/a", &VersionsOptions::default())
        .unwrap();
    assert!(versions.is_empty());
}

#[test]
fn a_rename_of_nothing_or_onto_itself() {
    let dir = TempDir::new("aliases-noop");
    let store = open(&dir);
    assert_eq!(store.update_slug("notes/none", "notes/x", None).unwrap(), 0);
    assert_eq!(
        store
            .update_slug("notes/none", "notes/x", Some("nowhere"))
            .unwrap(),
        0
    );
    put(&store, "notes/a");
    let before = page(&store, "notes/a");
    tick();
    assert_eq!(store.update_slug("notes/a", "notes/a", None).unwrap(), 1);
    let after = page(&store, "notes/a");
    assert_ne!(after["updated_at"], before["updated_at"]);
    assert_eq!(after["knowledge_revision"], before["knowledge_revision"]);
    assert_eq!(canonical(&store, "notes/a", &["default"]), None);
}

#[test]
fn a_rename_moves_a_soft_deleted_page_and_keeps_its_state() {
    let dir = TempDir::new("aliases-rename-deleted");
    let store = open(&dir);
    put(&store, "notes/a");
    store
        .update_page_contextual_retrieval_state("notes/a", "default", "title", None)
        .unwrap();
    store.soft_delete_page("notes/a", None).unwrap();
    assert_eq!(store.update_slug("notes/a", "notes/b", None).unwrap(), 1);
    let moved = page(&store, "notes/b");
    assert!(!moved["deleted_at"].is_null());
    assert_eq!(moved["contextual_retrieval_mode"], "title");
}

fn canonical_refs(store: &Store, refs: &[(&str, &str)], policy: Value) -> Vec<String> {
    let mut query = json!({
        "refs": refs.iter().map(|(s, slug)| json!({ "source_id": s, "slug": slug })).collect::<Vec<_>>(),
    });
    query
        .as_object_mut()
        .unwrap()
        .extend(policy.as_object().unwrap().clone());
    let query: AliasCanonicalQuery = serde_json::from_value(query).unwrap();
    store
        .alias_canonical_refs(&query)
        .unwrap()
        .iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["source_id"].as_str().unwrap(),
                r["canonical_slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn alias_canonical_refs_reads_live_and_private_pages_by_policy() {
    let dir = TempDir::new("aliases-canonical");
    let store = open(&dir);
    source(&store, "other");
    for slug in ["c/open", "c/private", "c/gone", "c/quiet"] {
        put(&store, &format!("{slug}-old"));
        store
            .update_slug(&format!("{slug}-old"), slug, None)
            .unwrap();
    }
    put_in(&store, "c/away-old", "away", json!({}), Some("other"));
    store
        .update_slug("c/away-old", "c/away", Some("other"))
        .unwrap();
    put_in(
        &store,
        "c/private",
        "p",
        json!({ "visibility": "private" }),
        None,
    );
    put_in(&store, "c/quiet", "q", json!({ "quarantine": true }), None);
    store.soft_delete_page("c/gone", None).unwrap();
    put(&store, "c/plain");
    let refs = [
        ("default", "c/quiet"),
        ("default", "c/open"),
        ("default", "c/private"),
        ("default", "c/gone"),
        ("default", "c/plain"),
        ("other", "c/away"),
        ("default", "c/open"),
        ("default", "c/open-old"),
        ("default", "c/\0nul"),
    ];
    let all = strings(&[
        "default/c/gone",
        "default/c/open",
        "default/c/private",
        "default/c/quiet",
        "other/c/away",
    ]);
    assert_eq!(canonical_refs(&store, &refs, json!({})), all);
    assert_eq!(
        canonical_refs(&store, &refs, json!({ "live": true })),
        strings(&["default/c/open", "default/c/private", "other/c/away"])
    );
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" });
    assert_eq!(
        canonical_refs(
            &store,
            &refs,
            json!({ "live": true, "exclude_private": policy })
        ),
        strings(&["default/c/open", "other/c/away"])
    );
    assert_eq!(
        canonical_refs(&store, &refs, json!({ "source_ids": ["other"] })),
        strings(&["other/c/away"])
    );
    store.set_source_archived("other", true).unwrap();
    assert_eq!(
        canonical_refs(&store, &refs, json!({ "live": true })),
        strings(&["default/c/open", "default/c/private"])
    );
    assert!(canonical_refs(&store, &[], json!({ "live": true })).is_empty());
}

/// [`put_in`] in a transaction that declares `tier` as the writer's trust tier.
fn put_at(store: &Store, tier: &str, slug: &str, title: &str) {
    let tx = store.begin_transaction(false).unwrap();
    let names = ["gbrain.write_trust_tier", "gbrain.write_origin"].map(String::from);
    tx.apply_write_trust(
        &names,
        &[tier.to_string(), r#"{"channel":"test"}"#.to_string()],
    )
    .unwrap();
    put_in(&tx, slug, title, json!({}), None);
    tx.commit_transaction().unwrap();
}

/// A `flag` write-gate receipt on the page, in `families`.
fn flag(store: &Store, slug: &str, families: &[&str]) {
    let families: Vec<String> = families.iter().map(|f| f.to_string()).collect();
    let fields = gbrain_store::trust::write_gate::ReceiptFields {
        content_hash: "h1".into(),
        tier: "agent_written".into(),
        detector_version: 1,
        verdict: "flag".into(),
        reason_families: families.clone(),
        reasons: families,
        detector_error: false,
        request_id: None,
    };
    assert!(
        store
            .upsert_page_write_gate_receipt("default", slug, fields)
            .unwrap()
            .is_some()
    );
}

fn declare(store: &Store, slug: &str, alias: &str) {
    let row: DerivedAliasRow =
        serde_json::from_value(json!({ "alias_norm": alias, "origin": "declared" })).unwrap();
    store
        .replace_derived_aliases(slug, "default", &[row])
        .unwrap();
}

#[test]
fn resolve_aliases_applies_the_trust_floor_and_the_flag_filter_to_aliases_and_title_shadows() {
    let dir = TempDir::new("aliases-trust");
    let store = open(&dir);
    put_at(&store, "operator_curated", "c/curated", "Curated");
    put_at(&store, "agent_written", "c/agent", "Agent");
    put_at(&store, "agent_written", "c/flagged", "Flagged");
    flag(&store, "c/flagged", &["override"]);
    put_at(&store, "external_untrusted", "c/outside", "Outside");
    put_at(&store, "operator_curated", "c/fallback", "Fallback");
    put_at(&store, "operator_curated", "c/target", "Target");
    put_at(&store, "external_untrusted", "n/shadow", "Low Shadow");
    for (slug, alias) in [
        ("c/curated", "curated"),
        ("c/agent", "agent"),
        ("c/flagged", "flagged"),
        ("c/outside", "shared"),
    ] {
        set(&store, slug, "default", &[alias]).unwrap();
    }
    declare(&store, "c/fallback", "shared");
    declare(&store, "c/target", "low shadow");
    let names = ["agent", "curated", "flagged", "low shadow", "shared"];
    assert_eq!(
        resolve(&store, &names, json!({})),
        vec![
            pair("agent", &["default/c/agent"]),
            pair("curated", &["default/c/curated"]),
            pair("flagged", &["default/c/flagged"]),
            pair("shared", &["default/c/outside"]),
        ]
    );
    assert_eq!(
        resolve(&store, &names, json!({ "minTrust": "agent_written" })),
        vec![
            pair("agent", &["default/c/agent"]),
            pair("curated", &["default/c/curated"]),
            pair("flagged", &["default/c/flagged"]),
            pair("low shadow", &["default/c/target"]),
            pair("shared", &["default/c/fallback"]),
        ]
    );
    assert_eq!(
        resolve(&store, &names, json!({ "minTrust": "operator_curated" })),
        vec![
            pair("curated", &["default/c/curated"]),
            pair("low shadow", &["default/c/target"]),
            pair("shared", &["default/c/fallback"]),
        ]
    );
    assert_eq!(
        resolve(&store, &names, json!({ "suppressFlagged": true })),
        vec![
            pair("agent", &["default/c/agent"]),
            pair("curated", &["default/c/curated"]),
            pair("shared", &["default/c/outside"]),
        ]
    );
    let scope: AliasScope = serde_json::from_value(json!({ "minTrust": "trusted" })).unwrap();
    let err = store
        .resolve_aliases(&strings(&["agent"]), &scope)
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn resolve_aliases_applies_the_page_policy_to_aliases_and_title_shadows() {
    let dir = TempDir::new("aliases-private");
    let store = open(&dir);
    put(&store, "c/open");
    put_in(
        &store,
        "c/private",
        "p",
        json!({ "visibility": "private" }),
        None,
    );
    put_in(
        &store,
        "c/readers",
        "r",
        json!({ "readable_by": ["alice-example"] }),
        None,
    );
    put_in(
        &store,
        "c/restricted",
        "x",
        json!({ "access": "Restricted" }),
        None,
    );
    put(&store, "c/target");
    put_in(
        &store,
        "n/crm",
        "Acme Example",
        json!({ "visibility": "private" }),
        None,
    );
    set(&store, "c/open", "default", &["open"]).unwrap();
    set(&store, "c/private", "default", &["private"]).unwrap();
    set(&store, "c/readers", "default", &["readers"]).unwrap();
    set(&store, "c/restricted", "default", &["restricted"]).unwrap();
    declare(&store, "c/target", "acme example");
    let names = ["acme example", "open", "private", "readers", "restricted"];
    assert_eq!(
        resolve(&store, &names, json!({})),
        vec![
            pair("open", &["default/c/open"]),
            pair("private", &["default/c/private"]),
            pair("readers", &["default/c/readers"]),
            pair("restricted", &["default/c/restricted"]),
        ]
    );
    let policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" });
    assert_eq!(
        resolve(&store, &names, json!({ "excludePrivate": policy })),
        vec![
            pair("acme example", &["default/c/target"]),
            pair("open", &["default/c/open"]),
        ]
    );
    let no_aliases = json!({ "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn" });
    assert_eq!(
        resolve(&store, &names, json!({ "excludePrivate": no_aliases })),
        vec![
            pair("acme example", &["default/c/target"]),
            pair("open", &["default/c/open"]),
            pair("restricted", &["default/c/restricted"]),
        ]
    );
}

/// `listAliasTargets` as `(source/slug, page, page_aliases, slug_redirects)`.
fn targets(store: &Store, sources: Option<&[&str]>) -> Vec<(String, &'static str, u64, u64)> {
    let ids = sources.map(strings);
    store
        .list_alias_targets(ids.as_deref())
        .unwrap()
        .into_iter()
        .map(|t| {
            (
                format!("{}/{}", t.source_id, t.slug),
                t.page,
                t.page_aliases,
                t.slug_redirects,
            )
        })
        .collect()
}

#[test]
fn alias_targets_name_missing_and_soft_deleted_pages_and_the_delete_takes_only_missing_ones() {
    let dir = TempDir::new("aliases-orphans");
    let store = open(&dir);
    source(&store, "work");
    // notes/b: renamed away to notes/c, so notes/b is a rename redirect (alias) pointing at notes/c.
    put(&store, "notes/b");
    store.update_slug("notes/b", "notes/c", None).unwrap();
    set(&store, "notes/c", "default", &["see", "cee"]).unwrap();
    put(&store, "notes/live");
    set(&store, "notes/live", "default", &["alive"]).unwrap();
    put(&store, "notes/soft");
    set(&store, "notes/soft", "default", &["soft"]).unwrap();
    store.soft_delete_page("notes/soft", None).unwrap();
    put_in(&store, "notes/w", "w", json!({}), Some("work"));
    set(&store, "notes/w", "work", &["dub"]).unwrap();
    store.delete_page("notes/c", None).unwrap();
    store.delete_page("notes/w", Some("work")).unwrap();
    assert!(store.list_alias_targets(Some(&[])).unwrap().is_empty());
    assert_eq!(
        targets(&store, None),
        vec![
            ("default/notes/c".into(), "missing", 2, 1),
            ("default/notes/soft".into(), "soft_deleted", 1, 0),
            ("work/notes/w".into(), "missing", 1, 0),
        ]
    );
    assert_eq!(
        targets(&store, Some(&["work"])),
        vec![("work/notes/w".into(), "missing", 1, 0)]
    );
    // A soft-deleted page keeps its rows; a live page keeps its rows; a missing one loses both tables'.
    assert_eq!(
        store
            .delete_orphaned_aliases("default", "notes/soft")
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .delete_orphaned_aliases("default", "notes/live")
            .unwrap(),
        0
    );
    assert_eq!(
        store.delete_orphaned_aliases("default", "notes/c").unwrap(),
        3
    );
    assert_eq!(
        store.delete_orphaned_aliases("default", "notes/c").unwrap(),
        0
    );
    assert_eq!(
        targets(&store, None),
        vec![
            ("default/notes/soft".into(), "soft_deleted", 1, 0),
            ("work/notes/w".into(), "missing", 1, 0)
        ]
    );
    assert_eq!(
        resolve(&store, &["alive"], json!({})),
        vec![pair("alive", &["default/notes/live"])]
    );
    let err = store
        .delete_orphaned_aliases("default", "a\0b")
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn list_slug_aliases_reads_one_source_in_alias_order_and_survives_a_reopen() {
    let dir = TempDir::new("aliases-list");
    {
        let store = open(&dir);
        source(&store, "other");
        put(&store, "notes/m");
        put(&store, "notes/a");
        put_in(&store, "notes/a", "notes/a", json!({}), Some("other"));
        store.update_slug("notes/m", "notes/n", None).unwrap();
        store.update_slug("notes/a", "notes/b", None).unwrap();
        store.update_slug("notes/b", "notes/c", None).unwrap();
        store
            .update_slug("notes/a", "notes/z", Some("other"))
            .unwrap();
    }
    let store = open(&dir);
    let rows = |source: &str| -> Vec<(String, String)> {
        store
            .list_slug_aliases(source)
            .unwrap()
            .into_iter()
            .map(|r| {
                (
                    r["alias_slug"].as_str().unwrap().to_string(),
                    r["canonical_slug"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    let pair = |a: &str, c: &str| (a.to_string(), c.to_string());
    assert_eq!(
        rows("default"),
        vec![
            pair("notes/a", "notes/c"),
            pair("notes/b", "notes/c"),
            pair("notes/m", "notes/n"),
        ]
    );
    assert_eq!(rows("other"), vec![pair("notes/a", "notes/z")]);
    assert!(rows("missing").is_empty());
    assert!(rows("bad\0id").is_empty());
}
