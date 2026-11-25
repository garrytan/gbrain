//! Group 5 facts members, conversation fact publication: the page counts, the window stamps and
//! moves, the batch clear and the outcome-row delete (src/core/engine-sql/facts-conversation.ts).
//!
//! A conversation row is one whose `source` starts with `cli:extract-conversation-facts`
//! ([`FactRecord::conversation_slot`]); an audit row is one of the three outcome sources
//! ([`AUDIT_ROW_SOURCES`]). A row's window key is `occurrence_id:window_ordinal:window_text_sha`,
//! each part the `->>` text of its `source_window` field (a number as its JSON text); a missing
//! part makes the key NULL, which matches no key.
//!
//! - `readNewestConversationFactId(sourceId, slug)`: the largest id of the page's conversation
//!   rows, null for none.
//! - `maxConversationRowNum(sourceId, slug)`: the largest `row_num` of any row of the page.
//! - `listHeldFactSlots(sourceId, slug)`: the page's rows with a dimension, in id order, each
//!   `{ entity_slug, dimension, value_hash, valid_from }` (`valid_from` as ISO text).
//! - `countActiveConversationFacts(sourceId, slug)`: the page's conversation rows, audit rows
//!   aside, with no `expired_at`. `countPageConversationFacts` counts expired rows too.
//! - `countConversationWindowFacts(sourceId, slug, key)`: the page's conversation rows with no
//!   `expired_at` anchored to window `key` (audit rows included, as the statement has no test).
//! - `countConversationFactsOutsideWindows(sourceId, slug, keys)`: the page's conversation rows,
//!   audit rows aside, with no `expired_at`, unanchored or anchored to a key not in `keys`.
//! - `stampConversationSourceWindows(pairs)`: sets `source_window` of each row by id (a JSON null
//!   window clears it). An id no row has changes nothing.
//! - `moveConversationSourceWindows(sourceId, slug, moves)`: sets `source_window` to `to` on the
//!   page's conversation rows whose window key is `from`; every move matches the keys as they were
//!   before the call, so a chain of moves applies at once.
//! - `deleteConversationOutcomeRows(sourceId, slug)`: deletes the page's audit rows, `[{ id }]`.
//! - `clearConversationPageFacts(sourceId, slug, windows?)`: the five statements of the batch
//!   clear in order, each judged on the rows as the statement before it left them: delete the
//!   expired relinked rows nothing references; unslot the expired slotted rows; expire and unslot
//!   the active relinked rows; expire and unslot the active referenced rows; delete the rows that
//!   are not referenced, not retired by `gbrain repair conversation-labels` and not relinked. The
//!   answer is the sum of the last three counts. A row is referenced when an open loop names it or
//!   another row names it as its successor.
//!
//! Every write runs in one store transaction and writes through [`write_fact`] / [`delete_fact`],
//! so the trust stamp, the purge refusal and the indexes stay as every other fact write keeps
//! them; a delete clears `superseded_by` on the rows that named the row.

use super::loops::loop_fact_ids;
use super::{
    AUDIT_ROW_SOURCES, FactRecord, bigint, delete_fact, ids_under, page_rows, read_fact,
    refs_prefix, write_fact,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::jsonb::order as jsonb_order;
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::WriteTrust;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `RELINKED_DERIVED_ROW`'s context marker.
const RELINKED_MARKER: &str = "entity relinked from ";
/// `LABEL_RETIRED_MARKER`: the context mark `gbrain repair conversation-labels` leaves.
const LABEL_RETIRED_MARKER: &str = "retired: conversation-labels";

/// A page of a source: the arguments of most page members.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPageArgs {
    pub source_id: String,
    pub slug: String,
}

impl ConversationPageArgs {
    pub(crate) fn check(&self, op: &str) -> Result<()> {
        no_nul(op, &[("sourceId", &self.source_id), ("slug", &self.slug)])
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowKeyArgs {
    pub source_id: String,
    pub slug: String,
    pub key: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowKeysArgs {
    pub source_id: String,
    pub slug: String,
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WindowStamp {
    pub id: f64,
    pub w: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowStampArgs {
    pub pairs: Vec<WindowStamp>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WindowMove {
    pub from: String,
    pub to: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowMoveArgs {
    pub source_id: String,
    pub slug: String,
    pub moves: Vec<WindowMove>,
}

/// The `windows` of a window clear: the keys, whether they are kept (`keep`) or cleared, and
/// whether the page's unanchored rows are cleared too.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearWindows {
    pub keys: Vec<String>,
    pub keep: bool,
    pub unanchored: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearPageArgs {
    pub source_id: String,
    pub slug: String,
    pub windows: Option<ClearWindows>,
}

/// The window key of a row, `None` when it is unanchored or a part is missing (SQL NULL).
pub(crate) fn window_key(row: &FactRecord) -> Option<String> {
    let window = row.source_window.as_ref()?.as_object()?;
    let part = |name: &str| window.get(name).and_then(jsonb_field_text);
    Some(format!(
        "{}:{}:{}",
        part("occurrence_id")?,
        part("window_ordinal")?,
        part("window_text_sha")?
    ))
}

/// A window as the `jsonb` column keeps it: a JSON null is SQL NULL, an object's keys in jsonb order.
fn stored_window(w: &Option<Value>) -> Option<Value> {
    w.clone().filter(|w| !w.is_null()).map(jsonb_order)
}

/// Whether the row has a `source_window` (`source_window IS NOT NULL`).
fn anchored(row: &FactRecord) -> bool {
    row.source_window.as_ref().is_some_and(|w| !w.is_null())
}

/// `key = ANY(keys)`: false for an empty list, NULL (`None`) for a NULL key, else membership.
fn key_in(key: Option<&str>, keys: &[String]) -> Option<bool> {
    if keys.is_empty() {
        return Some(false);
    }
    key.map(|k| keys.iter().any(|x| x == k))
}

/// A conversation extractor's derived row: a conversation row that is not an audit row.
pub(crate) fn derived_row(row: &FactRecord) -> bool {
    row.conversation_slot() && !row.audit_row()
}

/// `RELINKED_DERIVED_ROW`.
pub(crate) fn relinked(row: &FactRecord) -> bool {
    row.entity_slug.is_some()
        && row
            .context
            .as_deref()
            .unwrap_or("")
            .contains(RELINKED_MARKER)
}

/// `UNSLOT_SQL`: the row gives up its slot.
fn unslot(row: &mut FactRecord) {
    row.dimension = None;
    row.value = None;
    row.value_hash = None;
    row.dim_status = None;
}

/// `REFERENCED_SQL`: an open loop names the row, or another row names it as its successor.
fn referenced(read: &dyn KvRead, loops: &BTreeSet<u64>, id: u64) -> Result<bool> {
    Ok(loops.contains(&id) || !ids_under(read, &refs_prefix(id))?.is_empty())
}

/// The page predicate of a clear: the page's conversation rows, or with `windows` its derived
/// rows that the window test (`CASE WHEN source_window IS NULL ...`) takes.
fn cleared_by(row: &FactRecord, windows: Option<&ClearWindows>) -> bool {
    if !row.conversation_slot() {
        return false;
    }
    let Some(w) = windows else {
        return true;
    };
    if row.audit_row() {
        return false;
    }
    if !anchored(row) {
        return w.unanchored;
    }
    key_in(window_key(row).as_deref(), &w.keys).is_some_and(|hit| hit != w.keep)
}

impl Store {
    /// `readNewestConversationFactId(sourceId, slug)`.
    pub fn read_newest_conversation_fact_id(&self, a: &ConversationPageArgs) -> Result<Value> {
        a.check("readNewestConversationFactId")?;
        let read = self.read()?;
        let rows = page_rows(&*read, &a.source_id, &a.slug)?;
        Ok(json!(
            rows.iter()
                .filter(|r| r.conversation_slot())
                .map(|r| r.id)
                .max()
        ))
    }

    /// `maxConversationRowNum(sourceId, slug)`.
    pub fn max_conversation_row_num(&self, a: &ConversationPageArgs) -> Result<Value> {
        a.check("maxConversationRowNum")?;
        let read = self.read()?;
        let rows = page_rows(&*read, &a.source_id, &a.slug)?;
        Ok(json!(rows.iter().filter_map(|r| r.row_num).max()))
    }

    /// `listHeldFactSlots(sourceId, slug)`.
    pub fn list_held_fact_slots(&self, a: &ConversationPageArgs) -> Result<Vec<Value>> {
        a.check("listHeldFactSlots")?;
        let read = self.read()?;
        Ok(page_rows(&*read, &a.source_id, &a.slug)?
            .into_iter()
            .filter(|r| r.dimension.is_some())
            .map(|r| {
                json!({
                    "entity_slug": r.entity_slug,
                    "dimension": r.dimension,
                    "value_hash": r.value_hash,
                    "valid_from": iso(r.valid_from_us),
                })
            })
            .collect())
    }

    /// `countActiveConversationFacts(sourceId, slug)`.
    pub fn count_active_conversation_facts(&self, a: &ConversationPageArgs) -> Result<i64> {
        a.check("countActiveConversationFacts")?;
        self.count_conversation_page_rows(a, |r| derived_row(r) && r.expired_at_us.is_none())
    }

    /// `countPageConversationFacts(sourceId, slug)`.
    pub fn count_page_conversation_facts(&self, a: &ConversationPageArgs) -> Result<i64> {
        a.check("countPageConversationFacts")?;
        self.count_conversation_page_rows(a, derived_row)
    }

    /// `countConversationWindowFacts(sourceId, slug, key)`.
    pub fn count_conversation_window_facts(&self, a: &WindowKeyArgs) -> Result<i64> {
        no_nul(
            "countConversationWindowFacts",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let page = ConversationPageArgs {
            source_id: a.source_id.clone(),
            slug: a.slug.clone(),
        };
        self.count_conversation_page_rows(&page, |r| {
            r.conversation_slot()
                && r.expired_at_us.is_none()
                && anchored(r)
                && window_key(r).as_deref() == Some(a.key.as_str())
        })
    }

    /// `countConversationFactsOutsideWindows(sourceId, slug, keys)`.
    pub fn count_conversation_facts_outside_windows(&self, a: &WindowKeysArgs) -> Result<i64> {
        no_nul(
            "countConversationFactsOutsideWindows",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let page = ConversationPageArgs {
            source_id: a.source_id.clone(),
            slug: a.slug.clone(),
        };
        self.count_conversation_page_rows(&page, |r| {
            derived_row(r)
                && r.expired_at_us.is_none()
                && (!anchored(r)
                    || key_in(window_key(r).as_deref(), &a.keys).is_some_and(|hit| !hit))
        })
    }

    fn count_conversation_page_rows(
        &self,
        a: &ConversationPageArgs,
        keep: impl Fn(&FactRecord) -> bool,
    ) -> Result<i64> {
        let read = self.read()?;
        let rows = page_rows(&*read, &a.source_id, &a.slug)?;
        Ok(rows.iter().filter(|r| keep(r)).count() as i64)
    }

    /// `stampConversationSourceWindows(pairs)`.
    pub fn stamp_conversation_source_windows(&self, a: &WindowStampArgs) -> Result<()> {
        const OP: &str = "stampConversationSourceWindows";
        let mut pairs = Vec::with_capacity(a.pairs.len());
        for p in &a.pairs {
            pairs.push((bigint(OP, "id", p.id)?, stored_window(&p.w)));
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for (id, w) in &pairs {
                let Ok(id) = u64::try_from(*id) else {
                    continue;
                };
                let Some(old) = read_fact(&*tx, id)? else {
                    continue;
                };
                let mut new = old.clone();
                new.source_window = w.clone();
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `moveConversationSourceWindows(sourceId, slug, moves)`.
    pub fn move_conversation_source_windows(&self, a: &WindowMoveArgs) -> Result<()> {
        no_nul(
            "moveConversationSourceWindows",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        if a.moves.is_empty() {
            return Ok(());
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            // Every key is read before any row changes: the statement sees the rows as they were.
            let rows = page_rows(&*tx, &a.source_id, &a.slug)?;
            for old in rows.into_iter().filter(|r| r.conversation_slot()) {
                let Some(key) = window_key(&old) else {
                    continue;
                };
                let Some(m) = a.moves.iter().find(|m| m.from == key) else {
                    continue;
                };
                let mut new = old.clone();
                new.source_window = stored_window(&Some(m.to.clone()));
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `deleteConversationOutcomeRows(sourceId, slug)`.
    pub fn delete_conversation_outcome_rows(&self, a: &ConversationPageArgs) -> Result<Vec<Value>> {
        a.check("deleteConversationOutcomeRows")?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut out = Vec::new();
            for row in page_rows(&*tx, &a.source_id, &a.slug)? {
                if !AUDIT_ROW_SOURCES.contains(&row.source.as_str()) {
                    continue;
                }
                // An earlier delete may have rewritten this row (its successor cleared).
                if let Some(current) = read_fact(&*tx, row.id)? {
                    delete_fact(tx, trust, &current)?;
                    out.push(json!({ "id": row.id }));
                }
            }
            Ok(out)
        })
    }

    /// `clearConversationPageFacts(sourceId, slug, windows?)`.
    pub fn clear_conversation_page_facts(&self, a: &ClearPageArgs) -> Result<i64> {
        const OP: &str = "clearConversationPageFacts";
        no_nul(OP, &[("sourceId", &a.source_id), ("slug", &a.slug)])?;
        let windows = a.windows.as_ref();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let loops = loop_fact_ids(&*tx, OP)?;
            let page = |tx: &dyn KvRead| -> Result<Vec<FactRecord>> {
                Ok(page_rows(tx, &a.source_id, &a.slug)?
                    .into_iter()
                    .filter(|r| cleared_by(r, windows))
                    .collect())
            };
            // Each step picks its rows first, as one statement sees the rows before it runs.
            let mut picked = Vec::new();
            for r in page(&*tx)? {
                if r.expired_at_us.is_some() && relinked(&r) && !referenced(&*tx, &loops, r.id)? {
                    picked.push(r.id);
                }
            }
            delete_ids(tx, trust, &picked)?;

            let picked: Vec<u64> = page(&*tx)?
                .into_iter()
                .filter(|r| r.expired_at_us.is_some() && r.dimension.is_some())
                .map(|r| r.id)
                .collect();
            update_ids(tx, trust, &picked, unslot)?;

            let picked: Vec<u64> = page(&*tx)?
                .into_iter()
                .filter(|r| r.expired_at_us.is_none() && relinked(r))
                .map(|r| r.id)
                .collect();
            let relinked_n = picked.len();
            update_ids(tx, trust, &picked, |r| {
                r.expired_at_us = Some(now);
                unslot(r);
            })?;

            let mut picked = Vec::new();
            for r in page(&*tx)? {
                if r.expired_at_us.is_none() && referenced(&*tx, &loops, r.id)? {
                    picked.push(r.id);
                }
            }
            let expired_n = picked.len();
            update_ids(tx, trust, &picked, |r| {
                r.expired_at_us = Some(now);
                unslot(r);
            })?;

            let mut picked = Vec::new();
            for r in page(&*tx)? {
                let retired = r
                    .context
                    .as_deref()
                    .unwrap_or("")
                    .contains(LABEL_RETIRED_MARKER);
                if !retired && !relinked(&r) && !referenced(&*tx, &loops, r.id)? {
                    picked.push(r.id);
                }
            }
            let deleted_n = picked.len();
            delete_ids(tx, trust, &picked)?;
            Ok((relinked_n + expired_n + deleted_n) as i64)
        })
    }
}

/// Deletes the rows `ids` (each read again, as an earlier delete may have rewritten it).
fn delete_ids(tx: &mut dyn KvWrite, trust: &WriteTrust, ids: &[u64]) -> Result<()> {
    for id in ids {
        if let Some(row) = read_fact(&*tx, *id)? {
            delete_fact(tx, trust, &row)?;
        }
    }
    Ok(())
}

/// Rewrites the rows `ids` with `change`.
fn update_ids(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    ids: &[u64],
    change: impl Fn(&mut FactRecord),
) -> Result<()> {
    for id in ids {
        if let Some(old) = read_fact(&*tx, *id)? {
            let mut new = old.clone();
            change(&mut new);
            write_fact(tx, trust, Some(&old), &new)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{InsertFactsArgs, NewFactInput};
    use super::*;
    use crate::test_support::store;

    const EXTRACTOR: &str = "cli:extract-conversation-facts:v1";
    const PAGE: &str = "meetings/one";

    fn win(o: i64, ord: i64, sha: &str) -> Value {
        json!({ "occurrence_id": o, "window_ordinal": ord, "window_text_sha": sha })
    }

    fn row(window: Option<Value>) -> FactRecord {
        FactRecord {
            source: EXTRACTOR.into(),
            source_window: window,
            ..FactRecord::default()
        }
    }

    /// Inserts conversation rows `(fact, source, context, expired)` on the page.
    fn insert(store: &Store, rows: &[(&str, &str, Option<&str>, bool)]) -> Vec<u64> {
        let rows = rows
            .iter()
            .map(|(fact, source, context, expired)| NewFactInput {
                fact: Some((*fact).into()),
                source: Some((*source).into()),
                context: context.map(Into::into),
                entity_slug: context.map(|_| "people/a".into()),
                valid_from: Some("2026-01-01T00:00:00.000Z".into()),
                expired_at: expired.then(|| "2026-02-01T00:00:00.000Z".into()),
                source_markdown_slug: Some(PAGE.into()),
                ..NewFactInput::default()
            })
            .collect();
        let out = store
            .insert_facts(&InsertFactsArgs {
                rows,
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        serde_json::from_value(out["ids"].clone()).unwrap()
    }

    fn page_args() -> ConversationPageArgs {
        ConversationPageArgs {
            source_id: "default".into(),
            slug: PAGE.into(),
        }
    }

    fn live_facts(store: &Store) -> Vec<String> {
        page_rows(&*store.read().unwrap(), "default", PAGE)
            .unwrap()
            .into_iter()
            .map(|r| r.fact)
            .collect()
    }

    #[test]
    fn a_window_key_is_null_when_a_part_is_missing_and_numbers_read_as_text() {
        assert_eq!(
            window_key(&row(Some(win(1, 2, "x")))).as_deref(),
            Some("1:2:x")
        );
        assert_eq!(window_key(&row(None)), None);
        assert_eq!(
            window_key(&row(Some(
                json!({ "occurrence_id": 1, "window_ordinal": 2 })
            ))),
            None
        );
        assert_eq!(window_key(&row(Some(json!([1, 2, 3])))), None);
    }

    #[test]
    fn key_membership_follows_sql_three_valued_logic() {
        let keys = vec!["1:1:x".to_string()];
        assert_eq!(key_in(None, &[]), Some(false));
        assert_eq!(key_in(None, &keys), None);
        assert_eq!(key_in(Some("1:1:x"), &keys), Some(true));
        assert_eq!(key_in(Some("1:2:y"), &keys), Some(false));
        // An anchored row with a NULL key is never cleared by a window test.
        let w = ClearWindows {
            keys: keys.clone(),
            keep: true,
            unanchored: true,
        };
        assert!(!cleared_by(
            &row(Some(json!({ "occurrence_id": 1 }))),
            Some(&w)
        ));
        assert!(cleared_by(&row(None), Some(&w)));
        assert!(!cleared_by(&row(Some(win(1, 1, "x"))), Some(&w)));
        assert!(cleared_by(&row(Some(win(1, 2, "y"))), Some(&w)));
    }

    #[test]
    fn moves_apply_against_the_keys_before_the_call() {
        let store = store();
        let ids = insert(
            &store,
            &[("a", EXTRACTOR, None, false), ("b", EXTRACTOR, None, false)],
        );
        store
            .stamp_conversation_source_windows(&WindowStampArgs {
                pairs: vec![
                    WindowStamp {
                        id: ids[0] as f64,
                        w: Some(win(1, 1, "x")),
                    },
                    WindowStamp {
                        id: ids[1] as f64,
                        w: Some(win(1, 2, "y")),
                    },
                ],
            })
            .unwrap();
        // x -> y and y -> z at once: the row on x lands on y, the row on y on z.
        store
            .move_conversation_source_windows(&WindowMoveArgs {
                source_id: "default".into(),
                slug: PAGE.into(),
                moves: vec![
                    WindowMove {
                        from: "1:1:x".into(),
                        to: win(1, 2, "y"),
                    },
                    WindowMove {
                        from: "1:2:y".into(),
                        to: win(1, 3, "z"),
                    },
                ],
            })
            .unwrap();
        let count = |key: &str| {
            store
                .count_conversation_window_facts(&WindowKeyArgs {
                    source_id: "default".into(),
                    slug: PAGE.into(),
                    key: key.into(),
                })
                .unwrap()
        };
        assert_eq!((count("1:1:x"), count("1:2:y"), count("1:3:z")), (0, 1, 1));
        let outside = |keys: &[&str]| {
            store
                .count_conversation_facts_outside_windows(&WindowKeysArgs {
                    source_id: "default".into(),
                    slug: PAGE.into(),
                    keys: keys.iter().map(|k| (*k).into()).collect(),
                })
                .unwrap()
        };
        assert_eq!((outside(&[]), outside(&["1:2:y"])), (2, 1));
    }

    #[test]
    fn a_whole_clear_expires_relinked_rows_keeps_retired_rows_and_deletes_the_rest() {
        let store = store();
        insert(
            &store,
            &[
                ("plain", EXTRACTOR, None, false),
                (
                    "relinked",
                    EXTRACTOR,
                    Some("entity relinked from bob"),
                    false,
                ),
                (
                    "old relinked",
                    EXTRACTOR,
                    Some("entity relinked from bob"),
                    true,
                ),
                (
                    "retired",
                    EXTRACTOR,
                    Some("x; retired: conversation-labels"),
                    true,
                ),
                ("EXTRACTION_COMPLETE", AUDIT_ROW_SOURCES[0], None, false),
                ("fenced", "fence", None, false),
            ],
        );
        let n = store
            .clear_conversation_page_facts(&ClearPageArgs {
                source_id: "default".into(),
                slug: PAGE.into(),
                windows: None,
            })
            .unwrap();
        // relinked (expired) + plain and the outcome row (deleted).
        assert_eq!(n, 3);
        assert_eq!(live_facts(&store), vec!["relinked", "retired", "fenced"]);
        assert_eq!(
            store.count_active_conversation_facts(&page_args()).unwrap(),
            0
        );
        assert_eq!(
            store
                .delete_conversation_outcome_rows(&page_args())
                .unwrap(),
            Vec::<Value>::new()
        );
    }
}
