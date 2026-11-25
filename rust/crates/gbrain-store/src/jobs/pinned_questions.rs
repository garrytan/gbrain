//! Jobs: the `pinned_questions` table as the members of `src/core/engine-sql/collate-store-reads.ts` run it
//! (rust/docs/store/pinned-questions.md): the idempotent pin insert, the read of one pin and the listing the question
//! refresh cycle walks.
//!
//! Members: insertPinnedQuestion, readPinnedQuestion, listPinnedQuestions.
//!
//! Keys, under the family's own two-byte tag `keys::QUESTIONS` (`~q`, the interfaces lane's allotment; this file only):
//! - `~q 0x01 id -> PinRecord`: one pin, the whole row (30 columns, with the defaults the table gives them), the id the
//!   `BIGSERIAL` of the `pinned_questions_id` sequence (`m 0x00 pinned_questions`, the jobs family's sequence store).
//! - `~q 0x02 source_id \0 slug -> id`: the unique `(source_id, slug)` index (`pinned_questions_source_slug_key`).
//!
//! Kept: every column the TypeScript row reads. Not kept: `updated_at` (no member reads it) and the secondary index
//! `pinned_questions_state_idx` (a listing scans the table). The pin's state changes, its refresh lease and its answer
//! publish stay on the SQL engines (`src/core/questions/store.ts`, `refresh.ts`): a Rust brain serves the insert and the
//! two reads, so a pin made here is listed here, and the lease and answer writes refuse as raw SQL.

use super::*;
use crate::env::iso;
use crate::links::no_nul;

const PIN: u8 = 0x01;
const PIN_SLUG: u8 = 0x02;
const SEQUENCE: &str = "pinned_questions";
const OP_INSERT: &str = "insertPinnedQuestion";

/// `~q <sub>`: the start of every key of one pinned-questions table.
fn questions(sub: u8) -> Vec<u8> {
    let mut k = keys::QUESTIONS.to_vec();
    k.push(sub);
    k
}

fn pin_key(id: i64) -> Vec<u8> {
    let mut k = questions(PIN);
    k.extend_from_slice(&signed_key(id));
    k
}

fn slug_key(source_id: &str, slug: &str) -> Vec<u8> {
    let mut k = questions(PIN_SLUG);
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
    k.extend_from_slice(slug.as_bytes());
    k
}

/// One `pinned_questions` row. Times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PinRecord {
    id: i64,
    source_id: String,
    slug: String,
    question: String,
    scope_slug_prefix: Option<String>,
    scope_entity: Option<String>,
    state: String,
    inactive_reason: Option<String>,
    publish_mode: String,
    model: Option<String>,
    cooldown_days: Option<f64>,
    origin: String,
    created_by: String,
    revision: i64,
    answer_revision: i32,
    answer: Option<String>,
    answer_model: Option<String>,
    last_refresh_at: Option<i64>,
    last_attempt_at: Option<i64>,
    last_error: Option<String>,
    watermark_generation: Option<i64>,
    watermark_fact_id: Option<i64>,
    watermark_at: Option<i64>,
    lease_token: Option<String>,
    lease_owner: Option<String>,
    lease_expires_at: Option<i64>,
    refresh_attempts: i32,
    spend_usd: f64,
    created_at: i64,
    archived_at: Option<i64>,
}

impl PinRecord {
    /// The row as `SELECT <columns>` returns it on the SQL engines: times as ISO text.
    fn to_row(&self) -> Value {
        let t = |m: Option<i64>| m.map(iso);
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "slug": self.slug,
            "question": self.question,
            "scope_slug_prefix": self.scope_slug_prefix,
            "scope_entity": self.scope_entity,
            "state": self.state,
            "inactive_reason": self.inactive_reason,
            "publish_mode": self.publish_mode,
            "model": self.model,
            "cooldown_days": self.cooldown_days,
            "origin": self.origin,
            "created_by": self.created_by,
            "revision": self.revision,
            "answer_revision": self.answer_revision,
            "answer": self.answer,
            "answer_model": self.answer_model,
            "last_refresh_at": t(self.last_refresh_at),
            "last_attempt_at": t(self.last_attempt_at),
            "last_error": self.last_error,
            "watermark_generation": self.watermark_generation,
            "watermark_fact_id": self.watermark_fact_id,
            "watermark_at": t(self.watermark_at),
            "lease_token": self.lease_token,
            "lease_owner": self.lease_owner,
            "lease_expires_at": t(self.lease_expires_at),
            "refresh_attempts": self.refresh_attempts,
            "spend_usd": self.spend_usd,
            "created_at": iso(self.created_at),
            "archived_at": t(self.archived_at),
        })
    }
}

/// `insertPinnedQuestion(row)`: the columns `insertPin` writes; the others take the table's defaults.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInsert {
    pub source_id: Option<String>,
    pub slug: Option<String>,
    pub question: Option<String>,
    #[serde(default)]
    pub scope_slug_prefix: Option<String>,
    #[serde(default)]
    pub scope_entity: Option<String>,
    pub state: Option<String>,
    #[serde(default)]
    pub inactive_reason: Option<String>,
    pub publish_mode: Option<String>,
    pub created_by: Option<String>,
}

/// `listPinnedQuestions(filter)`: `sourceIds` and `states` are `= ANY(...)` lists; `states` absent keeps every pin but the
/// archived ones unless `includeArchived`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinFilter {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub states: Option<Vec<String>>,
    #[serde(default)]
    pub include_archived: bool,
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"pinned_questions\" violates not-null constraint"
        ),
    )
}

fn all_pins(read: &dyn KvRead) -> Result<Vec<PinRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &questions(PIN), false, &mut |_, v| {
        match serde_json::from_slice::<PinRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::invalid(format!("unreadable pin record: {e}")));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

impl Store {
    /// `insertPinnedQuestion(row)`: the new pin's row, or None when `(source_id, slug)` has one (`ON CONFLICT DO NOTHING`).
    /// A null `source_id`, `slug`, `question`, `state`, `publish_mode` or `created_by` refuses with
    /// `constraint_violation`; a NUL byte in a text with `invalid_argument`.
    pub fn insert_pinned_question(&self, row: &PinInsert) -> Result<Option<Value>> {
        let source_id = row.source_id.clone().ok_or_else(|| not_null("source_id"))?;
        let slug = row.slug.clone().ok_or_else(|| not_null("slug"))?;
        let question = row.question.clone().ok_or_else(|| not_null("question"))?;
        let created_by = row
            .created_by
            .clone()
            .ok_or_else(|| not_null("created_by"))?;
        let state = row.state.clone().ok_or_else(|| not_null("state"))?;
        let publish_mode = row
            .publish_mode
            .clone()
            .ok_or_else(|| not_null("publish_mode"))?;
        let mut texts: Vec<(&str, &str)> = vec![
            ("source_id", &source_id),
            ("slug", &slug),
            ("question", &question),
            ("created_by", &created_by),
            ("state", &state),
            ("publish_mode", &publish_mode),
        ];
        for (name, value) in [
            ("scope_slug_prefix", &row.scope_slug_prefix),
            ("scope_entity", &row.scope_entity),
            ("inactive_reason", &row.inactive_reason),
        ] {
            if let Some(v) = value.as_deref() {
                texts.push((name, v));
            }
        }
        no_nul(OP_INSERT, &texts)?;
        self.write(|tx| {
            if get_json::<i64>(tx, &slug_key(&source_id, &slug))?.is_some() {
                return Ok(None);
            }
            let id = next_seq(tx, SEQUENCE)?;
            let record = PinRecord {
                id,
                source_id: source_id.clone(),
                slug: slug.clone(),
                question,
                scope_slug_prefix: row.scope_slug_prefix.clone(),
                scope_entity: row.scope_entity.clone(),
                state,
                inactive_reason: row.inactive_reason.clone(),
                publish_mode,
                model: None,
                cooldown_days: None,
                origin: "pin".to_string(),
                created_by,
                revision: 1,
                answer_revision: 0,
                answer: None,
                answer_model: None,
                last_refresh_at: None,
                last_attempt_at: None,
                last_error: None,
                watermark_generation: None,
                watermark_fact_id: None,
                watermark_at: None,
                lease_token: None,
                lease_owner: None,
                lease_expires_at: None,
                refresh_attempts: 0,
                spend_usd: 0.0,
                created_at: self.env.now_micros(),
                archived_at: None,
            };
            put_json(tx, &pin_key(id), &record)?;
            put_json(tx, &slug_key(&source_id, &slug), &id)?;
            Ok(Some(record.to_row()))
        })
    }

    /// `readPinnedQuestion(sourceId, slug)`: the row of the pin, or None.
    pub fn read_pinned_question(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(id) = get_json::<i64>(&*read, &slug_key(source_id, slug))? else {
            return Ok(None);
        };
        Ok(get_json::<PinRecord>(&*read, &pin_key(id))?.map(|p| p.to_row()))
    }

    /// `listPinnedQuestions(filter)`: the rows by source id in byte order (`ORDER BY source_id COLLATE "C"`), then by
    /// creation time, then by id.
    pub fn list_pinned_questions(&self, filter: &PinFilter) -> Result<Value> {
        let read = self.read()?;
        let mut pins: Vec<PinRecord> = all_pins(&*read)?
            .into_iter()
            .filter(|p| {
                filter
                    .source_ids
                    .as_ref()
                    .is_none_or(|s| s.contains(&p.source_id))
            })
            .filter(|p| match &filter.states {
                Some(states) => states.contains(&p.state),
                None => filter.include_archived || p.state != "archived",
            })
            .collect();
        pins.sort_by(|a, b| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then(a.created_at.cmp(&b.created_at))
                .then(a.id.cmp(&b.id))
        });
        Ok(Value::Array(pins.iter().map(PinRecord::to_row).collect()))
    }
}

#[cfg(test)]
mod key_layout {
    use super::*;

    /// The pins live under their own two-byte tag `~q` (the interfaces lane's allotment), not under `keys::JOBS`:
    /// `m 0x2D` and `m 0x2E` are `OAUTH_CODE` and `AUDIT` on rust-engine/main.
    #[test]
    fn a_pin_and_its_slug_index_are_keyed_under_the_questions_tag() {
        let mut row = vec![b'~', b'q', 0x01];
        row.extend_from_slice(&signed_key(7));
        assert_eq!(pin_key(7), row);
        assert_eq!(
            slug_key("default", "notes/a"),
            b"~q\x02default\x00notes/a".to_vec()
        );
        assert_ne!(pin_key(7)[0], keys::JOBS);
    }
}
