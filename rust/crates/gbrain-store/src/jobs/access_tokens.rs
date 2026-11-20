//! Jobs: the `access_tokens` table, the columns the legacy-token mint and the read-floor command touch, as the members
//! of `src/core/engine-sql/access-tokens.ts` run them (rust/docs/store/access-tokens.md).
//!
//! Members: insertAccessToken, findActiveAccessTokens, setAccessTokenMinTrust, and the credential members of
//! `src/core/engine-sql/access-credentials.ts`: listAccessTokens, readActiveAccessTokenGrant, accessTokenLive,
//! readActiveAccessTokenByHash (the bearer checks), revokeAccessTokensNamed and revokeAccessToken.
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2B (this file only):
//! - `m 0x2B id -> TokenRecord`: one token row, keyed by its generated UUID.
//!
//! Kept: the columns those members read or write (id, name, token_hash, scopes, permissions, the five grant
//! columns, grant_revision, min_trust, revoked_at, created_at, last_used_at) and the table's constraints on them: the unique
//! `token_hash` (`access_tokens_token_hash_key`, found by scanning the table, as the secondary indexes are not kept), the
//! `source_grant` list and the `min_trust` list. A refusal is `constraint_violation` with the Postgres message.
//! Kept too: the binding columns (member_id, may_act_for, the attest columns, reads_unscoped) that
//! `writeCredentialBinding` and `writeCredentialReadsUnscoped` set. Not kept: the private columns, and the
//! `trust_generation_update` trigger: a listed row reads them as the table's defaults (`private_pages` and
//! `private_facts` `'none'`). `last_used_at` is stamped by the bearer check (`touch_access_token_last_used`) and NULL before. No member
//! returns `token_hash`. Setting
//! the floor of an id no token has changes nothing (Postgres also refuses an id that is not a UUID with 22P02; the
//! caller here always passes the id `findActiveAccessTokens` returned).

use super::*;
use crate::env::{iso, parse_iso};
use crate::kv::KvWrite;

const TOKEN: u8 = 0x2B;
const TABLE: &str = "access_tokens";

fn token_key(id: &str) -> Vec<u8> {
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
struct TokenRecord {
    id: String,
    name: String,
    token_hash: String,
    scopes: Option<Vec<String>>,
    permissions: Value,
    source_grant: Option<String>,
    source_id: Option<String>,
    federated_read: Option<Vec<String>>,
    allowed_operations: Option<Vec<String>>,
    takes_holders: Option<Vec<String>>,
    grant_revision: i32,
    min_trust: Option<String>,
    revoked_at: Option<i64>,
    created_at: i64,
    /// Stamped by the bearer check, at most once a minute; a record written before the field existed reads NULL.
    #[serde(default)]
    last_used_at: Option<i64>,
    /// The binding columns (`writeCredentialBinding`): the member, who it may act for, the attest right and the
    /// unscoped-read opt-out time. A record written before they were kept reads NULL.
    #[serde(default)]
    member_id: Option<String>,
    #[serde(default)]
    may_act_for: Option<Vec<String>>,
    #[serde(default)]
    attest_actor: Option<String>,
    #[serde(default)]
    attest_ops: Option<Vec<String>>,
    #[serde(default)]
    attest_sources: Option<Vec<String>>,
    #[serde(default)]
    attest_read: Option<String>,
    #[serde(default)]
    reads_unscoped: Option<i64>,
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

fn all_tokens(read: &dyn KvRead) -> Result<Vec<TokenRecord>> {
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
    #[serde(default)]
    pub min_trust: Option<String>,
    /// ISO text (the TypeScript member turns the `Date`).
    #[serde(default)]
    pub revoked_at: Option<String>,
}

/// The five grant columns a legacy-shape token converts to (`convertLegacyAccessTokenGrant`); `None` is NULL.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenGrantColumns {
    pub source_grant: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub federated_read: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_operations: Option<Vec<String>>,
    #[serde(default)]
    pub takes_holders: Option<Vec<String>>,
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
                min_trust: row.min_trust.clone(),
                revoked_at,
                created_at: self.env.now_micros(),
                last_used_at: None,
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

impl TokenRecord {
    /// The whole row (`SELECT *` or `RETURNING *`) less `token_hash`: the private columns, which are not kept, read as
    /// the table's default (`'none'`).
    fn whole_row(&self) -> Value {
        let t = self;
        json!({
            "id": t.id, "name": t.name, "scopes": t.scopes, "created_at": iso(t.created_at),
            "last_used_at": t.last_used_at.map(iso), "revoked_at": t.revoked_at.map(iso), "permissions": t.permissions,
            "source_grant": t.source_grant, "source_id": t.source_id, "federated_read": t.federated_read,
            "allowed_operations": t.allowed_operations, "takes_holders": t.takes_holders,
            "grant_revision": t.grant_revision, "min_trust": t.min_trust, "private_pages": "none",
            "member_id": t.member_id, "may_act_for": t.may_act_for, "attest_actor": t.attest_actor,
            "attest_ops": t.attest_ops, "attest_sources": t.attest_sources, "attest_read": t.attest_read,
            "reads_unscoped": t.reads_unscoped.map(iso), "private_facts": "none",
        })
    }

    /// The binding columns `readCredentialBindingForUpdate` reads (`reads_unscoped` included; the caller ignores it
    /// when it did not ask).
    fn binding_row(&self) -> Value {
        json!({
            "member_id": self.member_id, "may_act_for": self.may_act_for, "attest_actor": self.attest_actor,
            "attest_ops": self.attest_ops, "attest_sources": self.attest_sources, "attest_read": self.attest_read,
            "reads_unscoped": self.reads_unscoped.map(iso),
        })
    }

    /// The row `listAccessTokens` returns: the columns `gbrain auth list` prints, the ones not kept at their defaults.
    fn listed(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "scopes": self.scopes,
            "created_at": iso(self.created_at),
            "last_used_at": self.last_used_at.map(iso),
            "revoked_at": self.revoked_at.map(iso),
            "private_pages": "none",
            "private_facts": "none",
            "member_id": self.member_id,
        })
    }
}

impl Store {
    /// `listAccessTokens()`: every token, revoked ones too, newest first (`ORDER BY created_at DESC`; a tie by id).
    pub fn list_access_tokens(&self) -> Result<Value> {
        let read = self.read()?;
        let mut rows = all_tokens(&*read)?;
        rows.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(rows.iter().map(TokenRecord::listed).collect()))
    }

    /// `readActiveAccessTokenGrant(id)`: `{ permissions, private_pages }` of the token not revoked with this id (a UUID,
    /// so any case), or None.
    /// `private_pages` is not kept, so it reads as the column's default.
    pub fn read_active_access_token_grant(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(
            get_json::<TokenRecord>(&*read, &token_key(&id.to_ascii_lowercase()))?
                .filter(|t| t.revoked_at.is_none())
                .map(|t| json!({ "permissions": t.permissions, "private_pages": "none" })),
        )
    }

    /// `readActiveAccessTokenByHash(hash)`: the whole row (`SELECT *`) of the token not revoked with this hash, or None,
    /// for the bearer checks. The columns not kept read as the table's defaults (NULL, and `'none'` for the two private
    /// grants). The row leaves out `token_hash`: the caller passed it, and no member returns a hash.
    pub fn read_active_access_token_by_hash(&self, hash: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(all_tokens(&*read)?
            .into_iter()
            .find(|t| t.revoked_at.is_none() && t.token_hash == hash)
            .map(|t| t.whole_row()))
    }

    /// `convertLegacyAccessTokenGrant(id, columns)`: the first-read conversion of a token still on the legacy shape. A
    /// token with this id (a UUID, so any case) whose `source_grant` is NULL gets the five grant columns, one more grant
    /// revision and `last_used_at` at the store clock, in one write; its whole row comes back. None when no token has
    /// the id or it already has a `source_grant` (the statement's guard). It has no revoked filter, as the statement has
    /// none. `constraint_violation` for a `source_grant` outside the list, and then the row is untouched.
    pub fn convert_legacy_access_token_grant(
        &self,
        id: &str,
        columns: &TokenGrantColumns,
    ) -> Result<Option<Value>> {
        let id = id.to_ascii_lowercase();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(&id))? else {
                return Ok(None);
            };
            if t.source_grant.is_some() {
                return Ok(None);
            }
            t.source_grant = Some(columns.source_grant.clone());
            t.source_id = columns.source_id.clone();
            t.federated_read = columns.federated_read.clone();
            t.allowed_operations = columns.allowed_operations.clone();
            t.takes_holders = columns.takes_holders.clone();
            t.grant_revision += 1;
            t.last_used_at = Some(self.env.now_micros());
            t.check()?;
            put_json(tx, &token_key(&id), &t)?;
            Ok(Some(t.whole_row()))
        })
    }

    /// `touchAccessTokenLastUsed(id, unified)`: stamps the token's `last_used_at` with the store clock, once per token per
    /// 60 seconds (`last_used_at IS NULL OR last_used_at < now() - interval '60 seconds'`), in one write. `unified` is
    /// the statement that only touches a row whose `source_grant` is not NULL: a row still on the legacy shape is left
    /// to its first-read conversion. A token no row has, or a revoked one, is stamped the same as the statement does
    /// (it has no revoked filter); nothing changes for an id no token has.
    pub fn touch_access_token_last_used(&self, id: &str, unified: bool) -> Result<()> {
        let id = id.to_ascii_lowercase();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(&id))? else {
                return Ok(());
            };
            if unified && t.source_grant.is_none() {
                return Ok(());
            }
            let now = self.env.now_micros();
            if t.last_used_at.is_some_and(|last| last >= now - 60_000_000) {
                return Ok(());
            }
            t.last_used_at = Some(now);
            put_json(tx, &token_key(&id), &t)
        })
    }

    /// `accessTokenLive(id)`: whether a token not revoked has this id, compared as text (`id::text = $1`).
    pub fn access_token_live(&self, id: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(
            get_json::<TokenRecord>(&*read, &token_key(id))?
                .is_some_and(|t| t.revoked_at.is_none()),
        )
    }

    /// `revokeAccessTokensNamed(name)`: stamps `revoked_at` on every token not revoked with this exact name, in one
    /// write; the ids it revoked, by id.
    pub fn revoke_access_tokens_named(&self, name: &str) -> Result<Vec<String>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut ids = Vec::new();
            for mut t in all_tokens(&*tx)? {
                if t.revoked_at.is_some() || t.name != name {
                    continue;
                }
                t.revoked_at = Some(now);
                put_json(tx, &token_key(&t.id), &t)?;
                ids.push(t.id);
            }
            ids.sort();
            Ok(ids)
        })
    }

    /// `revokeAccessToken(id)`: stamps `revoked_at` on the token not revoked with this id (a UUID, so any case); its
    /// name, or None.
    pub fn revoke_access_token(&self, id: &str) -> Result<Option<String>> {
        let id = id.to_ascii_lowercase();
        let id = id.as_str();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(id))? else {
                return Ok(None);
            };
            if t.revoked_at.is_some() {
                return Ok(None);
            }
            t.revoked_at = Some(self.env.now_micros());
            put_json(tx, &token_key(id), &t)?;
            Ok(Some(t.name))
        })
    }
}

impl Store {
    /// `readLiveAccessTokenRows()`: the whole row (`SELECT *`, no hash) of every token not revoked, by id, for the
    /// grant checks that read every credential's source grant. Shaped as `read_active_access_token_by_hash` shapes it
    /// (`last_used_at` and the binding columns as stored).
    pub fn read_live_access_token_rows(&self) -> Result<Value> {
        let read = self.read()?;
        let mut tokens: Vec<TokenRecord> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none())
            .collect();
        tokens.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Value::Array(
            tokens.into_iter().map(|t| t.whole_row()).collect(),
        ))
    }
}

impl Store {
    /// `listAccessTokenRows()`: the whole row (`SELECT *`, no hash) of every token, revoked ones too, newest first
    /// (`ORDER BY created_at DESC, id`), shaped as `read_live_access_token_rows` shapes it.
    pub fn list_access_token_rows(&self) -> Result<Value> {
        let read = self.read()?;
        let mut tokens = all_tokens(&*read)?;
        tokens.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            tokens.iter().map(TokenRecord::whole_row).collect(),
        ))
    }

    /// `readCredentialBindingForUpdate({ kind: 'token', id })`: the token's binding columns, or None. The id is matched
    /// exactly (Postgres compares `id::text = $1`) and a revoked token is read too: a binding is kept past a revoke.
    pub fn read_access_token_binding(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(get_json::<TokenRecord>(&*read, &token_key(id))?.map(|t| t.binding_row()))
    }

    /// `writeCredentialBinding({ kind: 'token', id }, binding)`: sets the token's member, may_act_for and attest
    /// columns; whether the token exists. A revoked token is written too.
    pub fn write_token_binding(&self, id: &str, binding: &BindingWrite) -> Result<bool> {
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(tx, &token_key(id))? else {
                return Ok(false);
            };
            t.member_id = binding.member.clone();
            t.may_act_for = binding.may_act_for.clone();
            t.attest_actor = binding.attest_actor.clone();
            t.attest_ops = binding.attest_ops.clone();
            t.attest_sources = binding.attest_sources.clone();
            t.attest_read = binding.attest_read.clone();
            put_json(tx, &token_key(id), &t)?;
            Ok(true)
        })
    }

    /// `writeCredentialReadsUnscoped({ kind: 'token', id }, on)`: sets `reads_unscoped` to now (on) or clears it;
    /// whether the token exists.
    pub fn write_token_reads_unscoped(&self, id: &str, on: bool) -> Result<bool> {
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(tx, &token_key(id))? else {
                return Ok(false);
            };
            t.reads_unscoped = on.then(|| self.env.now_micros());
            put_json(tx, &token_key(id), &t)?;
            Ok(true)
        })
    }

    /// `readLiveMember('legacy_token', id)`'s first step: the member a token not revoked is bound to (None for no
    /// token, a revoked token or an unbound one).
    pub fn read_live_token_member(&self, id: &str) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(get_json::<TokenRecord>(&*read, &token_key(id))?
            .filter(|t| t.revoked_at.is_none())
            .and_then(|t| t.member_id))
    }
}

/// `UPDATE access_tokens SET member_id = $2 WHERE id::text = $1` inside the caller's write (`insertAccessMember` with
/// a `bindTokenId`): binds the token, revoked or not, and does nothing for an id no token has.
pub(crate) fn bind_token_member(tx: &mut dyn KvWrite, id: &str, member: &str) -> Result<()> {
    if let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(id))? {
        t.member_id = Some(member.to_string());
        put_json(tx, &token_key(id), &t)?;
    }
    Ok(())
}
