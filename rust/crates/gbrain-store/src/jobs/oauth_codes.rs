//! Jobs: the `oauth_codes` table, every column of it, as the members of `src/core/engine-sql/access-credentials.ts` run
//! them (rust/docs/store/oauth-codes.md): insertOauthCode, readOauthCodeForUpdate, deleteOauthCode, readOauthCodeChallenge
//! (the authorization-code flow of `OAuthGrants` and the provider), the code half of the expired-credential sweep, and
//! `client_holds_oauth_code` (the first-consent check "does this client hold an authorization").
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2D (this file only):
//! - `m 0x2D code_hash -> OauthCodeRecord`: one code row, keyed by its primary key (the SHA-256 of the code).
//!
//! Kept: the table's ten columns and its constraints: the primary key (`oauth_codes_pkey`) and the foreign key to
//! `oauth_clients` (`oauth_codes_client_id_fkey`, `ON DELETE CASCADE`: a client delete removes its codes,
//! `delete_client_codes`). Not kept: the row-level security (the store has no roles). The table has no secondary
//! index here: the client delete and the holds check scan it, every other read is a key lookup. No store call returns a
//! code hash, and the store never logs one.

use super::oauth_clients::load_client;
use super::oauth_tokens::{delete_expired_tokens, expire_all_tokens};
use super::*;
use crate::env::iso;

const OAUTH_CODE: u8 = 0x2D;
const TABLE: &str = "oauth_codes";

fn code_key(hash: &str) -> Vec<u8> {
    let mut k = prefix(OAUTH_CODE);
    k.extend_from_slice(hash.as_bytes());
    k
}

fn s256() -> String {
    "S256".to_string()
}

/// One `oauth_codes` row. Times are microseconds; `expires_at` is epoch seconds (`BIGINT`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OauthCodeRecord {
    code_hash: String,
    client_id: String,
    scopes: Option<Vec<String>>,
    code_challenge: String,
    #[serde(default = "s256")]
    code_challenge_method: String,
    redirect_uri: String,
    state: Option<String>,
    resource: Option<String>,
    expires_at: i64,
    created_at: i64,
}

/// `insertOauthCode(row)`: the table's NOT NULL columns are required; the method left out is `S256` (the column default).
#[derive(Debug, Clone, Deserialize)]
pub struct OauthCodeInsert {
    pub code_hash: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    pub code_challenge: String,
    #[serde(default = "s256")]
    pub code_challenge_method: String,
    pub redirect_uri: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub resource: Option<String>,
    pub expires_at: i64,
}

fn load_code(read: &dyn KvRead, hash: &str) -> Result<Option<OauthCodeRecord>> {
    get_json::<OauthCodeRecord>(read, &code_key(hash))
}

/// Every code key of the table with the client that holds it, a record that no longer parses is an error.
fn scan_codes(
    read: &dyn KvRead,
    mut keep: impl FnMut(&OauthCodeRecord) -> bool,
) -> Result<Vec<Vec<u8>>> {
    let mut keys = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix(OAUTH_CODE), false, &mut |k, v| {
        match serde_json::from_slice::<OauthCodeRecord>(v) {
            Ok(r) => {
                if keep(&r) {
                    keys.push(k.to_vec());
                }
            }
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable OAuth code record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    match bad {
        Some(e) => Err(e),
        None => Ok(keys),
    }
}

/// `EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = $1)`: an expired code counts.
pub(super) fn client_holds_code(read: &dyn KvRead, client_id: &str) -> Result<bool> {
    Ok(!scan_codes(read, |r| r.client_id == client_id)?.is_empty())
}

/// `ON DELETE CASCADE` of `oauth_codes_client_id_fkey`: every code of the client goes, in the client's write.
pub(super) fn delete_client_codes(tx: &mut dyn KvWrite, client_id: &str) -> Result<()> {
    for key in scan_codes(&*tx, |r| r.client_id == client_id)? {
        tx.delete(&key)?;
    }
    Ok(())
}

impl Store {
    /// `insertOauthCode(row)`. `constraint_violation` for a code hash already taken (`oauth_codes_pkey`) and for a client
    /// the store has none of (`oauth_codes_client_id_fkey`: a soft-deleted client still counts, as its row stays).
    pub fn insert_oauth_code(&self, row: &OauthCodeInsert) -> Result<()> {
        self.write(|tx| {
            if load_code(&*tx, &row.code_hash)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"oauth_codes_pkey\"",
                ));
            }
            if load_client(&*tx, &row.client_id)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!(
                        "insert or update on table \"{TABLE}\" violates foreign key constraint \"oauth_codes_client_id_fkey\""
                    ),
                ));
            }
            let record = OauthCodeRecord {
                code_hash: row.code_hash.clone(),
                client_id: row.client_id.clone(),
                scopes: row.scopes.clone(),
                code_challenge: row.code_challenge.clone(),
                code_challenge_method: row.code_challenge_method.clone(),
                redirect_uri: row.redirect_uri.clone(),
                state: row.state.clone(),
                resource: row.resource.clone(),
                expires_at: row.expires_at,
                created_at: self.env.now_micros(),
            };
            put_json(tx, &code_key(&record.code_hash), &record)
        })
    }

    /// `readOauthCodeForUpdate(hash, clientId)`: the whole row of the code with this hash held by this client, or null
    /// (any other client's code reads null). `created_at` is `+00:00`-style ISO text. An expired code is returned too:
    /// the caller refuses it from `expires_at`. The single write transaction is the lock `FOR UPDATE` takes elsewhere.
    pub fn read_oauth_code_for_update(&self, hash: &str, client_id: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(match load_code(&*read, hash)? {
            Some(r) if r.client_id == client_id => json!({
                "code_hash": r.code_hash, "client_id": r.client_id, "scopes": r.scopes,
                "code_challenge": r.code_challenge, "code_challenge_method": r.code_challenge_method,
                "redirect_uri": r.redirect_uri, "state": r.state, "resource": r.resource,
                "expires_at": r.expires_at, "created_at": iso(r.created_at),
            }),
            _ => Value::Null,
        })
    }

    /// `deleteOauthCode(hash, clientId)`: removes the code of this hash held by this client (one write); nothing else.
    pub fn delete_oauth_code(&self, hash: &str, client_id: &str) -> Result<()> {
        self.write(|tx| {
            if load_code(&*tx, hash)?.is_some_and(|r| r.client_id == client_id) {
                tx.delete(&code_key(hash))?;
            }
            Ok(())
        })
    }

    /// `readOauthCodeChallenge(hash, clientId, now)`: the PKCE challenge of the code with this hash held by this
    /// client when it expires after `now_epoch_seconds` and the client's row is not soft-deleted, else None.
    pub fn read_oauth_code_challenge(
        &self,
        hash: &str,
        client_id: &str,
        now_epoch_seconds: i64,
    ) -> Result<Option<String>> {
        let read = self.read()?;
        let Some(code) = load_code(&*read, hash)? else {
            return Ok(None);
        };
        if code.client_id != client_id || code.expires_at <= now_epoch_seconds {
            return Ok(None);
        }
        let live = load_client(&*read, client_id)?.is_some_and(|c| c.deleted_at.is_none());
        Ok(live.then_some(code.code_challenge))
    }

    /// Whether the client holds an authorization code (the `oauth_codes` half of first consent's "holds an
    /// authorization" check, `SELECT EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = $1)`): an expired code counts.
    pub fn client_holds_oauth_code(&self, client_id: &str) -> Result<bool> {
        let read = self.read()?;
        client_holds_code(&*read, client_id)
    }

    /// `DELETE FROM oauth_tokens WHERE expires_at < $1` and `DELETE FROM oauth_codes WHERE expires_at < $1` of the
    /// startup sweep, in one write; how many rows the two removed (a code's `expires_at` is never NULL).
    pub fn delete_expired_oauth_credentials(&self, now_epoch_seconds: i64) -> Result<u32> {
        self.write(|tx| {
            let tokens = delete_expired_tokens(tx, now_epoch_seconds)?;
            let expired = scan_codes(&*tx, |r| r.expires_at < now_epoch_seconds)?;
            for key in &expired {
                tx.delete(key)?;
            }
            Ok(tokens.saturating_add(u32::try_from(expired.len()).unwrap_or(u32::MAX)))
        })
    }

    /// `UPDATE oauth_tokens SET expires_at=0` and `UPDATE oauth_codes SET expires_at=0` of the shared-skill restore
    /// quarantine, in one write: every token and code expires, so no grant the archive carried is honored.
    pub fn expire_all_oauth_credentials(&self) -> Result<()> {
        self.write(|tx| {
            expire_all_tokens(tx)?;
            for key in scan_codes(&*tx, |_| true)? {
                if let Some(mut row) = get_json::<OauthCodeRecord>(&*tx, &key)? {
                    row.expires_at = 0;
                    put_json(tx, &key, &row)?;
                }
            }
            Ok(())
        })
    }
}
