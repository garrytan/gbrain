//! `owner_only_marks` (migration v322, GST-3032): the rows a hard delete leaves owner-only. A row of an owner-only source,
//! a concept or question synthesized from one, and a row whose recorded `derivation_inputs` reach one read as owner-only
//! through live rows (`owner_only.rs`). When that origin is deleted for good the live rows that made the derived row
//! owner-only go with it; SQL's BEFORE DELETE trigger on `pages`, `facts`, `takes` and `timeline_entries`
//! (`gbrain_owner_only_row_deleted`, src/core/access/owner-only-marks.ts) first marks the row and everything derived from
//! it (`gbrain_owner_only_mark_derived`), and `gbrain_owner_only_lineage_strict` reads those marks. This is that record,
//! written in code on every delete path of the four tables.
//!
//! Keys: `M owner_only_mark/<table>/<id>` -> `1`, one per `(row_table, row_id)` of `owner_only_marks`. A table name never
//! holds `/` (`TABLE_NAME` in src/core/facts/derivation-inputs.ts), so the split is exact; ids are never reused, so a
//! mark never names another row. The trigger's guard (a brain that never held owner-only data stores nothing) is kept:
//! [`mark_before_row_delete`] returns before it reads anything else when no source is owner-only and no mark exists.
//!
//! SQL also writes two closed marks under the table `*`: `unguarded` while a delete trigger is missing and `row_security`
//! when a role whose reads row-level security limits deletes a row. This store never writes either: it has no SQL
//! trigger that can go missing or be disabled, every delete path marks in code, and it has no row-level security, so its
//! marking walk always reads every row. A read still honours a `*` mark if one is ever present (`any_closed`).
//!
//! Nothing here marks on a link delete or a source config change, because SQL has no trigger on `links` and its sources
//! trigger marks only a source that is deleted. The Rust engine serves no source delete (`cascade.rs`): core removes each
//! page of the source through `pages::remove_page` first, and the source is still owner-only then, so each page goes
//! through [`mark_before_row_delete`].

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::in_links;
use crate::owner_only::{any_owner_only, lineage_strict};
use crate::pages::read_page_by_id;
use crate::{Result, Store, keys};

const MARK: &str = "owner_only_mark";
/// The table of SQL's closed marks (`unguarded`, `row_security`).
const CLOSED_TABLE: &str = "*";

fn mark_key(table: &str, id: &str) -> Vec<u8> {
    keys::meta(&format!("{MARK}/{table}/{id}"))
}

fn any_under(read: &dyn KvRead, prefix: &str) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &keys::meta(prefix), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// Whether any row was ever marked: once one was, the guard stays on for good (the SQL held flag).
pub(crate) fn any_marked(read: &dyn KvRead) -> Result<bool> {
    any_under(read, &format!("{MARK}/"))
}

/// Whether a closed mark (`row_table = '*'`) exists: owner-only lineage then reads closed.
pub(crate) fn any_closed(read: &dyn KvRead) -> Result<bool> {
    any_under(read, &format!("{MARK}/{CLOSED_TABLE}/"))
}

/// `owner_only_marks` holds `(table, id)`.
pub(crate) fn is_marked(read: &dyn KvRead, table: &str, id: &str) -> Result<bool> {
    Ok(read.get(&mark_key(table, id))?.is_some())
}

/// The guard of every owner-only test and of the delete triggers: an owner-only source exists or a mark does.
pub(crate) fn held(read: &dyn KvRead) -> Result<bool> {
    Ok(any_owner_only(read)? || any_marked(read)?)
}

/// `gbrain_owner_only_row_deleted`, run before the row `(table, id)` goes: when the row is owner-only by its strict
/// lineage (a take or timeline entry also when its page `page_id` is), marks it and everything derived from it. Call it
/// while the row and its page's links still exist.
pub(crate) fn mark_before_row_delete(
    tx: &mut dyn KvWrite,
    table: &str,
    id: u64,
    page_id: Option<u64>,
) -> Result<()> {
    if !held(&*tx)? {
        return Ok(());
    }
    let owner_only = lineage_strict(&*tx, table, id)?
        || match page_id {
            Some(page) => lineage_strict(&*tx, "pages", page)?,
            None => false,
        };
    if owner_only {
        mark_derived(tx, table, &[id])?;
    }
    Ok(())
}

/// `gbrain_owner_only_mark_derived(table, ids)`: marks the rows, the takes and timeline entries of each page among them,
/// every row derived from any of those at any depth (the `h 0x0B` input index), and each concept or question with a
/// `concept-provenance` `synthesized_from` link to one of the pages.
pub(crate) fn mark_derived(tx: &mut dyn KvWrite, table: &str, ids: &[u64]) -> Result<()> {
    let mut seed: Vec<(String, String)> = ids
        .iter()
        .map(|id| (table.to_string(), id.to_string()))
        .collect();
    let mut concepts: Vec<(String, String)> = Vec::new();
    if table == "pages" {
        for &page in ids {
            for take in crate::takes::page_takes(&*tx, page)? {
                seed.push(("takes".into(), take.id.to_string()));
            }
            for entry in page_entry_ids(&*tx, page)? {
                seed.push(("timeline_entries".into(), entry.to_string()));
            }
            for link in in_links(&*tx, page)? {
                if link.link_source.as_deref() == Some("concept-provenance")
                    && link.link_type == "synthesized_from"
                    && let Some(from) = read_page_by_id(&*tx, link.from_page_id)?
                    && matches!(from.page_type.as_str(), "concept" | "question")
                {
                    concepts.push(("pages".into(), from.id.to_string()));
                }
            }
        }
    }
    let down = crate::generations::derived_closure(&*tx, &seed)?;
    let rows: BTreeSet<(String, String)> = seed.into_iter().chain(down).chain(concepts).collect();
    for (t, id) in rows {
        tx.put(&mark_key(&t, &id), b"1")?;
    }
    Ok(())
}

/// The ids of the timeline entries filed on page `page_id`, from their keys (`E page date id`).
fn page_entry_ids(read: &dyn KvRead, page_id: u64) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |k, _| {
        if let Some(id) = k.get(k.len().saturating_sub(8)..).and_then(keys::be8) {
            ids.push(id);
        }
        true
    })?;
    Ok(ids)
}

/// Marks before the timeline entries of page `page_id` go with it (`remove_page_timeline`): each entry is one trigger run.
pub(crate) fn mark_before_page_timeline_delete(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    if !held(&*tx)? {
        return Ok(());
    }
    for id in page_entry_ids(&*tx, page_id)? {
        mark_before_row_delete(tx, "timeline_entries", id, Some(page_id))?;
    }
    Ok(())
}

impl Store {
    /// The store side of `ownerOnlyMarkTriggers`: `closed` (a `*` mark exists) and `held` (an owner-only source or a
    /// mark exists). The store has no trigger to report missing; see the module doc.
    pub fn owner_only_mark_state(&self) -> Result<Value> {
        let read = self.read()?;
        Ok(json!({
            "closed": is_marked(&*read, CLOSED_TABLE, "unguarded")?,
            "rowSecurity": is_marked(&*read, CLOSED_TABLE, "row_security")?,
            "held": held(&*read)?,
        }))
    }
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
        is_marked(&*read, "pages", &page.id.to_string()).unwrap()
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

    fn record(store: &crate::Store, derived: (&str, String), input: (&str, String)) {
        let args: crate::generations::DerivationInputsArgs = serde_json::from_value(json!({
            "derived": { "table": derived.0, "id": derived.1 },
            "inputs": [{ "table": input.0, "id": input.1 }],
        }))
        .unwrap();
        store.record_derivation_inputs(&args).unwrap();
    }

    fn vault(store: &crate::Store) -> u64 {
        let source: SourceInput =
            serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } }))
                .unwrap();
        store.upsert_source(&source).unwrap();
        put(store, "vault", "notes/vault", "note", json!({}));
        let read = store.read().unwrap();
        read_page(&*read, "vault", "notes/vault")
            .unwrap()
            .unwrap()
            .id
    }

    fn page_id(store: &crate::Store, slug: &str) -> u64 {
        let read = store.read().unwrap();
        read_page(&*read, "default", slug).unwrap().unwrap().id
    }

    /// A take of an owner-only page deleted on its own marks the take and every row derived from
    /// it at any depth; a row derived from an open take stays unmarked.
    #[test]
    fn deleting_a_take_of_an_owner_only_page_marks_what_was_derived_from_it() {
        let store = crate::test_support::store();
        let page = vault(&store);
        put(&store, "default", "notes/open", "note", json!({}));
        let open = page_id(&store, "notes/open");
        let take = |page: u64, row: u64| -> Value {
            json!({ "page_id": page, "row_num": row, "claim": "a heron", "kind": "take", "holder": "self", "weight": 0.5, "active": true })
        };
        let rows: Vec<crate::takes::TakeInput> = [take(page, 1), take(open, 1)]
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect();
        store.add_takes_batch(&rows).unwrap();
        let ids: Vec<u64> = {
            let read = store.read().unwrap();
            [page, open]
                .iter()
                .map(|&p| crate::takes::page_takes(&*read, p).unwrap()[0].id)
                .collect()
        };
        put(&store, "default", "notes/d1", "note", json!({}));
        put(&store, "default", "notes/d2", "note", json!({}));
        put(&store, "default", "notes/d3", "note", json!({}));
        let (d1, d2, d3) = (
            page_id(&store, "notes/d1"),
            page_id(&store, "notes/d2"),
            page_id(&store, "notes/d3"),
        );
        record(
            &store,
            ("pages", d1.to_string()),
            ("takes", ids[0].to_string()),
        );
        record(&store, ("facts", "41".into()), ("pages", d1.to_string()));
        record(&store, ("pages", d2.to_string()), ("facts", "41".into()));
        record(
            &store,
            ("pages", d3.to_string()),
            ("takes", ids[1].to_string()),
        );

        store.delete_take_rows(open as i64, &[json!(1)]).unwrap();
        assert!(
            !any_marked(&*store.read().unwrap()).unwrap(),
            "an open take marks nothing"
        );
        store.delete_take_rows(page as i64, &[json!(1)]).unwrap();
        let read = store.read().unwrap();
        assert!(is_marked(&*read, "takes", &ids[0].to_string()).unwrap());
        assert!(is_marked(&*read, "pages", &d1.to_string()).unwrap());
        assert!(is_marked(&*read, "facts", "41").unwrap());
        assert!(is_marked(&*read, "pages", &d2.to_string()).unwrap());
        assert!(!is_marked(&*read, "pages", &d3.to_string()).unwrap());
    }

    /// A hard delete of an owner-only page marks its timeline entries and what was derived from
    /// them, so the derived row reads owner-only after the entry is gone.
    #[test]
    fn deleting_an_owner_only_page_marks_what_its_timeline_entries_derived() {
        use crate::owner_only::{OwnerOnlyForm, page_owner_only};
        let store = crate::test_support::store();
        let page = vault(&store);
        let entry: crate::timeline::TimelineInput =
            serde_json::from_value(json!({ "date": "2026-01-02", "summary": "a heron" })).unwrap();
        let options = crate::timeline::AddTimelineOptions {
            source_id: Some("vault".into()),
            ..Default::default()
        };
        assert!(
            store
                .add_timeline_entry("notes/vault", &entry, &options)
                .unwrap()
        );
        let entry_id = {
            let read = store.read().unwrap();
            page_entry_ids(&*read, page).unwrap()[0]
        };
        put(&store, "default", "notes/derived", "note", json!({}));
        let derived = page_id(&store, "notes/derived");
        record(
            &store,
            ("pages", derived.to_string()),
            ("timeline_entries", entry_id.to_string()),
        );
        store.delete_page("notes/vault", Some("vault")).unwrap();
        let read = store.read().unwrap();
        assert!(is_marked(&*read, "timeline_entries", &entry_id.to_string()).unwrap());
        assert!(is_marked(&*read, "pages", &derived.to_string()).unwrap());
        let row = crate::pages::read_page_by_id(&*read, derived)
            .unwrap()
            .unwrap();
        assert!(page_owner_only(&*read, &row, OwnerOnlyForm::Fn).unwrap());
    }

    /// A closed mark (`*`), which this store never writes, makes every row with a recorded input
    /// and every concept read owner-only, and `owner_only_mark_state` reports it.
    #[test]
    fn a_closed_mark_reads_every_derived_row_as_owner_only() {
        use crate::owner_only::{OwnerOnlyForm, fact_owner_only, page_owner_only};
        let store = crate::test_support::store();
        put(&store, "default", "notes/plain", "note", json!({}));
        put(&store, "default", "notes/derived", "note", json!({}));
        put(&store, "default", "concepts/c", "concept", json!({}));
        let (plain, derived, concept) = (
            page_id(&store, "notes/plain"),
            page_id(&store, "notes/derived"),
            page_id(&store, "concepts/c"),
        );
        record(
            &store,
            ("pages", derived.to_string()),
            ("pages", plain.to_string()),
        );
        record(&store, ("facts", "9".into()), ("pages", plain.to_string()));
        let state = store.owner_only_mark_state().unwrap();
        assert_eq!(
            state,
            json!({ "closed": false, "rowSecurity": false, "held": false })
        );
        let read_all = |want: bool| {
            let read = store.read().unwrap();
            let page = |id| crate::pages::read_page_by_id(&*read, id).unwrap().unwrap();
            assert_eq!(
                page_owner_only(&*read, &page(derived), OwnerOnlyForm::Fn).unwrap(),
                want
            );
            assert_eq!(
                page_owner_only(&*read, &page(concept), OwnerOnlyForm::Fn).unwrap(),
                want
            );
            assert_eq!(
                fact_owner_only(&*read, 9, "default", OwnerOnlyForm::Fn).unwrap(),
                want
            );
            assert!(!page_owner_only(&*read, &page(plain), OwnerOnlyForm::Fn).unwrap());
            assert!(!fact_owner_only(&*read, 10, "default", OwnerOnlyForm::Fn).unwrap());
        };
        read_all(false);
        store
            .write(|tx| tx.put(&mark_key(CLOSED_TABLE, "unguarded"), b"1"))
            .unwrap();
        read_all(true);
        let state = store.owner_only_mark_state().unwrap();
        assert_eq!(
            state,
            json!({ "closed": true, "rowSecurity": false, "held": true })
        );
    }
}
