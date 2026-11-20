//! The page embedding lease and the per-page spend ledgers (`engine-sql/page-spend.ts`,
//! rust/docs/store/page_spend.md), matched to the PGLite statements they serve.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::jobs::{LeaseHolder, LockFilter};
use gbrain_store::page_body::{
    BudgetLimitedPagesOpts, PageEmbeddingHolds, PageSpendLedger, PageSpendReservationWrite,
    PageSpendSettle,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::brain;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const TOKEN_A: &str = "00000000-0000-4000-8000-00000000000a";
const TOKEN_B: &str = "00000000-0000-4000-8000-00000000000b";
const MINUTE: i64 = 60_000_000;

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// An inline page with `frontmatter` and `body`; returns (id, knowledge revision).
fn page(store: &Store, slug: &str, frontmatter: Value, body: &str) -> (i64, String) {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": body, "frontmatter": frontmatter,
    }));
    let row = store
        .put_page(slug, &input, &de::<PutPageOptions>(json!({"index": false})))
        .unwrap();
    (
        row["id"].as_i64().unwrap(),
        row["knowledge_revision"].as_str().unwrap().to_string(),
    )
}

fn seal(store: &Store, slug: &str, revision: &str, chunks: Value) {
    store
        .upsert_chunks(
            slug,
            &de::<Vec<ChunkInput>>(chunks),
            &UpsertChunksOptions {
                expected_revision: Some(revision.to_string()),
                seal: true,
                ..Default::default()
            },
        )
        .unwrap();
}

fn holder() -> LeaseHolder {
    de(json!({"pid": 41, "host": "host-a"}))
}

fn budget(page_id: i64) -> PageSpendLedger {
    de(json!({"table": "page_embedding_budget", "pageId": page_id}))
}

fn derivation(page_id: i64, family: &str) -> PageSpendLedger {
    de(json!({"table": "page_derivation_spend", "pageId": page_id, "family": family}))
}

fn write(v: Value) -> PageSpendReservationWrite {
    de(v)
}

fn settle(v: Value) -> PageSpendSettle {
    de(v)
}

fn lock_ids(store: &Store) -> Vec<String> {
    store
        .read_cycle_locks(&LockFilter::All)
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_lease_is_taken_once_until_its_ttl_passes_and_only_its_holder_renews_it() {
    let b = brain("spend-lease");
    let id = "embed-page:7";
    assert!(
        b.take_page_embedding_lease(id, &holder(), 10.0, TOKEN_A)
            .unwrap()
    );
    // A second holder waits while the first TTL runs, including at its last microsecond.
    assert!(
        !b.take_page_embedding_lease(id, &holder(), 10.0, TOKEN_B)
            .unwrap()
    );
    b.clock.advance(10 * MINUTE);
    assert!(
        !b.take_page_embedding_lease(id, &holder(), 10.0, TOKEN_B)
            .unwrap()
    );
    // Only the token on the row renews it; an upper-case token is the same uuid.
    assert!(!b.renew_page_embedding_lease(id, TOKEN_B, 10.0).unwrap());
    assert!(
        b.renew_page_embedding_lease(id, &TOKEN_A.to_uppercase(), 10.0)
            .unwrap()
    );
    b.clock.advance(10 * MINUTE + 1);
    assert!(
        b.take_page_embedding_lease(id, &holder(), 10.0, TOKEN_B)
            .unwrap()
    );
    assert!(!b.renew_page_embedding_lease(id, TOKEN_A, 10.0).unwrap());
    assert!(
        !b.renew_page_embedding_lease("embed-page:8", TOKEN_A, 10.0)
            .unwrap()
    );
    let row = &b
        .read_cycle_locks(&LockFilter::Id { lock_id: id.into() })
        .unwrap()[0];
    assert_eq!(row["holder_pid"], json!(41));
    assert_eq!(row["holder_host"], json!("host-a"));
    assert_eq!(row["acquisition_token"], json!(TOKEN_B));
}

#[test]
fn a_lease_ttl_rounds_to_whole_minutes() {
    let b = brain("spend-lease-round");
    assert!(
        b.take_page_embedding_lease("embed-page:1", &holder(), 1.4, TOKEN_A)
            .unwrap()
    );
    b.clock.advance(MINUTE + 1);
    assert!(
        b.take_page_embedding_lease("embed-page:1", &holder(), 1.0, TOKEN_B)
            .unwrap()
    );
}

#[test]
fn release_drops_the_holders_row_and_every_expired_page_lease_only() {
    let b = brain("spend-release");
    b.take_page_embedding_lease("embed-page:1", &holder(), 5.0, TOKEN_A)
        .unwrap();
    b.take_page_embedding_lease("embed-page:2", &holder(), 1.0, TOKEN_B)
        .unwrap();
    b.take_page_embedding_lease("embed-page:3", &holder(), 60.0, TOKEN_B)
        .unwrap();
    // A cycle lock that is not a page lease is left alone even when its TTL has passed.
    b.take_page_embedding_lease("gbrain-cycle", &holder(), 1.0, TOKEN_B)
        .unwrap();
    b.clock.advance(2 * MINUTE);
    // A wrong token leaves the holder's row, but still sweeps the expired page lease.
    b.release_page_embedding_lease("embed-page:1", TOKEN_B)
        .unwrap();
    assert_eq!(
        lock_ids(&b),
        vec!["embed-page:1", "embed-page:3", "gbrain-cycle"]
    );
    b.release_page_embedding_lease("embed-page:1", TOKEN_A)
        .unwrap();
    assert_eq!(lock_ids(&b), vec!["embed-page:3", "gbrain-cycle"]);
}

#[test]
fn a_lease_token_that_is_not_a_uuid_is_refused() {
    let b = brain("spend-lease-uuid");
    for err in [
        b.take_page_embedding_lease("embed-page:1", &holder(), 1.0, "nope")
            .unwrap_err(),
        b.renew_page_embedding_lease("embed-page:1", "nope", 1.0)
            .unwrap_err(),
        b.release_page_embedding_lease("embed-page:1", "nope")
            .unwrap_err(),
    ] {
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}

#[test]
fn holds_read_the_frontmatter_marker_and_the_budget_row() {
    let b = brain("spend-holds");
    let (id, _) = page(
        &b,
        "notes/call",
        json!({"call_import": {"embedding_hold": "approval"}}),
        "body",
    );
    let (archive, _) = page(
        &b,
        "notes/archive",
        json!({"transcript_archive": {"embedding_hold": 3}, "call_import": {"embedding_hold": "x"}}),
        "body",
    );
    assert_eq!(b.read_page_embedding_holds(9_999).unwrap(), None);
    assert_eq!(
        b.read_page_embedding_holds(id).unwrap(),
        Some(PageEmbeddingHolds {
            marker: Some("approval".into()),
            state: None,
            reason: None
        })
    );
    assert_eq!(
        b.read_page_embedding_holds(archive)
            .unwrap()
            .unwrap()
            .marker,
        Some("3".into())
    );
    b.write_page_embedding_hold(id, "call_import", "if_absent")
        .unwrap();
    // `if_absent` leaves a row that exists; `replace` sets the hold over it.
    b.write_page_embedding_hold(id, "other", "if_absent")
        .unwrap();
    let held = b.read_page_embedding_holds(id).unwrap().unwrap();
    assert_eq!(
        (held.state.as_deref(), held.reason.as_deref()),
        (Some("held"), Some("call_import"))
    );
    b.write_page_embedding_hold(id, "archive_backfill", "replace")
        .unwrap();
    assert_eq!(
        b.read_page_embedding_holds(id).unwrap().unwrap().reason,
        Some("archive_backfill".into())
    );
    b.open_page_embedding_hold(id).unwrap();
    let open = b.read_page_embedding_holds(id).unwrap().unwrap();
    assert_eq!((open.state.as_deref(), open.reason), (Some("open"), None));
    // Opening a page with no row writes none; a hold on a missing page breaks the foreign key.
    b.open_page_embedding_hold(archive).unwrap();
    assert_eq!(
        b.read_page_embedding_holds(archive).unwrap().unwrap().state,
        None
    );
    let err = b
        .write_page_embedding_hold(9_999, "call_import", "replace")
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert_eq!(
        b.write_page_embedding_hold(id, "x", "upsert")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_reservation_opens_a_window_that_a_settle_books_inside_only() {
    let b = brain("spend-window");
    let (id, _) = page(&b, "notes/a", json!({}), "body");
    let ledger = budget(id);
    let row = b.lock_page_spend_ledger(&ledger).unwrap().unwrap();
    assert_eq!(row.state.as_deref(), Some("open"));
    assert_eq!(
        (row.spent_usd, row.reserved_usd, row.cap_usd),
        (0.0, 0.0, None)
    );
    assert!(!row.stale_reservation);
    let window = b
        .write_page_spend_reservation(
            &ledger,
            &write(
                json!({"spent": 0.0, "reserved": 0.5, "keepWindow": false, "signature": "sig-1",
                "plan": {"state": "open", "reason": null, "capUsd": 2.0}}),
            ),
        )
        .unwrap()
        .unwrap();
    assert_eq!(window, T0_TEXT);
    // A second grant keeps the open window.
    b.clock.advance(5);
    let kept = b
        .write_page_spend_reservation(
            &ledger,
            &write(json!({"spent": 0.0, "reserved": 0.75, "keepWindow": true, "signature": null})),
        )
        .unwrap();
    assert_eq!(kept.as_deref(), Some(T0_TEXT));
    let row = b.lock_page_spend_ledger(&ledger).unwrap().unwrap();
    assert_eq!(row.embedding_signature.as_deref(), Some("sig-1"));
    assert_eq!((row.reserved_usd, row.cap_usd), (0.75, Some(2.0)));
    // A settle in another window books nothing.
    b.settle_page_spend_reservation(
        &ledger,
        &settle(json!({"window": "1", "reservedUsd": 0.5, "bookedUsd": 0.4, "unpriced": 0})),
    )
    .unwrap();
    assert_eq!(
        b.lock_page_spend_ledger(&ledger)
            .unwrap()
            .unwrap()
            .spent_usd,
        0.0
    );
    b.settle_page_spend_reservation(
        &ledger,
        &settle(json!({"window": T0_TEXT, "reservedUsd": 0.5, "bookedUsd": 0.4, "unpriced": 1})),
    )
    .unwrap();
    let row = b.lock_page_spend_ledger(&ledger).unwrap().unwrap();
    assert_eq!((row.spent_usd, row.reserved_usd), (0.4, 0.25));
    // The last grant's settle drops the hold and closes the window, so a late settle books nothing.
    b.settle_page_spend_reservation(
        &ledger,
        &settle(json!({"window": T0_TEXT, "reservedUsd": 0.25, "bookedUsd": 0.1, "unpriced": 0})),
    )
    .unwrap();
    b.settle_page_spend_reservation(
        &ledger,
        &settle(json!({"window": T0_TEXT, "reservedUsd": 0.25, "bookedUsd": 0.1, "unpriced": 0})),
    )
    .unwrap();
    let row = b.lock_page_spend_ledger(&ledger).unwrap().unwrap();
    assert_eq!(row.reserved_usd, 0.0);
    assert!((row.spent_usd - 0.5).abs() < 1e-12);
}

const T0_TEXT: &str = "1800000000000000";

#[test]
fn a_new_window_is_later_than_the_one_it_replaces_and_none_is_left_when_nothing_is_reserved() {
    let b = brain("spend-new-window");
    let (id, _) = page(&b, "notes/a", json!({}), "body");
    let ledger = derivation(id, "facts");
    b.lock_page_spend_ledger(&ledger).unwrap();
    let first = b
        .write_page_spend_reservation(
            &ledger,
            &write(json!({"spent": 0.0, "reserved": 0.2, "keepWindow": false})),
        )
        .unwrap();
    assert_eq!(first.as_deref(), Some(T0_TEXT));
    // On the same clock tick a fresh window still moves one millisecond past the last.
    let second = b
        .write_page_spend_reservation(
            &ledger,
            &write(json!({"spent": 0.1, "reserved": 0.2, "keepWindow": false})),
        )
        .unwrap();
    assert_eq!(second.as_deref(), Some("1800000000001000"));
    let none = b
        .write_page_spend_reservation(
            &ledger,
            &write(json!({"spent": 0.1, "reserved": 0.0, "keepWindow": true})),
        )
        .unwrap();
    assert_eq!(none, None);
    // A derivation row reads null for the budget-only columns, even when a plan is written.
    b.write_page_spend_reservation(
        &ledger,
        &write(
            json!({"spent": 0.1, "reserved": 0.0, "keepWindow": false, "signature": "s",
            "plan": {"state": "held", "reason": "r", "capUsd": 1.0}}),
        ),
    )
    .unwrap();
    let row = b.lock_page_spend_ledger(&ledger).unwrap().unwrap();
    assert_eq!(
        (row.state, row.reason, row.embedding_signature, row.cap_usd),
        (None, None, None, None)
    );
    // The two families keep separate rows.
    assert_eq!(
        b.lock_page_spend_ledger(&derivation(id, "synopsis"))
            .unwrap()
            .unwrap()
            .spent_usd,
        0.0
    );
}

#[test]
fn a_reservation_held_for_an_hour_reads_stale() {
    let b = brain("spend-stale");
    let (id, _) = page(&b, "notes/a", json!({}), "body");
    let ledger = budget(id);
    b.lock_page_spend_ledger(&ledger).unwrap();
    b.write_page_spend_reservation(
        &ledger,
        &write(json!({"spent": 0.0, "reserved": 0.2, "keepWindow": false})),
    )
    .unwrap();
    b.clock.advance(60 * MINUTE);
    assert!(
        !b.lock_page_spend_ledger(&ledger)
            .unwrap()
            .unwrap()
            .stale_reservation
    );
    b.clock.advance(1);
    assert!(
        b.lock_page_spend_ledger(&ledger)
            .unwrap()
            .unwrap()
            .stale_reservation
    );
}

#[test]
fn ledger_checks_match_the_table_constraints() {
    let b = brain("spend-checks");
    let (id, _) = page(&b, "notes/a", json!({}), "body");
    let codes = [
        b.lock_page_spend_ledger(&budget(9_999)).unwrap_err().code,
        b.lock_page_spend_ledger(&derivation(id, "takes"))
            .unwrap_err()
            .code,
    ];
    assert_eq!(codes, [CONSTRAINT_VIOLATION, CONSTRAINT_VIOLATION]);
    b.lock_page_spend_ledger(&budget(id)).unwrap();
    let negative = b
        .write_page_spend_reservation(
            &budget(id),
            &write(json!({"spent": -1.0, "reserved": 0.0, "keepWindow": false})),
        )
        .unwrap_err();
    assert_eq!(negative.code, CONSTRAINT_VIOLATION);
    let state = b
        .write_page_spend_reservation(
            &budget(id),
            &write(json!({"spent": 0.0, "reserved": 0.0, "keepWindow": false,
                "plan": {"state": "paused", "reason": null, "capUsd": null}})),
        )
        .unwrap_err();
    assert_eq!(state.code, CONSTRAINT_VIOLATION);
    // A reservation on a row that is not there writes nothing.
    assert_eq!(
        b.write_page_spend_reservation(
            &derivation(id, "facts"),
            &write(json!({"spent": 0.0, "reserved": 1.0, "keepWindow": false})),
        )
        .unwrap(),
        None
    );
    assert_eq!(
        b.list_vectorless_chunk_indexes(id).unwrap(),
        Vec::<i64>::new()
    );
}

#[test]
fn vectorless_chunk_indexes_and_the_budget_limited_list_read_the_visible_chunks() {
    let b = brain("spend-limited");
    let (id, rev) = page(&b, "notes/call", json!({}), "body");
    seal(
        &b,
        "notes/call",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "héllo", "model": "m1"},
            {"chunk_index": 1, "chunk_text": "has vector", "model": "m1", "embedding": vec![0.5; 1536]},
            {"chunk_index": 2, "chunk_text": "abc", "model": "m1"},
        ]),
    );
    assert_eq!(b.list_vectorless_chunk_indexes(id).unwrap(), vec![0, 2]);
    assert_eq!(
        b.list_vectorless_chunk_indexes(9_999).unwrap(),
        Vec::<i64>::new()
    );
    let (small, _) = page(&b, "notes/small", json!({}), "body");
    let (skipped, _) = page(&b, "notes/skip", json!({"embed_skip": true}), "body");
    b.write_page_embedding_hold(id, "call_import", "replace")
        .unwrap();
    b.clock.advance(1);
    // A small page held for a reason that only applies to large pages is not listed.
    b.write_page_embedding_hold(small, "page_over_cap", "replace")
        .unwrap();
    b.write_page_embedding_hold(skipped, "call_import", "replace")
        .unwrap();
    let all = b
        .list_budget_limited_page_rows(&BudgetLimitedPagesOpts::default())
        .unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].slug, "notes/call");
    assert_eq!(all[0].state, "held");
    assert_eq!((all[0].pending_chunks, all[0].pending_chars), (2, 8));
    let capped: BudgetLimitedPagesOpts =
        de(json!({"state": "capped", "sourceId": null, "limit": 10}));
    assert!(b.list_budget_limited_page_rows(&capped).unwrap().is_empty());
    let other: BudgetLimitedPagesOpts = de(json!({"sourceId": "other", "limit": null}));
    assert!(b.list_budget_limited_page_rows(&other).unwrap().is_empty());
    let none: BudgetLimitedPagesOpts = de(json!({"limit": 0}));
    assert!(b.list_budget_limited_page_rows(&none).unwrap().is_empty());
}

#[test]
fn size_state_rows_list_the_pages_a_state_may_apply_to_by_slug() {
    let b = brain("spend-size");
    page(&b, "notes/z-plain", json!({}), "body");
    page(&b, "notes/b-skip", json!({"embed_skip": "manual"}), "body");
    page(&b, "notes/c-large", json!({}), &"x".repeat(1024 * 1024 + 1));
    let (held, _) = page(&b, "notes/a-held", json!({}), "body");
    b.write_page_embedding_hold(held, "call_import", "replace")
        .unwrap();
    let rows = b.read_page_size_state_rows("default", None).unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, vec!["notes/a-held", "notes/b-skip", "notes/c-large"]);
    assert_eq!(rows[0].state.as_deref(), Some("held"));
    assert_eq!(rows[2].bytes, 1024 * 1024 + 1);
    assert!(!rows[2].segmented);
    let wanted = vec!["notes/b-skip".to_string(), "notes/z-plain".to_string()];
    let some = b
        .read_page_size_state_rows("default", Some(&wanted))
        .unwrap();
    assert_eq!(some.len(), 1);
    assert_eq!(some[0].frontmatter["embed_skip"], json!("manual"));
    assert!(
        b.read_page_size_state_rows("other", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn deleting_a_page_drops_its_ledgers() {
    let b = brain("spend-cascade");
    let (id, _) = page(&b, "notes/a", json!({}), "body");
    b.write_page_embedding_hold(id, "call_import", "replace")
        .unwrap();
    b.lock_page_spend_ledger(&derivation(id, "facts")).unwrap();
    b.delete_page("notes/a", None).unwrap();
    // The page id is not reused, so a re-created page starts with no ledger rows.
    let (again, _) = page(&b, "notes/a", json!({}), "body");
    assert_ne!(again, id);
    assert!(b.lock_page_spend_ledger(&derivation(id, "facts")).is_err());
    assert_eq!(
        b.read_page_embedding_holds(again).unwrap().unwrap().state,
        None
    );
    assert!(
        b.list_budget_limited_page_rows(&BudgetLimitedPagesOpts::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_held_page_leaves_the_stale_queue_and_counts_as_held_while_its_hold_applies() {
    use gbrain_store::embeddings::{ListStaleChunksOptions, StaleChunkOptions};
    use gbrain_store::link_queries::PendingCountInput;
    let b = brain("spend-held-queue");
    let (held, rev) = page(&b, "notes/held", json!({}), "body");
    seal(
        &b,
        "notes/held",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "held", "model": "m1"}]),
    );
    let (free, rev) = page(&b, "notes/free", json!({}), "body");
    seal(
        &b,
        "notes/free",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "free text", "model": "m1"}]),
    );
    let queue = |b: &Store| {
        let rows = b
            .list_stale_chunks(&ListStaleChunksOptions::default())
            .unwrap();
        (
            b.count_stale_chunks(&StaleChunkOptions::default()).unwrap(),
            b.sum_stale_chunk_chars(&StaleChunkOptions::default())
                .unwrap(),
            rows.iter()
                .map(|r| r["page_id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
        )
    };
    let input: PendingCountInput =
        de(json!({"scope": {}, "relevance": {"all": true, "exactTopPageId": held}}));
    let held_count =
        |b: &Store| serde_json::to_value(b.count_embedding_held_pages(&input).unwrap()).unwrap();
    assert_eq!(queue(&b), (2, 13, vec![held, free]));
    assert_eq!(
        held_count(&b),
        json!({"total": 0, "could_affect": 0, "capped": false, "top_counted": false})
    );
    // A reason that holds a page of any size applies to this small page.
    b.write_page_embedding_hold(held, "archive_backfill", "replace")
        .unwrap();
    assert_eq!(queue(&b), (1, 9, vec![free]));
    assert_eq!(
        held_count(&b),
        json!({"total": 1, "could_affect": 1, "capped": false, "top_counted": true})
    );
    // A size hold on a small page does not apply.
    b.write_page_embedding_hold(held, "page_over_cap", "replace")
        .unwrap();
    assert_eq!(queue(&b), (2, 13, vec![held, free]));
    assert_eq!(held_count(&b)["total"], json!(0));
    b.write_page_embedding_hold(held, "call_import", "replace")
        .unwrap();
    b.open_page_embedding_hold(held).unwrap();
    assert_eq!(queue(&b), (2, 13, vec![held, free]));
}
