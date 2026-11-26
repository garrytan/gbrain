//! Loop mutes: the `loop_suppressions` table (src/schema.sql, migration v144) and the open-loop
//! statements a mute, an unmute and the Gmail thread verdict run (src/core/loops/loops-store.ts,
//! SQL in src/core/engine-sql/loop-mutes.ts).
//!
//! Members: `addLoopSuppression`, `removeLoopSuppression`, `listLoopSuppressions`,
//! `listMuteRecheckThreads`, `closeMutedLoops`, `requeueMutedLoops`, `closeThreadLoops` and
//! `settleMuteRecheck`.
//!
//! Keys (after `keys::FACT`; a text part ends with a NUL byte, and no text column may hold one):
//! - `F 0x11 source_id kind value -> SuppressionRecord`: one row; the key is the table's
//!   `loop_suppressions_uniq` key `(source_id, kind, value)`. Stores of format 6 and older kept
//!   these rows at `F 0x10`, the take purge ledger's prefix; the open-time upgrade to format 7
//!   moves them (`facts/key_split.rs`).
//! - meta `next_loop_suppressions_id`: the `BIGSERIAL` sequence. Every add takes an id, also one
//!   that meets an existing row, as `nextval` runs before `ON CONFLICT` looks.
//!
//! Deleting a source removes its suppressions (`ON DELETE CASCADE`, [`remove_source_rows`]).
//! Text compares by bytes; `lower()` is Rust's Unicode lower case (rust/docs/store/facts.md).

use super::{LoopRecord, MUTE_RECHECK, MUTED, all_rows, row_key};
use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::pg_lower_char;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::require_source;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The byte after `keys::FACT` that marks a suppression row. `0x10` is the take purge ledger's
/// (`facts/take_purges.rs`); formats 6 and older kept both kinds there.
pub(crate) const SUPPRESSION: u8 = 0x11;
const COUNTER: &str = "next_loop_suppressions_id";
/// `UNMUTED` in loops-store.ts.
const UNMUTED: &str = "unmuted";
/// The table's CHECK list.
const KINDS: [&str; 2] = ["sender", "thread"];

/// What is stored for a suppression.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SuppressionRecord {
    id: u64,
    created_at_us: i64,
}

fn suppression_key(source_id: &str, kind: &str, value: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, SUPPRESSION];
    for (i, part) in [source_id, kind, value].iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

/// `F 0x11 source \0`: every suppression of a source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = vec![keys::FACT, SUPPRESSION];
    prefix.extend_from_slice(source_id.as_bytes());
    prefix.push(0);
    prefix
}

fn check_kind(kind: &str) -> Result<()> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!("loop_suppressions: kind must be sender or thread, got \"{kind}\""),
        ))
    }
}

/// One suppression row: `(source_id, kind, value, record)`.
type Suppression = (String, String, String, SuppressionRecord);

/// Every suppression under `prefix`, in key order.
fn scan(read: &dyn KvRead, prefix: &[u8], op: &str) -> Result<Vec<Suppression>> {
    let mut out = Vec::new();
    let mut failed = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        let parts: Vec<&[u8]> = k[2..].split(|b| *b == 0).collect();
        let [s, kind, value] = parts.as_slice() else {
            return true;
        };
        match serde_json::from_slice::<SuppressionRecord>(v) {
            Ok(r) => out.push((
                String::from_utf8_lossy(s).into_owned(),
                String::from_utf8_lossy(kind).into_owned(),
                String::from_utf8_lossy(value).into_owned(),
                r,
            )),
            Err(e) => {
                failed = Some(e);
                return false;
            }
        }
        true
    })?;
    if let Some(e) = failed {
        return Err(StoreError::invalid(format!("{op}: corrupt record: {e}")));
    }
    Ok(out)
}

/// Every suppression, in id order, as `SELECT *` reads it (`readMigrationRows`).
pub(crate) fn migration_rows(read: &dyn KvRead) -> Result<Vec<Value>> {
    let mut rows = scan(read, &[keys::FACT, SUPPRESSION], "readMigrationRows")?;
    rows.sort_by_key(|(_, _, _, r)| r.id);
    Ok(rows
        .into_iter()
        .map(|(s, kind, value, r)| {
            json!({ "id": r.id, "source_id": s, "kind": kind, "value": value, "created_at": iso(r.created_at_us) })
        })
        .collect())
}

/// The `loop_suppressions` columns `migration_rows` emits, in its order.
pub(crate) const SUPPRESSION_COLUMNS: [&str; 5] =
    ["id", "source_id", "kind", "value", "created_at"];

/// Removes every suppression of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &source_prefix(source_id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

/// Whether the suppression matches the loop: a `sender` row names its counterparty email, a
/// `thread` row its lower-cased thread id.
fn covers(kind: &str, value: &str, r: &LoopRecord) -> bool {
    match kind {
        "sender" => r.counterparty_email.as_deref() == Some(value),
        _ => r
            .thread_id
            .as_deref()
            .is_some_and(|t| t.chars().map(pg_lower_char).eq(value.chars())),
    }
}

impl Store {
    /// `addLoopSuppression`: records the `(source_id, kind, value)` suppression; a row that
    /// exists stays as it is (`ON CONFLICT DO NOTHING`). The caller lower-cases `value`.
    pub fn add_loop_suppression(&self, source_id: &str, kind: &str, value: &str) -> Result<()> {
        no_nul(
            "addLoopSuppression",
            &[("sourceId", source_id), ("kind", kind), ("value", value)],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            check_kind(kind)?;
            require_source(tx, source_id)?;
            let id = next_id(tx, COUNTER)?;
            let key = suppression_key(source_id, kind, value);
            if tx.get(&key)?.is_none() {
                put_json(
                    tx,
                    &key,
                    &SuppressionRecord {
                        id,
                        created_at_us: now,
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `removeLoopSuppression`: deletes the exact `(source_id, kind, value)` row; the number of
    /// rows removed (0 or 1).
    pub fn remove_loop_suppression(&self, source_id: &str, kind: &str, value: &str) -> Result<u32> {
        no_nul(
            "removeLoopSuppression",
            &[("sourceId", source_id), ("kind", kind), ("value", value)],
        )?;
        self.write(|tx| {
            let key = suppression_key(source_id, kind, value);
            if tx.get(&key)?.is_none() {
                return Ok(0);
            }
            tx.delete(&key)?;
            Ok(1)
        })
    }

    /// `listLoopSuppressions`: the `{ kind, value }` of every suppression of a source, by kind
    /// and then value (byte order).
    pub fn list_loop_suppressions(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listLoopSuppressions", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(
            scan(&*read, &source_prefix(source_id), "listLoopSuppressions")?
                .into_iter()
                .map(|(_, kind, value, _)| json!({ "kind": kind, "value": value }))
                .collect(),
        )
    }

    /// `listMuteRecheckThreads`: the threads of a source with loops an unmute queued for re-check
    /// (`closed_by = 'mute_recheck'`), each with the greatest page slug of those loops (null when
    /// none has one), by thread id.
    pub fn list_mute_recheck_threads(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listMuteRecheckThreads", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut threads: BTreeMap<String, Option<String>> = BTreeMap::new();
        for (_, r) in all_rows(&*read, "listMuteRecheckThreads")? {
            if r.source_id != source_id || r.closed_by.as_deref() != Some(MUTE_RECHECK) {
                continue;
            }
            let Some(thread) = r.thread_id else { continue };
            let slug = threads.entry(thread).or_default();
            if r.page_slug > *slug {
                *slug = r.page_slug;
            }
        }
        Ok(threads
            .into_iter()
            .map(|(thread_id, page_slug)| json!({ "thread_id": thread_id, "page_slug": page_slug }))
            .collect())
    }

    /// `closeMutedLoops`: the reply-owed loops a mute covers, open or queued by an earlier
    /// unmute, by id. With `apply` they close as `dropped` by `muted`, now.
    pub fn close_muted_loops(
        &self,
        source_id: &str,
        kind: &str,
        value: &str,
        apply: bool,
    ) -> Result<Vec<u64>> {
        no_nul(
            "closeMutedLoops",
            &[("sourceId", source_id), ("kind", kind), ("value", value)],
        )?;
        let now = self.env.now_micros();
        self.update_loops("closeMutedLoops", source_id, apply, |_, r| {
            if r.source_id != source_id
                || r.loop_type != "unanswered_inbound"
                || !covers(kind, value, r)
                || !(r.status == "open" || r.closed_by.as_deref() == Some(MUTE_RECHECK))
            {
                return false;
            }
            r.status = "dropped".into();
            r.closed_at_us = Some(now);
            r.closed_by = Some(MUTED.into());
            r.updated_at_us = now;
            true
        })
        .map(|rows| rows.into_iter().map(|(id, _)| id).collect())
    }

    /// `requeueMutedLoops`: the loops this mute closed that no other suppression of the source
    /// still covers, by id, as `{ id, thread_id }`. With `apply` a loop on a thread is queued for
    /// re-check (`mute_recheck`) and one without a thread stays closed (`unmuted`).
    pub fn requeue_muted_loops(
        &self,
        source_id: &str,
        kind: &str,
        value: &str,
        apply: bool,
    ) -> Result<Vec<Value>> {
        no_nul(
            "requeueMutedLoops",
            &[("sourceId", source_id), ("kind", kind), ("value", value)],
        )?;
        let now = self.env.now_micros();
        let rows = self.update_loops("requeueMutedLoops", source_id, apply, |held, r| {
            if r.source_id != source_id
                || r.closed_by.as_deref() != Some(MUTED)
                || !covers(kind, value, r)
                || held
                    .iter()
                    .any(|(k, v)| !(k == kind && v == value) && covers(k, v, r))
            {
                return false;
            }
            r.closed_by = Some(
                if r.thread_id.is_none() {
                    UNMUTED
                } else {
                    MUTE_RECHECK
                }
                .into(),
            );
            r.updated_at_us = now;
            true
        })?;
        Ok(rows
            .into_iter()
            .map(|(id, thread_id)| json!({ "id": id, "thread_id": thread_id }))
            .collect())
    }

    /// `closeThreadLoops`: closes the thread-detector loops of a thread, open or queued for
    /// re-check, as `done` by `closed_by`, now; only the loop types in `only` when it is given.
    /// The number closed.
    pub fn close_thread_loops(
        &self,
        source_id: &str,
        thread_id: &str,
        closed_by: &str,
        only: Option<&[String]>,
    ) -> Result<u32> {
        no_nul(
            "closeThreadLoops",
            &[
                ("sourceId", source_id),
                ("threadId", thread_id),
                ("closedBy", closed_by),
            ],
        )?;
        let now = self.env.now_micros();
        let rows = self.update_loops("closeThreadLoops", source_id, true, |_, r| {
            if r.source_id != source_id
                || r.thread_id.as_deref() != Some(thread_id)
                || !(r.status == "open" || r.closed_by.as_deref() == Some(MUTE_RECHECK))
                || r.detector != "deterministic_thread"
                || only.is_some_and(|types| !types.contains(&r.loop_type))
            {
                return false;
            }
            r.status = "done".into();
            r.closed_at_us = Some(now);
            r.closed_by = Some(closed_by.into());
            r.updated_at_us = now;
            true
        })?;
        Ok(rows.len() as u32)
    }

    /// `settleMuteRecheck`: the loops of a thread still queued for re-check stay closed
    /// (`unmuted`). The number settled.
    pub fn settle_mute_recheck(&self, source_id: &str, thread_id: &str) -> Result<u32> {
        no_nul(
            "settleMuteRecheck",
            &[("sourceId", source_id), ("threadId", thread_id)],
        )?;
        let now = self.env.now_micros();
        let rows = self.update_loops("settleMuteRecheck", source_id, true, |_, r| {
            if r.source_id != source_id
                || r.thread_id.as_deref() != Some(thread_id)
                || r.closed_by.as_deref() != Some(MUTE_RECHECK)
            {
                return false;
            }
            r.closed_by = Some(UNMUTED.into());
            r.updated_at_us = now;
            true
        })?;
        Ok(rows.len() as u32)
    }

    /// The loops of `source_id` that `edit` selects, by id, as `(id, thread_id)` before the edit.
    /// `edit` gets the source's suppressions as `(kind, value)` and a copy of the loop; it returns
    /// whether the loop matches and changes the copy. With `apply` the changed rows are written in
    /// the transaction that read them, otherwise nothing is written.
    fn update_loops(
        &self,
        op: &str,
        source_id: &str,
        apply: bool,
        mut edit: impl FnMut(&[(String, String)], &mut LoopRecord) -> bool,
    ) -> Result<Vec<(u64, Option<String>)>> {
        let mut pick = |read: &dyn KvRead| -> Result<Vec<(u64, LoopRecord, Option<String>)>> {
            let held: Vec<(String, String)> = scan(read, &source_prefix(source_id), op)?
                .into_iter()
                .map(|(_, k, v, _)| (k, v))
                .collect();
            let mut out = Vec::new();
            for (id, mut r) in all_rows(read, op)? {
                let thread = r.thread_id.clone();
                if edit(&held, &mut r) {
                    out.push((id, r, thread));
                }
            }
            Ok(out)
        };
        if !apply {
            let read = self.read()?;
            return Ok(pick(&*read)?
                .into_iter()
                .map(|(id, _, t)| (id, t))
                .collect());
        }
        self.write(|tx| {
            let picked = pick(&*tx)?;
            for (id, r, _) in &picked {
                put_json(tx, &row_key(*id), r)?;
            }
            Ok(picked.into_iter().map(|(id, _, t)| (id, t)).collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SOURCE_NOT_FOUND;
    use crate::facts::loops::OpenLoopUpsert;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    const T1: &str = "2026-03-01T10:00:00Z";

    fn source(s: &Store, id: &str) {
        s.upsert_source(&SourceInput {
            id: id.into(),
            ..SourceInput::default()
        })
        .unwrap();
    }

    /// A reply-owed thread-detector loop; returns its id.
    fn owed(
        s: &Store,
        source_id: &str,
        key: &str,
        email: &str,
        thread: Option<&str>,
        slug: Option<&str>,
    ) -> u64 {
        let input: OpenLoopUpsert = serde_json::from_value(json!({
            "sourceId": source_id, "dedupKey": key, "loopType": "unanswered_inbound",
            "counterpartyEmail": email, "summary": "s", "evidence": [], "threadId": thread,
            "pageSlug": slug, "detector": "deterministic_thread", "lastActivityAt": T1, "openedAt": T1,
        }))
        .unwrap();
        s.upsert_open_loop(&input).unwrap().id as u64
    }

    fn closed_by(s: &Store, id: u64) -> (String, Option<String>) {
        let read = s.read().unwrap();
        let r = super::super::read_row(&*read, id).unwrap().unwrap();
        (r.status, r.closed_by)
    }

    #[test]
    fn add_keeps_one_row_takes_an_id_each_time_and_checks_kind_and_source() {
        let s = store();
        source(&s, "src");
        s.add_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        s.add_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        s.add_loop_suppression("src", "thread", "t1").unwrap();
        let rows = migration_rows(&*s.read().unwrap()).unwrap();
        assert_eq!(rows.len(), 2);
        // The second add took id 2 and wrote nothing, as nextval runs before ON CONFLICT.
        assert_eq!(rows[0]["id"], 1);
        assert_eq!(rows[1]["id"], 3);
        assert_eq!(
            s.add_loop_suppression("src", "domain", "x")
                .unwrap_err()
                .code,
            CONSTRAINT_VIOLATION
        );
        assert_eq!(
            s.add_loop_suppression("nope", "sender", "x")
                .unwrap_err()
                .code,
            SOURCE_NOT_FOUND
        );
        assert_eq!(
            s.list_loop_suppressions("src").unwrap(),
            vec![
                json!({ "kind": "sender", "value": "a@example.com" }),
                json!({ "kind": "thread", "value": "t1" })
            ]
        );
        assert_eq!(
            s.remove_loop_suppression("src", "sender", "a@example.com")
                .unwrap(),
            1
        );
        assert_eq!(
            s.remove_loop_suppression("src", "sender", "a@example.com")
                .unwrap(),
            0
        );
        assert_eq!(s.list_loop_suppressions("src").unwrap().len(), 1);
    }

    #[test]
    fn a_mute_closes_covered_loops_and_an_unmute_queues_only_what_no_other_mute_covers() {
        let s = store();
        source(&s, "src");
        let a = owed(
            &s,
            "src",
            "k1",
            "a@example.com",
            Some("T-One"),
            Some("mail/one"),
        );
        let b = owed(&s, "src", "k2", "a@example.com", Some("t-two"), None);
        let c = owed(&s, "src", "k3", "a@example.com", None, None);
        let other = owed(&s, "src", "k4", "b@example.com", Some("t-three"), None);
        // A dry run lists and writes nothing.
        assert_eq!(
            s.close_muted_loops("src", "sender", "a@example.com", false)
                .unwrap(),
            vec![a, b, c]
        );
        assert_eq!(closed_by(&s, a), ("open".into(), None));
        s.add_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        assert_eq!(
            s.close_muted_loops("src", "sender", "a@example.com", true)
                .unwrap(),
            vec![a, b, c]
        );
        assert_eq!(closed_by(&s, a), ("dropped".into(), Some(MUTED.into())));
        assert_eq!(closed_by(&s, other), ("open".into(), None));
        // A thread mute matches the lower-cased thread id and keeps loop b closed after the unmute.
        s.add_loop_suppression("src", "thread", "t-two").unwrap();
        assert_eq!(
            s.remove_loop_suppression("src", "sender", "a@example.com")
                .unwrap(),
            1
        );
        let dry = s
            .requeue_muted_loops("src", "sender", "a@example.com", false)
            .unwrap();
        assert_eq!(
            dry,
            vec![
                json!({ "id": a, "thread_id": "T-One" }),
                json!({ "id": c, "thread_id": null })
            ]
        );
        assert_eq!(closed_by(&s, a).1.as_deref(), Some(MUTED));
        s.requeue_muted_loops("src", "sender", "a@example.com", true)
            .unwrap();
        assert_eq!(
            closed_by(&s, a),
            ("dropped".into(), Some(MUTE_RECHECK.into()))
        );
        assert_eq!(closed_by(&s, b), ("dropped".into(), Some(MUTED.into())));
        assert_eq!(closed_by(&s, c), ("dropped".into(), Some(UNMUTED.into())));
        assert_eq!(
            s.list_mute_recheck_threads("src").unwrap(),
            vec![json!({ "thread_id": "T-One", "page_slug": "mail/one" })]
        );
        // A thread mute of the upper-case id matches it lower-cased.
        assert_eq!(
            s.close_muted_loops("src", "thread", "t-one", false)
                .unwrap(),
            vec![a]
        );
    }

    #[test]
    fn the_thread_verdict_closes_or_settles_the_queued_loops() {
        let s = store();
        source(&s, "src");
        let a = owed(&s, "src", "k1", "a@example.com", Some("t1"), None);
        let b = owed(&s, "src", "k2", "a@example.com", Some("t2"), None);
        s.add_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        s.close_muted_loops("src", "sender", "a@example.com", true)
            .unwrap();
        s.remove_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        s.requeue_muted_loops("src", "sender", "a@example.com", true)
            .unwrap();
        let only = vec!["unanswered_outbound".to_string()];
        assert_eq!(
            s.close_thread_loops("src", "t1", "reply_detected", Some(&only))
                .unwrap(),
            0
        );
        assert_eq!(
            s.close_thread_loops("src", "t1", "reply_detected", None)
                .unwrap(),
            1
        );
        assert_eq!(
            closed_by(&s, a),
            ("done".into(), Some("reply_detected".into()))
        );
        assert_eq!(s.settle_mute_recheck("src", "t2").unwrap(), 1);
        assert_eq!(closed_by(&s, b), ("dropped".into(), Some(UNMUTED.into())));
        assert_eq!(s.settle_mute_recheck("src", "t2").unwrap(), 0);
        assert!(s.list_mute_recheck_threads("src").unwrap().is_empty());
    }

    #[test]
    fn deleting_a_source_removes_its_mutes_only() {
        let s = store();
        source(&s, "src");
        source(&s, "keep");
        s.add_loop_suppression("src", "sender", "a@example.com")
            .unwrap();
        s.add_loop_suppression("keep", "sender", "a@example.com")
            .unwrap();
        s.write(|tx| super::super::remove_source_rows(tx, "src"))
            .unwrap();
        assert!(s.list_loop_suppressions("src").unwrap().is_empty());
        assert_eq!(s.list_loop_suppressions("keep").unwrap().len(), 1);
    }
}
