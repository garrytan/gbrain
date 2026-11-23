//! Pages: the observable behaviour of `readPageSnapshot`, `putPage`, `listPages`,
//! `resolveSlugs`, tags and versions, matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::cli_reads::import::{PageTrustKey, PageTrustLookup};
use gbrain_store::error::*;
use gbrain_store::pages::{
    PageFilters, PageInput, PageTrustRestore, PutPageOptions, ReadScope, VersionReasonStamp,
    VersionsOptions,
};
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
    // jsonb keeps no insertion order: Postgres gives keys shorter first, then by bytes.
    assert_eq!(
        keys,
        ["alpha", "zebra"],
        "frontmatter reads in Postgres jsonb key order"
    );
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
fn resolve_slugs_answers_the_exact_live_slug_then_the_fuzzy_half() {
    let dir = TempDir::new("pages-resolve");
    let store = open(&dir);
    for slug in ["people/ada", "people/adam", "notes/ada-diary"] {
        put(&store, slug, "x");
    }
    let resolve = |p: &str| store.resolve_slugs(p, &ReadScope::default()).unwrap();
    assert_eq!(resolve("people/ada"), ["people/ada"]);
    // No exact slug: the fuzzy half lists slugs containing the name (any case) or titles similar
    // to it, best title similarity first (the titles are the slugs). Expected rows read from
    // Postgres 16 with the same WHERE and ORDER BY.
    assert_eq!(
        resolve("ADA"),
        ["people/ada", "notes/ada-diary", "people/adam"]
    );
    assert_eq!(resolve("people/ad"), ["people/ada", "people/adam"]);
    assert!(resolve("zz").is_empty());
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
    assert_eq!(
        resolve("people/ada"),
        ["people/adam"],
        "a soft-deleted page is not resolved; the fuzzy half still finds the slug that contains it"
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
fn change_reasons_stamp_the_versions_after_a_mark() {
    let dir = TempDir::new("pages-version-reasons");
    let store = open(&dir);
    let page_id = put(&store, "a", "one")["id"].as_i64().unwrap();
    assert_eq!(store.read_latest_version_id(page_id).unwrap(), None);
    let v1 = store.create_version("a", None).unwrap();
    assert_eq!(
        store.read_latest_version_id(page_id).unwrap(),
        v1["id"].as_u64()
    );
    let stamp = |after: i64, reason: &str| {
        store.stamp_version_change_reason(&VersionReasonStamp {
            page_id,
            after_version_id: after,
            reason: reason.into(),
        })
    };
    assert_eq!(stamp(0, "first").unwrap(), 1);
    put(&store, "a", "two");
    let v2 = store
        .create_version_with("a", None, Some("imported"))
        .unwrap();
    assert_eq!(v2["change_reason"], "imported");
    assert_eq!(stamp(v2["id"].as_i64().unwrap(), "late").unwrap(), 0);
    assert_eq!(stamp(-1, "bad\0reason").unwrap_err().code, INVALID_ARGUMENT);
    let reasons: Vec<Value> = store
        .get_versions("a", &VersionsOptions::default())
        .unwrap()
        .iter()
        .map(|v| v["replaced_because"].clone())
        .collect();
    assert_eq!(reasons, [json!("imported"), json!("first")]);
}

#[test]
fn the_holding_prune_keeps_the_newest_five_versions_and_marks_the_gap() {
    let dir = TempDir::new("pages-holding-prune");
    let store = open(&dir);
    let page_id = put(&store, "memory/unattributed", "held")["id"]
        .as_i64()
        .unwrap();
    let ids: Vec<u64> = (0..8)
        .map(|_| {
            store.create_version("memory/unattributed", None).unwrap()["id"]
                .as_u64()
                .unwrap()
        })
        .collect();
    let kept = || -> Vec<u64> {
        store
            .get_versions("memory/unattributed", &VersionsOptions::default())
            .unwrap()
            .iter()
            .map(|v| v["id"].as_u64().unwrap())
            .collect()
    };
    assert_eq!(store.prune_holding_page_versions(page_id).unwrap(), 3);
    assert_eq!(kept(), ids[3..].iter().rev().copied().collect::<Vec<_>>());
    assert_eq!(store.prune_holding_page_versions(page_id).unwrap(), 0);
    assert_eq!(store.prune_holding_page_versions(987_654).unwrap(), 0);
    assert_eq!(store.prune_holding_page_versions(-1).unwrap(), 0);
}

fn trust_of(store: &Store, slug: &str) -> (String, Option<Value>) {
    let rows = store
        .read_page_trust_rows(&PageTrustLookup {
            keys: vec![PageTrustKey {
                source_id: "default".into(),
                slug: slug.into(),
            }],
            ..PageTrustLookup::default()
        })
        .unwrap();
    (rows[0].trust_tier.clone(), rows[0].write_origin.clone())
}

fn restore(
    store: &Store,
    page_id: i64,
    tier: &str,
    origin: Option<&str>,
) -> gbrain_store::Result<()> {
    store.restore_page_trust(&PageTrustRestore {
        page_id,
        trust_tier: tier.into(),
        write_origin: origin.map(String::from),
    })
}

#[test]
fn a_trust_restore_lowers_freely_and_raises_only_under_a_promotion() {
    let dir = TempDir::new("pages-trust-restore");
    let store = open(&dir);
    let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let owner = r#"{"channel":"owner"}"#;
    let tx = store.begin_transaction(false).unwrap();
    tx.apply_write_trust(
        &names(&[
            "gbrain.write_trust_tier",
            "gbrain.write_trust_promotion",
            "gbrain.write_origin",
        ]),
        &[
            "operator_curated".into(),
            "operator_curated".into(),
            owner.into(),
        ],
    )
    .unwrap();
    let page_id = put(&tx, "a", "one")["id"].as_i64().unwrap();
    tx.commit_transaction().unwrap();

    // An agent rewrite lowers the page; the restore under the page's own promotion raises it back.
    let tx = store.begin_transaction(false).unwrap();
    let agent = names(&["gbrain.write_trust_tier", "gbrain.write_origin"]);
    let agent_values = [
        "agent_written".to_string(),
        r#"{"channel":"agent"}"#.to_string(),
    ];
    tx.apply_write_trust(&agent, &agent_values).unwrap();
    put(&tx, "a", "one, appended");
    assert_eq!(trust_of(&tx, "a").0, "agent_written");
    tx.apply_write_trust(
        &names(&["gbrain.write_trust_promotion"]),
        &["operator_curated".into()],
    )
    .unwrap();
    restore(&tx, page_id, "operator_curated", Some(owner)).unwrap();
    tx.commit_transaction().unwrap();
    assert_eq!(
        trust_of(&store, "a"),
        (
            "operator_curated".into(),
            Some(json!({ "channel": "owner" }))
        )
    );

    // A lower needs no promotion, and a null origin clears it.
    let tx = store.begin_transaction(false).unwrap();
    tx.apply_write_trust(&agent, &agent_values).unwrap();
    restore(&tx, page_id, "external_untrusted", None).unwrap();
    // A raise with no promotion keeps the stored tier; an unknown page writes nothing.
    restore(&tx, page_id, "operator_curated", Some(owner)).unwrap();
    restore(&tx, 987_654, "agent_written", None).unwrap();
    tx.commit_transaction().unwrap();
    assert_eq!(trust_of(&store, "a").0, "external_untrusted");

    assert_eq!(
        code(restore(&store, page_id, "root", None).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(restore(&store, page_id, "agent_written", Some("{not json")).unwrap_err()),
        INVALID_ARGUMENT
    );
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

#[test]
fn put_page_writes_the_contextual_retrieval_stamp_it_is_given_and_none_keeps_the_stored_one() {
    let dir = TempDir::new("pages-cr-stamp");
    let store = open(&dir);
    let mode = |store: &Store| {
        let snapshot = store
            .read_page_snapshot("notes/cr", &ReadScope::default())
            .unwrap()
            .unwrap();
        snapshot["page"]["contextual_retrieval_mode"].clone()
    };
    let stamp =
        |m: &str| opts(json!({"contextualRetrieval": {"mode": m, "corpusGeneration": "gen-1"}}));
    store
        .put_page("notes/cr", &input("CR", "One."), &stamp("title"))
        .unwrap();
    assert_eq!(mode(&store), json!("title"));
    store
        .put_page("notes/cr", &input("CR", "Two."), &PutPageOptions::default())
        .unwrap();
    assert_eq!(mode(&store), json!("title"));
    store
        .put_page("notes/cr", &input("CR", "Three."), &stamp("none"))
        .unwrap();
    assert_eq!(mode(&store), json!("title"));
    store
        .put_page(
            "notes/cr",
            &input("CR", "Four."),
            &stamp("per_chunk_synopsis"),
        )
        .unwrap();
    assert_eq!(mode(&store), json!("per_chunk_synopsis"));
    // A stamp Postgres could not store refuses the whole write: neither the body nor the mode changes.
    let err = store
        .put_page("notes/cr", &input("CR", "Five."), &stamp("ti\0tle"))
        .unwrap_err();
    assert_eq!(code(err), INVALID_ARGUMENT);
    assert_eq!(mode(&store), json!("per_chunk_synopsis"));
    let body = store
        .read_page_snapshot("notes/cr", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(body["page"]["compiled_truth"], json!("Four."));
}

/// `excludePrivate` on the page reads: a hidden page reads as missing, a scope whose first source
/// holds a hidden page answers the next source, and `resolveSlugs` never names a hidden page.
#[test]
fn exclude_private_hides_a_private_page_from_every_page_read() {
    let dir = TempDir::new("pages-exclude-private");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "alt".into(),
            ..Default::default()
        })
        .unwrap();
    let private: PageInput = serde_json::from_value(json!({
        "type": "person", "title": "Secret", "compiled_truth": "secret",
        "frontmatter": { "visibility": "private" },
    }))
    .unwrap();
    store
        .put_page("people/secret", &private, &PutPageOptions::default())
        .unwrap();
    store
        .put_page("people/ada", &private, &opts(json!({ "sourceId": "alt" })))
        .unwrap();
    put(&store, "people/ada", "public");
    let policy = json!({ "honorAliases": true, "entityPrivacy": true });
    let hidden = scope(json!({ "excludePrivate": policy }));
    assert!(
        store
            .read_page_snapshot("people/secret", &hidden)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_page_snapshot("people/secret", &ReadScope::default())
            .unwrap()
            .is_some()
    );
    let alt_first = scope(json!({ "excludePrivate": policy, "sourceIds": ["alt", "default"] }));
    let snapshot = store
        .read_page_snapshot("people/ada", &alt_first)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["page"]["source_id"], "default");
    // The hidden exact page is skipped; the fuzzy half then finds the public `people/ada`, whose
    // title (`people/ada`) shares the `people` trigrams (7 of 18, over the 0.3 threshold).
    assert_eq!(
        store.resolve_slugs("people/secret", &hidden).unwrap(),
        ["people/ada"]
    );
    assert_eq!(
        store.resolve_slugs("people/ada", &alt_first).unwrap(),
        vec!["people/ada".to_string()]
    );
    let listed = store
        .list_pages(&filters(json!({ "excludePrivate": policy })))
        .unwrap();
    assert_eq!(slugs(&listed), vec!["people/ada"]);
    assert_eq!(listed[0]["source_id"], "default");
}

#[test]
fn resolve_alias_follows_a_rename_alias_and_require_unambiguous_refuses_two_candidates() {
    let dir = TempDir::new("pages-resolve-alias");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "alt".into(),
            ..Default::default()
        })
        .unwrap();
    put(&store, "people/old-name", "body");
    assert_eq!(
        store
            .update_slug("people/old-name", "people/new-name", None)
            .unwrap(),
        1
    );
    store
        .put_page(
            "people/old-name",
            &input("alt", "alt body"),
            &opts(json!({ "sourceId": "alt" })),
        )
        .unwrap();
    let at = |v: Option<Value>| {
        v.map(|s| {
            format!(
                "{}:{}",
                s["page"]["source_id"].as_str().unwrap(),
                s["page"]["slug"].as_str().unwrap()
            )
        })
    };
    // Without resolveAlias only the exact page in alt answers; with it the exact page still outranks the alias.
    let read = |v: Value| store.read_page_snapshot("people/old-name", &scope(v));
    assert_eq!(
        at(read(json!({})).unwrap()).as_deref(),
        Some("alt:people/old-name")
    );
    assert_eq!(
        at(read(json!({ "resolveAlias": true })).unwrap()).as_deref(),
        Some("alt:people/old-name")
    );
    assert_eq!(
        at(read(json!({ "resolveAlias": true, "sourceId": "default" })).unwrap()).as_deref(),
        Some("default:people/new-name")
    );
    assert_eq!(
        code(read(json!({ "resolveAlias": true, "requireUnambiguous": true })).unwrap_err()),
        PAGE_AMBIGUOUS
    );
    // preserveExactIdentity skips an alias of a source that has a page at the slug.
    assert_eq!(
        at(read(
            json!({ "resolveAlias": true, "preserveExactIdentity": true, "sourceId": "default" })
        )
        .unwrap()),
        Some("default:people/new-name".to_string())
    );
    put(&store, "people/old-name", "recreated");
    store.soft_delete_page("people/old-name", None).unwrap();
    assert!(
        read(json!({ "resolveAlias": true, "preserveExactIdentity": true, "sourceId": "default" }))
            .unwrap()
            .is_none()
    );
}

#[test]
fn an_alias_read_follows_a_rename_alias_and_an_exact_slug_wins() {
    let dir = TempDir::new("pages-snapshot-alias");
    let store = open(&dir);
    put(&store, "notes/old", "Movable.");
    store.update_slug("notes/old", "notes/new", None).unwrap();
    let read = |slug: &str, v: Value| {
        store
            .read_page_snapshot(slug, &scope(v))
            .unwrap()
            .map(|s| s["page"]["slug"].as_str().unwrap().to_string())
    };
    assert_eq!(read("notes/old", json!({})), None);
    assert_eq!(
        read("notes/old", json!({"resolveAlias": true})).as_deref(),
        Some("notes/new")
    );
    assert_eq!(read("notes/never", json!({"resolveAlias": true})), None);
    put(&store, "notes/old", "Squatter.");
    assert_eq!(
        read("notes/old", json!({"resolveAlias": true})).as_deref(),
        Some("notes/old")
    );
}
