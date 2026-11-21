//! Jobs: the grant writes over `oauth_clients` and the grant audit (`oauth_grant_audit`), as the members of
//! `src/core/engine-sql/client-grants.ts` run them (rust/docs/store/oauth-clients.md).
//!
//! Members: persistOauthClientGrant, insertOauthClientGrant (the client and its register audit row), listOauthGrantAudit,
//! readLatestCatalogProvenanceAudit, readLiveOauthClients, readSourceGrantState and replaceSourceConfig. A client's binding
//! columns are written by `credential_binding.rs`.
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2E (this file only):
//! - `m 0x2E id -> AuditRecord`: one audit row (sequence `oauth_grant_audit`). The table is append-only and is read
//!   whole (a client's rows are a scan), as the SQL engines read it by `client_id`.
//!
//! One grant write is one store write: the client row with its constraints checked, the rewrite of the open subagent
//! jobs the client owns that carry no delegation grant yet, the audit row, and the private-pages and private-facts
//! columns commit together or not at all (the SQL engines run the first three as one statement and the other two as
//! statements after it, in one transaction).

use super::oauth_clients::{ClientRecord, all_clients, budget_hundredths, load_client, put_client};
use super::*;
use crate::dream::jsonb;
use crate::env::Env;
use crate::sources::{read_source, source_key};

const AUDIT: u8 = 0x2E;

fn audit_key(id: i64) -> Vec<u8> {
    let mut k = prefix(AUDIT);
    k.extend_from_slice(&signed_key(id));
    k
}

/// One `oauth_grant_audit` row. `created_at` is microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuditRecord {
    id: i64,
    client_id: String,
    actor: String,
    action: String,
    revision: i32,
    before_grant: Option<Value>,
    after_grant: Value,
    created_at: i64,
}

impl AuditRecord {
    /// The row as `SELECT *` returns it: the documents in `jsonb` key order, the time as ISO text.
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "client_id": self.client_id,
            "actor": self.actor,
            "action": self.action,
            "revision": self.revision,
            "before_grant": self.before_grant.as_ref().map(jsonb),
            "after_grant": jsonb(&self.after_grant),
            "created_at": iso(self.created_at),
        })
    }
}

/// The audit row a grant write appends: who, which action, and the grant documents as JSON text (the SQL engines cast
/// them `::text::jsonb`).
#[derive(Debug, Clone, Deserialize)]
pub struct GrantAudit {
    pub actor: String,
    pub action: String,
    #[serde(default)]
    pub before_grant: Option<String>,
    pub after_grant: String,
}

/// One grant audit row a client lifecycle action appends (`insertOauthGrantAudit`): the documents are JSON text.
#[derive(Debug, Clone, Deserialize)]
pub struct GrantAuditInsert {
    pub client_id: String,
    pub actor: String,
    pub action: String,
    pub revision: i32,
    #[serde(default)]
    pub before_grant: Option<String>,
    pub after_grant: String,
}

/// What `insertOauthClientGrant` writes beside the client: the register audit row.
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterAudit {
    pub actor: String,
    pub after_grant: String,
}

/// The delegation grant an open subagent job that carries none yet receives (`before`'s side of the grant).
#[derive(Debug, Clone, Deserialize)]
pub struct JobGrantSource {
    #[serde(default)]
    pub brain_id: Option<String>,
    #[serde(default)]
    pub federated_read: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub allowed_operations: Option<Vec<String>>,
    pub max_concurrent: i32,
    #[serde(default)]
    pub budget_usd_per_day: Option<String>,
}

/// `persistOauthClientGrant(input)`: the grant columns to write (the values of `after`), the revision the row must
/// still hold, what the legacy job rewrite reads of `before`, the audit row, and the private grants when they change.
#[derive(Debug, Clone, Deserialize)]
pub struct GrantPersist {
    pub client_id: String,
    pub expected_revision: i32,
    pub scope: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub federated_read: Vec<String>,
    #[serde(default)]
    pub source_grant: Option<String>,
    #[serde(default)]
    pub takes_holders: Option<Vec<String>>,
    #[serde(default)]
    pub bound_slug_prefixes: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_operations: Option<Vec<String>>,
    #[serde(default)]
    pub bound_tools: Option<Vec<String>>,
    #[serde(default)]
    pub bound_source_id: Option<String>,
    #[serde(default)]
    pub bound_brain_id: Option<String>,
    #[serde(default)]
    pub delegated_slug_prefixes: Option<Vec<String>>,
    pub delegated_namespace: String,
    pub bound_max_concurrent: i32,
    /// Dollars per day.
    #[serde(default)]
    pub budget_usd_per_day: Option<f64>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub surface_set_by: Option<String>,
    #[serde(default)]
    pub token_ttl: Option<i32>,
    #[serde(default)]
    pub grant_profile: Option<String>,
    pub grant_revision: i32,
    #[serde(default)]
    pub grant_repair_reasons: Vec<String>,
    pub legacy_jobs: JobGrantSource,
    pub audit: GrantAudit,
    #[serde(default)]
    pub private_pages: Option<String>,
    #[serde(default)]
    pub private_facts: Option<String>,
}

fn parse_document(text: &str, what: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|e| StoreError::invalid(format!("{what}: not JSON: {e}")))
}

/// `->>` of a JSON value: a string as it is, a number or boolean as its text, anything else NULL here.
fn text_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(v @ (Value::Number(_) | Value::Bool(_))) => Some(v.to_string()),
        _ => None,
    }
}

/// The statuses an open subagent job has: the legacy rewrite touches no finished job.
const OPEN_STATUSES: [&str; 5] = ["waiting", "active", "waiting-children", "delayed", "paused"];

impl JobGrantSource {
    /// The `__delegation_grant` of one job: what the grant of the client it was submitted under allowed, read from the
    /// job's own `data` (the `jsonb_build_object` of the SQL engines' legacy-job rewrite).
    fn delegation_grant(&self, client_id: &str, data: &Map<String, Value>) -> Value {
        let source_id = text_of(data.get("source_id"));
        let prefixes = data.get("allowed_slug_prefixes");
        let has_prefixes = match prefixes {
            None | Some(Value::Null) => false,
            Some(Value::Array(a)) => !a.is_empty(),
            Some(_) => true,
        };
        let read_sources = match &source_id {
            Some(s) if self.federated_read.contains(s) => json!([s]),
            _ => json!([]),
        };
        jsonb(&json!({
            "clientId": client_id,
            "sourceId": source_id,
            "brainId": self.brain_id,
            "tools": data.get("allowed_tools").cloned().unwrap_or(Value::Null),
            "slugPrefixes": if has_prefixes {
                prefixes.cloned().unwrap_or(Value::Null)
            } else {
                json!(["wiki/agents/{job_id}/*"])
            },
            "namespace": if has_prefixes { "prefixes" } else { "job" },
            "readSources": read_sources,
            "scopes": self.scopes,
            "allowedOperations": self.allowed_operations,
            "maxConcurrent": self.max_concurrent,
            "budgetUsdPerDay": self.budget_usd_per_day,
        }))
    }
}

/// Gives every open subagent job `client_id` owns that carries no delegation grant the grant its owner held before.
fn rewrite_legacy_jobs(
    tx: &mut dyn KvWrite,
    client_id: &str,
    source: &JobGrantSource,
) -> Result<()> {
    for old in all_rows(&*tx)? {
        let Some(data) = old.data.as_object() else {
            continue;
        };
        if old.name != "subagent"
            || !OPEN_STATUSES.contains(&old.status.as_str())
            || text_of(data.get("__owner_client_id")).as_deref() != Some(client_id)
            || data.contains_key("__delegation_grant")
        {
            continue;
        }
        let mut data = data.clone();
        data.insert(
            "__delegation_grant".to_string(),
            source.delegation_grant(client_id, &data),
        );
        let mut new = old.clone();
        new.data = jsonb(&Value::Object(data));
        save(tx, Some(&old), &new)?;
    }
    Ok(())
}

fn append_audit(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    client_id: &str,
    revision: i32,
    (action, actor): (&str, &str),
    before_grant: Option<Value>,
    after_grant: Value,
) -> Result<()> {
    let record = AuditRecord {
        id: next_seq(tx, "oauth_grant_audit")?,
        client_id: client_id.to_string(),
        actor: actor.to_string(),
        action: action.to_string(),
        revision,
        before_grant,
        after_grant,
        created_at: env.now_micros(),
    };
    put_json(tx, &audit_key(record.id), &record)
}

fn all_audit(read: &dyn KvRead) -> Result<Vec<AuditRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &prefix(AUDIT),
        false,
        &mut |_, v| match serde_json::from_slice::<AuditRecord>(v) {
            Ok(r) => {
                rows.push(r);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    Ok(rows)
}

impl Store {
    /// `persistOauthClientGrant(input)`: writes the grant onto the client while it still holds `expected_revision`,
    /// rewrites the legacy open jobs, appends the audit row and sets the private grants that changed; false (and nothing
    /// written) when no client has the id at that revision. `constraint_violation` for a value a CHECK refuses.
    pub fn persist_oauth_client_grant(&self, input: &GrantPersist) -> Result<bool> {
        let budget = input
            .budget_usd_per_day
            .map(budget_hundredths)
            .transpose()?;
        let before_grant = input
            .audit
            .before_grant
            .as_deref()
            .map(|t| parse_document(t, "audit before_grant"))
            .transpose()?;
        let after_grant = parse_document(&input.audit.after_grant, "audit after_grant")?;
        self.write(|tx| {
            let Some(mut record) = load_client(tx, &input.client_id)? else {
                return Ok(false);
            };
            if record.grant_revision != input.expected_revision {
                return Ok(false);
            }
            set_grant_columns(&mut record, input, budget);
            put_client(tx, &record)?;
            rewrite_legacy_jobs(tx, &input.client_id, &input.legacy_jobs)?;
            append_audit(
                tx,
                &*self.env,
                &input.client_id,
                input.grant_revision,
                (&input.audit.action, &input.audit.actor),
                before_grant.clone(),
                after_grant.clone(),
            )?;
            if input.private_pages.is_some() || input.private_facts.is_some() {
                if let Some(pages) = &input.private_pages {
                    record.private_pages = pages.clone();
                }
                if let Some(facts) = &input.private_facts {
                    record.private_facts = facts.clone();
                }
                put_client(tx, &record)?;
            }
            Ok(true)
        })
    }

    /// `insertOauthClientGrant(row, audit)`: the client as `insertOauthClient` writes it, and the register audit row
    /// (revision the row's, no before document), in one write.
    pub fn insert_oauth_client_grant(
        &self,
        row: &ClientInsert,
        audit: &RegisterAudit,
    ) -> Result<()> {
        let after_grant = parse_document(&audit.after_grant, "audit after_grant")?;
        self.write(|tx| {
            self.insert_client_in(tx, row)?;
            append_audit(
                tx,
                &*self.env,
                &row.client_id,
                row.grant_revision,
                ("register", &audit.actor),
                None,
                after_grant.clone(),
            )
        })
    }

    /// `insertOauthGrantAudit(row)`: appends one audit row, whether or not the client exists (a `delete` writes its
    /// audit after the client is gone). `invalid_argument` for a document that is not JSON.
    pub fn insert_oauth_grant_audit(&self, row: &GrantAuditInsert) -> Result<()> {
        let before_grant = row
            .before_grant
            .as_deref()
            .map(|t| parse_document(t, "audit before_grant"))
            .transpose()?;
        let after_grant = parse_document(&row.after_grant, "audit after_grant")?;
        self.write(|tx| {
            append_audit(
                tx,
                &*self.env,
                &row.client_id,
                row.revision,
                (&row.action, &row.actor),
                before_grant.clone(),
                after_grant.clone(),
            )
        })
    }

    /// `listOauthGrantAudit(clientId)`: the client's audit rows, oldest first (by id).
    pub fn list_oauth_grant_audit(&self, client_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<AuditRecord> = all_audit(&*read)?
            .into_iter()
            .filter(|r| r.client_id == client_id)
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(Value::Array(rows.iter().map(AuditRecord::to_row).collect()))
    }

    /// `readLatestCatalogProvenanceAudit(clientId)`: the `after_grant` of the client's newest audit row whose document
    /// has a `catalogProvenance` key (a JSON null counts, as `->` returns a jsonb null that is not SQL NULL), or None.
    pub fn read_latest_catalog_provenance_audit(&self, client_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(all_audit(&*read)?
            .into_iter()
            .filter(|r| {
                r.client_id == client_id
                    && r.after_grant
                        .as_object()
                        .is_some_and(|d| d.contains_key("catalogProvenance"))
            })
            .max_by_key(|r| r.id)
            .map(|r| jsonb(&r.after_grant)))
    }

    /// `readLiveOauthClients()`: every client not deleted, whole rows, by client id.
    pub fn read_live_oauth_clients(&self) -> Result<Value> {
        let read = self.read()?;
        let mut clients = all_clients(&*read)?;
        clients.retain(|c| c.deleted_at.is_none());
        clients.sort_by(|a, b| a.client_id.as_bytes().cmp(b.client_id.as_bytes()));
        Ok(Value::Array(
            clients.iter().map(ClientRecord::to_row).collect(),
        ))
    }

    /// `readSourceGrantState(id)`: `{ archived, config }` of the source, or None.
    pub fn read_source_grant_state(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_source(&*read, id)?
            .map(|s| json!({ "archived": s.archived, "config": jsonb(&Value::Object(s.config)) })))
    }

    /// `replaceSourceConfig(id, config)`: sets the source's whole `config`; whether the source exists.
    pub fn replace_source_config(&self, id: &str, config: &Map<String, Value>) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            record.config = config.clone();
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }
}

/// Every column `persist_oauth_client_grant` sets, as the statement's `UPDATE ... SET` lists them.
fn set_grant_columns(record: &mut ClientRecord, input: &GrantPersist, budget: Option<i64>) {
    record.scope = Some(input.scope.clone());
    record.source_id = input.source_id.clone();
    record.federated_read = input.federated_read.clone();
    record.source_grant = input.source_grant.clone();
    record.takes_holders = input.takes_holders.clone();
    record.bound_slug_prefixes = input.bound_slug_prefixes.clone();
    record.allowed_operations = input.allowed_operations.clone();
    record.bound_tools = input.bound_tools.clone();
    record.bound_source_id = input.bound_source_id.clone();
    record.bound_brain_id = input.bound_brain_id.clone();
    record.delegated_slug_prefixes = input.delegated_slug_prefixes.clone();
    record.delegated_namespace = input.delegated_namespace.clone();
    record.bound_max_concurrent = input.bound_max_concurrent;
    record.budget = budget;
    record.surface = input.surface.clone();
    record.surface_set_by = input.surface_set_by.clone();
    record.token_ttl = input.token_ttl;
    record.grant_profile = input.grant_profile.clone();
    record.grant_revision = input.grant_revision;
    record.grant_repair_reasons = input.grant_repair_reasons.clone();
}
