//! The visibility filters of the keyword members: `excludePrivate` (the page policy), the
//! safe-chunk fence, the trust floor (`minTrust`) and the flagged-page filter (`suppressFlagged`), as
//! `buildVisibilityClause` (src/core/search/sql-ranking.ts) adds them.

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::keyword::{KeywordOptions, TitleAttempt};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::trust::write_gate::ReceiptFields;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    store: Store,
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain { _dir: dir, store }
    }

    /// Writes the page, then seals one compiled-truth chunk holding its body.
    fn page(&self, slug: &str, title: &str, body: &str, frontmatter: Value) {
        write(&self.store, slug, title, body, frontmatter);
    }

    /// [`Brain::page`] in a transaction that declares `tier` as the writer's trust tier.
    fn page_at(&self, tier: &str, slug: &str, body: &str) {
        let tx = self.store.begin_transaction(false).unwrap();
        let names = ["gbrain.write_trust_tier", "gbrain.write_origin"].map(String::from);
        tx.apply_write_trust(
            &names,
            &[tier.to_string(), r#"{"channel":"test"}"#.to_string()],
        )
        .unwrap();
        write(&tx, slug, &format!("Nimbus {slug}"), body, json!({}));
        tx.commit_transaction().unwrap();
    }

    /// A `flag` write-gate receipt on the page, in `families`.
    fn flag(&self, slug: &str, families: &[&str]) {
        let families: Vec<String> = families.iter().map(|f| f.to_string()).collect();
        let fields = ReceiptFields {
            content_hash: "h1".into(),
            tier: "agent_written".into(),
            detector_version: 1,
            verdict: "flag".into(),
            reason_families: families.clone(),
            reasons: families,
            detector_error: false,
            request_id: None,
        };
        assert!(
            self.store
                .upsert_page_write_gate_receipt("default", slug, fields)
                .unwrap()
                .is_some()
        );
    }
}

fn write(store: &Store, slug: &str, title: &str, body: &str, frontmatter: Value) {
    {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": title, "compiled_truth": body, "frontmatter": frontmatter,
        }))
        .unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
        store.put_page(slug, &input, &options).unwrap();
        let chunk: ChunkInput = serde_json::from_value(json!({
            "chunk_index": 0, "chunk_text": body, "chunk_source": "compiled_truth",
        }))
        .unwrap();
        let options = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks(slug, &[chunk], &options).unwrap();
    }
}

fn scope(policy: Option<PrivacyPolicy>, safe: bool) -> KeywordOptions {
    KeywordOptions {
        exclude_private: policy,
        require_safe_chunks: safe,
        ..KeywordOptions::default()
    }
}

fn slugs(rows: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = rows
        .iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect();
    out.sort();
    out
}

#[test]
fn keyword_reads_hide_private_pages_and_pages_short_of_the_safe_fence() {
    let b = Brain::new("keyword-visibility");
    b.page("notes/open", "Zephyr open", "zephyr open", json!({}));
    b.page(
        "notes/private",
        "Zephyr private",
        "zephyr private",
        json!({"visibility": "private"}),
    );
    b.page(
        "notes/readers",
        "Zephyr readers",
        "zephyr readers",
        json!({"readable_by": ["alice-example"]}),
    );
    b.page(
        "notes/alias",
        "Zephyr alias",
        "zephyr alias",
        json!({"access": "restricted"}),
    );
    b.page("notes/unsafe", "Zephyr unsafe", "zephyr unsafe", json!({}));
    // Sealed text, but a chunker version short of the safe fence.
    b.store
        .set_chunker_version("notes/unsafe", "3", Some("default"))
        .unwrap();
    let honored = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let visibility_only = PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
        ..Default::default()
    };

    let count = |o: &KeywordOptions| b.store.count_keyword_pages("zephyr", o).unwrap();
    assert_eq!(count(&scope(None, false)), 5);
    assert_eq!(count(&scope(Some(honored.clone()), true)), 1);
    assert_eq!(count(&scope(Some(honored.clone()), false)), 2);
    assert_eq!(count(&scope(Some(visibility_only.clone()), true)), 2);
    assert_eq!(count(&scope(None, true)), 4);

    let chunks = |o: &KeywordOptions| slugs(&b.store.search_keyword_chunks("zephyr", o).unwrap());
    assert_eq!(chunks(&scope(Some(honored.clone()), true)), ["notes/open"]);
    assert_eq!(
        chunks(&scope(Some(visibility_only.clone()), true)),
        ["notes/alias", "notes/open"]
    );
    assert!(!chunks(&scope(None, true)).contains(&"notes/unsafe".to_string()));

    let arm =
        |o: &KeywordOptions| slugs(&b.store.search_keyword_arm("zephyr", "zephyr", o).unwrap());
    assert_eq!(
        arm(&scope(Some(honored.clone()), false)),
        ["notes/open", "notes/unsafe"]
    );

    let attempt: TitleAttempt = serde_json::from_value(
        json!({"texts": ["zephyr"], "kind": "title", "limit": 20, "offset": 0}),
    )
    .unwrap();
    let titles = |o: &KeywordOptions| {
        let lists = b
            .store
            .search_titles_attempts(std::slice::from_ref(&attempt), "zephyr", 100.0, o)
            .unwrap();
        slugs(lists[0]["rows"].as_array().unwrap())
    };
    assert_eq!(titles(&scope(None, false)).len(), 5);
    assert_eq!(titles(&scope(Some(honored.clone()), true)), ["notes/open"]);
}

#[test]
fn keyword_reads_drop_pages_below_the_trust_floor_and_flagged_pages() {
    let b = Brain::new("keyword-trust");
    b.page_at("operator_curated", "notes/curated", "nimbus curated");
    b.page_at(
        "operator_curated",
        "notes/curated-flagged",
        "nimbus curated flagged",
    );
    b.flag("notes/curated-flagged", &["override"]);
    b.page_at("agent_written", "notes/agent", "nimbus agent");
    b.page_at(
        "agent_written",
        "notes/agent-flagged",
        "nimbus agent flagged",
    );
    b.flag("notes/agent-flagged", &["exfiltration"]);
    b.page_at("agent_written", "notes/agent-other", "nimbus agent other");
    b.flag("notes/agent-other", &["other"]);
    b.page(
        "notes/unknown",
        "Nimbus unknown",
        "nimbus unknown",
        json!({}),
    );
    b.flag("notes/unknown", &["credential"]);
    b.page_at("external_untrusted", "notes/outside", "nimbus outside");

    let trust = |floor: Option<&str>, suppress: bool| KeywordOptions {
        min_trust: floor.map(String::from),
        suppress_flagged: suppress,
        ..KeywordOptions::default()
    };
    let count = |o: &KeywordOptions| b.store.count_keyword_pages("nimbus", o).unwrap();
    assert_eq!(count(&trust(None, false)), 7);
    assert_eq!(count(&trust(Some(""), false)), 7);
    assert_eq!(count(&trust(Some("external_untrusted"), false)), 7);
    assert_eq!(count(&trust(Some("operator_curated"), false)), 2);
    // The unknown and outside pages rank below agent_written.
    assert_eq!(count(&trust(Some("agent_written"), false)), 5);
    // The flags in an activation family on a page at or below agent_written: agent-flagged, unknown.
    assert_eq!(count(&trust(None, true)), 5);
    assert_eq!(count(&trust(Some("agent_written"), true)), 4);
    assert!(
        b.store
            .count_keyword_pages("nimbus", &trust(Some("nobody"), false))
            .is_err()
    );

    let chunks = |o: &KeywordOptions| slugs(&b.store.search_keyword_chunks("nimbus", o).unwrap());
    assert_eq!(
        chunks(&trust(None, true)),
        [
            "notes/agent",
            "notes/agent-other",
            "notes/curated",
            "notes/curated-flagged",
            "notes/outside"
        ]
    );
    let arm =
        |o: &KeywordOptions| slugs(&b.store.search_keyword_arm("nimbus", "nimbus", o).unwrap());
    assert_eq!(
        arm(&trust(Some("operator_curated"), false)),
        ["notes/curated", "notes/curated-flagged"]
    );
    let attempt: TitleAttempt = serde_json::from_value(
        json!({"texts": ["nimbus"], "kind": "whole", "limit": 20, "offset": 0}),
    )
    .unwrap();
    let titles = |o: &KeywordOptions| {
        let lists = b
            .store
            .search_titles_attempts(std::slice::from_ref(&attempt), "nimbus", 100.0, o)
            .unwrap();
        slugs(lists[0]["rows"].as_array().unwrap())
    };
    assert_eq!(titles(&trust(Some("agent_written"), true)).len(), 4);
}
