//! Read-back tests of the privacy relations: each imports rows and reads them back through the
//! family's own reads, then retries the batch.

use super::super::decode::timestamp_us;
use super::super::{ImportResult, SeedRow};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, SOURCE_NOT_FOUND};
use crate::facts::InsertFactsArgs;
use crate::facts::repair::PurgedCountArgs;
use crate::trust::withdrawals::WithdrawalClaim;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SEED: &str = "seed-1";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn us(text: &str) -> i64 {
    timestamp_us(text).unwrap()
}

#[test]
fn owner_only_marks_keep_page_marks_and_drop_the_other_tables() {
    let s = crate::test_support::store();
    let rows = || {
        vec![
            row(&[
                ("row_table", "pages"),
                ("row_id", "7"),
                ("marked_at", "2026-03-01 00:00:00+00"),
            ]),
            row(&[("row_table", "pages"), ("row_id", "9")]),
            row(&[("row_table", "facts"), ("row_id", "3")]),
        ]
    };
    let r = import(&s, "owner_only_marks", rows());
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 1));
    assert_eq!(r.unmapped_columns, ["marked_at"]);
    assert_eq!(r.losses["owner_only_mark_not_a_page"], 1);
    {
        let read = s.read().unwrap();
        assert!(crate::owner_only_marks::any_marked(&*read).unwrap());
        assert!(crate::owner_only_marks::is_marked(&*read, 7).unwrap());
        assert!(crate::owner_only_marks::is_marked(&*read, 9).unwrap());
        assert!(!crate::owner_only_marks::is_marked(&*read, 3).unwrap());
    }
    let again = import(&s, "owner_only_marks", rows());
    assert_eq!((again.imported, again.skipped, again.dropped), (0, 2, 1));
}

#[test]
fn a_mark_whose_page_is_gone_reserves_its_page_id() {
    // A mark outlives a hard-deleted page, so it can name an id above every surviving page; the next page written must not take it
    // (it would inherit the deleted page's owner-only mark and be hidden from non-owner reads).
    let s = crate::test_support::store();
    import(
        &s,
        "owner_only_marks",
        vec![
            row(&[("row_table", "pages"), ("row_id", "7")]),
            row(&[("row_table", "facts"), ("row_id", "40")]),
        ],
    );
    let next = s
        .write(|tx| crate::pages::next_id(tx, crate::pages::NEXT_PAGE_ID))
        .unwrap();
    assert_eq!(next, 8);
    let read = s.read().unwrap();
    assert!(!crate::owner_only_marks::is_marked(&*read, next).unwrap());
}

#[test]
fn an_owner_only_mark_needs_a_page_id() {
    let s = crate::test_support::store();
    let err = s
        .import_relation(
            SEED,
            "owner_only_marks",
            vec![row(&[("row_table", "pages"), ("row_id", "seven")])],
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(err.message.contains("owner_only_marks.row_id"));
}

#[test]
fn slug_rename_history_keeps_every_old_to_new_pair() {
    let s = crate::test_support::store();
    let rows = || {
        vec![
            row(&[
                ("source_id", "default"),
                ("old_slug", "people/al"),
                ("new_slug", "people/alice"),
                ("created_at", "2026-03-01 00:00:00+00"),
            ]),
            row(&[
                ("source_id", "default"),
                ("old_slug", "people/al"),
                ("new_slug", "people/alicia"),
            ]),
        ]
    };
    let r = import(&s, "slug_rename_history", rows());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert_eq!(r.unmapped_columns, ["created_at"]);
    {
        let read = s.read().unwrap();
        assert_eq!(
            crate::aliases::renamed_to(&*read, "default", "people/al").unwrap(),
            ["people/alice", "people/alicia"]
        );
        assert!(
            crate::aliases::renamed_to(&*read, "default", "people/alice")
                .unwrap()
                .is_empty()
        );
    }
    let again = import(&s, "slug_rename_history", rows());
    assert_eq!((again.imported, again.skipped), (0, 2));
}

#[test]
fn a_rename_of_a_missing_source_is_refused() {
    let s = crate::test_support::store();
    let err = s
        .import_relation(
            SEED,
            "slug_rename_history",
            vec![row(&[
                ("source_id", "nowhere"),
                ("old_slug", "a"),
                ("new_slug", "b"),
            ])],
        )
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn fact_withdrawals_keep_the_primary_hash_and_time() {
    let s = crate::test_support::store();
    // A hash that is not the fingerprint of any claim: it is stored as given, not re-fingerprinted.
    let rows = || {
        vec![
            row(&[
                ("source_id", "default"),
                ("visibility", "private"),
                ("subject", "*"),
                ("fact_hash", &sha256_hex("owes acme money")),
                ("withdrawn_at", "2026-03-04 05:06:07.123456+00"),
            ]),
            row(&[
                ("source_id", "default"),
                ("visibility", "world"),
                ("subject", "people/alice"),
                ("fact_hash", "legacy-hash"),
                ("withdrawn_at", "2026-04-05 00:00:00+00"),
            ]),
        ]
    };
    let r = import(&s, "fact_withdrawals", rows());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.unmapped_columns.is_empty());
    let claim = |text: &str, visibility: &str| WithdrawalClaim {
        row_num: 1,
        claim: text.into(),
        visibility: visibility.into(),
    };
    let dates = s
        .list_fact_withdrawal_dates("default", &[claim("Owes  ACME money", "private")], None)
        .unwrap();
    assert_eq!(dates.len(), 1);
    assert_eq!(
        timestamp_us(&dates[0].withdrawn_at),
        Some(us("2026-03-04 05:06:07.123456+00"))
    );
    assert!(
        s.list_fact_withdrawal_dates("default", &[claim("owes acme money", "world")], None)
            .unwrap()
            .is_empty()
    );
    assert!(
        s.has_covering_fact_withdrawal(
            "default",
            "private",
            "unused",
            "owes acme money",
            "people/bob"
        )
        .unwrap()
    );
    assert!(
        s.has_covering_fact_withdrawal("default", "world", "legacy-hash", "x", "people/alice")
            .unwrap()
    );
    assert!(
        !s.has_covering_fact_withdrawal("default", "world", "legacy-hash", "x", "people/bob")
            .unwrap()
    );
    let again = import(&s, "fact_withdrawals", rows());
    assert_eq!((again.imported, again.skipped), (0, 2));
}

#[test]
fn a_withdrawal_needs_a_source_and_a_visibility() {
    let s = crate::test_support::store();
    let base = [
        ("source_id", "default"),
        ("visibility", "private"),
        ("subject", "*"),
        ("fact_hash", "h"),
        ("withdrawn_at", "2026-03-04 05:06:07+00"),
    ];
    let with = |col: &str, value: &str| {
        let mut r = row(&base);
        r.insert(col.to_owned(), Some(value.to_owned()));
        r
    };
    let err = s
        .import_relation(SEED, "fact_withdrawals", vec![with("source_id", "nowhere")])
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
    let err = s
        .import_relation(SEED, "fact_withdrawals", vec![with("visibility", "secret")])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn page_purges_keep_the_tombstone_the_purge_count_reads() {
    let s = crate::test_support::store();
    let facts: Vec<Value> = ["early", "purged", "notes/gone"]
        .iter()
        .map(|c| {
            json!({ "fact": format!("claim {c}"), "visibility": "private", "source": "mcp:put_page",
                "valid_from": "2026-01-01T00:00:00.000Z", "context": format!("{c} \u{2014} x") })
        })
        .collect();
    let insert: InsertFactsArgs =
        serde_json::from_value(json!({ "rows": facts, "sourceId": "default" })).unwrap();
    // The facts go in after the seed: a store that holds them is not fresh.
    let rows = || {
        vec![
            row(&[
                ("source_id", "default"),
                ("content_hash", "h1"),
                ("slug", "early"),
                ("request_id", "0a1b2c3d-0000-4000-8000-00000000000a"),
                ("purged_at", "1970-01-01 00:00:00+00"),
            ]),
            row(&[
                ("source_id", "default"),
                ("content_hash", "h2"),
                ("slug", "purged"),
                ("purged_at", "2999-01-01 00:00:00+00"),
            ]),
        ]
    };
    let r = import(&s, "page_purges", rows());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.unmapped_columns.is_empty());
    s.insert_facts(&insert).unwrap();
    // `early` was purged before its fact and has no `/`; `purged` is evidenced; `notes/gone` has no tombstone.
    let count = s
        .count_purged_page_facts(&PurgedCountArgs {
            source_ids: vec!["default".into()],
            limit: 10,
        })
        .unwrap();
    assert_eq!(count, vec![true, false]);
    let read = s.read().unwrap();
    let mut key = crate::keys::text(crate::keys::FACT, &["default", "h1"]);
    key.insert(1, 0x0C);
    let stored: Value = crate::get_json(&*read, &key).unwrap().unwrap();
    assert_eq!(
        stored,
        json!({ "slug": "early", "request_id": "0a1b2c3d-0000-4000-8000-00000000000a", "purged_at_us": 0 })
    );
    drop(read);
    let again = import(&s, "page_purges", rows());
    assert_eq!((again.imported, again.skipped), (0, 2));
}

#[test]
fn oauth_clients_keep_the_spend_columns_and_report_the_rest() {
    let s = crate::test_support::store();
    let rows = || {
        vec![
            row(&[
                ("client_id", "c-agent"),
                ("client_name", "Agent One"),
                ("scope", "read agent"),
                ("budget_usd_per_day", "5.00"),
                ("client_secret_hash", "abc"),
                ("redirect_uris", "{https://example.test/cb}"),
                ("grant_types", "{client_credentials}"),
                ("federated_read", "{}"),
                ("bound_max_concurrent", "1"),
                ("grant_revision", "0"),
                ("private_pages", "none"),
                ("created_at", "2026-01-02 03:04:05+00"),
            ]),
            row(&[
                ("client_id", "c-bound"),
                ("client_name", "Bound"),
                ("bound_tools", "{search,\"get page\"}"),
            ]),
            row(&[
                ("client_id", "c-gone"),
                ("client_name", "Gone"),
                ("scope", "agent"),
                ("deleted_at", "2026-02-03 04:05:06+00"),
            ]),
            row(&[("client_id", "c-plain"), ("client_name", "Plain")]),
        ]
    };
    let r = import(&s, "oauth_clients", rows());
    assert_eq!((r.imported, r.skipped), (4, 0));
    assert_eq!(
        r.unmapped_columns,
        ["client_secret_hash", "created_at", "redirect_uris"]
    );
    assert_eq!(
        s.read_client_budget_usd("c-agent").unwrap().as_deref(),
        Some("5.00")
    );
    assert_eq!(s.read_client_budget_usd("c-plain").unwrap(), None);
    // The admin spend view lists live clients that hold the agent scope or are bound to tools.
    let listed = s.read_agent_client_spend().unwrap();
    let ids: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["client_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["c-agent", "c-bound"]);
    assert_eq!(listed[0]["client_name"], "Agent One");
    assert_eq!(listed[0]["cap_usd_per_day"], 5.0);
    assert_eq!(listed[1]["cap_usd_per_day"], Value::Null);
    let again = import(&s, "oauth_clients", rows());
    assert_eq!((again.imported, again.skipped), (0, 4));
}
