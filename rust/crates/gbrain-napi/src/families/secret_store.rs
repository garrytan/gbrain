//! The secret store and the page-store reads and writes of `gbrain repair secret-spans`
//! (`gbrain_store::secret_store`, `gbrain_store::repair_secret_spans`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store"). Every write is one store call, so the
//! engine's transaction holds it with the others.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `findSecretEntryByMac(sourceId, mac)`: resolves the entry id or null.
    #[napi]
    pub fn find_secret_entry_by_mac<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        mac: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_secret_entry_by_mac(&source_id, &mac))
    }

    /// `secretEntryExists(id)`.
    #[napi]
    pub fn secret_entry_exists<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.secret_entry_exists(&id))
    }

    /// `insertSecretEntry(row, conflict)`: resolves the id written or null.
    #[napi]
    pub fn insert_secret_entry<'env>(
        &self,
        env: &'env Env,
        row: Value,
        conflict: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::secret_store::SecretEntryInsert =
                required(row, "insertSecretEntry row")?;
            s.insert_secret_entry(&row, &conflict)
        })
    }

    /// `insertSecretOccurrence(o)`.
    #[napi]
    pub fn insert_secret_occurrence<'env>(
        &self,
        env: &'env Env,
        o: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let o: gbrain_store::secret_store::SecretOccurrenceInsert =
                required(o, "insertSecretOccurrence row")?;
            s.insert_secret_occurrence(&o)
        })
    }

    /// `readSecretEntry(id)`: resolves the entry row or null.
    #[napi]
    pub fn read_secret_entry<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_secret_entry(&id))
    }

    /// `listSecretOccurrences(entryId)`.
    #[napi]
    pub fn list_secret_occurrences<'env>(
        &self,
        env: &'env Env,
        entry_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_secret_occurrences(&entry_id))
    }

    /// `listSecretEntrySummaries({ sourceId, slug, limit })`.
    #[napi]
    pub fn list_secret_entry_summaries<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source = filter.get("sourceId").and_then(Value::as_str);
            let slug = filter.get("slug").and_then(Value::as_str);
            let limit = filter.get("limit").and_then(Value::as_i64).unwrap_or(1000);
            s.list_secret_entry_summaries(source, slug, limit)
        })
    }

    /// `countSecretsByRule(sourceId)`.
    #[napi]
    pub fn count_secrets_by_rule<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_secrets_by_rule(source_id.as_deref()))
    }

    /// `listAllowedSecretMacs(sourceId)`.
    #[napi]
    pub fn list_allowed_secret_macs<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_allowed_secret_macs(source_id.as_deref())
        })
    }

    /// `listSecretKeysInUse()`.
    #[napi]
    pub fn list_secret_keys_in_use<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_secret_keys_in_use())
    }

    /// `readSecretStoreSnapshot()`: resolves `{ entries, occurrences }`.
    #[napi]
    pub fn read_secret_store_snapshot<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_secret_store_snapshot())
    }

    /// `insertBackupSecretEntry(row)`.
    #[napi]
    pub fn insert_backup_secret_entry<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::secret_store::BackupEntry =
                required(row, "insertBackupSecretEntry row")?;
            s.insert_backup_secret_entry(&row)
        })
    }

    /// `readBackupEntryHold(id, sourceId, mac)`: resolves true, false or null.
    #[napi]
    pub fn read_backup_entry_hold<'env>(
        &self,
        env: &'env Env,
        id: String,
        source_id: String,
        mac: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_backup_entry_hold(&id, &source_id, &mac)
        })
    }

    /// `insertBackupSecretOccurrence(o, pageId)`.
    #[napi]
    pub fn insert_backup_secret_occurrence<'env>(
        &self,
        env: &'env Env,
        o: Value,
        page_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let o: gbrain_store::secret_store::BackupOccurrence =
                required(o, "insertBackupSecretOccurrence row")?;
            s.insert_backup_secret_occurrence(&o, page_id)
        })
    }

    /// `deleteUnreferencedSecretEntry(id)`.
    #[napi]
    pub fn delete_unreferenced_secret_entry<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_unreferenced_secret_entry(&id))
    }

    /// `listSecretHoldingPages(sourceId, slugs, id)`.
    #[napi]
    pub fn list_secret_holding_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_secret_holding_pages(&source_id, &slugs, &id)
        })
    }

    /// `countUnreferencedSecretEntries()`.
    #[napi]
    pub fn count_unreferenced_secret_entries<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_unreferenced_secret_entries())
    }

    /// `readRestorePageHit(sourceId, slug, marker)`.
    #[napi]
    pub fn read_restore_page_hit<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        marker: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_restore_page_hit(&source_id, &slug, &marker)
        })
    }

    /// `markSecretEntryAllowed(id)`.
    #[napi]
    pub fn mark_secret_entry_allowed<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_secret_entry_allowed(&id))
    }

    /// `readPageRedactionRow(sourceId, slug)`: resolves the page row or null.
    #[napi]
    pub fn read_page_redaction_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_redaction_row(&source_id, &slug))
    }

    /// `readPageRedactionRows(pageId, sourceId, slug)`: resolves `{ timeline, facts, takes, links, rawData }`.
    #[napi]
    pub fn read_page_redaction_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_redaction_rows(page_id, &source_id, &slug)
        })
    }

    /// `listTimelineDedupRows(pageId)`.
    #[napi]
    pub fn list_timeline_dedup_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_timeline_dedup_rows(page_id))
    }

    /// `listVersionBodiesForRedaction(pageId)`.
    #[napi]
    pub fn list_version_bodies_for_redaction<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_version_bodies_for_redaction(page_id))
    }

    /// `countPageVersionRows(pageId)`.
    #[napi]
    pub fn count_page_version_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_version_rows(page_id))
    }

    /// `setRetainedVersionBody(pageId, id, compiledTruth, frontmatter)`.
    #[napi]
    pub fn set_retained_version_body<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        id: i64,
        compiled_truth: Option<String>,
        frontmatter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let frontmatter = required(frontmatter, "setRetainedVersionBody frontmatter")?;
            s.set_retained_version_body(page_id, id, compiled_truth, frontmatter)
        })
    }

    /// `listChunkTextsForRedaction(pageId)`.
    #[napi]
    pub fn list_chunk_texts_for_redaction<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_chunk_texts_for_redaction(page_id))
    }

    /// `deleteChunksByIds(pageId, ids)`.
    #[napi]
    pub fn delete_chunks_by_ids<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "deleteChunksByIds ids")?;
            s.delete_chunks_by_ids(page_id, &ids)
        })
    }

    /// `setRedactedPageFields(pageId, fields)`.
    #[napi]
    pub fn set_redacted_page_fields<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        fields: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fields: gbrain_store::repair_secret_spans::RedactedPageFields =
                required(fields, "setRedactedPageFields fields")?;
            s.set_redacted_page_fields(page_id, &fields)
        })
    }

    /// `readRawDataValue(pageId, id)`: resolves the row's data or null.
    #[napi]
    pub fn read_raw_data_value<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_raw_data_value(page_id, id))
    }

    /// `setRawDataValue(pageId, id, data)`.
    #[napi]
    pub fn set_raw_data_value<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        id: i64,
        data: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_raw_data_value(page_id, id, data))
    }

    /// `setRedactedRowText(pageId, store, id, column, text)`.
    #[napi]
    pub fn set_redacted_row_text<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        store: String,
        id: i64,
        column: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_redacted_row_text(page_id, &store, id, &column, &text)
        })
    }
}
