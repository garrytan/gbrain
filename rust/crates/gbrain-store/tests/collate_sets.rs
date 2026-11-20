//! The page-set reads of the core commands (`collate_sets.rs`): the size states, the chat census, the link-resolver rows,
//! the attendance origins, the company-brain evidence, the shelf, the live source incarnations and the attendance window.

mod common;
mod memory_env;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::links::LinkBatchInput;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&args::<SourceInput>(
            json!({ "id": id, "name": id, "config": {} }),
        ))
        .unwrap();
}

fn put_in(
    store: &Store,
    source: &str,
    slug: &str,
    kind: &str,
    title: &str,
    body: &str,
    fm: Value,
) -> Value {
    let input: PageInput = args(json!({
        "type": kind, "title": title, "compiled_truth": body, "timeline": "", "frontmatter": fm,
    }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    store.put_page(slug, &input, &options).unwrap()
}

fn put(store: &Store, slug: &str, kind: &str, title: &str, body: &str, fm: Value) -> Value {
    put_in(store, "default", slug, kind, title, body, fm)
}

fn link(store: &Store, from: &str, to: &str, kind: &str, link_source: &str, origin: Option<&str>) {
    let input: LinkBatchInput = args(json!({
        "from_slug": from, "to_slug": to, "link_type": kind, "context": "", "link_source": link_source,
        "origin_slug": origin, "from_source_id": "default", "to_source_id": "default",
        "origin_source_id": origin.map(|_| "default"),
    }));
    store.add_links_batch(&[input]).unwrap();
}

fn strings(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn size_rows_keep_the_pages_that_carry_a_size_state_by_byte() {
    let dir = TempDir::new("collate-sets-size");
    let s = open(&dir);
    put(&s, "ab", "note", "t", "tiny", json!({ "embed_skip": true }));
    put(&s, "a-z", "note", "t", "ééé", json!({ "embed_skip": null }));
    put(&s, "big", "note", "t", &"x".repeat(50), json!({}));
    put(&s, "small", "note", "t", "tiny", json!({}));
    put(
        &s,
        "gone",
        "note",
        "t",
        "tiny",
        json!({ "embed_skip": true }),
    );
    s.soft_delete_page("gone", None).unwrap();
    let rows = s.read_page_size_rows("default", 10, None).unwrap();
    assert_eq!(strings(&rows, "slug"), ["a-z", "ab", "big"]);
    assert_eq!(rows[0]["bytes"], 6);
    assert_eq!(rows[0]["segmented"], false);
    assert_eq!(rows[0]["frontmatter"], json!({ "embed_skip": null }));
    assert!(rows[0]["state"].is_null() && rows[0]["reason"].is_null());
    let slugs = ["big".to_string(), "small".to_string(), "ab".to_string()];
    let some = s.read_page_size_rows("default", 10, Some(&slugs)).unwrap();
    assert_eq!(strings(&some, "slug"), ["ab", "big"]);
    assert!(
        s.read_page_size_rows("nobody", 10, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn size_rows_carry_the_embedding_ledger_state() {
    let dir = TempDir::new("collate-sets-ledger");
    let s = open(&dir);
    let id = put(&s, "held", "note", "t", "tiny", json!({}))["id"]
        .as_u64()
        .unwrap();
    put(&s, "plain", "note", "t", "tiny", json!({}));
    s.record_page_embedding_hold(id, "too big").unwrap();
    let rows = s.read_page_size_rows("default", 1000, None).unwrap();
    assert_eq!(strings(&rows, "slug"), ["held"]);
    assert_eq!(rows[0]["state"], "held");
    assert_eq!(rows[0]["reason"], "too big");
}

#[test]
fn the_chat_census_counts_pages_and_distinct_channels_per_source_by_byte() {
    let dir = TempDir::new("collate-sets-census");
    let s = open(&dir);
    for id in ["b", "a-z", "a0"] {
        source(&s, id);
    }
    let chat = ["chat".to_string()];
    let dm = ["dm".to_string()];
    let all = [
        "b".to_string(),
        "a-z".to_string(),
        "a0".to_string(),
        "nobody".to_string(),
    ];
    put_in(&s, "b", "c1", "chat", "#General", "x", json!({}));
    put_in(&s, "b", "c2", "chat", "#general", "x", json!({}));
    put_in(&s, "b", "c3", "chat", "No channel", "x", json!({}));
    put_in(
        &s,
        "b",
        "c4",
        "chat",
        "No channel",
        "x",
        json!({ "channel": "ops" }),
    );
    put_in(
        &s,
        "b",
        "c5",
        "chat",
        "No channel",
        "x",
        json!({ "chat": 7, "channel": "" }),
    );
    put_in(&s, "b", "gone", "chat", "#gone", "x", json!({}));
    put_in(&s, "b", "note", "note", "#note", "x", json!({}));
    s.soft_delete_page("gone", Some("b")).unwrap();
    put_in(
        &s,
        "a-z",
        "d1",
        "dm",
        "t",
        "x",
        json!({ "channel": "ignored" }),
    );
    put_in(&s, "a-z", "d2", "dm", "t", "x", json!({}));
    put_in(&s, "a0", "c1", "chat", "#only", "x", json!({}));
    let rows = s
        .list_chat_channel_census(&all, &chat, &dm, None, false)
        .unwrap();
    assert_eq!(strings(&rows, "source_id"), ["a0", "b"]);
    // b: general (twice), '' (c3), ops, 7 -> 4 channels over 5 pages.
    assert_eq!(
        rows[1],
        json!({ "source_id": "b", "chat_pages": 5, "channels": 4 })
    );
    let both = [chat[0].clone(), dm[0].clone()];
    let rows = s
        .list_chat_channel_census(&all, &both, &dm, None, false)
        .unwrap();
    assert_eq!(strings(&rows, "source_id"), ["a-z", "a0", "b"]);
    assert_eq!(
        rows[0],
        json!({ "source_id": "a-z", "chat_pages": 2, "channels": 2 })
    );
    let only = ["a0".to_string()];
    let rows = s
        .list_chat_channel_census(&only, &both, &dm, None, false)
        .unwrap();
    assert_eq!(strings(&rows, "source_id"), ["a0"]);
}

#[test]
fn the_fast_census_counts_a_cheap_page_the_full_policy_hides() {
    let dir = TempDir::new("collate-sets-census-fast");
    let s = open(&dir);
    source(&s, "open");
    s.upsert_source(&args::<SourceInput>(
        json!({ "id": "locked", "name": "locked", "config": { "owner_only": true } }),
    ))
    .unwrap();
    for id in ["open", "locked"] {
        put_in(&s, id, "plain", "chat", "#plain", "x", json!({}));
        put_in(
            &s,
            id,
            "private",
            "chat",
            "#private",
            "x",
            json!({ "visibility": "private" }),
        );
        put_in(
            &s,
            id,
            "readers",
            "chat",
            "#readers",
            "x",
            json!({ "readable_by": ["member:a"] }),
        );
        put_in(
            &s,
            id,
            "alias",
            "chat",
            "#alias",
            "x",
            json!({ "access": "private" }),
        );
        put_in(
            &s,
            id,
            "null-key",
            "chat",
            "#nullkey",
            "x",
            json!({ "visibility": null }),
        );
    }
    let chat = ["chat".to_string()];
    let all = ["open".to_string(), "locked".to_string()];
    let policy: PrivacyPolicy = args(json!({
        "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn",
    }));
    let counts = |fast: bool| {
        let rows = s
            .list_chat_channel_census(&all, &chat, &[], Some(&policy), fast)
            .unwrap();
        rows.iter()
            .map(|r| {
                (
                    r["source_id"].as_str().unwrap().to_string(),
                    r["chat_pages"].as_u64().unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    // The full policy hides the owner-only source whole and every private, restricted or aliased page.
    assert_eq!(counts(false), [("open".to_string(), 2)]);
    // The fast form passes the cheap page of the owner-only source (and the page whose `visibility` key holds JSON null, a key
    // that is present, goes to the full policy, which keeps it in the open source only).
    assert_eq!(
        counts(true),
        [("locked".to_string(), 1), ("open".to_string(), 2)]
    );
}

#[test]
fn link_page_metadata_for_slugs_lists_the_live_named_pages_by_byte() {
    let dir = TempDir::new("collate-sets-link-pages");
    let s = open(&dir);
    put(&s, "ab", "note", "Ab", "x", json!({ "aliases": ["Alpha"] }));
    put(&s, "a-z", "person", "A-z", "x", json!({}));
    put(&s, "gone", "note", "Gone", "x", json!({}));
    s.soft_delete_page("gone", None).unwrap();
    let slugs = ["ab", "a-z", "gone", "missing", "ab"].map(String::from);
    let rows = s
        .list_link_page_metadata_for_slugs("default", &slugs)
        .unwrap();
    let got: Vec<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(got, ["a-z", "ab"]);
    assert_eq!(rows[1].aliases, json!(["Alpha"]));
    assert_eq!(rows[0].aliases, Value::Null);
    assert_eq!(rows[0].page_type, "person");
    assert!(
        s.list_link_page_metadata_for_slugs("other", &slugs)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn attended_origins_are_the_pages_with_a_canonical_edge_to_themselves() {
    let dir = TempDir::new("collate-sets-attended");
    let s = open(&dir);
    for slug in ["m1", "m2", "m3", "m4", "m5", "p"] {
        put(&s, slug, "note", slug, "x", json!({}));
    }
    link(&s, "m2", "m2", "attended", "markdown", Some("m2"));
    link(&s, "m1", "m1", "attended", "frontmatter", Some("m1"));
    link(&s, "m3", "m3", "attended", "manual", Some("m3"));
    link(&s, "m4", "p", "attended", "markdown", Some("m4"));
    // The edge may start at another page: its origin is also its target.
    link(&s, "p", "m5", "attended", "markdown", Some("m5"));
    let rows = s.list_attended_origin_slugs("default", None).unwrap();
    assert_eq!(strings(&rows, "slug"), ["m1", "m2", "m5"]);
    let only = ["m2".to_string(), "m4".to_string()];
    let rows = s
        .list_attended_origin_slugs("default", Some(&only))
        .unwrap();
    assert_eq!(strings(&rows, "slug"), ["m2"]);
    assert!(
        s.list_attended_origin_slugs("other", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn company_brain_evidence_takes_the_first_owner_decision_and_page_by_byte() {
    let dir = TempDir::new("collate-sets-evidence");
    let s = open(&dir);
    let empty = s.read_company_brain_evidence_rows("default").unwrap();
    assert_eq!(
        empty,
        json!({ "owner": null, "decision": null, "page": null })
    );
    put(&s, "ab", "decision", "Ab", "x", json!({}));
    put(&s, "a-z", "decision", "A-z", "x", json!({}));
    put(&s, "z-target", "decision", "Z", "x", json!({}));
    put(&s, "acme", "customer", "Acme", "x", json!({}));
    put(&s, "zed", "customer", "Zed", "x", json!({}));
    put(&s, "hub", "person", "Hub", "x", json!({}));
    link(&s, "ab", "z-target", "supersedes", "markdown", None);
    link(&s, "a-z", "z-target", "supersedes", "markdown", None);
    link(&s, "ab", "a-z", "supersedes", "manual", None);
    link(&s, "ab", "hub", "owned_by", "markdown", None);
    link(&s, "zed", "hub", "owned_by", "frontmatter", Some("zed"));
    link(&s, "acme", "hub", "owned_by", "frontmatter", Some("ab"));
    link(&s, "acme", "ab", "owned_by", "manual", None);
    let rows = s.read_company_brain_evidence_rows("default").unwrap();
    assert_eq!(rows["page"], json!({ "slug": "a-z", "title": "A-z" }));
    assert_eq!(rows["decision"]["from_slug"], "a-z");
    assert_eq!(rows["decision"]["to_slug"], "z-target");
    // A customer page sorts first; the edge another page originated and the manual edge do not count.
    assert_eq!(rows["owner"]["from_slug"], "zed");
    assert_eq!(rows["owner"]["to_title"], "Hub");
    s.soft_delete_page("a-z", None).unwrap();
    let rows = s.read_company_brain_evidence_rows("default").unwrap();
    assert_eq!(rows["decision"]["from_slug"], "ab");
    assert_eq!(rows["page"]["slug"], "ab");
}

#[test]
fn shelf_rows_are_the_live_pages_with_their_frontmatter_by_byte() {
    let dir = TempDir::new("collate-sets-shelf");
    let s = open(&dir);
    put(&s, "ab", "stored-object", "Ab", "x", json!({ "k": 1 }));
    put(&s, "a-z", "stored-object", "A-z", "x", json!({}));
    put(&s, "gone", "stored-object", "G", "x", json!({}));
    s.soft_delete_page("gone", None).unwrap();
    let rows = s.list_shelf_page_rows("default").unwrap();
    assert_eq!(strings(&rows, "slug"), ["a-z", "ab"]);
    assert_eq!(rows[1]["title"], "Ab");
    assert_eq!(rows[1]["type"], "stored-object");
    assert_eq!(rows[1]["frontmatter"], json!({ "k": 1 }));
    assert!(s.list_shelf_page_rows("other").unwrap().is_empty());
}

#[test]
fn card_rows_page_the_live_cards_by_byte_and_read_the_storage_object() {
    let dir = TempDir::new("collate-sets-cards");
    let s = open(&dir);
    let card = |status: &str, stores: Value, machine: Value| {
        json!({ "storage": { "status": status, "kind": "dataset", "original_path": "/p", "on_source_machine": machine,
                              "locations": stores } })
    };
    put(
        &s,
        "ab",
        "stored-object",
        "Ab",
        "x",
        card(
            "archived",
            json!([{ "store": "s3" }, { "store": "b2" }, { "store": "s3" }]),
            json!(true),
        ),
    );
    put(
        &s,
        "a-z",
        "stored-object",
        "A-z",
        "x",
        card(
            "missing",
            json!([{ "store": "gcs" }, {}, "text"]),
            json!("false"),
        ),
    );
    put(
        &s,
        "plain",
        "stored-object",
        "Plain",
        "x",
        json!({ "storage": "not an object" }),
    );
    put(
        &s,
        "held",
        "stored-object",
        "Held",
        "x",
        json!({ "quarantine": { "why": "x" }, "storage": { "status": "archived" } }),
    );
    put(&s, "gone", "stored-object", "Gone", "x", json!({}));
    s.soft_delete_page("gone", None).unwrap();
    put(&s, "note", "note", "Note", "x", json!({}));
    let rows = |status, store, machine, limit, offset| {
        s.list_card_rows(
            "default",
            "stored-object",
            status,
            store,
            machine,
            limit,
            offset,
        )
        .unwrap()
    };
    let all = rows(None, None, None, 10, 0);
    assert_eq!(all["total"], 3);
    let ids: Vec<&str> = all["cards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a-z", "ab", "plain"]);
    assert_eq!(all["cards"][1]["stores"], json!(["b2", "s3"]));
    assert_eq!(all["cards"][0]["stores"], json!(["gcs", null]));
    assert_eq!(all["cards"][1]["on_source_machine"], true);
    assert_eq!(all["cards"][0]["on_source_machine"], false);
    assert_eq!(all["cards"][2]["status"], Value::Null);
    assert_eq!(all["cards"][2]["stores"], json!([]));
    assert!(
        all["cards"][1]["updated_at"]
            .as_str()
            .unwrap()
            .ends_with("+00")
    );
    let page = rows(None, None, None, 1, 1);
    assert_eq!(
        (page["total"].clone(), page["cards"][0]["id"].clone()),
        (json!(3), json!("ab"))
    );
    assert_eq!(rows(Some("archived"), None, None, 10, 0)["total"], 1);
    assert_eq!(
        rows(None, Some("gcs"), None, 10, 0)["cards"][0]["id"],
        "a-z"
    );
    assert_eq!(rows(None, None, Some(false), 10, 0)["total"], 1);
    assert_eq!(rows(None, None, None, 10, 5)["cards"], json!([]));
    s.set_source_archived("default", true).unwrap();
    assert_eq!(
        rows(None, None, None, 10, 0),
        json!({ "cards": [], "total": 0 })
    );
}

#[test]
fn found_card_rows_rank_exact_matches_then_words_then_similarity() {
    let dir = TempDir::new("collate-sets-find");
    let s = open(&dir);
    let card = || json!({ "storage": { "status": "archived" } });
    put(
        &s,
        "disk",
        "stored-object",
        "Disk Backup",
        "Photos of the 2019 Lisbon trip",
        card(),
    );
    put(&s, "tax", "stored-object", "  Tax Papers ", "forms", card());
    put(
        &s,
        "other",
        "stored-object",
        "Other",
        "nothing here",
        json!({ "storage": { "status": "missing" } }),
    );
    put(
        &s,
        "held",
        "stored-object",
        "Tax Held",
        "tax",
        json!({ "quarantine": 1 }),
    );
    s.set_page_aliases("disk", "default", &["old drive".to_string()])
        .unwrap();
    let terms = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
    let find = |query: &str, alias: &str, words: &[&str], status| {
        s.find_card_rows(
            "default",
            "stored-object",
            query,
            alias,
            &terms(words),
            status,
            None,
            None,
        )
        .unwrap()
    };
    let ids = |rows: &[Value]| strings(rows, "id");

    let by_title = find("tax papers", "tax papers", &["tax", "papers"], None);
    assert_eq!(ids(&by_title), ["tax", "disk", "other"]);
    assert_eq!(by_title[0]["exact_title"], true);
    assert_eq!(by_title[0]["matched"], 2);
    assert_eq!(by_title[1]["matched"], 0);

    let by_alias = find("old drive", "old drive", &["old", "drive"], None);
    assert_eq!(ids(&by_alias)[0], "disk");
    assert_eq!(
        (
            by_alias[0]["exact_alias"].clone(),
            by_alias[0]["exact_title"].clone()
        ),
        (json!(true), json!(false))
    );

    let by_id = find("other", "other", &["other"], None);
    assert_eq!(
        (ids(&by_id)[0].as_str(), by_id[0]["exact_id"].clone()),
        ("other", json!(true))
    );

    // The `simple` search does not stem: `photo` is not `photos`, `lisbon` is found by its lowercase form.
    let words = find("photo lisbon", "photo lisbon", &["photo", "lisbon"], None);
    assert_eq!(
        (ids(&words)[0].as_str(), words[0]["matched"].clone()),
        ("disk", json!(1))
    );
    // The slug is part of the document, and a term with no token matches nothing.
    assert_eq!(find("disk", "disk", &["disk"], None)[0]["matched"], 1);
    assert_eq!(find("x", "x", &["!!"], None)[0]["matched"], 0);

    let similar = find("backup", "backup", &[], None);
    assert_eq!(ids(&similar)[0], "disk");
    assert!(similar[0]["similarity"].as_f64().unwrap() > 0.5);

    assert_eq!(
        ids(&find("tax", "tax", &["tax"], Some("missing"))),
        ["other"]
    );
    s.set_source_archived("default", true).unwrap();
    assert!(find("tax", "tax", &["tax"], None).is_empty());
}

#[test]
fn live_source_incarnations_leave_out_archived_and_missing_sources() {
    let dir = TempDir::new("collate-sets-incarnations");
    let s = open(&dir);
    source(&s, "kept");
    source(&s, "shelved");
    s.set_source_archived("shelved", true).unwrap();
    let ids = ["shelved", "kept", "default", "missing"].map(String::from);
    let rows = s.list_live_source_incarnations(&ids).unwrap();
    assert_eq!(strings(&rows, "id"), ["default", "kept"]);
    assert!(
        rows.iter()
            .all(|r| !r["incarnation"].as_str().unwrap().is_empty())
    );
}

#[test]
fn the_attendance_window_pages_by_slug_byte_and_includes_deleted_pages() {
    let dir = TempDir::new("collate-sets-window");
    let s = open(&dir);
    for slug in ["ab", "a0", "a_b", "a-b"] {
        put(&s, slug, "note", slug, "x", json!({}));
    }
    s.soft_delete_page("a0", None).unwrap();
    let first = s.list_attendance_scan_window("default", "", 3).unwrap();
    assert_eq!(strings(&first, "slug"), ["a-b", "a0", "a_b"]);
    assert_eq!(first[1]["deleted"], true);
    assert_eq!(first[0]["deleted"], false);
    assert_eq!(first[0]["type"], "note");
    assert!(first[0]["id"].is_string() && first[0]["revision"].is_string());
    let next = s.list_attendance_scan_window("default", "a_b", 3).unwrap();
    assert_eq!(strings(&next, "slug"), ["ab"]);
    assert!(
        s.list_attendance_scan_window("default", "ab", 3)
            .unwrap()
            .is_empty()
    );
    assert!(
        s.list_attendance_scan_window("default", "", 0)
            .unwrap()
            .is_empty()
    );
    assert!(s.list_attendance_scan_window("default", "", -1).is_err());
}
