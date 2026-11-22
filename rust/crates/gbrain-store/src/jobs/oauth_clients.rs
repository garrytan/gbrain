//! Jobs: the `oauth_clients` table, every column of it, as the members of `src/core/engine-sql/oauth-clients.ts` and
//! `spend-log.ts` run them (rust/docs/store/spend-log.md, rust/docs/store/oauth-clients.md).
//!
//! Members: insertOauthClient, updateOauthClientBudget, readClientBudgetUsd, readOauthClient, listSourceOAuthClients,
//! and the client reads the admission and the agent spend view make (`budget_cents`, `agent_clients`).
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2A (this file only):
//! - `m 0x2A client_id -> ClientRecord`: one client, the full row (the 41 columns of the table after every migration,
//!   with the defaults the table gives them).
//!
//! Every write goes through `put_client`, which holds the row to the table's constraints: the agent-grant check
//! (`oauth_clients_complete_agent_grant`, src/core/grants/schema.ts), the five value lists and the `sources` foreign
//! key. A refusal is `constraint_violation` with the Postgres message (`new row for relation "oauth_clients" violates
//! check constraint "..."`); the TypeScript member gives it the SQLSTATE and constraint name PGLite and Postgres raise.
//! Not kept: the `trust_generation_update` trigger and the secondary indexes (a read scans the table). A source
//! delete runs [`remove_source_rows`]: the `ON DELETE RESTRICT` of `source_id` and the `ON DELETE SET NULL` of
//! `bound_source_id`.

use super::spend::numeric_fixed;
use super::*;
use crate::env::{iso, parse_iso};
use crate::sources::read_source;

const CLIENT: u8 = 0x2A;
const TABLE: &str = "oauth_clients";

fn client_key(client_id: &str) -> Vec<u8> {
    let mut k = prefix(CLIENT);
    k.extend_from_slice(client_id.as_bytes());
    k
}

fn default_grant_types() -> Option<Vec<String>> {
    Some(vec!["client_credentials".to_string()])
}
fn one() -> i32 {
    1
}
fn prefixes() -> String {
    "prefixes".to_string()
}
fn none_text() -> String {
    "none".to_string()
}

/// One `oauth_clients` row. Times are microseconds; `budget` is hundredths of a dollar (`NUMERIC(10,2)`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ClientRecord {
    pub(super) client_id: String,
    #[serde(default)]
    pub(super) client_secret_hash: Option<String>,
    pub(super) client_name: String,
    #[serde(default)]
    pub(super) redirect_uris: Option<Vec<String>>,
    #[serde(default = "default_grant_types")]
    pub(super) grant_types: Option<Vec<String>>,
    #[serde(default)]
    pub(super) scope: Option<String>,
    #[serde(default)]
    pub(super) token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    pub(super) client_id_issued_at: Option<i64>,
    #[serde(default)]
    pub(super) client_secret_expires_at: Option<i64>,
    #[serde(default)]
    pub(super) token_ttl: Option<i32>,
    #[serde(default)]
    pub(super) deleted_at: Option<i64>,
    #[serde(default)]
    pub(super) source_id: Option<String>,
    #[serde(default)]
    pub(super) federated_read: Vec<String>,
    #[serde(default)]
    pub(super) budget: Option<i64>,
    #[serde(default)]
    pub(super) bound_tools: Option<Vec<String>>,
    #[serde(default)]
    pub(super) bound_source_id: Option<String>,
    #[serde(default)]
    pub(super) bound_brain_id: Option<String>,
    #[serde(default)]
    pub(super) bound_slug_prefixes: Option<Vec<String>>,
    #[serde(default = "one")]
    pub(super) bound_max_concurrent: i32,
    #[serde(default)]
    pub(super) surface: Option<String>,
    #[serde(default)]
    pub(super) surface_set_by: Option<String>,
    #[serde(default)]
    pub(super) allowed_operations: Option<Vec<String>>,
    #[serde(default)]
    pub(super) delegated_slug_prefixes: Option<Vec<String>>,
    #[serde(default = "prefixes")]
    pub(super) delegated_namespace: String,
    #[serde(default)]
    pub(super) grant_profile: Option<String>,
    #[serde(default)]
    pub(super) grant_revision: i32,
    /// `read_shared_revision` (v323): the read-shared switch is on while it equals `grant_revision`.
    #[serde(default)]
    pub(super) read_shared_revision: Option<i32>,
    #[serde(default)]
    pub(super) grant_repair_reasons: Vec<String>,
    pub(super) created_at: i64,
    #[serde(default)]
    pub(super) source_grant: Option<String>,
    #[serde(default)]
    pub(super) takes_holders: Option<Vec<String>>,
    #[serde(default)]
    pub(super) min_trust: Option<String>,
    #[serde(default)]
    pub(super) registered_via: Option<String>,
    #[serde(default = "none_text")]
    pub(super) private_pages: String,
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
    #[serde(default = "none_text")]
    pub(super) private_facts: String,
}

/// The characters of the POSIX class `[[:space:]]`.
fn is_posix_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0B' | '\x0C' | '\r')
}

impl ClientRecord {
    /// Whether the admin spend view lists the client: live, and holding the `agent` scope or bound to tools.
    pub(super) fn is_agent(&self) -> bool {
        self.deleted_at.is_none()
            && (self
                .scope
                .as_deref()
                .is_some_and(|s| s.split(' ').any(|t| t == "agent"))
                || self.bound_tools.is_some())
    }

    /// The scope holds the word `agent` in the sense of `(^|[[:space:]])agent([[:space:]]|$)`.
    fn has_agent_word(&self) -> bool {
        self.scope
            .as_deref()
            .is_some_and(|s| s.split(is_posix_space).any(|t| t == "agent"))
    }

    /// The table's CHECK constraints and its foreign key, in the order Postgres names a violation.
    fn check(&self, read: &dyn KvRead) -> Result<()> {
        let refuse = |constraint: &str| {
            Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "new row for relation \"{TABLE}\" violates check constraint \"{constraint}\""
                ),
            ))
        };
        let one_of = |value: &Option<String>, list: &[&str]| {
            value.as_deref().is_none_or(|v| list.contains(&v))
        };
        if self.has_agent_word() && !self.agent_grant_complete() {
            return refuse("oauth_clients_complete_agent_grant");
        }
        if !one_of(
            &self.min_trust,
            &[
                "user_confirmed",
                "operator_curated",
                "tool_observed",
                "agent_written",
                "unknown",
                "external_untrusted",
            ],
        ) {
            return refuse("oauth_clients_min_trust_check");
        }
        if !["none", "granted_sources"].contains(&self.private_facts.as_str()) {
            return refuse("oauth_clients_private_facts_check");
        }
        if !["none", "granted_sources"].contains(&self.private_pages.as_str()) {
            return refuse("oauth_clients_private_pages_check");
        }
        if !one_of(&self.registered_via, &["dcr"]) {
            return refuse("oauth_clients_registered_via_check");
        }
        if !one_of(&self.source_grant, &["none"]) {
            return refuse("oauth_clients_source_grant_check");
        }
        if let Some(source) = &self.source_id
            && read_source(read, source)?.is_none()
        {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "insert or update on table \"{TABLE}\" violates foreign key constraint \"oauth_clients_source_id_fkey\""
                ),
            ));
        }
        Ok(())
    }

    /// The part of `oauth_clients_complete_agent_grant` that applies to an `agent` scope.
    fn agent_grant_complete(&self) -> bool {
        let tools = self.bound_tools.as_ref().is_some_and(|t| !t.is_empty());
        let source = match (&self.source_id, &self.bound_source_id) {
            (Some(s), Some(b)) => s == b && self.federated_read.contains(s),
            _ => false,
        };
        let delegated = match self.delegated_namespace.as_str() {
            "job" => self.delegated_slug_prefixes.is_none(),
            "prefixes" => self
                .delegated_slug_prefixes
                .as_ref()
                .is_some_and(|p| !p.is_empty()),
            _ => false,
        };
        tools && source && delegated && self.bound_max_concurrent > 0
    }

    /// The row as `SELECT *` returns it on the SQL engines: times as ISO text, the cap as `NUMERIC` text.
    fn to_row(&self) -> Value {
        let t = |m: Option<i64>| m.map(iso);
        let mut row = json!({
            "client_id": self.client_id,
            "client_secret_hash": self.client_secret_hash,
            "client_name": self.client_name,
            "redirect_uris": self.redirect_uris,
            "grant_types": self.grant_types,
            "scope": self.scope,
            "token_endpoint_auth_method": self.token_endpoint_auth_method,
            "client_id_issued_at": self.client_id_issued_at,
            "client_secret_expires_at": self.client_secret_expires_at,
            "token_ttl": self.token_ttl,
            "deleted_at": t(self.deleted_at),
            "source_id": self.source_id,
            "federated_read": self.federated_read,
            "budget_usd_per_day": self.budget.map(budget_text),
            "bound_tools": self.bound_tools,
            "bound_source_id": self.bound_source_id,
            "bound_brain_id": self.bound_brain_id,
            "bound_slug_prefixes": self.bound_slug_prefixes,
            "bound_max_concurrent": self.bound_max_concurrent,
            "surface": self.surface,
            "surface_set_by": self.surface_set_by,
            "allowed_operations": self.allowed_operations,
            "delegated_slug_prefixes": self.delegated_slug_prefixes,
            "delegated_namespace": self.delegated_namespace,
            "grant_profile": self.grant_profile,
            "grant_revision": self.grant_revision,
            "grant_repair_reasons": self.grant_repair_reasons,
            "created_at": iso(self.created_at),
            "source_grant": self.source_grant,
            "takes_holders": self.takes_holders,
            "min_trust": self.min_trust,
            "registered_via": self.registered_via,
            "private_pages": self.private_pages,
            "member_id": self.member_id,
            "may_act_for": self.may_act_for,
            "attest_actor": self.attest_actor,
            "attest_ops": self.attest_ops,
            "attest_sources": self.attest_sources,
            "attest_read": self.attest_read,
            "reads_unscoped": t(self.reads_unscoped),
            "private_facts": self.private_facts,
        });
        // Added past the macro's recursion limit: the v323 read-shared switch, null on a row that never set it.
        row["read_shared_revision"] = json!(self.read_shared_revision);
        row
    }
}

pub(super) fn load_client(read: &dyn KvRead, client_id: &str) -> Result<Option<ClientRecord>> {
    get_json(read, &client_key(client_id))
}

/// The row after the constraints: the one place a client record is written.
pub(super) fn put_client(tx: &mut dyn KvWrite, record: &ClientRecord) -> Result<()> {
    record.check(&*tx)?;
    put_json(tx, &client_key(&record.client_id), record)
}

/// The `sources` delete side of the client's foreign keys: refuses, as `ON DELETE RESTRICT` does, when a client's
/// `source_id` names `source_id`, revoked clients included (the key is physical), with the error Postgres raises;
/// else clears every `bound_source_id` that names it (`ON DELETE SET NULL`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let clients = all_clients(&*tx)?;
    if clients
        .iter()
        .any(|c| c.source_id.as_deref() == Some(source_id))
    {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "update or delete on table \"sources\" violates foreign key constraint \"oauth_clients_source_id_fkey\" on table \"{TABLE}\""
            ),
        ));
    }
    for mut client in clients {
        if client.bound_source_id.as_deref() == Some(source_id) {
            client.bound_source_id = None;
            put_json(tx, &client_key(&client.client_id), &client)?;
        }
    }
    Ok(())
}

/// Every client, by client id.
pub(super) fn all_clients(read: &dyn KvRead) -> Result<Vec<ClientRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix(CLIENT), false, &mut |_, v| {
        match serde_json::from_slice::<ClientRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable client record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

/// `insertOauthClient(row)`: a column left out takes the table's default; `null` is NULL where the column allows it
/// (`grant_types` defaults to `{client_credentials}` only when left out).
#[derive(Debug, Clone, Deserialize)]
pub struct ClientInsert {
    pub client_id: String,
    pub client_name: String,
    #[serde(default)]
    pub client_secret_hash: Option<String>,
    #[serde(default)]
    pub redirect_uris: Option<Vec<String>>,
    #[serde(default = "default_grant_types")]
    pub grant_types: Option<Vec<String>>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    pub client_id_issued_at: Option<i64>,
    #[serde(default)]
    pub client_secret_expires_at: Option<i64>,
    #[serde(default)]
    pub token_ttl: Option<i32>,
    /// ISO text (the TypeScript member turns the `Date`).
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub federated_read: Vec<String>,
    /// Dollars per day.
    #[serde(default)]
    pub budget_usd_per_day: Option<f64>,
    #[serde(default)]
    pub bound_tools: Option<Vec<String>>,
    #[serde(default)]
    pub bound_source_id: Option<String>,
    #[serde(default)]
    pub bound_brain_id: Option<String>,
    #[serde(default)]
    pub bound_slug_prefixes: Option<Vec<String>>,
    #[serde(default = "one")]
    pub bound_max_concurrent: i32,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub surface_set_by: Option<String>,
    #[serde(default)]
    pub allowed_operations: Option<Vec<String>>,
    #[serde(default)]
    pub delegated_slug_prefixes: Option<Vec<String>>,
    #[serde(default = "prefixes")]
    pub delegated_namespace: String,
    #[serde(default)]
    pub grant_profile: Option<String>,
    #[serde(default)]
    pub grant_revision: i32,
    #[serde(default)]
    pub read_shared_revision: Option<i32>,
    #[serde(default)]
    pub grant_repair_reasons: Vec<String>,
    /// ISO text; left out, the store clock.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub source_grant: Option<String>,
    #[serde(default)]
    pub takes_holders: Option<Vec<String>>,
    #[serde(default)]
    pub min_trust: Option<String>,
    #[serde(default)]
    pub registered_via: Option<String>,
    #[serde(default = "none_text")]
    pub private_pages: String,
    #[serde(default)]
    pub member_id: Option<String>,
    #[serde(default)]
    pub may_act_for: Option<Vec<String>>,
    #[serde(default)]
    pub attest_actor: Option<String>,
    #[serde(default)]
    pub attest_ops: Option<Vec<String>>,
    #[serde(default)]
    pub attest_sources: Option<Vec<String>>,
    #[serde(default)]
    pub attest_read: Option<String>,
    #[serde(default)]
    pub reads_unscoped: Option<String>,
    #[serde(default = "none_text")]
    pub private_facts: String,
}

/// The text Postgres prints for a `NUMERIC(10,2)` of `hundredths`.
fn budget_text(hundredths: i64) -> String {
    let sign = if hundredths < 0 { "-" } else { "" };
    let abs = hundredths.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn budget_hundredths(usd: f64) -> Result<i64> {
    numeric_fixed(usd, 2, 8, "budget_usd_per_day")
}

fn iso_micros(text: &Option<String>, what: &str) -> Result<Option<i64>> {
    text.as_deref()
        .map(|t| {
            parse_iso(t)
                .ok_or_else(|| StoreError::invalid(format!("{what}: \"{t}\" is not an ISO time")))
        })
        .transpose()
}

/// `patchOauthClient(clientId, patch, guard)`: the columns to set are the names in `set`; the value of each is the field
/// of that name, `None` clearing it. The five columns are the ones the client-admin writers change in place.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ClientPatch {
    #[serde(default)]
    pub set: Vec<String>,
    #[serde(default)]
    pub client_secret_hash: Option<String>,
    #[serde(default)]
    pub token_ttl: Option<i32>,
    #[serde(default)]
    pub min_trust: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub surface_set_by: Option<String>,
}

/// The rows a patch may touch: `live` skips a deleted client, `unless_surface_set_by` skips a client whose
/// `surface_set_by` is that value (a NULL `surface_set_by` is not equal to it, as `IS DISTINCT FROM`),
/// `client_secret_hash_is` skips a client whose secret hash is not that value (a NULL hash is never equal to it).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ClientPatchGuard {
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub unless_surface_set_by: Option<String>,
    /// Touch the client only while its secret hash is this value (a compare-and-set: the read, the check and the
    /// write are one store write, so of two callers that read the same hash exactly one writes).
    #[serde(default)]
    pub client_secret_hash_is: Option<String>,
}

impl Store {
    /// `patchOauthClient(clientId, patch, guard)`: sets the named columns of one client in one write and returns
    /// `{ row, before }` (the row after, with its constraints checked, and the five patchable columns before), or None
    /// when the client does not exist or the guard excludes it. `constraint_violation` for a value a CHECK refuses.
    pub fn patch_oauth_client(
        &self,
        client_id: &str,
        patch: &ClientPatch,
        guard: &ClientPatchGuard,
    ) -> Result<Option<Value>> {
        self.write(|tx| {
            let Some(mut record) = load_client(tx, client_id)? else {
                return Ok(None);
            };
            if guard.live && record.deleted_at.is_some() {
                return Ok(None);
            }
            if let Some(held) = &guard.unless_surface_set_by
                && record.surface_set_by.as_deref() == Some(held.as_str())
            {
                return Ok(None);
            }
            if let Some(expected) = &guard.client_secret_hash_is
                && record.client_secret_hash.as_deref() != Some(expected.as_str())
            {
                return Ok(None);
            }
            let before = serde_json::json!({
                "client_secret_hash": record.client_secret_hash,
                "token_ttl": record.token_ttl,
                "min_trust": record.min_trust,
                "surface": record.surface,
                "surface_set_by": record.surface_set_by,
            });
            for column in &patch.set {
                match column.as_str() {
                    "client_secret_hash" => {
                        record.client_secret_hash = patch.client_secret_hash.clone()
                    }
                    "token_ttl" => record.token_ttl = patch.token_ttl,
                    "min_trust" => record.min_trust = patch.min_trust.clone(),
                    "surface" => record.surface = patch.surface.clone(),
                    "surface_set_by" => record.surface_set_by = patch.surface_set_by.clone(),
                    other => {
                        return Err(StoreError::invalid(format!(
                            "patchOauthClient: \"{other}\" is not a patchable column"
                        )));
                    }
                }
            }
            put_client(tx, &record)?;
            Ok(Some(
                serde_json::json!({ "row": record.to_row(), "before": before }),
            ))
        })
    }

    /// `insertOauthClient(row)`. `constraint_violation` for a client id already taken, a budget that overflows
    /// `NUMERIC(10,2)`, a row that breaks a CHECK of the table (the agent-grant check first among them) and a
    /// `source_id` no source has; `invalid_argument` for a time that is not ISO text.
    pub fn insert_oauth_client(&self, row: &ClientInsert) -> Result<()> {
        let budget = row.budget_usd_per_day.map(budget_hundredths).transpose()?;
        let deleted_at = iso_micros(&row.deleted_at, "deleted_at")?;
        let reads_unscoped = iso_micros(&row.reads_unscoped, "reads_unscoped")?;
        let created_at = iso_micros(&row.created_at, "created_at")?;
        self.write(|tx| {
            if load_client(tx, &row.client_id)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"oauth_clients_pkey\"",
                ));
            }
            let record = ClientRecord {
                client_id: row.client_id.clone(),
                client_secret_hash: row.client_secret_hash.clone(),
                client_name: row.client_name.clone(),
                redirect_uris: row.redirect_uris.clone(),
                grant_types: row.grant_types.clone(),
                scope: row.scope.clone(),
                token_endpoint_auth_method: row.token_endpoint_auth_method.clone(),
                client_id_issued_at: row.client_id_issued_at,
                client_secret_expires_at: row.client_secret_expires_at,
                token_ttl: row.token_ttl,
                deleted_at,
                source_id: row.source_id.clone(),
                federated_read: row.federated_read.clone(),
                budget,
                bound_tools: row.bound_tools.clone(),
                bound_source_id: row.bound_source_id.clone(),
                bound_brain_id: row.bound_brain_id.clone(),
                bound_slug_prefixes: row.bound_slug_prefixes.clone(),
                bound_max_concurrent: row.bound_max_concurrent,
                surface: row.surface.clone(),
                surface_set_by: row.surface_set_by.clone(),
                allowed_operations: row.allowed_operations.clone(),
                delegated_slug_prefixes: row.delegated_slug_prefixes.clone(),
                delegated_namespace: row.delegated_namespace.clone(),
                grant_profile: row.grant_profile.clone(),
                grant_revision: row.grant_revision,
                read_shared_revision: row.read_shared_revision,
                grant_repair_reasons: row.grant_repair_reasons.clone(),
                created_at: created_at.unwrap_or_else(|| self.env.now_micros()),
                source_grant: row.source_grant.clone(),
                takes_holders: row.takes_holders.clone(),
                min_trust: row.min_trust.clone(),
                registered_via: row.registered_via.clone(),
                private_pages: row.private_pages.clone(),
                member_id: row.member_id.clone(),
                may_act_for: row.may_act_for.clone(),
                attest_actor: row.attest_actor.clone(),
                attest_ops: row.attest_ops.clone(),
                attest_sources: row.attest_sources.clone(),
                attest_read: row.attest_read.clone(),
                reads_unscoped,
                private_facts: row.private_facts.clone(),
            };
            put_client(tx, &record)
        })
    }

    /// `updateOauthClientBudget(clientId, usd)`: sets (or clears, with None) the daily cap; whether the client exists.
    pub fn update_oauth_client_budget(&self, client_id: &str, usd: Option<f64>) -> Result<bool> {
        let budget = usd.map(budget_hundredths).transpose()?;
        self.write(|tx| {
            let Some(mut record) = load_client(tx, client_id)? else {
                return Ok(false);
            };
            record.budget = budget;
            put_client(tx, &record)?;
            Ok(true)
        })
    }

    /// `readClientBudgetUsd(clientId)`: the cap as Postgres prints it (`"5.00"`), None for no cap or no such client.
    pub fn read_client_budget_usd(&self, client_id: &str) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(load_client(&*read, client_id)?
            .and_then(|c| c.budget)
            .map(budget_text))
    }

    /// `readOauthClient(clientId)`: the whole row as `SELECT * FROM oauth_clients WHERE client_id = $1` returns it
    /// (times as ISO text), or None.
    pub fn read_oauth_client(&self, client_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(load_client(&*read, client_id)?.map(|c| c.to_row()))
    }

    /// `[{ id, name }]` (`client_id`, `client_name`) of the clients whose id is one of `ids`, by id; an id no client has is
    /// left out. The names `get_write_attribution` shows for an OAuth client.
    pub fn read_oauth_client_names(&self, ids: &[String]) -> Result<Value> {
        let read = self.read()?;
        let mut wanted: Vec<&String> = ids.iter().collect();
        wanted.sort();
        wanted.dedup();
        let mut rows = Vec::new();
        for id in wanted {
            if let Some(c) = load_client(&*read, id)? {
                rows.push(json!({ "id": c.client_id, "name": c.client_name }));
            }
        }
        Ok(Value::Array(rows))
    }

    /// `listOauthClients()`: every client's whole row (as `read_oauth_client` returns it), by name then id in byte
    /// order, as `ORDER BY client_name COLLATE "C", client_id COLLATE "C"` sorts.
    pub fn list_oauth_clients(&self) -> Result<Value> {
        let read = self.read()?;
        let mut clients = all_clients(&*read)?;
        clients.sort_by(|a, b| {
            (a.client_name.as_bytes(), a.client_id.as_bytes())
                .cmp(&(b.client_name.as_bytes(), b.client_id.as_bytes()))
        });
        Ok(Value::Array(clients.iter().map(|c| c.to_row()).collect()))
    }

    /// `listSourceOAuthClients(sourceId)`: every client that names the source, revoked ones
    /// included (`deleted` is whether `deleted_at` is set), by client id in byte order. These are
    /// the clients whose `ON DELETE RESTRICT` blocks a source delete on the SQL engines.
    pub fn list_source_oauth_clients(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut clients: Vec<ClientRecord> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.source_id.as_deref() == Some(source_id))
            .collect();
        clients.sort_by(|a, b| a.client_id.as_bytes().cmp(b.client_id.as_bytes()));
        Ok(Value::Array(
            clients
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "client_id": c.client_id,
                        "client_name": c.client_name,
                        "deleted": c.deleted_at.is_some(),
                    })
                })
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_word_split_uses_pglite_space_class() {
        // `(^|[[:space:]])agent([[:space:]]|$)` in the SQL (src/core/grants/schema.ts).
        let mismatches = crate::fingerprint_fixture::space_mismatches(is_posix_space);
        assert_eq!(mismatches, Vec::<String>::new());
    }

    #[test]
    fn budget_text_prints_two_decimals_with_the_sign() {
        assert_eq!(budget_text(500), "5.00");
        assert_eq!(budget_text(29), "0.29");
        assert_eq!(budget_text(-50), "-0.50");
        assert_eq!(budget_text(0), "0.00");
        assert_eq!(budget_text(1250), "12.50");
    }

    #[test]
    fn budget_rounds_half_away_from_zero_to_cents() {
        assert_eq!(budget_hundredths(0.005).unwrap(), 1);
        assert_eq!(budget_hundredths(0.004_99).unwrap(), 0);
        assert_eq!(budget_hundredths(-0.005).unwrap(), -1);
        assert_eq!(budget_hundredths(99_999_999.99).unwrap(), 9_999_999_999);
        assert!(budget_hundredths(100_000_000.0).is_err());
    }
}
