//! Jobs slice 2: the inbox members (`queue.ts` `sendMessage`, `readInbox`, `readChildCompletions`).

use super::*;

fn inbox_json(r: &InboxRecord) -> Value {
    json!({
        "id": r.id,
        "job_id": r.job_id,
        "sender": r.sender,
        "payload": jsonb(&r.payload),
        "sent_at": iso(r.sent_at),
        "read_at": r.read_at.map(iso),
    })
}

/// A job's inbox rows in id order.
fn inbox_rows(read: &dyn KvRead, job_id: i64) -> Result<Vec<(Vec<u8>, InboxRecord)>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &inbox_prefix(job_id),
        false,
        &mut |k, v| match serde_json::from_slice(v) {
            Ok(row) => {
                rows.push((k.to_vec(), row));
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

/// `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`.
fn holds(read: &dyn KvRead, id: i64, token: &str) -> Result<bool> {
    Ok(load(read, id)?
        .is_some_and(|r| r.status == "active" && r.lock_token.as_deref() == Some(token)))
}

impl Store {
    /// `sendMessage`'s INSERT (the queue validated the sender and the state): the new inbox row.
    /// `constraint_violation` when the job does not exist (the foreign key) or the payload is null.
    pub fn post_inbox_message(&self, job_id: i64, sender: &str, payload: &Value) -> Result<Value> {
        self.write(|tx| {
            let now = self.env.now_micros();
            if load(tx, job_id)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("minion_inbox foreign key: job {job_id} does not exist"),
                ));
            }
            if payload.is_null() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "minion_inbox: null value in column \"payload\"",
                ));
            }
            let id = next_seq(tx, "inbox")?;
            let record = InboxRecord {
                id,
                job_id,
                sender: sender.into(),
                payload: payload.clone(),
                sent_at: now,
                read_at: None,
            };
            let mut k = inbox_prefix(job_id);
            k.extend_from_slice(&signed_key(id));
            put_json(tx, &k, &record)?;
            Ok(inbox_json(&record))
        })
    }

    /// `readInbox`: the unread rows, marked read now, when the job is `active` under the token.
    pub fn read_job_inbox(&self, job_id: i64, lock_token: &str) -> Result<Vec<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            if !holds(tx, job_id, lock_token)? {
                return Ok(Vec::new());
            }
            let mut out = Vec::new();
            for (key, mut row) in inbox_rows(tx, job_id)? {
                if row.read_at.is_none() {
                    row.read_at = Some(now);
                    put_json(tx, &key, &row)?;
                    out.push(inbox_json(&row));
                }
            }
            Ok(out)
        })
    }

    /// `readChildCompletions`: the `child_done` payloads sent after `since`, by `sent_at`; empty
    /// unless the parent is `active` under the token. Rows stay unread.
    pub fn read_child_completions(
        &self,
        parent_id: i64,
        lock_token: &str,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        let since = match since {
            None => None,
            Some(s) => Some(crate::env::parse_iso(s).ok_or_else(|| {
                StoreError::invalid(format!(
                    "readChildCompletions: since is not an ISO timestamp: {s}"
                ))
            })?),
        };
        let read = self.read()?;
        if !holds(&*read, parent_id, lock_token)? {
            return Ok(Vec::new());
        }
        let mut rows: Vec<InboxRecord> = inbox_rows(&*read, parent_id)?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| {
                r.payload.get("type").and_then(jsonb_field_text).as_deref() == Some("child_done")
                    && since.is_none_or(|s| r.sent_at > s)
            })
            .collect();
        rows.sort_by_key(|r| (r.sent_at, r.id));
        Ok(rows.iter().map(|r| jsonb(&r.payload)).collect())
    }
}
