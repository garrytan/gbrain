//! The CLI search and graph reads (cli_reads/reads.rs) and the remote-caller reads around them
//! (cli_reads/remote_reads.rs): what each answers from the store's records.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::cli_reads::reads::{
    EntityTypeFilter, ExactBatchInput, ExactIdentityInput, ExactIdentityProbes,
    ExtractionPendingInput, RankEntitiesInput, RemoteCaller,
};
use gbrain_store::cli_reads::remote_reads::{
    ExactRescanInput, ExactSnippetChunksInput, ExactSnippetKey, RankCoverageInput, RankCoverageRow,
};
use gbrain_store::extraction::ExtractedRef;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    let input = PageInput {
        page_type: page_type.into(),
        title: slug.to_uppercase(),
        compiled_truth: format!("body of {slug}"),
        frontmatter: frontmatter.as_object().cloned(),
        ..PageInput::default()
    };
    let options = PutPageOptions {
        source_id: Some(source_id.into()),
        ..PutPageOptions::default()
    };
    let row = store.put_page(slug, &input, &options).unwrap();
    row["id"].as_u64().unwrap()
}

#[test]
fn next_live_page_skips_deleted_pages_and_reads_archived_sources() {
    let dir = TempDir::new("cli-reads-ops-next");
    let store = open(&dir);
    source(&store, "old");
    let a = page(&store, "default", "notes/a", "note", json!({}));
    page(&store, "default", "notes/gone", "note", json!({}));
    let c = page(&store, "old", "notes/c", "note", json!({}));
    store.set_source_archived("old", true).unwrap();
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    assert_eq!(
        store.next_live_page_after(a as i64).unwrap().map(|p| p.id),
        Some(c)
    );
    assert_eq!(
        store.next_live_page_after(-5).unwrap().map(|p| p.id),
        Some(a)
    );
    assert!(store.next_live_page_after(c as i64).unwrap().is_none());
    assert!(store.next_live_page_after(i64::MAX).unwrap().is_none());
}

#[test]
fn exact_batch_needs_a_word_and_a_non_negative_limit() {
    let dir = TempDir::new("cli-reads-ops-scan");
    let store = open(&dir);
    page(&store, "default", "notes/a", "note", json!({}));
    assert!(
        store
            .scan_exact_batch(&ExactBatchInput::default())
            .unwrap()
            .is_none()
    );
    let input = ExactBatchInput {
        words: vec!["body".into()],
        longest: "body".into(),
        batch_pages: -1,
        ..ExactBatchInput::default()
    };
    assert!(store.scan_exact_batch(&input).is_err());
    let input = ExactBatchInput {
        batch_pages: 10,
        ..input
    };
    let rows = store.scan_exact_batch(&input).unwrap().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].gap, rows[0].matching_chunks), (None, Some(1)));
}

#[test]
fn identity_and_rank_refuse_exclude_private_without_a_page_policy() {
    let dir = TempDir::new("cli-reads-ops-private");
    let store = open(&dir);
    // excludePrivate with no page policy is refused: the store never guesses the caller.
    let remote = Some(RemoteCaller {
        exclude_private: true,
        policy: None,
    });
    let identity = ExactIdentityInput {
        probes: ExactIdentityProbes::default(),
        source_ids: vec!["default".into()],
        types: EntityTypeFilter::default(),
        remote: remote.clone(),
        emails_only: false,
        limit: 10,
    };
    assert!(store.list_exact_identity_candidates(&identity).is_err());
    let rank = RankEntitiesInput {
        direction: "in".into(),
        limit: 10,
        remote,
        ..RankEntitiesInput::default()
    };
    assert!(store.rank_entities(&rank).is_err());
    let sideways = RankEntitiesInput {
        direction: "sideways".into(),
        limit: 10,
        ..RankEntitiesInput::default()
    };
    assert!(store.rank_entities(&sideways).is_err());
}

#[test]
fn extraction_queue_reads_unverified_auto_extracted_pages_as_text() {
    let dir = TempDir::new("cli-reads-ops-pending");
    let store = open(&dir);
    let pending = json!({ "provenance": "auto-extracted", "status": "unverified", "source": 5 });
    page(&store, "default", "people/a", "person", pending.clone());
    page(
        &store,
        "default",
        "people/b",
        "person",
        json!({ "provenance": "auto-extracted", "status": "verified" }),
    );
    let input = ExtractionPendingInput {
        limit: 10,
        ..ExtractionPendingInput::default()
    };
    let rows = store.list_extraction_pending_pages(&input).unwrap();
    let got: Vec<(&str, Option<&str>)> = rows
        .iter()
        .map(|r| (r.slug.as_str(), r.extracted_from.as_deref()))
        .collect();
    assert_eq!(got, [("people/a", Some("5"))]);
    assert!(rows[0].created_at.ends_with("+00"));
    let negative = ExtractionPendingInput {
        offset: -1,
        ..input
    };
    assert!(store.list_extraction_pending_pages(&negative).is_err());
}

#[test]
fn identity_finds_a_live_page_by_its_alias_rows_in_the_named_sources_and_refuses_nul() {
    let dir = TempDir::new("cli-reads-ops-alias");
    let store = open(&dir);
    source(&store, "other");
    page(
        &store,
        "default",
        "people/alice-example",
        "person",
        json!({}),
    );
    page(
        &store,
        "default",
        "people/gone-example",
        "person",
        json!({}),
    );
    page(&store, "default", "notes/alice-note", "note", json!({}));
    page(&store, "other", "people/other-alice", "person", json!({}));
    let alias = |slug: &str, source: &str, names: &[&str]| {
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        store.set_page_aliases(slug, source, &names).unwrap();
    };
    alias("people/alice-example", "default", &["alice", "ae"]);
    alias("people/gone-example", "default", &["alice"]);
    alias("notes/alice-note", "default", &["alice"]);
    alias("people/other-alice", "other", &["alice"]);
    alias("people/nobody-example", "default", &["alice"]);
    store
        .soft_delete_page("people/gone-example", Some("default"))
        .unwrap();
    let read = |keys: &[&str], sources: &[&str]| {
        store.list_exact_identity_candidates(&ExactIdentityInput {
            probes: ExactIdentityProbes {
                alias_keys: keys.iter().map(|k| k.to_string()).collect(),
                ..ExactIdentityProbes::default()
            },
            source_ids: sources.iter().map(|s| s.to_string()).collect(),
            types: EntityTypeFilter {
                types: vec!["person".into()],
                per_source: Vec::new(),
            },
            remote: None,
            emails_only: false,
            limit: 10,
        })
    };
    let slugs = |keys: &[&str], sources: &[&str]| -> Vec<String> {
        read(keys, sources)
            .unwrap()
            .into_iter()
            .map(|r| format!("{}:{}", r.source_id, r.slug))
            .collect()
    };
    assert_eq!(
        slugs(&["alice"], &["default"]),
        ["default:people/alice-example"]
    );
    assert_eq!(
        slugs(&["alice"], &["default", "other"]),
        ["default:people/alice-example", "other:people/other-alice"]
    );
    assert_eq!(
        slugs(&["nope", "ae"], &["default"]),
        ["default:people/alice-example"]
    );
    assert!(slugs(&["ali"], &["default"]).is_empty());
    assert!(slugs(&["nope"], &["default"]).is_empty());
    let err = read(&["al\0ice"], &["default"]).unwrap_err();
    assert!(err.to_string().contains("invalid byte sequence"), "{err}");
    let err = read(&["alice"], &["def\0ault"]).unwrap_err();
    assert!(err.to_string().contains("invalid byte sequence"), "{err}");
}

/// Seals one compiled-truth chunk holding `text` on the page.
fn seal_chunk(store: &Store, slug: &str, source_id: &str, text: &str) {
    let chunk: ChunkInput = serde_json::from_value(json!({
        "chunk_index": 0, "chunk_text": text, "chunk_source": "compiled_truth",
    }))
    .unwrap();
    let options: UpsertChunksOptions =
        serde_json::from_value(json!({"seal": true, "sourceId": source_id})).unwrap();
    store.upsert_chunks(slug, &[chunk], &options).unwrap();
}

fn hide_labels() -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }
}

#[test]
fn rank_coverage_counts_only_the_pages_the_caller_may_read() {
    let dir = TempDir::new("cli-reads-ops-coverage");
    let store = open(&dir);
    page(&store, "default", "notes/open", "note", json!({}));
    page(
        &store,
        "default",
        "notes/secret",
        "note",
        json!({"visibility": "private"}),
    );
    let input = |policy: Option<PrivacyPolicy>, mentions: Option<Vec<String>>| RankCoverageInput {
        source_id: "default".into(),
        version_ts: Some("2020-01-01T00:00:00Z".into()),
        mention_types: mentions,
        mention_version: 7,
        alias_version: 4,
        exclude_private: policy,
    };
    // Both pages are unstamped: the open one owes link extraction.
    assert!(
        store
            .read_rank_coverage(&input(Some(hide_labels()), None))
            .unwrap()
            .link_behind
    );
    let stamp = |slug: &str| ExtractedRef {
        slug: slug.into(),
        source_id: "default".into(),
        extracted_at: Some("2999-01-01T00:00:00Z".into()),
    };
    store
        .mark_pages_extracted_batch(&[stamp("notes/open")], "2999-01-01T00:00:00Z")
        .unwrap();
    // Only the private page is still stale: it moves coverage for a trusted read, not for the caller.
    let hidden = store
        .read_rank_coverage(&input(Some(hide_labels()), None))
        .unwrap();
    assert_eq!(
        hidden,
        RankCoverageRow {
            link_behind: false,
            mention_due: false
        }
    );
    assert!(
        store
            .read_rank_coverage(&input(None, None))
            .unwrap()
            .link_behind
    );
    // The store keeps no mention state: any readable page owes a mention pass.
    let mentions = store
        .read_rank_coverage(&input(Some(hide_labels()), Some(vec!["person".into()])))
        .unwrap();
    assert!(mentions.mention_due);
    // An archived or unknown source reads as covered.
    let mut unknown = input(None, Some(vec![]));
    unknown.source_id = "nowhere".into();
    assert_eq!(
        store.read_rank_coverage(&unknown).unwrap(),
        RankCoverageRow::default()
    );
}

#[test]
fn exact_snippet_chunks_read_visible_chunks_in_key_order_and_hide_private_pages() {
    let dir = TempDir::new("cli-reads-ops-snippets");
    let store = open(&dir);
    let open_id = page(&store, "default", "notes/open", "note", json!({}));
    let secret_id = page(
        &store,
        "default",
        "notes/secret",
        "note",
        json!({"visibility": "private"}),
    );
    seal_chunk(&store, "notes/open", "default", "zephyr open text");
    seal_chunk(&store, "notes/secret", "default", "zephyr secret text");
    let key = |page_id: u64, snippet: &str| ExactSnippetKey {
        page_id: page_id as i64,
        chunk_index: 0,
        snippet: snippet.into(),
    };
    let keys = vec![
        key(secret_id, "zephyr"),
        key(open_id, "absent"),
        key(open_id, "open"),
        key(9_999, "zephyr"),
    ];
    let rows = |policy: Option<PrivacyPolicy>| {
        store
            .read_exact_snippet_chunks(&ExactSnippetChunksInput {
                keys: keys.clone(),
                exclude_private: policy,
            })
            .unwrap()
            .into_iter()
            .map(|r| (r.i, r.chunk_text))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        rows(Some(hide_labels())),
        vec![(3, "zephyr open text".to_string())]
    );
    assert_eq!(
        rows(None),
        vec![
            (1, "zephyr secret text".to_string()),
            (3, "zephyr open text".to_string())
        ]
    );
}

#[test]
fn exact_rescan_chunks_keep_safe_fenced_pages_the_caller_may_read() {
    let dir = TempDir::new("cli-reads-ops-rescan");
    let store = open(&dir);
    let open_id = page(&store, "default", "notes/open", "note", json!({}));
    let secret_id = page(
        &store,
        "default",
        "notes/secret",
        "note",
        json!({"visibility": "private"}),
    );
    let unsafe_id = page(&store, "default", "notes/unsafe", "note", json!({}));
    for slug in ["notes/open", "notes/secret", "notes/unsafe"] {
        seal_chunk(&store, slug, "default", &format!("text of {slug}"));
    }
    store
        .set_chunker_version("notes/unsafe", "3", Some("default"))
        .unwrap();
    let ids = vec![
        unsafe_id as i64,
        secret_id as i64,
        open_id as i64,
        open_id as i64,
        -1,
    ];
    let pages = |policy: Option<PrivacyPolicy>| {
        store
            .list_exact_rescan_chunks(&ExactRescanInput {
                page_ids: ids.clone(),
                exclude_private: policy,
            })
            .unwrap()
            .into_iter()
            .map(|r| (r.page_id, r.chunk_index, r.chunk_source, r.chunk_text))
            .collect::<Vec<_>>()
    };
    let open_row = (
        open_id,
        0,
        "compiled_truth".to_string(),
        "text of notes/open".to_string(),
    );
    assert_eq!(pages(Some(hide_labels())), vec![open_row.clone()]);
    assert_eq!(
        pages(None),
        vec![
            open_row,
            (
                secret_id,
                0,
                "compiled_truth".to_string(),
                "text of notes/secret".to_string()
            )
        ]
    );
    assert!(
        store
            .list_exact_rescan_chunks(&ExactRescanInput::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn identity_finds_a_page_by_its_phone_digits_and_emails_only_skips_titles_and_phones() {
    let dir = TempDir::new("cli-reads-ops-phone");
    let store = open(&dir);
    page(
        &store,
        "default",
        "people/alice-example",
        "person",
        json!({"phone": "+1 (415) 555-0100"}),
    );
    page(
        &store,
        "default",
        "people/bob-example",
        "person",
        json!({"phones": ["415.555.0199", 4155550142_i64], "email": "bob@example.com"}),
    );
    page(
        &store,
        "default",
        "people/carol-example",
        "person",
        json!({"phone": null}),
    );
    let read = |probes: ExactIdentityProbes, emails_only: bool| -> Vec<String> {
        store
            .list_exact_identity_candidates(&ExactIdentityInput {
                probes,
                source_ids: vec!["default".into()],
                types: EntityTypeFilter {
                    types: vec!["person".into()],
                    per_source: Vec::new(),
                },
                remote: None,
                emails_only,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    let phones = |d: &[&str]| ExactIdentityProbes {
        phones: d.iter().map(|s| s.to_string()).collect(),
        ..ExactIdentityProbes::default()
    };
    assert_eq!(
        read(phones(&["14155550100"]), false),
        ["people/alice-example"]
    );
    assert_eq!(read(phones(&["4155550199"]), false), ["people/bob-example"]);
    assert_eq!(read(phones(&["4155550142"]), false), ["people/bob-example"]);
    assert!(read(phones(&["4155550100"]), false).is_empty());
    // emailsOnly drops the phone and title arms; the email arm still runs.
    assert!(read(phones(&["14155550100"]), true).is_empty());
    let titled = ExactIdentityProbes {
        title_raw: "PEOPLE/ALICE-EXAMPLE".into(),
        emails: vec!["bob@example.com".into()],
        ..ExactIdentityProbes::default()
    };
    assert_eq!(
        read(titled.clone(), false),
        ["people/alice-example", "people/bob-example"]
    );
    assert_eq!(read(titled, true), ["people/bob-example"]);
    // No title key and no raw title: no title arm, so an empty probe finds nothing.
    assert!(read(ExactIdentityProbes::default(), false).is_empty());
    let rows = store
        .list_exact_identity_candidates(&ExactIdentityInput {
            probes: phones(&["4155550199"]),
            source_ids: vec!["default".into()],
            types: EntityTypeFilter {
                types: vec!["person".into()],
                per_source: Vec::new(),
            },
            remote: None,
            emails_only: false,
            limit: 10,
        })
        .unwrap();
    assert_eq!(rows[0].phones, json!(["415.555.0199", 4155550142_i64]));
    assert_eq!(rows[0].phone, Value::Null);
}
