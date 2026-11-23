//! Jobs: the spend columns of `oauth_clients` (the client a hold is placed for, its daily cap, and whether it is an
//! agent client), as the members of `src/core/engine-sql/spend-log.ts` run them (rust/docs/store/spend-log.md).
//!
//! Members: insertOauthClient, updateOauthClientBudget, readClientBudgetUsd, and the client reads the admission and
//! the agent spend view make (`budget_cents`, `agent_clients`).
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tag 0x2A (this file only):
//! - `m 0x2A client_id -> ClientRecord`: one client.
//!
//! The record keeps only the columns the spend surfaces read: `client_id`, `client_name`, `scope`, `bound_tools`,
//! `budget_usd_per_day` (in hundredths of a dollar, which is cents) and `deleted_at`. Every other column of the
//! Postgres table (secrets, redirect URIs, grants, source bindings) is not in the store. The grants family's
//! completeness check on an `agent` scope is not enforced here either: the store takes the row as given.

use super::spend::numeric_fixed;
use super::*;
use crate::env::parse_iso;

const CLIENT: u8 = 0x2A;

fn client_key(client_id: &str) -> Vec<u8> {
    let mut k = prefix(CLIENT);
    k.extend_from_slice(client_id.as_bytes());
    k
}

/// One `oauth_clients` row, with the spend columns only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ClientRecord {
    pub(super) client_id: String,
    pub(super) client_name: String,
    pub(super) scope: Option<String>,
    pub(super) bound_tools: Option<Vec<String>>,
    /// `budget_usd_per_day` in hundredths of a dollar (`NUMERIC(10,2)`).
    pub(super) budget: Option<i64>,
    pub(super) deleted_at: Option<i64>,
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
}

pub(super) fn load_client(read: &dyn KvRead, client_id: &str) -> Result<Option<ClientRecord>> {
    get_json(read, &client_key(client_id))
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

/// The shadow seed (`seed.rs`): stores a client's spend columns copied from another engine (`budget_usd_per_day` in
/// dollars, as the column holds it). `false` when the client id is already stored.
pub(crate) fn seed_client(
    tx: &mut dyn KvWrite,
    client: (&str, &str, Option<&str>),
    bound_tools: Option<Vec<String>>,
    budget_usd_per_day: Option<f64>,
    deleted_at: Option<i64>,
) -> Result<bool> {
    let (client_id, client_name, scope) = client;
    if client_id.contains('\0')
        || client_name.contains('\0')
        || scope.is_some_and(|s| s.contains('\0'))
    {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            "seed oauth_clients: invalid byte sequence for encoding \"UTF8\": 0x00",
        ));
    }
    if load_client(&*tx, client_id)?.is_some() {
        return Ok(false);
    }
    let record = ClientRecord {
        client_id: client_id.to_string(),
        client_name: client_name.to_string(),
        scope: scope.map(str::to_string),
        bound_tools,
        budget: budget_usd_per_day.map(budget_hundredths).transpose()?,
        deleted_at,
    };
    put_json(tx, &client_key(client_id), &record)?;
    Ok(true)
}

/// `insertOauthClient(row)`.
#[derive(Debug, Clone, Deserialize)]
pub struct ClientInsert {
    pub client_id: String,
    pub client_name: String,
    #[serde(default)]
    pub scope: Option<String>,
    /// Dollars per day.
    #[serde(default)]
    pub budget_usd_per_day: Option<f64>,
    #[serde(default)]
    pub bound_tools: Option<Vec<String>>,
    /// ISO text (the TypeScript member turns the `Date`).
    #[serde(default)]
    pub deleted_at: Option<String>,
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

impl Store {
    /// `insertOauthClient(row)`. `constraint_violation` for a client id already taken and for a budget that overflows
    /// `NUMERIC(10,2)`; `invalid_argument` for a time that is not ISO text.
    pub fn insert_oauth_client(&self, row: &ClientInsert) -> Result<()> {
        let budget = row.budget_usd_per_day.map(budget_hundredths).transpose()?;
        let deleted_at = row
            .deleted_at
            .as_deref()
            .map(|t| {
                parse_iso(t).ok_or_else(|| {
                    StoreError::invalid(format!("deleted_at: \"{t}\" is not an ISO time"))
                })
            })
            .transpose()?;
        self.write(|tx| {
            if load_client(tx, &row.client_id)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"oauth_clients_pkey\"",
                ));
            }
            let record = ClientRecord {
                client_id: row.client_id.clone(),
                client_name: row.client_name.clone(),
                scope: row.scope.clone(),
                bound_tools: row.bound_tools.clone(),
                budget,
                deleted_at,
            };
            put_json(tx, &client_key(&row.client_id), &record)
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
            put_json(tx, &client_key(client_id), &record)?;
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
}

/// The shadow follow (`seed/follow.rs`): removes the client `client_id`. `false` when there is none.
pub(crate) fn remove_client(tx: &mut dyn KvWrite, client_id: &str) -> Result<bool> {
    if client_id.contains('\0') || load_client(&*tx, client_id)?.is_none() {
        return Ok(false);
    }
    tx.delete(&client_key(client_id))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

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
