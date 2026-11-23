//! Context-volunteer events: the `context_volunteer_events` table of the SQL engines (migration v117),
//! the log of every page the brain volunteered (`src/core/context/volunteer-events.ts`,
//! `src/core/engine-sql/volunteer-events.ts`, `rust/docs/store/volunteer-events.md`).
//!
//! Members: `insertVolunteerEventRows`, `listVolunteerChannels`, `listVolunteerUsage`,
//! `deleteVolunteerEventsOlderThan`, `deleteVolunteerEventsForSlugs` and
//! `countVolunteerEventsForSlug`.
//!
//! Keys (family `META`, name `volunteer_event`; text parts joined with `0x00`):
//! `M volunteer_event \0 source \0 slug \0 <id, 20 digits>` holds an [`EventRecord`]. The id is the
//! table's `BIGSERIAL`, so a slug's rows list in the order they were written.
//!
//! A row names a page by source and slug outside any foreign key, and its rationale quotes the matched
//! name, so every hard delete scrubs it as the SQL engines do (`scrubPurgedNameStores`, the source delete's
//! `scrub_context_volunteer_events`): `scrub_slugs` runs after `delete_pages` and `purge_deleted_pages`, and
//! `remove_source_rows` runs in `cascade::remove_source_rows`. A soft delete keeps the rows, because
//! `restore_page` can bring the page back. `purge_probe_rows` is the row set a purge verification's inventory
//! probe searches.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::env::iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::purge_probe::{ProbeCell, ProbeRow};
use crate::kv::{KvRead, KvWrite, collect_prefix};
use crate::pages::read_page;
use crate::{Store, keys, put_json};

const NAME: &str = "volunteer_event";
const NEXT_ID: &str = "next_volunteer_event_id";
const OP_INSERT: &str = "insertVolunteerEventRows";
const OP_RETENTION: &str = "deleteVolunteerEventsOlderThan";
/// One day of PGLite's `interval '1 day'`. PGLite runs in `Etc/GMT0`, so a day is always 24 hours.
const DAY_US: i64 = 86_400_000_000;
/// `VOLUNTEER_SCOPED_SQL`'s window: `volunteered_at > now() - interval '7 days'`.
const CHANNEL_WINDOW_US: i64 = 7 * DAY_US;

fn key(source: &str, slug: &str, id: u64) -> Vec<u8> {
    keys::text(keys::META, &[NAME, source, slug, &format!("{id:020}")])
}

fn prefix(parts: &[&str]) -> Vec<u8> {
    let mut all = vec![NAME];
    all.extend_from_slice(parts);
    let mut key = keys::text(keys::META, &all);
    key.push(0);
    key
}

fn nul(member: &str) -> StoreError {
    StoreError::new(
        INVALID_ARGUMENT,
        format!("{member}: invalid byte sequence for encoding \"UTF8\": 0x00"),
    )
}

/// One row to insert: the columns `insertVolunteerEvents` writes (`volunteered_at` defaults to now).
#[derive(Debug, Clone, Deserialize)]
pub struct VolunteerEventInput {
    pub source_id: String,
    pub slug: String,
    pub confidence: f64,
    pub match_arm: String,
    pub rationale: String,
    pub channel: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub turn: Option<i32>,
}

/// One `context_volunteer_events` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EventRecord {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub confidence: f64,
    pub match_arm: String,
    pub rationale: String,
    pub channel: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub turn: Option<i32>,
    pub volunteered_at_us: i64,
}

fn all_events(read: &dyn KvRead) -> Result<Vec<EventRecord>> {
    Ok(events_under(read, &[])?
        .into_iter()
        .map(|(_, r)| r)
        .collect())
}

/// The rows under `parts` (none: every row; a source; a source and a slug), with their keys.
fn events_under(read: &dyn KvRead, parts: &[&str]) -> Result<Vec<(Vec<u8>, EventRecord)>> {
    let mut out = Vec::new();
    for (key, value) in collect_prefix(read, &prefix(parts), false, usize::MAX)? {
        out.push((key, serde_json::from_slice::<EventRecord>(&value)?));
    }
    Ok(out)
}

/// Deletes the rows named by `parts` (a source, or a source and a slug); how many went.
fn delete_under(tx: &mut dyn KvWrite, parts: &[&str]) -> Result<u64> {
    if parts.iter().any(|p| p.contains('\0')) {
        return Ok(0);
    }
    let mut removed = 0;
    for (key, _) in events_under(&*tx, parts)? {
        tx.delete(&key)?;
        removed += 1;
    }
    Ok(removed)
}

/// A source delete removes every row of the source (`scrub_context_volunteer_events`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    delete_under(tx, &[source_id]).map(|_| ())
}

/// The scrub of a hard page delete (`scrubPurgedNameStores`): the rows of each slug of the source.
pub(crate) fn scrub_slugs(tx: &mut dyn KvWrite, source_id: &str, slugs: &[String]) -> Result<u64> {
    let mut removed = 0;
    for slug in slugs {
        removed += delete_under(tx, &[source_id, slug])?;
    }
    Ok(removed)
}

/// The rows a purge verification's inventory probe searches (`crate::facts::purge_probe`): the inventory
/// columns of `context_volunteer_events` as `col::text` prints them.
pub(crate) fn purge_probe_rows(read: &dyn KvRead) -> Result<Vec<ProbeRow>> {
    Ok(all_events(read)?
        .into_iter()
        .map(|r| ProbeRow {
            cells: vec![
                ("source_id", ProbeCell::text(&r.source_id)),
                ("slug", ProbeCell::text(&r.slug)),
                ("match_arm", ProbeCell::text(&r.match_arm)),
                ("rationale", ProbeCell::text(&r.rationale)),
                ("channel", ProbeCell::text(&r.channel)),
                ("session_id", ProbeCell::opt_text(r.session_id.as_deref())),
            ],
            source_id: Some(r.source_id),
        })
        .collect())
}

impl Store {
    /// `insertVolunteerEventRows(rows)`: one multi-row insert of the rows whose page still exists
    /// (deleted or not, as the SQL's `EXISTS (SELECT 1 FROM pages ...)` reads), so a write built before a
    /// page purge and landing after it drops that page's slug and rationale (#9068). All rows are checked
    /// first, so a bad row inserts none, as one statement does. Returns how many rows it wrote.
    pub fn insert_volunteer_event_rows(&self, rows: &[VolunteerEventInput]) -> Result<u64> {
        for row in rows {
            let texts = [
                Some(row.source_id.as_str()),
                Some(row.slug.as_str()),
                Some(row.match_arm.as_str()),
                Some(row.rationale.as_str()),
                Some(row.channel.as_str()),
                row.session_id.as_deref(),
            ];
            if texts.iter().flatten().any(|t| t.contains('\0')) {
                return Err(nul(OP_INSERT));
            }
        }
        if rows.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut written = 0;
            for row in rows {
                if read_page(&*tx, &row.source_id, &row.slug)?.is_none() {
                    continue;
                }
                let id = crate::pages::next_id(tx, NEXT_ID)?;
                let record = EventRecord {
                    id,
                    source_id: row.source_id.clone(),
                    slug: row.slug.clone(),
                    confidence: row.confidence,
                    match_arm: row.match_arm.clone(),
                    rationale: row.rationale.clone(),
                    channel: row.channel.clone(),
                    session_id: row.session_id.clone(),
                    turn: row.turn,
                    volunteered_at_us: now,
                };
                put_json(tx, &key(&row.source_id, &row.slug, id), &record)?;
                written += 1;
            }
            Ok(written)
        })
    }

    /// `listVolunteerChannels(sourceIds)`: the events of the last 7 days per channel, in byte order of the
    /// channel, as `{ channel, n, last_fired }`; `source_ids` `None` reads the whole brain.
    pub fn list_volunteer_channels(&self, source_ids: Option<&[String]>) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut channels: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for r in all_events(&*read)? {
            if r.volunteered_at_us <= now.saturating_sub(CHANNEL_WINDOW_US)
                || source_ids.is_some_and(|ids| !ids.contains(&r.source_id))
            {
                continue;
            }
            let entry = channels.entry(r.channel).or_insert((0, i64::MIN));
            entry.0 += 1;
            entry.1 = entry.1.max(r.volunteered_at_us);
        }
        Ok(channels
            .into_iter()
            .map(|(channel, (n, last))| json!({ "channel": channel, "n": n, "last_fired": iso(last) }))
            .collect())
    }

    /// `listVolunteerUsage(sourceIds, days)`: per `(match_arm, channel)` in byte order, the events of the
    /// sources in the last `days` days (`volunteered`) and those whose live page was retrieved after the
    /// event (`used`), both as the text `count(*)::text` prints. The store keeps no legacy
    /// `pages.last_retrieved_at` column, so the page's retrieval record is the whole `GREATEST(...)`.
    pub fn list_volunteer_usage(&self, source_ids: &[String], days: i64) -> Result<Vec<Value>> {
        let since = self
            .env
            .now_micros()
            .saturating_sub(days.saturating_mul(DAY_US));
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        for r in all_events(&*read)? {
            if r.volunteered_at_us <= since || !source_ids.contains(&r.source_id) {
                continue;
            }
            let used = match read_page(&*read, &r.source_id, &r.slug)? {
                Some(page) if page.deleted_at_us.is_none() => {
                    crate::page_ops::retrievals::last_retrieved_us(&*read, page.id)?
                        .is_some_and(|at| at > r.volunteered_at_us)
                }
                _ => false,
            };
            let entry = groups.entry((r.match_arm, r.channel)).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += u64::from(used);
        }
        Ok(groups
            .into_iter()
            .map(|((match_arm, channel), (volunteered, used))| {
                json!({
                    "match_arm": match_arm, "channel": channel,
                    "volunteered": volunteered.to_string(), "used": used.to_string(),
                })
            })
            .collect())
    }

    /// `deleteVolunteerEventsOlderThan(ttlDays)`: deletes the rows older than `ttl_days` days
    /// (`volunteered_at < now() - interval`) and returns how many. A day count that is not a number refuses,
    /// as the interval cast does.
    pub fn delete_volunteer_events_older_than(&self, ttl_days: f64) -> Result<u64> {
        if !ttl_days.is_finite() {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "{OP_RETENTION}: invalid input syntax for type interval: \"{ttl_days} days\""
                ),
            ));
        }
        self.write(|tx| {
            let cutoff = self.env.now_micros() - (ttl_days * DAY_US as f64).round() as i64;
            let mut removed = 0;
            for (key, record) in events_under(&*tx, &[])? {
                if record.volunteered_at_us < cutoff {
                    tx.delete(&key)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }

    /// `deleteVolunteerEventsForSlugs(sourceId, slugs)`: deletes the rows naming those slugs of the source
    /// (`scrubPurgedNameStores`) and returns how many.
    pub fn delete_volunteer_events_for_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<u64> {
        if slugs.is_empty() {
            return Ok(0);
        }
        self.write(|tx| scrub_slugs(tx, source_id, slugs))
    }

    /// `countVolunteerEventsForSlug(sourceId, slug)`: how many rows still name the slug (the purge
    /// verification's `context_volunteer_events` check).
    pub fn count_volunteer_events_for_slug(&self, source_id: &str, slug: &str) -> Result<u64> {
        if source_id.contains('\0') || slug.contains('\0') {
            return Ok(0);
        }
        let read = self.read()?;
        Ok(events_under(&*read, &[source_id, slug])?.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_reads::pg_text::pg_lower;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn put(s: &Store, slug: &str) {
        let input: PageInput = serde_json::from_value(
            json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") }),
        )
        .unwrap();
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }

    fn row(source: &str, slug: &str, channel: &str) -> VolunteerEventInput {
        VolunteerEventInput {
            source_id: source.into(),
            slug: slug.into(),
            confidence: 0.9,
            match_arm: "exact".into(),
            rationale: format!("matched {slug}"),
            channel: channel.into(),
            session_id: None,
            turn: Some(2),
        }
    }

    #[test]
    fn keys_of_a_slug_never_cover_another_slug() {
        assert!(key("s", "a", 1).starts_with(&prefix(&["s", "a"])));
        assert!(!key("s", "ab", 1).starts_with(&prefix(&["s", "a"])));
        assert!(!key("sx", "a", 1).starts_with(&prefix(&["s"])));
    }

    #[test]
    fn the_insert_drops_rows_of_pages_that_do_not_exist() {
        let s = store();
        put(&s, "notes/a");
        let wrote = s
            .insert_volunteer_event_rows(&[
                row("default", "notes/a", "op"),
                row("default", "notes/gone", "op"),
            ])
            .unwrap();
        assert_eq!(wrote, 1);
        assert_eq!(
            s.count_volunteer_events_for_slug("default", "notes/a")
                .unwrap(),
            1
        );
        assert_eq!(
            s.count_volunteer_events_for_slug("default", "notes/gone")
                .unwrap(),
            0
        );
        assert_eq!(s.insert_volunteer_event_rows(&[]).unwrap(), 0);
    }

    #[test]
    fn a_nul_byte_refuses_the_whole_batch() {
        let s = store();
        put(&s, "notes/a");
        let err = s
            .insert_volunteer_event_rows(&[
                row("default", "notes/a", "op"),
                row("default", "notes/a", "o\0p"),
            ])
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert_eq!(
            s.count_volunteer_events_for_slug("default", "notes/a")
                .unwrap(),
            0
        );
    }

    #[test]
    fn channels_list_in_byte_order_scoped_and_brain_wide() {
        let s = store();
        put(&s, "notes/a");
        s.insert_volunteer_event_rows(&[
            row("default", "notes/a", "b"),
            row("default", "notes/a", "a-z"),
            row("default", "notes/a", "ab"),
            row("default", "notes/a", "a-z"),
        ])
        .unwrap();
        let names = |rows: Vec<Value>| -> Vec<(String, i64)> {
            rows.iter()
                .map(|r| {
                    (
                        r["channel"].as_str().unwrap().to_string(),
                        r["n"].as_i64().unwrap(),
                    )
                })
                .collect()
        };
        let all = names(s.list_volunteer_channels(None).unwrap());
        assert_eq!(
            all,
            vec![("a-z".into(), 2), ("ab".into(), 1), ("b".into(), 1)]
        );
        let scoped = s
            .list_volunteer_channels(Some(&["default".to_string()]))
            .unwrap();
        assert_eq!(names(scoped), all);
        assert!(
            s.list_volunteer_channels(Some(&["other".to_string()]))
                .unwrap()
                .is_empty()
        );
        assert!(s.list_volunteer_channels(Some(&[])).unwrap().is_empty());
    }

    #[test]
    fn usage_counts_events_and_retrievals_by_arm_and_channel() {
        let s = store();
        put(&s, "notes/a");
        s.insert_volunteer_event_rows(&[
            row("default", "notes/a", "op"),
            row("default", "notes/a", "hook"),
        ])
        .unwrap();
        let rows = s
            .list_volunteer_usage(&["default".to_string()], 30)
            .unwrap();
        let shown: Vec<(&str, &str, &str, &str)> = rows
            .iter()
            .map(|r| {
                (
                    r["match_arm"].as_str().unwrap(),
                    r["channel"].as_str().unwrap(),
                    r["volunteered"].as_str().unwrap(),
                    r["used"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![("exact", "hook", "1", "0"), ("exact", "op", "1", "0")]
        );
        assert!(
            s.list_volunteer_usage(&["other".to_string()], 30)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn retention_deletes_only_rows_older_than_the_window() {
        let s = store();
        put(&s, "notes/a");
        s.insert_volunteer_event_rows(&[row("default", "notes/a", "op")])
            .unwrap();
        assert_eq!(s.delete_volunteer_events_older_than(90.0).unwrap(), 0);
        assert_eq!(s.delete_volunteer_events_older_than(-1.0).unwrap(), 1);
        assert!(s.delete_volunteer_events_older_than(f64::NAN).is_err());
    }

    #[test]
    fn a_slug_scrub_and_a_source_delete_remove_the_rows() {
        let s = store();
        put(&s, "notes/a");
        put(&s, "notes/b");
        s.insert_volunteer_event_rows(&[
            row("default", "notes/a", "op"),
            row("default", "notes/b", "op"),
        ])
        .unwrap();
        assert_eq!(
            s.delete_volunteer_events_for_slugs("default", &[]).unwrap(),
            0
        );
        assert_eq!(
            s.delete_volunteer_events_for_slugs("default", &["notes/a".to_string()])
                .unwrap(),
            1
        );
        assert_eq!(
            s.count_volunteer_events_for_slug("default", "notes/b")
                .unwrap(),
            1
        );
        s.write(|tx| remove_source_rows(tx, "default")).unwrap();
        assert_eq!(
            s.count_volunteer_events_for_slug("default", "notes/b")
                .unwrap(),
            0
        );
    }

    #[test]
    fn the_probe_rows_carry_the_rationale() {
        let s = store();
        put(&s, "notes/a");
        s.insert_volunteer_event_rows(&[row("default", "notes/a", "op")])
            .unwrap();
        let rows = purge_probe_rows(&*s.read().unwrap()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_id.as_deref(), Some("default"));
        let rationale = rows[0]
            .cells
            .iter()
            .find(|(n, _)| *n == "rationale")
            .unwrap();
        assert!(matches!(&rationale.1, ProbeCell::Text(t) if pg_lower(t) == "matched notes/a"));
    }
}
