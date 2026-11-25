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
//! from those through `derivation_inputs` (transitively, `generations/derivation_inputs.rs`), and every concept or question
//! that names the page. A fact, take or timeline row delete marks the same way (`mark_row_before_delete`, SQL's BEFORE
//! DELETE trigger on `facts`, `takes` and `timeline_entries`): a row that is owner-only by its own lineage, or (a take or a
//! timeline row) whose page is, is marked with every row derived from it, before it goes. Every store path that deletes one
//! of those rows calls it (`facts::delete_fact`, `takes::delete_take`, the timeline deletes); the shadow follow does not,
//! as it copies the primary's marks. The row-security and unguarded marks stay unwritten: the store has no row-level
//! security and no trigger that can be missing. Nothing here marks on a link delete or a source config
//! change, because SQL has no trigger on `links` and its sources trigger marks only a source that is deleted. The source
//! delete (`sources::archive`) removes each page of the source through `pages::remove_page` first, and the
//! source is still owner-only then, so each page goes through `mark_before_delete`.

use serde::Serialize;

use crate::Result;
use crate::generations::derived_closure;
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

/// The shadow seed (`seed.rs`): stores the mark of page `page_id` as another engine holds it. `false` when the page is
/// already marked. The page itself need not exist: a mark is left by a page's hard delete.
pub(crate) fn seed_mark(tx: &mut dyn KvWrite, page_id: u64) -> Result<bool> {
    let key = mark_key("pages", &page_id.to_string());
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
    // `seed`: the page, its takes and its timeline rows; `down`: what the edges derive from them; `concepts`.
    let mut seed = vec![("pages".to_string(), page.id.to_string())];
    for take in crate::takes::page_takes(&*tx, page.id)? {
        seed.push(("takes".to_string(), take.id.to_string()));
    }
    for entry in timeline_rows(&*tx, Some(page.id))? {
        seed.push(("timeline_entries".to_string(), entry.id.to_string()));
    }
    let mut doomed = seed.clone();
    doomed.extend(derived_closure(&*tx, &seed)?);
    for link in in_links(&*tx, page.id)? {
        if link.link_source.as_deref() == Some("concept-provenance")
            && link.link_type == "synthesized_from"
            && let Some(from) = read_page_by_id(&*tx, link.from_page_id)?
            && matches!(from.page_type.as_str(), "concept" | "question")
        {
            doomed.push(("pages".to_string(), from.id.to_string()));
        }
    }
    for (table, id) in doomed {
        tx.put(&mark_key(&table, &id), b"1")?;
    }
    Ok(())
}

/// Marks what the delete of one fact, take or timeline row (`table`, `id`) would leave unmarked, before it goes
/// (`gbrain_owner_only_row_deleted` on `facts`, `takes` and `timeline_entries`): when the brain holds owner-only data and
/// the row is owner-only by its own lineage (a fact also by its source), or a take or timeline row's page (`page_id`) is,
/// the row and every row derived from it through `derivation_inputs` (`gbrain_owner_only_mark_derived(table, [id])`).
pub(crate) fn mark_row_before_delete(
    tx: &mut dyn KvWrite,
    table: &str,
    id: u64,
    source_id: Option<&str>,
    page_id: Option<u64>,
) -> Result<()> {
    let sources = OwnerOnlySources::read(&*tx)?;
    if !sources.guarded() {
        return Ok(());
    }
    let mut owner_only = sources.row_lineage(&*tx, table, id, source_id)?;
    if !owner_only
        && table != "facts"
        && let Some(page_id) = page_id
        && let Some(page) = read_page_by_id(&*tx, page_id)?
    {
        owner_only = sources.lineage_strict(&*tx, &page)?;
    }
    if !owner_only {
        return Ok(());
    }
    let seed = vec![(table.to_string(), id.to_string())];
    let mut doomed = seed.clone();
    doomed.extend(derived_closure(&*tx, &seed)?);
    for (table, id) in doomed {
        tx.put(&mark_key(&table, &id), b"1")?;
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
    let key = mark_key("pages", &page_id.to_string());
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
            let args: crate::generations::DerivationInputsArgs = serde_json::from_value(json!({
                "derived": { "table": "pages", "id": derived }, "sourceId": "default",
                "inputs": [{ "table": "pages", "id": input }],
            }))
            .unwrap();
            store.record_derivation_inputs(&args).unwrap();
        };
        edge(id("default", "atoms/one"), id("vault", "notes/vault"));
        edge(id("default", "notes/summary"), id("default", "atoms/one"));
        assert!(!marked(&store, "default", "notes/summary"));
        store.delete_page("notes/vault", Some("vault")).unwrap();
        assert!(marked(&store, "default", "atoms/one"));
        assert!(marked(&store, "default", "notes/summary"));
    }

    /// A hard delete of an owner-only fact, take or timeline row (not of its page) marks the row and what was derived
    /// from it, as v322's triggers on those tables do; deleting an open fact marks nothing.
    #[test]
    fn deleting_an_owner_only_fact_take_or_timeline_row_marks_what_was_derived_from_it() {
        let store = crate::test_support::store();
        let source: SourceInput =
            serde_json::from_value(json!({ "id": "vault", "config": { "owner_only": true } }))
                .unwrap();
        store.upsert_source(&source).unwrap();
        put(&store, "vault", "notes/vault", "note", json!({}));
        for slug in [
            "notes/from-fact",
            "notes/from-take",
            "notes/from-timeline",
            "notes/from-open",
        ] {
            put(&store, "default", slug, "note", json!({}));
        }
        let page_id = |source: &str, slug: &str| {
            read_page(&*store.read().unwrap(), source, slug)
                .unwrap()
                .unwrap()
                .id
        };
        let fact = |source: &str, text: &str| -> u64 {
            let args: crate::facts::InsertFactArgs = serde_json::from_value(json!({
                "input": { "fact": text, "entity_slug": "people/a", "source": "mcp:remember" }, "sourceId": source,
            }))
            .unwrap();
            store.insert_fact(&args).unwrap()["id"].as_u64().unwrap()
        };
        let held_fact = fact("vault", "a vault claim");
        let open_fact = fact("default", "an open claim");
        let vault = page_id("vault", "notes/vault");
        let take: crate::takes::TakeInput = serde_json::from_value(json!({
            "page_id": vault, "row_num": 1, "claim": "a vault take", "kind": "fact", "holder": "self", "weight": 1.0, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        let take_id = crate::takes::page_takes(&*store.read().unwrap(), vault).unwrap()[0].id;
        let entry: crate::timeline::TimelineInput = serde_json::from_value(
            json!({ "date": "2026-05-03", "source": "chat", "summary": "a vault event" }),
        )
        .unwrap();
        let options: crate::timeline::AddTimelineOptions =
            serde_json::from_value(json!({ "sourceId": "vault" })).unwrap();
        store
            .add_timeline_entry("notes/vault", &entry, &options)
            .unwrap();
        let timeline = timeline_rows(&*store.read().unwrap(), Some(vault)).unwrap()[0].clone();
        let edge = |derived: &str, table: &str, input: u64| {
            let args: crate::generations::DerivationInputsArgs = serde_json::from_value(json!({
                "derived": { "table": "pages", "id": page_id("default", derived).to_string() }, "sourceId": "default",
                "inputs": [{ "table": table, "id": input.to_string() }],
            }))
            .unwrap();
            store.record_derivation_inputs(&args).unwrap();
        };
        edge("notes/from-fact", "facts", held_fact);
        edge("notes/from-take", "takes", take_id);
        edge("notes/from-timeline", "timeline_entries", timeline.id);
        edge("notes/from-open", "facts", open_fact);
        store
            .delete_purged_facts(&[held_fact as i64, open_fact as i64], "vault")
            .unwrap();
        store
            .delete_purged_facts(&[open_fact as i64], "default")
            .unwrap();
        store.delete_purged_takes(&[take_id as i64]).unwrap();
        store
            .write(|tx| crate::timeline::remove_entry(tx, &timeline))
            .unwrap();
        let row_marked = |table: &str, id: u64| {
            is_row_marked(&*store.read().unwrap(), table, &id.to_string()).unwrap()
        };
        assert!(
            row_marked("facts", held_fact)
                && row_marked("takes", take_id)
                && row_marked("timeline_entries", timeline.id)
        );
        assert!(marked(&store, "default", "notes/from-fact"));
        assert!(marked(&store, "default", "notes/from-take"));
        assert!(marked(&store, "default", "notes/from-timeline"));
        assert!(!row_marked("facts", open_fact) && !marked(&store, "default", "notes/from-open"));
    }
}
