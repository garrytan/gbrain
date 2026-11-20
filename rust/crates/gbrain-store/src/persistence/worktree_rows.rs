//! The worktree-row seam: the one place this engine reads a `persistence_worktrees` row
//! (rust/docs/store/persistence.md, "Worktree rows").
//!
//! The worktree binding (`claimWorktree` and the `persistence_worktrees`,
//! `persistence_source_bindings` and `persistence_host_bindings` tables) belongs to another lane
//! and has not landed on this engine. Until it does, this store cannot say which host owns a
//! worktree or whether it is active. So every caller that meets a worktree id asks here, and the
//! seam refuses with `engine_capability_missing` (`managed_persistence: ...`). It never answers
//! "no row": a claim, admission or scan that depends on a worktree must not report "nothing to
//! do" when the truth is unknown.
//!
//! When the binding lands, `read_worktree_row` reads its row and the callers keep their shape.

use crate::error::{CAPABILITY_MISSING, Result, StoreError};
use crate::kv::KvRead;

/// The columns of a `persistence_worktrees` row that the claim and the scans read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeRow {
    /// `owner_host_id`: the host whose consumers publish the worktree's writes.
    pub owner_host_id: String,
    /// `state`: only an `active` worktree's writes are claimed.
    pub state: String,
}

/// The refusal every worktree read gives until the worktree binding lands. Nothing was written.
pub(crate) fn worktree_capability_missing(id: &str) -> StoreError {
    StoreError::new(
        CAPABILITY_MISSING,
        format!(
            "managed_persistence: worktree {id} cannot be read: this store keeps no \
             persistence_worktrees row until the worktree binding lands"
        ),
    )
}

/// The `persistence_worktrees` row with id `id`, or `None` when no row has that id. On this engine
/// the read refuses (see the module doc).
pub(crate) fn read_worktree_row(_read: &dyn KvRead, id: &str) -> Result<Option<WorktreeRow>> {
    Err(worktree_capability_missing(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{RequestRecord, write_request};
    use crate::persistence::effects::{all_effects, write_effect};
    use crate::persistence::{ClaimableSpec, PublicationEffectsSpec, WriteRequestInsert};
    use crate::test_support::store;
    use crate::{Store, get_json, keys};
    use serde_json::{Value, json};

    const WORKTREE: &str = "f0000000-0000-4000-8000-0000000000a1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";

    fn insert_spec(s: &Store, worktree: Option<&str>) -> WriteRequestInsert {
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "p1", "requestId": "b0000000-0000-4000-8000-0000000000e1",
            "operation": "put_page", "sourceId": "default", "sourceIncarnation": inc, "slug": "notes/a", "digest": "d",
            "intent": {}, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
            "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued", "worktreeId": worktree,
        }))
        .unwrap()
    }

    fn effects_spec(s: &Store, request: &str, worktree: Option<&str>) -> PublicationEffectsSpec {
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        serde_json::from_value(json!({
            "requestId": request, "revision": null, "sourceId": "default", "sourceIncarnation": inc, "worktreeId": worktree,
            "effects": [{ "kind": "withdrawal-mirror", "data": { "slugs": ["notes/a"] } }],
        }))
        .unwrap()
    }

    fn refused(err: StoreError) {
        assert_eq!(err.code, CAPABILITY_MISSING, "{}", err.message);
        assert!(
            err.message.starts_with("managed_persistence: "),
            "{}",
            err.message
        );
    }

    /// A queued request and one queued withdrawal mirror, both without a worktree.
    fn queued_request_with_effect(s: &Store) -> String {
        let id = s.insert_write_request(&insert_spec(s, None)).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.insert_publication_effects(&effects_spec(s, &id, None))
            .unwrap();
        id
    }

    /// Rows that name a worktree, as the binding will let them be stored.
    fn bind_to_worktree(s: &Store, request: &str, effect_state: &str, effect_error: Option<&str>) {
        s.write(|tx| {
            let mut r: RequestRecord = get_json(&*tx, &keys::request(request))?.unwrap();
            r.extra.insert("worktree_id".into(), json!(WORKTREE));
            write_request(tx, &r)?;
            for mut e in all_effects(&*tx)? {
                e.worktree_id = Some(WORKTREE.into());
                e.state = effect_state.into();
                e.error_code = effect_error.map(str::to_owned);
                write_effect(tx, &e)?;
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_seam_refuses_by_capability_instead_of_answering_no_row() {
        let s = store();
        refused(read_worktree_row(&*s.read().unwrap(), WORKTREE).unwrap_err());
    }

    #[test]
    fn a_write_or_effect_naming_a_worktree_refuses_by_capability() {
        let s = store();
        refused(
            s.insert_write_request(&insert_spec(&s, Some(WORKTREE)))
                .unwrap_err(),
        );
        let id = s.insert_write_request(&insert_spec(&s, None)).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        refused(
            s.insert_publication_effects(&effects_spec(&s, &id, Some(WORKTREE)))
                .unwrap_err(),
        );
        assert!(
            all_effects(&*s.read().unwrap()).unwrap().is_empty(),
            "nothing was written"
        );
    }

    #[test]
    fn a_claim_that_meets_a_worktree_row_refuses_instead_of_answering_none() {
        let s = store();
        let id = queued_request_with_effect(&s);
        let spec = ClaimableSpec::default();
        assert!(
            s.has_claimable_write(&spec).unwrap(),
            "without a worktree the row is claimable"
        );
        assert!(!s.select_claimable_effect(HOST, &[]).unwrap().is_null());
        bind_to_worktree(&s, &id, "queued", None);
        refused(s.has_claimable_write(&spec).unwrap_err());
        refused(s.select_claimable_write(&spec).unwrap_err());
        refused(s.select_claimable_effect(HOST, &[]).unwrap_err());
    }

    #[test]
    fn a_parked_mirror_on_a_worktree_makes_the_gated_scan_refuse() {
        let s = store();
        let id = queued_request_with_effect(&s);
        assert_eq!(
            s.list_gated_mirror_requests(HOST).unwrap(),
            Vec::<Value>::new()
        );
        bind_to_worktree(&s, &id, "failed", Some("targets_parked"));
        refused(s.list_gated_mirror_requests(HOST).unwrap_err());
    }
}
