//! Read-back tests of the shadow seed: one per relation, plus the claim guard, retries, losses,
//! unmapped columns and the decoders.

use super::decode::timestamp_us;
use super::*;
use crate::chunks::ChunkRecord;
use crate::embeddings::{InvalidateOptions, StaleChunkOptions};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, INVALID_STATE, PAGE_NOT_FOUND};
use crate::facts::{md5_hex, read_fact};
use crate::links::LinkRecord;
use crate::links::LinkScope;
use crate::pages::ReadScope;
use crate::test_support::store;
use crate::timeline::TimelineOptions;
use serde_json::json;

const SEED: &str = "seed-1";
const REV: &str = "11111111-1111-4111-8111-111111111111";
const INCARNATION: &str = "22222222-2222-4222-8222-222222222222";
const OTHER_REV: &str = "33333333-3333-4333-8333-333333333333";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn counter(s: &Store, name: &str) -> u64 {
    let read = s.read().unwrap();
    keys::be8(&read.get(&keys::meta(name)).unwrap().unwrap()).unwrap()
}

fn us(text: &str) -> i64 {
    timestamp_us(text).unwrap()
}

fn page_row(id: &str, slug: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("slug", slug),
        ("type", "person"),
        ("page_kind", "markdown"),
        ("title", "Alice Example"),
        ("compiled_truth", "Alice builds widgets at acme."),
        ("timeline", ""),
        ("frontmatter", r#"{"role": "founder"}"#),
        ("content_hash", "abc123"),
        ("created_at", "2026-01-02 03:04:05.123456+00"),
        ("updated_at", "2026-02-03 04:05:06.5+00"),
        ("knowledge_revision", REV),
        ("text_projection_revision", REV),
        ("chunker_version", "3"),
        ("trust_tier", "user_confirmed"),
        ("write_origin", r#"{"kind": "cli"}"#),
        ("emotional_weight", "0.75"),
        ("salience_touched_at", "2026-03-01 00:00:00+00"),
        ("contextual_retrieval_mode", "on"),
        ("corpus_generation", "g7"),
        ("embedding_signature", "openai:text-embedding-3-large:1536"),
        ("links_extracted_at", "2026-03-02 00:00:00+00"),
        ("generation", "1"),
        ("search_vector", "'alice':1"),
    ])
}

/// A store with the default source and two pages (ids 7 and 9).
fn seeded_pages() -> Store {
    let s = store();
    let r = import(
        &s,
        "pages",
        vec![
            page_row("7", "people/alice-example"),
            page_row("9", "companies/acme-example"),
        ],
    );
    assert_eq!(r.imported, 2);
    s
}

#[test]
fn claim_writes_the_manifest_and_refuses_another_seed() {
    let s = store();
    let r = import(&s, "config", vec![row(&[("key", "k"), ("value", "v")])]);
    assert_eq!((r.imported, r.skipped), (1, 0));
    let read = s.read().unwrap();
    let manifest: SeedManifest = get_json(&*read, &keys::meta(MANIFEST)).unwrap().unwrap();
    assert_eq!(manifest.seed_id, SEED);
    assert!(manifest.started_at_us > 0);
    assert_eq!(manifest.relations["config"].imported, 1);
    drop(read);

    let err = s
        .import_relation(
            "seed-2",
            "config",
            vec![row(&[("key", "k2"), ("value", "v")])],
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    assert!(err.message.starts_with("shadow_seed:"), "{}", err.message);
    assert_eq!(s.get_config("k2").unwrap(), None);
}

#[test]
fn claim_refuses_a_store_that_is_not_fresh() {
    let s = store();
    s.write(|tx| {
        tx.put(&keys::text(keys::CONFIG, &["other"]), b"x")?;
        Ok(())
    })
    .unwrap();
    let err = s
        .import_relation(SEED, "config", vec![row(&[("key", "k"), ("value", "v")])])
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    assert!(err.message.contains("not empty"), "{}", err.message);
}

#[test]
fn unknown_relation_and_empty_seed_id_are_refused() {
    let s = store();
    assert_eq!(
        s.import_relation(SEED, "nope", vec![]).unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        s.import_relation("", "config", vec![]).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_failed_batch_stores_nothing() {
    let s = store();
    let bad = row(&[("id", "1"), ("page_id", "99"), ("tag", "x")]);
    let err = s.import_relation(SEED, "tags", vec![bad]).unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
    assert!(err.message.starts_with("tags row 0:"), "{}", err.message);
    // The refused batch left no manifest, so another seed may still claim the store.
    s.import_relation("seed-2", "config", vec![]).unwrap();
}

#[test]
fn a_batch_that_fails_after_good_rows_stores_none_of_them() {
    // Value: protects=a failed batch leaves no accepted prefix; fails_when=rows commit one by one before a later row fails;
    // why_new=a_failed_batch_stores_nothing fails on its first row, before any data was written; seam=none;
    // no_claim=power-loss durability.
    let s = seeded_pages();
    let good = row(&[("page_id", "7"), ("tag", "founder")]);
    let bad = row(&[("page_id", "99"), ("tag", "x")]);
    let err = s
        .import_relation(SEED, "tags", vec![good, bad])
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
    assert!(err.message.starts_with("tags row 1:"), "{}", err.message);
    assert!(
        s.get_tags("people/alice-example", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    // The same seed may send the batch again: the refused batch recorded nothing.
    let r = import(
        &s,
        "tags",
        vec![row(&[("page_id", "7"), ("tag", "founder")])],
    );
    assert_eq!((r.imported, r.skipped), (1, 0));
}

#[test]
fn sources_are_copied_verbatim_and_retries_skip() {
    let s = store();
    let wiki = row(&[
        ("id", "wiki"),
        ("name", "Wiki"),
        ("local_path", "/brain/wiki"),
        ("last_sync_at", "2026-04-05 06:07:08.000009+00"),
        ("config", r#"{"federated": false}"#),
        ("archived", "f"),
        ("incarnation", INCARNATION),
        ("created_at", "2025-12-31 23:59:59+00"),
        ("trust_frontmatter_overrides", "false"),
        ("purge_epoch", "0"),
        ("last_commit", "deadbeef"),
    ]);
    let default = row(&[
        ("id", "default"),
        ("name", "default"),
        ("config", r#"{"federated": true}"#),
        ("archived", "false"),
        ("incarnation", REV),
        ("created_at", "2025-01-01 00:00:00+00"),
    ]);
    let r = import(&s, "sources", vec![wiki.clone(), default.clone()]);
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert_eq!(r.unmapped_columns, vec!["last_commit".to_string()]);

    let read = s.read().unwrap();
    let got = read_source(&*read, "wiki").unwrap().unwrap();
    assert_eq!(got.name.as_deref(), Some("Wiki"));
    assert_eq!(got.local_path.as_deref(), Some("/brain/wiki"));
    assert_eq!(got.last_sync_at_us, Some(us("2026-04-05T06:07:08.000009Z")));
    assert_eq!(got.config.get("federated"), Some(&json!(false)));
    assert_eq!(got.incarnation, INCARNATION);
    assert_eq!(got.created_at_us, us("2025-12-31T23:59:59Z"));
    let default_source = read_source(&*read, "default").unwrap().unwrap();
    assert_eq!(default_source.incarnation, REV);
    assert_eq!(default_source.created_at_us, us("2025-01-01T00:00:00Z"));
    drop(read);

    let again = import(&s, "sources", vec![wiki, default]);
    assert_eq!((again.imported, again.skipped), (0, 2));
}

#[test]
fn config_is_copied_and_the_schema_version_is_kept() {
    let s = store();
    let version = s.get_config("version").unwrap().unwrap();
    let r = import(
        &s,
        "config",
        vec![
            row(&[("key", "embedding_dimensions"), ("value", "1024")]),
            row(&[("key", "version"), ("value", "1")]),
            row(&[("key", "version"), ("value", &version)]),
        ],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (1, 1, 1));
    assert_eq!(r.losses.get("config_version_differs"), Some(&1));
    assert_eq!(
        s.get_config("embedding_dimensions").unwrap().as_deref(),
        Some("1024")
    );
    assert_eq!(s.get_config("version").unwrap(), Some(version));
}

#[test]
fn pages_keep_ids_times_revisions_and_family_columns() {
    let s = seeded_pages();
    let read = s.read().unwrap();
    let page = read_page_by_id(&*read, 7).unwrap().unwrap();
    assert_eq!(page.slug, "people/alice-example");
    assert_eq!(page.page_type, "person");
    assert_eq!(page.knowledge_revision, REV);
    assert_eq!(page.text_projection_revision.as_deref(), Some(REV));
    assert_eq!(page.created_at_us, us("2026-01-02T03:04:05.123456Z"));
    assert_eq!(page.updated_at_us, us("2026-02-03T04:05:06.5Z"));
    assert_eq!(page.chunker_version, Some(3));
    assert_eq!(page.content_hash.as_deref(), Some("abc123"));
    assert_eq!(page.frontmatter.get("role"), Some(&json!("founder")));
    // The seed's backfill keeps the tier and origin the primary stamped.
    assert_eq!(page.trust_tier.as_deref(), Some("user_confirmed"));
    assert_eq!(page.write_origin, Some(json!({"kind": "cli"})));
    // Index keys: the slug key and the id key.
    assert!(
        read.get(&keys::page("default", "people/alice-example"))
            .unwrap()
            .is_some()
    );
    assert!(read.get(&keys::page_id(7)).unwrap().is_some());
    let shown = page.to_page_with_columns(&*read).unwrap();
    assert_eq!(shown["contextual_retrieval_mode"], json!("on"));
    assert_eq!(shown["emotional_weight"], json!(0.75));
    drop(read);
    assert_eq!(counter(&s, crate::pages::NEXT_PAGE_ID), 10);

    // The signature carried over: no stale chunk for the page's own signature.
    let sig = StaleChunkOptions {
        signature: Some("openai:text-embedding-3-large:1536".into()),
        ..Default::default()
    };
    assert_eq!(s.count_stale_chunks(&sig).unwrap(), 0);
    // A later page write takes the next id.
    assert_eq!(
        s.write(|tx| crate::pages::next_id(tx, crate::pages::NEXT_PAGE_ID))
            .unwrap(),
        10
    );
}

#[test]
fn an_imported_page_signature_decides_which_embedded_chunks_are_stale() {
    // Value: protects=the page's embedding signature survives the import; fails_when=the signature is dropped or changed (every embedded chunk
    // would then read stale or fresh by the wrong rule); why_new=the signature check in pages_keep_ids_times_revisions_and_family_columns runs on a
    // page with no chunk, so it passes without the signature; seam=none; no_claim=embedding provider compatibility.
    let s = seeded_pages();
    let text = "Alice builds widgets at acme.";
    let mut embedded = chunk_row("41", "0", text);
    embedded.insert("embedding".into(), Some("[0.5,-0.25,1]".into()));
    embedded.insert("embedded_at".into(), Some("2026-01-03 00:00:00+00".into()));
    embedded.insert("embedded_text_hash".into(), Some(md5_hex(text)));
    assert_eq!(import(&s, "content_chunks", vec![embedded]).imported, 1);
    let stale = |signature: &str| {
        s.count_stale_chunks(&StaleChunkOptions {
            signature: Some(signature.into()),
            include_null_signature: true,
            ..Default::default()
        })
        .unwrap()
    };
    assert_eq!(stale("openai:text-embedding-3-large:1536"), 0);
    assert_eq!(stale("another:model:1"), 1);
}

#[test]
fn pages_retry_skips_and_a_slug_held_by_another_id_is_refused() {
    let s = seeded_pages();
    let r = import(&s, "pages", vec![page_row("7", "people/alice-example")]);
    assert_eq!((r.imported, r.skipped), (0, 1));
    let err = s
        .import_relation(SEED, "pages", vec![page_row("8", "people/alice-example")])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

#[test]
fn pages_report_losses_and_unmapped_columns() {
    let s = store();
    let mut p = page_row("3", "notes/x");
    p.remove("salience_touched_at");
    p.remove("contextual_retrieval_mode");
    p.insert("generation".into(), Some("4".into()));
    p.insert("page_readers".into(), Some("{a}".into()));
    p.insert("last_retrieved_at".into(), None);
    p.insert("body_storage".into(), Some("segmented".into()));
    p.insert("body_generation".into(), Some("2".into()));
    p.insert("compiled_truth".into(), None);
    let r = import(&s, "pages", vec![p]);
    assert_eq!(r.imported, 1);
    assert_eq!(r.unmapped_columns, vec!["generation", "page_readers"]);
    assert_eq!(r.losses.get("emotional_weight_without_touch"), Some(&1));
    assert_eq!(r.losses.get("corpus_generation_without_mode"), Some(&1));
    assert_eq!(r.losses.get("segmented_body"), Some(&1));
    let read = s.read().unwrap();
    let page = read_page_by_id(&*read, 3).unwrap().unwrap();
    assert!(page.compiled_truth.is_null());
    let shown = page.to_page_with_columns(&*read).unwrap();
    assert_eq!(shown["body_storage"], json!("segmented"));
}

#[test]
fn tags_are_added_without_touching_the_page() {
    let s = seeded_pages();
    let before = read_page_by_id(&*s.read().unwrap(), 7).unwrap().unwrap();
    let r = import(
        &s,
        "tags",
        vec![
            row(&[
                ("id", "1"),
                ("page_id", "7"),
                ("tag", "founder"),
                ("tag_source", "frontmatter"),
            ]),
            row(&[("id", "2"), ("page_id", "7"), ("tag", "yc")]),
        ],
    );
    assert_eq!(r.imported, 2);
    assert_eq!(r.unmapped_columns, vec!["id"]);
    let scope = ReadScope::default();
    let mut tags = s.get_tags("people/alice-example", &scope).unwrap();
    tags.sort();
    assert_eq!(tags, vec!["founder", "yc"]);
    let after = read_page_by_id(&*s.read().unwrap(), 7).unwrap().unwrap();
    assert_eq!(after.updated_at_us, before.updated_at_us);
    assert_eq!(after.trust_tier, before.trust_tier);
    assert_eq!(
        after.tag_sources.get("founder").map(String::as_str),
        Some("frontmatter")
    );
    assert!(!after.tag_sources.contains_key("yc"));
    let again = import(&s, "tags", vec![row(&[("page_id", "7"), ("tag", "yc")])]);
    assert_eq!((again.imported, again.skipped), (0, 1));
}

fn chunk_row(id: &str, index: &str, text: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", "7"),
        ("chunk_index", index),
        ("chunk_text", text),
        ("chunk_source", "compiled_truth"),
        ("model", "openai:text-embedding-3-large"),
        ("modality", "text"),
        ("token_count", "6"),
        ("created_at", "2026-01-02 03:04:05+00"),
    ])
}

#[test]
fn chunks_keep_ids_vectors_and_hashes() {
    let s = seeded_pages();
    let text = "Alice builds widgets at acme.";
    let mut embedded = chunk_row("41", "0", text);
    embedded.insert("embedding".into(), Some("[0.5,-0.25,1]".into()));
    embedded.insert("embedded_at".into(), Some("2026-01-03 00:00:00+00".into()));
    embedded.insert("embedded_text_hash".into(), Some(md5_hex(text)));
    embedded.insert("parent_symbol_path".into(), Some(r#"{a,"b c"}"#.into()));
    let mut stale = chunk_row("42", "1", "second chunk");
    stale.insert("embedding".into(), Some("[1,0,0]".into()));
    stale.insert("embedded_at".into(), Some("2026-01-03 00:00:00+00".into()));
    stale.insert("embedded_text_hash".into(), Some("not-the-hash".into()));
    stale.insert("embedding_image".into(), Some("[1]".into()));
    let mut segment = chunk_row("43", "2", "segment");
    segment.insert("body_generation".into(), Some("1".into()));
    let mut retired = chunk_row("44", "3", "retired");
    retired.insert("retired_generation".into(), Some("1".into()));
    let r = import(
        &s,
        "content_chunks",
        vec![embedded, stale, segment, retired],
    );
    assert_eq!((r.imported, r.dropped), (2, 2));
    assert_eq!(r.losses.get("segment_chunk"), Some(&1));
    assert_eq!(r.losses.get("retired_chunk"), Some(&1));
    assert_eq!(r.losses.get("embedding_image"), Some(&1));
    assert_eq!(r.unmapped_columns, vec!["created_at"]);

    let read = s.read().unwrap();
    let chunk: ChunkRecord = get_json(&*read, &keys::chunk(7, 0)).unwrap().unwrap();
    assert_eq!(chunk.id, 41);
    assert_eq!(chunk.embed.dims, 3);
    assert_eq!(chunk.embed.embedded_at_us, Some(us("2026-01-03T00:00:00Z")));
    assert_eq!(
        chunk.embed.text_hash.as_deref(),
        Some(crate::embeddings::text_hash(text).as_str())
    );
    assert_eq!(chunk.meta["token_count"], json!(6));
    assert_eq!(chunk.meta["model"], json!("openai:text-embedding-3-large"));
    assert_eq!(chunk.meta["parent_symbol_path"], json!(["a", "b c"]));
    assert!(chunk.length > 0);
    drop(read);
    // The dropped segment chunk (43) and retired chunk (44) still moved the counter: a code edge may name them.
    assert_eq!(counter(&s, crate::chunks::NEXT_CHUNK_ID), 45);

    let vectors = s.get_embeddings_by_chunk_ids(&[41, 42]).unwrap();
    assert_eq!(vectors.len(), 2);
    assert_eq!(vectors[0]["embedding"], json!([0.5, -0.25, 1.0]));
    let chunks = s
        .get_chunks("people/alice-example", &ReadScope::default())
        .unwrap();
    assert_eq!(chunks.len(), 2);
    // Only the chunk whose hash was not of its text reads as drifted.
    assert_eq!(
        s.invalidate_content_drift_embeddings(&InvalidateOptions::default())
            .unwrap(),
        1
    );
    let found = s
        .search_keyword("widgets", &crate::search::SearchOptions::default())
        .unwrap();
    assert_eq!(found[0]["slug"], json!("people/alice-example"));

    let again = import(&s, "content_chunks", vec![chunk_row("41", "0", text)]);
    assert_eq!(again.skipped, 1);
    let err = s
        .import_relation(SEED, "content_chunks", vec![chunk_row("50", "0", text)])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

fn link_row(id: &str, from: &str, to: &str, link_type: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("from_page_id", from),
        ("to_page_id", to),
        ("link_type", link_type),
        ("context", "works at"),
        ("link_source", "markdown"),
        ("created_at", "2026-01-04 00:00:00+00"),
    ])
}

#[test]
fn links_keep_ids_and_index_keys() {
    let s = seeded_pages();
    let r = import(&s, "links", vec![link_row("31", "7", "9", "works_at")]);
    assert_eq!(r.imported, 1);
    let links = s
        .get_links("people/alice-example", &LinkScope::default())
        .unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["to_slug"], json!("companies/acme-example"));
    assert_eq!(links[0]["link_type"], json!("works_at"));
    let read = s.read().unwrap();
    let stored: LinkRecord = get_json(&*read, &keys::link(7, 31)).unwrap().unwrap();
    assert_eq!(stored.created_at_us, us("2026-01-04T00:00:00Z"));
    assert!(read.get(&keys::link_to(9, 31)).unwrap().is_some());
    assert!(read.get(&stored.unique_key()).unwrap().is_some());
    drop(read);
    assert_eq!(counter(&s, crate::links::NEXT_LINK_ID), 32);

    assert_eq!(
        import(&s, "links", vec![link_row("31", "7", "9", "works_at")]).skipped,
        1
    );
    let err = s
        .import_relation(SEED, "links", vec![link_row("35", "7", "9", "works_at")])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = s
        .import_relation(SEED, "links", vec![link_row("36", "7", "404", "x")])
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
}

#[test]
fn timeline_entries_keep_ids_and_dates() {
    let s = seeded_pages();
    let entry = row(&[
        ("id", "12"),
        ("page_id", "7"),
        ("date", "2026-05-06"),
        ("source", "meeting"),
        ("summary", "Raised a seed round"),
        ("detail", ""),
        ("event_page_id", "9"),
        ("created_at", "2026-05-06 10:00:00+00"),
        ("trust_tier", "unknown"),
    ]);
    let r = import(&s, "timeline_entries", vec![entry.clone()]);
    assert_eq!(r.imported, 1);
    assert!(r.unmapped_columns.is_empty());
    let got = s
        .get_timeline("people/alice-example", &TimelineOptions::default())
        .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], json!(12));
    assert_eq!(got[0]["summary"], json!("Raised a seed round"));
    assert!(
        s.read()
            .unwrap()
            .get(&keys::timeline(7, "2026-05-06", 12))
            .unwrap()
            .is_some()
    );
    assert_eq!(counter(&s, crate::timeline::NEXT_TIMELINE_ID), 13);
    assert_eq!(import(&s, "timeline_entries", vec![entry]).skipped, 1);
}

#[test]
fn aliases_are_copied_and_retries_skip() {
    let s = seeded_pages();
    let slug_alias = row(&[
        ("id", "1"),
        ("source_id", "default"),
        ("alias_slug", "people/alice"),
        ("canonical_slug", "people/alice-example"),
        ("notes", "renamed"),
    ]);
    let r = import(&s, "slug_aliases", vec![slug_alias.clone()]);
    assert_eq!(r.imported, 1);
    let found = s
        .resolve_slug_with_alias_detailed("people/alice", &["default".to_string()])
        .unwrap()
        .unwrap();
    assert_eq!(found.canonical_slug, "people/alice-example");
    assert_eq!(import(&s, "slug_aliases", vec![slug_alias]).skipped, 1);

    let page_alias = row(&[
        ("id", "1"),
        ("source_id", "default"),
        ("alias_norm", "alice"),
        ("slug", "people/alice-example"),
        ("origin", "frontmatter"),
        ("case_sensitive", "f"),
    ]);
    let r = import(&s, "page_aliases", vec![page_alias.clone()]);
    assert_eq!(r.imported, 1);
    assert_eq!(r.unmapped_columns, vec!["id"]);
    let resolved = s
        .resolve_aliases(&["alice".to_string()], &Default::default())
        .unwrap();
    assert_eq!(resolved[0].1[0].slug, "people/alice-example");
    assert_eq!(import(&s, "page_aliases", vec![page_alias]).skipped, 1);
}

#[test]
fn facts_keep_ids_tiers_and_embeddings() {
    let s = seeded_pages();
    let fact = row(&[
        ("id", "501"),
        ("source_id", "default"),
        ("entity_slug", "people/alice-example"),
        ("fact", "Alice founded acme"),
        ("kind", "fact"),
        ("visibility", "world"),
        ("notability", "high"),
        ("valid_from", "2026-01-01 00:00:00+00"),
        ("source", "meeting"),
        ("confidence", "0.9"),
        ("embedding", "[0.5,0.25]"),
        ("embedding_model", "openai:text-embedding-3-small"),
        ("embedded_text_hash", &md5_hex("Alice founded acme")),
        ("embedded_at", "2026-01-02 00:00:00+00"),
        ("created_at", "2026-01-01 12:00:00+00"),
        ("trust_tier", "user_confirmed"),
        ("write_origin", r#"{"kind": "mcp"}"#),
        ("write_request_id", "req-1"),
    ]);
    let r = import(&s, "facts", vec![fact.clone()]);
    assert_eq!(r.imported, 1);
    assert!(r.unmapped_columns.is_empty());
    let read = s.read().unwrap();
    let got = read_fact(&*read, 501).unwrap().unwrap();
    assert_eq!(got.receipt.write_request_id.as_deref(), Some("req-1"));
    assert_eq!(got.fact, "Alice founded acme");
    assert_eq!(got.visibility, "world");
    assert_eq!(got.valid_from_us, us("2026-01-01T00:00:00Z"));
    assert_eq!(got.created_at_us, us("2026-01-01T12:00:00Z"));
    assert_eq!(got.trust_tier, "user_confirmed");
    assert_eq!(got.write_origin, Some(json!({"kind": "mcp"})));
    assert_eq!(got.embedding, Some(vec![0.5, 0.25]));
    assert_eq!(got.embedded_text_hash, Some(md5_hex("Alice founded acme")));
    drop(read);
    assert_eq!(counter(&s, crate::facts::COUNTER), 502);
    let listed = s
        .list_facts_by_entity(&crate::facts::FactQuery {
            source_id: "default".into(),
            entity_slug: Some("people/alice-example".into()),
            limit: 10.0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(import(&s, "facts", vec![fact]).skipped, 1);
}

fn take_row(id: &str, row_num: &str, claim: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", "7"),
        ("row_num", row_num),
        ("claim", claim),
        ("kind", "bet"),
        ("holder", "people/alice-example"),
        ("weight", "0.8"),
        ("since_date", "2026-01"),
        ("active", "t"),
        ("created_at", "2026-01-05 00:00:00+00"),
        ("updated_at", "2026-01-06 00:00:00+00"),
        ("embedding_model", "openai:text-embedding-3-large"),
        ("embedded_at", "2026-01-07 00:00:00+00"),
    ])
}

#[test]
fn takes_keep_ids_rows_and_current_vectors() {
    let s = seeded_pages();
    let mut current = take_row("61", "1", "Widgets win");
    current.insert("embedding".into(), Some("[1,2]".into()));
    current.insert("embedded_text_hash".into(), Some(md5_hex("Widgets win")));
    let mut stale = take_row("62", "2", "Gadgets lose");
    stale.insert("embedding".into(), Some("[3,4]".into()));
    stale.insert("embedded_text_hash".into(), Some(md5_hex("an older claim")));
    let r = import(&s, "takes", vec![current.clone(), stale]);
    assert_eq!(r.imported, 2);
    assert_eq!(r.losses.get("take_vector_not_current"), Some(&1));
    let read = s.read().unwrap();
    let take = crate::takes::read_take(&*read, 61).unwrap().unwrap();
    assert_eq!(take.row_num, 1);
    assert_eq!(take.source_id, "default");
    assert_eq!(take.since_date.as_deref(), Some("2026-01"));
    assert_eq!(take.created_at_us, us("2026-01-05T00:00:00Z"));
    assert_eq!(take.updated_at_us, us("2026-01-06T00:00:00Z"));
    drop(read);
    assert_eq!(counter(&s, crate::takes::NEXT_TAKE_ID), 63);
    let vectors = s.get_take_embeddings(&[61, 62]).unwrap();
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0]["id"], json!(61));
    assert_eq!(import(&s, "takes", vec![current]).skipped, 1);
    let err = s
        .import_relation(SEED, "takes", vec![take_row("70", "1", "dup row")])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

/// The columns the store keeps since master added them: the sources' chunker version, a link's
/// assertion tense, the tier, origin and write receipt of timeline entries and takes, a page's
/// revision receipt and the columns of a derived page alias.
#[test]
fn the_columns_master_stores_are_kept_not_reported() {
    let s = store();
    let r = import(
        &s,
        "sources",
        vec![row(&[
            ("id", "wiki"),
            ("name", "Wiki"),
            ("config", "{}"),
            ("archived", "f"),
            ("incarnation", INCARNATION),
            ("created_at", "2025-12-31 23:59:59+00"),
            ("chunker_version", "3"),
        ])],
    );
    assert!(r.unmapped_columns.is_empty());
    let read = s.read().unwrap();
    let source = crate::sources::read_source(&*read, "wiki")
        .unwrap()
        .unwrap();
    assert_eq!(source.chunker_version.as_deref(), Some("3"));
    drop(read);

    let mut page = page_row("7", "people/alice-example");
    page.insert("revision_write_request_id".into(), Some(REV.into()));
    page.insert("revision_principal_kind".into(), Some("token".into()));
    page.insert("revision_principal_id".into(), Some("tok-1".into()));
    let r = import(
        &s,
        "pages",
        vec![page, page_row("9", "companies/acme-example")],
    );
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    let read = s.read().unwrap();
    let stored = crate::pages::read_page_by_id(&*read, 7).unwrap().unwrap();
    assert_eq!(stored.revision_receipt.request_id.as_deref(), Some(REV));
    assert_eq!(
        stored.revision_receipt.principal_kind.as_deref(),
        Some("token")
    );
    assert_eq!(
        stored.revision_receipt.principal_id.as_deref(),
        Some("tok-1")
    );
    drop(read);

    let mut link = link_row("21", "7", "9", "works_at");
    link.insert("assertion_tense".into(), Some("past".into()));
    let r = import(&s, "links", vec![link]);
    assert!(r.unmapped_columns.is_empty());
    let read = s.read().unwrap();
    let stored: LinkRecord = get_json(&*read, &keys::link(7, 21)).unwrap().unwrap();
    assert_eq!(stored.assertion_tense.as_deref(), Some("past"));
    drop(read);

    let receipt = [
        ("write_request_id", REV),
        ("write_principal_kind", "token"),
        ("write_principal_id", "tok-1"),
        ("last_write_request_id", OTHER_REV),
        ("last_write_principal_kind", "owner"),
        ("last_write_principal_id", "garry"),
        ("last_written_at", "2026-06-01 00:00:00+00"),
    ];
    let mut entry = row(&[
        ("id", "12"),
        ("page_id", "7"),
        ("date", "2026-05-06"),
        ("source", "meeting"),
        ("summary", "Raised a seed round"),
        ("detail", ""),
        ("created_at", "2026-05-06 10:00:00+00"),
        ("trust_tier", "user_confirmed"),
        ("write_origin", r#"{"kind": "cli"}"#),
    ]);
    entry.extend(row(&receipt));
    let r = import(&s, "timeline_entries", vec![entry]);
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    let read = s.read().unwrap();
    let stored = crate::timeline::read_entry(&*read, 7, "2026-05-06", 12)
        .unwrap()
        .unwrap();
    assert_eq!(stored.trust.trust_tier.as_deref(), Some("user_confirmed"));
    assert_eq!(stored.trust.write_origin, Some(json!({"kind": "cli"})));
    assert_eq!(stored.receipt.write_request_id.as_deref(), Some(REV));
    assert_eq!(
        stored.receipt.last_write_principal_id.as_deref(),
        Some("garry")
    );
    assert_eq!(
        stored.receipt.last_written_at_us,
        Some(us("2026-06-01T00:00:00Z"))
    );
    drop(read);

    let mut take = take_row("31", "1", "Alice ships");
    take.insert("trust_tier".into(), Some("user_confirmed".into()));
    take.extend(row(&receipt));
    let r = import(&s, "takes", vec![take]);
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    let read = s.read().unwrap();
    let stored = crate::takes::read_take(&*read, 31).unwrap().unwrap();
    assert_eq!(stored.trust.trust_tier.as_deref(), Some("user_confirmed"));
    assert_eq!(
        stored.receipt.write_principal_kind.as_deref(),
        Some("token")
    );
    drop(read);

    let derived = row(&[
        ("source_id", "default"),
        ("alias_norm", "alice"),
        ("slug", "people/alice-example"),
        ("origin", "declared"),
        ("case_sensitive", "t"),
        ("alias_text", "Alice"),
    ]);
    let r = import(&s, "page_aliases", vec![derived]);
    assert_eq!((r.imported, r.losses.len()), (1, 0));
    assert!(r.unmapped_columns.is_empty());
    let mut plain = row(&[
        ("source_id", "default"),
        ("alias_norm", "ally"),
        ("slug", "people/alice-example"),
        ("origin", "frontmatter"),
        ("case_sensitive", "t"),
    ]);
    plain.insert("alias_text".into(), None);
    let r = import(&s, "page_aliases", vec![plain]);
    assert_eq!(r.losses.get("frontmatter_alias_columns"), Some(&1));
}

#[test]
fn counters_never_go_down() {
    let s = seeded_pages();
    import(&s, "links", vec![link_row("40", "7", "9", "a")]);
    import(&s, "links", vec![link_row("5", "9", "7", "b")]);
    assert_eq!(counter(&s, crate::links::NEXT_LINK_ID), 41);
}

#[test]
fn decoders_read_postgres_text() {
    assert_eq!(timestamp_us("1970-01-01 00:00:01+00"), Some(1_000_000));
    assert_eq!(timestamp_us("1970-01-01 01:00:01+01"), Some(1_000_000));
    assert_eq!(
        timestamp_us("1970-01-01 00:00:01-00:30"),
        Some(1_801_000_000)
    );
    assert_eq!(timestamp_us("1970-01-01T00:00:01.5Z"), Some(1_500_000));
    assert_eq!(timestamp_us("1970-01-01 00:00:01"), None);
    assert_eq!(timestamp_us("infinity"), None);
    let r = SeedRow::from([
        (
            "a".to_string(),
            Some(r#"{x,"y,z","q\"r",NULLX}"#.to_string()),
        ),
        ("b".to_string(), Some("[1.5, -2,3e-1]".to_string())),
        ("c".to_string(), Some("{}".to_string())),
        ("d".to_string(), Some("{a,NULL}".to_string())),
        ("e".to_string(), Some("2026-02-30".to_string())),
    ]);
    let row = Row {
        relation: "t",
        row: &r,
    };
    assert_eq!(
        row.text_array("a").unwrap().unwrap(),
        vec!["x", "y,z", "q\"r", "NULLX"]
    );
    assert_eq!(row.vector("b").unwrap().unwrap(), vec![1.5, -2.0, 0.3]);
    assert_eq!(row.text_array("c").unwrap().unwrap(), Vec::<String>::new());
    assert!(row.text_array("d").is_err());
    assert!(row.date("e").is_err());
    assert_eq!(row.text_array("missing").unwrap(), None);
}

/// A page whose text projection is behind its knowledge revision, so both engines queue a
/// projection job for it.
fn behind_page_row(id: &str, slug: &str) -> SeedRow {
    let mut p = page_row(id, slug);
    p.insert("text_projection_revision".into(), None);
    p
}

fn job(s: &Store, slug: &str) -> crate::persistence::JobRecord {
    let read = s.read().unwrap();
    crate::persistence::read_page_job(&*read, "default", slug)
        .unwrap()
        .expect("a projection job")
}

#[test]
fn pages_keep_the_primary_projection_job() {
    let s = store();
    let mut p = behind_page_row("5", "notes/behind");
    p.insert("projection_job_revision".into(), Some(REV.into()));
    p.insert(
        "projection_job_reason".into(),
        Some("rebuild_failed".into()),
    );
    p.insert(
        "projection_job_updated_at".into(),
        Some("2026-04-05 06:07:08.25+00".into()),
    );
    let r = import(&s, "pages", vec![p]);
    assert_eq!(r.imported, 1);
    assert!(r.losses.is_empty(), "{:?}", r.losses);
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    let j = job(&s, "notes/behind");
    // The primary's time, revision and reason, not the seed transaction's.
    assert_eq!(j.updated_at_us, us("2026-04-05T06:07:08.25Z"));
    assert_eq!(j.revision, REV);
    assert_eq!(j.reason, "rebuild_failed");
}

#[test]
fn a_projection_job_without_a_primary_time_keeps_the_seed_time_and_is_a_loss() {
    let s = store();
    // No job columns at all: the store queues its own job at the seed time.
    let r = import(&s, "pages", vec![behind_page_row("5", "notes/a")]);
    assert_eq!(r.losses.get("projection_job_seed_time"), Some(&1));
    assert!(job(&s, "notes/a").updated_at_us > 0);
    // A job row with no time: the primary's revision and reason, the seed's time.
    let mut p = behind_page_row("6", "notes/b");
    p.insert("projection_job_revision".into(), Some(REV.into()));
    p.insert(
        "projection_job_reason".into(),
        Some("rebuild_failed".into()),
    );
    let r = import(&s, "pages", vec![p]);
    assert_eq!(r.losses.get("projection_job_seed_time"), Some(&1));
    let j = job(&s, "notes/b");
    assert!(j.updated_at_us > 0);
    assert_eq!(j.reason, "rebuild_failed");
    // A projected page has no job, so nothing is lost.
    let r = import(&s, "pages", vec![page_row("8", "notes/c")]);
    assert!(r.losses.is_empty(), "{:?}", r.losses);
}

#[test]
fn the_plan_lists_every_relation_once_in_import_order() {
    let plan = plan();
    let names: Vec<_> = plan.relations.iter().map(|p| p.relation).collect();
    assert_eq!(&names[..3], ["sources", "config", "pages"]);
    let unique: BTreeSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
    assert!(plan.relations.iter().all(|p| !p.key.is_empty()));
    for name in &names {
        assert!(relation_spec(name).is_ok());
    }
    for (table, relation) in &plan.carried {
        assert!(names.contains(relation), "{table} rides in {relation}");
        assert!(!names.contains(table));
    }
}

/// The tables the seed leaves behind on purpose. A change to this list changes what a swap to a
/// seeded store may lose: edit the pin only together with rust/docs/store/seed.md.
#[test]
fn the_not_copied_list_is_pinned_sorted_and_disjoint_from_the_relations() {
    let tables: Vec<_> = NOT_COPIED.iter().map(|n| n.table).collect();
    let mut sorted = tables.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(tables, sorted, "sorted, no duplicates");
    assert_eq!(
        tables,
        [
            "chat_usage_log",
            "code_traversal_cache",
            "conversation_parser_llm_cache",
            "dream_verdicts",
            "engine_writer_coverage_gaps",
            "engine_writer_observations",
            "engine_writer_sessions",
            "eval_candidates",
            "eval_capture_failures",
            "eval_contradictions_cache",
            "eval_contradictions_runs",
            "eval_takes_quality_runs",
            "extract_atoms_page_state",
            "extract_atoms_transcript_state",
            "extract_rollup_7d",
            "file_migration_ledger",
            "gbrain_cycle_locks",
            "ingest_log",
            "mcp_request_log",
            "mention_gazetteer_entries",
            "mention_index_status",
            "migration_impact_log",
            "minion_attachments",
            "minion_budget_log",
            "minion_inbox",
            "minion_jobs",
            "minion_lease_pressure_log",
            "minion_self_fix_log",
            "op_checkpoint_paths",
            "op_checkpoints",
            "page_body_manifest",
            "page_body_staging_parts",
            "page_body_staging_texts",
            "page_body_stagings",
            "page_generation_clock",
            "page_mention_state",
            "page_retrievals",
            "page_segment_derivation_purge_pages",
            "page_segment_derivation_purges",
            "page_segment_derivations",
            "page_segment_texts",
            "page_view_digests",
            "page_write_guards",
            "persistence_brain",
            "persistence_consumers",
            "persistence_counters",
            "persistence_effects",
            "persistence_graduation",
            "persistence_host_bindings",
            "persistence_local_writers",
            "persistence_requests",
            "persistence_source_bindings",
            "persistence_topology_changes",
            "persistence_worktree_refreshes",
            "persistence_worktrees",
            "persistence_writer_protocols",
            "planner_stats_deltas",
            "planner_stats_state",
            "query_cache",
            "reason_purge_tombstones",
            "retrieval_event_links",
            "retrieval_event_pages",
            "retrieval_events",
            "search_telemetry",
            "session_context_state",
            "subagent_messages",
            "subagent_rate_leases",
            "subagent_tool_executions",
            "sync_notifier_leases",
            "sync_notifier_sources",
            "sync_wanted_markers",
            "take_grade_cache",
            "take_nudge_log",
            "think_ab_results",
            "trust_policy_state",
            "wake_subscriptions",
            "write_gate_holds",
            "write_gate_receipts",
        ]
    );
    let plan = plan();
    for n in NOT_COPIED {
        assert!(!n.read.is_empty());
        assert!(
            relation_spec(n.table).is_err(),
            "{} is both copied and not",
            n.table
        );
        assert!(plan.carried.iter().all(|(t, _)| *t != n.table));
    }
}

/// `page_write_guards` rows exist only to be locked (`src/core/page-state/guards.ts`: insert, then `SELECT ... FOR UPDATE`), so
/// the table is left behind as a lock anchor and holds no gap rows: the store holds the same lock on the page key.
#[test]
fn page_write_guards_are_a_lock_anchor_with_no_gap_rows() {
    let entry = NOT_COPIED
        .iter()
        .find(|n| n.table == "page_write_guards")
        .unwrap();
    assert_eq!(entry.kind, LossKind::LockAnchor);
    assert_eq!(entry.gap_rows, None);
    assert!(entry.read.starts_with("none:"), "{}", entry.read);
    assert_eq!(serde_json::to_value(entry.kind).unwrap(), "lock_anchor");
}

/// `op_checkpoints` rows of the sync identity downgrade op are brain state, not machine state: the
/// purge of deleted pages holds the old page of such a record, and the rename repair reads them. The seed does not
/// copy them yet, so they are counted as gap rows (`sync_identity_downgrades`) and block a swap.
/// Every other op's rows stay a machine-local loss.
#[test]
fn identity_downgrade_checkpoints_are_gap_rows_inside_a_not_copied_table() {
    let entry = NOT_COPIED
        .iter()
        .find(|n| n.table == "op_checkpoints")
        .unwrap();
    assert_eq!(entry.kind, LossKind::MachineLocal);
    assert_eq!(
        entry.gap_rows,
        Some(GapRows {
            gap: "sync_identity_downgrades",
            column: "op",
            equals: "sync-identity-downgrade",
        })
    );
    let with_gap_rows: Vec<_> = NOT_COPIED
        .iter()
        .filter(|n| n.gap_rows.is_some())
        .map(|n| n.table)
        .collect();
    assert_eq!(with_gap_rows, ["op_checkpoints"]);
}

/// The columns a copied row may hold that the store cannot keep yet: counted as gaps, never
/// dropped quietly. Edit the pin only together with rust/docs/store/seed.md.
#[test]
fn the_gap_columns_are_pinned_and_belong_to_copied_relations() {
    let pinned: Vec<_> = super::GAP_COLUMNS
        .iter()
        .map(|g| (g.table, g.column, g.gap))
        .collect();
    assert_eq!(
        pinned,
        [
            (
                "page_versions",
                "frontmatter_raw",
                "page_versions.frontmatter_raw"
            ),
            ("pages", "frontmatter_raw", "pages.frontmatter_raw"),
        ]
    );
    let plan = super::plan();
    for g in super::GAP_COLUMNS {
        let rel = plan.relations.iter().find(|r| r.relation == g.table);
        assert!(rel.is_some(), "{} is a copied relation", g.table);
        let spec = super::relation_spec(g.table).unwrap();
        assert!(
            !spec.columns.iter().any(|(c, _)| *c == g.column),
            "{}.{} is not a column the relation keeps",
            g.table,
            g.column
        );
    }
}
