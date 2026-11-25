//! Jobs: the `access_tokens` table, the columns the legacy-token mint and the read-floor command touch, as the members
//! of `src/core/engine-sql/access-tokens.ts` run them (rust/docs/store/access-tokens.md).
//!
//! Members: insertAccessToken, findActiveAccessTokens, setAccessTokenMinTrust, readLiveAccessTokenScope, and the credential members of
//! `src/core/engine-sql/access-credentials.ts`: listAccessTokens, readActiveAccessTokenGrant, accessTokenLive,
//! readActiveAccessTokenByHash (the bearer checks), revokeAccessTokensNamed and revokeAccessToken; the legacy-token
//! read of readJobPrincipal (`src/core/engine-sql/access-control.ts`), through read_access_token; and the member-key
//! setup members of `src/core/engine-sql/access-setup.ts`: listUnboundTokenNames, readLiveAccessToken (the one call that
//! returns a hash: the setup compares it to the key file), recordTokenSetupReads and listKeysReadingSource. The
//! credential binding members (the member, may_act_for, attest and reads_unscoped columns) read and write these records
//! in `credential_binding.rs`.
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2B (this file only):
//! - `m 0x2B id -> TokenRecord`: one token row, keyed by its generated UUID.
//!
//! Kept: the columns those members read or write (id, name, token_hash, scopes, permissions, the five grant
//! columns, grant_revision, min_trust, revoked_at, created_at, last_used_at, member_id, may_act_for, the four attest
//! columns, reads_unscoped and the two private grants) and the table's constraints on them: the unique
//! `token_hash` (`access_tokens_token_hash_key`, found by scanning the table, as the secondary indexes are not kept), the
//! `source_grant` list, the `min_trust` list and the two private-grant lists. A refusal is `constraint_violation` with the Postgres message.
//! The two private grants (`private_pages`, `private_facts`) are kept with their CHECK lists, `'none'` at insert; a
//! record written before they were kept reads `'none'`. Not kept: the `trust_generation_update` trigger. `member_id` and `may_act_for` are set by the insert (when it
//! names them), by a member insert that binds the token, and by the credential binding write. `last_used_at` is
//! stamped by the bearer check (`touch_access_token_last_used`) and NULL before. Only `readLiveAccessToken` and doctor's
//! whole-row `listActiveAccessTokenRows` (`doctor_credentials.rs`) return `token_hash`. Setting the floor of an id no token has changes nothing (Postgres also refuses an id that is not a UUID with 22P02; the
//! caller here always passes the id `findActiveAccessTokens` returned).

use super::*;
use crate::env::{iso, parse_iso};
use crate::kv::KvWrite;

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

/// One `access_tokens` row. Times are microseconds. A field added after the first records were written defaults to
/// NULL when an older record is read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct TokenRecord {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) token_hash: String,
    pub(super) scopes: Option<Vec<String>>,
    pub(super) permissions: Value,
    pub(super) source_grant: Option<String>,
    pub(super) source_id: Option<String>,
    pub(super) federated_read: Option<Vec<String>>,
    pub(super) allowed_operations: Option<Vec<String>>,
    pub(super) takes_holders: Option<Vec<String>>,
    pub(super) grant_revision: i32,
    /// The revision the read-shared switch was set at (the birth revision, 1); None is off.
    #[serde(default)]
    pub(super) read_shared_revision: Option<i32>,
    pub(super) min_trust: Option<String>,
    pub(super) revoked_at: Option<i64>,
    pub(super) created_at: i64,
    /// Stamped by the bearer check, at most once a minute.
    #[serde(default)]
    pub(super) last_used_at: Option<i64>,
    /// The member the token is bound to.
    #[serde(default)]
    pub(super) member_id: Option<String>,
    /// The people the token may act for (`may_act_for TEXT[]`).
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
    /// The private-pages grant (`'none'` or `'granted_sources'`); a record written before the store kept it reads `'none'`.
    #[serde(default = "private_default")]
    pub(super) private_pages: String,
    /// The private-facts grant, kept the same way.
    #[serde(default = "private_default")]
    pub(super) private_facts: String,
}

const PRIVATE_GRANTS: [&str; 2] = ["none", "granted_sources"];

fn private_default() -> String {
    "none".to_string()
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
        if !PRIVATE_GRANTS.contains(&self.private_facts.as_str()) {
            return Err(refuse_check("access_tokens_private_facts_check"));
        }
        if !PRIVATE_GRANTS.contains(&self.private_pages.as_str()) {
            return Err(refuse_check("access_tokens_private_pages_check"));
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
/// at grant revision 1, as the mint's statement writes it. `member_id`, `may_act_for` and `created_at` are for a caller
/// that seeds a bound token; the mint leaves them out (NULL, NULL and the store clock).
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
    #[serde(default)]
    pub member_id: Option<String>,
    #[serde(default)]
    pub may_act_for: Option<Vec<String>>,
    /// ISO text; None is the store clock (`COALESCE(created_at, now())`).
    #[serde(default)]
    pub created_at: Option<String>,
}

fn iso_time(text: Option<&str>, what: &str) -> Result<Option<i64>> {
    text.map(|t| {
        parse_iso(t)
            .ok_or_else(|| StoreError::invalid(format!("{what}: \"{t}\" is not an ISO time")))
    })
    .transpose()
}

/// A member insert that binds a token (`UPDATE access_tokens SET member_id = $2 WHERE id::text = $1`), inside the
/// caller's write: the token whose id is exactly `token_id` is bound to `member_id`; nothing changes when no token has
/// it.
pub(crate) fn bind_token_member(
    tx: &mut dyn KvWrite,
    token_id: &str,
    member_id: &str,
) -> Result<()> {
    let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(token_id))? else {
        return Ok(());
    };
    t.member_id = Some(member_id.to_string());
    put_json(tx, &token_key(token_id), &t)
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
        let revoked_at = iso_time(row.revoked_at.as_deref(), "revoked_at")?;
        let created_at = iso_time(row.created_at.as_deref(), "created_at")?;
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
                created_at: created_at.unwrap_or_else(|| self.env.now_micros()),
                last_used_at: None,
                member_id: row.member_id.clone(),
                may_act_for: row.may_act_for.clone(),
                attest_actor: None,
                attest_ops: None,
                attest_sources: None,
                attest_read: None,
                reads_unscoped: None,
                private_pages: private_default(),
                private_facts: private_default(),
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

    /// `readAccessTokenNames(ids)`: `[{ id, name }]` of the tokens whose id is one of `ids`, revoked ones included, by id;
    /// an id no token has is left out. The names `get_write_attribution` shows for a legacy token.
    pub fn read_access_token_names(&self, ids: &[String]) -> Result<Value> {
        let read = self.read()?;
        let mut wanted: Vec<&String> = ids.iter().collect();
        wanted.sort();
        wanted.dedup();
        let mut rows = Vec::new();
        for id in wanted {
            if let Some(t) = get_json::<TokenRecord>(&*read, &token_key(id))? {
                rows.push(json!({ "id": t.id, "name": t.name }));
            }
        }
        Ok(Value::Array(rows))
    }

    /// `readLiveAccessTokenScope(id)`: `{ reads_unscoped, created_at }` of the token `id` names when it is not revoked
    /// (both as ISO text; `reads_unscoped` is null unless the token opted out with `--reads-unscoped`), or null.
    pub fn read_live_access_token_scope(&self, id: &str) -> Result<Value> {
        let read = self.read()?;
        match get_json::<TokenRecord>(&*read, &token_key(id))? {
            Some(t) if t.revoked_at.is_none() => Ok(json!({
                "reads_unscoped": t.reads_unscoped.map(iso),
                "created_at": iso(t.created_at),
            })),
            _ => Ok(Value::Null),
        }
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
    /// The whole row (`SELECT *` or `RETURNING *`) less `token_hash`.
    fn whole_row(&self) -> Value {
        let t = self;
        json!({
            "id": t.id, "name": t.name, "scopes": t.scopes, "created_at": iso(t.created_at),
            "last_used_at": t.last_used_at.map(iso), "revoked_at": t.revoked_at.map(iso), "permissions": t.permissions,
            "source_grant": t.source_grant, "source_id": t.source_id, "federated_read": t.federated_read,
            "allowed_operations": t.allowed_operations, "takes_holders": t.takes_holders,
            "grant_revision": t.grant_revision, "min_trust": t.min_trust, "private_pages": t.private_pages,
            "member_id": t.member_id, "may_act_for": t.may_act_for, "attest_actor": t.attest_actor,
            "attest_ops": t.attest_ops, "attest_sources": t.attest_sources, "attest_read": t.attest_read,
            "reads_unscoped": t.reads_unscoped.map(iso), "private_facts": t.private_facts,
            "read_shared_revision": t.read_shared_revision,
        })
    }

    /// The whole row with its hash, every column of `access_tokens` named: `SELECT *` as the SQL engines return it
    /// (doctor's active-token read; the parity case compares every column).
    pub(super) fn row_with_hash(&self) -> Value {
        let mut row = self.whole_row();
        row["token_hash"] = json!(self.token_hash);
        row
    }

    /// The row as `to_jsonb(t)` prints it in a UTC session: `row_with_hash` with the times as `to_jsonb` text
    /// (`+00:00`, no trailing fraction zeros).
    pub(super) fn to_jsonb_row(&self) -> Value {
        let mut row = self.row_with_hash();
        for (name, micros) in [
            ("created_at", Some(self.created_at)),
            ("last_used_at", self.last_used_at),
            ("revoked_at", self.revoked_at),
            ("reads_unscoped", self.reads_unscoped),
        ] {
            row[name] = micros.map_or(Value::Null, |m| json!(super::oauth_clients::jsonb_time(m)));
        }
        row
    }

    /// The row `listAccessTokens` returns: the columns `gbrain auth list` prints.
    fn listed(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "scopes": self.scopes,
            "created_at": iso(self.created_at),
            "last_used_at": self.last_used_at.map(iso),
            "revoked_at": self.revoked_at.map(iso),
            "private_pages": self.private_pages,
            "private_facts": self.private_facts,
            "member_id": self.member_id,
            "source_grant": self.source_grant,
            "source_id": self.source_id,
            "federated_read": self.federated_read,
            "grant_revision": self.grant_revision,
            "read_shared_revision": self.read_shared_revision,
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
    pub fn read_active_access_token_grant(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(
            get_json::<TokenRecord>(&*read, &token_key(&id.to_ascii_lowercase()))?
                .filter(|t| t.revoked_at.is_none())
                .map(|t| json!({ "permissions": t.permissions, "private_pages": t.private_pages })),
        )
    }

    /// `readJobPrincipal({ kind: 'legacy_token', id })` (`SELECT * FROM access_tokens WHERE id = $1`): the whole row of
    /// the token with this id (a UUID, so any case), revoked or not, or None. The caller reads `revoked_at` itself and
    /// names it when it denies a job. The row has the same columns as the bearer read's and leaves out `token_hash`.
    pub fn read_access_token(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(
            get_json::<TokenRecord>(&*read, &token_key(&id.to_ascii_lowercase()))?
                .map(|t| t.whole_row()),
        )
    }

    /// `lockActiveAccessTokens(target)` (`SELECT * ... AND revoked_at IS NULL FOR UPDATE`, the row `auth rescope` edits):
    /// the whole rows of the tokens not revoked whose id is `id` (a UUID, so any case) or whose name is exactly `name`,
    /// oldest first and a tie by id. The lock is skipped while explicit transactions hold the writer (`serialized_transactions`), which this fn asserts. Exactly one of the two
    /// names the target; anything else is `invalid_argument`. The rows leave out `token_hash`, as every store row does.
    pub fn lock_active_access_tokens(&self, id: Option<&str>, name: Option<&str>) -> Result<Value> {
        self.assert_serialized_transactions("lockActiveAccessTokens")?;
        let read = self.read()?;
        let mut rows: Vec<TokenRecord> = match (id, name) {
            (Some(id), None) => {
                get_json::<TokenRecord>(&*read, &token_key(&id.to_ascii_lowercase()))?
                    .into_iter()
                    .collect()
            }
            (None, Some(name)) => all_tokens(&*read)?
                .into_iter()
                .filter(|t| t.name == name)
                .collect(),
            _ => {
                return Err(StoreError::invalid(
                    "lockActiveAccessTokens needs exactly one of id and name",
                ));
            }
        };
        rows.retain(|t| t.revoked_at.is_none());
        rows.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            rows.iter().map(TokenRecord::whole_row).collect(),
        ))
    }

    /// `readActiveAccessTokenByHash(hash)`: the whole row (`SELECT *`) of the token not revoked with this hash, or None,
    /// for the bearer checks. The columns not kept read as the table's defaults (NULL, and `'none'` for the two private
    /// grants). The row leaves out `token_hash`: the caller passed it, and no member returns a hash. A record that
    /// cannot be read is skipped, so one corrupt record does not refuse other sign-ins, unless it could be the token
    /// asked for: a JSON record whose `token_hash` is this hash, or a record that is not JSON at all and whose bytes
    /// hold this hash. Then the read fails closed.
    pub fn read_active_access_token_by_hash(&self, hash: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let (mut found, mut target_unreadable) = (None, None);
        scan_prefix(&*read, &prefix(TOKEN), false, &mut |_, v| {
            match serde_json::from_slice::<TokenRecord>(v) {
                Ok(t) if t.revoked_at.is_none() && t.token_hash == hash => found = Some(t),
                Ok(_) => {}
                Err(e) => {
                    let is_target = match serde_json::from_slice::<Value>(v) {
                        Ok(j) => j.get("token_hash").and_then(Value::as_str) == Some(hash),
                        Err(_) => {
                            !hash.is_empty() && v.windows(hash.len()).any(|w| w == hash.as_bytes())
                        }
                    };
                    if is_target {
                        target_unreadable =
                            Some(StoreError::invalid(format!("unreadable token record: {e}")));
                    }
                }
            }
            true
        })?;
        target_unreadable.map_or(Ok(found.map(|t| t.whole_row())), Err)
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

    /// `writeAccessTokenGrant(id, write)` (`auth rescope`'s grant write): the token with this id (a UUID, so any case),
    /// revoked or not as the statement has no revoked filter, gets the five grant columns, the scopes when given (None
    /// keeps them), the `permissions` mirror and one more grant revision, in one write; the new revision, or None when no
    /// token has the id. `constraint_violation` for a `source_grant` outside the list, and then the row is untouched.
    pub fn write_access_token_grant(
        &self,
        id: &str,
        columns: &TokenGrantColumns,
        scopes: Option<Vec<String>>,
        permissions: Value,
    ) -> Result<Option<i32>> {
        let id = id.to_ascii_lowercase();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(&id))? else {
                return Ok(None);
            };
            t.source_grant = Some(columns.source_grant.clone());
            t.source_id = columns.source_id.clone();
            t.federated_read = columns.federated_read.clone();
            t.allowed_operations = columns.allowed_operations.clone();
            t.takes_holders = columns.takes_holders.clone();
            if let Some(scopes) = &scopes {
                t.scopes = Some(scopes.clone());
            }
            t.grant_revision += 1;
            t.permissions = permissions.clone();
            t.check()?;
            put_json(tx, &token_key(&id), &t)?;
            Ok(Some(t.grant_revision))
        })
    }

    /// `setAccessTokenReadSharedRevision(id, revision)`: `UPDATE access_tokens SET read_shared_revision = $2 WHERE id =
    /// $1::uuid` (GST-2898; `None` clears the switch) for the token with this id (a UUID, so any case); nothing changes
    /// when no token has the id.
    pub fn set_access_token_read_shared_revision(
        &self,
        id: &str,
        revision: Option<i32>,
    ) -> Result<()> {
        let id = id.to_ascii_lowercase();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(&id))? else {
                return Ok(());
            };
            t.read_shared_revision = revision;
            put_json(tx, &token_key(&id), &t)
        })
    }

    /// `writeAccessTokenPrivateGrant(id, axis, value)`: sets `private_pages` or `private_facts` of the token with this id
    /// (a UUID, so any case) to `value`; nothing changes when no token has the id. `constraint_violation` for a value
    /// other than `'none'` and `'granted_sources'`, and then the row is untouched; `invalid_argument` for another axis.
    pub fn write_access_token_private_grant(
        &self,
        id: &str,
        axis: &str,
        value: &str,
    ) -> Result<()> {
        if axis != "private_pages" && axis != "private_facts" {
            return Err(StoreError::invalid(format!(
                "writeAccessTokenPrivateGrant: \"{axis}\" is not private_pages or private_facts"
            )));
        }
        let id = id.to_ascii_lowercase();
        self.write(|tx| {
            let Some(mut t) = get_json::<TokenRecord>(&*tx, &token_key(&id))? else {
                return Ok(());
            };
            if axis == "private_pages" {
                t.private_pages = value.to_string();
            } else {
                t.private_facts = value.to_string();
            }
            t.check()?;
            put_json(tx, &token_key(&id), &t)
        })
    }

    /// `lockLegacyAccessTokens()` (`SELECT * ... WHERE revoked_at IS NULL AND source_grant IS NULL ORDER BY created_at, id
    /// FOR UPDATE`): the whole rows of the active tokens still on the legacy shape, oldest first and a tie by id. The store
    /// The lock is skipped while explicit transactions hold the writer (`serialized_transactions`), which this fn asserts.
    /// The rows leave out `token_hash`.
    pub fn lock_legacy_access_tokens(&self) -> Result<Value> {
        self.assert_serialized_transactions("lockLegacyAccessTokens")?;
        let read = self.read()?;
        let mut rows: Vec<TokenRecord> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && t.source_grant.is_none())
            .collect();
        rows.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            rows.iter().map(TokenRecord::whole_row).collect(),
        ))
    }

    /// `touchAccessTokenLastUsed(id, unified)`: stamps the token's `last_used_at` with the store clock, once per token per
    /// 60 seconds (`last_used_at IS NULL OR last_used_at < now() - interval '60 seconds'`), in one write. `unified` is
    /// the statement that only touches a row whose `source_grant` is not NULL: a row still on the legacy shape is left
    /// to its first-read conversion. A token no row has, or a revoked one, is stamped the same as the statement does
    /// (it has no revoked filter); nothing changes for an id no token has. Read first: nothing due opens no write; the
    /// write re-checks.
    pub fn touch_access_token_last_used(&self, id: &str, unified: bool) -> Result<()> {
        let id = id.to_ascii_lowercase();
        let due = |t: &TokenRecord, now: i64| {
            !(unified && t.source_grant.is_none())
                && !t.last_used_at.is_some_and(|last| last >= now - 60_000_000)
        };
        let peek = get_json::<TokenRecord>(&*self.read()?, &token_key(&id))?;
        if !peek.is_some_and(|t| due(&t, self.env.now_micros())) {
            return Ok(());
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            match get_json::<TokenRecord>(&*tx, &token_key(&id))? {
                Some(mut t) if due(&t, now) => {
                    t.last_used_at = Some(now);
                    put_json(tx, &token_key(&id), &t)
                }
                _ => Ok(()),
            }
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

/// The member-key setup reads and writes of `gbrain access serves several` (`src/core/engine-sql/access-setup.ts`).
impl Store {
    /// `listUnboundTokenNames()`: the distinct names of the tokens not revoked and bound to no member, in byte order
    /// (`SELECT DISTINCT name COLLATE "C" ... ORDER BY name`).
    pub fn list_unbound_token_names(&self) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut names: Vec<String> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && t.member_id.is_none())
            .map(|t| t.name)
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// `readLiveAccessToken(name)`: `{ member_id, token_hash, source_grant, source_id, federated_read, permissions }` of
    /// the token not revoked with this exact name, or None. The member-key setup compares the hash of the key file to
    /// `token_hash`, so this is the one store call that returns a hash; the store still never logs one. The statement
    /// has no order: when several live tokens share the name, the oldest (then the lowest id) answers, as a heap scan
    /// of rows inserted in order finds it first.
    pub fn read_live_access_token(&self, name: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && t.name == name)
            .min_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)))
            .map(|t| {
                json!({
                    "member_id": t.member_id, "token_hash": t.token_hash, "source_grant": t.source_grant,
                    "source_id": t.source_id, "federated_read": t.federated_read, "permissions": t.permissions,
                })
            }))
    }

    /// `recordTokenSetupReads(name, reads)`: sets `setup_reads` to `reads` in the `permissions` object of every token
    /// not revoked with this exact name, keeping its other fields, in one write
    /// (`COALESCE(permissions, '{}') || jsonb_build_object('setup_reads', reads)`). A token whose `permissions` is
    /// neither NULL nor an object is left alone, as the statement's guard leaves it.
    pub fn record_token_setup_reads(&self, name: &str, reads: &[String]) -> Result<()> {
        self.write(|tx| {
            for mut t in all_tokens(&*tx)? {
                if t.revoked_at.is_some() || t.name != name {
                    continue;
                }
                let mut fields = match t.permissions {
                    Value::Null => serde_json::Map::new(),
                    Value::Object(ref m) => m.clone(),
                    _ => continue,
                };
                fields.insert("setup_reads".to_owned(), json!(reads));
                t.permissions = Value::Object(fields);
                put_json(tx, &token_key(&t.id), &t)?;
            }
            Ok(())
        })
    }

    /// `listKeysReadingSource(sourceId)`: `[{ name, member_id, federated_read }]` of the tokens not revoked, bound to a
    /// member, on the `federated` grant, whose write source is another source (a NULL one is not, as `<>` is not true
    /// for NULL) and whose read list holds `sourceId`; by name in byte order (`ORDER BY name COLLATE "C"`), a tie by id.
    pub fn list_keys_reading_source(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<TokenRecord> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| {
                t.revoked_at.is_none()
                    && t.member_id.is_some()
                    && t.source_grant.as_deref() == Some("federated")
                    && t.source_id.as_deref().is_some_and(|s| s != source_id)
                    && t.federated_read
                        .as_ref()
                        .is_some_and(|f| f.iter().any(|s| s == source_id))
            })
            .collect();
        rows.sort_by(|a, b| {
            a.name
                .as_bytes()
                .cmp(b.name.as_bytes())
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            rows.into_iter()
                .map(|t| json!({ "name": t.name, "member_id": t.member_id, "federated_read": t.federated_read }))
                .collect(),
        ))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::{Kv, KvRead, KvWrite};
    use std::sync::{Arc, atomic::AtomicUsize, atomic::Ordering::SeqCst};

    /// Counts the write transactions a store opens (test-only; a read opens none).
    struct CountingKv(Arc<dyn Kv>, Arc<AtomicUsize>);
    impl Kv for CountingKv {
        fn snapshot(&self) -> Result<Box<dyn KvRead>> {
            self.0.snapshot()
        }
        fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
            self.0.versioned_snapshot()
        }
        fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
            self.1.fetch_add(1, SeqCst);
            self.0.begin_write()
        }
        fn version(&self) -> Result<u64> {
            self.0.version()
        }
    }

    fn insert(s: &Store, hash: &str, grant: Option<&str>) -> String {
        let row = json!({ "name": hash, "token_hash": hash, "source_grant": grant });
        let row = serde_json::from_value(row).unwrap();
        s.insert_access_token(&row).unwrap()
    }

    #[test]
    fn an_unreadable_record_fails_the_sign_in_only_when_it_is_the_target() {
        let s = crate::test_support::store();
        insert(&s, "good", Some("default"));
        let put = |bytes: &[u8]| s.write(|tx| tx.put(&token_key("bad"), bytes)).unwrap();
        let by_hash = || s.read_active_access_token_by_hash("good");
        for other in [&br#"{"token_hash":"other"}"#[..], b"\xff not json"] {
            put(other);
            assert_eq!(by_hash().unwrap().unwrap()["name"], json!("good"));
        }
        for target in [&br#"{"token_hash":"good"}"#[..], b"\xff good \xff"] {
            put(target);
            assert!(by_hash().unwrap_err().message.contains("unreadable"));
        }
        assert!(s.list_access_tokens().is_err(), "other readers stay strict");
        // An empty hash names no token: a record that is not JSON is skipped, never matched by a zero-length window.
        put(b"\xff not json");
        assert_eq!(by_hash_of(&s, ""), None);
    }

    fn by_hash_of(s: &Store, hash: &str) -> Option<Value> {
        s.read_active_access_token_by_hash(hash).unwrap()
    }

    /// The store clock, set by the test.
    struct Clock(std::sync::atomic::AtomicI64);
    impl crate::env::Env for Clock {
        fn now_micros(&self) -> i64 {
            self.0.load(SeqCst)
        }
        fn new_uuid(&self) -> String {
            crate::SystemEnv.new_uuid()
        }
    }

    #[test]
    fn a_touch_that_writes_nothing_opens_no_write_transaction() {
        let writes = Arc::new(AtomicUsize::new(0));
        let kv = CountingKv(crate::test_support::mem_kv(), writes.clone());
        let clock = Arc::new(Clock(std::sync::atomic::AtomicI64::new(
            1_700_000_000_000_000,
        )));
        let s = Store::open_kv(Arc::new(kv), clock.clone(), crate::OpenOptions::default()).unwrap();
        let (id, legacy) = (insert(&s, "a", Some("default")), insert(&s, "b", None));
        let base = writes.load(SeqCst);
        let touch = |id: &str| s.touch_access_token_last_used(id, true).unwrap();
        touch("00000000-0000-4000-8000-000000000000");
        touch(&legacy);
        assert_eq!(writes.load(SeqCst) - base, 0, "missing id, no source_grant");
        touch(&id);
        assert_eq!(writes.load(SeqCst) - base, 1, "a due touch writes once");
        touch(&id);
        assert_eq!(writes.load(SeqCst) - base, 1, "inside 60 s: no write");
        // At exactly 60 s the stamp is not due (`last_used_at < now() - interval '60 seconds'`).
        clock.0.fetch_add(60_000_000, SeqCst);
        touch(&id);
        assert_eq!(writes.load(SeqCst) - base, 1, "at 60 s: no write");
        // Past the debounce the token is stamped again, with the new time, in exactly one write; the id is compared
        // lower-cased, so an upper-case id finds it.
        clock.0.fetch_add(1, SeqCst);
        touch(&id.to_ascii_uppercase());
        assert_eq!(writes.load(SeqCst) - base, 2, "past 60 s: one more write");
        // Without `unified` a row with no source_grant is stamped too.
        s.touch_access_token_last_used(&legacy, false).unwrap();
        assert_eq!(
            writes.load(SeqCst) - base,
            3,
            "not unified: the legacy row is stamped"
        );
        let row = by_hash_of(&s, "a").unwrap();
        assert_eq!(
            row["last_used_at"].as_str().map(str::to_owned),
            Some(iso(clock.0.load(SeqCst)))
        );
    }
}
