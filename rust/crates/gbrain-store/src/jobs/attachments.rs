//! Jobs slice 2: `minion_attachments`. One record per `(job, id)` under `m 0x08`; the unique
//! `(job_id, filename)` index is a scan of the job's few rows. The bytes arrive and leave as the
//! base64 text the TypeScript member encodes; the store never decodes them.

use super::*;

/// `INSERT INTO minion_attachments`: the validated, normalized attachment.
#[derive(Debug, Clone, Deserialize)]
pub struct AttachmentInput {
    pub filename: String,
    pub content_type: String,
    pub content_b64: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentRecord {
    id: i64,
    job_id: i64,
    filename: String,
    content_type: String,
    content_b64: String,
    storage_uri: Option<String>,
    size_bytes: i64,
    sha256: String,
    created_at: i64,
}

impl AttachmentRecord {
    fn meta(&self) -> Value {
        json!({
            "id": self.id,
            "job_id": self.job_id,
            "filename": self.filename,
            "content_type": self.content_type,
            "storage_uri": self.storage_uri,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
            "created_at": iso(self.created_at),
        })
    }
}

fn attachments_of(read: &dyn KvRead, job_id: i64) -> Result<Vec<AttachmentRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &attach_prefix(job_id),
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

impl Store {
    /// The filenames of a job's attachments (id order), or None when the job does not exist.
    pub fn list_job_attachment_names(&self, job_id: i64) -> Result<Option<Vec<String>>> {
        let read = self.read()?;
        if load(&*read, job_id)?.is_none() {
            return Ok(None);
        }
        Ok(Some(
            attachments_of(&*read, job_id)?
                .into_iter()
                .map(|a| a.filename)
                .collect(),
        ))
    }

    /// `addAttachment`'s INSERT: the metadata of the new row. `constraint_violation` for a missing
    /// job (the foreign key), a duplicate filename (`uniq_minion_attachments_job_filename`) or a
    /// negative size (`chk_attachment_size`).
    pub fn insert_job_attachment(&self, job_id: i64, input: &AttachmentInput) -> Result<Value> {
        self.write(|tx| {
            let now = self.env.now_micros();
            if load(tx, job_id)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("minion_attachments foreign key: job {job_id} does not exist"),
                ));
            }
            if input.size_bytes < 0 || input.size_bytes > i64::from(i32::MAX) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "minion_attachments check: chk_attachment_size",
                ));
            }
            if attachments_of(tx, job_id)?
                .iter()
                .any(|a| a.filename == input.filename)
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"uniq_minion_attachments_job_filename\"",
                ));
            }
            let id = next_seq(tx, "attachment")?;
            let record = AttachmentRecord {
                id,
                job_id,
                filename: input.filename.clone(),
                content_type: input.content_type.clone(),
                content_b64: input.content_b64.clone(),
                storage_uri: None,
                size_bytes: input.size_bytes,
                sha256: input.sha256.clone(),
                created_at: now,
            };
            put_json(tx, &attach_key(job_id, id), &record)?;
            Ok(record.meta())
        })
    }

    /// A job's attachments' metadata, `created_at` then id.
    pub fn list_job_attachments(&self, job_id: i64) -> Result<Vec<Value>> {
        let mut rows = attachments_of(&*self.read()?, job_id)?;
        rows.sort_by_key(|a| (a.created_at, a.id));
        Ok(rows.iter().map(AttachmentRecord::meta).collect())
    }

    /// One attachment: its metadata plus `content_b64`, or None.
    pub fn get_job_attachment(&self, job_id: i64, filename: &str) -> Result<Option<Value>> {
        Ok(attachments_of(&*self.read()?, job_id)?
            .into_iter()
            .find(|a| a.filename == filename)
            .map(|a| {
                let mut meta = a.meta();
                meta["content_b64"] = json!(a.content_b64);
                meta
            }))
    }

    /// `deleteAttachment`: whether a row was removed.
    pub fn delete_job_attachment(&self, job_id: i64, filename: &str) -> Result<bool> {
        self.write(|tx| {
            let Some(a) = attachments_of(tx, job_id)?
                .into_iter()
                .find(|a| a.filename == filename)
            else {
                return Ok(false);
            };
            tx.delete(&attach_key(job_id, a.id))?;
            Ok(true)
        })
    }
}

/// The `minion_attachments` rows a fact purge's inventory probe searches (crate::facts::purge_probe): the content bytes.
pub(crate) fn purge_probe_attachment_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow, decode_base64, json_rows};
    json_rows::<AttachmentRecord>(read, &prefix(ATTACH))?
        .into_iter()
        .map(|r| {
            let content = if r.storage_uri.is_some() && r.content_b64.is_empty() {
                ProbeCell::Null
            } else {
                ProbeCell::Bytes(decode_base64(&r.content_b64).ok_or_else(|| {
                    StoreError::invalid(format!(
                        "minion_attachments {}: the stored content is not base64",
                        r.id
                    ))
                })?)
            };
            Ok(ProbeRow {
                source_id: None,
                cells: vec![("content", content)],
            })
        })
        .collect()
}
