//! The synopsis tier's configuration read (synopsis_tier.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::synopsis_tier::SynopsisTierQuery;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn read(store: &Store, skip: bool) -> Value {
    store
        .read_synopsis_tier_sources(&SynopsisTierQuery {
            skip_frontmatter: skip,
        })
        .unwrap()
}

const SYNOPSIS: &str = "per_chunk_synopsis";

#[test]
fn only_a_live_host_page_with_the_synopsis_frontmatter_picks_the_tier() {
    let dir = TempDir::new("synopsis-tier");
    let store = open(&dir);
    let none = json!({ "sourceIds": [], "frontmatterPicks": false });
    assert_eq!(read(&store, false), none);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            name: Some("work".into()),
            ..SourceInput::default()
        })
        .unwrap();
    put(
        &store,
        "work",
        "notes/elsewhere",
        json!({ "contextual_retrieval": SYNOPSIS }),
    );
    put(
        &store,
        "default",
        "notes/titled",
        json!({ "contextual_retrieval": "title" }),
    );
    put(
        &store,
        "default",
        "notes/nested",
        json!({ "meta": { "contextual_retrieval": SYNOPSIS } }),
    );
    put(
        &store,
        "default",
        "notes/gone",
        json!({ "contextual_retrieval": SYNOPSIS }),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    assert_eq!(read(&store, false), none);
    put(
        &store,
        "default",
        "notes/picked",
        json!({ "contextual_retrieval": SYNOPSIS }),
    );
    assert_eq!(
        read(&store, false),
        json!({ "sourceIds": [], "frontmatterPicks": true })
    );
    assert_eq!(read(&store, true), none);
}
