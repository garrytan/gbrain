//! Jobs: the `access_tokens` table, the columns the legacy-token mint and the read-floor command touch, as the members
//! of `src/core/engine-sql/access-tokens.ts` run them (rust/docs/store/access-tokens.md).
//!
//! Members: insertAccessToken, findActiveAccessTokens, setAccessTokenMinTrust, listAccessTokens (every column), and the
//! member-key setup of `gbrain access serves several` (listUnboundTokenNames, readLiveAccessToken,
//! recordTokenSetupReads, listKeysReadingSource, revokeAccessTokenById). The credential binding members of
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
//! Kept too, for `listAccessTokens`: `last_used_at` (stamped by the bearer check, `touchAccessTokenLastUsed`) and the two private
//! grants `private_pages` and `private_facts` (`'none'` at insert, with their CHECK list; no store member changes them
//! yet). Not kept: the `trust_generation_update` trigger. Setting
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
const PRIVATE_GRANTS: [&str; 2] = ["none", "granted_sources"];

fn private_default() -> String {
    "none".to_owned()
}

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
    /// `last_used_at` in microseconds; NULL until a token's use is stamped.
    #[serde(default)]
    last_used_at: Option<i64>,
    /// The two private grants (`'none'` or `'granted_sources'`).
    #[serde(default = "private_default")]
    private_pages: String,
    #[serde(default = "private_default")]
    private_facts: String,
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
        if !PRIVATE_GRANTS.contains(&self.private_facts.as_str()) {
            return Err(refuse_check("access_tokens_private_facts_check"));
        }
        if !PRIVATE_GRANTS.contains(&self.private_pages.as_str()) {
            return Err(refuse_check("access_tokens_private_pages_check"));
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
                last_used_at: None,
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
    /// The whole row, as `SELECT *` returns it: every column of the table, times as ISO text.
    fn whole_row(&self) -> Value {
        let t = self;
        json!({
            "id": t.id, "name": t.name, "token_hash": t.token_hash, "scopes": t.scopes,
            "created_at": iso(t.created_at), "last_used_at": t.last_used_at.map(iso),
            "revoked_at": t.revoked_at.map(iso), "permissions": t.permissions,
            "source_grant": t.source_grant, "source_id": t.source_id, "federated_read": t.federated_read,
            "allowed_operations": t.allowed_operations, "takes_holders": t.takes_holders,
            "grant_revision": t.grant_revision, "min_trust": t.min_trust, "private_pages": t.private_pages,
            "member_id": t.member_id, "may_act_for": t.may_act_for, "attest_actor": t.attest_actor,
            "attest_ops": t.attest_ops, "attest_sources": t.attest_sources, "attest_read": t.attest_read,
            "reads_unscoped": t.reads_unscoped.map(iso), "private_facts": t.private_facts,
            "read_shared_revision": t.read_shared_revision,
        })
    }
}

impl Store {
    /// `listAccessTokens()`: every token, revoked ones too, newest first (`SELECT * ... ORDER BY created_at DESC`; a
    /// tie by id), each with every column of the table.
    pub fn list_access_tokens(&self) -> Result<Value> {
        let read = self.read()?;
        let mut rows = all_tokens(&*read)?;
        rows.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            rows.iter().map(TokenRecord::whole_row).collect(),
        ))
    }

    /// `readActiveAccessTokenByHash(hash, caller)`: the whole row (`SELECT *`) of the token not revoked with this hash,
    /// for the bearer checks (row 32d-1); the hash in it is the one the caller passed. A record that cannot be read
    /// is skipped, so one corrupt record does not refuse other sign-ins, unless it could be the token asked for (its
    /// `token_hash` is this hash, or its raw bytes hold it): then the read fails closed.
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

    /// `touchAccessTokenLastUsed(id, unified)`: stamps the token's `last_used_at` with the store clock, once per token per
    /// 60 seconds (`last_used_at IS NULL OR last_used_at < now() - interval '60 seconds'`), in one write. `unified` is
    /// the statement that only touches a row whose `source_grant` is not NULL: a row still on the legacy shape is left
    /// to its first-read conversion. A revoked token is stamped the same as the statement does (it has no revoked
    /// filter); nothing changes for an id no token has. Read first: nothing due opens no write; the write re-checks.
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

    /// `revokeAccessTokenById(id)`: stamps `revoked_at` on the token not revoked with this id (a UUID, so any case),
    /// in one write; a revoked or missing one changes nothing.
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
    }

    #[test]
    fn a_touch_that_writes_nothing_opens_no_write_transaction() {
        let writes = Arc::new(AtomicUsize::new(0));
        let kv = CountingKv(crate::test_support::mem_kv(), writes.clone());
        let (env, opts) = (Arc::new(crate::SystemEnv), crate::OpenOptions::default());
        let s = Store::open_kv(Arc::new(kv), env, opts).unwrap();
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
    }
}
