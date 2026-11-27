//! The files commands and file operations (`upsertCliFileRow`, `upsertOpFileRow`, `registerFileRow`,
//! `claimFilePage`, the readable reads and the lists), matched to the statements the PGLite engine runs.

mod common;

use common::TempDir;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};

fn open(dir: &TempDir) -> Store {
    Store::open_dir(dir.path(), OpenOptions::default()).unwrap()
}

fn put(store: &Store, source: &str, slug: &str, private: bool) -> u64 {
    let frontmatter = if private {
        json!({"visibility": "private"})
    } else {
        json!({})
    };
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn add_source(store: &Store, id: &str) {
    let source: SourceInput = serde_json::from_value(json!({"id": id})).unwrap();
    store.upsert_source(&source).unwrap();
}

fn spec(v: Value) -> FileSpec {
    serde_json::from_value(v).unwrap()
}

fn policy() -> PrivacyPolicy {
    serde_json::from_value(json!({"honorAliases": false, "entityPrivacy": true})).unwrap()
}

fn row(path: &str, slug: Option<&str>, meta: Value) -> FileSpec {
    spec(json!({
        "page_slug": slug, "filename": path.rsplit('/').next().unwrap(), "storage_path": path,
        "mime_type": "image/png", "size_bytes": 10, "content_hash": format!("hash-{path}"),
        "metadata": meta.to_string(),
    }))
}

fn paths(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["storage_path"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn command_upsert_merges_metadata_and_keeps_the_rest() {
    let dir = TempDir::new("files-ops-merge");
    let store = open(&dir);
    store
        .upsert_file_row(
            "command",
            &row(
                "plan/a.png",
                Some("plan"),
                json!({"keep": 1, "over": "old"}),
            ),
        )
        .unwrap();
    let mut again = row("plan/a.png", Some("other"), json!({"over": "new", "b": 2}));
    again.content_hash = Some("hash-new".into());
    again.size_bytes = Some(json!(20));
    again.mime_type = Some("image/jpeg".into());
    store.upsert_file_row("command", &again).unwrap();
    let rows = store.list_file_rows("all", None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["page_slug"], "plan",
        "a repeat keeps the first page slug"
    );
    assert_eq!(rows[0]["content_hash"], "hash-new");
    assert_eq!(rows[0]["size_bytes"], 20);
    assert_eq!(rows[0]["mime_type"], "image/jpeg");
    assert_eq!(
        rows[0]["metadata"],
        json!({"keep": 1, "over": "new", "b": 2})
    );
    assert!(store.has_file_with_hash("hash-new", "plan/a.png").unwrap());
    assert!(
        !store
            .has_file_with_hash("hash-plan/a.png", "plan/a.png")
            .unwrap()
    );
    assert!(!store.has_file_with_hash("hash-new", "elsewhere").unwrap());
}

#[test]
fn an_upload_binds_the_live_page_and_follows_its_slug() {
    let dir = TempDir::new("files-ops-follow");
    let store = open(&dir);
    add_source(&store, "other");
    let id = put(&store, "default", "people/old", false);
    let there = put(&store, "other", "people/old", false);
    put(&store, "default", "people/gone", false);
    store
        .soft_delete_page("people/gone", Some("default"))
        .unwrap();
    let of = |path: &str| {
        store
            .list_file_rows("all", None)
            .unwrap()
            .into_iter()
            .find(|r| r["storage_path"] == path)
            .unwrap()
    };
    // A command upload binds the live page at its slug in its source, and none when the page is gone or absent.
    store
        .upsert_file_row("command", &row("c/cli.png", Some("people/old"), json!({})))
        .unwrap();
    let mut raw = row("c/raw.png", Some("people/old"), json!({}));
    raw.source_id = Some("other".into());
    store.upsert_file_row("command", &raw).unwrap();
    store
        .upsert_file_row(
            "command",
            &row("c/gone.png", Some("people/gone"), json!({})),
        )
        .unwrap();
    store
        .upsert_file_row(
            "command",
            &row("c/none.png", Some("people/nobody"), json!({})),
        )
        .unwrap();
    assert_eq!(of("c/cli.png")["page_id"], id);
    assert_eq!(of("c/raw.png")["page_id"], there);
    assert_eq!(of("c/gone.png")["page_id"], Value::Null);
    assert_eq!(of("c/none.png")["page_id"], Value::Null);
    // A rename moves the files bound to the page by id and named by the old slug (raw_files::rename_page_files).
    assert_eq!(
        store
            .update_slug("people/old", "people/new", Some("default"))
            .unwrap(),
        1
    );
    assert_eq!(of("c/cli.png")["page_slug"], "people/new");
    assert_eq!(
        of("c/raw.png")["page_slug"],
        "people/old",
        "another source's file stays"
    );
    // An operation upload names the page's slug as it is now, also when it still carries the old one.
    let mut op = row("o/op.png", Some("people/old"), json!({}));
    op.source_id = Some("default".into());
    op.page_id = Some(json!(id));
    store.upsert_file_row("operation", &op).unwrap();
    assert_eq!(of("o/op.png")["page_slug"], "people/new");
    // A repeat that binds the page takes its id and slug together; a repeat that binds none keeps the pair.
    let mut again = row("c/none.png", Some("people/new"), json!({}));
    again.content_hash = Some("hash-2".into());
    store.upsert_file_row("command", &again).unwrap();
    assert_eq!(of("c/none.png")["page_id"], id);
    assert_eq!(of("c/none.png")["page_slug"], "people/new");
    let mut keeps = row("c/none.png", Some("people/nobody"), json!({}));
    keeps.content_hash = Some("hash-3".into());
    store.upsert_file_row("command", &keeps).unwrap();
    assert_eq!(of("c/none.png")["page_id"], id);
    assert_eq!(of("c/none.png")["page_slug"], "people/new");
    let mut stale = row("o/op.png", Some("people/old"), json!({}));
    stale.source_id = Some("default".into());
    stale.page_id = Some(json!(id));
    stale.content_hash = Some("hash-4".into());
    store.upsert_file_row("operation", &stale).unwrap();
    assert_eq!(of("o/op.png")["page_slug"], "people/new");
}

#[test]
fn list_orders_and_limits() {
    let dir = TempDir::new("files-ops-lists");
    let store = open(&dir);
    for n in 0..101 {
        store
            .upsert_file_row(
                "command",
                &row(&format!("bulk/f{n:03}"), Some("bulk"), json!({})),
            )
            .unwrap();
    }
    store
        .upsert_file_row("command", &row("loose.txt", None, json!({})))
        .unwrap();
    store
        .upsert_file_row("command", &row("a/first", Some("a"), json!({})))
        .unwrap();
    let all = store.list_file_rows("all", None).unwrap();
    assert_eq!(all.len(), 100);
    assert_eq!(all[0]["storage_path"], "a/first");
    assert_eq!(all[99]["storage_path"], "bulk/f098");
    let verify = store.list_file_rows("verify", None).unwrap();
    assert_eq!(verify.len(), 103);
    assert_eq!(verify[0]["storage_path"], "a/first");
    let slug = store.list_file_rows("slug", Some("bulk")).unwrap();
    assert_eq!(slug.len(), 100);
    assert_eq!(slug[99]["storage_path"], "bulk/f099");
    assert!(
        store
            .list_file_rows("slug", Some("nowhere"))
            .unwrap()
            .is_empty()
    );
    let err = store.list_file_rows("bogus", None).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn operation_upsert_keeps_source_and_page_without_a_page() {
    let dir = TempDir::new("files-ops-op");
    let store = open(&dir);
    add_source(&store, "other");
    let here = put(&store, "default", "notes/plan", false);
    let there = put(&store, "other", "notes/plan", false);
    let base = |hash: &str, source: &str, page: Value| {
        spec(json!({
            "page_slug": "notes/plan", "filename": "r.pdf", "storage_path": "notes/plan/r.pdf",
            "mime_type": "application/pdf", "size_bytes": 12, "content_hash": hash,
            "source_id": source, "page_id": page, "metadata": "{\"storage\":\"local\"}",
        }))
    };
    store
        .upsert_file_row("operation", &base("h1", "default", json!(here)))
        .unwrap();
    store
        .upsert_file_row("operation", &base("h2", "other", Value::Null))
        .unwrap();
    let owner = store.read_file_owner("notes/plan/r.pdf").unwrap().unwrap();
    assert_eq!(
        owner,
        json!({"source_id": "default", "page_id": here, "content_hash": "h2"})
    );
    store
        .upsert_file_row("operation", &base("h3", "other", json!(there)))
        .unwrap();
    let owner = store.read_file_owner("notes/plan/r.pdf").unwrap().unwrap();
    assert_eq!(
        owner,
        json!({"source_id": "other", "page_id": there, "content_hash": "h3"})
    );
    assert_eq!(store.read_file_owner("nothing").unwrap(), None);
    // A source that does not exist is a foreign key violation, and nothing is written.
    let err = store
        .upsert_file_row("operation", &base("h4", "never-made", json!(here)))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = store
        .upsert_file_row("operation", &base("h4", "other", json!(999_999)))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert_eq!(
        store.read_file_owner("notes/plan/r.pdf").unwrap().unwrap()["content_hash"],
        "h3"
    );
}

#[test]
fn register_refreshes_the_same_identity_only() {
    let dir = TempDir::new("files-ops-register");
    let store = open(&dir);
    let here = put(&store, "default", "notes/plan", false);
    let base = |name: &str, hash: &str| {
        spec(json!({
            "page_slug": "notes/plan", "filename": name, "storage_path": "notes/plan/r.pdf",
            "mime_type": "application/pdf", "size_bytes": 12, "content_hash": hash,
            "source_id": "default", "page_id": here, "metadata": "{}",
        }))
    };
    assert!(store.register_file_row(&base("r.pdf", "h1")).unwrap());
    assert!(store.register_file_row(&base("r.pdf", "h2")).unwrap());
    assert!(!store.register_file_row(&base("moved.pdf", "h3")).unwrap());
    assert_eq!(
        store.read_file_owner("notes/plan/r.pdf").unwrap().unwrap()["content_hash"],
        "h2"
    );
    assert_eq!(
        store
            .count_files_registered_elsewhere(&base("r.pdf", "h"))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .count_files_registered_elsewhere(&base("other.pdf", "h"))
            .unwrap(),
        1
    );
    let mut nowhere = base("r.pdf", "h");
    nowhere.storage_path = Some("none.pdf".into());
    assert_eq!(store.count_files_registered_elsewhere(&nowhere).unwrap(), 0);
}

#[test]
fn claim_moves_a_row_and_checks_the_keys() {
    let dir = TempDir::new("files-ops-claim");
    let store = open(&dir);
    add_source(&store, "other");
    let there = put(&store, "other", "notes/plan", false);
    store
        .upsert_file_row("command", &row("p/f.png", Some("notes/plan"), json!({})))
        .unwrap();
    store
        .claim_file_page("p/f.png", "other", &json!(there))
        .unwrap();
    let owner = store.read_file_owner("p/f.png").unwrap().unwrap();
    assert_eq!(owner["source_id"], "other");
    assert_eq!(owner["page_id"], there);
    store
        .claim_file_page("missing", "other", &json!(there))
        .unwrap();
    assert_eq!(
        store
            .claim_file_page("p/f.png", "never", &json!(there))
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store
            .claim_file_page("p/f.png", "other", &json!(777))
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn readable_reads_hide_private_pages_by_id_and_by_slug_in_any_source() {
    let dir = TempDir::new("files-ops-readable");
    let store = open(&dir);
    add_source(&store, "other");
    let shared = put(&store, "default", "notes/shared", false);
    let shared_there = put(&store, "other", "notes/shared", true);
    let solo = put(&store, "default", "notes/solo", true);
    let open_id = put(&store, "default", "notes/open", false);
    store
        .soft_delete_page("notes/solo", Some("default"))
        .unwrap();
    let with = |path: &str, slug: Option<&str>, id: Value, source: &str, hash: &str| {
        spec(json!({
            "page_slug": slug, "page_id": id, "filename": path.rsplit('/').next().unwrap(),
            "storage_path": path, "size_bytes": 5, "content_hash": hash, "source_id": source,
            "metadata": "{}",
        }))
    };
    for s in [
        with(
            "x/by-slug.png",
            Some("notes/shared"),
            json!(shared),
            "default",
            "h1",
        ),
        with("x/by-id.png", None, json!(shared_there), "other", "h2"),
        with(
            "x/deleted.png",
            Some("notes/solo"),
            Value::Null,
            "default",
            "h3",
        ),
        with(
            "x/open.png",
            Some("notes/open"),
            json!(open_id),
            "default",
            "h4",
        ),
        with("x/unlinked.png", None, Value::Null, "default", "h5"),
    ] {
        store.upsert_file_row("operation", &s).unwrap();
    }
    let p = policy();
    let none = store.list_readable_files("rows", None, None).unwrap();
    // The operation upload names the page's slug as it is now (`COALESCE((SELECT p.slug FROM pages p WHERE p.id = $8
    // FOR SHARE), $1)`), so the file bound by id alone lists under its page's slug, not last with the unbound.
    assert_eq!(
        paths(&none),
        [
            "x/open.png",
            "x/by-id.png",
            "x/by-slug.png",
            "x/deleted.png",
            "x/unlinked.png"
        ]
    );
    assert!(none[0]["created_at"].is_string());
    let hidden = store.list_readable_files("rows", None, Some(&p)).unwrap();
    assert_eq!(paths(&hidden), ["x/open.png", "x/unlinked.png"]);
    assert!(
        store
            .list_readable_files("rows", Some("notes/shared"), Some(&p))
            .unwrap()
            .is_empty()
    );
    let listed = store.list_readable_files("paths", None, Some(&p)).unwrap();
    assert_eq!(
        listed,
        vec![
            json!({"storage_path": "x/open.png", "page_slug": "notes/open"}),
            json!({"storage_path": "x/unlinked.png", "page_slug": null}),
        ]
    );
    for (path, unreadable) in [
        ("x/by-slug.png", 1),
        ("x/by-id.png", 1),
        ("x/deleted.png", 1),
        ("x/open.png", 0),
        ("x/nothing.png", 0),
    ] {
        assert_eq!(
            store.count_unreadable_files_at(path, Some(&p)).unwrap(),
            unreadable,
            "{path}"
        );
        assert_eq!(
            store.count_unreadable_files_at(path, None).unwrap(),
            0,
            "{path}"
        );
    }
    assert_eq!(
        store
            .read_readable_file("url", "x/by-slug.png", Some(&p))
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_readable_file("url", "x/open.png", Some(&p))
            .unwrap(),
        Some(json!({"storage_path": "x/open.png", "mime_type": null, "size_bytes": 5}))
    );
    assert_eq!(
        store
            .read_readable_file("verify", "x/deleted.png", Some(&p))
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_readable_file("verify", "x/deleted.png", None)
            .unwrap(),
        Some(json!({"size_bytes": 5, "content_hash": "h3"}))
    );
    assert_eq!(
        store
            .read_readable_file("url", "x/nothing.png", None)
            .unwrap(),
        None
    );
    // The page id read is per source and hides only the private page itself.
    assert_eq!(
        store
            .read_readable_page_id("notes/shared", "default", Some(&p))
            .unwrap(),
        Some(shared)
    );
    assert_eq!(
        store
            .read_readable_page_id("notes/shared", "other", Some(&p))
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_readable_page_id("notes/shared", "other", None)
            .unwrap(),
        Some(shared_there)
    );
    assert_eq!(
        store
            .read_readable_page_id("notes/solo", "default", Some(&p))
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_readable_page_id("notes/solo", "default", None)
            .unwrap(),
        Some(solo)
    );
    assert_eq!(
        store
            .read_readable_page_id("notes/open", "other", None)
            .unwrap(),
        None
    );
    // A deleted page still has its id in the source.
    assert_eq!(
        store
            .read_page_id_in_source("notes/solo", "default")
            .unwrap(),
        Some(solo)
    );
    assert_eq!(
        store.read_page_id_in_source("notes/solo", "other").unwrap(),
        None
    );
    assert_eq!(
        store
            .read_readable_file("bogus", "x/open.png", None)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn bad_inputs_are_refused_by_name() {
    let dir = TempDir::new("files-ops-bad");
    let store = open(&dir);
    let mut nul = row("a.png", None, json!({}));
    nul.filename = Some("a\0.png".into());
    assert_eq!(
        store.upsert_file_row("command", &nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let arr = row("a.png", None, json!([1]));
    assert_eq!(
        store.upsert_file_row("command", &arr).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut no_hash = row("a.png", None, json!({}));
    no_hash.content_hash = None;
    assert!(store.upsert_file_row("command", &no_hash).is_err());
    assert_eq!(
        store
            .upsert_file_row("sideways", &row("a.png", None, json!({})))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert!(store.list_file_rows("all", None).unwrap().is_empty());
}
