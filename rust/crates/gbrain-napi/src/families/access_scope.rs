//! Multi-user sessions (lane L4, interface I-6): `mintScope`, `checkScope`, `scopeGrant` and
//! `releaseScope`.
//!
//! The server's hello handler (lane L3) hands the client's bearer token to `mintScope`; the store
//! verifies it (`Store::authenticate_bearer`) and admits it through the owner gate
//! (`Scope::from_principal`), and the binding keeps the `Scope` here, behind a handle (a `u64`
//! the store mints). TypeScript holds the handle, never a scope's parts: there is no call that
//! builds a scope from fields. Before each member call of that session the server calls
//! `checkScope(handle)`, which revalidates the scope against the store's current records, so a
//! revoke or a narrowing committed between two calls takes effect on the next one. A handle is
//! tied to the store that minted it: after `close` (or a reopen) every older handle refuses. The
//! table holds at most [`MAX_SCOPES`] sessions; a mint past that refuses.
//!
//! Every refusal is `permission_denied` with the same message, whatever the cause.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use gbrain_store::scope::Scope;
use gbrain_store::{Store, StoreError};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::Brain;

/// The most sessions one handle keeps open.
pub(crate) const MAX_SCOPES: usize = 4096;

/// One open session: the scope, the store it was minted on and the close count at the time.
struct Entry {
    store: usize,
    closes: u64,
    scope: Scope,
}

/// The sessions of one `Brain` handle.
#[derive(Default)]
pub(crate) struct ScopeTable {
    next: u64,
    entries: HashMap<u64, Entry>,
}

fn refused() -> StoreError {
    StoreError::new(
        "permission_denied",
        "this credential cannot open a multi-user session on this brain (only the brain owner's own key is admitted for now)",
    )
}

fn store_id(store: &Arc<Store>) -> usize {
    Arc::as_ptr(store) as usize
}

impl ScopeTable {
    /// Drops every entry minted on another store or before the last close.
    fn prune(&mut self, store: usize, closes: u64) {
        self.entries
            .retain(|_, e| e.store == store && e.closes == closes);
    }

    fn insert(&mut self, store: usize, closes: u64, scope: Scope) -> Result<u64, StoreError> {
        self.prune(store, closes);
        if self.entries.len() >= MAX_SCOPES {
            return Err(refused());
        }
        self.next += 1;
        let handle = self.next;
        self.entries.insert(
            handle,
            Entry {
                store,
                closes,
                scope,
            },
        );
        Ok(handle)
    }

    /// The scope of `handle` when it was minted on `store` since the last close.
    fn get(&mut self, handle: u64, store: usize, closes: u64) -> Option<Scope> {
        let live = self
            .entries
            .get(&handle)
            .is_some_and(|e| e.store == store && e.closes == closes);
        if !live {
            self.entries.remove(&handle);
            return None;
        }
        self.entries.get(&handle).map(|e| e.scope.clone())
    }
}

/// Parses a handle the way TypeScript sends it (a decimal string, so no precision is lost).
fn parse_handle(handle: &str) -> Result<u64, StoreError> {
    handle.parse::<u64>().map_err(|_| refused())
}

#[napi]
impl Brain {
    /// `mintScope(bearer)`: verifies the token and admits it through the owner gate; resolves
    /// `{ handle }` (a decimal string). Refuses `permission_denied` otherwise.
    #[napi]
    pub fn mint_scope<'env>(&self, env: &'env Env, bearer: String) -> napi::Result<Object<'env>> {
        let table = self.scopes.clone();
        let closes = self.closes.load(Ordering::SeqCst);
        let current = self.current();
        self.run(env, move |s| {
            let id = current.as_ref().map(store_id).ok_or_else(refused)?;
            let principal = s.authenticate_bearer(&bearer)?;
            let scope = Scope::from_principal(s, &principal)?;
            let handle = table
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id, closes, scope)?;
            Ok(json!({ "handle": handle.to_string() }))
        })
    }

    /// `checkScope(handle)`: revalidates the session against the store's current records before a
    /// call; resolves `{}` or refuses `permission_denied` (and drops the handle).
    #[napi]
    pub fn check_scope<'env>(&self, env: &'env Env, handle: String) -> napi::Result<Object<'env>> {
        let table = self.scopes.clone();
        let closes = self.closes.load(Ordering::SeqCst);
        let current = self.current();
        self.run(env, move |s| {
            let id = current.as_ref().map(store_id).ok_or_else(refused)?;
            let h = parse_handle(&handle)?;
            let scope = table
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(h, id, closes)
                .ok_or_else(refused)?;
            if let Err(e) = scope.revalidate(s) {
                table
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .entries
                    .remove(&h);
                return Err(e);
            }
            Ok(json!({}))
        })
    }

    /// `scopeGrant(handle)`: the verified token row (no hash) of a live session, from which the
    /// server builds the call's grant; refuses `permission_denied` for a dead handle.
    #[napi]
    pub fn scope_grant<'env>(&self, env: &'env Env, handle: String) -> napi::Result<Object<'env>> {
        let table = self.scopes.clone();
        let closes = self.closes.load(Ordering::SeqCst);
        let current = self.current();
        self.run(env, move |_s| {
            let id = current.as_ref().map(store_id).ok_or_else(refused)?;
            let h = parse_handle(&handle)?;
            let scope = table
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(h, id, closes)
                .ok_or_else(refused)?;
            Ok(scope
                .principal()
                .map(|p| p.row().clone())
                .unwrap_or(Value::Null))
        })
    }

    /// `releaseScope(handle)`: forgets the session (connection closed). Never refuses.
    #[napi]
    pub fn release_scope(&self, handle: String) {
        if let Ok(h) = handle.parse::<u64>() {
            self.scopes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entries
                .remove(&h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handle_from_another_store_or_before_a_close_is_dead() {
        let mut t = ScopeTable::default();
        let scope = Scope::trusted_local(&json!({}));
        let h = t.insert(1, 0, scope.clone()).unwrap();
        assert!(t.get(h, 1, 0).is_some());
        assert!(t.get(h, 1, 1).is_none(), "a close kills it");
        let h = t.insert(1, 0, scope.clone()).unwrap();
        assert!(t.get(h, 2, 0).is_none(), "another store kills it");
        assert!(t.get(999, 1, 0).is_none());
    }

    #[test]
    fn the_table_is_bounded() {
        let mut t = ScopeTable::default();
        let scope = Scope::trusted_local(&json!({}));
        for _ in 0..MAX_SCOPES {
            t.insert(1, 0, scope.clone()).unwrap();
        }
        assert_eq!(
            t.insert(1, 0, scope.clone()).unwrap_err().code,
            "permission_denied"
        );
        // A close frees every slot.
        assert!(t.insert(1, 1, scope).is_ok());
    }

    #[test]
    fn a_bad_handle_is_refused() {
        assert!(parse_handle("x").is_err());
        assert!(parse_handle("-1").is_err());
        assert_eq!(parse_handle("7").unwrap(), 7);
    }
}
