//! Statistics, health counters, the ingest log, enrich candidates and anomaly buckets. The PGLite
//! parity cases are in test/engine-parity/stats.test.ts; these cover the store's own
//! contract: the ingest log's order and durability across a reopen, its not-null checks, the
//! empty scope, the raw counters the TypeScript member scores, the embedded-chunk counts and the
//! salience weight of the enrich order.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::salience::EmotionalWeightRow;
use gbrain_store::sources::SourceInput;
use gbrain_store::stats::*;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use serde_json::{Value, json};

fn put_page(store: &Store, slug: &str, page_type: &str, body: &str, source: Option<&str>) {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type,
        "title": slug,
        "compiled_truth": body,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn source(store: &Store, id: &str) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
    store.upsert_source(&input).unwrap();
}

fn link(store: &Store, from: &str, to: &str) {
    store
        .add_link(from, to, &AddLinkOptions::default())
        .unwrap();
}

fn ingest(source_ref: &str, source: Option<&str>) -> IngestInput {
    IngestInput {
        source_id: source.map(str::to_string),
        source_type: Some("git".into()),
        source_ref: Some(source_ref.into()),
        pages_updated_json: Some(r#"{"b":1,"a":[2]}"#.into()),
        summary: Some("ok".into()),
        ..IngestInput::default()
    }
}

fn scope(ids: Option<&[&str]>) -> ScopeInput {
    ScopeInput {
        scope: ids.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
    }
}

fn refs(rows: &[Value]) -> Vec<&str> {
    rows.iter()
        .map(|r| r["source_ref"].as_str().unwrap())
        .collect()
}

#[test]
fn ingest_log_is_newest_first_limited_scoped_and_durable() {
    let dir = TempDir::new("stats-ingest");
    {
        let store = open(&dir);
        source(&store, "work");
        for (i, s) in [None, Some("work"), None].into_iter().enumerate() {
            store.log_ingest(&ingest(&format!("r{i}"), s)).unwrap();
        }
    }
    let store = open(&dir);
    let all = store.get_ingest_log(&IngestLogOptions::default()).unwrap();
    assert_eq!(refs(&all), ["r2", "r1", "r0"]);
    assert_eq!(all[0]["source_id"], "default");
    assert_eq!(all[0]["pages_updated"], json!({"a": [2], "b": 1}));
    assert!(all[0]["created_at"].is_string());
    let limited = store
        .get_ingest_log(&IngestLogOptions {
            limit: Some(1.0),
            source_ids: None,
        })
        .unwrap();
    assert_eq!(refs(&limited), ["r2"]);
    let work = store
        .get_ingest_log(&IngestLogOptions {
            limit: None,
            source_ids: Some(vec!["work".into()]),
        })
        .unwrap();
    assert_eq!(refs(&work), ["r1"]);
    let negative = store
        .get_ingest_log(&IngestLogOptions {
            limit: Some(-1.0),
            source_ids: None,
        })
        .unwrap_err();
    assert_eq!(negative.code, INVALID_ARGUMENT);
}

#[test]
fn log_ingest_checks_not_null_columns_in_order() {
    let dir = TempDir::new("stats-ingest-null");
    let store = open(&dir);
    let mut entry = ingest("r", None);
    entry.source_type = None;
    entry.summary = None;
    let err = store.log_ingest(&entry).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(err.message.contains("\"source_type\""), "{}", err.message);
    let mut entry = ingest("r", None);
    entry.pages_updated_json = None;
    let err = store.log_ingest(&entry).unwrap_err();
    assert!(err.message.contains("\"pages_updated\""), "{}", err.message);
    let mut entry = ingest("r", None);
    entry.pages_updated_json = Some("{not json".into());
    assert_eq!(store.log_ingest(&entry).unwrap_err().code, INVALID_ARGUMENT);
    assert!(
        store
            .get_ingest_log(&IngestLogOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ping_store_answers_on_an_empty_and_a_written_store() {
    let dir = TempDir::new("stats-ping");
    let store = open(&dir);
    store.ping_store().unwrap();
    put_page(&store, "a", "note", "alpha", None);
    store.ping_store().unwrap();
}

#[test]
fn get_stats_counts_scope_and_empty_scope() {
    let dir = TempDir::new("stats-get");
    let store = open(&dir);
    source(&store, "work");
    put_page(&store, "a", "person", "alpha", None);
    put_page(&store, "b", "person", "beta", None);
    put_page(&store, "c", "note", "gamma", Some("work"));
    link(&store, "a", "b");
    store.add_tag("a", "x", None).unwrap();
    store.add_tag("b", "x", None).unwrap();
    store
        .add_timeline_entry(
            "a",
            &TimelineInput {
                date: Some("2026-01-02".into()),
                summary: Some("met".into()),
                ..TimelineInput::default()
            },
            &AddTimelineOptions::default(),
        )
        .unwrap();

    let all = store.get_stats(&scope(None)).unwrap();
    assert_eq!(all["page_count"], 3);
    assert_eq!(all["link_count"], 1);
    assert_eq!(all["tag_count"], 1);
    assert_eq!(all["timeline_entry_count"], 1);
    assert_eq!(all["embedded_count"], 0);
    assert_eq!(all["pages_by_type"], json!({"person": 2, "note": 1}));

    let work = store.get_stats(&scope(Some(&["work"]))).unwrap();
    assert_eq!(work["page_count"], 1);
    assert_eq!(work["link_count"], 0);
    assert_eq!(work["tag_count"], 0);

    let none = store.get_stats(&scope(Some(&[]))).unwrap();
    assert_eq!(none["page_count"], 0);
    assert_eq!(none["pages_by_type"], json!({}));
}

#[test]
fn get_health_counts_dead_links_entities_and_most_connected() {
    let dir = TempDir::new("stats-health");
    let store = open(&dir);
    put_page(&store, "hub", "person", "hub", None);
    put_page(&store, "a", "person", "a", None);
    put_page(&store, "b", "note", "b", None);
    put_page(&store, "lonely", "note", "alone", None);
    link(&store, "a", "hub");
    link(&store, "b", "hub");
    link(&store, "hub", "a");
    let input: HealthInput = serde_json::from_value(json!({
        "scope": null,
        "entityTypes": { "types": ["person"], "per_source": [] },
    }))
    .unwrap();
    let health = store.get_health(&input).unwrap();
    assert_eq!(health["page_count"], 4);
    assert_eq!(health["link_count"], 3);
    assert_eq!(health["dead_links"], 0);
    assert_eq!(health["embedded_chunks"], 0);
    assert_eq!(health["entity_page_count"], 2);
    assert_eq!(health["entity_linked"], 2);
    assert_eq!(
        health["most_connected"][0],
        json!({"slug": "hub", "link_count": 3})
    );
    let linkable = health["linkable"].as_array().unwrap();
    let lonely = linkable.iter().find(|p| p["slug"] == "lonely").unwrap();
    assert_eq!(lonely["islanded"], true);
}

#[test]
fn enrich_candidates_filter_thin_pages_and_order_by_inbound() {
    let dir = TempDir::new("stats-enrich");
    let store = open(&dir);
    put_page(&store, "thin", "person", "x", None);
    put_page(&store, "popular", "person", "y", None);
    put_page(&store, "thick", "person", &"z".repeat(500), None);
    put_page(&store, "other", "note", "w", None);
    link(&store, "other", "popular");
    let input: EnrichInput = serde_json::from_value(json!({
        "types": ["person"], "thinThreshold": 100.0, "order": "inbound-links", "limit": 10,
    }))
    .unwrap();
    let rows = store.list_enrich_candidates(&input).unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["popular", "thin"]);
    assert_eq!(rows[0]["inbound_count"], 1);
    assert_eq!(rows[0]["body_len"], 1);
}

#[test]
fn anomalies_bucket_baseline_days_and_today() {
    let dir = TempDir::new("stats-anomaly");
    let store = open(&dir);
    put_page(&store, "p", "person", "x", None);
    store.add_tag("p", "t", None).unwrap();
    // A window that holds now as "today" and nothing in the baseline.
    let day: i64 = 86_400_000_000;
    let since = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64)
        .div_euclid(day)
        * day;
    let input = AnomalyInput {
        scope: None,
        baseline_start_us: (since - 3 * day) as f64,
        since_us: since as f64,
        since_end_us: (since + day) as f64,
        ..Default::default()
    };
    let found = store.find_anomalies(&input).unwrap();
    assert_eq!(found["baseline"], json!({"tag": {}, "type": {}}));
    let today = found["today"].as_array().unwrap();
    assert_eq!(
        today
            .iter()
            .map(|r| (
                r["cohort_kind"].as_str().unwrap(),
                r["cohort_value"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [("tag", "t"), ("type", "person")]
    );
    assert_eq!(today[0]["page_slugs"], json!(["p"]));
    // The same page in the baseline window instead.
    let earlier = AnomalyInput {
        scope: None,
        baseline_start_us: since as f64,
        since_us: (since + day) as f64,
        since_end_us: (since + 2 * day) as f64,
        ..Default::default()
    };
    let found = store.find_anomalies(&earlier).unwrap();
    assert!(found["today"].as_array().unwrap().is_empty());
    let tag = found["baseline"]["tag"]["t"].as_object().unwrap();
    assert_eq!(tag.values().next().unwrap(), 1);
}

#[test]
fn anomalies_under_exclude_private_skip_hidden_pages_in_today_and_the_baseline() {
    let dir = TempDir::new("stats-anomaly-private");
    let store = open(&dir);
    let put = |slug: &str, frontmatter: Value| {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        store.add_tag(slug, "t", None).unwrap();
    };
    put("open", json!({}));
    put("secret", json!({"visibility": "private"}));
    put("readers", json!({"readable_by": ["alice-example"]}));
    put("alias", json!({"access": "restricted"}));
    let day: i64 = 86_400_000_000;
    let since = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64)
        .div_euclid(day)
        * day;
    let read = |since: i64, policy: Option<PrivacyPolicy>| {
        store
            .find_anomalies(&AnomalyInput {
                scope: None,
                baseline_start_us: (since - day) as f64,
                since_us: since as f64,
                since_end_us: (since + day) as f64,
                exclude_private: policy,
            })
            .unwrap()
    };
    let slugs = |found: &Value| {
        let mut slugs: Vec<String> = found["today"][0]["page_slugs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        slugs.sort();
        slugs
    };
    let strict = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        slugs(&read(since, None)),
        ["alias", "open", "readers", "secret"]
    );
    assert_eq!(slugs(&read(since, Some(strict.clone()))), ["open"]);
    // With aliases off, `access: restricted` is no longer private.
    let no_alias = PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        slugs(&read(since, Some(no_alias.clone()))),
        ["alias", "open"]
    );
    // With the privacy part off (privacy relaxed), only the reader list still hides a page.
    let relaxed = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: false,
        ..Default::default()
    };
    assert_eq!(
        slugs(&read(since, Some(relaxed.clone()))),
        ["alias", "open", "secret"]
    );
    // The baseline window counts only what the policy keeps.
    let later = read(since + day, Some(strict.clone()));
    let tag = later["baseline"]["tag"]["t"].as_object().unwrap();
    assert_eq!(tag.values().next().unwrap(), 1);
}

/// Writes `count` chunks on `slug`; the first `embedded` of them carry a vector.
fn chunks(store: &Store, slug: &str, count: u32, embedded: u32) {
    let rows: Vec<ChunkInput> = (0..count)
        .map(|i| {
            let mut row = json!({ "chunk_index": i, "chunk_text": format!("{slug} {i}") });
            if i < embedded {
                let vector: Vec<f64> = (0..1536)
                    .map(|d| if d == i as usize { 1.0 } else { 0.0 })
                    .collect();
                row["model"] = json!("m1");
                row["embedding"] = json!(vector);
            }
            serde_json::from_value(row).unwrap()
        })
        .collect();
    store
        .upsert_chunks(slug, &rows, &UpsertChunksOptions::default())
        .unwrap();
}

fn health_of(store: &Store) -> Value {
    let input: HealthInput = serde_json::from_value(json!({
        "scope": null,
        "entityTypes": { "types": [], "per_source": [] },
    }))
    .unwrap();
    store.get_health(&input).unwrap()
}

#[test]
fn embedded_counts_read_stored_vectors() {
    let dir = TempDir::new("stats-embedded");
    let store = open(&dir);
    put_page(&store, "live", "note", "live", None);
    put_page(&store, "gone", "note", "gone", None);
    let skip: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "skip", "compiled_truth": "skip", "frontmatter": { "embed_skip": true },
    }))
    .unwrap();
    store
        .put_page("skip", &skip, &PutPageOptions::default())
        .unwrap();
    chunks(&store, "live", 3, 2);
    chunks(&store, "gone", 1, 1);
    chunks(&store, "skip", 2, 1);
    store.soft_delete_page("gone", None).unwrap();

    // getStats counts every chunk with a vector, soft-deleted and embed_skip pages too.
    let stats = store.get_stats(&scope(None)).unwrap();
    assert_eq!(stats["chunk_count"], 6);
    assert_eq!(stats["embedded_count"], 4);
    // getHealth counts only live, eligible chunks.
    let health = health_of(&store);
    assert_eq!(health["eligible_chunks"], 3);
    assert_eq!(health["embedded_chunks"], 2);
    assert_eq!(health["missing_embeddings"], 1);

    // deleteChunks drops the vectors with the chunks.
    store.delete_chunks("live", None).unwrap();
    assert_eq!(store.get_stats(&scope(None)).unwrap()["embedded_count"], 2);
    let health = health_of(&store);
    assert_eq!(health["embedded_chunks"], 0);
    assert_eq!(health["missing_embeddings"], 0);
}

#[test]
fn enrich_salience_order_reads_the_emotional_weight() {
    let dir = TempDir::new("stats-enrich-salience");
    let store = open(&dir);
    put_page(&store, "low", "person", "x", None);
    put_page(&store, "high", "person", "y", None);
    put_page(&store, "linked", "person", "z", None);
    put_page(&store, "other", "note", "w", None);
    link(&store, "other", "linked");
    let input: EnrichInput = serde_json::from_value(json!({
        "types": ["person"], "thinThreshold": 100.0, "order": "salience", "limit": 10,
    }))
    .unwrap();
    let slugs = |store: &Store| -> Vec<String> {
        store
            .list_enrich_candidates(&input)
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    };
    // No weight: every page reads 0, so inbound links decide, then the slug.
    assert_eq!(slugs(&store), ["linked", "high", "low"]);
    let rows: Vec<EmotionalWeightRow> = serde_json::from_value(json!([
        { "slug": "high", "source_id": "default", "weight": 0.9 },
        { "slug": "low", "source_id": "default", "weight": 0.1 },
    ]))
    .unwrap();
    store.set_emotional_weight_batch(&rows).unwrap();
    assert_eq!(slugs(&store), ["high", "low", "linked"]);
}

fn onboard(store: &Store, signal: &str) -> u64 {
    let input: OnboardSignalInput = serde_json::from_value(json!({
        "signal": signal,
        "entityTypes": {
            "types": ["person", "company"],
            "per_source": [{ "source_id": "other", "types": ["company"] }],
        },
    }))
    .unwrap();
    store.count_onboard_signal(&input).unwrap()
}

#[test]
fn onboard_signals_count_brain_wide_live_pages_under_the_entity_filter() {
    let dir = TempDir::new("stats-onboard");
    let store = open(&dir);
    source(&store, "other");
    put_page(&store, "people/alice-example", "person", "alice", None);
    put_page(&store, "companies/acme-example", "company", "acme", None);
    put_page(&store, "people/gone-example", "person", "gone", None);
    put_page(&store, "notes/memo", "note", "memo", None);
    // A person in `other`, whose entity types are only `company`.
    put_page(
        &store,
        "people/carol-example",
        "person",
        "carol",
        Some("other"),
    );
    let skip: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "skip", "compiled_truth": "skip", "frontmatter": { "embed_skip": true },
    }))
    .unwrap();
    store
        .put_page("notes/skip", &skip, &PutPageOptions::default())
        .unwrap();
    chunks(&store, "notes/memo", 3, 1);
    chunks(&store, "notes/skip", 2, 0);
    chunks(&store, "people/gone-example", 1, 0);
    link(&store, "notes/memo", "people/alice-example");
    link(&store, "people/alice-example", "people/gone-example");
    store.soft_delete_page("people/gone-example", None).unwrap();

    // memo has 2 chunks with no vector; alice, acme and carol each have the one chunk `put_page`
    // made from the body. skip (embed_skip) and gone (soft-deleted) do not count.
    assert_eq!(onboard(&store, "stale_chunks"), 5);
    assert_eq!(onboard(&store, "entities"), 2);
    assert_eq!(onboard(&store, "linked_entities"), 1);
    assert_eq!(onboard(&store, "timeline_entities"), 0);
    assert_eq!(onboard(&store, "takes"), 0);
    assert_eq!(onboard(&store, "pages"), 5);
    // A signal the member does not name counts live pages, as the SQL's last arm does.
    assert_eq!(onboard(&store, "unknown"), 5);
}

#[test]
fn live_pages_count_every_source_and_skip_soft_deleted_pages() {
    // `countLivePages` (`engine-sql/doctor-pages.ts`), the brain-wide count backup coverage reads.
    let dir = TempDir::new("stats-brain-live");
    let store = open(&dir);
    assert_eq!(store.count_live_pages().unwrap(), 0);
    source(&store, "other");
    put_page(&store, "notes/a", "note", "a", None);
    put_page(&store, "notes/b", "note", "b", None);
    put_page(&store, "notes/c", "note", "c", Some("other"));
    assert_eq!(store.count_live_pages().unwrap(), 3);
    store.soft_delete_page("notes/b", None).unwrap();
    assert_eq!(store.count_live_pages().unwrap(), 2);
}

#[test]
fn live_counts_by_source_count_live_pages_and_their_chunks_per_source() {
    let dir = TempDir::new("stats-live-by-source");
    let store = open(&dir);
    assert_eq!(store.live_counts_by_source().unwrap(), json!([]));
    source(&store, "other");
    put_page(&store, "notes/a", "note", "a", None);
    put_page(&store, "notes/b", "note", "b", None);
    put_page(&store, "notes/gone", "note", "gone", None);
    put_page(&store, "notes/c", "note", "c", Some("other"));
    chunks(&store, "notes/a", 3, 2);
    chunks(&store, "notes/gone", 2, 2);
    // put_page writes one chunk of its own, so notes/b and notes/c have one each.
    store.soft_delete_page("notes/gone", None).unwrap();
    assert_eq!(
        store.live_counts_by_source().unwrap(),
        json!([
            { "source_id": "default", "pages": 2, "chunks": 4, "embedded": 2 },
            { "source_id": "other", "pages": 1, "chunks": 1, "embedded": 0 },
        ])
    );
}
