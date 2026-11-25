//! Who a call runs as on a multi-user server (lane L4, interface I-6, design note M2: "only the
//! authentication boundary builds a scope").
//!
//! A [`Scope`] has private fields and two constructors. [`Scope::trusted_local`] is today's
//! behavior: the embedded engine's own caller, trusted as the CLI is. [`Scope::from_principal`] is
//! the server path: it takes an [`AuthenticatedPrincipal`], which only [`Store::authenticate_bearer`]
//! makes, from a bearer token the store verified against its own `access_tokens` records. Nothing
//! the client sent besides the token reaches a scope.
//!
//! Fail closed. Until the store's own privacy derivation (`access_derive.rs`) is proven equal to
//! the TypeScript policy on every case and that is accepted as a decision, a principal scope is
//! admitted only for a live token bound to the brain's owner member (`access.owner_member`) while
//! that member is enabled. An unknown or revoked token, another member's token, an unbound token
//! and a brain with no owner member all refuse with the same `permission_denied`, so the refusal
//! does not tell a caller which of these it hit ("not found" equals "not yours").
//!
//! A scope is a snapshot. [`Scope::revalidate`] re-reads, before every call it admits, that the
//! token is still live with the same grant revision and member, that the member is still enabled
//! and that the owner member is unchanged; any change refuses the call, so a revoke or a narrowing
//! committed between two calls on one connection takes effect on the next call.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Result, Store, StoreError};

/// The config row naming the brain owner's member (`access.owner_member`).
pub const OWNER_MEMBER_KEY: &str = "access.owner_member";

/// A bearer token the store verified: its record id, grant revision, bound member and the whole
/// token row (no hash), from which the server builds the call's grant. Only
/// [`Store::authenticate_bearer`] constructs one.
#[derive(Debug, Clone)]
pub struct AuthenticatedPrincipal {
    token_id: String,
    grant_revision: i64,
    member_id: Option<String>,
    row: Value,
}

impl AuthenticatedPrincipal {
    /// The token record id.
    pub fn token_id(&self) -> &str {
        &self.token_id
    }

    /// The member the token is bound to, if any.
    pub fn member_id(&self) -> Option<&str> {
        self.member_id.as_deref()
    }

    /// The verified token row (no hash): what the server's grant model reads.
    pub fn row(&self) -> &Value {
        &self.row
    }
}

#[derive(Debug, Clone)]
enum ScopeKind {
    /// The embedded engine's own caller (today's behavior), with the access record it runs under.
    TrustedLocal(Value),
    /// A verified principal admitted by the owner gate.
    Principal {
        principal: AuthenticatedPrincipal,
        owner_member: String,
    },
}

/// Who a call runs as. Private fields: build one with [`Scope::trusted_local`] or
/// [`Scope::from_principal`].
#[derive(Debug, Clone)]
pub struct Scope {
    kind: ScopeKind,
}

/// The one refusal every gate failure gives.
fn refused() -> StoreError {
    StoreError::new(
        "permission_denied",
        "this credential cannot open a multi-user session on this brain (only the brain owner's own key is admitted for now)",
    )
}

/// `hashToken` (src/core/utils.ts): SHA-256, lowercase hex.
fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

impl Store {
    /// Verifies a bearer token against the store's own active `access_tokens` records. An empty,
    /// unknown or revoked token refuses `permission_denied`.
    pub fn authenticate_bearer(&self, token: &str) -> Result<AuthenticatedPrincipal> {
        if token.is_empty() {
            return Err(refused());
        }
        let row = self
            .read_active_access_token_by_hash(&token_hash(token))?
            .ok_or_else(refused)?;
        let token_id = text(&row, "id").ok_or_else(refused)?;
        let grant_revision = row
            .get("grant_revision")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let member_id = text(&row, "member_id");
        Ok(AuthenticatedPrincipal {
            token_id,
            grant_revision,
            member_id,
            row,
        })
    }

    /// The owner member when it names an enabled member.
    fn live_owner_member(&self) -> Result<Option<String>> {
        let Some(owner) = self
            .get_config(OWNER_MEMBER_KEY)?
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        else {
            return Ok(None);
        };
        Ok(self
            .list_active_access_members()?
            .contains(&owner)
            .then_some(owner))
    }
}

impl Scope {
    /// Today's behavior, embedded only: the caller's own access record, trusted.
    pub fn trusted_local(access_record: &Value) -> Scope {
        Scope {
            kind: ScopeKind::TrustedLocal(access_record.clone()),
        }
    }

    /// The server path: a scope for a verified principal, through the owner gate (see the module
    /// comment). Refuses `permission_denied` for every principal the gate does not admit.
    pub fn from_principal(store: &Store, principal: &AuthenticatedPrincipal) -> Result<Scope> {
        let owner = store.live_owner_member()?.ok_or_else(refused)?;
        if principal.member_id.as_deref() != Some(owner.as_str()) {
            return Err(refused());
        }
        Ok(Scope {
            kind: ScopeKind::Principal {
                principal: principal.clone(),
                owner_member: owner,
            },
        })
    }

    /// True for a principal scope (the server path), false for the embedded caller.
    pub fn is_principal(&self) -> bool {
        matches!(self.kind, ScopeKind::Principal { .. })
    }

    /// The principal of a principal scope.
    pub fn principal(&self) -> Option<&AuthenticatedPrincipal> {
        match &self.kind {
            ScopeKind::Principal { principal, .. } => Some(principal),
            ScopeKind::TrustedLocal(_) => None,
        }
    }

    /// The access record of the embedded caller.
    pub fn local_access_record(&self) -> Option<&Value> {
        match &self.kind {
            ScopeKind::TrustedLocal(v) => Some(v),
            ScopeKind::Principal { .. } => None,
        }
    }

    /// Re-reads, from the store's current records, everything the scope was admitted on; refuses
    /// `permission_denied` when any of it changed. The embedded caller always passes.
    pub fn revalidate(&self, store: &Store) -> Result<()> {
        let ScopeKind::Principal {
            principal,
            owner_member,
        } = &self.kind
        else {
            return Ok(());
        };
        let row = store
            .read_access_token(&principal.token_id)?
            .ok_or_else(refused)?;
        let revoked = row.get("revoked_at").is_some_and(|v| !v.is_null());
        let revision = row
            .get("grant_revision")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if revoked
            || revision != principal.grant_revision
            || text(&row, "member_id") != principal.member_id
        {
            return Err(refused());
        }
        if store.live_owner_member()?.as_deref() != Some(owner_member.as_str()) {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
