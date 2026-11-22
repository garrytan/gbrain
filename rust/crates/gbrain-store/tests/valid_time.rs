//! The valid-time reads of one page (`trust/valid_time.rs`): the page lookup a dated read follows
//! and the edition in force on a date over the page and its version records.

mod memory_env;

use gbrain_store::sources::SourceInput;
use gbrain_store::trust::valid_time::{
    VALID_TIME_CURRENT_ORD, ValidTimeIdentityQuery, ValidTimePickQuery,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, source: &str, slug: &str, body: &str, frontmatter: Value) {
    let tx = b.begin_transaction(false).unwrap();
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": "note", "title": format!("T {slug}"), "compiled_truth": body,
        "timeline": "", "frontmatter": frontmatter }));
    tx.put_page(slug, &input, &args(json!({ "sourceId": source })))
        .unwrap();
    tx.commit_transaction().unwrap();
}

fn source(b: &Brain, id: &str, local_path: Option<&str>) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        local_path: local_path.map(String::from),
        ..SourceInput::default()
    })
    .unwrap();
}

fn snapshot(b: &Brain, slug: &str) -> i64 {
    b.create_version(slug, Some("default")).unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn identities(b: &Brain, q: Value) -> Vec<Value> {
    let mut q = q;
    q["world"] = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" });
    b.list_valid_time_identities(&args::<ValidTimeIdentityQuery>(q))
        .unwrap()
}

fn sources_of(rows: &[Value]) -> Vec<(String, bool)> {
    rows.iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().to_string(),
                r["world"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[test]
fn identities_list_the_live_pages_with_the_slug_by_source_with_checkout_and_world_mark() {
    let b = brain("valid-time-identities");
    source(&b, "beta", Some("/srv/brain/beta"));
    source(&b, "alpha", None);
    put(&b, "default", "notes/shared", "Default.", json!({}));
    put(&b, "beta", "notes/shared", "Beta.", json!({}));
    put(
        &b,
        "alpha",
        "notes/shared",
        "Alpha.",
        json!({ "visibility": "private" }),
    );
    b.soft_delete_page("notes/shared", Some("default")).unwrap();

    let all = identities(
        &b,
        json!({ "slug": "notes/shared", "sourceId": null, "sourceIds": null, "excludePrivate": null }),
    );
    assert_eq!(
        sources_of(&all),
        [("alpha".into(), false), ("beta".into(), true)]
    );
    assert_eq!(all[1]["local_path"], json!("/srv/brain/beta"));
    assert_eq!(all[0]["local_path"], Value::Null);
    assert_eq!(all[1]["slug"], json!("notes/shared"));
    assert!(all[1]["id"].as_u64().unwrap() > 0);

    let one = identities(
        &b,
        json!({ "slug": "notes/shared", "sourceId": "beta", "sourceIds": null, "excludePrivate": null }),
    );
    assert_eq!(sources_of(&one), [("beta".into(), true)]);
    let listed = identities(
        &b,
        json!({ "slug": "notes/shared", "sourceId": null, "sourceIds": ["default", "alpha"], "excludePrivate": null }),
    );
    assert_eq!(sources_of(&listed), [("alpha".into(), false)]);
    let public = identities(
        &b,
        json!({ "slug": "notes/shared", "sourceId": null, "sourceIds": null,
                "excludePrivate": { "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" } }),
    );
    assert_eq!(sources_of(&public), [("beta".into(), true)]);
    // Without the privacy part the policy only reads the reader list, which no page names.
    let readers_only = identities(
        &b,
        json!({ "slug": "notes/shared", "sourceId": null, "sourceIds": null,
                "excludePrivate": { "honorAliases": false, "entityPrivacy": false, "ownerOnly": "fn" } }),
    );
    assert_eq!(readers_only.len(), 2);
    assert!(
        identities(
            &b,
            json!({ "slug": "notes/missing", "sourceId": null, "sourceIds": null, "excludePrivate": null })
        )
        .is_empty()
    );
}

#[test]
fn identities_stop_at_six_rows() {
    let b = brain("valid-time-identities-limit");
    for i in 0..7 {
        let id = format!("s{i}");
        source(&b, &id, None);
        put(&b, &id, "notes/many", "Body.", json!({}));
    }
    let rows = identities(
        &b,
        json!({ "slug": "notes/many", "sourceId": null, "sourceIds": null, "excludePrivate": null }),
    );
    let ids: Vec<String> = sources_of(&rows).into_iter().map(|(s, _)| s).collect();
    assert_eq!(ids, ["s0", "s1", "s2", "s3", "s4", "s5"]);
}

fn page_id(b: &Brain, slug: &str) -> i64 {
    identities(
        b,
        json!({ "slug": slug, "sourceId": "default", "sourceIds": null, "excludePrivate": null }),
    )[0]["id"]
        .as_i64()
        .unwrap()
}

fn pick_policy(
    b: &Brain,
    page: i64,
    as_of: &str,
    pin: Option<i64>,
    privacy: bool,
    exclude_private: bool,
) -> Value {
    b.pick_valid_time_edition(&args::<ValidTimePickQuery>(json!({
        "pageId": page, "asOf": as_of, "excludePrivate": exclude_private, "pinOrd": pin, "inlineMaxBytes": 5,
        "policy": { "honorAliases": true, "entityPrivacy": privacy, "ownerOnly": "fn" },
    })))
    .unwrap()
}

fn pick(b: &Brain, page: i64, as_of: &str, pin: Option<i64>) -> Value {
    pick_policy(b, page, as_of, pin, true, false)
}

/// Three editions: v1 from January, v2 from June, and the current page from March.
fn seed_editions(b: &Brain) -> (i64, i64, i64) {
    put(
        b,
        "default",
        "notes/policy",
        "Jan.",
        json!({ "valid_from": "2026-01-01" }),
    );
    let v1 = snapshot(b, "notes/policy");
    put(
        b,
        "default",
        "notes/policy",
        "June edition.",
        json!({ "valid_from": "2026-06-01T00:00:00Z", "valid_until": "2026-08-01" }),
    );
    let v2 = snapshot(b, "notes/policy");
    put(
        b,
        "default",
        "notes/policy",
        "Mar.",
        json!({ "valid_from": "2026-03-01" }),
    );
    (page_id(b, "notes/policy"), v1, v2)
}

#[test]
fn the_pick_takes_the_latest_edition_in_force_with_its_neighbours_and_competitors() {
    let b = brain("valid-time-pick");
    let (page, v1, v2) = seed_editions(&b);
    let r = pick(&b, page, "2026-07-01", None)["row"].clone();
    assert_eq!(r["version_id"], json!(v2));
    assert_eq!(r["ord"], json!(v2));
    assert_eq!(r["chosen"], json!(true));
    assert_eq!(r["valid_from"], json!("2026-06-01"));
    assert_eq!(r["valid_until"], json!("2026-08-01"));
    assert!(r["recorded_since"].is_string());
    assert!(r["replaced_at"].is_string());
    assert_eq!(r["competing"], json!([VALID_TIME_CURRENT_ORD]));
    assert_eq!(r["successor_tier"], json!("unknown"));
    assert_eq!(r["large_versions"], json!(1));
    assert_eq!(r["undated"], json!(0));
    assert_eq!(r["reason"], Value::Null);
    assert_eq!(r["introduced_because"], Value::Null);
    assert_eq!(r["gap_at"], Value::Null);
    assert_eq!(r["successor_pruned"], json!(false));

    let before = pick(&b, page, "2025-01-01", None)["row"].clone();
    assert_eq!(
        (
            before["version_id"].clone(),
            before["chosen"].clone(),
            before["recorded_since"].clone()
        ),
        (json!(v1), json!(false), Value::Null)
    );
    assert_eq!(before["competing"], Value::Null);

    // A row starts its validity on its own date.
    let first_day = pick(&b, page, "2026-06-01", None)["row"].clone();
    assert_eq!(
        (first_day["version_id"].clone(), first_day["chosen"].clone()),
        (json!(v2), json!(true))
    );
    let march = pick(&b, page, "2026-04-01", None)["row"].clone();
    assert_eq!(march["ord"], json!(VALID_TIME_CURRENT_ORD));
    assert_eq!(march["version_id"], Value::Null);
    assert_eq!(march["successor_tier"], Value::Null);

    let pinned = pick(&b, page, "2027-01-01", Some(v1))["row"].clone();
    assert_eq!(pinned["version_id"], json!(v1));
    assert_eq!(
        pick(&b, page, "2027-01-01", Some(987_654))["row"]["ord"],
        Value::Null
    );
    assert_eq!(
        pick(&b, 987_654, "2026-07-01", None),
        json!({ "row": null })
    );
}

#[test]
fn the_pick_counts_undated_rows_and_reads_null_columns_when_nothing_is_dated() {
    let b = brain("valid-time-undated");
    put(
        &b,
        "default",
        "notes/undated",
        "One.",
        json!({ "valid_from": "2026-02-30" }),
    );
    snapshot(&b, "notes/undated");
    put(&b, "default", "notes/undated", "Two.", json!({}));
    let page = page_id(&b, "notes/undated");
    let r = pick(&b, page, "2026-07-01", None)["row"].clone();
    assert_eq!(r["ord"], Value::Null);
    assert_eq!(r["chosen"], Value::Null);
    assert_eq!(r["undated"], json!(2));
    assert_eq!(r["any_filed"], json!(false));
    assert!(r["created_at"].is_string());
}

#[test]
fn the_pick_reads_the_marks_a_large_page_prune_leaves() {
    let b = brain("valid-time-pruned");
    let slug = "notes/large";
    put(
        &b,
        "default",
        slug,
        "Small.",
        json!({ "valid_from": "2026-01-01" }),
    );
    let small = b
        .create_version_with(slug, Some("default"), Some("grew"))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let large = "x".repeat(1024 * 1024 + 1);
    put(
        &b,
        "default",
        slug,
        &large,
        json!({ "valid_from": "2026-03-01" }),
    );
    let page = page_id(&b, slug);
    let ids: Vec<i64> = (0..6).map(|_| snapshot(&b, slug)).collect();
    // Six large snapshots: the oldest goes, and the small version before it loses its successor.
    let kept: Vec<i64> = b
        .get_versions(slug, &args(json!({ "includeBody": false })))
        .unwrap()
        .iter()
        .map(|v| v["id"].as_i64().unwrap())
        .collect();
    let mut want: Vec<i64> = ids[1..].iter().rev().copied().collect();
    want.push(small);
    assert_eq!(kept, want);

    let r = pick(&b, page, "2026-02-01", None)["row"].clone();
    assert_eq!(r["version_id"], json!(small));
    assert_eq!(r["successor_pruned"], json!(true));
    assert_eq!(r["reason"], json!("grew"));
    // The five kept large versions, and the small one: the read counts bodies over 5 bytes.
    assert_eq!(r["large_versions"], json!(6));
    assert!(r["gap_at"].is_string());
    // A reader held to visible text never sees a reason whose successor is gone.
    let hidden = pick_policy(&b, page, "2026-02-01", None, true, true)["row"].clone();
    assert_eq!(hidden["reason"], Value::Null);
    // The oldest kept large version was introduced by a pruned successor: no reason introduces it.
    let next = pick(&b, page, "2026-04-01", Some(ids[1]))["row"].clone();
    assert_eq!(next["version_id"], json!(ids[1]));
    assert_eq!(next["introduced_because"], Value::Null);
    assert_eq!(next["successor_pruned"], json!(false));
}

#[test]
fn a_rename_that_prunes_keeps_the_gap_it_records() {
    let b = brain("valid-time-rename-prune");
    let large = "x".repeat(1024 * 1024 + 1);
    put(
        &b,
        "default",
        "notes/big",
        &large,
        json!({ "valid_from": "2026-01-01" }),
    );
    for _ in 0..5 {
        snapshot(&b, "notes/big");
    }
    let page = page_id(&b, "notes/big");
    assert_eq!(
        pick(&b, page, "2026-07-01", None)["row"]["gap_at"],
        Value::Null
    );
    // The rename's own snapshot is the sixth large version: it prunes the oldest, and the renamed
    // page keeps the gap that prune recorded.
    b.update_slug("notes/big", "notes/bigger", None).unwrap();
    assert!(pick(&b, page, "2026-07-01", None)["row"]["gap_at"].is_string());
}

#[test]
fn the_pick_reads_no_gap_on_a_history_no_prune_cut() {
    let b = brain("valid-time-unpruned");
    let (page, _, _) = seed_editions(&b);
    let r = pick(&b, page, "2026-07-01", None)["row"].clone();
    assert_eq!(r["gap_at"], Value::Null);
    // A history gap the caller records reads back as the page's gap.
    b.create_version_opts(
        "notes/policy",
        &args(json!({ "sourceId": "default", "historyGap": true })),
    )
    .unwrap();
    assert!(pick(&b, page, "2026-07-01", None)["row"]["gap_at"].is_string());
}

#[test]
fn the_pick_marks_a_private_edition_invisible() {
    let b = brain("valid-time-private");
    put(
        &b,
        "default",
        "notes/secret",
        "Hidden.",
        json!({ "valid_from": "2026-01-01", "visibility": "private" }),
    );
    let v1 = snapshot(&b, "notes/secret");
    put(
        &b,
        "default",
        "notes/secret",
        "Open.",
        json!({ "valid_from": "2026-06-01" }),
    );
    let page = page_id(&b, "notes/secret");
    let old = pick(&b, page, "2026-02-01", None)["row"].clone();
    assert_eq!(
        (old["version_id"].clone(), old["visible"].clone()),
        (json!(v1), json!(false))
    );
    let now = pick(&b, page, "2026-07-01", None)["row"].clone();
    assert_eq!(now["visible"], json!(true));
    let unjudged = pick_policy(&b, page, "2026-02-01", None, false, false);
    assert_eq!(unjudged["row"]["visible"], json!(true));
    // A version that names readers stays hidden under either policy.
    put(
        &b,
        "default",
        "notes/listed",
        "Listed.",
        json!({ "valid_from": "2026-01-01", "readable_by": ["alice-example"] }),
    );
    snapshot(&b, "notes/listed");
    put(
        &b,
        "default",
        "notes/listed",
        "Open.",
        json!({ "valid_from": "2026-06-01" }),
    );
    let listed = page_id(&b, "notes/listed");
    let r = pick_policy(&b, listed, "2026-02-01", None, false, false);
    assert_eq!(r["row"]["visible"], json!(false));
    // The current page is judged by the page policy.
    put(
        &b,
        "default",
        "notes/now-secret",
        "Hidden now.",
        json!({ "valid_from": "2026-01-01", "visibility": "private" }),
    );
    let now_secret = page_id(&b, "notes/now-secret");
    let r = pick(&b, now_secret, "2026-02-01", None)["row"].clone();
    assert_eq!(
        (r["ord"].clone(), r["visible"].clone()),
        (json!(VALID_TIME_CURRENT_ORD), json!(false))
    );
}

/// The pick under a caller's readers: a version that names readers is visible to a policy whose
/// identity one of them is, and a private version to a grant on the page's source.
fn pick_as(b: &Brain, page: i64, policy: Value) -> bool {
    b.pick_valid_time_edition(&args::<ValidTimePickQuery>(json!({
        "pageId": page, "asOf": "2026-02-01", "excludePrivate": true, "pinOrd": null,
        "inlineMaxBytes": 1_000_000, "policy": policy,
    })))
    .unwrap()["row"]["visible"]
        .as_bool()
        .unwrap()
}

#[test]
fn the_pick_judges_a_version_by_the_callers_readers_and_grants() {
    let b = brain("valid-time-readers");
    source(&b, "vault", None);
    put(
        &b,
        "default",
        "notes/listed",
        "Listed.",
        json!({ "valid_from": "2026-01-01", "readable_by": ["alice-example"] }),
    );
    snapshot(&b, "notes/listed");
    put(
        &b,
        "default",
        "notes/listed",
        "Open.",
        json!({ "valid_from": "2026-06-01" }),
    );
    put(
        &b,
        "vault",
        "notes/secret",
        "Hidden.",
        json!({ "valid_from": "2026-01-01", "visibility": "private" }),
    );
    b.create_version("notes/secret", Some("vault")).unwrap();
    put(
        &b,
        "vault",
        "notes/secret",
        "Open.",
        json!({ "valid_from": "2026-06-01" }),
    );
    let listed = page_id(&b, "notes/listed");
    let secret = identities(
        &b,
        json!({ "slug": "notes/secret", "sourceId": "vault", "sourceIds": null, "excludePrivate": null }),
    )[0]["id"]
        .as_i64()
        .unwrap();
    let policy = |identity: Value, grants: Value| {
        json!({ "honorAliases": true, "entityPrivacy": true,
                "identity": identity, "privateReadableSources": grants })
    };
    let none = policy(json!([]), json!([]));
    let reader = policy(json!(["member:alice-example"]), json!([]));
    let stranger = policy(json!(["member:bob-example"]), json!([]));
    let granted = policy(json!([]), json!(["vault"]));
    let wrong_grant = policy(json!([]), json!(["default"]));
    assert!(!pick_as(&b, listed, none.clone()));
    assert!(pick_as(&b, listed, reader.clone()));
    assert!(!pick_as(&b, listed, stranger));
    // A grant opens privacy, never readers.
    assert!(!pick_as(&b, listed, wrong_grant.clone()));
    assert!(!pick_as(&b, secret, none));
    assert!(!pick_as(&b, secret, reader));
    assert!(pick_as(&b, secret, granted));
    assert!(!pick_as(&b, secret, wrong_grant));
}

#[test]
fn a_later_row_from_the_same_date_does_not_compete() {
    let b = brain("valid-time-same-date");
    put(
        &b,
        "default",
        "notes/same",
        "First.",
        json!({ "valid_from": "2026-01-01" }),
    );
    let v1 = snapshot(&b, "notes/same");
    put(
        &b,
        "default",
        "notes/same",
        "Second.",
        json!({ "valid_from": "2026-01-01" }),
    );
    let page = page_id(&b, "notes/same");
    let r = pick(&b, page, "2026-02-01", Some(v1))["row"].clone();
    assert_eq!(r["version_id"], json!(v1));
    assert_eq!(r["competing"], Value::Null);
    // With no pin the most recently recorded row from that date wins.
    let latest = pick(&b, page, "2026-02-01", None)["row"].clone();
    assert_eq!(latest["ord"], json!(VALID_TIME_CURRENT_ORD));
}

/// `replacedBecauseSql`: the reason a picked version carries for an `excludePrivate` reader is
/// withheld when its successor is private, even for a caller whose private-readable grant opens
/// that successor: the successor is judged by its own fields, never the grant.
#[test]
fn a_grant_never_opens_the_reason_a_private_successor_gave() {
    let b = brain("valid-time-successor-grant");
    put(
        &b,
        "default",
        "vt/p",
        "One.",
        json!({ "valid_from": "2026-01-01" }),
    );
    b.create_version_with("vt/p", Some("default"), Some("r1"))
        .unwrap();
    put(
        &b,
        "default",
        "vt/p",
        "Two.",
        json!({ "valid_from": "2026-02-01", "visibility": "private" }),
    );
    b.create_version_with("vt/p", Some("default"), Some("r2"))
        .unwrap();
    put(
        &b,
        "default",
        "vt/p",
        "Three.",
        json!({ "valid_from": "2026-03-01" }),
    );
    let page = page_id(&b, "vt/p");
    let reason = |exclude_private: bool, grants: Value| {
        b.pick_valid_time_edition(&args::<ValidTimePickQuery>(json!({
            "pageId": page, "asOf": "2026-01-15", "excludePrivate": exclude_private, "pinOrd": null,
            "inlineMaxBytes": 1_000_000,
            "policy": { "honorAliases": true, "entityPrivacy": true,
                        "identity": ["member:alice-example"], "privateReadableSources": grants },
        })))
        .unwrap()["row"]["reason"]
            .clone()
    };
    assert_eq!(reason(false, json!([])), json!("r1"));
    assert_eq!(reason(true, json!([])), Value::Null);
    assert_eq!(reason(true, json!(["default"])), Value::Null);
}
