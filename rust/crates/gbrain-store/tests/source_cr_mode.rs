//! A source's own contextual-retrieval mode (source_cr_mode.rs) and the synopsis tier's read of it.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::sources::SourceInput;
use gbrain_store::synopsis_tier::SynopsisTierQuery;
use serde_json::json;

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..SourceInput::default()
        })
        .unwrap();
}

fn tier(store: &Store) -> serde_json::Value {
    store
        .read_synopsis_tier_sources(&SynopsisTierQuery {
            skip_frontmatter: true,
        })
        .unwrap()["sourceIds"]
        .clone()
}

const SYNOPSIS: &str = "per_chunk_synopsis";

#[test]
fn a_set_mode_reads_back_until_it_is_cleared() {
    let dir = TempDir::new("source-cr-mode");
    let store = open(&dir);
    assert!(
        !store
            .set_source_contextual_mode("no-such-source", Some("title"))
            .unwrap()
    );
    assert_eq!(
        store.source_contextual_mode("no-such-source").unwrap(),
        None
    );
    source(&store, "work");
    assert_eq!(store.source_contextual_mode("work").unwrap(), None);
    assert!(
        store
            .set_source_contextual_mode("work", Some("title"))
            .unwrap()
    );
    assert_eq!(
        store.source_contextual_mode("work").unwrap().as_deref(),
        Some("title")
    );
    assert!(store.set_source_contextual_mode("work", None).unwrap());
    assert_eq!(store.source_contextual_mode("work").unwrap(), None);
    // Clearing a source with no mode still answers that the source exists.
    assert!(store.set_source_contextual_mode("work", None).unwrap());
}

#[test]
fn the_synopsis_tier_lists_live_synopsis_sources_in_byte_order() {
    let dir = TempDir::new("source-cr-mode-tier");
    let store = open(&dir);
    assert_eq!(tier(&store), json!([]));
    for id in ["coop", "cob", "co-op", "old", "plain"] {
        source(&store, id);
    }
    for id in ["coop", "cob", "co-op", "old"] {
        assert!(
            store
                .set_source_contextual_mode(id, Some(SYNOPSIS))
                .unwrap()
        );
    }
    assert!(
        store
            .set_source_contextual_mode("plain", Some("title"))
            .unwrap()
    );
    assert!(store.set_source_archived("old", true).unwrap());
    assert_eq!(tier(&store), json!(["co-op", "cob", "coop"]));
    // An archived source keeps its mode; only the tier skips it.
    assert_eq!(
        store.source_contextual_mode("old").unwrap().as_deref(),
        Some(SYNOPSIS)
    );
    assert!(store.set_source_contextual_mode("cob", None).unwrap());
    assert_eq!(tier(&store), json!(["co-op", "coop"]));
}
