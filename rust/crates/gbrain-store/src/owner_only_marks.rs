//! `owner_only_marks` (migration v322, GST-3032): the rows a hard delete leaves owner-only. A page of an owner-only source,
//! and a concept or question synthesized from one, reads as owner-only through live rows (`facts/privacy.rs`). When that
//! page is deleted for good its `concept-provenance` link goes with it, so the concept would read as open; SQL's BEFORE
//! DELETE trigger on `pages` (`gbrain_owner_only_row_deleted`, src/core/access/owner-only-marks.ts) marks the page and every
//! concept or question that names it first, and `gbrain_owner_only_lineage_strict` reads those marks. This is that record.
//!
//! Keys: `M owner_only_mark/pages/<page id>` -> `1`. Page ids are never reused, so a mark never names another row. The
//! trigger's guard (a brain that never held owner-only data stores nothing) is kept: `mark_before_delete` returns before it
//! reads a link when no source is owner-only and no mark exists, and a read that finds neither takes the unmarked path.
//!
//! What SQL marks that this store has no table for stays unmarked: `derivation_inputs` descendants, takes and timeline rows
//! of the page, facts, and the row-security and unguarded marks. Nothing here marks on a link delete or a source config
//! change, because SQL has no trigger on `links` and its sources trigger marks only a source that is deleted. The source
//! delete (`sources::archive`) removes each page of the source through `pages::remove_page` first, and the
//! source is still owner-only then, so each page goes through `mark_before_delete`.

use serde::Serialize;

use crate::Result;
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::in_links;
use crate::owner_only::OwnerOnlySources;
use crate::pages::{PageRecord, read_page_by_id};

const MARK: &str = "owner_only_mark";

fn mark_key(page_id: u64) -> Vec<u8> {
    keys::meta(&format!("{MARK}/pages/{page_id}"))
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
    Ok(read.get(&mark_key(page_id))?.is_some())
}

/// The shadow seed (`seed.rs`): stores the mark of page `page_id` as another engine holds it. `false` when the page is
/// already marked. The page itself need not exist: a mark is left by a page's hard delete.
pub(crate) fn seed_mark(tx: &mut dyn KvWrite, page_id: u64) -> Result<bool> {
    let key = mark_key(page_id);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    tx.put(&key, b"1")?;
    Ok(true)
}

/// Marks what the delete of `page` would leave unmarked, before it goes (`gbrain_owner_only_row_deleted`): when the page is
/// owner-only by its own lineage, the page itself and every concept or question with a `concept-provenance`
/// `synthesized_from` link to it (`gbrain_owner_only_mark_derived`). Call it before the page's links are deleted.
pub(crate) fn mark_before_delete(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let sources = OwnerOnlySources::read(&*tx)?;
    if !sources.guarded() || !sources.lineage_strict(&*tx, page)? {
        return Ok(());
    }
    let mut doomed = vec![page.id];
    for link in in_links(&*tx, page.id)? {
        if link.link_source.as_deref() == Some("concept-provenance")
            && link.link_type == "synthesized_from"
            && let Some(from) = read_page_by_id(&*tx, link.from_page_id)?
            && matches!(from.page_type.as_str(), "concept" | "question")
        {
            doomed.push(from.id);
        }
    }
    for id in doomed {
        tx.put(&mark_key(id), b"1")?;
    }
    Ok(())
}

/// One database login that reads owner-only lineage closed (`OwnerOnlyTriggerState.closedLogins`): its quoted name, the
/// quoted policy name doctor prints and the lineage tables it cannot read in full.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClosedLogin {
    pub login: String,
    pub policy: String,
    pub tables: Vec<String>,
}

/// The store side of `ownerOnlyMarkTriggers` (`readState` in `src/core/engine-sql/owner-only-marks.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerOnlyMarkState {
    /// The `('*', 'unguarded')` mark. SQL writes it when a delete trigger was missing; the store marks in code on
    /// every delete path, so no trigger can be missing and it never writes it.
    pub closed: bool,
    /// The `('*', 'row_security')` mark. SQL writes it when a role whose reads row-level security limits deletes a
    /// row; the store has no row-level security, so its marking walk reads every row and it never writes it.
    pub row_security: bool,
    /// `gbrain_owner_only_held()`: the brain holds an owner-only source or a mark.
    pub held: bool,
    /// `CLOSED_LOGINS_SQL` on a held brain: the logins that read `sources` but not every row of a lineage table. The
    /// store has no database logins and no row-level security: its one caller, the process that opened it, reads every
    /// row, so the list is empty on every brain.
    pub closed_logins: Vec<ClosedLogin>,
}

impl crate::Store {
    /// `ownerOnlyMarkTriggers()` (the store side): what the SQL member reads from `owner_only_marks` and the catalog.
    pub fn owner_only_mark_state(&self) -> Result<OwnerOnlyMarkState> {
        let read = self.read()?;
        Ok(OwnerOnlyMarkState {
            closed: false,
            row_security: false,
            held: OwnerOnlySources::read(&*read)?.guarded(),
            closed_logins: Vec::new(),
        })
    }
}

/// The shadow follow (`seed/follow.rs`): removes the mark of page `page_id`. `false` when the page
/// is not marked.
pub(crate) fn remove_mark(tx: &mut dyn KvWrite, page_id: u64) -> Result<bool> {
    let key = mark_key(page_id);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
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

    /// The mark state: not held on a fresh store, held once a source is owner-only; never closed, no logins.
    #[test]
    fn mark_state_is_held_once_a_source_is_owner_only() {
        let store = crate::test_support::store();
        let state = |held| OwnerOnlyMarkState {
            closed: false,
            row_security: false,
            held,
            closed_logins: Vec::new(),
        };
        assert_eq!(store.owner_only_mark_state().unwrap(), state(false));
        let source: SourceInput =
            serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } }))
                .unwrap();
        store.upsert_source(&source).unwrap();
        assert_eq!(store.owner_only_mark_state().unwrap(), state(true));
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
}
