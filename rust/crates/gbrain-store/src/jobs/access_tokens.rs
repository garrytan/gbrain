//! Jobs: the `access_tokens` table, the columns the legacy-token mint and the read-floor command touch, as the members
//! of `src/core/engine-sql/access-tokens.ts` run them (rust/docs/store/access-tokens.md).
//!
//! Members: insertAccessToken, findActiveAccessTokens, setAccessTokenMinTrust, and the token check of listAccessTokens. The credential binding members of
//! `credential_binding.rs` read and write the member, may_act_for, attest and reads_unscoped columns of these records.
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2B (this file only):
//! - `m 0x2B id -> TokenRecord`: one token row, keyed by its generated UUID.
//!
//! Kept: the columns those members read or write (id, name, token_hash, scopes, permissions, the five grant
//! columns, grant_revision, min_trust, revoked_at, created_at, member_id, may_act_for, the four attest columns and
//! reads_unscoped; a record written before the binding columns were kept reads them as NULL) and the table's constraints on them: the unique
//! `token_hash` (`access_tokens_token_hash_key`, found by scanning the table, as the secondary indexes are not kept), the
//! `source_grant` list and the `min_trust` list. A refusal is `constraint_violation` with the Postgres message.
//! Not kept: `last_used_at`, the private columns, and the `trust_generation_update` trigger. Setting
//! the floor of an id no token has changes nothing (Postgres also refuses an id that is not a UUID with 22P02; the
//! caller here always passes the id `findActiveAccessTokens` returned).

use super::*;
use crate::env::parse_iso;

const TOKEN: u8 = 0x2B;
const TABLE: &str = "access_tokens";

pub(super) fn token_key(id: &str) -> Vec<u8> {
    let mut k = prefix(TOKEN);
    k.extend_from_slice(id.as_bytes());
    k
}

const MIN_TRUST_TIERS: [&str; 6] = [
    "user_confirmed",
    "operator_curated",
    "tool_observed",
    "agent_written",
    "unknown",
    "external_untrusted",
];
const SOURCE_GRANTS: [&str; 4] = ["default", "scalar", "federated", "none"];

/// One `access_tokens` row. Times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct TokenRecord {
    pub(super) id: String,
    pub(super) name: String,
    token_hash: String,
    scopes: Option<Vec<String>>,
    permissions: Value,
    source_grant: Option<String>,
    source_id: Option<String>,
    federated_read: Option<Vec<String>>,
    allowed_operations: Option<Vec<String>>,
    takes_holders: Option<Vec<String>>,
    grant_revision: i32,
    /// The revision the read-shared switch was set at (the birth revision, 1); None is off.
    #[serde(default)]
    read_shared_revision: Option<i32>,
    min_trust: Option<String>,
    pub(super) revoked_at: Option<i64>,
    pub(super) created_at: i64,
    /// The binding columns (`credential_binding.rs`); `reads_unscoped` is a time in microseconds.
    #[serde(default)]
    pub(super) member_id: Option<String>,
    #[serde(default)]
    pub(super) may_act_for: Option<Vec<String>>,
    #[serde(default)]
    pub(super) attest_actor: Option<String>,
    #[serde(default)]
    pub(super) attest_ops: Option<Vec<String>>,
    #[serde(default)]
    pub(super) attest_sources: Option<Vec<String>>,
    #[serde(default)]
    pub(super) attest_read: Option<String>,
    #[serde(default)]
    pub(super) reads_unscoped: Option<i64>,
}

fn refuse_check(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{TABLE}\" violates check constraint \"{constraint}\""),
    )
}

impl TokenRecord {
    /// The table's CHECK constraints on the kept columns, in the order Postgres names a violation.
    fn check(&self) -> Result<()> {
        if let Some(tier) = &self.min_trust
            && !MIN_TRUST_TIERS.contains(&tier.as_str())
        {
            return Err(refuse_check("access_tokens_min_trust_check"));
        }
        if let Some(grant) = &self.source_grant
            && !SOURCE_GRANTS.contains(&grant.as_str())
        {
            return Err(refuse_check("access_tokens_source_grant_check"));
        }
        Ok(())
    }
}

pub(super) fn all_tokens(read: &dyn KvRead) -> Result<Vec<TokenRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix(TOKEN), false, &mut |_, v| {
        match serde_json::from_slice::<TokenRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::invalid(format!("unreadable token record: {e}")));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

/// `insertAccessToken(row)`: the grant columns are the values of the five grant columns (`None` is NULL); the row is born
/// at grant revision 1, as the mint's statement writes it.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenInsert {
    pub name: String,
    pub token_hash: String,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: Value,
    #[serde(default)]
    pub source_grant: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub federated_read: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_operations: Option<Vec<String>>,
    #[serde(default)]
    pub takes_holders: Option<Vec<String>>,
    /// Born with the read-shared switch on (`read_shared_revision` = 1, the birth revision).
    #[serde(default)]
    pub read_shared: bool,
    #[serde(default)]
    pub min_trust: Option<String>,
    /// ISO text (the TypeScript member turns the `Date`).
    #[serde(default)]
    pub revoked_at: Option<String>,
}

impl Store {
    /// `insertAccessToken(row)`: the generated id. `constraint_violation` for a token hash already taken, a
    /// `source_grant` outside the list, or a `min_trust` outside the six tiers; `invalid_argument` for a time that is not
    /// ISO text.
    pub fn insert_access_token(&self, row: &TokenInsert) -> Result<String> {
        let revoked_at = row
            .revoked_at
            .as_deref()
            .map(|t| {
                parse_iso(t).ok_or_else(|| {
                    StoreError::invalid(format!("revoked_at: \"{t}\" is not an ISO time"))
                })
            })
            .transpose()?;
        self.write(|tx| {
            let record = TokenRecord {
                id: self.env.new_uuid(),
                name: row.name.clone(),
                token_hash: row.token_hash.clone(),
                scopes: row.scopes.clone(),
                permissions: if row.permissions.is_null() {
                    json!({})
                } else {
                    row.permissions.clone()
                },
                source_grant: row.source_grant.clone(),
                source_id: row.source_id.clone(),
                federated_read: row.federated_read.clone(),
                allowed_operations: row.allowed_operations.clone(),
                takes_holders: row.takes_holders.clone(),
                grant_revision: 1,
                read_shared_revision: row.read_shared.then_some(1),
                min_trust: row.min_trust.clone(),
                revoked_at,
                created_at: self.env.now_micros(),
                member_id: None,
                may_act_for: None,
                attest_actor: None,
                attest_ops: None,
                attest_sources: None,
                attest_read: None,
                reads_unscoped: None,
            };
            record.check()?;
            if all_tokens(&*tx)?
                .iter()
                .any(|t| t.token_hash == record.token_hash)
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"access_tokens_token_hash_key\"",
                ));
            }
            put_json(tx, &token_key(&record.id), &record)?;
            Ok(record.id)
        })
    }

    /// Whether any token row exists, revoked or not: `listAccessTokens` refuses on a brain that holds one, since the
    /// store keeps only some of the columns its `SELECT *` returns (docs/designs/RUST_ENGINE.md row 32g).
    pub fn access_tokens_present(&self) -> Result<bool> {
        let mut any = false;
        scan_prefix(&*self.read()?, &prefix(TOKEN), false, &mut |_, _| {
            any = true;
            false
        })?;
        Ok(any)
    }

    /// `findActiveAccessTokens(target)`: `[{ id, name, min_trust }]` of the tokens not revoked whose id or name is `target`,
    /// by id.
    pub fn find_active_access_tokens(&self, target: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<TokenRecord> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && (t.id == target || t.name == target))
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Value::Array(
            rows.into_iter()
                .map(|t| json!({ "id": t.id, "name": t.name, "min_trust": t.min_trust }))
                .collect(),
        ))
    }

    /// `setAccessTokenMinTrust(id, tier)`: sets (or clears, with None) one token's floor; whether a token had the id.
    /// `constraint_violation` for a tier outside the six, and then the row is untouched.
    pub fn set_access_token_min_trust(&self, id: &str, tier: Option<&str>) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = get_json::<TokenRecord>(&*tx, &token_key(id))? else {
                return Ok(false);
            };
            record.min_trust = tier.map(str::to_string);
            record.check()?;
            put_json(tx, &token_key(id), &record)?;
            Ok(true)
        })
    }
}
