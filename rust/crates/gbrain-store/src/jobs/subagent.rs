//! Jobs: the subagent transcript and tool ledger, `subagent_messages` and `subagent_tool_executions`
//! (engine-sql/jobs-subagent.ts, rust/docs/store/jobs-subagent.md). The subagent handler, the oneshot
//! runner, crash replay, the transcript views, the read budget and the dream cycle's provenance
//! reads reach these tables through 17 members; this file is all of them.
//!
//! Keys, under `keys::JOBS` (`m`), sub-tags `0x18..=0x1F` (the other jobs files hold `0x00..=0x17`):
//! - `m 0x18 job message_idx -> MessageRecord`: one model turn (the unique `(job_id, message_idx)`).
//!   Ids come from the `subagent_message` sequence.
//! - `m 0x19 job id -> ToolRecord`: one tool call. Ids come from the `subagent_tool` sequence.
//! - `m 0x1A job message_idx ordinal -> id`: `subagent_tool_executions_stable_id`, the unique
//!   `(job_id, message_idx, ordinal)` position. A row without an ordinal (a legacy row) is not in it,
//!   as a NULL never conflicts.
//! - `m 0x1B uuid_text \0 job id`: every row by `gbrain_tool_use_id`, not unique (a settle by stable id
//!   touches each match).
//! - `m 0x1C job message_idx id`: the legacy (NULL ordinal) rows of a turn, which a positional settle
//!   falls back to and the legacy guard looks for.
//!
//! A row is written once and then only settled: no update moves its job, turn, ordinal or stable id, so
//! the indexes are written with the row and removed with it (deleting a job). A JSON column is kept as
//! the value given; reads return it in the key order Postgres prints a `jsonb` (`jsonb::ordered`). A
//! tool `output` is kept as its JSON text, so a JSON null output stays distinct from a SQL NULL one.
//!
//! The same refusals the SQL has: a missing job (the foreign key), a role outside user/assistant, a
//! status outside pending/complete/failed, text that is not JSON, a stable id that is not a UUID, and an
//! `INTEGER` outside 32 bits. A write that refuses writes nothing.

use super::*;
use crate::dream::jsonb_check;
use crate::journal::RequestRecord;
use crate::timeline_queries::jsonb_text;

const MSG: u8 = 0x18;
const TOOL: u8 = 0x19;
const POSITION: u8 = 0x1A;
const STABLE: u8 = 0x1B;
const LEGACY: u8 = 0x1C;

const PUT_PAGE: &str = "brain_put_page";
const TIMELINE_ENTRY: &str = "brain_add_timeline_entry";

fn msg_prefix(job: i64) -> Vec<u8> {
    let mut k = prefix(MSG);
    k.extend_from_slice(&signed_key(job));
    k
}

fn msg_key(job: i64, idx: i64) -> Vec<u8> {
    let mut k = msg_prefix(job);
    k.extend_from_slice(&signed_key(idx));
    k
}

fn tool_prefix(job: i64) -> Vec<u8> {
    let mut k = prefix(TOOL);
    k.extend_from_slice(&signed_key(job));
    k
}

fn tool_key(job: i64, id: i64) -> Vec<u8> {
    let mut k = tool_prefix(job);
    k.extend_from_slice(&signed_key(id));
    k
}

fn position_key(job: i64, idx: i64, ordinal: i64) -> Vec<u8> {
    let mut k = prefix(POSITION);
    for part in [job, idx, ordinal] {
        k.extend_from_slice(&signed_key(part));
    }
    k
}

fn stable_prefix(uuid: &str) -> Vec<u8> {
    let mut k = prefix(STABLE);
    k.extend_from_slice(uuid.as_bytes());
    k.push(0);
    k
}

fn stable_key(uuid: &str, job: i64, id: i64) -> Vec<u8> {
    let mut k = stable_prefix(uuid);
    k.extend_from_slice(&signed_key(job));
    k.extend_from_slice(&signed_key(id));
    k
}

fn legacy_prefix(job: i64, idx: i64) -> Vec<u8> {
    let mut k = prefix(LEGACY);
    k.extend_from_slice(&signed_key(job));
    k.extend_from_slice(&signed_key(idx));
    k
}

fn legacy_key(job: i64, idx: i64, id: i64) -> Vec<u8> {
    let mut k = legacy_prefix(job, idx);
    k.extend_from_slice(&signed_key(id));
    k
}

/// One `subagent_messages` row. Timestamps are µs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MessageRecord {
    id: i64,
    job_id: i64,
    message_idx: i64,
    role: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    content_blocks: Value,
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
    tokens_cache_read: Option<i64>,
    tokens_cache_create: Option<i64>,
    model: Option<String>,
    ended_at: i64,
}

impl MessageRecord {
    fn view(&self) -> Value {
        json!({
            "id": self.id,
            "job_id": self.job_id,
            "message_idx": self.message_idx,
            "role": self.role,
            "content_blocks": ordered(&self.content_blocks),
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tokens_cache_read": self.tokens_cache_read,
            "tokens_cache_create": self.tokens_cache_create,
            "model": self.model,
            "ended_at": iso(self.ended_at),
        })
    }
}

/// One `subagent_tool_executions` row. Timestamps are µs; `output` is JSON text (None: SQL NULL).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolRecord {
    id: i64,
    job_id: i64,
    message_idx: i64,
    ordinal: Option<i64>,
    tool_use_id: String,
    tool_name: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    input: Value,
    status: String,
    output: Option<String>,
    error: Option<String>,
    schema_version: i64,
    provider_id: Option<String>,
    gbrain_tool_use_id: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
}

impl ToolRecord {
    fn output_value(&self) -> Result<Option<Value>> {
        match &self.output {
            None => Ok(None),
            Some(text) => Ok(Some(serde_json::from_str(text)?)),
        }
    }

    fn output_json(&self) -> Result<Value> {
        Ok(self.output_value()?.map_or(Value::Null, |v| ordered(&v)))
    }

    fn view(&self) -> Result<Value> {
        Ok(json!({
            "id": self.id,
            "job_id": self.job_id,
            "message_idx": self.message_idx,
            "ordinal": self.ordinal,
            "tool_use_id": self.tool_use_id,
            "tool_name": self.tool_name,
            "input": ordered(&self.input),
            "status": self.status,
            "output": self.output_json()?,
            "error": self.error,
            "schema_version": self.schema_version,
            "provider_id": self.provider_id,
            "gbrain_tool_use_id": self.gbrain_tool_use_id,
            "started_at": iso(self.started_at),
            "ended_at": self.ended_at.map(iso),
        }))
    }
}

/// `insertSubagentMessage`: the message to persist (`content_blocks` is JSON text).
#[derive(Debug, Clone, Deserialize)]
pub struct MessageInsert {
    pub message_idx: i64,
    pub role: String,
    pub content_blocks: String,
    #[serde(default)]
    pub tokens_in: Option<i64>,
    #[serde(default)]
    pub tokens_out: Option<i64>,
    #[serde(default)]
    pub tokens_cache_read: Option<i64>,
    #[serde(default)]
    pub tokens_cache_create: Option<i64>,
    #[serde(default)]
    pub model: Option<String>,
}

/// `recordSubagentToolExecutions`: a tool row to bank (`input` is JSON text). No ordinal: a legacy row.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolInsert {
    pub message_idx: i64,
    #[serde(default)]
    pub ordinal: Option<i64>,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: String,
    pub status: String,
}

/// `startSubagentToolExecution`: the first observation of a gateway tool call.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolStart {
    pub message_idx: i64,
    pub ordinal: i64,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: String,
    pub gbrain_tool_use_id: String,
    pub provider_id: String,
}

/// The row a settle touches: by stable id (every match) or by position (one row, never a complete one).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ToolTarget {
    Stable {
        #[serde(rename = "gbrainToolUseId")]
        gbrain_tool_use_id: String,
    },
    Position {
        #[serde(rename = "jobId")]
        job_id: i64,
        #[serde(rename = "messageIdx")]
        message_idx: i64,
        ordinal: i64,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
    },
}

/// `failSubagentToolExecution`'s fallback: the row to insert when the position has none.
#[derive(Debug, Clone, Deserialize)]
pub struct FailureFallback {
    pub tool_name: String,
    pub input: String,
}

fn constraint(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

/// An `INTEGER` column: 32 bits.
fn int4(value: i64, what: &str) -> Result<i64> {
    if i32::try_from(value).is_err() {
        return Err(StoreError::invalid(format!(
            "{what}: {value} is out of range for type integer"
        )));
    }
    Ok(value)
}

fn int4_opt(value: Option<i64>, what: &str) -> Result<Option<i64>> {
    value.map(|v| int4(v, what)).transpose()
}

/// A `::text::jsonb` parameter: text that is not JSON, or that holds U+0000, is refused.
fn parse_json(text: &str, what: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| StoreError::invalid(format!("{what}: invalid input syntax for type json")))?;
    jsonb_check("subagent", what, &value)?;
    Ok(value)
}

fn check_status(status: &str) -> Result<()> {
    if matches!(status, "pending" | "complete" | "failed") {
        return Ok(());
    }
    Err(constraint(
        "subagent_tool_executions check: chk_subagent_tools_status",
    ))
}

fn require_job(read: &dyn KvRead, job_id: i64, table: &str) -> Result<()> {
    if load(read, job_id)?.is_none() {
        return Err(constraint(format!(
            "{table} foreign key: job {job_id} does not exist"
        )));
    }
    Ok(())
}

/// A `uuid` parameter's canonical text: the 8-4-4-4-12 or the 32-digit form, in any case.
fn uuid_text(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let hex = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_hexdigit());
    match lower.len() {
        36 if crate::env::is_uuid(&lower) => Some(lower),
        32 if hex(&lower) => Some(format!(
            "{}-{}-{}-{}-{}",
            &lower[0..8],
            &lower[8..12],
            &lower[12..16],
            &lower[16..20],
            &lower[20..32]
        )),
        _ => None,
    }
}

/// SQL `LIKE` with the default escape: `%` any run, `_` one character, `\` takes the next one literally.
fn like(pattern: &[char], text: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('%', rest)) => (0..=text.len()).any(|i| like(rest, &text[i..])),
        Some(('_', rest)) => !text.is_empty() && like(rest, &text[1..]),
        Some(('\\', rest)) => match rest.split_first() {
            Some((c, rest)) => text.first() == Some(c) && like(rest, &text[1..]),
            None => false,
        },
        Some((c, rest)) => text.first() == Some(c) && like(rest, &text[1..]),
    }
}

/// `column LIKE prefix || '%'`.
fn has_prefix(text: &str, prefix: &str) -> bool {
    let pattern: Vec<char> = format!("{prefix}%").chars().collect();
    let text: Vec<char> = text.chars().collect();
    like(&pattern, &text)
}

fn load_tool(read: &dyn KvRead, job: i64, id: i64) -> Result<Option<ToolRecord>> {
    get_json(read, &tool_key(job, id))
}

/// A job's tool rows, `id` order.
fn tools_of(read: &dyn KvRead, job: i64) -> Result<Vec<ToolRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &tool_prefix(job),
        false,
        &mut |_, v| match serde_json::from_slice(v) {
            Ok(row) => {
                rows.push(row);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(rows),
    }
}

/// The tool rows of every named job (once each), `id` order across them.
fn tools_of_jobs(read: &dyn KvRead, jobs: &[i64]) -> Result<Vec<ToolRecord>> {
    let mut rows = Vec::new();
    for job in jobs.iter().collect::<BTreeSet<_>>() {
        rows.extend(tools_of(read, *job)?);
    }
    rows.sort_by_key(|r| r.id);
    Ok(rows)
}

fn save_new_tool(tx: &mut dyn KvWrite, row: &ToolRecord) -> Result<()> {
    put_json(tx, &tool_key(row.job_id, row.id), row)?;
    match row.ordinal {
        Some(ordinal) => put_json(
            tx,
            &position_key(row.job_id, row.message_idx, ordinal),
            &row.id,
        )?,
        None => put_json(
            tx,
            &legacy_key(row.job_id, row.message_idx, row.id),
            &row.id,
        )?,
    }
    if let Some(uuid) = &row.gbrain_tool_use_id {
        put_json(tx, &stable_key(uuid, row.job_id, row.id), &row.id)?;
    }
    Ok(())
}

fn keys_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut found = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        found.push(k.to_vec());
        true
    })?;
    Ok(found)
}

/// The legacy (NULL ordinal) rows of a turn, `id` order.
fn legacy_rows(read: &dyn KvRead, job: i64, idx: i64) -> Result<Vec<ToolRecord>> {
    let mut rows = Vec::new();
    for key in keys_under(read, &legacy_prefix(job, idx))? {
        if let Some(id) = last_id(&key) {
            rows.extend(load_tool(read, job, id)?);
        }
    }
    Ok(rows)
}

/// The row at a position: the one with that ordinal, when there is one.
fn row_at(read: &dyn KvRead, job: i64, idx: i64, ordinal: i64) -> Result<Option<ToolRecord>> {
    match get_json::<i64>(read, &position_key(job, idx, ordinal))? {
        Some(id) => load_tool(read, job, id),
        None => Ok(None),
    }
}

/// The row a positional settle takes (`POSITION_ROW`): same job, turn and tool id, not complete; the row
/// with its own ordinal before a legacy one, then the lower id.
fn position_row(
    read: &dyn KvRead,
    job: i64,
    idx: i64,
    tool_use_id: &str,
    ordinal: i64,
) -> Result<Option<ToolRecord>> {
    let settleable = |r: &ToolRecord| r.tool_use_id == tool_use_id && r.status != "complete";
    if let Some(own) = row_at(read, job, idx, ordinal)?.filter(settleable) {
        return Ok(Some(own));
    }
    Ok(legacy_rows(read, job, idx)?.into_iter().find(settleable))
}

/// The rows named by a settle target, with the write time already known to the caller.
fn target_rows(read: &dyn KvRead, target: &ToolTarget) -> Result<Vec<ToolRecord>> {
    match target {
        ToolTarget::Stable { gbrain_tool_use_id } => {
            let mut rows = Vec::new();
            for key in keys_under(read, &stable_prefix(gbrain_tool_use_id))? {
                let head = key.len().saturating_sub(8);
                let (Some(job), Some(id)) = (last_id(&key[..head]), last_id(&key)) else {
                    continue;
                };
                rows.extend(load_tool(read, job, id)?);
            }
            Ok(rows)
        }
        ToolTarget::Position {
            job_id,
            message_idx,
            ordinal,
            tool_use_id,
        } => Ok(
            position_row(read, *job_id, *message_idx, tool_use_id, *ordinal)?
                .into_iter()
                .collect(),
        ),
    }
}

/// A `COALESCE(input->>field, (input #>> '{}')::jsonb->>field)` read: the field of an object input, or of
/// the object a double-encoded (jsonb string) input holds. A string that is not JSON refuses, as the cast
/// does; any other input names nothing.
fn input_field(input: &Value, field: &str) -> Result<Option<String>> {
    match input {
        Value::Object(map) => Ok(map.get(field).and_then(jsonb_field_text)),
        Value::String(text) => {
            let inner: Value = serde_json::from_str(text).map_err(|_| {
                StoreError::invalid("invalid input syntax for type json: a tool input string")
            })?;
            Ok(inner
                .as_object()
                .and_then(|m| m.get(field))
                .and_then(jsonb_field_text))
        }
        _ => Ok(None),
    }
}

/// `output->>field`.
fn output_field(row: &ToolRecord, field: &str) -> Result<Option<String>> {
    Ok(row.output_value()?.and_then(|v| {
        v.as_object()
            .and_then(|m| m.get(field))
            .and_then(jsonb_field_text)
    }))
}

/// `input->>field`: a field of an object input only.
fn plain_input_field(row: &ToolRecord, field: &str) -> Option<String> {
    row.input
        .as_object()
        .and_then(|m| m.get(field))
        .and_then(jsonb_field_text)
}

/// Deletes a job's messages and tool rows with their indexes (`ON DELETE CASCADE`).
pub(super) fn delete_job_rows(tx: &mut dyn KvWrite, job: i64) -> Result<()> {
    for key in keys_under(tx, &msg_prefix(job))? {
        tx.delete(&key)?;
    }
    for row in tools_of(tx, job)? {
        tx.delete(&tool_key(job, row.id))?;
        match row.ordinal {
            Some(ordinal) => tx.delete(&position_key(job, row.message_idx, ordinal))?,
            None => tx.delete(&legacy_key(job, row.message_idx, row.id))?,
        }
        if let Some(uuid) = &row.gbrain_tool_use_id {
            tx.delete(&stable_key(uuid, job, row.id))?;
        }
    }
    Ok(())
}

impl Store {
    // ---------------------------------------------------------------- messages

    /// `listSubagentMessages(jobId, { last })`: the job's messages by `message_idx`; only the newest with `last`.
    pub fn list_subagent_messages(&self, job_id: i64, last: bool) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows: Vec<MessageRecord> = Vec::new();
        let mut bad = None;
        scan_prefix(
            &*read,
            &msg_prefix(job_id),
            last,
            &mut |_, v| match serde_json::from_slice(v) {
                Ok(row) => {
                    rows.push(row);
                    !last
                }
                Err(e) => {
                    bad = Some(e);
                    false
                }
            },
        )?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        Ok(rows.iter().map(MessageRecord::view).collect())
    }

    /// `countSubagentMessages(jobId)`.
    pub fn count_subagent_messages(&self, job_id: i64) -> Result<i64> {
        Ok(keys_under(&*self.read()?, &msg_prefix(job_id))?.len() as i64)
    }

    /// `insertSubagentMessage`: a message already at the `message_idx` stays as it is.
    pub fn insert_subagent_message(&self, job_id: i64, m: &MessageInsert) -> Result<()> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let content_blocks = parse_json(&m.content_blocks, "content_blocks")?;
            int4(m.message_idx, "message_idx")?;
            for (v, what) in [
                (m.tokens_in, "tokens_in"),
                (m.tokens_out, "tokens_out"),
                (m.tokens_cache_read, "tokens_cache_read"),
                (m.tokens_cache_create, "tokens_cache_create"),
            ] {
                int4_opt(v, what)?;
            }
            if !matches!(m.role.as_str(), "user" | "assistant") {
                return Err(constraint(
                    "subagent_messages check: chk_subagent_messages_role",
                ));
            }
            let key = msg_key(job_id, m.message_idx);
            if get_json::<Value>(tx, &key)?.is_some() {
                return Ok(());
            }
            require_job(tx, job_id, "subagent_messages")?;
            let id = next_seq(tx, "subagent_message")?;
            put_json(
                tx,
                &key,
                &MessageRecord {
                    id,
                    job_id,
                    message_idx: m.message_idx,
                    role: m.role.clone(),
                    content_blocks,
                    tokens_in: m.tokens_in,
                    tokens_out: m.tokens_out,
                    tokens_cache_read: m.tokens_cache_read,
                    tokens_cache_create: m.tokens_cache_create,
                    model: m.model.clone(),
                    ended_at: now,
                },
            )
        })
    }

    // ---------------------------------------------------------------- tool ledger reads

    /// `listSubagentToolExecutions(jobId, order)`: `replay` is (`message_idx`, ordinal with NULL as 0, `id`);
    /// otherwise `id` order.
    pub fn list_subagent_tool_executions(&self, job_id: i64, replay: bool) -> Result<Vec<Value>> {
        let mut rows = tools_of(&*self.read()?, job_id)?;
        if replay {
            rows.sort_by_key(|r| (r.message_idx, r.ordinal.unwrap_or(0), r.id));
        }
        rows.iter().map(ToolRecord::view).collect()
    }

    /// `hasSubagentToolExecution`: a row of `status` (any when None) whose `tool_use_id` is `LIKE prefix || '%'`.
    pub fn has_subagent_tool_execution(
        &self,
        job_id: i64,
        status: Option<&str>,
        tool_use_id_prefix: Option<&str>,
    ) -> Result<bool> {
        Ok(tools_of(&*self.read()?, job_id)?.iter().any(|r| {
            status.is_none_or(|s| r.status == s)
                && tool_use_id_prefix.is_none_or(|p| has_prefix(&r.tool_use_id, p))
        }))
    }

    /// `listSubagentWriteOutcomes`: the `brain_put_page` rows' status, error and output, by `id`.
    pub fn list_subagent_write_outcomes(
        &self,
        job_id: i64,
        tool_use_id_prefix: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        for r in tools_of(&*self.read()?, job_id)? {
            if r.tool_name == PUT_PAGE
                && tool_use_id_prefix.is_none_or(|p| has_prefix(&r.tool_use_id, p))
            {
                out.push(json!({"status": r.status, "error": r.error, "output": r.output_json()?}));
            }
        }
        Ok(out)
    }

    /// `listSubagentOneshotLedger`: rows whose `tool_use_id` is `LIKE prefix || '%'`, by `id`, with their
    /// input fields as text.
    pub fn list_subagent_oneshot_ledger(&self, job_id: i64, prefix: &str) -> Result<Vec<Value>> {
        Ok(tools_of(&*self.read()?, job_id)?
            .iter()
            .filter(|r| has_prefix(&r.tool_use_id, prefix))
            .map(|r| {
                json!({
                    "tool_use_id": r.tool_use_id,
                    "ordinal": r.ordinal,
                    "status": r.status,
                    "slug": plain_input_field(r, "slug"),
                    "content": plain_input_field(r, "content"),
                    "request_id": plain_input_field(r, "request_id"),
                    "skip_reason": plain_input_field(r, "skip_reason"),
                    "batch_id": plain_input_field(r, "batch_id"),
                })
            })
            .collect())
    }

    /// `summarizeSubagentToolExecutions`: `{ count, output_bytes }` of the jobs' rows of `tool_name` in
    /// `status`; the bytes are of each output's `jsonb` text (a SQL NULL output has none).
    pub fn summarize_subagent_tool_executions(
        &self,
        job_ids: &[i64],
        tool_name: &str,
        status: &str,
    ) -> Result<Value> {
        let (mut count, mut bytes) = (0_i64, 0_i64);
        for r in tools_of_jobs(&*self.read()?, job_ids)? {
            if r.tool_name == tool_name && r.status == status {
                count += 1;
                bytes += r.output_value()?.map_or(0, |v| jsonb_text(&v).len() as i64);
            }
        }
        Ok(json!({"count": count, "output_bytes": bytes}))
    }

    // ---------------------------------------------------------------- dream provenance reads

    /// The jobs' completed `brain_put_page` rows, `id` order.
    fn completed_puts(&self, job_ids: &[i64]) -> Result<Vec<ToolRecord>> {
        Ok(tools_of_jobs(&*self.read()?, job_ids)?
            .into_iter()
            .filter(|r| r.tool_name == PUT_PAGE && r.status == "complete")
            .collect())
    }

    /// `listSubagentPutPageSlugs`: the distinct slugs, bytewise ascending, NULL (no slug) last.
    pub fn list_subagent_put_page_slugs(&self, job_ids: &[i64]) -> Result<Vec<Value>> {
        let mut slugs = BTreeSet::new();
        let mut none = false;
        for r in self.completed_puts(job_ids)? {
            match input_field(&r.input, "slug")? {
                Some(slug) => {
                    slugs.insert(slug);
                }
                None => none = true,
            }
        }
        let mut out: Vec<Value> = slugs.into_iter().map(Value::from).collect();
        if none {
            out.push(Value::Null);
        }
        Ok(out)
    }

    /// `listSubagentPutPageWrites`: `{ job_id, slug, started_at }` per completed call, by `id`.
    pub fn list_subagent_put_page_writes(&self, job_ids: &[i64]) -> Result<Vec<Value>> {
        self.completed_puts(job_ids)?
            .iter()
            .map(|r| {
                Ok(json!({
                    "job_id": r.job_id,
                    "slug": input_field(&r.input, "slug")?,
                    "started_at": iso(r.started_at),
                }))
            })
            .collect()
    }

    /// `listSubagentRetainedPutPages`: the completed calls whose output state is `committed`, with their
    /// job's idempotency key, by `id`.
    pub fn list_subagent_retained_put_pages(&self, job_ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for r in self.completed_puts(job_ids)? {
            if output_field(&r, "state")?.as_deref() != Some("committed") {
                continue;
            }
            let Some(job) = load(&*read, r.job_id)? else {
                continue;
            };
            out.push(json!({
                "job_id": r.job_id,
                "job_key": job.idempotency_key.clone(),
                "input": ordered(&r.input),
                "output": r.output_json()?,
                "started_at": iso(r.started_at),
            }));
        }
        Ok(out)
    }

    /// `listSubagentStagedPages`: per slug, the last completed `brain_put_page` whose output status is
    /// `staged`, with its staged markdown (output content, else input content). Slugs bytewise ascending,
    /// the call without one last.
    pub fn list_subagent_staged_pages(&self, job_id: i64) -> Result<Vec<Value>> {
        let mut by_slug: BTreeMap<Option<String>, Option<String>> = BTreeMap::new();
        for r in self.completed_puts(&[job_id])? {
            if output_field(&r, "status")?.as_deref() != Some("staged") {
                continue;
            }
            let content = match output_field(&r, "content")? {
                Some(c) => Some(c),
                None => plain_input_field(&r, "content"),
            };
            by_slug.insert(output_field(&r, "slug")?, content);
        }
        // `None` sorts first in an `Option`: NULL goes last.
        let mut out: Vec<Value> = by_slug
            .iter()
            .filter(|(slug, _)| slug.is_some())
            .map(|(slug, content)| json!({"slug": slug, "content": content}))
            .collect();
        if let Some(content) = by_slug.get(&None) {
            out.push(json!({"slug": null, "content": content}));
        }
        Ok(out)
    }

    /// `listSubagentTimelineAppendCalls`: the jobs' `brain_add_timeline_entry` calls whose input request id
    /// names a committed `add_timeline_entry` request of `source_id` with outcome status `ok`, by call `id`.
    pub fn list_subagent_timeline_append_calls(
        &self,
        job_ids: &[i64],
        source_id: &str,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut calls = Vec::new();
        for r in tools_of_jobs(&*read, job_ids)? {
            if r.tool_name != TIMELINE_ENTRY {
                continue;
            }
            if let Some(request_id) = input_field(&r.input, "request_id")? {
                calls.push((r, request_id));
            }
        }
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = calls.iter().map(|(_, id)| id.as_str()).collect();
        let mut requests: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut bad = None;
        scan_prefix(
            &*read,
            &[keys::REQUEST],
            false,
            &mut |_, v| match serde_json::from_slice::<RequestRecord>(v) {
                Ok(q) => {
                    let ok = q
                        .outcome
                        .as_ref()
                        .and_then(|o| o.get("status"))
                        .and_then(jsonb_field_text)
                        .as_deref()
                        == Some("ok");
                    if wanted.contains(q.request_id.as_str())
                        && q.operation == "add_timeline_entry"
                        && q.source_id == source_id
                        && q.state == "committed"
                        && ok
                    {
                        requests
                            .entry(q.request_id.clone())
                            .or_default()
                            .push((q.request_id, q.slug));
                    }
                    true
                }
                Err(e) => {
                    bad = Some(e);
                    false
                }
            },
        )?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        let mut out = Vec::new();
        for (call, request_id) in &calls {
            for (id, slug) in requests.get(request_id).into_iter().flatten() {
                out.push(json!({"request_id": id, "slug": slug, "input": ordered(&call.input)}));
            }
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- tool ledger writes

    /// `recordSubagentToolExecutions`: banks each row at its position (one transaction for the batch). A
    /// position that already has a row keeps it; the legacy guard also skips a row when a legacy row of the
    /// same turn and tool id exists.
    pub fn record_subagent_tool_executions(
        &self,
        job_id: i64,
        rows: &[ToolInsert],
        legacy_guard: bool,
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            for r in rows {
                if legacy_guard
                    && legacy_rows(tx, job_id, r.message_idx)?
                        .iter()
                        .any(|l| l.tool_use_id == r.tool_use_id)
                {
                    continue;
                }
                let input = parse_json(&r.input, "input")?;
                int4(r.message_idx, "message_idx")?;
                int4_opt(r.ordinal, "ordinal")?;
                check_status(&r.status)?;
                if let Some(ordinal) = r.ordinal
                    && row_at(tx, job_id, r.message_idx, ordinal)?.is_some()
                {
                    continue;
                }
                require_job(tx, job_id, "subagent_tool_executions")?;
                let id = next_seq(tx, "subagent_tool")?;
                save_new_tool(
                    tx,
                    &ToolRecord {
                        id,
                        job_id,
                        message_idx: r.message_idx,
                        ordinal: r.ordinal,
                        tool_use_id: r.tool_use_id.clone(),
                        tool_name: r.tool_name.clone(),
                        input,
                        status: r.status.clone(),
                        output: None,
                        error: None,
                        schema_version: 1,
                        provider_id: None,
                        gbrain_tool_use_id: None,
                        started_at: now,
                        ended_at: None,
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `startSubagentToolExecution`: records the pending `schema_version` 2 row and returns its stable id; a
    /// row already at the position stays and its own stable id comes back (None when it has none).
    pub fn start_subagent_tool_execution(
        &self,
        job_id: i64,
        r: &ToolStart,
    ) -> Result<Option<String>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let input = parse_json(&r.input, "input")?;
            int4(r.message_idx, "message_idx")?;
            int4(r.ordinal, "ordinal")?;
            let uuid = uuid_text(&r.gbrain_tool_use_id).ok_or_else(|| {
                StoreError::invalid(format!(
                    "invalid input syntax for type uuid: \"{}\"",
                    r.gbrain_tool_use_id
                ))
            })?;
            if let Some(existing) = row_at(tx, job_id, r.message_idx, r.ordinal)? {
                return Ok(existing.gbrain_tool_use_id);
            }
            require_job(tx, job_id, "subagent_tool_executions")?;
            let id = next_seq(tx, "subagent_tool")?;
            save_new_tool(
                tx,
                &ToolRecord {
                    id,
                    job_id,
                    message_idx: r.message_idx,
                    ordinal: Some(r.ordinal),
                    tool_use_id: r.tool_use_id.clone(),
                    tool_name: r.tool_name.clone(),
                    input,
                    status: "pending".into(),
                    output: None,
                    error: None,
                    schema_version: 2,
                    provider_id: Some(r.provider_id.clone()),
                    gbrain_tool_use_id: Some(uuid.clone()),
                    started_at: now,
                    ended_at: None,
                },
            )?;
            Ok(Some(uuid))
        })
    }

    /// `completeSubagentToolExecution`: settles the target's rows complete with `output` (JSON text); how
    /// many rows it settled.
    pub fn complete_subagent_tool_execution(
        &self,
        target: &ToolTarget,
        output: &str,
    ) -> Result<i64> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let value = parse_json(output, "output")?;
            let text = serde_json::to_string(&value)?;
            let mut settled = 0;
            for mut row in target_rows(tx, target)? {
                row.status = "complete".into();
                row.output = Some(text.clone());
                row.ended_at = Some(now);
                put_json(tx, &tool_key(row.job_id, row.id), &row)?;
                settled += 1;
            }
            Ok(settled)
        })
    }

    /// `failSubagentToolExecution`: settles the target's rows failed with `error`. With a `fallback` (a
    /// positional target), a position that had no settleable row gets one inserted failed, unless its row
    /// is of another tool id or already complete. How many rows it changed.
    pub fn fail_subagent_tool_execution(
        &self,
        target: &ToolTarget,
        error: &str,
        fallback: Option<&FailureFallback>,
    ) -> Result<i64> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let rows = target_rows(tx, target)?;
            if !rows.is_empty() {
                let count = rows.len() as i64;
                for mut row in rows {
                    row.status = "failed".into();
                    row.error = Some(error.to_string());
                    row.ended_at = Some(now);
                    put_json(tx, &tool_key(row.job_id, row.id), &row)?;
                }
                return Ok(count);
            }
            let (
                Some(fallback),
                ToolTarget::Position {
                    job_id,
                    message_idx,
                    ordinal,
                    tool_use_id,
                },
            ) = (fallback, target)
            else {
                return Ok(0);
            };
            let input = parse_json(&fallback.input, "input")?;
            int4(*message_idx, "message_idx")?;
            int4(*ordinal, "ordinal")?;
            if let Some(mut held) = row_at(tx, *job_id, *message_idx, *ordinal)? {
                // The position is taken: only a not-yet-complete row of the same tool id is failed.
                if held.tool_use_id != *tool_use_id || held.status == "complete" {
                    return Ok(0);
                }
                held.status = "failed".into();
                held.error = Some(error.to_string());
                held.ended_at = Some(now);
                put_json(tx, &tool_key(held.job_id, held.id), &held)?;
                return Ok(1);
            }
            require_job(tx, *job_id, "subagent_tool_executions")?;
            let id = next_seq(tx, "subagent_tool")?;
            save_new_tool(
                tx,
                &ToolRecord {
                    id,
                    job_id: *job_id,
                    message_idx: *message_idx,
                    ordinal: Some(*ordinal),
                    tool_use_id: tool_use_id.clone(),
                    tool_name: fallback.tool_name.clone(),
                    input,
                    status: "failed".into(),
                    output: None,
                    error: Some(error.to_string()),
                    schema_version: 1,
                    provider_id: None,
                    gbrain_tool_use_id: None,
                    started_at: now,
                    ended_at: Some(now),
                },
            )?;
            Ok(1)
        })
    }
}

/// The `subagent_messages` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_message_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow, json_rows};
    Ok(json_rows::<MessageRecord>(read, &prefix(MSG))?
        .into_iter()
        .map(|r| ProbeRow {
            source_id: None,
            cells: vec![("content_blocks", ProbeCell::jsonb(&r.content_blocks))],
        })
        .collect())
}

/// The `subagent_tool_executions` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_tool_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow, json_rows};
    Ok(json_rows::<ToolRecord>(read, &prefix(TOOL))?
        .into_iter()
        .map(|r| ProbeRow {
            source_id: None,
            cells: vec![
                ("input", ProbeCell::jsonb(&r.input)),
                ("output", ProbeCell::opt_jsonb_text(r.output.as_deref())),
            ],
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, text: &str) -> bool {
        has_prefix(text, pattern)
    }

    #[test]
    fn like_follows_the_default_escape() {
        assert!(matches("oneshot-", "oneshot-abc"));
        assert!(!matches("oneshot-", "oneshotXabc"));
        assert!(matches("one_hot", "oneXhot-1"));
        assert!(matches("one%", "one"));
        assert!(matches("a\\_b", "a_b-1"));
        assert!(!matches("a\\_b", "axb-1"));
        assert!(matches("100\\%", "100%-done"));
        assert!(!matches("100\\%", "1000-done"));
        assert!(matches("", "anything"));
        assert!(matches("é_", "éé"));
    }

    #[test]
    fn a_uuid_is_stored_lowercase_and_hyphenated() {
        assert_eq!(
            uuid_text("0190A2B3-C4D5-7E6F-8A9B-0C1D2E3F4A5B").as_deref(),
            Some("0190a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b")
        );
        assert_eq!(
            uuid_text("0190a2b3c4d57e6f8a9b0c1d2e3f4a5b").as_deref(),
            Some("0190a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b")
        );
        assert_eq!(uuid_text("not-a-uuid"), None);
        assert_eq!(uuid_text(""), None);
    }

    #[test]
    fn a_slug_comes_from_the_input_object_or_its_double_encoded_text() {
        assert_eq!(
            input_field(&json!({"slug": "a/b"}), "slug").unwrap(),
            Some("a/b".into())
        );
        assert_eq!(
            input_field(&json!("{\"slug\":\"x\"}"), "slug").unwrap(),
            Some("x".into())
        );
        assert_eq!(
            input_field(&json!({"slug": 7}), "slug").unwrap(),
            Some("7".into())
        );
        assert_eq!(input_field(&json!({"slug": null}), "slug").unwrap(), None);
        assert_eq!(input_field(&json!(5), "slug").unwrap(), None);
        assert_eq!(input_field(&json!("\"just text\""), "slug").unwrap(), None);
        assert!(input_field(&json!("not json"), "slug").is_err());
    }

    #[test]
    fn deleting_a_job_leaves_no_record_or_index_key_behind() {
        let store = crate::test_support::store();
        let insert = json!({
            "name": "n", "queue": "default", "status": "waiting", "priority": 0, "data": {},
            "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
            "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
            "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
        });
        let spec: AdmitSpec =
            serde_json::from_value(json!({"insert": insert, "maxSpawnDepth": 5})).unwrap();
        let job = store.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
        let row = |idx: i64, ordinal: Option<i64>, id: &str| ToolInsert {
            message_idx: idx,
            ordinal,
            tool_use_id: id.into(),
            tool_name: "brain_get_page".into(),
            input: "{}".into(),
            status: "pending".into(),
        };
        store
            .insert_subagent_message(
                job,
                &MessageInsert {
                    message_idx: 0,
                    role: "user".into(),
                    content_blocks: "[]".into(),
                    tokens_in: None,
                    tokens_out: None,
                    tokens_cache_read: None,
                    tokens_cache_create: None,
                    model: None,
                },
            )
            .unwrap();
        store
            .record_subagent_tool_executions(job, &[row(1, Some(0), "a"), row(1, None, "b")], false)
            .unwrap();
        store
            .start_subagent_tool_execution(
                job,
                &ToolStart {
                    message_idx: 2,
                    ordinal: 0,
                    tool_use_id: "c".into(),
                    tool_name: "brain_get_page".into(),
                    input: "{}".into(),
                    gbrain_tool_use_id: "0190a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b".into(),
                    provider_id: "anthropic".into(),
                },
            )
            .unwrap();
        let count = |store: &Store| -> usize {
            let read = store.read().unwrap();
            [MSG, TOOL, POSITION, STABLE, LEGACY]
                .iter()
                .map(|tag| keys_under(&*read, &[keys::JOBS, *tag]).unwrap().len())
                .sum()
        };
        assert_eq!(count(&store), 1 + 3 + 2 + 1 + 1);
        store.cancel_jobs(&[job], &Default::default()).unwrap();
        assert!(store.delete_terminal_job(job).unwrap());
        assert_eq!(count(&store), 0);
    }
}
