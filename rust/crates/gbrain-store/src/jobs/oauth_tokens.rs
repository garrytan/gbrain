//! Jobs: the `oauth_tokens` table, every column of it, as the members of `src/core/engine-sql/access-credentials.ts`
//! run them (rust/docs/store/oauth-tokens.md): insertOauthToken (the two INSERTs of `OAuthGrants.issue`) and
//! readOauthAccessTokenRows (the bearer check's OAuth token read, `BEARER_SQL.oauth_rungs`), and the refresh-token read
//! and delete of `OAuthGrants.refresh` (readOauthRefreshTokenForUpdate, deleteOauthRefreshToken, `OAUTH_REFRESH_SQL`).
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2C (this file only):
//! - `m 0x2C token_hash -> OauthTokenRecord`: one token row, keyed by its primary key (the SHA-256 of the token).
//!
//! Kept: the table's eight columns (token_hash, token_type, client_id, scopes, expires_at, resource, created_at,
//! grant_type) and its constraints: the primary key (`oauth_tokens_pkey`) and the foreign key to `oauth_clients`
//! (`oauth_tokens_client_id_fkey`, with `ON DELETE CASCADE`: a client delete removes its tokens, `delete_client_tokens`).
//! The table has no CHECK. Not kept: the two secondary indexes (`idx_oauth_tokens_expiry`, `idx_oauth_tokens_client`: the
//! client delete scans the table; the bearer read is a key lookup) and the sweep of expired rows (a raw statement in
//! `src/core/oauth-provider.ts`, so an expired row stays here until its client is deleted; the bearer check refuses it
//! from `expires_at`).

use super::oauth_clients::load_client;
use super::*;
use crate::sources::read_source;

const OAUTH_TOKEN: u8 = 0x2C;
const TABLE: &str = "oauth_tokens";

fn token_key(hash: &str) -> Vec<u8> {
    let mut k = prefix(OAUTH_TOKEN);
    k.extend_from_slice(hash.as_bytes());
    k
}

/// One `oauth_tokens` row. Times are microseconds; `expires_at` is epoch seconds (`BIGINT`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OauthTokenRecord {
    token_hash: String,
    token_type: String,
    client_id: String,
    scopes: Option<Vec<String>>,
    expires_at: Option<i64>,
    resource: Option<String>,
    created_at: i64,
    #[serde(default)]
    grant_type: Option<String>,
}

/// `insertOauthToken(row)`: `token_hash`, `token_type` and `client_id` are required (the table's NOT NULL columns).
/// `created_at` is epoch seconds (the INSERT writes `to_timestamp($n)`); left out, the store clock. `grant_type` left out
/// is the INSERT of a schema without the column: NULL.
#[derive(Debug, Clone, Deserialize)]
pub struct OauthTokenInsert {
    pub token_hash: String,
    pub token_type: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub resource: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub grant_type: Option<String>,
}

/// `EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = $1)`: whether the client holds a token (expired ones count).
pub(super) fn client_holds_token(read: &dyn KvRead, client_id: &str) -> Result<bool> {
    let mut held = false;
    let mut bad = None;
    scan_prefix(read, &prefix(OAUTH_TOKEN), false, &mut |_, v| {
        match serde_json::from_slice::<OauthTokenRecord>(v) {
            Ok(r) => {
                if r.client_id == client_id {
                    held = true;
                    return false;
                }
            }
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable OAuth token record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    match bad {
        Some(e) => Err(e),
        None => Ok(held),
    }
}

/// `ON DELETE CASCADE` of `oauth_tokens_client_id_fkey`: every token of the client goes, in the client's write.
pub(super) fn delete_client_tokens(tx: &mut dyn KvWrite, client_id: &str) -> Result<()> {
    let mut keys = Vec::new();
    let mut bad = None;
    scan_prefix(&*tx, &prefix(OAUTH_TOKEN), false, &mut |k, v| {
        match serde_json::from_slice::<OauthTokenRecord>(v) {
            Ok(r) => {
                if r.client_id == client_id {
                    keys.push(k.to_vec());
                }
            }
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable OAuth token record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    if let Some(e) = bad {
        return Err(e);
    }
    for key in keys {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The sweep of `delete_expired_oauth_tokens`, inside the caller's write (also run by the credential sweep).
pub(super) fn delete_expired_tokens(tx: &mut dyn KvWrite, now_epoch_seconds: i64) -> Result<u32> {
    let mut expired = Vec::new();
    let mut bad = None;
    scan_prefix(&*tx, &prefix(OAUTH_TOKEN), false, &mut |k, v| {
        match serde_json::from_slice::<OauthTokenRecord>(v) {
            Ok(r) => {
                if r.expires_at.is_some_and(|e| e < now_epoch_seconds) {
                    expired.push(k.to_vec());
                }
            }
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable OAuth token record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    if let Some(e) = bad {
        return Err(e);
    }
    for key in &expired {
        tx.delete(key)?;
    }
    Ok(u32::try_from(expired.len()).unwrap_or(u32::MAX))
}

/// `UPDATE oauth_tokens SET expires_at=0`: every token expires (the restore quarantine); how many rows it changed.
pub(super) fn expire_all_tokens(tx: &mut dyn KvWrite) -> Result<u32> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(&*tx, &prefix(OAUTH_TOKEN), false, &mut |k, v| {
        match serde_json::from_slice::<OauthTokenRecord>(v) {
            Ok(r) => rows.push((k.to_vec(), r)),
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable OAuth token record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    if let Some(e) = bad {
        return Err(e);
    }
    let changed = u32::try_from(rows.len()).unwrap_or(u32::MAX);
    for (key, mut row) in rows {
        row.expires_at = Some(0);
        put_json(tx, &key, &row)?;
    }
    Ok(changed)
}

/// `DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`: the token goes only when this client owns it.
pub(super) fn delete_token_of_client(
    tx: &mut dyn KvWrite,
    hash: &str,
    client_id: &str,
) -> Result<()> {
    let key = token_key(hash);
    if get_json::<OauthTokenRecord>(&*tx, &key)?.is_some_and(|r| r.client_id == client_id) {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The names the bearer check's projection drops at each rung of its degrade ladder (a brain missing newer
/// `oauth_clients` columns): rung 1 has no `grant_type`, `surface`, `surface_set_by`; rung 2 also no
/// `bound_slug_prefixes`; rung 3 also no `federated_read`; rung 4 also no `source_id`.
fn dropped_at(rung: u8) -> &'static [&'static str] {
    match rung {
        0 => &[],
        1 => &["token_grant", "surface", "surface_set_by"],
        2 => &[
            "token_grant",
            "surface",
            "surface_set_by",
            "bound_slug_prefixes",
        ],
        3 => &[
            "token_grant",
            "surface",
            "surface_set_by",
            "bound_slug_prefixes",
            "federated_read",
        ],
        _ => &[
            "token_grant",
            "surface",
            "surface_set_by",
            "bound_slug_prefixes",
            "federated_read",
            "source_id",
        ],
    }
}

impl Store {
    /// `insertOauthToken(row)`. `constraint_violation` for a token hash already taken (`oauth_tokens_pkey`) and for a
    /// client the store has none of (`oauth_tokens_client_id_fkey`: a deleted client still counts, as its row stays).
    pub fn insert_oauth_token(&self, row: &OauthTokenInsert) -> Result<()> {
        self.write(|tx| self.put_oauth_token(tx, row))
    }

    /// `issueOauthTokens(rows)`: the tokens of one grant (an access token and its refresh token), each checked as
    /// `insert_oauth_token` checks it, in the one write: the client's row is read in the same write the tokens land in,
    /// so no second connection waits on it, and a refusal of any row (`constraint_violation`) leaves none of them.
    pub fn issue_oauth_tokens(&self, rows: &[OauthTokenInsert]) -> Result<()> {
        self.write(|tx| {
            for row in rows {
                self.put_oauth_token(tx, row)?;
            }
            Ok(())
        })
    }

    fn put_oauth_token(&self, tx: &mut dyn KvWrite, row: &OauthTokenInsert) -> Result<()> {
        if get_json::<OauthTokenRecord>(&*tx, &token_key(&row.token_hash))?.is_some() {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "duplicate key value violates unique constraint \"oauth_tokens_pkey\"",
            ));
        }
        if load_client(&*tx, &row.client_id)?.is_none() {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "insert or update on table \"{TABLE}\" violates foreign key constraint \"oauth_tokens_client_id_fkey\""
                ),
            ));
        }
        let record = OauthTokenRecord {
            token_hash: row.token_hash.clone(),
            token_type: row.token_type.clone(),
            client_id: row.client_id.clone(),
            scopes: row.scopes.clone(),
            expires_at: row.expires_at,
            resource: row.resource.clone(),
            created_at: row
                .created_at
                .map_or_else(|| self.env.now_micros(), |s| s.saturating_mul(1_000_000)),
            grant_type: row.grant_type.clone(),
        };
        put_json(tx, &token_key(&record.token_hash), &record)
    }

    /// `readOauthAccessTokenRows(hash, rung)`: `[row]` for the access token with this hash joined to its client, which
    /// must exist and not be deleted, or `[]`. The row is the bearer check's projection (`BEARER_SQL.oauth_rungs[rung]`):
    /// the token's `client_id`, `scopes`, `expires_at`, `resource` and `token_grant`; the client's `client_name`,
    /// `current_scopes` (its `scope`), `source_id`, `federated_read`, `bound_slug_prefixes`, `surface`, `surface_set_by`
    /// and `current_grant` (the whole row as `to_jsonb` prints it, without the secret hash); and `source_active` and
    /// `active_read_sources` (the sources the client names that are not archived). An expired token is returned too: the
    /// caller refuses it from `expires_at`.
    pub fn read_oauth_access_token_rows(&self, hash: &str, rung: u8) -> Result<Value> {
        let read = self.read()?;
        let Some(t) = get_json::<OauthTokenRecord>(&*read, &token_key(hash))? else {
            return Ok(json!([]));
        };
        if t.token_type != "access" {
            return Ok(json!([]));
        }
        let Some(c) = load_client(&*read, &t.client_id)? else {
            return Ok(json!([]));
        };
        if c.deleted_at.is_some() {
            return Ok(json!([]));
        }
        let live = |id: &str| -> Result<bool> {
            Ok(read_source(&*read, id)?.is_some_and(|s| !s.archived))
        };
        let source_active = match &c.source_id {
            Some(id) => live(id)?,
            None => false,
        };
        // `COALESCE(NULLIF(federated_read, null), [source_id])`: the store's column is never NULL.
        let mut active_read = BTreeSet::new();
        for id in &c.federated_read {
            if live(id)? {
                active_read.insert(id.clone());
            }
        }
        let grant = c.to_grant_json();
        let mut row = json!({
            "client_id": t.client_id, "scopes": t.scopes, "expires_at": t.expires_at, "resource": t.resource,
            "client_name": c.client_name, "current_scopes": c.scope, "token_grant": t.grant_type,
            "current_grant": grant, "source_active": source_active, "active_read_sources": active_read,
            "source_id": c.source_id, "federated_read": c.federated_read,
            "bound_slug_prefixes": c.bound_slug_prefixes, "surface": c.surface, "surface_set_by": c.surface_set_by,
        });
        if let Some(map) = row.as_object_mut() {
            for name in dropped_at(rung) {
                map.remove(*name);
            }
        }
        Ok(json!([row]))
    }

    /// `countOauthAccessTokens(from, to)`: the access tokens whose `expires_at` (epoch seconds) is from `from` to `to`
    /// inclusive, or after `from` (exclusive) with no `to`. A refresh token and a token with a NULL `expires_at` never
    /// count (the comparison with NULL is not true).
    pub fn count_oauth_access_tokens(&self, from: i64, to: Option<i64>) -> Result<i64> {
        let read = self.read()?;
        let mut count = 0_i64;
        let mut bad = None;
        scan_prefix(
            &*read,
            &prefix(OAUTH_TOKEN),
            false,
            &mut |_, v| match serde_json::from_slice::<OauthTokenRecord>(v) {
                Ok(r) => {
                    let inside = r.token_type == "access"
                        && r.expires_at.is_some_and(|e| match to {
                            Some(to) => e >= from && e <= to,
                            None => e > from,
                        });
                    if inside {
                        count += 1;
                    }
                    true
                }
                Err(e) => {
                    bad = Some(StoreError::invalid(format!(
                        "unreadable OAuth token record: {e}"
                    )));
                    false
                }
            },
        )?;
        match bad {
            Some(e) => Err(e),
            None => Ok(count),
        }
    }

    /// `readOauthRefreshTokenForUpdate(hash, clientId)`: the whole row of the refresh token with this hash held by this
    /// client, or null (an access token, or another client's token, reads null). `created_at` is ISO text. An expired
    /// token is returned too: the caller refuses it from `expires_at`. The single write transaction is the lock
    /// `FOR UPDATE` takes elsewhere.
    pub fn read_oauth_refresh_token_for_update(
        &self,
        hash: &str,
        client_id: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        Ok(
            match get_json::<OauthTokenRecord>(&*read, &token_key(hash))? {
                Some(r) if r.token_type == "refresh" && r.client_id == client_id => json!({
                    "token_hash": r.token_hash, "token_type": r.token_type, "client_id": r.client_id,
                    "scopes": r.scopes, "expires_at": r.expires_at, "resource": r.resource,
                    "created_at": iso(r.created_at), "grant_type": r.grant_type,
                }),
                _ => Value::Null,
            },
        )
    }

    /// `deleteOauthRefreshToken(hash, clientId)`: removes the refresh token of this hash held by this client (one write);
    /// an access token of that hash, or another client's token, stays.
    pub fn delete_oauth_refresh_token(&self, hash: &str, client_id: &str) -> Result<()> {
        self.write(|tx| {
            let key = token_key(hash);
            if get_json::<OauthTokenRecord>(&*tx, &key)?
                .is_some_and(|r| r.token_type == "refresh" && r.client_id == client_id)
            {
                tx.delete(&key)?;
            }
            Ok(())
        })
    }

    /// `DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1`: removes every token (of any type) whose `expires_at`
    /// is before `now_epoch_seconds`, in one write, and returns how many went. A token with a NULL `expires_at` stays
    /// (`NULL < $1` is not true). For the sweep of expired credentials (`deleteExpiredOauthCredentials`).
    pub fn delete_expired_oauth_tokens(&self, now_epoch_seconds: i64) -> Result<u32> {
        self.write(|tx| delete_expired_tokens(tx, now_epoch_seconds))
    }
}
