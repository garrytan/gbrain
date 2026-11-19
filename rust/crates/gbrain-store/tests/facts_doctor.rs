//! The doctor-check reads of the facts family (`facts/doctor.rs`): the PGLite semantics of each.

mod memory_env;

use gbrain_store::facts::doctor::{
    ConversationRowsQuery, CoverageQuery, RedactedQuery, UnlinkedQuery,
};
use gbrain_store::facts::relink::{AttemptInput, UpsertOptions};
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs, InsertFactsArgs};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU32, Ordering};

static ROW: AtomicU32 = AtomicU32::new(1);

const DAY: i64 = 86_400_000_000;
const TERMINAL: &str = "cli:extract-conversation-facts:terminal:v2";
const CONVERSATION: &str = "cli:extract-conversation-facts";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str, config: Value) {
    b.upsert_source(&args::<SourceInput>(
        json!({ "id": id, "name": id, "config": config }),
    ))
    .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str, kind: &str, frontmatter: Value) -> i64 {
    let input: PageInput = args(json!({
        "type": kind, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
    }));
    let options: PutPageOptions = args(json!({ "sourceId": source_id }));
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// A fact row. One that names a page (`source_markdown_slug`) goes in through `insertFacts`, the only
/// writer of the fence columns, with a fresh `row_num` unless the input gives one.
fn fact(b: &Brain, source_id: &str, input: Value) -> u64 {
    let mut input = input;
    input["source"] = input.get("source").cloned().unwrap_or(json!("chat"));
    if input.get("source_markdown_slug").is_some() {
        if input.get("row_num").is_none() {
            input["row_num"] = json!(ROW.fetch_add(1, Ordering::Relaxed));
        }
        let out = b
            .insert_facts(&args::<InsertFactsArgs>(
                json!({ "rows": [input], "sourceId": source_id }),
            ))
            .unwrap();
        return out["ids"][0].as_u64().unwrap();
    }
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": source_id }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// A 1536-wide vector literal (the width of the column).
fn vector(width: usize) -> String {
    let mut v = vec!["0"; width];
    v[0] = "1";
    format!("[{}]", v.join(","))
}

fn unlinked(v: Value) -> UnlinkedQuery {
    args(v)
}

#[test]
fn conversation_rows_are_the_unexpired_checkpoint_rows_newest_first() {
    let b = brain("doctor-conv");
    source(&b, "other", json!({}));
    let mk = |sid: &str, src: &str, slug: &str| {
        fact(
            &b,
            sid,
            json!({ "fact": slug, "source": src, "source_markdown_slug": slug, "context": "ctx" }),
        )
    };
    mk("default", TERMINAL, "a");
    mk(
        "default",
        "cli:extract-conversation-facts:non-extractable:v2",
        "b",
    );
    mk(
        "default",
        "cli:extract-conversation-facts:terminal",
        "legacy",
    );
    mk("default", CONVERSATION, "plain");
    mk("other", TERMINAL, "c");
    let gone = mk("default", TERMINAL, "gone");
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone as f64 })))
        .unwrap();
    let rows = b
        .list_conversation_fact_rows(&args::<ConversationRowsQuery>(
            json!({ "sourceIds": ["default", "other"], "limit": 10 }),
        ))
        .unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["c", "b", "a"]);
    assert_eq!(rows[0]["source_id"], "other");
    assert_eq!(rows[0]["context"], "ctx");
    let one = b
        .list_conversation_fact_rows(&args(json!({ "sourceIds": ["default"], "limit": 1 })))
        .unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0]["slug"], "b");
    let none = b
        .list_conversation_fact_rows(&args(json!({ "sourceIds": [], "limit": 5 })))
        .unwrap();
    assert!(none.is_empty());
    assert!(
        b.list_conversation_fact_rows(&args(json!({ "sourceIds": ["default"], "limit": -1 })))
            .is_err()
    );
}

#[test]
fn redacted_facts_count_active_rows_in_live_sources() {
    let b = brain("doctor-redacted");
    source(&b, "other", json!({}));
    source(&b, "old", json!({}));
    fact(&b, "default", json!({ "fact": "key is [redacted:token]" }));
    fact(&b, "default", json!({ "fact": "all clear" }));
    fact(&b, "other", json!({ "fact": "[redacted" }));
    fact(&b, "old", json!({ "fact": "[redacted] too" }));
    let gone = fact(&b, "default", json!({ "fact": "[redacted] expired" }));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone as f64 })))
        .unwrap();
    b.set_source_archived("old", true).unwrap();
    let count = |ids: Option<Vec<&str>>| {
        b.count_redacted_facts(&RedactedQuery {
            source_ids: ids.map(|v| v.into_iter().map(String::from).collect()),
        })
        .unwrap()
    };
    assert_eq!(count(None), 2);
    assert_eq!(count(Some(vec!["default"])), 1);
    assert_eq!(count(Some(vec!["old"])), 0);
    assert_eq!(count(Some(vec![])), 0);
}

#[test]
fn outside_fences_count_rows_indexed_from_third_party_pages() {
    let b = brain("doctor-fences");
    source(&b, "mail", json!({ "kind": "google" }));
    source(&b, "gh", json!({ "kind": "github" }));
    source(&b, "dead", json!({ "kind": "github" }));
    let email = page(&b, "mail", "inbox/one", "email", json!({}));
    page(&b, "mail", "notes/own", "note", json!({}));
    page(&b, "gh", "repo/issue", "note", json!({}));
    let gone = page(&b, "gh", "repo/deleted", "note", json!({}));
    page(
        &b,
        "default",
        "calls/standup",
        "note",
        json!({ "transcript_import": true }),
    );
    page(&b, "default", "calls/plain", "note", json!({}));
    page(&b, "dead", "repo/x", "note", json!({}));
    b.soft_delete_page("repo/deleted", Some("gh")).unwrap();
    let _ = gone;
    let row = |sid: &str, slug: &str, n: f64, vis: &str| {
        fact(
            &b,
            sid,
            json!({ "fact": format!("{slug}-{n}"), "source_markdown_slug": slug, "row_num": n, "visibility": vis }),
        )
    };
    row("mail", "inbox/one", 1.0, "world");
    row("mail", "inbox/one", 2.0, "private");
    row("mail", "notes/own", 1.0, "world");
    row("gh", "repo/issue", 1.0, "world");
    row("gh", "repo/deleted", 1.0, "world");
    row("default", "calls/standup", 1.0, "private");
    row("default", "calls/plain", 1.0, "world");
    row("dead", "repo/x", 1.0, "world");
    let expired = row("mail", "inbox/one", 3.0, "world");
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired as f64 })))
        .unwrap();
    b.set_source_archived("dead", true).unwrap();
    let take: TakeInput = args(
        json!({ "page_id": email, "row_num": 1, "claim": "c", "kind": "fact", "holder": "h", "weight": 0.5, "active": true }),
    );
    let off: TakeInput = args(
        json!({ "page_id": email, "row_num": 2, "claim": "d", "kind": "fact", "holder": "h", "weight": 0.5, "active": false }),
    );
    b.add_takes_batch(&[take, off]).unwrap();
    let link: AddLinkOptions = args(
        json!({ "linkType": "x", "originSlug": "inbox/one", "originField": "links_fence", "fromSourceId": "mail", "toSourceId": "gh", "originSourceId": "mail" }),
    );
    b.add_link("inbox/one", "repo/issue", &link).unwrap();
    let rows = b.list_outside_content_fence_counts().unwrap();
    let got: Vec<(String, String, String, u64, u64, u64, u64)> = rows
        .iter()
        .map(|r| {
            let s = |k: &str| r[k].as_str().unwrap().to_string();
            let n = |k: &str| r[k].as_u64().unwrap();
            (
                s("source_id"),
                s("slug"),
                s("type"),
                n("facts"),
                n("world_facts"),
                n("takes"),
                n("links"),
            )
        })
        .collect();
    let want = |a: &str, s: &str, t: &str, n: [u64; 4]| {
        (
            a.to_string(),
            s.to_string(),
            t.to_string(),
            n[0],
            n[1],
            n[2],
            n[3],
        )
    };
    assert_eq!(
        got,
        vec![
            want("default", "calls/standup", "note", [1, 0, 0, 0]),
            want("gh", "repo/issue", "note", [1, 1, 0, 0]),
            want("mail", "inbox/one", "email", [2, 1, 1, 1]),
        ]
    );
}

#[test]
fn atom_facts_count_unexpired_rows_under_atoms() {
    let b = brain("doctor-atoms");
    source(&b, "other", json!({}));
    fact(
        &b,
        "default",
        json!({ "fact": "a", "source_markdown_slug": "atoms/one" }),
    );
    fact(&b, "other", json!({ "fact": "b", "context": "atoms/two" }));
    fact(
        &b,
        "default",
        json!({ "fact": "c", "source_markdown_slug": "notes/atoms/x" }),
    );
    fact(&b, "default", json!({ "fact": "d", "context": "Atoms/x" }));
    let gone = fact(
        &b,
        "default",
        json!({ "fact": "e", "context": "atoms/expired" }),
    );
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone as f64 })))
        .unwrap();
    assert_eq!(b.count_atom_facts().unwrap(), 2);
}

fn window_fixture() -> Brain {
    let b = brain("doctor-unlinked");
    source(&b, "other", json!({}));
    // Oldest first: the window keeps the newest rows.
    fact(
        &b,
        "default",
        json!({ "fact": "old", "source": CONVERSATION, "source_markdown_slug": "conv/old" }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "linked", "entity_slug": "people/a", "source": CONVERSATION, "source_markdown_slug": "conv/a" }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "c1", "source": CONVERSATION, "source_markdown_slug": "conv/b" }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "c2", "source": CONVERSATION, "source_markdown_slug": "conv/b" }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "c3", "source": CONVERSATION, "source_markdown_slug": "conv/c" }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "fence", "source": "chat", "source_markdown_slug": "notes/f", "row_num": 1 }),
    );
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "audit", "source": TERMINAL, "source_markdown_slug": "conv/z" }),
    );
    b.clock.advance(1);
    fact(&b, "default", json!({ "fact": "plain", "source": "chat" }));
    b.clock.advance(1);
    fact(
        &b,
        "default",
        json!({ "fact": "agent", "source": "chat", "attributed_to": "assistant" }),
    );
    b.clock.advance(1);
    fact(&b, "other", json!({ "fact": "o", "source": "chat" }));
    b
}

#[test]
fn unlinked_origin_counts_cover_the_newest_window_of_each_source() {
    let b = window_fixture();
    let q = |window: f64, ids: Value| {
        unlinked(json!({ "sourceIds": ids, "auditSources": [TERMINAL], "windowPerSource": window }))
    };
    let rows = b
        .count_unlinked_facts_by_origin(&q(100.0, json!(["default", "other"])))
        .unwrap();
    let got: Vec<(&str, &str, u64, u64, u64, u64)> = rows
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap(),
                r["origin"].as_str().unwrap(),
                r["active"].as_u64().unwrap(),
                r["unlinked"].as_u64().unwrap(),
                r["fence_owned"].as_u64().unwrap(),
                r["conversation"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("default", "conversation", 5, 4, 0, 4),
            ("default", "remember", 2, 2, 1, 0),
            ("other", "remember", 1, 1, 0, 0),
        ]
    );
    assert!(
        rows.iter()
            .all(|r| r["conversation_tried"] == 0 && r["conversation_paid"] == 0)
    );
    // A window of 3 keeps the newest three active rows: plain, fence, c3.
    let rows = b
        .count_unlinked_facts_by_origin(&q(3.0, json!(["default"])))
        .unwrap();
    let total: u64 = rows.iter().map(|r| r["active"].as_u64().unwrap()).sum();
    assert_eq!(total, 3);
    assert!(
        b.count_unlinked_facts_by_origin(&q(0.0, json!(["default"])))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.count_unlinked_facts_by_origin(&q(1.5, json!(["default"])))
            .is_err()
    );
    // An id given twice counts twice, as `unnest` does.
    let twice = b
        .count_unlinked_facts_by_origin(&q(100.0, json!(["other", "other"])))
        .unwrap();
    assert_eq!(twice[0]["active"], 2);
}

#[test]
fn unlinked_stats_cover_the_last_seven_days_and_the_inferred_tiers() {
    let b = brain("doctor-stats");
    fact(
        &b,
        "default",
        json!({ "fact": "ancient", "context": "entity inferred from page" }),
    );
    b.clock.advance(8 * DAY);
    let infer = |tier: &str, prefix: &str, linked: bool| {
        let mut input =
            json!({ "fact": tier, "context": format!("{prefix}entity inferred from {tier}") });
        if linked {
            input["entity_slug"] = json!("people/a");
        }
        fact(&b, "default", input);
    };
    infer("page", "", false);
    infer("mention", "", true);
    infer("page", "met on Monday — ", false);
    infer("other", "", false);
    fact(&b, "default", json!({ "fact": "plain" }));
    fact(
        &b,
        "default",
        json!({ "fact": "audit", "source": TERMINAL }),
    );
    let stats = b
        .count_unlinked_fact_stats(&unlinked(
            json!({ "sourceIds": ["default"], "auditSources": [TERMINAL] }),
        ))
        .unwrap();
    assert_eq!(
        stats,
        json!({ "facts": 5, "unlinked": 4, "no_subject": 0, "conversation_unresolved": 0,
                "inferred_page": 2, "inferred_mention": 1 })
    );
    let none = b
        .count_unlinked_fact_stats(&unlinked(json!({ "sourceIds": [] })))
        .unwrap();
    assert_eq!(none["facts"], 0);
}

#[test]
fn unlinked_conversation_slugs_rank_pages_by_row_count() {
    let b = window_fixture();
    let q = |fix: &str, window: f64| {
        unlinked(
            json!({ "sourceId": "default", "auditSources": [TERMINAL], "windowPerSource": window, "fix": fix }),
        )
    };
    let slugs = |rows: Vec<Value>| -> Vec<String> {
        rows.iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        slugs(
            b.list_unlinked_conversation_slugs(&q("relink", 100.0))
                .unwrap()
        ),
        ["conv/b", "conv/c", "conv/old"]
    );
    assert!(
        b.list_unlinked_conversation_slugs(&q("reextract", 100.0))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_unlinked_conversation_slugs(&q("manual", 100.0))
            .unwrap()
            .is_empty()
    );
    // The attributed row is not an entity fact, so the window of 3 holds plain, fence and c3.
    assert_eq!(
        slugs(
            b.list_unlinked_conversation_slugs(&q("relink", 3.0))
                .unwrap()
        ),
        ["conv/c"]
    );
    // The window of 5 adds c2 and c1: conv/b has two rows, conv/c one.
    assert_eq!(
        slugs(
            b.list_unlinked_conversation_slugs(&q("relink", 5.0))
                .unwrap()
        ),
        ["conv/b", "conv/c"]
    );
}

/// `REARMED` of facts/conversation-memo.ts, as the TypeScript member passes it (a subset is enough here).
const REARMED: [&str; 2] = ["no_mention", "no_page"];

fn attempt(
    b: &Brain,
    id: u64,
    outcome: &str,
    reason: Option<&str>,
    tier: Option<&str>,
    slug: Option<&str>,
) {
    let a: AttemptInput = args(json!({
        "factId": id as f64, "outcome": outcome, "reason": reason, "tier": tier, "targetSlug": slug,
    }));
    b.upsert_fact_relink_attempt("default", &a, &UpsertOptions::default())
        .unwrap();
}

#[test]
fn relink_outcomes_count_linked_rows_of_the_last_seven_days_and_every_no_subject_row() {
    let b = brain("doctor-relink-window");
    attempt(&b, 1, "linked", None, Some("mention"), None);
    attempt(&b, 2, "no_subject", None, Some("model"), None);
    attempt(&b, 3, "ambiguous", None, None, None);
    let count = || b.count_fact_relink_outcomes(&["default".into()]).unwrap();
    let both = [
        json!({ "outcome": "linked", "tier": "mention", "n": 1 }),
        json!({ "outcome": "no_subject", "tier": "model", "n": 1 }),
    ];
    // Exactly seven days old is still inside the window (`attempted_at >= now() - 7 days`).
    b.clock.advance(7 * DAY);
    assert_eq!(count(), both);
    // One microsecond later the linked row drops out; the no_subject row never ages out.
    b.clock.advance(1);
    assert_eq!(count(), [both[1].clone()]);
}

#[test]
fn attempts_forms_read_the_tried_paid_and_no_subject_memos() {
    let b = brain("doctor-attempts");
    let conv = |b: &Brain, fact_text: &str, slug: &str| {
        fact(
            b,
            "default",
            json!({ "fact": fact_text, "source": CONVERSATION, "source_markdown_slug": slug }),
        )
    };
    let old = conv(&b, "old", "conv/old");
    b.clock.advance(1);
    let c1 = conv(&b, "c1", "conv/b");
    b.clock.advance(1);
    let c2 = conv(&b, "c2", "conv/b");
    b.clock.advance(1);
    let c3 = conv(&b, "c3", "conv/c");
    b.clock.advance(1);
    let plain = fact(&b, "default", json!({ "fact": "plain", "source": "chat" }));
    b.clock.advance(1);
    // c1's reason is memoized, c2's re-armed, c3's NULL; old has no attempt.
    attempt(
        &b,
        c1,
        "conversation_unresolved",
        Some("ambiguous"),
        Some("mention"),
        None,
    );
    attempt(
        &b,
        c2,
        "conversation_unresolved",
        Some("no_mention"),
        Some("mention"),
        None,
    );
    attempt(
        &b,
        c3,
        "conversation_unresolved",
        None,
        Some("mention"),
        None,
    );
    attempt(
        &b,
        plain,
        "no_subject",
        Some("no_subject"),
        Some("model"),
        None,
    );
    let _ = old;
    let q = |fix: &str, has: bool| {
        unlinked(json!({
            "sourceIds": ["default"], "sourceId": "default", "auditSources": [TERMINAL], "windowPerSource": 100,
            "fix": fix, "hasAttempts": has, "rearmedReasons": REARMED,
        }))
    };
    let slugs = |fix: &str, has: bool| -> Vec<String> {
        b.list_unlinked_conversation_slugs(&q(fix, has))
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    let conversation = |has: bool| -> (u64, u64) {
        let rows = b.count_unlinked_facts_by_origin(&q("relink", has)).unwrap();
        let row = rows.iter().find(|r| r["origin"] == "conversation").unwrap();
        (
            row["conversation_tried"].as_u64().unwrap(),
            row["conversation_paid"].as_u64().unwrap(),
        )
    };
    let stats = |has: bool| -> (u64, u64) {
        let s = b.count_unlinked_fact_stats(&q("relink", has)).unwrap();
        (
            s["no_subject"].as_u64().unwrap(),
            s["conversation_unresolved"].as_u64().unwrap(),
        )
    };
    // No live page yet: every attempted row is tried, none paid.
    assert_eq!(conversation(true), (3, 0));
    assert_eq!(stats(true), (1, 3));
    assert_eq!(slugs("relink", true), ["conv/old"]);
    assert_eq!(slugs("reextract", true), ["conv/b", "conv/c"]);
    assert!(slugs("manual", true).is_empty());
    // Without the table every memo is false.
    assert_eq!(conversation(false), (0, 0));
    assert_eq!(stats(false), (0, 0));
    assert_eq!(slugs("relink", false), ["conv/b", "conv/c", "conv/old"]);
    // A page created after the attempts re-arms c2 (a re-armed reason) and c3 (a NULL reason).
    b.clock.advance(1);
    let hash = {
        let input: PageInput =
            args(json!({ "type": "note", "title": "b", "compiled_truth": "body" }));
        let options: PutPageOptions = args(json!({ "sourceId": "default" }));
        b.put_page("conv/b", &input, &options).unwrap()["content_hash"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(conversation(true), (1, 0));
    assert_eq!(stats(true), (1, 1));
    assert_eq!(slugs("relink", true), ["conv/b", "conv/c", "conv/old"]);
    assert_eq!(slugs("reextract", true), ["conv/b"]);
    // A paid memo on another fact id, with a stale hash, does not cover the page; the current hash does.
    attempt(
        &b,
        9_999,
        "paid_reextract",
        Some("stale"),
        Some("paid_reextract"),
        Some("conv/b"),
    );
    assert_eq!(conversation(true), (1, 0));
    attempt(
        &b,
        9_998,
        "paid_reextract",
        Some(&hash),
        Some("paid_reextract"),
        Some("conv/b"),
    );
    assert_eq!(conversation(true), (1, 1));
    assert_eq!(slugs("manual", true), ["conv/b"]);
    assert!(slugs("reextract", true).is_empty());
    // Deleting the page's paid memos uncovers it.
    b.delete_fact_relink_memos("default", "paid_reextract", "conv/b")
        .unwrap();
    assert_eq!(conversation(true), (1, 0));
    let outcomes = b.count_fact_relink_outcomes(&["default".into()]).unwrap();
    assert_eq!(
        outcomes,
        [json!({ "outcome": "no_subject", "tier": "model", "n": 1 })]
    );
}

#[test]
fn embedding_coverage_counts_missing_stale_and_partial_rows() {
    let b = brain("doctor-coverage");
    source(&b, "other", json!({}));
    source(&b, "old", json!({}));
    let model = "m1";
    let vec3 = vector(1536);
    let ok = |sid: &str, text: &str, extra: Value| {
        let mut input = json!({ "fact": text, "embedding": vec3, "embedding_model": model });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        fact(&b, sid, input)
    };
    ok("default", "fresh", json!({}));
    fact(&b, "default", json!({ "fact": "no vector" }));
    ok("default", "other model", json!({ "embedding_model": "m0" }));
    ok("default", &"x".repeat(8001), json!({}));
    ok("default", &"x".repeat(8000), json!({}));
    ok("default", &"😀".repeat(4001), json!({}));
    ok("default", &"😀".repeat(2500), json!({}));
    ok(
        "default",
        "audit",
        json!({ "source": TERMINAL, "embedding_model": "m0" }),
    );
    ok(
        "default",
        "on deleted page",
        json!({ "source_markdown_slug": "gone", "embedding_model": "m0" }),
    );
    let expired = ok("default", "expired", json!({ "embedding_model": "m0" }));
    b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired as f64 })))
        .unwrap();
    ok(
        "default",
        "lapsed",
        json!({ "embedding_model": "m0", "valid_until": "2000-01-01T00:00:00.000Z" }),
    );
    page(&b, "default", "gone", "note", json!({}));
    b.soft_delete_page("gone", Some("default")).unwrap();
    fact(&b, "other", json!({ "fact": "o" }));
    fact(&b, "old", json!({ "fact": "archived" }));
    b.set_source_archived("old", true).unwrap();
    let cov = |source_id: Option<&str>, dims: f64| {
        b.count_fact_embedding_coverage(&CoverageQuery {
            source_id: source_id.map(String::from),
            model: model.to_string(),
            dims,
        })
        .unwrap()
    };
    let row = |r: &Value| {
        (
            r["source_id"].as_str().unwrap().to_string(),
            r["missing"].as_u64().unwrap(),
            r["stale"].as_u64().unwrap(),
            r["partial"].as_u64().unwrap(),
        )
    };
    let rows: Vec<_> = cov(None, 1536.0).iter().map(row).collect();
    assert_eq!(
        rows,
        [
            ("default".to_string(), 1, 2, 2),
            ("other".to_string(), 1, 1, 0)
        ]
    );
    let one: Vec<_> = cov(Some("other"), 1536.0).iter().map(row).collect();
    assert_eq!(one, [("other".to_string(), 1, 1, 0)]);
    assert!(cov(Some("old"), 1536.0).is_empty());
    assert!(cov(Some("nope"), 1536.0).is_empty());
    // Another width makes every embedded row stale; none is partial then.
    let narrow: Vec<_> = cov(Some("default"), 1024.0).iter().map(row).collect();
    assert_eq!(narrow, [("default".to_string(), 1, 7, 0)]);
    assert!(
        b.count_fact_embedding_coverage(&CoverageQuery {
            source_id: None,
            model: model.into(),
            dims: 1.5
        })
        .is_err()
    );
}

#[test]
fn embedding_coverage_leaves_out_a_claim_withdrawn_after_it_was_saved() {
    let b = brain("doctor-coverage-withdrawal");
    let cov = || {
        let rows = b
            .count_fact_embedding_coverage(&CoverageQuery {
                source_id: Some("default".into()),
                model: "m1".into(),
                dims: 1536.0,
            })
            .unwrap();
        rows.first().map_or(0, |r| r["missing"].as_u64().unwrap())
    };
    fact(
        &b,
        "default",
        json!({ "fact": "x", "entity_slug": "people/a", "visibility": "world" }),
    );
    fact(
        &b,
        "default",
        json!({ "fact": "x", "entity_slug": "people/b", "visibility": "world" }),
    );
    fact(
        &b,
        "default",
        json!({ "fact": "x", "entity_slug": "people/a", "visibility": "private" }),
    );
    fact(
        &b,
        "default",
        json!({ "fact": "keep", "entity_slug": "people/a", "visibility": "world" }),
    );
    assert_eq!(cov(), 4);
    // a withdrawal under people/a: only the world `x` about people/a leaves the count
    b.insert_fact_withdrawal("default", "world", "x", "people/a", None)
        .unwrap();
    assert_eq!(cov(), 3);
    // subject `*` reaches every entity at that visibility
    b.insert_fact_withdrawal("default", "world", "x", "*", None)
        .unwrap();
    assert_eq!(cov(), 2);
}
