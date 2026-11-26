//! Read-back tests of the seeded chronicle ledger: a row keeps every column and its times, a retry skips, and a row
//! whose source or page was not seeded refuses with the codes `upsertChronicleRow` uses, writing nothing.

use crate::Store;
use crate::chronicle_state::{ChronicleLedgerRow, ChronicleRowKey};
use crate::env::iso;
use crate::error::{PAGE_NOT_FOUND, SOURCE_NOT_FOUND};
use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;

const SEED: &str = "seed-1";
const REV: &str = "0b9d2f1e-5c4a-4e8f-9a7b-3c2d1e0f9a8b";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> crate::error::Result<ImportResult> {
    s.import_relation(SEED, relation, rows)
}

fn us(text: &str) -> i64 {
    crate::seed::decode::timestamp_us(text).unwrap()
}

/// The `default` source (a new store has it) and page 7.
fn seed_page(s: &Store) {
    let page = row(&[
        ("id", "7"),
        ("source_id", "default"),
        ("slug", "meetings/launch-example"),
        ("type", "meeting"),
        ("page_kind", "markdown"),
        ("title", "Launch review"),
        ("compiled_truth", "Alice and Bob reviewed the launch."),
        ("timeline", ""),
        ("frontmatter", "{}"),
        ("content_hash", "hash-7"),
        ("created_at", "2026-01-02 03:04:05+00"),
        ("updated_at", "2026-01-02 03:04:05+00"),
        ("knowledge_revision", REV),
        ("text_projection_revision", REV),
        ("chunker_version", "3"),
        ("trust_tier", "unknown"),
        ("generation", "1"),
    ]);
    import(s, "pages", vec![page]).unwrap();
}

/// A row with every column set, as the primary's digest session prints it.
fn full_row(source: &str, page: &str) -> SeedRow {
    row(&[
        ("source_id", source),
        ("page_id", page),
        ("content_hash", "hash-7"),
        ("extractor_version", "2"),
        ("slug", "meetings/launch-example"),
        ("state", "failed"),
        ("reason", "judge_error"),
        ("trigger", "backfill"),
        ("principal_kind", "local_cli"),
        ("principal_id", "writer-1"),
        ("request_id", "6f9619ff-8b86-4d01-b42d-00cf4fc964ff"),
        ("no_extract", "t"),
        ("attempts", "2"),
        ("next_attempt_at", "2026-11-20 12:00:00.123+00"),
        ("cost_usd", "0.0375"),
        ("unpriced", "t"),
        ("event_slugs", "{events/a-example,events/b-example}"),
        ("event_hashes", "{h1,h2}"),
        ("decided_at", "2026-11-19 08:00:00.123456+00"),
        ("updated_at", "2026-11-19 09:30:00.654321+00"),
        ("campaign_id", "campaign-a"),
        ("attempt_cap_usd", "0.50"),
        ("max_attempts", "3"),
        ("pricing_policy", "priced"),
        ("campaign_max_usd", "12.00"),
        ("cost_attempts", "{1,2}"),
        ("judge_input_hash", "jh-1"),
        ("judge_window_chars", "4000"),
        ("judge_window_hash", "jw-1"),
        ("judge_input_failures", "1"),
    ])
}

fn key(source: &str, page: i64) -> ChronicleRowKey {
    ChronicleRowKey {
        source_id: source.into(),
        page_id: page,
        content_hash: "hash-7".into(),
        extractor_version: 2,
    }
}

#[test]
fn a_seeded_row_keeps_every_column_and_its_original_times() {
    let s = store();
    seed_page(&s);
    let r = import(&s, "chronicle_page_state", vec![full_row("default", "7")]).unwrap();
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let stored = s.read_chronicle_row(&key("default", 7)).unwrap().unwrap();
    assert_eq!(
        stored,
        ChronicleLedgerRow {
            source_id: "default".into(),
            page_id: 7,
            content_hash: "hash-7".into(),
            extractor_version: 2,
            slug: "meetings/launch-example".into(),
            state: "failed".into(),
            reason: Some("judge_error".into()),
            trigger: "backfill".into(),
            principal_kind: Some("local_cli".into()),
            principal_id: Some("writer-1".into()),
            request_id: Some("6f9619ff-8b86-4d01-b42d-00cf4fc964ff".into()),
            no_extract: true,
            attempts: 2,
            next_attempt_at: Some(iso(us("2026-11-20 12:00:00.123+00"))),
            cost_usd: Some(0.0375),
            unpriced: true,
            event_slugs: vec!["events/a-example".into(), "events/b-example".into()],
            event_hashes: vec!["h1".into(), "h2".into()],
            decided_at: iso(us("2026-11-19 08:00:00.123456+00")),
            updated_at: iso(us("2026-11-19 09:30:00.654321+00")),
            campaign_id: Some("campaign-a".into()),
            attempt_cap_usd: Some("0.50".into()),
            max_attempts: Some(3),
            pricing_policy: Some("priced".into()),
            campaign_max_usd: Some("12.00".into()),
            cost_attempts: vec![1, 2],
            judge_input_hash: Some("jh-1".into()),
            judge_window_chars: Some(4000),
            judge_window_hash: Some("jw-1".into()),
            judge_input_failures: 1,
        }
    );
    // A retry of the same row stores nothing.
    let again = import(&s, "chronicle_page_state", vec![full_row("default", "7")]).unwrap();
    assert_eq!((again.imported, again.skipped), (0, 1));
}

#[test]
fn a_row_whose_source_or_page_is_not_seeded_refuses_and_writes_nothing() {
    let s = store();
    seed_page(&s);
    let no_source = import(&s, "chronicle_page_state", vec![full_row("missing", "7")]).unwrap_err();
    assert_eq!(no_source.code, SOURCE_NOT_FOUND);
    let no_page = import(&s, "chronicle_page_state", vec![full_row("default", "99")]).unwrap_err();
    assert_eq!(no_page.code, PAGE_NOT_FOUND);
    // The source is checked before the page.
    let neither = import(&s, "chronicle_page_state", vec![full_row("missing", "99")]).unwrap_err();
    assert_eq!(neither.code, SOURCE_NOT_FOUND);
    assert!(s.read_chronicle_row(&key("missing", 7)).unwrap().is_none());
    assert!(s.read_chronicle_row(&key("default", 99)).unwrap().is_none());
}

#[test]
fn the_runtime_upsert_refuses_with_the_same_codes() {
    let s = store();
    seed_page(&s);
    let upsert = |source: &str, page: i64| {
        let w: crate::chronicle_ledger::ChronicleRowInput =
            serde_json::from_value(serde_json::json!({
                "sourceId": source, "pageId": page, "contentHash": "hash-7", "extractorVersion": 2,
                "slug": "meetings/launch-example", "state": "pending", "trigger": "backfill",
            }))
            .unwrap();
        s.upsert_chronicle_row(&w)
    };
    assert_eq!(upsert("missing", 7).unwrap_err().code, SOURCE_NOT_FOUND);
    assert_eq!(upsert("default", 99).unwrap_err().code, PAGE_NOT_FOUND);
    assert!(upsert("default", 7).unwrap());
}
