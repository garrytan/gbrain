//! Pages: the observable behaviour of `readPageSnapshot`, `putPage`, `listPages`,
//! `resolveSlugs`, tags and versions, matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::error::*;
use gbrain_store::pages::{PageFilters, PageInput, PutPageOptions, ReadScope, VersionsOptions};
use gbrain_store::{Store, sources::SourceInput};
use serde_json::{Value, json};

fn input(title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": body})).unwrap()
}

fn opts(v: Value) -> PutPageOptions {
    serde_json::from_value(v).unwrap()
}

fn scope(v: Value) -> ReadScope {
    serde_json::from_value(v).unwrap()
}

fn filters(v: Value) -> PageFilters {
    serde_json::from_value(v).unwrap()
}

fn slugs(pages: &[Value]) -> Vec<String> {
    pages
        .iter()
        .map(|p| p["slug"].as_str().unwrap().to_string())
        .collect()
}

fn put(store: &Store, slug: &str, body: &str) -> Value {
    store
        .put_page(slug, &input(slug, body), &PutPageOptions::default())
        .unwrap()
}

fn code(e: gbrain_store::StoreError) -> &'static str {
    e.code
}

#[test]
fn an_empty_brain_has_no_pages_and_a_missing_slug_is_null() {
    let dir = TempDir::new("pages-empty");
    let store = open(&dir);
    assert!(
        store
            .read_page_snapshot("people/ada", &ReadScope::default())
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .list_pages(&PageFilters::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.count_pages(None).unwrap(), 0);
    assert!(
        store
            .resolve_slugs("ada", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .get_versions("people/ada", &VersionsOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_put_page_reads_back_with_the_page_shape() {
    let dir = TempDir::new("pages-put");
    let store = open(&dir);
    let mut page = input("Ada Lovelace", "Wrote the first program.");
    page.timeline = Some("- 1843: notes".into());
    page.frontmatter = serde_json::from_value(json!({"zebra": 1, "alpha": [1, 2]})).unwrap();
    let put = store
        .put_page("People/Ada", &page, &PutPageOptions::default())
        .unwrap();
    assert_eq!(put["slug"], "people/ada", "slugs are lower-cased");
    assert_eq!(put["source_id"], "default");
    assert_eq!(put["page_kind"], "markdown");
    assert_eq!(put["id"], 1);
    assert_eq!(
        put["text_projection_revision"], put["knowledge_revision"],
        "putPage indexes the page, so its chunks are current"
    );
    assert_eq!(put["deleted_at"], Value::Null);
    assert_eq!(put["content_hash"].as_str().unwrap().len(), 64);
    assert_eq!(put["created_at"], put["updated_at"]);
    assert_eq!(put["updated_at"], put["updated_at_iso"]);
    assert!(put["updated_at"].as_str().unwrap().ends_with('Z'));

    let snap = store
        .read_page_snapshot("people/ada", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(snap["page"], put);
    assert_eq!(snap["revision"], put["knowledge_revision"]);
    assert_eq!(snap["tags"], json!([]));
    assert_eq!(snap["withdrawals"], json!([]));
    assert_eq!(snap["sourceIncarnation"].as_str().unwrap().len(), 36);
    let keys: Vec<&String> = snap["page"]["frontmatter"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["zebra", "alpha"], "frontmatter keeps its key order");
    // An upper-case read finds the page too.
    assert!(
        store
            .read_page_snapshot("PEOPLE/ADA", &ReadScope::default())
            .unwrap()
            .is_some()
    );
}

#[test]
fn an_update_keeps_the_id_and_bumps_the_revision_only_when_content_changes() {
    let dir = TempDir::new("pages-update");
    let store = open(&dir);
    let first = put(&store, "notes/a", "one");
    let same = put(&store, "notes/a", "one");
    assert_eq!(same["id"], first["id"]);
    assert_eq!(
        same["knowledge_revision"], first["knowledge_revision"],
        "no canonical change, same revision"
    );
    assert_eq!(same["created_at"], first["created_at"]);
    assert_ne!(same["updated_at"], first["updated_at"]);
    let changed = put(&store, "notes/a", "two");
    assert_eq!(changed["id"], first["id"]);
    assert_ne!(changed["knowledge_revision"], first["knowledge_revision"]);
    assert_eq!(changed["compiled_truth"], "two");
    assert_eq!(store.count_pages(None).unwrap(), 1);
}

#[test]
fn provenance_and_dates_are_kept_when_a_later_put_leaves_them_out() {
    let dir = TempDir::new("pages-coalesce");
    let store = open(&dir);
    let mut first = input("A", "body");
    first.source_kind = Some("capture-cli".into());
    first.source_path = Some("notes/a.md".into());
    first.import_filename = Some("a".into());
    first.effective_date = Some("2026-01-02".into());
    first.effective_date_source = Some("filename".into());
    let one = store
        .put_page("notes/a", &first, &PutPageOptions::default())
        .unwrap();
    assert_eq!(one["effective_date"], "2026-01-02T00:00:00.000000Z");
    assert!(one["ingested_at"].is_string());
    let two = put(&store, "notes/a", "body, edited");
    for field in [
        "source_kind",
        "source_path",
        "import_filename",
        "effective_date",
        "effective_date_source",
        "ingested_at",
    ] {
        assert_eq!(
            two[field], one[field],
            "{field} survives a put that omits it"
        );
    }
    let mut bad = input("A", "body");
    bad.effective_date = Some("yesterday".into());
    assert_eq!(
        code(
            store
                .put_page("notes/b", &bad, &PutPageOptions::default())
                .unwrap_err()
        ),
        INVALID_ARGUMENT
    );
}

#[test]
fn the_content_hash_is_the_callers_or_sha256_of_the_canonical_envelope() {
    let dir = TempDir::new("pages-hash");
    let store = open(&dir);
    let mut page = input("T", "body");
    page.content_hash = Some("abc".into());
    let given = store
        .put_page("a", &page, &PutPageOptions::default())
        .unwrap();
    assert_eq!(given["content_hash"], "abc");
    // Ephemeral frontmatter keys and tag spelling do not change the hash.
    let mut x = input("T", "body");
    x.frontmatter =
        serde_json::from_value(json!({"tags": ["b", "a"], "captured_at": "now"})).unwrap();
    let mut y = input("T", "body");
    y.tags = Some(vec!["a".into(), "b".into()]);
    y.frontmatter = serde_json::from_value(json!({"captured_at": "later"})).unwrap();
    assert_eq!(
        gbrain_store::pages::content_hash(&x),
        gbrain_store::pages::content_hash(&y)
    );
    // Digests computed by `contentHash` of src/core/utils.ts (bun -e, same session).
    let known = input("T", "body");
    assert_eq!(
        gbrain_store::pages::content_hash(&known),
        "547661ee75a4406caa564621cff6bc15e435d01c269f9d1617d6663f881eaaf2"
    );
    let mut rich = input("Zo\u{eb} \"q\" \u{65e5}\u{672c}", "l1\nl2\t");
    rich.timeline = Some("- a".into());
    rich.frontmatter = serde_json::from_value(
        json!({"z": 1, "a": [1, 2], "tags": ["b", "a"], "captured_at": "x"}),
    )
    .unwrap();
    assert_eq!(
        gbrain_store::pages::content_hash(&rich),
        "702af9919c2577a6148e69b6a86a704f6b8b1d354ff1af5966325f2bb9943640"
    );
}

#[test]
fn bad_slugs_are_refused() {
    let dir = TempDir::new("pages-slugs");
    let store = open(&dir);
    for bad in [
        "",
        "/abs",
        "a/../b",
        "..",
        "a\\b",
        "a\u{0}b",
        "a\u{202e}b",
        "a%2Fb",
        "a\u{7f}b",
    ] {
        let err = store
            .put_page(bad, &input("t", "b"), &PutPageOptions::default())
            .unwrap_err();
        assert_eq!(err.code, INVALID_SLUG, "{bad:?}");
    }
    assert!(
        store
            .put_page("a/..b", &input("t", "b"), &PutPageOptions::default())
            .is_ok()
    );
}

#[test]
fn a_missing_source_is_refused_and_slugs_are_unique_per_source() {
    let dir = TempDir::new("pages-sources");
    let store = open(&dir);
    let err = store
        .put_page("a", &input("t", "b"), &opts(json!({"sourceId": "ghost"})))
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            ..Default::default()
        })
        .unwrap();
    let in_default = put(&store, "shared", "default body");
    let in_work = store
        .put_page(
            "shared",
            &input("shared", "work body"),
            &opts(json!({"sourceId": "work"})),
        )
        .unwrap();
    assert_ne!(in_default["id"], in_work["id"]);
    assert_eq!(in_work["source_id"], "work");
    let read = |v: Value| {
        store
            .read_page_snapshot("shared", &scope(v))
            .unwrap()
            .map(|s| s["page"]["compiled_truth"].clone())
    };
    assert_eq!(read(json!({"sourceId": "work"})), Some(json!("work body")));
    assert_eq!(
        read(json!({"sourceId": "default"})),
        Some(json!("default body"))
    );
    assert_eq!(
        read(json!({})),
        Some(json!("default body")),
        "no scope reads the default source first"
    );
    assert_eq!(
        read(json!({"sourceIds": ["work", "default"]})),
        Some(json!("work body")),
        "the list order decides"
    );
    assert_eq!(read(json!({"sourceId": "ghost"})), None);
    assert_eq!(
        slugs(
            &store
                .list_pages(&filters(json!({"sourceId": "work"})))
                .unwrap()
        ),
        ["shared"]
    );
    assert_eq!(store.list_pages(&PageFilters::default()).unwrap().len(), 2);
    assert_eq!(store.count_pages(Some("work")).unwrap(), 1);
    // The array wins over the scalar.
    let both = filters(json!({"sourceId": "default", "sourceIds": ["work"]}));
    assert_eq!(store.list_pages(&both).unwrap()[0]["source_id"], "work");
}

#[test]
fn a_soft_deleted_page_is_hidden_until_restored() {
    let dir = TempDir::new("pages-soft");
    let store = open(&dir);
    put(&store, "a", "body");
    let revision = put(&store, "a", "body")["knowledge_revision"].clone();
    assert_eq!(
        store.soft_delete_page("a", None).unwrap().as_deref(),
        Some("a")
    );
    assert_eq!(
        store.soft_delete_page("a", None).unwrap(),
        None,
        "already deleted"
    );
    assert!(
        store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .is_none()
    );
    let deleted = store
        .read_page_snapshot("a", &scope(json!({"includeDeleted": true})))
        .unwrap()
        .unwrap();
    assert!(deleted["page"]["deleted_at"].is_string());
    assert_ne!(
        deleted["revision"], revision,
        "deletion is a canonical change"
    );
    assert!(
        store
            .list_pages(&PageFilters::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_pages(&filters(json!({"includeDeleted": true})))
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .resolve_slugs("a", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.count_pages(None).unwrap(), 0);
    assert!(store.restore_page("a", None).unwrap());
    assert!(!store.restore_page("a", None).unwrap());
    assert!(
        store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .is_some()
    );
    // A put over a deleted page revives it.
    store.soft_delete_page("a", None).unwrap();
    let revived = put(&store, "a", "again");
    assert_eq!(revived["deleted_at"], Value::Null);
}

#[test]
fn a_hard_delete_removes_the_page_and_its_versions() {
    let dir = TempDir::new("pages-delete");
    let store = open(&dir);
    put(&store, "a", "body");
    store.create_version("a", None).unwrap();
    store.delete_page("a", None).unwrap();
    assert!(
        store
            .read_page_snapshot("a", &scope(json!({"includeDeleted": true})))
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_versions("a", &VersionsOptions::default())
            .unwrap()
            .is_empty()
    );
    store.delete_page("a", None).unwrap();
}

#[test]
fn expected_revision_has_three_states_and_force_skips_it() {
    let dir = TempDir::new("pages-revision");
    let store = open(&dir);
    let make = |body: &str, o: Value| store.put_page("a", &input("a", body), &opts(o));
    // null: the page must not exist.
    let first = make("one", json!({"expectedRevision": null})).unwrap();
    assert_eq!(
        code(make("two", json!({"expectedRevision": null})).unwrap_err()),
        REVISION_CONFLICT
    );
    // A revision: it must match.
    let revision = first["knowledge_revision"].as_str().unwrap().to_string();
    let second = make("two", json!({"expectedRevision": revision})).unwrap();
    assert_eq!(
        code(make("three", json!({"expectedRevision": revision})).unwrap_err()),
        REVISION_CONFLICT,
        "stale"
    );
    // An upper-case revision matches the stored one.
    let upper = second["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_uppercase();
    assert!(make("three", json!({"expectedRevision": upper})).is_ok());
    // A revision for a page that does not exist.
    let ghost = store.put_page(
        "ghost",
        &input("g", "b"),
        &opts(json!({"expectedRevision": revision})),
    );
    assert_eq!(code(ghost.unwrap_err()), REVISION_CONFLICT);
    // force false and nothing expected is "the page must not exist": revision_required.
    assert_eq!(
        code(make("four", json!({"force": false})).unwrap_err()),
        REVISION_REQUIRED
    );
    // force true skips the check.
    assert!(make("four", json!({"force": true})).is_ok());
    // Absent options do not check at all.
    assert!(make("five", json!({})).is_ok());
    // Malformed.
    assert_eq!(
        code(make("six", json!({"expectedRevision": "not-a-uuid"})).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(make("six", json!({"force": true, "expectedRevision": null})).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        make("seven", json!({})).unwrap()["compiled_truth"],
        "seven",
        "a refused write changed nothing"
    );
}

#[test]
fn a_blank_body_over_a_page_with_content_is_refused() {
    let dir = TempDir::new("pages-empty-overwrite");
    let store = open(&dir);
    put(&store, "a", "real content");
    let err = store
        .put_page("a", &input("a", "  \n "), &PutPageOptions::default())
        .unwrap_err();
    assert_eq!(err.code, EMPTY_OVERWRITE);
    assert_eq!(
        store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]["compiled_truth"],
        "real content"
    );
    // A blank body on a new page, or on a blank page, is fine.
    assert!(
        store
            .put_page("new", &input("n", ""), &PutPageOptions::default())
            .is_ok()
    );
    assert!(
        store
            .put_page("new", &input("n", " "), &PutPageOptions::default())
            .is_ok()
    );
    // Asked for, it overwrites.
    let cleared = store
        .put_page(
            "a",
            &input("a", ""),
            &opts(json!({"allowEmptyOverwrite": true})),
        )
        .unwrap();
    assert_eq!(cleared["compiled_truth"], "");
}

#[test]
fn list_sorts_filters_and_pages() {
    let dir = TempDir::new("pages-list");
    let store = open(&dir);
    for slug in ["b", "a", "c", "d/x", "d/y"] {
        put(&store, slug, slug);
    }
    let mut person = input("P", "p");
    person.page_type = "person".into();
    store
        .put_page("people/p", &person, &PutPageOptions::default())
        .unwrap();
    store.add_tag("a", "red", None).unwrap();
    store.add_tag("b", "red", None).unwrap();
    let list = |v: Value| slugs(&store.list_pages(&filters(v)).unwrap());
    // Newest first, oldest first, by slug.
    assert_eq!(list(json!({}))[0], "people/p");
    assert_eq!(list(json!({"sort": "updated_asc"}))[0], "b");
    assert_eq!(list(json!({"sort": "created_desc"}))[0], "people/p");
    assert_eq!(
        list(json!({"sort": "slug"})),
        ["a", "b", "c", "d/x", "d/y", "people/p"]
    );
    assert_eq!(
        list(json!({"sort": "slug", "limit": 2, "offset": 1})),
        ["b", "c"]
    );
    assert_eq!(
        list(json!({"limit": 0})).len(),
        6,
        "limit 0 means the default"
    );
    // Filters.
    assert_eq!(list(json!({"type": "person"})), ["people/p"]);
    assert_eq!(list(json!({"tag": "red", "sort": "slug"})), ["a", "b"]);
    assert_eq!(
        list(json!({"slugPrefix": "d/", "sort": "slug"})),
        ["d/x", "d/y"]
    );
    assert_eq!(
        list(json!({"slugPrefix": "%", "sort": "slug"})),
        Vec::<String>::new(),
        "the prefix is literal"
    );
    assert_eq!(
        list(json!({"excludeSlugPrefixes": ["d/", "people/", ""], "sort": "slug"})),
        ["a", "b", "c"]
    );
    assert_eq!(
        list(json!({"slugAfter": "c", "sort": "slug"})),
        ["d/x", "d/y", "people/p"]
    );
    // updated_after and the keyset.
    let rows = store
        .list_pages(&filters(json!({"sort": "updated_asc"})))
        .unwrap();
    let cut = rows[2]["updated_at_iso"].as_str().unwrap().to_string();
    assert_eq!(
        list(json!({"sort": "updated_asc", "updated_after": cut})).len(),
        3
    );
    let keyset = json!({"updatedAt": cut, "slug": rows[2]["slug"]});
    assert_eq!(
        list(json!({"sort": "updated_asc", "updatedAfterKeyset": keyset})).len(),
        3
    );
    let keyset_start = json!({"updatedAt": cut, "slug": ""});
    assert_eq!(
        list(json!({"sort": "updated_asc", "updatedAfterKeyset": keyset_start})).len(),
        4,
        "empty slug starts the bucket"
    );
    assert!(
        store
            .list_pages(&filters(json!({"updated_after": "nope"})))
            .is_err()
    );
    assert_eq!(list(json!({"updated_after": "2000-01-01"})).len(), 6);
    assert!(list(json!({"updated_after": "2999-01-01"})).is_empty());
}

#[test]
fn resolve_slugs_answers_only_the_exact_live_slug() {
    let dir = TempDir::new("pages-resolve");
    let store = open(&dir);
    for slug in ["people/ada", "people/adam", "notes/ada-diary"] {
        put(&store, slug, "x");
    }
    let resolve = |p: &str| store.resolve_slugs(p, &ReadScope::default()).unwrap();
    assert_eq!(resolve("people/ada"), ["people/ada"]);
    // A partial name, a different case and a title are the trigram half of PGLite's answer, which
    // this store does not have: the list is empty, and the TypeScript member refuses it.
    assert!(resolve("ADA").is_empty());
    assert!(resolve("people/ad").is_empty());
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            ..Default::default()
        })
        .unwrap();
    let in_work = store
        .resolve_slugs("people/ada", &scope(json!({"sourceId": "work"})))
        .unwrap();
    assert!(in_work.is_empty());
    store.soft_delete_page("people/ada", None).unwrap();
    assert!(
        resolve("people/ada").is_empty(),
        "a soft-deleted page is not resolved"
    );
}

#[test]
fn an_unscoped_soft_delete_and_restore_cover_every_source_and_a_hard_delete_only_the_default() {
    let dir = TempDir::new("pages-unscoped");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            ..Default::default()
        })
        .unwrap();
    let live = |slug: &str, source: &str| {
        store
            .read_page_snapshot(slug, &scope(json!({"sourceId": source})))
            .unwrap()
            .is_some()
    };
    for slug in ["s/one", "s/two"] {
        store
            .put_page(slug, &input("T", "body"), &opts(json!({})))
            .unwrap();
        store
            .put_page(
                slug,
                &input("T", "body"),
                &opts(json!({"sourceId": "work"})),
            )
            .unwrap();
    }
    // One call hides the slug in both sources and reports it once.
    assert_eq!(
        store.soft_delete_page("s/one", None).unwrap().as_deref(),
        Some("s/one")
    );
    assert!(!live("s/one", "default") && !live("s/one", "work"));
    assert!(live("s/two", "default") && live("s/two", "work"));
    assert_eq!(store.soft_delete_page("s/one", None).unwrap(), None);
    // And one call brings both back.
    assert!(store.restore_page("s/one", None).unwrap());
    assert!(live("s/one", "default") && live("s/one", "work"));
    assert!(!store.restore_page("s/one", None).unwrap());
    // A named source is the only one touched.
    store.soft_delete_page("s/one", Some("work")).unwrap();
    assert!(live("s/one", "default") && !live("s/one", "work"));
    // A hard delete with no source is the default source's alone.
    store.delete_page("s/two", None).unwrap();
    assert!(!live("s/two", "default") && live("s/two", "work"));
    // Slugs are matched as written: stored slugs are lower case, so a capitalised one finds nothing.
    assert_eq!(store.soft_delete_page("S/One", None).unwrap(), None);
    store.delete_page("S/One", None).unwrap();
    assert!(live("s/one", "default"));
}

#[test]
fn tags_are_added_removed_and_change_the_revision() {
    let dir = TempDir::new("pages-tags");
    let store = open(&dir);
    let page = put(&store, "a", "body");
    assert_eq!(
        store.add_tag("ghost", "x", None).unwrap_err().code,
        PAGE_NOT_FOUND
    );
    store.add_tag("a", "zed", None).unwrap();
    store.add_tag("a", "alpha", None).unwrap();
    store.add_tag("a", "alpha", None).unwrap();
    assert_eq!(
        store.get_tags("a", &ReadScope::default()).unwrap(),
        ["alpha", "zed"]
    );
    let snap = store
        .read_page_snapshot("a", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(snap["tags"], json!(["alpha", "zed"]));
    assert_ne!(snap["revision"], page["knowledge_revision"]);
    let before = snap["revision"].clone();
    store.add_tag("a", "alpha", None).unwrap();
    assert_eq!(
        store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .unwrap()["revision"],
        before,
        "a no-op keeps the revision"
    );
    store.remove_tag("a", "zed", None).unwrap();
    store.remove_tag("a", "never", None).unwrap();
    store.remove_tag("ghost", "x", None).unwrap();
    assert_eq!(
        store.get_tags("a", &ReadScope::default()).unwrap(),
        ["alpha"]
    );
    assert!(
        store
            .get_tags("ghost", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn versions_are_snapshots_listed_newest_first() {
    let dir = TempDir::new("pages-versions");
    let store = open(&dir);
    assert_eq!(
        store.create_version("ghost", None).unwrap_err().code,
        PAGE_NOT_FOUND
    );
    put(&store, "a", "one");
    store.add_tag("a", "t", None).unwrap();
    let v1 = store.create_version("a", None).unwrap();
    put(&store, "a", "two");
    let v2 = store.create_version("a", None).unwrap();
    assert_eq!(v1["compiled_truth"], "one");
    assert_eq!(v1["tags"], json!(["t"]));
    assert_eq!(v1["is_deleted"], false);
    assert!(v2["id"].as_u64() > v1["id"].as_u64());
    let all = store
        .get_versions("a", &VersionsOptions::default())
        .unwrap();
    assert_eq!(
        all.iter()
            .map(|v| v["compiled_truth"].clone())
            .collect::<Vec<_>>(),
        [json!("two"), json!("one")]
    );
    let limited = store
        .get_versions(
            "a",
            &serde_json::from_value(json!({"limit": 1, "includeBody": false})).unwrap(),
        )
        .unwrap();
    assert_eq!(limited.len(), 1);
    assert!(limited[0].get("compiled_truth").is_none() && limited[0].get("timeline").is_none());
    assert_eq!(limited[0]["knowledge_revision"], v2["knowledge_revision"]);
    let none = store
        .get_versions(
            "a",
            &serde_json::from_value(json!({"sourceId": "other"})).unwrap(),
        )
        .unwrap();
    assert!(none.is_empty());
}

#[test]
fn lock_page_keys_checks_the_keys() {
    let dir = TempDir::new("pages-lock");
    let store = open(&dir);
    let ok: Vec<gbrain_store::pages::PageKey> =
        serde_json::from_value(json!([{"sourceId": "default", "slug": "a"}])).unwrap();
    store.lock_page_keys(&ok).unwrap();
    let bad: Vec<gbrain_store::pages::PageKey> =
        serde_json::from_value(json!([{"sourceId": "default", "slug": "../a"}])).unwrap();
    assert_eq!(store.lock_page_keys(&bad).unwrap_err().code, INVALID_SLUG);
    store.lock_page_keys(&[]).unwrap();
}

#[test]
fn pages_survive_a_reopen_and_ids_keep_counting() {
    let dir = TempDir::new("pages-reopen");
    let (revision, id) = {
        let store = open(&dir);
        let page = put(&store, "a", "body");
        store.add_tag("a", "t", None).unwrap();
        store.create_version("a", None).unwrap();
        let snap = store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .unwrap();
        store.close();
        (snap["revision"].clone(), page["id"].clone())
    };
    let store = open(&dir);
    let snap = store
        .read_page_snapshot("a", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(snap["revision"], revision);
    assert_eq!(snap["page"]["id"], id);
    assert_eq!(snap["tags"], json!(["t"]));
    assert_eq!(
        store
            .get_versions("a", &VersionsOptions::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(put(&store, "b", "x")["id"], 2);
    assert_eq!(store.create_version("b", None).unwrap()["id"], 2);
}
