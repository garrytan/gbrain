//! The visibility filters of the keyword members: `excludePrivate` (the page policy) and the
//! safe-chunk fence, as `buildVisibilityClause` (src/core/search/sql-ranking.ts) adds them.

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::keyword::{KeywordOptions, TitleAttempt};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
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
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": title, "compiled_truth": body, "frontmatter": frontmatter,
        }))
        .unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
        self.store.put_page(slug, &input, &options).unwrap();
        let chunk: ChunkInput = serde_json::from_value(json!({
            "chunk_index": 0, "chunk_text": body, "chunk_source": "compiled_truth",
        }))
        .unwrap();
        let options = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        self.store.upsert_chunks(slug, &[chunk], &options).unwrap();
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
    };
    let visibility_only = PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
    };

    let count = |o: &KeywordOptions| b.store.count_keyword_pages("zephyr", o).unwrap();
    assert_eq!(count(&scope(None, false)), 5);
    assert_eq!(count(&scope(Some(honored), true)), 1);
    assert_eq!(count(&scope(Some(honored), false)), 2);
    assert_eq!(count(&scope(Some(visibility_only), true)), 2);
    assert_eq!(count(&scope(None, true)), 4);

    let chunks = |o: &KeywordOptions| slugs(&b.store.search_keyword_chunks("zephyr", o).unwrap());
    assert_eq!(chunks(&scope(Some(honored), true)), ["notes/open"]);
    assert_eq!(
        chunks(&scope(Some(visibility_only), true)),
        ["notes/alias", "notes/open"]
    );
    assert!(!chunks(&scope(None, true)).contains(&"notes/unsafe".to_string()));

    let arm =
        |o: &KeywordOptions| slugs(&b.store.search_keyword_arm("zephyr", "zephyr", o).unwrap());
    assert_eq!(
        arm(&scope(Some(honored), false)),
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
    assert_eq!(titles(&scope(Some(honored), true)), ["notes/open"]);
}
