//! `owner_only_marks` (migration v322, GST-3032): the rows a hard delete leaves owner-only. A page of an owner-only source,
//! and a concept or question synthesized from one, reads as owner-only through live rows (`facts/privacy.rs`). When that
//! page is deleted for good its `concept-provenance` link goes with it, so the concept would read as open; SQL's BEFORE
//! DELETE trigger on `pages` (`gbrain_owner_only_row_deleted`, src/core/access/owner-only-marks.ts) marks the page and every
//! concept or question that names it first, and `gbrain_owner_only_lineage_strict` reads those marks. This is that record.
//!
//! Keys: `M owner_only_mark/<table>/<row id>` -> `1` (`pages`, `facts`, `takes`, `timeline_entries`). Row ids are never
//! reused, so a mark never names another row. The
//! trigger's guard (a brain that never held owner-only data stores nothing) is kept: `mark_before_delete` returns before it
//! reads a link when no source is owner-only and no mark exists, and a read that finds neither takes the unmarked path.
//!
//! A page delete marks, as `gbrain_owner_only_mark_derived` does, the page, its takes and timeline rows, every row derived
//! from those through `derivation_inputs` (transitively, `derivation_inputs.rs`), and every concept or question that names
//! the page. What SQL marks on a fact, take or timeline delete, and the row-security and unguarded marks, stay unmarked:
//! the store runs no trigger on those deletes. Nothing here marks on a link delete or a source config
//! change, because SQL has no trigger on `links` and its sources trigger marks only a source that is deleted. The Rust engine
//! serves no source delete (`cascade.rs`): core removes each page of the source through `pages::remove_page` first, and the
//! source is still owner-only then, so each page goes through `mark_before_delete`.

use crate::Result;
use crate::derivation_inputs::{EdgeRef, derived_closure};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::in_links;
use crate::owner_only::OwnerOnlySources;
use crate::pages::{PageRecord, read_page_by_id};

const MARK: &str = "owner_only_mark";

/// The timeline rows of page `page_id`, or of every page when `None`, in key order.
pub(crate) fn timeline_rows(
    read: &dyn KvRead,
    page_id: Option<u64>,
) -> Result<Vec<crate::timeline::TimelineRecord>> {
    let prefix = match page_id {
        Some(id) => keys::timeline_prefix(id),
        None => vec![keys::TIMELINE],
    };
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &prefix,
        false,
        &mut |_, v| match serde_json::from_slice(v) {
            Ok(entry) => {
                out.push(entry);
                true
            }
            Err(e) => {
                bad = Some(crate::error::StoreError::from(e));
                false
            }
        },
    )?;
    bad.map_or(Ok(out), Err)
}

fn mark_key(table: &str, id: &str) -> Vec<u8> {
    keys::meta(&format!("{MARK}/{table}/{id}"))
}

/// Whether any row was ever marked: once one was, the guard stays on for good (the SQL held flag).
pub(crate) fn any_marked(read: &dyn KvRead) -> Result<bool> {
    let mut found = false;
    scan_prefix(
        read,
        &keys::meta(&format!("{MARK}/")),
        false,
        &mut |_, _| {
            found = true;
            false
        },
    )?;
    Ok(found)
}

/// `owner_only_marks` holds `('pages', page_id)`.
pub(crate) fn is_marked(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    is_row_marked(read, "pages", &page_id.to_string())
}

/// `owner_only_marks` holds `(table, id)`.
pub(crate) fn is_row_marked(read: &dyn KvRead, table: &str, id: &str) -> Result<bool> {
    Ok(read.get(&mark_key(table, id))?.is_some())
}

/// Marks what the delete of `page` would leave unmarked, before it goes (`gbrain_owner_only_row_deleted`): when the page is
/// owner-only by its own lineage, the page itself and every concept or question with a `concept-provenance`
/// `synthesized_from` link to it (`gbrain_owner_only_mark_derived`). Call it before the page's links are deleted.
pub(crate) fn mark_before_delete(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let sources = OwnerOnlySources::read(&*tx)?;
    if !sources.guarded() || !sources.lineage_strict(&*tx, page)? {
        return Ok(());
    }
    // `seed`: the page, its takes and its timeline rows; `down`: what the edges derive from them; `concepts`.
    let mut seed = vec![EdgeRef {
        table: "pages".into(),
        id: page.id.to_string(),
    }];
    for take in crate::takes::page_takes(&*tx, page.id)? {
        seed.push(EdgeRef {
            table: "takes".into(),
            id: take.id.to_string(),
        });
    }
    for entry in timeline_rows(&*tx, Some(page.id))? {
        seed.push(EdgeRef {
            table: "timeline_entries".into(),
            id: entry.id.to_string(),
        });
    }
    let mut doomed = seed.clone();
    doomed.extend(derived_closure(&*tx, &seed)?);
    for link in in_links(&*tx, page.id)? {
        if link.link_source.as_deref() == Some("concept-provenance")
            && link.link_type == "synthesized_from"
            && let Some(from) = read_page_by_id(&*tx, link.from_page_id)?
            && matches!(from.page_type.as_str(), "concept" | "question")
        {
            doomed.push(EdgeRef {
                table: "pages".into(),
                id: from.id.to_string(),
            });
        }
    }
    for row in doomed {
        tx.put(&mark_key(&row.table, &row.id), b"1")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::links::AddLinkOptions;
    use crate::pages::{PageInput, PutPageOptions, read_page};
    use crate::sources::SourceInput;
    use serde_json::{Value, json};

    fn put(store: &crate::Store, source: &str, slug: &str, page_type: &str, frontmatter: Value) {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": "heron", "timeline": "",
            "frontmatter": frontmatter,
        }))
        .unwrap();
        let options = PutPageOptions {
            source_id: Some(source.into()),
            ..Default::default()
        };
        store.put_page(slug, &input, &options).unwrap();
    }

    fn link(store: &crate::Store, from: &str, to: &str, to_source: &str) {
        let options = AddLinkOptions {
            link_type: Some("synthesized_from".into()),
            link_source: Some("concept-provenance".into()),
            to_source_id: Some(to_source.into()),
            ..Default::default()
        };
        store.add_link(from, to, &options).unwrap();
    }

    fn marked(store: &crate::Store, source: &str, slug: &str) -> bool {
        let read = store.read().unwrap();
        let page = read_page(&*read, source, slug).unwrap().unwrap();
        is_marked(&*read, page.id).unwrap()
    }

    /// A hard delete of an owner-only page marks the page and the concepts that name it, and only those; a brain that holds
    /// no owner-only source stores no mark at all.
    #[test]
    fn deleting_an_owner_only_page_marks_the_concepts_derived_from_it() {
        let store = crate::test_support::store();
        let derived = json!({ "synthesized_by": "dream", "visibility": "world" });
        put(&store, "default", "notes/open", "note", json!({}));
        put(
            &store,
            "default",
            "concepts/from-open",
            "concept",
            derived.clone(),
        );
        link(&store, "concepts/from-open", "notes/open", "default");
        // No owner-only source yet: deleting stores nothing and the guard stays off.
        store.delete_page("notes/open", None).unwrap();
        assert!(!any_marked(&*store.read().unwrap()).unwrap());

        let source: SourceInput =
            serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } }))
                .unwrap();
        store.upsert_source(&source).unwrap();
        put(&store, "vault", "notes/vault", "note", json!({}));
        put(&store, "default", "notes/open2", "note", json!({}));
        put(
            &store,
            "default",
            "concepts/from-vault",
            "concept",
            derived.clone(),
        );
        put(&store, "default", "concepts/from-open2", "concept", derived);
        link(&store, "concepts/from-vault", "notes/vault", "vault");
        link(&store, "concepts/from-open2", "notes/open2", "default");

        store.delete_page("notes/open2", None).unwrap();
        assert!(!any_marked(&*store.read().unwrap()).unwrap());
        store.delete_page("notes/vault", Some("vault")).unwrap();
        assert!(any_marked(&*store.read().unwrap()).unwrap());
        assert!(marked(&store, "default", "concepts/from-vault"));
        assert!(!marked(&store, "default", "concepts/from-open2"));
        // The marked concept deleted in turn marks what names it (a concept built on a concept).
        put(
            &store,
            "default",
            "concepts/on-concept",
            "concept",
            json!({ "synthesized_by": "dream" }),
        );
        link(
            &store,
            "concepts/on-concept",
            "concepts/from-vault",
            "default",
        );
        store.delete_page("concepts/from-vault", None).unwrap();
        assert!(marked(&store, "default", "concepts/on-concept"));
    }
    /// A hard delete of an owner-only page also marks every row derived from it through `derivation_inputs`,
    /// transitively, so the derived page stays owner-only after its input is gone.
    #[test]
    fn deleting_an_owner_only_page_marks_the_rows_derived_from_it() {
        let store = crate::test_support::store();
        let source: SourceInput =
            serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } }))
                .unwrap();
        store.upsert_source(&source).unwrap();
        put(&store, "vault", "notes/vault", "note", json!({}));
        put(&store, "default", "atoms/one", "atom", json!({}));
        put(&store, "default", "notes/summary", "note", json!({}));
        let id = |source: &str, slug: &str| {
            read_page(&*store.read().unwrap(), source, slug)
                .unwrap()
                .unwrap()
                .id
                .to_string()
        };
        let edge = |derived: String, input: String| {
            let spec: crate::derivation_inputs::DerivationEdges = serde_json::from_value(json!({
                "derived": { "table": "pages", "id": derived }, "sourceId": "default",
                "edges": [{ "table": "pages", "id": input }],
            }))
            .unwrap();
            store.record_derivation_edges(&spec).unwrap();
        };
        edge(id("default", "atoms/one"), id("vault", "notes/vault"));
        edge(id("default", "notes/summary"), id("default", "atoms/one"));
        assert!(!marked(&store, "default", "notes/summary"));
        store.delete_page("notes/vault", Some("vault")).unwrap();
        assert!(marked(&store, "default", "atoms/one"));
        assert!(marked(&store, "default", "notes/summary"));
    }
}
