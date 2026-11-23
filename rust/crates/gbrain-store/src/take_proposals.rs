//! The failure tombstones of `take_proposals` (rust/docs/store/take-proposals.md): the
//! `rejected` rows the propose_takes phase writes for a page whose extractor call keeps failing
//! (`recordFailureTombstone`) and the listing of them (`listFailureTombstones`,
//! `src/core/engine-sql/take-proposals.ts`). PGLite and Postgres run the SQL; this
//! answers the same questions from the store's records.
//!
//! Keys (under `keys::TAKE`, `A`, the takes family; the id counter is `M next_take_proposal_id`):
//! - `A 0x10 <source> 0x00 <page slug> 0x00 <content hash> 0x00 <prompt version> 0x00 <md5(claim)>`
//!   -> `ProposalRecord` (JSON). The key is the table's idempotency index
//!   (`take_proposals_idempotency_idx`), so one claim is one row, and a scan of one source
//!   meets its rows in page-slug byte order (NUL sorts below every other byte).

use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::Env;
use crate::error::Result;
use crate::facts::md5_hex;
use crate::kv::{KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::require_source;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};

const PROPOSAL: u8 = 0x10;
const NEXT_PROPOSAL_ID: &str = "next_take_proposal_id";

/// What the tombstone insert names (`FailureTombstoneInput`); the row's own fixed columns are
/// kind `fact`, holder `brain`, weight 0, no domain and status `rejected`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureTombstoneInput {
    pub source_id: String,
    pub slug: String,
    pub content_hash: String,
    pub prompt_version: String,
    pub proposal_run_id: String,
    pub claim_text: String,
    pub model_id: String,
}

/// A tombstone as listed (`FailureTombstoneRow`): `proposed_at` is `timestamptz::text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FailureTombstoneRow {
    pub page_slug: String,
    pub claim_text: String,
    pub prompt_version: String,
    pub proposed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProposalRecord {
    id: u64,
    source_id: String,
    page_slug: String,
    content_hash: String,
    prompt_version: String,
    proposal_run_id: String,
    claim_text: String,
    kind: String,
    holder: String,
    weight: f64,
    model_id: String,
    status: String,
    proposed_at_us: i64,
    acted_at_us: Option<i64>,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::TAKE, PROPOSAL];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

fn proposal_key(input: &FailureTombstoneInput) -> Vec<u8> {
    let mut key = source_prefix(&input.source_id);
    for part in [
        input.slug.as_str(),
        input.content_hash.as_str(),
        input.prompt_version.as_str(),
        md5_hex(&input.claim_text).as_str(),
    ] {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key.pop();
    key
}

impl Store {
    /// `recordFailureTombstone(input)`: inserts the `rejected` row unless the same claim is
    /// already recorded for the page, content hash and prompt version. True when it inserted.
    /// An unknown source refuses, as the table's foreign key does.
    pub fn record_failure_tombstone(&self, input: &FailureTombstoneInput) -> Result<bool> {
        no_nul(
            "recordFailureTombstone",
            &[
                ("sourceId", &input.source_id),
                ("slug", &input.slug),
                ("contentHash", &input.content_hash),
                ("promptVersion", &input.prompt_version),
                ("claimText", &input.claim_text),
            ],
        )?;
        let key = proposal_key(input);
        let env: &dyn Env = &*self.env;
        self.write(|tx| {
            require_source(&*tx, &input.source_id)?;
            if tx.get(&key)?.is_some() {
                return Ok(false);
            }
            let record = ProposalRecord {
                id: next_id(tx, NEXT_PROPOSAL_ID)?,
                source_id: input.source_id.clone(),
                page_slug: input.slug.clone(),
                content_hash: input.content_hash.clone(),
                prompt_version: input.prompt_version.clone(),
                proposal_run_id: input.proposal_run_id.clone(),
                claim_text: input.claim_text.clone(),
                kind: "fact".into(),
                holder: "brain".into(),
                weight: 0.0,
                model_id: input.model_id.clone(),
                status: "rejected".into(),
                proposed_at_us: env.now_micros(),
                acted_at_us: None,
            };
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `listFailureTombstones(sourceId, claimPrefix)`: the source's `rejected` proposals nobody
    /// acted on whose claim text starts with `claimPrefix`, by page slug bytes.
    pub fn list_failure_tombstones(
        &self,
        source_id: &str,
        claim_prefix: &str,
    ) -> Result<Vec<FailureTombstoneRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &source_prefix(source_id), false, &mut |_, v| {
            match serde_json::from_slice::<ProposalRecord>(v) {
                Ok(r)
                    if r.status == "rejected"
                        && r.acted_at_us.is_none()
                        && r.claim_text.starts_with(claim_prefix) =>
                {
                    rows.push(FailureTombstoneRow {
                        page_slug: r.page_slug,
                        claim_text: r.claim_text,
                        prompt_version: r.prompt_version,
                        proposed_at: timestamptz_text(r.proposed_at_us),
                    });
                }
                Ok(_) => {}
                Err(e) => {
                    failure = Some(e);
                    return false;
                }
            }
            true
        })?;
        match failure {
            Some(e) => Err(e.into()),
            None => Ok(rows),
        }
    }
}

/// `ON DELETE CASCADE` of `take_proposals.source_id`.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &source_prefix(source_id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}
